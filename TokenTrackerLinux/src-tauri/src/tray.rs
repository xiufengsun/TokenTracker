use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Manager, Runtime};

const OPEN_ID: &str = "open-dashboard";
const PET_ID: &str = "show-pet";
const QUIT_ID: &str = "quit";
const TRAY_ID: &str = "main-tray";

/// How long to wait before re-publishing the menu. Long enough that the
/// desktop's tray client has finished its initial layout exchange, short
/// enough that a user reaching for the tray immediately still gets labels.
const MENU_REPUBLISH_DELAY: Duration = Duration::from_millis(1500);
const FALLBACK_TRAY_ICON: &[u8] = include_bytes!("../icons/icon.png");

fn fallback_tray_icon() -> tauri::Result<Image<'static>> {
    Image::from_bytes(FALLBACK_TRAY_ICON)
}

/// Install the tray icon.
///
/// **Menu-only by design.** There is deliberately no `on_tray_icon_event`
/// click handler: on Linux `tray-icon`'s GTK/libappindicator backend never
/// calls `TrayIconEvent::send` (its `platform_impl/gtk/mod.rs` contains no
/// event code at all), so `TrayIconEvent::Click` is never emitted. Both Tauri
/// and `tray-icon` document this as "**Linux**: Unsupported. The event is not
/// emitted even though the icon is shown". A left-click handler here would
/// compile and look functional while never running.
///
/// The upside is that libappindicator opens the context menu on *left* click
/// too, so "Open Dashboard" as the first item is the primary entry point.
fn build_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let open = MenuItem::with_id(manager, OPEN_ID, "Open Dashboard", true, None::<&str>)?;
    let pet_visible = manager
        .try_state::<crate::pet::PetState>()
        .is_some_and(|state| state.get().visible);
    let pet = CheckMenuItem::with_id(manager, PET_ID, "Show Pet", true, pet_visible, None::<&str>)?;
    let quit = MenuItem::with_id(manager, QUIT_ID, "Quit", true, None::<&str>)?;
    Menu::with_items(manager, &[&open, &pet, &quit])
}

/// Reflect the pet's visibility in the tray's "Show Pet" check after it changes.
///
/// Publishes a freshly built menu rather than flipping the existing item, for
/// the same reason as `republish_menu`: GNOME's AppIndicator extension handles
/// new menus reliably and in-place property updates less so.
pub fn refresh_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(error) => eprintln!("[TokenTracker] failed to rebuild the tray menu: {error}"),
    }
}

/// Publish a second, freshly built menu once startup has quiesced.
///
/// libappindicator exports the menu in two passes: the structure first, then
/// the item properties ~50ms later as `ItemsPropertiesUpdated` plus a second
/// `LayoutUpdated`. GNOME's AppIndicator extension cannot absorb that. Its
/// `GetLayout` deliberately asks for `type`/`children-display` only and fetches
/// labels separately on an idle callback, and the second `LayoutUpdated`
/// cancels that pending fetch. The re-run then finds the item ids already
/// known and skips re-requesting them (`dbusMenu.js`), so the labels are never
/// fetched and the tray menu renders as blank rows.
///
/// Re-publishing a newly built menu gets new item ids, so the extension has to
/// create the items afresh — and by then nothing is racing the property fetch.
fn republish_menu(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(MENU_REPUBLISH_DELAY);
        let _ = app.clone().run_on_main_thread(move || {
            let Some(tray) = app.tray_by_id(TRAY_ID) else {
                return;
            };
            match build_menu(&app) {
                Ok(menu) => {
                    if let Err(error) = tray.set_menu(Some(menu)) {
                        eprintln!("[TokenTracker] failed to republish the tray menu: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("[TokenTracker] failed to rebuild the tray menu: {error}");
                }
            }
        });
    });
}

pub fn install(app: &App) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    let icon = app
        .default_window_icon()
        .cloned()
        .unwrap_or(fallback_tray_icon()?);

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("TokenTracker")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_main_window(app),
            PET_ID => {
                let visible = app.state::<crate::pet::PetState>().get().visible;
                crate::pet::set_visible(app, !visible);
            }
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .build(app)?;

    republish_menu(app.handle());

    Ok(())
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::fallback_tray_icon;

    #[test]
    fn embedded_fallback_icon_has_non_zero_dimensions() {
        let icon = fallback_tray_icon().expect("embedded fallback icon must decode");

        assert!(icon.width() > 0);
        assert!(icon.height() > 0);
    }
}
