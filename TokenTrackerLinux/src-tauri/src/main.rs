use tokentracker_linux::{external, oauth, paths, server, tray};

use std::sync::Mutex;

use oauth::{DashboardBaseUrl, PendingAuthCode};
use once_cell::sync::Lazy;
use server::TokenTrackerServer;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

static SERVER: Lazy<Mutex<Option<TokenTrackerServer>>> = Lazy::new(|| Mutex::new(None));

const WEBKIT_DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

const NATIVE_OAUTH_BRIDGE: &str = r#"
(() => {
  const host = window.location.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') return;
  const handler = {
    postMessage(url) {
      return window.__TAURI_INTERNALS__.invoke('open_oauth', { url });
    }
  };
  // WebKit's messageHandlers object is a host object. Assigning onto it can
  // throw; the page then thinks it is a normal browser and OAuth returns to
  // the dashboard root. Keep going so a later page script can install it.
  try {
    window.webkit = window.webkit || {};
    if (!window.webkit.messageHandlers) window.webkit.messageHandlers = {};
    if (!window.webkit.messageHandlers.nativeOAuth) {
      window.webkit.messageHandlers.nativeOAuth = handler;
    }
  } catch (e) {}
})();
"#;

/// WebKitGTK renders through DMA-BUF by default. On a number of otherwise
/// supported Wayland setups — most reliably NVIDIA's proprietary driver — that
/// path either paints a permanently blank webview or loses the Wayland
/// connection outright, aborting with `Error 71 (Protocol error)` before the
/// dashboard is ever shown. The abort skips `stop_server`, so the bundled Node
/// server is orphaned on port 17680 and later launches lose OAuth sign-in.
///
/// Defaults to the compatibility renderer while treating an explicit user value
/// as authoritative, so `WEBKIT_DISABLE_DMABUF_RENDERER=0` can still opt back
/// into the accelerated path. Called as the first statement in `main` because
/// the variable is only read when GTK/WebKit initializes, and `set_var` is
/// sound only while the process is still single-threaded.
fn configure_webkit_runtime() {
    if std::env::var_os(WEBKIT_DMABUF_ENV).is_none() {
        std::env::set_var(WEBKIT_DMABUF_ENV, "1");
    }
}

fn stop_server() {
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut server) = guard.take() {
            server.stop();
        }
    }
}

/// Run a webview action on the main thread.
///
/// wry's GTK backend is thread-affine and the dashboard is brought up on a
/// worker thread, so every webview mutation is hopped back explicitly.
fn on_main_thread<F>(app: &AppHandle, action: F)
where
    F: FnOnce() + Send + 'static,
{
    if let Err(error) = app.run_on_main_thread(action) {
        eprintln!("[TokenTracker] failed to dispatch to the main thread: {error}");
    }
}

/// Surface a startup failure in the loading page instead of leaving the user
/// with a window stuck on "Starting TokenTracker…".
fn report_startup_failure(app: &AppHandle, window: &WebviewWindow, error: &str) {
    eprintln!("[TokenTracker] {error}");
    // Serialize through serde_json so the message is a JS string literal and
    // can never break out of the script.
    let Ok(detail) = serde_json::to_string(error) else {
        return;
    };
    let script =
        format!("window.dispatchEvent(new CustomEvent('tokentracker:startup-error', {{ detail: {detail} }}));");
    let window = window.clone();
    on_main_thread(app, move || {
        let _ = window.eval(&script);
    });
}

/// Resolve the bundled runtime, start the Node server and point the window at
/// it.
///
/// Runs on a worker thread. Doing this inside `setup()` would block the main
/// thread for up to 20 seconds before the event loop starts: no window would be
/// mapped and the tray menu's "Open Dashboard" would silently do nothing,
/// because `show_main_window` looks for a "main" window that does not exist
/// yet.
fn start_dashboard(app: AppHandle, window: WebviewWindow) {
    // `resource_dir()` is authoritative for bundled builds (AppImage included);
    // `paths` falls back to the Arch prefix and the dev checkout.
    let resource_dir = app.path().resource_dir().ok();

    let server =
        match paths::resolve_runtime_paths(resource_dir).and_then(TokenTrackerServer::start) {
            Ok(server) => server,
            Err(error) => {
                report_startup_failure(&app, &window, &error);
                return;
            }
        };

    let dashboard_url = server.url().to_string();
    app.state::<DashboardBaseUrl>().store(dashboard_url.clone());

    if let Ok(mut guard) = SERVER.lock() {
        *guard = Some(server);
    }

    start_health_monitor();

    let url = match dashboard_url.parse::<tauri::Url>() {
        Ok(url) => url,
        Err(error) => {
            report_startup_failure(
                &app,
                &window,
                &format!("invalid dashboard URL {dashboard_url}: {error}"),
            );
            return;
        }
    };

    let navigate_app = app.clone();
    let navigate_window = window.clone();
    on_main_thread(&app, move || {
        if let Err(error) = navigate_window.navigate(url) {
            eprintln!("[TokenTracker] failed to open the dashboard: {error}");
            return;
        }
        // A `tokentracker://` callback may have arrived before the server was
        // ready, in which case it was parked as a pending code.
        oauth::deliver_pending_callback(&navigate_app);
    });
}

