fn main() {
    // Declaring the app's own commands generates the `allow-open-oauth` /
    // `deny-open-oauth` (and `allow-set-ui-zoom` / `deny-set-ui-zoom`)
    // permissions that `capabilities/*.json` reference.
    //
    // Without an app manifest the ACL has no permission to grant, so the
    // remote-origin capability cannot authorize `open_oauth` and the build
    // fails validation. Note that adding a manifest also ACL-gates app
    // commands for the LOCAL origin, which is why `capabilities/default.json`
    // grants `allow-open-oauth` as well.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_oauth",
            "pet_bridge",
            "set_ui_zoom",
            "save_cloud_usage_export",
        ]),
    ))
    .expect("failed to run tauri-build");
}
