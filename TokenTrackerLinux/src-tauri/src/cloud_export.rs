use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const MAXIMUM_BYTES: usize = 5 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExportMessage {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub filename: String,
    pub content: String,
    pub format: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub request_id: String,
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}

impl ExportMessage {
    fn valid(&self) -> bool {
        let Some(stem) = self
            .filename
            .strip_prefix("tokentracker-cloud-")
            .and_then(|name| name.strip_suffix(&format!(".{}", self.format)))
        else {
            return false;
        };
        let request = self.request_id.as_bytes();
        self.kind == "saveCloudUsageExport"
            && matches!(self.format.as_str(), "csv" | "json")
            && !stem.is_empty()
            && stem.len() <= 151
            && stem.as_bytes()[0].is_ascii_alphanumeric()
            && stem
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            && request.len() == 36
            && request.iter().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
            && !self.content.is_empty()
            && self.content.len() <= MAXIMUM_BYTES
            && !self.content.contains('\0')
            && (self.format != "json"
                || serde_json::from_str::<serde_json::Value>(&self.content)
                    .map(|value| value.is_object())
                    .unwrap_or(false))
    }

    pub fn failure(&self, code: &'static str) -> ExportResult {
        ExportResult {
            request_id: self.request_id.clone(),
            saved: false,
            filename: None,
            error_code: Some(code),
        }
    }

    // The native host resolves Downloads; callers cannot supply a directory.
    pub fn save(&self, directory: &Path) -> ExportResult {
        if !self.valid() {
            return self.failure("invalid_export");
        }
        let stem = &self.filename[..self.filename.len() - self.format.len() - 1];
        for index in 0..1000 {
            let name = if index == 0 {
                self.filename.clone()
            } else {
                format!("{stem}-{index}.{}", self.format)
            };
            let target = directory.join(&name);
            let mut file = match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&target)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return self.failure("save_failed"),
            };
            if file
                .write_all(self.content.as_bytes())
                .and_then(|()| file.sync_all())
                .is_err()
            {
                drop(file);
                let _ = fs::remove_file(target);
                return self.failure("save_failed");
            }
            return ExportResult {
                request_id: self.request_id.clone(),
                saved: true,
                filename: Some(name),
                error_code: None,
            };
        }
        self.failure("save_failed")
    }
}

pub fn permits_source(
    label: &str,
    source_origin: &str,
    current_origin: &str,
    managed: &str,
) -> bool {
    let expected = managed.strip_suffix('/').unwrap_or(managed);
    let port = expected
        .strip_prefix("http://127.0.0.1:")
        .filter(|port| port.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|port| {
            port.parse::<u16>()
                .ok()
                .filter(|value| value.to_string() == port)
        });
    label == "main"
        && port.is_some_and(|value| value > 0)
        && source_origin == expected
        && current_origin == expected
}