/// Background thread that periodically health-checks the bundled Node server.
///
/// Mirrors the Windows `ServerManager.StartHealthLoop()` pattern: debounce
/// transient failures with a consecutive-count threshold, then auto-restart the
/// server on the same port (the dashboard JS is already loaded targeting that
/// port, so no page reload is needed).
///
/// `MAX_RESTARTS` budgets restarts that did *not* lead to recovery. Exhausting
/// it sleeps for `RESTART_BACKOFF` and then resumes with a fresh budget, so a
/// crash-looping server is retried slowly and indefinitely rather than being
/// abandoned. A successful probe clears both counters.
fn start_health_monitor() {
    std::thread::spawn(|| {
        let mut consecutive_failures: u32 = 0;
        let mut restarts_since_recovery: u32 = 0;

        loop {
            std::thread::sleep(server::HEALTH_CHECK_INTERVAL);

            // Read the port and process liveness under the lock, then release
            // it before probing. `probe_server_http` performs a connect plus
            // read with second-scale timeouts; holding the global mutex across
            // it delays `stop_server()` on app exit by the same amount.
            let (port, process_alive) = {
                let mut guard = match SERVER.lock() {
                    Ok(guard) => guard,
                    Err(_) => continue,
                };
                let Some(server) = guard.as_mut() else {
                    continue;
                };
                (server.port(), server.is_process_alive())
            };

            if process_alive && server::probe_server_http(port).is_ok() {
                consecutive_failures = 0;
                restarts_since_recovery = 0;
                continue;
            }

            consecutive_failures += 1;
            eprintln!(
                "[TokenTracker] health check failed ({}/{})",
                consecutive_failures,
                server::FAILURE_THRESHOLD
            );

            if consecutive_failures < server::FAILURE_THRESHOLD {
                continue;
            }

            if restarts_since_recovery >= server::MAX_RESTARTS {
                eprintln!(
                    "[TokenTracker] server restarted {} times without recovering, backing off for {:?}",
                    restarts_since_recovery,
                    server::RESTART_BACKOFF
                );
                std::thread::sleep(server::RESTART_BACKOFF);
                restarts_since_recovery = 0;
                consecutive_failures = 0;
                continue;
            }

            restarts_since_recovery += 1;
            eprintln!(
                "[TokenTracker] restarting server (attempt {}/{})...",
                restarts_since_recovery,
                server::MAX_RESTARTS
            );

            // Respawn under the lock (it mutates the child handle), then poll
            // readiness after the guard drops at the end of this block.
            let restart_result = {
                let mut guard = match SERVER.lock() {
                    Ok(guard) => guard,
                    Err(_) => continue,
                };
                let Some(server) = guard.as_mut() else {
                    continue;
                };
                if server.port() != port {
                    // Replaced while we were probing without the lock; do not
                    // restart a port we no longer own.
                    continue;
                }
                server.restart_process()
            };

            match restart_result
                .and_then(|()| server::wait_for_server_ready(port, server::READY_TIMEOUT))
            {
                Ok(()) => {
                    eprintln!("[TokenTracker] server restarted successfully");
                    consecutive_failures = 0;
                }
                Err(error) => {
                    eprintln!("[TokenTracker] server restart failed: {error}");
                }
            }
        }
    });
}

fn main() {
    configure_webkit_runtime();

    let initial_args: Vec<String> = std::env::args().collect();

    tauri::Builder::default()
        .manage(PendingAuthCode::default())
        .manage(DashboardBaseUrl::default())
        .invoke_handler(tauri::generate_handler![oauth::open_oauth])
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv {
                if oauth::handle_callback(app, &arg) {
                    return;
                }
            }
            tray::show_main_window(app);
        }))
        .setup(move |app| {
            if let Err(error) = oauth::ensure_appimage_protocol_registration() {
                eprintln!("[TokenTracker] AppImage OAuth callback registration failed: {error}");
            }
            tray::install(app)?;

            for arg in &initial_args {
                if let Some(code) = oauth::parse_auth_callback(arg) {
                    app.state::<PendingAuthCode>().store(code);
                }
            }

            // Create the window up front so it paints `src/index.html` as a
            // loading screen and the tray menu has a "main" window to raise
            // while the server is still coming up.
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(NATIVE_OAUTH_BRIDGE)
            // `target="_blank"` links (provider status pages, leaderboard
            // profiles) belong in the system browser. WebKitGTK opens nothing
            // at all unless this handler is installed.
            .on_new_window(|url, _features| {
                external::open_in_browser(&url);
                tauri::webview::NewWindowResponse::Deny
            })
            // The app window has no browser chrome, so a top-level navigation
            // off the dashboard would strand the user with no way back.
            .on_navigation(|url| {
                if external::is_internal_url(url) {
                    return true;
                }
                external::open_in_browser(url);
                false
            })
            .title("TokenTracker")
            .inner_size(1180.0, 820.0)
            .min_inner_size(960.0, 640.0)
            .build()?;

            let handle = app.handle().clone();
            std::thread::spawn(move || start_dashboard(handle, window));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build TokenTracker Linux client")
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                stop_server();
            }
        });
}
