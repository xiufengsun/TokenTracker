//! Floating desktop pet — the Linux counterpart of `TokenTrackerWin/PetWindow.cs`.
//!
//! The pet runs in its own process (`tokentracker-linux --pet <dashboard-url>`).
//! GTK picks one display backend per process, and the pet needs X11: on
//! Wayland a client window can't stay above other windows, can't place itself,
//! and GNOME snaps and constrains it like any app window when it is dragged.
//! Under XWayland the pet is an override-redirect overlay instead — unmanaged
//! by the window manager, like a tooltip — so it floats above everything, moves
//! wherever it is dragged and stays out of the dock and Alt+Tab. The dashboard
//! keeps its native Wayland window in the main process.
//!
//! The pet window loads the shared `pet.html` page from the bundled server. The
//! page feeds itself usage, limits, currency and locale
//! (`dashboard/src/lib/pet-linux-host.js`). The main process owns the settings
//! the dashboard's Pet page edits (visibility, size, character, bot colour) and
//! writes them to `pet.json`; the pet process watches that file. The pet
//! process owns only its position (`pet-position.json`).

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use gtk::gdk::prelude::{MonitorExt, SeatExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::oauth::DashboardBaseUrl;

pub const PET_LABEL: &str = "pet";
const MAIN_LABEL: &str = "main";
const PET_ARG: &str = "--pet";
const SETTINGS_FILE: &str = "pet.json";
const POSITION_FILE: &str = "pet-position.json";
/// How often the pet process checks for settings changes and a vanished parent.
const WATCH_INTERVAL: Duration = Duration::from_millis(500);
/// Drag follows the pointer at display rate.
const DRAG_INTERVAL: Duration = Duration::from_millis(16);
/// Gap between the sprite and the screen corner on first launch.
const DEFAULT_MARGIN: i32 = 24;

// Geometry mirrors PetWindow.cs / pet.jsx:sizeFor(). The window is wider than
// the sprite so the 340px bubble never touches the edge.
const WINDOW_WIDTH: f64 = 400.0;
const MIN_BUBBLE_BAND: f64 = 138.0;
/// Windows grows the bubble band on demand and moves the window up to keep the
/// sprite still. Here the band is fixed at a height that fits the hover card
/// with several limit rows, so the sprite never jumps when the bubble grows.
pub const BUBBLE_BAND: f64 = 230.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PetSettings {
    pub visible: bool,
    pub size: String,
    pub character: String,
    pub bot_color: String,
    pub context: PetContext,
}

/// The dashboard's display preferences, copied raw from its localStorage.
///
/// The pet's webview has its own data directory — two processes must never
/// share the dashboard's storage, which also holds the sign-in session — so
/// the main process relays these instead. `pet-linux-host.js` parses them with
/// the dashboard's own helpers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PetContext {
    pub currency: Option<String>,
    pub exchange_rates: Option<String>,
    pub locale: Option<String>,
    pub theme: Option<String>,
}

/// Longest value accepted per context field (the exchange-rate blob is the big one).
const CONTEXT_VALUE_MAX: usize = 4096;

impl PetContext {
    fn from_message(values: &Value) -> Self {
        let field = |key: &str| {
            values
                .get(key)
                .and_then(Value::as_str)
                .filter(|value| value.len() <= CONTEXT_VALUE_MAX)
                .map(str::to_string)
        };
        Self {
            currency: field("currency"),
            exchange_rates: field("exchangeRates"),
            locale: field("locale"),
            theme: field("theme"),
        }
    }
}

impl Default for PetSettings {
    fn default() -> Self {
        Self {
            visible: false,
            size: "medium".into(),
            character: "clawd".into(),
            bot_color: "auto".into(),
            context: PetContext::default(),
        }
    }
}

impl PetSettings {
    fn normalized(self) -> Self {
        Self {
            visible: self.visible,
            size: normalize_size(&self.size).into(),
            character: normalize_character(&self.character),
            bot_color: normalize_bot_color(&self.bot_color),
            context: self.context,
        }
    }
}

pub fn normalize_size(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "small" => "small",
        "large" => "large",
        _ => "medium",
    }
}

