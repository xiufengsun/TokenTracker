//! The window navigates to `http://127.0.0.1:<port>`, which Tauri classifies as
//! a REMOTE origin. Remote origins are ACL-gated even when the app ships no
//! manifest, so a missing or mis-scoped capability silently breaks the
//! `open_oauth` invoke and therefore OAuth sign-in. These tests pin the parts of
//! that contract that are easy to regress by editing JSON.

use std::path::{Path, PathBuf};

use tauri_utils::acl::capability::{Capability, PermissionEntry};
use tauri_utils::acl::RemoteUrlPattern;

fn src_tauri_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn load_capability(name: &str) -> Capability {
    let path = src_tauri_dir().join("capabilities").join(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    // Deserializing through Tauri's own type means an unknown or misspelled
    // field fails here rather than at bundle time.
    serde_json::from_str(&raw)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn permission_identifiers(capability: &Capability) -> Vec<String> {
    capability
        .permissions
        .iter()
        .map(|entry| match entry {
            PermissionEntry::PermissionRef(identifier) => identifier.get().to_string(),
            PermissionEntry::ExtendedPermission { identifier, .. } => identifier.get().to_string(),
        })
        .collect()
}

#[test]
fn capability_files_exist_and_parse() {
    for name in ["default.json", "remote-dashboard.json"] {
        let capability = load_capability(name);
        assert!(
            !capability.identifier.is_empty(),
            "{name} must declare an identifier"
        );
        assert!(
            capability.windows.iter().any(|window| window == "main"),
            "{name} must apply to the \"main\" window"
        );
    }
}

#[test]
fn remote_capability_grants_open_oauth_to_the_loopback_dashboard() {
    let capability = load_capability("remote-dashboard.json");

    let remote = capability
        .remote
        .as_ref()
        .expect("remote-dashboard.json must declare a `remote` block, or the loopback dashboard cannot use IPC at all");
    assert!(!remote.urls.is_empty(), "`remote.urls` must not be empty");

    assert!(
        !capability.local,
        "the remote capability should not also grant the local origin; that is what default.json is for"
    );

    assert_eq!(
        permission_identifiers(&capability),
        vec!["allow-open-oauth".to_string()],
        "the remote origin must be scoped to open_oauth only -- never core:default"
    );
}

#[test]
fn local_capability_covers_core_and_open_oauth() {
    let capability = load_capability("default.json");
    let permissions = permission_identifiers(&capability);

    assert!(
        capability.local,
        "default.json must keep the local execution context"
    );
    assert!(
        permissions.contains(&"core:default".to_string()),
        "the local shell page needs the core default permission set"
    );
    // Declaring an app manifest in build.rs ACL-gates app commands for the LOCAL
    // origin too, so omitting this would break local invokes.
    assert!(
        permissions.contains(&"allow-open-oauth".to_string()),
        "declaring an app manifest gates app commands locally as well"
    );
}

#[test]
fn pet_capability_grants_only_pet_bridge_to_both_windows() {
    let capability = load_capability("pet.json");

    assert!(
        !capability.local,
        "the pet page and dashboard are loopback REMOTE origins"
    );
    assert!(
        capability.remote.is_some(),
        "pet.json must declare the loopback remote block"
    );
    for window in ["main", "pet"] {
        assert!(
            capability.windows.iter().any(|w| w == window),
            "pet.json must apply to the \"{window}\" window"
        );
    }
    assert_eq!(
        permission_identifiers(&capability),
        vec!["allow-pet-bridge".to_string()],
        "the pet capability must stay scoped to pet_bridge -- never core:default"
    );
    assert_eq!(
        capability.remote.as_ref().map(|r| r.urls.clone()),
        load_capability("remote-dashboard.json")
            .remote
            .map(|r| r.urls),
        "the pet bridge must be reachable from exactly the dashboard's origins"
    );
}

/// The server prefers port 17680 but falls back to an OS-assigned port, so the
/// remote URL pattern has to match an arbitrary port. A pattern that omits the
/// port matches only the scheme default (port 80 for http) and would reject
/// every real dashboard origin.
#[test]
fn remote_urls_match_any_loopback_port() {
    let capability = load_capability("remote-dashboard.json");
    let patterns: Vec<RemoteUrlPattern> = capability
        .remote
        .as_ref()
        .expect("remote block")
        .urls
        .iter()
        .map(|url| {
            url.parse()
                .unwrap_or_else(|error| panic!("invalid remote URL pattern {url}: {error:?}"))
        })
        .collect();

    let matches_any = |candidate: &str| {
        let url = candidate.parse().expect("valid URL");
        patterns.iter().any(|pattern| pattern.test(&url))
    };

    // The preferred fixed port and an arbitrary fallback port both matter.
    for allowed in [
        "http://127.0.0.1:17680/",
        "http://127.0.0.1:39215/",
        "http://127.0.0.1:1/",
        "http://127.0.0.1:65535/auth/callback?insforge_code=abc&app=1",
    ] {
        assert!(matches_any(allowed), "should have matched {allowed}");
    }

    // ...and the grant must not leak beyond loopback http.
    for denied in [
        "https://127.0.0.1:17680/",
        "http://127.0.0.2:17680/",
        "http://evil.example.com/",
        "http://127.0.0.1.evil.com/",
    ] {
        assert!(!matches_any(denied), "should NOT have matched {denied}");
    }
}

/// Regression guard for the exact mistake that makes this silently useless:
/// writing `http://127.0.0.1` (no port) instead of `http://127.0.0.1:*`.
#[test]
fn a_portless_pattern_would_not_match_the_dashboard() {
    let portless: RemoteUrlPattern = "http://127.0.0.1".parse().expect("parses");
    let dashboard = "http://127.0.0.1:17680/".parse().expect("valid URL");

    assert!(
        !portless.test(&dashboard),
        "if this ever starts matching, the `:*` port wildcard in remote-dashboard.json is no longer load-bearing"
    );
}

#[test]
fn bundle_produces_the_three_supported_linux_targets() {
    let raw = std::fs::read_to_string(src_tauri_dir().join("tauri.conf.json"))
        .expect("tauri.conf.json should be readable");
    let config: serde_json::Value = serde_json::from_str(&raw).expect("tauri.conf.json is JSON");
    let bundle = &config["bundle"];

    assert_eq!(
        bundle["active"], true,
        "bundling must be enabled or the release produces no artifact at all"
    );
    // Every target here becomes a release asset that the `publish` job's
    // required-asset check must also list, so this stays an explicit set rather
    // than "whatever tauri defaults to".
    assert_eq!(
        bundle["targets"],
        serde_json::json!(["appimage", "deb", "rpm"]),
        "Linux ships an AppImage plus native packages for apt and dnf; \
         changing this set means updating the release workflow's build, \
         payload verification and publish asset list together"
    );

    // The embedded runtime is layered in via tauri.bundle.conf.json instead,
    // because tauri-build rejects a missing resource path and EmbeddedServer is
    // generated on demand -- declaring it here breaks plain `cargo test`.
    assert!(
        bundle.get("resources").is_none(),
        "resources must stay in tauri.bundle.conf.json"
    );
}

#[test]
fn bundle_overlay_ships_the_embedded_runtime() {
    let raw = std::fs::read_to_string(src_tauri_dir().join("tauri.bundle.conf.json"))
        .expect("tauri.bundle.conf.json should be readable");
    let config: serde_json::Value = serde_json::from_str(&raw).expect("overlay is JSON");

    let resources = &config["bundle"]["resources"];
    assert_eq!(
        resources["../EmbeddedServer"], "EmbeddedServer",
        "the AppImage must carry the bundled Node runtime, mapped where paths.rs looks for it"
    );
}

#[test]
fn build_script_declares_the_open_oauth_command() {
    let build_rs = std::fs::read_to_string(src_tauri_dir().join("build.rs"))
        .expect("build.rs should be readable");

    // Without this the `allow-open-oauth` permission is never generated and the
    // capability files fail validation.
    assert!(
        build_rs.contains("app_manifest"),
        "build.rs must declare an app manifest"
    );
    assert!(
        build_rs.contains("open_oauth"),
        "build.rs must list the open_oauth command"
    );
}

#[test]
fn autogenerated_permission_matches_the_capability_reference() {
    let path = src_tauri_dir()
        .join("permissions")
        .join("autogenerated")
        .join("open_oauth.toml");
    if !Path::new(&path).exists() {
        // Generated by tauri-build; absent on a clean checkout before the first
        // build. Nothing to assert in that case.
        return;
    }

    let contents = std::fs::read_to_string(&path).expect("permission file readable");
    assert!(
        contents.contains("allow-open-oauth"),
        "tauri-build should generate the identifier the capabilities reference"
    );
}
