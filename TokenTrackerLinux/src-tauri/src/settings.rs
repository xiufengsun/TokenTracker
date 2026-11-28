//! Persisted app-level settings (currently only the Silent Start toggle).
//!
//! The file lives under the XDG config dir (`~/.config/tokentracker/settings.json`).
//! Only the *write-side* hygiene of `server.rs` is mirrored here (0700 dir / 0600
//! file): the read-side hardening there (O_NOFOLLOW, uid check, mode rejection)
//! defends against forged *server records* naming PIDs, which a trusted-owner
//! settings file does not need. The path resolver is a pure function so tests can
//! inject directories without mutating process env.

use std::fs;
use std::io::Write;
// The `.mode()` builders below come from these unix extensions (same as server.rs).
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const SETTINGS_DIR: &str = "tokentracker";
const SETTINGS_FILE: &str = "settings.json";

/// Pure so tests can inject directories without mutating process env.
fn settings_path(xdg_config_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    // XDG_CONFIG_HOME alone is sufficient; HOME is required only for the
    // ~/.config fallback (a set XDG dir must not be discarded in stripped-down
    // environments where HOME is absent).
    let base = match xdg_config_home {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => Path::new(home?).join(".config"),
    };
    Some(base.join(SETTINGS_DIR).join(SETTINGS_FILE))
}

fn path_from_env() -> Option<PathBuf> {
    settings_path(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
}

/// The Silent Start toggle. A missing file/key or any IO/parse error reads as
/// `false` (the documented default) — never an error surfaced to the user.
pub fn silent_start() -> bool {
    read_bool(path_from_env().as_deref())
}

/// Persist the toggle. Takes effect on the next launch; a failed write is logged
/// and swallowed rather than surfacing an error.
pub fn set_silent_start(value: bool) {
    if let Some(path) = path_from_env() {
        write_bool(&path, value);
    }
}

fn read_bool(path: Option<&Path>) -> bool {
    let Some(path) = path else {
        return false;
    };
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("silent_start").and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn write_bool(path: &Path, value: bool) {
    let Some(dir) = path.parent() else {
        return;
    };
    // 0700/0600 mirrors `server.rs`: a permissive umask (0002, or 0000) would
    // otherwise leave these group- or world-writable.
    let _ = fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir);
    let json = serde_json::json!({ "silent_start": value });
    let written = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut file| file.write_all(json.to_string().as_bytes()));
    if let Err(error) = written {
        eprintln!("[TokenTracker] failed to persist settings: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Minimal scratch directory helper; the crate has no `tempfile` dependency
    // (same hand-rolled pattern as tests/paths.rs).
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "tokentracker-linux-settings-{label}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("scratch dir should be creatable");
            Self(path)
        }

        fn settings_file(&self) -> PathBuf {
            self.0.join(SETTINGS_DIR).join(SETTINGS_FILE)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn settings_path_prefers_xdg_config_home() {
        let path = settings_path(Some("/xdg/cfg"), Some("/home/u")).expect("both inputs set");
        assert_eq!(path, Path::new("/xdg/cfg/tokentracker/settings.json"));
    }

    #[test]
    fn settings_path_falls_back_to_home_config() {
        let path = settings_path(None, Some("/home/u")).expect("home set");
        assert_eq!(
            path,
            Path::new("/home/u/.config/tokentracker/settings.json")
        );
    }

    #[test]
    fn settings_path_resolves_xdg_config_home_without_home() {
        let path = settings_path(Some("/xdg/cfg"), None).expect("XDG set is enough");
        assert_eq!(path, Path::new("/xdg/cfg/tokentracker/settings.json"));
    }

    #[test]
    fn missing_file_reads_as_false() {
        let dir = TempDir::new("missing");
        assert!(!read_bool(Some(&dir.settings_file())));
        assert!(!read_bool(None));
    }

    #[test]
    fn corrupted_file_reads_as_false() {
        let dir = TempDir::new("corrupt");
        let file = dir.settings_file();
        fs::create_dir_all(file.parent().expect("parent")).expect("mkdir");
        fs::write(&file, "not json").expect("write scratch file");
        assert!(!read_bool(Some(&file)));
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = TempDir::new("roundtrip");
        let file = dir.settings_file();
        write_bool(&file, true);
        assert!(read_bool(Some(&file)));
        write_bool(&file, false);
        assert!(!read_bool(Some(&file)));
    }

    #[cfg(unix)]
    #[test]
    fn written_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new("perms");
        let file = dir.settings_file();
        write_bool(&file, true);
        let dir_mode = fs::metadata(dir.0.join(SETTINGS_DIR))
            .expect("dir")
            .permissions()
            .mode();
        let file_mode = fs::metadata(&file).expect("file").permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700);
        assert_eq!(file_mode & 0o777, 0o600);
    }
}
