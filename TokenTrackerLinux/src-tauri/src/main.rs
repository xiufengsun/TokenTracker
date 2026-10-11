use tokentracker_linux::{
    cloud_export, desktop, external, oauth, paths, pet, server, tray, ui_zoom,
};

use std::sync::Mutex;

use oauth::{DashboardBaseUrl, PendingAuthCode};
use once_cell::sync::Lazy;
use server::TokenTrackerServer;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

static SERVER: Lazy<Mutex<Option<TokenTrackerServer>>> = Lazy::new(|| Mutex::new(None));

const WEBKIT_DMABUF_ENV: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

const NATIVE_OAUTH_BRIDGE: &str = r#"
(() => {
  if (window.location.hostname !== '127.0.0.1') return;
  if (window !== window.top) return;
  window.__TOKENTRACKER_CLOUD_EXPORT__ = true;
  const handler = {
    postMessage(url) {
      return window.__TAURI_INTERNALS__.invoke('open_oauth', { url });
    }
  };
  // WebKit's messageHandlers object is a host object and assigning onto it can
  // throw. The dashboard then calls the Tauri command directly
  // (getNativeOAuthBridge), so a failure here is not fatal.
  try {
    window.webkit = window.webkit || {};
    if (!window.webkit.messageHandlers) window.webkit.messageHandlers = {};
    if (!window.webkit.messageHandlers.nativeOAuth) {
      window.webkit.messageHandlers.nativeOAuth = handler;
    }
  } catch (e) {}
})();
"#;

/// Dashboard zoom bridge, injected in place of Tauri's built-in zoom hotkeys.
///
/// The built-in script (`zoom-hotkey.js`) is inert on this client -- its
/// `plugin:webview|set_webview_zoom` invoke is rejected by the ACL for the
/// loopback dashboard, and it would forget the level on every launch anyway.
/// `ui_zoom` documents both failure modes; this script routes the same gestures
/// through the app's own `set_ui_zoom` command, which is granted to the
/// dashboard origin and persists what it applies.
///
/// The starting level comes from Rust, so a machine that configured one gets it
/// before the user touches anything. Every change re-reads the value the command
/// returns, which keeps the clamping in one place instead of duplicating it here.
fn ui_zoom_bridge(initial_zoom: f64) -> String {
    format!(
        r#"(() => {{
  const STEP = {step};
  const MIN = {min};
  const MAX = {max};
  const BASELINE = {baseline};
  let zoom = BASELINE;
  let revision = 0;
  let sending = false;

  const flush = async () => {{
    if (sending) return;
    sending = true;
    try {{
      while (true) {{
        const sentRevision = revision;
        try {{
          const applied = await window.__TAURI_INTERNALS__
            .invoke('set_ui_zoom', {{ value: zoom }});
          if (sentRevision === revision && typeof applied === 'number' && Number.isFinite(applied)) {{
            zoom = applied;
          }}
        }} catch (_) {{}}
        if (sentRevision === revision) break;
      }}
    }} finally {{
      sending = false;
    }}
  }};

  const apply = (next) => {{
    // Record intent before awaiting the host; coalesce bursts behind one write.
    zoom = Math.round(Math.min(Math.max(next, MIN), MAX) * 10) / 10;
    revision += 1;
    void flush();
  }};

  window.addEventListener('keydown', (event) => {{
    if (!event.ctrlKey) return;
    if (event.key === '-') apply(zoom - STEP);
    else if (event.key === '=' || event.key === '+') apply(zoom + STEP);
    // Resets to the level this launch started at rather than to 100%: on a
    // desktop configured for 150%, dropping back to 100% is the complaint.
    else if (event.key === '0') apply(BASELINE);
    else return;
    event.preventDefault();
  }});

  // `passive: false` so Ctrl + wheel zooms instead of scrolling.
  window.addEventListener('wheel', (event) => {{
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (!event.deltaY) return;
    apply(event.deltaY < 0 ? zoom + STEP : zoom - STEP);
  }}, {{ passive: false }});
}})();"#,
        step = ui_zoom::ZOOM_STEP,
        min = ui_zoom::MIN_ZOOM,
        max = ui_zoom::MAX_ZOOM,
        baseline = initial_zoom,
    )
}

/// The level this launch starts at: environment, then the stored level, then
/// 100%. See [`ui_zoom::resolve_zoom`].
fn initial_ui_zoom() -> f64 {
    let from_env = std::env::var(ui_zoom::ZOOM_ENV).ok();
    let stored = ui_zoom::default_zoom_path().and_then(|path| ui_zoom::load_zoom(&path));
    ui_zoom::resolve_zoom(from_env.as_deref(), stored)
}