pub fn capability_url(managed: &str) -> Option<String> {
    let origin = managed.strip_suffix('/').unwrap_or(managed);
    permits_source("main", origin, origin, managed).then(|| format!("{origin}/*"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct PrivateDirectory(PathBuf);
    impl PrivateDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "tokentracker-export-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for PrivateDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn message() -> ExportMessage {
        ExportMessage {
            kind: "saveCloudUsageExport".into(),
            request_id: "00112233-4455-4677-8899-aabbccddeeff".into(),
            filename: "tokentracker-cloud-usage.csv".into(),
            format: "csv".into(),
            content: "date,tokens\nsynthetic,4\n".into(),
        }
    }

    #[test]
    fn actual_utf8_and_private_permissions() {
        let directory = PrivateDirectory::new();
        let mut export = message();
        export.content = "date,tokens\n合成,4\n".into();
        let result = export.save(&directory.0);
        assert!(result.saved);
        let path = directory.0.join(result.filename.unwrap());
        assert_eq!(fs::read(&path).unwrap(), export.content.as_bytes());
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn existing_and_symlink_destinations_are_retained() {
        let directory = PrivateDirectory::new();
        let export = message();
        let existing = directory.0.join(&export.filename);
        fs::write(&existing, "keep").unwrap();
        assert_eq!(
            export.save(&directory.0).filename.unwrap(),
            "tokentracker-cloud-usage-1.csv"
        );
        assert_eq!(fs::read_to_string(&existing).unwrap(), "keep");
        fs::remove_file(&existing).unwrap();
        let retained = directory.0.join("retained.txt");
        fs::write(&retained, "keep").unwrap();
        symlink(&retained, &existing).unwrap();
        assert_eq!(
            export.save(&directory.0).filename.unwrap(),
            "tokentracker-cloud-usage-2.csv"
        );
        assert_eq!(fs::read_to_string(retained).unwrap(), "keep");
    }

    #[test]
    fn invalid_payloads_never_write() {
        let directory = PrivateDirectory::new();
        for name in [
            "../tokentracker-cloud-a.csv",
            "tokentracker-cloud-a\\b.csv",
            "tokentracker-cloud-a.csv\n",
            "other.csv",
            "tokentracker-cloud-a.json",
        ] {
            let mut export = message();
            export.filename = name.into();
            assert_eq!(export.save(&directory.0).error_code, Some("invalid_export"));
        }
        for content in ["a\0b".to_string(), "字".repeat(MAXIMUM_BYTES / 3 + 1)] {
            let mut export = message();
            export.content = content;
            assert_eq!(export.save(&directory.0).error_code, Some("invalid_export"));
        }
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
        let mut export = message();
        export.content = "a".repeat(MAXIMUM_BYTES);
        assert!(export.valid());
    }

    #[test]
    fn object_json_and_exact_ipc_fields() {
        let mut export = message();
        export.filename = "tokentracker-cloud-usage.json".into();
        export.format = "json".into();
        for content in ["[]", "broken", "null"] {
            export.content = content.into();
            assert!(!export.valid());
        }
        export.content = "{\"synthetic\":true}".into();
        assert!(export.valid());
        assert!(serde_json::from_str::<ExportMessage>(r#"{"type":"saveCloudUsageExport","requestId":"fixture","filename":"tokentracker-cloud-a.csv","content":"synthetic","format":"csv","directory":"/tmp"}"#).is_err());
    }

    #[test]
    fn missing_directory_and_generic_reply() {
        let directory = PrivateDirectory::new();
        let export = message();
        let result = export.save(&directory.0.join("missing"));
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            serde_json::json!({"requestId":export.request_id,"saved":false,"errorCode":"save_failed"})
        );
    }

    #[test]
    fn exact_current_managed_origin_only() {
        let managed = "http://127.0.0.1:51956/";
        let origin = "http://127.0.0.1:51956";
        assert!(permits_source("main", origin, origin, managed));
        assert_eq!(
            capability_url(managed).as_deref(),
            Some("http://127.0.0.1:51956/*")
        );
        assert!(!permits_source("pet", origin, origin, managed));
        for other in [
            "http://127.0.0.1:7680",
            "http://localhost:51956",
            "https://127.0.0.1:51956",
            "http://user@127.0.0.1:51956",
            "https://hosted.example",
        ] {
            assert!(!permits_source("main", other, origin, managed));
            assert!(!permits_source("main", origin, other, managed));
        }
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub fn save_cloud_usage_export(
    webview: tauri::Webview,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::oauth::DashboardBaseUrl>,
    message: ExportMessage,
) -> ExportResult {
    use tauri::Manager;
    let current = webview
        .url()
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    let managed = state.get().unwrap_or_default();
    // The runtime ACL binds this command to the managed server's exact origin.
    // Tauri's Linux IPC initialization and invoke key exclude external frames.
    if webview.window().label() != "main"
        || !permits_source(webview.label(), &current, &current, &managed)
    {
        return message.failure("forbidden_source");
    }
    match app.path().download_dir() {
        Ok(directory) => message.save(&directory),
        Err(_) => message.failure("save_failed"),
    }
}