fn is_slug(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Built-ins plus imported pet ids (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`,
/// as on Windows). Anything else falls back to Clawd so a bad value can never
/// become script.
pub fn normalize_character(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if is_slug(&value, 64) && !value.starts_with('-') && !value.ends_with('-') {
        value
    } else {
        "clawd".into()
    }
}

pub fn normalize_bot_color(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if is_slug(&value, 32) {
        value
    } else {
        "auto".into()
    }
}

/// Window size for a size preset: the preset's sprite area plus the fixed bubble band.
pub fn window_size(size: &str) -> (f64, f64) {
    let base = match normalize_size(size) {
        "small" => 230.0,
        "large" => 286.0,
        _ => 254.0,
    };
    (WINDOW_WIDTH, base - MIN_BUBBLE_BAND + BUBBLE_BAND)
}

/// The sprite square inside the window, as `(x, y, side)` — pet.jsx centres a
/// `min(width, height - band) - 8` square in the area under the bubble band.
pub fn sprite_rect(width: f64, height: f64) -> (f64, f64, f64) {
    let side = (width.min(height - BUBBLE_BAND) - 8.0).max(40.0);
    let x = (width - side) / 2.0;
    let y = BUBBLE_BAND + (height - BUBBLE_BAND - side) / 2.0;
    (x, y, side)
}

/// A screen rectangle in GDK logical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// First-launch spot: the sprite in the bottom-right corner of the work area.
pub fn default_position(size: &str, work_area: Rect) -> (i32, i32) {
    let (width, height) = window_size(size);
    let (sx, sy, side) = sprite_rect(width, height);
    let x = work_area.x + work_area.width - DEFAULT_MARGIN - (sx + side) as i32;
    let y = work_area.y + work_area.height - DEFAULT_MARGIN - (sy + side) as i32;
    (x, y)
}

/// Centre of the sprite for a window at `(x, y)` — what decides which monitor
/// the pet is on. The window's own corner can hang off-screen (bubble band).
pub fn sprite_center(size: &str, (x, y): (i32, i32)) -> (i32, i32) {
    let (width, height) = window_size(size);
    let (sx, sy, side) = sprite_rect(width, height);
    (x + (sx + side / 2.0) as i32, y + (sy + side / 2.0) as i32)
}

/// Keep the whole sprite on screen. The transparent bubble band may hang off
/// the top edge, which is what lets the pet sit right under the top bar.
pub fn clamp_position(size: &str, (x, y): (i32, i32), screen: Rect) -> (i32, i32) {
    let (width, height) = window_size(size);
    let (sx, sy, side) = sprite_rect(width, height);
    let (sx, sy, side) = (sx as i32, sy as i32, side as i32);
    let min_x = screen.x - sx;
    let max_x = screen.x + screen.width - sx - side;
    let min_y = screen.y - sy;
    let max_y = screen.y + screen.height - sy - side;
    (
        x.clamp(min_x, max_x.max(min_x)),
        y.clamp(min_y, max_y.max(min_y)),
    )
}

// ── Settings (written by the main process, watched by the pet process) ──────

pub struct PetState {
    settings: Mutex<PetSettings>,
    path: Option<PathBuf>,
}

impl PetState {
    pub fn load(path: Option<PathBuf>) -> Self {
        let settings = read_settings(path.as_ref());
        Self {
            settings: Mutex::new(settings),
            path,
        }
    }

    pub fn get(&self) -> PetSettings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Apply a change and save it. Saving touches `pet.json`, which the pet
    /// process watches, so `force` re-saves even when nothing changed.
    fn update(&self, force: bool, change: impl FnOnce(&mut PetSettings)) -> PetSettings {
        let Ok(mut settings) = self.settings.lock() else {
            return PetSettings::default();
        };
        let before = settings.clone();
        change(&mut settings);
        *settings = settings.clone().normalized();
        let snapshot = settings.clone();
        if snapshot == before && !force {
            return snapshot;
        }
        // Write while still holding the lock: the context relay and dashboard
        // changes save from different threads through the same tmp file, and
        // an older snapshot must never land after a newer one.
        if let Some(path) = &self.path {
            if let Err(error) = write_json_atomic(path, &snapshot) {
                eprintln!("[TokenTracker] failed to save pet settings: {error}");
            }
        }
        drop(settings);
        snapshot
    }
}

fn read_settings(path: Option<&PathBuf>) -> PetSettings {
    path.and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<PetSettings>(&raw).ok())
        .unwrap_or_default()
        .normalized()
}

fn write_json_atomic<T: Serialize>(path: &PathBuf, value: &T) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, path)
}

fn config_file<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(name))
}

pub fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    config_file(app, SETTINGS_FILE)
}

/// Apply one change from the dashboard's Pet page (`setPetSetting`).
fn apply_setting(settings: &mut PetSettings, key: &str, value: &Value) {
    let text = value.as_str().unwrap_or_default();
    match key {
        "visible" => settings.visible = value.as_bool().unwrap_or(false),
        "size" => settings.size = text.into(),
        "character" => settings.character = text.into(),
        "botColor" => settings.bot_color = text.into(),
        _ => {}
    }
}

// ── Main process: keep the pet process in step with the settings ────────────

#[derive(Default)]
pub struct PetProcess(Mutex<Option<Child>>);

/// The dashboard URL a `--pet` launch should load, if this is one. Only the
/// loopback server is accepted, so the flag can't point the pet anywhere else.
pub fn pet_process_url(args: &[String]) -> Option<String> {
    match args {
        [_, flag, url, ..] if flag == PET_ARG => {
            let parsed = url.parse::<tauri::Url>().ok()?;
            let loopback = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
            (parsed.scheme() == "http" && loopback).then(|| url.trim_end_matches('/').to_string())
        }
        _ => None,
    }
}

/// Start or stop the pet process to match the saved settings.
pub fn sync_pet<R: Runtime>(app: &AppHandle<R>) {
    let visible = app.state::<PetState>().get().visible;
    let base_url = app.state::<DashboardBaseUrl>().get();
    let process = app.state::<PetProcess>();
    let Ok(mut child) = process.0.lock() else {
        return;
    };

    let running = match child.as_mut() {
        Some(existing) => matches!(existing.try_wait(), Ok(None)),
        None => false,
    };

    if !visible {
        if let Some(mut existing) = child.take() {
            let _ = existing.kill();
            let _ = existing.wait();
        }
        return;
    }
    if running {
        return;
    }
    // The page is served by the bundled server; before it is up there is
    // nothing to load. start_dashboard calls back here once it is.
    let Some(base_url) = base_url else {
        return;
    };
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            eprintln!("[TokenTracker] cannot locate the app binary for the pet: {error}");
            return;
        }
    };
    match Command::new(exe).arg(PET_ARG).arg(&base_url).spawn() {
        Ok(spawned) => *child = Some(spawned),
        Err(error) => eprintln!("[TokenTracker] failed to start the pet: {error}"),
    }
}

/// How often the dashboard's display preferences are relayed to the pet.
const CONTEXT_RELAY_INTERVAL: Duration = Duration::from_secs(3);

/// Reads the dashboard's display preferences and hands them to `pet_bridge`.
/// A no-op on the local loading page, which has no such storage or permission.
const CONTEXT_RELAY_SCRIPT: &str = r#"
(() => {
  try {
    if (window.location.hostname !== '127.0.0.1' || !window.__TAURI_INTERNALS__) return;
    const get = (key) => window.localStorage.getItem(key);
    window.__TAURI_INTERNALS__.invoke('pet_bridge', { message: { type: 'petContext', values: {
      currency: get('tokentracker-currency'),
      exchangeRates: get('tokentracker-exchange-rates'),
      locale: get('tokentracker-locale'),
      theme: get('tokentracker-theme'),
    } } }).catch(() => {});
  } catch (e) {}
})();
"#;

/// While the pet is shown, keep its currency, language and theme in step with
/// the dashboard's settings. Only writes `pet.json` when something changed.
pub fn start_context_relay(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(CONTEXT_RELAY_INTERVAL);
        if !app.state::<PetState>().get().visible {
            continue;
        }
        let relay = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(main) = relay.get_webview_window(MAIN_LABEL) {
                let _ = main.eval(CONTEXT_RELAY_SCRIPT);
            }
        });
    });
}

/// Stop the pet with the app. It also exits on its own if the app dies.
pub fn stop_pet<R: Runtime>(app: &AppHandle<R>) {
    if let Some(process) = app.try_state::<PetProcess>() {
        if let Ok(mut child) = process.0.lock() {
            if let Some(mut existing) = child.take() {
                let _ = existing.kill();
                let _ = existing.wait();
            }
        }
    }
}

pub fn set_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    let settings = app
        .state::<PetState>()
        .update(false, |s| s.visible = visible);
    sync_pet(app);
    push_to_dashboard(app, &settings);
    crate::tray::refresh_menu(app);
}

/// Answer the dashboard's `getPetSettings` / confirm a change, as macOS and Windows do.
fn push_to_dashboard<R: Runtime>(app: &AppHandle<R>, settings: &PetSettings) {
    let Some(main) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let Ok(detail) = serde_json::to_string(settings) else {
        return;
    };
    let _ = main.eval(format!(
        "window.dispatchEvent(new CustomEvent('native:petSettings', {{ detail: {detail} }}));"
    ));
}

fn handle_dashboard_message<R: Runtime>(app: &AppHandle<R>, message: &Value) {
    match message.get("type").and_then(Value::as_str) {
        Some("getPetSettings") => push_to_dashboard(app, &app.state::<PetState>().get()),
        Some("setPetSetting") => {
            let Some(key) = message.get("key").and_then(Value::as_str) else {
                return;
            };
            let value = message.get("value").cloned().unwrap_or(Value::Null);
            // Size / character / colour reach the running pet through pet.json.
            let settings = app
                .state::<PetState>()
                .update(false, |s| apply_setting(s, key, &value));
            sync_pet(app);
            push_to_dashboard(app, &settings);
            crate::tray::refresh_menu(app);
        }
        // A pet was imported or removed. Re-saving bumps pet.json's mtime, and
        // the pet re-pushes its character, which makes the page re-read the catalog.
        Some("refreshPetCatalog") => {
            app.state::<PetState>().update(true, |_| {});
        }
        Some("petContext") => {
            let context = PetContext::from_message(message.get("values").unwrap_or(&Value::Null));
            app.state::<PetState>()
                .update(false, |s| s.context = context);
        }
        _ => {}
    }
}

// ── Pet process ─────────────────────────────────────────────────────────────

/// Must run before GTK initialises. Prefers XWayland whenever it is available;
/// GTK falls back to Wayland if the X server can't be reached, and the pet then
/// works as an ordinary (managed) Wayland window.
pub fn prefer_x11_backend() {
    if std::env::var_os("DISPLAY").is_some() {
        std::env::set_var("GDK_BACKEND", "x11,wayland");
    }
}

#[derive(Serialize, Deserialize)]
struct SavedPosition {
    x: i32,
    y: i32,
}

struct PetWindowState {
    /// Override-redirect X11 overlay (as opposed to a managed Wayland window).
    overlay: bool,
    dragging: Mutex<bool>,
}

fn is_x11<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    use gtk::glib::prelude::ObjectExt;
    use gtk::prelude::WidgetExt;
    window
        .gtk_window()
        .map(|w| w.display().type_().name().contains("X11"))
        .unwrap_or(false)
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
}

/// Push the settings the page can't read on its own into the pet window.
fn push_to_pet<R: Runtime>(window: &WebviewWindow<R>, settings: &PetSettings) {
    let storage = serde_json::to_string(&settings.context).unwrap_or_else(|_| "{}".into());
    let script = format!(
        "window.__ttPetCharacter={};window.__ttPetBotColor={};window.__ttPetBubbleBand={};\
         window.__ttPetStorage={storage};\
         window.dispatchEvent(new Event('pet:character'));\
         window.dispatchEvent(new Event('pet:botColor'));\
         window.dispatchEvent(new Event('pet:bubble-band'));\
         window.dispatchEvent(new Event('pet:storage'));",
        js_string(&settings.character),
        js_string(&settings.bot_color),
        BUBBLE_BAND,
    );
    let _ = window.eval(script);
}

fn push_drag_state<R: Runtime>(window: &WebviewWindow<R>, state: Option<&str>) {
    let value = state.map(js_string).unwrap_or_else(|| "null".into());
    let end = if state.is_none() {
        "window.dispatchEvent(new Event('pet:drag-end'));"
    } else {
        ""
    };
    let _ = window.eval(format!(
        "window.__ttPetDragState={value};window.dispatchEvent(new Event('pet:drag-state'));{end}"
    ));
}

fn primary_work_area(window: &gtk::ApplicationWindow) -> Option<Rect> {
    use gtk::prelude::WidgetExt;
    let display = window.display();
    let monitor = display.primary_monitor().or_else(|| display.monitor(0))?;
    let area = monitor.workarea();
    Some(Rect {
        x: area.x(),
        y: area.y(),
        width: area.width(),
        height: area.height(),
    })
}

/// The monitor the pet's sprite is on (the nearest one if it's in a gap).
fn screen_for_pet(
    window: &gtk::ApplicationWindow,
    size: &str,
    position: (i32, i32),
) -> Option<Rect> {
    let (x, y) = sprite_center(size, position);
    use gtk::prelude::WidgetExt;
    let display = window.display();
    let monitor = display
        .monitor_at_point(x, y)
        .or_else(|| display.primary_monitor())?;
    let area = monitor.geometry();
    Some(Rect {
        x: area.x(),
        y: area.y(),
        width: area.width(),
        height: area.height(),
    })
}

/// Make only the sprite square take pointer input; the transparent padding and
/// the bubble band pass clicks through to whatever is underneath.
fn apply_input_region(gtk_window: &gtk::ApplicationWindow, size: &str) {
    use gtk::prelude::WidgetExt;
    let (width, height) = window_size(size);
    let (x, y, side) = sprite_rect(width, height);
    let Some(gdk_window) = gtk_window.window() else {
        return;
    };
    let rect = gtk::cairo::RectangleInt::new(x as i32, y as i32, side as i32, side as i32);
    gdk_window.input_shape_combine_region(&gtk::cairo::Region::create_rectangle(&rect), 0, 0);
}

fn save_position<R: Runtime>(app: &AppHandle<R>, (x, y): (i32, i32)) {
    if let Some(path) = config_file(app, POSITION_FILE) {
        if let Err(error) = write_json_atomic(&path, &SavedPosition { x, y }) {
            eprintln!("[TokenTracker] failed to save the pet position: {error}");
        }
    }
}

fn load_position<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32)> {
    let raw = std::fs::read_to_string(config_file(app, POSITION_FILE)?).ok()?;
    let saved: SavedPosition = serde_json::from_str(&raw).ok()?;
    Some((saved.x, saved.y))
}

/// Resize to a size preset keeping the sprite's bottom edge where it is.
fn apply_size<R: Runtime>(window: &WebviewWindow<R>, size: &str) {
    use gtk::prelude::{GtkWindowExt, WidgetExt};
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let (width, height) = window_size(size);
    let (old_width, old_height) = gtk_window.size();
    let (x, y) = gtk_window.position();
    gtk_window.resize(width as i32, height as i32);
    if gtk_window.is_visible() && (old_width, old_height) != (width as i32, height as i32) {
        gtk_window.move_(x, y + old_height - height as i32);
    }
    apply_input_region(&gtk_window, size);
}

/// Follow the pointer until the left button is released. The overlay has no
/// window manager to run a move loop, so the pet moves itself.
fn start_overlay_drag<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    use gtk::prelude::{GtkWindowExt, WidgetExt};

    let state = app.state::<PetWindowState>();
    if let Ok(mut dragging) = state.dragging.lock() {
        if *dragging {
            return;
        }
        *dragging = true;
    }
    let Ok(gtk_window) = window.gtk_window() else {
        return;
    };
    let display = gtk_window.display();
    let Some(pointer) = display.default_seat().and_then(|seat| seat.pointer()) else {
        return;
    };
    let root = WidgetExt::screen(&gtk_window).and_then(|screen| screen.root_window());
    let Some(root) = root else {
        return;
    };
    let (_, px, py, _) = root.device_position(&pointer);
    let (wx, wy) = gtk_window.position();
    let offset = (px - wx, py - wy);
    let mut last_x = wx;
    let mut facing = "running-right";
    push_drag_state(window, Some(facing));

    let app = app.clone();
    let window = window.clone();
    gtk::glib::timeout_add_local(DRAG_INTERVAL, move || {
        let (_, x, y, mask) = root.device_position(&pointer);
        if !mask.contains(gtk::gdk::ModifierType::BUTTON1_MASK) {
            let size = app.state::<PetState>().get().size;
            let position = gtk_window.position();
            let clamped = screen_for_pet(&gtk_window, &size, position)
                .map(|screen| clamp_position(&size, position, screen))
                .unwrap_or(position);
            if clamped != position {
                gtk_window.move_(clamped.0, clamped.1);
            }
            save_position(&app, clamped);
            push_drag_state(&window, None);
            if let Ok(mut dragging) = app.state::<PetWindowState>().dragging.lock() {
                *dragging = false;
            }
            return gtk::glib::ControlFlow::Break;
        }
        let next = (x - offset.0, y - offset.1);
        if next.0 != last_x {
            let heading = if next.0 < last_x {
                "running-left"
            } else {
                "running-right"
            };
            if heading != facing {
                facing = heading;
                push_drag_state(&window, Some(facing));
            }
            last_x = next.0;
        }
        gtk_window.move_(next.0, next.1);
        gtk::glib::ControlFlow::Continue
    });
}

fn handle_pet_message<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, message: &str) {
    match message {
        "pet:drag" | "pet:drag-left" | "pet:drag-right" => {
            if app.state::<PetWindowState>().overlay {
                start_overlay_drag(app, window);
            } else if let Err(error) = window.start_dragging() {
                eprintln!("[TokenTracker] pet drag failed: {error}");
            }
        }
        // Launching the app again hands off to the running instance, which
        // raises the dashboard (tauri-plugin-single-instance).
        "pet:context-menu" => {
            if let Ok(exe) = std::env::current_exe() {
                let _ = Command::new(exe).spawn();
            }
        }
        // The bubble band is fixed on Linux (see BUBBLE_BAND).
        _ => {}
    }
}

/// Single entry point for both the pet page (`"pet:*"` strings, pet process)
/// and the dashboard's Pet page (`{ type, key?, value? }` objects, main process).
#[tauri::command]
pub fn pet_bridge<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, message: Value) {
    match (window.label(), &message) {
        (PET_LABEL, Value::String(text)) => handle_pet_message(&app, &window, text),
        (MAIN_LABEL, Value::Object(_)) => handle_dashboard_message(&app, &message),
        _ => {}
    }
}

fn build_pet_window<R: Runtime>(
    app: &AppHandle<R>,
    base_url: &str,
    settings: &PetSettings,
) -> Result<WebviewWindow<R>, String> {
    // No `?app=1`: it would set the sticky native-app flag in localStorage,
    // which this origin shares with the dashboard window.
    let url = format!("{base_url}/pet.html")
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid pet URL: {error}"))?;
    let (width, height) = window_size(&settings.size);
    let push_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::External(url));
    // Never share the dashboard's WebKit profile across processes (see PetContext).
    if let Ok(dir) = app.path().app_local_data_dir() {
        builder = builder.data_directory(dir.join("pet-webview"));
    }
    builder
        .title("TokenTracker Pet")
        .inner_size(width, height)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        // Keep the page transparent before its own stylesheet lands.
        .initialization_script(
            "try{var s=document.createElement('style');\
             s.textContent='html,body,#pet-root{background:transparent!important}';\
             (document.head||document.documentElement).appendChild(s);}catch(e){}",
        )
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                push_to_pet(&window, &push_app.state::<PetState>().get());
            }
        })
        .build()
        .map_err(|error| error.to_string())
}

fn show_pet_window<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, size: &str) {
    use gtk::prelude::{GtkWindowExt, WidgetExt};
    let Ok(gtk_window) = window.gtk_window() else {
        let _ = window.show();
        return;
    };
    let overlay = app.state::<PetWindowState>().overlay;
    if overlay {
        // Must be set on the unmapped window: the window manager then never
        // manages it, so it floats above every window and can go anywhere.
        gtk_window.realize();
        if let Some(gdk_window) = gtk_window.window() {
            gdk_window.set_override_redirect(true);
        }
        let saved = load_position(app);
        let screen = saved.and_then(|saved| screen_for_pet(&gtk_window, size, saved));
        let position = match (saved, screen) {
            (Some(saved), Some(screen)) => clamp_position(size, saved, screen),
            _ => primary_work_area(&gtk_window)
                .map(|area| default_position(size, area))
                .unwrap_or((0, 0)),
        };
        gtk_window.move_(position.0, position.1);
    }
    let _ = window.show();
    apply_input_region(&gtk_window, size);
}

fn modified(path: Option<&PathBuf>) -> Option<SystemTime> {
    std::fs::metadata(path?).and_then(|m| m.modified()).ok()
}

/// Follow `pet.json` and exit when the pet is turned off or the app is gone.
fn watch_settings<R: Runtime>(app: AppHandle<R>, parent: libc::pid_t) {
    let path = settings_path(&app);
    let mut last_modified = modified(path.as_ref());
    let mut current = app.state::<PetState>().get();
    gtk::glib::timeout_add_local(WATCH_INTERVAL, move || {
        // Re-parented means the app that launched the pet has exited.
        // SAFETY: getppid has no preconditions and cannot fail.
        if unsafe { libc::getppid() } != parent {
            app.exit(0);
            return gtk::glib::ControlFlow::Break;
        }
        let now = modified(path.as_ref());
        if now == last_modified {
            return gtk::glib::ControlFlow::Continue;
        }
        last_modified = now;
        let next = read_settings(path.as_ref());
        if !next.visible {
            app.exit(0);
            return gtk::glib::ControlFlow::Break;
        }
        if let Some(window) = app.get_webview_window(PET_LABEL) {
            if next.size != current.size {
                apply_size(&window, &next.size);
            }
            push_to_pet(&window, &next);
        }
        if let Ok(mut settings) = app.state::<PetState>().settings.lock() {
            *settings = next.clone();
        }
        current = next;
        gtk::glib::ControlFlow::Continue
    });
}

/// Entry point for `tokentracker-linux --pet <url>`.
pub fn run_pet_process(base_url: String, context: tauri::Context<tauri::Wry>) {
    // SAFETY: getppid has no preconditions and cannot fail.
    let parent = unsafe { libc::getppid() };
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pet_bridge])
        .setup(move |app| {
            let state = PetState::load(settings_path(app.handle()));
            let settings = state.get();
            app.manage(state);
            let window = build_pet_window(app.handle(), &base_url, &settings)?;
            app.manage(PetWindowState {
                overlay: is_x11(&window),
                dragging: Mutex::new(false),
            });
            show_pet_window(app.handle(), &window, &settings.size);
            watch_settings(app.handle().clone(), parent);
            Ok(())
        })
        .run(context);
    if let Err(error) = result {
        eprintln!("[TokenTracker] pet failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };

    #[test]
    fn sizes_normalize_to_the_three_presets() {
        assert_eq!(normalize_size("Large"), "large");
        assert_eq!(normalize_size(" small "), "small");
        assert_eq!(normalize_size("huge"), "medium");
    }

    #[test]
    fn characters_are_slugs_or_clawd() {
        assert_eq!(normalize_character("Sprout"), "sprout");
        assert_eq!(normalize_character("my-pet-2"), "my-pet-2");
        assert_eq!(normalize_character("'-alert(1)-'"), "clawd");
        assert_eq!(normalize_character("-bad"), "clawd");
        assert_eq!(normalize_character(""), "clawd");
        assert_eq!(normalize_character(&"a".repeat(65)), "clawd");
    }

    #[test]
    fn bot_colors_are_short_slugs_or_auto() {
        assert_eq!(normalize_bot_color("Mint"), "mint");
        assert_eq!(normalize_bot_color("red;alert(1)"), "auto");
        assert_eq!(normalize_bot_color(&"a".repeat(33)), "auto");
    }

    #[test]
    fn sprite_sits_under_the_bubble_band_for_every_size() {
        for size in ["small", "medium", "large"] {
            let (w, h) = window_size(size);
            let (x, y, side) = sprite_rect(w, h);
            assert!(y >= BUBBLE_BAND, "{size}: sprite overlaps the bubble band");
            assert!(y + side <= h, "{size}: sprite runs past the bottom");
            assert!(
                (x * 2.0 + side - w).abs() < 1e-9,
                "{size}: sprite not centred"
            );
        }
        // Same sprite sizes as Windows: base height - 138 band - 8.
        let (w, h) = window_size("medium");
        assert_eq!(sprite_rect(w, h).2, 254.0 - 138.0 - 8.0);
    }

    #[test]
    fn default_position_puts_the_sprite_in_the_bottom_right_corner() {
        let (x, y) = default_position("medium", SCREEN);
        let (w, h) = window_size("medium");
        let (sx, sy, side) = sprite_rect(w, h);
        assert_eq!(x + (sx + side) as i32, SCREEN.width - DEFAULT_MARGIN);
        assert_eq!(y + (sy + side) as i32, SCREEN.height - DEFAULT_MARGIN);
    }

    #[test]
    fn clamping_keeps_the_sprite_on_screen_but_lets_the_bubble_band_overhang() {
        let (w, h) = window_size("medium");
        let (sx, sy, side) = sprite_rect(w, h);
        // Dragged far past the top-left: the sprite stops at the corner, and the
        // window itself sits above/left of the screen.
        let (x, y) = clamp_position("medium", (-5000, -5000), SCREEN);
        assert_eq!((x + sx as i32, y + sy as i32), (0, 0));
        assert!(y < 0, "the transparent bubble band may leave the screen");
        // Past the bottom-right: the sprite's far corner stops at the screen's.
        let (x, y) = clamp_position("medium", (5000, 5000), SCREEN);
        assert_eq!(
            (x + (sx + side) as i32, y + (sy + side) as i32),
            (SCREEN.width, SCREEN.height)
        );
        // In range: untouched.
        assert_eq!(clamp_position("medium", (300, 200), SCREEN), (300, 200));
    }

    #[test]
    fn the_sprite_centre_decides_the_monitor_not_the_window_corner() {
        let (w, h) = window_size("medium");
        let (sx, sy, side) = sprite_rect(w, h);
        // A pet on a second monitor to the right, with its band hanging above.
        let (cx, cy) = sprite_center("medium", (2000, -100));
        assert_eq!(cx, 2000 + (sx + side / 2.0) as i32);
        assert_eq!(cy, -100 + (sy + side / 2.0) as i32);
        assert!(
            cx > SCREEN.width,
            "centre is on the monitor right of SCREEN"
        );
        assert!(
            cy >= 0,
            "centre is on screen even though the window corner is not"
        );
    }

    #[test]
    fn only_loopback_http_urls_start_a_pet_process() {
        let args = |url: &str| vec!["app".to_string(), PET_ARG.to_string(), url.to_string()];
        assert_eq!(
            pet_process_url(&args("http://127.0.0.1:17680/")),
            Some("http://127.0.0.1:17680".to_string())
        );
        assert!(pet_process_url(&args("http://localhost:4000")).is_some());
        assert_eq!(pet_process_url(&args("https://evil.example.com")), None);
        assert_eq!(pet_process_url(&args("http://127.0.0.2:17680")), None);
        assert_eq!(pet_process_url(&args("file:///etc/passwd")), None);
        assert_eq!(pet_process_url(&["app".to_string()]), None);
        assert_eq!(
            pet_process_url(&["app".to_string(), "tokentracker://auth".to_string()]),
            None
        );
    }

    #[test]
    fn context_keeps_only_short_string_values() {
        let context = PetContext::from_message(&serde_json::json!({
            "currency": "EUR",
            "exchangeRates": "x".repeat(CONTEXT_VALUE_MAX + 1),
            "locale": 7,
        }));
        assert_eq!(context.currency.as_deref(), Some("EUR"));
        assert_eq!(context.exchange_rates, None);
        assert_eq!(context.locale, None);
        assert_eq!(context.theme, None);
    }

    #[test]
    fn unchanged_updates_do_not_touch_the_file() {
        let dir = std::env::temp_dir().join(format!("tt-pet-touch-{}", std::process::id()));
        let path = dir.join(SETTINGS_FILE);
        let state = PetState::load(Some(path.clone()));
        state.update(false, |_| {});
        assert!(!path.exists(), "a no-op update must not bump pet.json");
        state.update(true, |_| {});
        assert!(
            path.exists(),
            "a forced update re-saves for the pet to pick up"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dashboard_settings_apply_by_key() {
        let mut settings = PetSettings::default();
        apply_setting(&mut settings, "visible", &Value::Bool(true));
        apply_setting(&mut settings, "size", &Value::String("large".into()));
        apply_setting(&mut settings, "botColor", &Value::String("mint".into()));
        apply_setting(&mut settings, "unknown", &Value::String("x".into()));
        assert!(settings.visible);
        assert_eq!(settings.size, "large");
        assert_eq!(settings.bot_color, "mint");
    }

    #[test]
    fn settings_round_trip_through_the_file() {
        let dir = std::env::temp_dir().join(format!("tt-pet-{}", std::process::id()));
        let path = dir.join(SETTINGS_FILE);
        let state = PetState::load(Some(path.clone()));
        assert_eq!(state.get(), PetSettings::default());
        state.update(false, |s| {
            s.visible = true;
            s.character = "BYTE".into();
        });
        let reloaded = PetState::load(Some(path));
        assert!(reloaded.get().visible);
        assert_eq!(reloaded.get().character, "byte");
        let _ = std::fs::remove_dir_all(dir);
    }
}