/// Apply a level to the dashboard webview.
///
/// Reported rather than swallowed: a zoom that silently does nothing is exactly
/// the bug this replaces.
fn apply_ui_zoom(window: &WebviewWindow, zoom: f64) {
    if let Err(error) = window.set_zoom(zoom) {
        eprintln!("[TokenTracker] failed to apply UI zoom {zoom}: {error}");
    }
}

/// Apply and remember a zoom level, then report the level that was applied.
///
/// Returns the clamped value (not a `Result`) so the injected bridge can resync
/// its local copy from the authoritative one. Failures are logged rather than
/// raised: the webview keeps rendering at the previous level either way, and a
/// stale preference file is not worth failing the gesture over.
#[tauri::command]
fn set_ui_zoom(window: WebviewWindow, value: f64) -> f64 {
    let applied = ui_zoom::clamp_zoom(value);
    apply_ui_zoom(&window, applied);

    if let Some(path) = ui_zoom::default_zoom_path() {
        if let Err(error) = ui_zoom::store_zoom(&path, applied) {
            eprintln!("[TokenTracker] failed to store UI zoom: {error}");
        }
    }

    applied
}

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
fn start_dashboard(app: AppHandle, window: WebviewWindow, zoom: f64) {
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
    let Some(export_url) = cloud_export::capability_url(&dashboard_url) else {
        report_startup_failure(&app, &window, "invalid cloud export origin");
        return;
    };
    let export_capability = tauri::ipc::CapabilityBuilder::new("cloud-usage-export")
        .window("main")
        .local(false)
        .remote(export_url)
        .permission("allow-save-cloud-usage-export");
    if app.add_capability(export_capability).is_err() {
        report_startup_failure(&app, &window, "cloud export permission unavailable");
        return;
    }
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
        // The level belongs to the webview rather than to a document, but
        // re-applying it after the navigation costs nothing and guarantees it is
        // in force from the dashboard's first paint instead of only on the
        // loading page.
        apply_ui_zoom(&navigate_window, zoom);
        // A `tokentracker://` callback may have arrived before the server was
        // ready, in which case it was parked as a pending code.
        oauth::deliver_pending_callback(&navigate_app);
        // The pet page is served by the same server, so a pet left on at the
        // last quit can only come back now.
        pet::sync_pet(&navigate_app);
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
    let context = tauri::generate_context!();

    // `--pet <url>` runs the floating pet in its own process (see pet.rs). Still
    // single-threaded here, so setting GDK_BACKEND before GTK starts is sound.
    if let Some(base_url) = pet::pet_process_url(&initial_args) {
        pet::prefer_x11_backend();
        pet::run_pet_process(base_url, context);
        return;
    }

    tauri::Builder::default()
        .manage(PendingAuthCode::default())
        .manage(DashboardBaseUrl::default())
        .invoke_handler(tauri::generate_handler![
            oauth::open_oauth,
            pet::pet_bridge,
            cloud_export::save_cloud_usage_export,
            set_ui_zoom
        ])
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
            app.manage(pet::PetState::load(pet::settings_path(app.handle())));
            app.manage(pet::PetProcess::default());
            pet::start_context_relay(app.handle().clone());
            tray::install(app)?;

            for arg in &initial_args {
                if let Some(code) = oauth::parse_auth_callback(arg) {
                    app.state::<PendingAuthCode>().store(code);
                }
            }

            // Resolved before the window exists so the loading page and the
            // dashboard that replaces it both start at the same level.
            let zoom = initial_ui_zoom();

            // Create the window up front so it paints `src/index.html` as a
            // loading screen and the tray menu has a "main" window to raise
            // while the server is still coming up.
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .initialization_script(NATIVE_OAUTH_BRIDGE)
            .initialization_script(desktop::init_script())
            .initialization_script(ui_zoom_bridge(zoom))
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
            // The app owns the zoom level: Tauri's built-in hotkeys cannot reach
            // the loopback dashboard through the ACL, and they would not persist
            // the level even if they could. See `ui_zoom`.
            .zoom_hotkeys_enabled(false)
            .build()?;

            apply_ui_zoom(&window, zoom);

            let handle = app.handle().clone();
            std::thread::spawn(move || start_dashboard(handle, window, zoom));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(context)
        .expect("failed to build TokenTracker Linux client")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                pet::stop_pet(app);
                stop_server();
            }
        });
}
