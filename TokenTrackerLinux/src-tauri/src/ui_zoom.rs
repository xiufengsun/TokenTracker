//! Dashboard UI zoom: where a launch starts, how the hotkeys step it, and how
//! the choice survives a restart.
//!
//! The dashboard is a web UI, so every size in it is a CSS pixel. The webview
//! maps CSS pixels onto logical pixels one to one, which is exactly right on a
//! display that scales the whole desktop -- and it also means the Linux client
//! otherwise has no say in how large the dashboard reads next to the native
//! windows around it. On a desktop running at 125% or 150% the UI is
//! consistently reported as too small, which is what a zoom level is for.
//!
//! Tauri ships its own zoom hotkeys (`src/webview/scripts/zoom-hotkey.js`), and
//! on this client they are inert for two independent reasons:
//!
//! 1. The script invokes `plugin:webview|set_webview_zoom`, which requires
//!    `core:webview:allow-set-webview-zoom`. The dashboard is served from
//!    `http://127.0.0.1:<port>`, i.e. a REMOTE origin, and the remote
//!    capability deliberately grants nothing beyond what the dashboard itself
//!    needs -- so the ACL rejects the invoke and the keys do nothing at all.
//! 2. Even if it were granted, the level lives in a JS local
//!    (`let zoomLevel = 1`), so it is back to 100% on the next launch and users
//!    on a scaling desktop have to re-apply it every single time.
//!
//! This module owns the level instead: [`resolve_zoom`] decides where a launch
//! starts, [`step_zoom`] is what the injected hotkey bridge applies, and
//! [`store_zoom`] makes the result outlive the process.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// Smallest level the UI accepts. Below this the dashboard is unusable and the
/// user has no obvious way back without the keyboard.
pub const MIN_ZOOM: f64 = 0.5;

/// Largest level the UI accepts. Beyond this the dashboard is effectively
/// unusable too, and a stray `Ctrl + wheel` should not be able to get there.
pub const MAX_ZOOM: f64 = 3.0;

/// Level used when neither the environment nor the stored value says anything.
///
/// Deliberately 100%: the point of this module is to let a user *choose* a
/// level for their desktop, not to guess one, so the default keeps every
/// existing install looking exactly as it does today.
pub const DEFAULT_ZOOM: f64 = 1.0;

/// One hotkey press or wheel notch.
///
/// Tauri's built-in script steps by 0.2, which cannot express the two levels
/// scaling desktops actually offer: 125% and 150%. 0.1 reaches both.
pub const ZOOM_STEP: f64 = 0.1;

/// Environment override, checked before the stored value.
///
/// Kept in the app's `TOKENTRACKER_` namespace so a launcher, a desktop entry or
/// a machine-specific dotfiles layer can pin the level without touching state
/// the app writes.
pub const ZOOM_ENV: &str = "TOKENTRACKER_UI_ZOOM";

/// Clamp a level into [`MIN_ZOOM`]..=[`MAX_ZOOM`], rounding away the drift that
/// repeated `+ 0.1` would otherwise accumulate (`1.4000000000000001`).
///
/// `NaN` resolves to [`DEFAULT_ZOOM`] rather than propagating: `f64::clamp`
/// returns `NaN` unchanged, and a `NaN` zoom would render the dashboard at an
/// unpredictable size with no way to reason about it.
pub fn clamp_zoom(value: f64) -> f64 {
    if value.is_nan() {
        return DEFAULT_ZOOM;
    }
    round_zoom(value.clamp(MIN_ZOOM, MAX_ZOOM))
}

/// The level after one step. `delta` is `+ZOOM_STEP` for zoom in, `-ZOOM_STEP`
/// for zoom out and `0.0` for a reset.
pub fn step_zoom(current: f64, delta: f64) -> f64 {
    clamp_zoom(current + delta)
}

/// Parse a user-supplied level. Unparsable or non-finite input is reported as
/// "not set" rather than as `0`, so a typo can never leave the dashboard
/// unreadably small -- it just falls back to the next source.
pub fn parse_zoom(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    // `"nan"` and `"inf"` both parse as f64; neither is a level.
    let value = trimmed.parse::<f64>().ok()?;
    if !value.is_finite() {
        return None;
    }
    Some(round_zoom(value))
}

/// Where a launch starts: the environment first, then the level the hotkeys
/// last stored, then [`DEFAULT_ZOOM`].
pub fn resolve_zoom(env_value: Option<&str>, stored: Option<f64>) -> f64 {
    if let Some(raw) = env_value {
        if let Some(zoom) = parse_zoom(raw) {
            return clamp_zoom(zoom);
        }
    }
    match stored {
        Some(zoom) => clamp_zoom(zoom),
        None => DEFAULT_ZOOM,
    }
}

/// `$XDG_CONFIG_HOME/tokentracker/ui-zoom`, falling back to
/// `$HOME/.config/tokentracker/ui-zoom`.
///
/// Injected rather than read from the environment so the precedence stays unit
/// testable, matching `paths::RuntimeRoots`. The CLI writes machine state under
/// `~/.tokentracker/`; this is a desktop-preferences file and belongs in the
/// config directory instead.
pub fn zoom_path_in(xdg_config_home: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    let base = xdg_config_home.or_else(|| home.map(|home| home.join(".config")))?;
    Some(base.join("tokentracker").join("ui-zoom"))
}

