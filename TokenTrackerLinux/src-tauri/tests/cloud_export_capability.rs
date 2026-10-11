use tauri_utils::acl::RemoteUrlPattern;
use tokentracker_linux::cloud_export::capability_url;

#[test]
fn runtime_export_permission_matches_only_the_managed_port() {
    let pattern: RemoteUrlPattern = capability_url("http://127.0.0.1:51956/")
        .unwrap()
        .parse()
        .unwrap();
    for url in [
        "http://127.0.0.1:51956/dashboard",
        "http://127.0.0.1:51956/cloud?view=daily",
    ] {
        assert!(pattern.test(&url.parse().unwrap()));
    }
    for url in [
        "http://127.0.0.1:7680/dashboard",
        "http://localhost:51956/dashboard",
        "http://127.0.0.1:51957/dashboard",
        "https://127.0.0.1:51956/dashboard",
        "http://127.0.0.1.evil.example:51956/dashboard",
        "https://hosted.example",
    ] {
        assert!(
            !pattern.test(&url.parse().unwrap()),
            "unexpected origin matched"
        );
    }
    let source: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/remote-dashboard.json")).unwrap();
    assert!(!source["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|permission| permission == "allow-save-cloud-usage-export"));
}

#[test]
fn invalid_managed_origins_cannot_create_a_file_permission() {
    for value in [
        "http://127.0.0.1:0/",
        "http://127.0.0.1:+51956/",
        "http://127.0.0.1:051956/",
        "http://127.0.0.1:65536/",
        "http://127.0.0.1:51956/path",
        "http://127.0.0.1:51956/?x=1",
        "http://127.0.0.1:51956/*",
        "http://localhost:51956/",
        "https://127.0.0.1:51956/",
        "http://user@127.0.0.1:51956/",
    ] {
        assert!(capability_url(value).is_none());
    }
}