/// [`zoom_path_in`] wired to the real process environment.
pub fn default_zoom_path() -> Option<PathBuf> {
    zoom_path_in(
        env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        env::var_os("HOME").map(PathBuf::from),
    )
}

/// Read a stored level, treating a missing or unreadable file as "not set".
pub fn load_zoom(path: &Path) -> Option<f64> {
    parse_zoom(&fs::read_to_string(path).ok()?)
}

/// Persist a level.
///
/// Writes to a sibling temporary file and renames it into place, so an
/// interrupted write (or a second instance racing on the same path) can never
/// leave a truncated file behind to be read as a level.
pub fn store_zoom(path: &Path, zoom: f64) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }

    let value = clamp_zoom(zoom);
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, format!("{value}\n"))
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))
}

/// Two decimal places, which is finer than one [`ZOOM_STEP`] and keeps the
/// rounded arithmetic exact for every level a user can reach with the hotkeys.
fn round_zoom(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_zoom(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.0001,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn a_launch_with_no_configuration_starts_at_one() {
        assert_zoom(resolve_zoom(None, None), DEFAULT_ZOOM);
    }

    #[test]
    fn the_environment_wins_over_the_stored_level() {
        assert_zoom(resolve_zoom(Some("1.5"), Some(1.2)), 1.5);
    }

    #[test]
    fn an_unparsable_environment_value_falls_through_to_the_stored_level() {
        for raw in ["", "  ", "big", "1,5", "nan", "inf", "-inf"] {
            assert_zoom(resolve_zoom(Some(raw), Some(1.4)), 1.4);
        }
    }

    #[test]
    fn an_out_of_range_environment_value_is_clamped_rather_than_rejected() {
        assert_zoom(resolve_zoom(Some("99"), None), MAX_ZOOM);
        assert_zoom(resolve_zoom(Some("0.01"), None), MIN_ZOOM);
    }

    #[test]
    fn a_stored_level_outside_the_range_is_clamped() {
        assert_zoom(resolve_zoom(None, Some(42.0)), MAX_ZOOM);
        assert_zoom(resolve_zoom(None, Some(-1.0)), MIN_ZOOM);
    }

    /// A `NaN` level would reach the webview as an unpredictable size, so it has
    /// to resolve to something renderable.
    #[test]
    fn a_nan_level_resolves_to_the_default() {
        assert_zoom(clamp_zoom(f64::NAN), DEFAULT_ZOOM);
    }

    #[test]
    fn stepping_reaches_the_levels_scaling_desktops_use() {
        assert_zoom(step_zoom(1.0, ZOOM_STEP), 1.1);
        assert_zoom(step_zoom(1.4, ZOOM_STEP), 1.5);
        assert_zoom(step_zoom(1.5, ZOOM_STEP), 1.6);
        assert_zoom(step_zoom(1.6, -ZOOM_STEP), 1.5);
    }

    /// Repeated stepping must not drift into `1.4000000000000001`, which would
    /// then be written to disk and read back.
    #[test]
    fn repeated_stepping_stays_exact() {
        let mut zoom = DEFAULT_ZOOM;
        for _ in 0..5 {
            zoom = step_zoom(zoom, ZOOM_STEP);
        }
        assert_zoom(zoom, 1.5);
        assert_eq!(format!("{zoom}"), "1.5");
    }

    #[test]
    fn stepping_stops_at_the_bounds() {
        assert_zoom(step_zoom(MAX_ZOOM, ZOOM_STEP), MAX_ZOOM);
        assert_zoom(step_zoom(MIN_ZOOM, -ZOOM_STEP), MIN_ZOOM);
    }

    #[test]
    fn the_config_path_prefers_xdg_config_home() {
        let path = zoom_path_in(
            Some(PathBuf::from("/xdg/config")),
            Some(PathBuf::from("/home/user")),
        );
        assert_eq!(
            path,
            Some(PathBuf::from("/xdg/config/tokentracker/ui-zoom"))
        );
    }

    #[test]
    fn the_config_path_falls_back_to_dot_config_under_home() {
        let path = zoom_path_in(None, Some(PathBuf::from("/home/user")));
        assert_eq!(
            path,
            Some(PathBuf::from("/home/user/.config/tokentracker/ui-zoom"))
        );
    }

    #[test]
    fn the_config_path_is_unavailable_without_a_home() {
        assert_eq!(zoom_path_in(None, None), None);
    }

    #[test]
    fn a_stored_level_survives_a_round_trip() {
        let directory =
            env::temp_dir().join(format!("tokentracker-ui-zoom-{}", std::process::id()));
        let path = directory.join("tokentracker").join("ui-zoom");

        store_zoom(&path, 1.5).expect("store");
        assert_zoom(load_zoom(&path).expect("load"), 1.5);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_unreadable_store_is_treated_as_not_set() {
        let missing = env::temp_dir().join("tokentracker-ui-zoom-does-not-exist");
        assert_eq!(load_zoom(&missing), None);
    }
}
