/**
 * Bridge helpers for talking to the macOS TokenTrackerBar host via WKWebView's
 * `window.webkit.messageHandlers.nativeBridge` or the Windows WebView2 host via
 * `window.chrome.webview`. The native side dispatches a `native:settings`
 * CustomEvent on `window` whenever state changes.
 *
 * Safe no-ops in browser/cloud mode.
 */

const NATIVE_APP_KEY = "tokentracker_native_app";

// Module-level cache for native system appearance.
// An always-on listener (installed at module load) keeps this fresh,
// so React components don't depend on lifecycle ordering to receive
// `native:systemAppearanceChanged` events.
let nativeSystemDark = null; // null = unknown, true/false = native push received
const nativeSystemListeners = new Set();

if (typeof window !== "undefined") {
  window.addEventListener("native:systemAppearanceChanged", (event) => {
    const d = event?.detail?.isDark;
    if (typeof d !== "boolean") return;
    nativeSystemDark = d;
    // Defensive: also write .dark directly so the page reflects the change
    // even before React re-renders. ThemeProvider's applyThemeToDOM will
    // converge on the same value moments later.
    try {
      const root = document.documentElement;
      if (d) root.classList.add("dark");
      else root.classList.remove("dark");
    } catch { /* ignore */ }
    nativeSystemListeners.forEach((cb) => {
      try { cb(d); } catch { /* ignore listener errors */ }
    });
  });
}

/** Latest system appearance pushed by native, or null if none yet. */
export function getCachedNativeSystemDark() {
  return nativeSystemDark;
}

/** Subscribe to native system appearance changes. Returns unsubscribe fn. */
export function subscribeNativeSystemAppearance(callback) {
  nativeSystemListeners.add(callback);
  return () => nativeSystemListeners.delete(callback);
}

export function isNativeApp() {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("app") === "1") {
      try { window.localStorage.setItem(NATIVE_APP_KEY, "1"); } catch { /* ignore */ }
      return true;
    }
    return window.localStorage.getItem(NATIVE_APP_KEY) === "1";
  } catch {
    return false;
  }
}

/** True when running inside TokenTrackerBar WKWebView (bridge is always present). */
export function isNativeEmbed() {
  if (typeof window === "undefined") return false;
  return Boolean(window.webkit?.messageHandlers?.nativeBridge);
}

/**
 * True when running inside the Windows tray app's WebView2 host
 * (`window.chrome.webview` exists only there) in native-app mode. Used to hide
 * macOS-only features (e.g. the Widgets page) on Windows.
 */
export function isNativeWindowsApp() {
  if (typeof window === "undefined") return false;
  return Boolean(window.chrome?.webview) && isNativeApp();
}

/**
 * True when running inside the Linux Tauri app. Tauri injects
 * `__TAURI_INTERNALS__` into every webview it hosts, and the Linux app loads
 * the dashboard without `?app=1`, so this can't key off `isNativeApp()`.
 */
export function isNativeLinuxApp() {
  if (typeof window === "undefined") return false;
  return Boolean(window.__TAURI_INTERNALS__);
}

/**
 * Set by the Linux app (`desktop.rs`) on GNOME Shell when the top-bar
 * extension is installed but not turned on.
 */
export function canOfferTopBarExtension() {
  if (typeof window === "undefined") return false;
  return window.__TOKENTRACKER_OFFER_TOP_BAR__ === true;
}

/**
 * The handler that opens OAuth in the system browser, or null in a normal
 * browser. macOS and Windows expose `webkit.messageHandlers.nativeOAuth`. The
 * Linux shell's copy of it may never attach to WebKitGTK's host object, so
 * there the Tauri command is called directly.
 */
export function getNativeOAuthBridge() {
  if (typeof window === "undefined") return null;
  const handler = window.webkit?.messageHandlers?.nativeOAuth;
  if (handler) return handler;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== "function") return null;
  return { postMessage: (url) => invoke("open_oauth", { url }) };
}

function getHandler() {
  if (typeof window === "undefined") return null;
  return window.webkit?.messageHandlers?.nativeBridge ?? null;
}

export function isBridgeAvailable() {
  if (typeof window === "undefined") return false;
  return Boolean(getHandler() || window.chrome?.webview);
}

function post(message) {
  const handler = getHandler();
  if (handler) {
    try {
      handler.postMessage(message);
      return true;
    } catch (err) {
      console.warn("[tokentracker] nativeBridge post failed:", err);
      return false;
    }
  }

  // WebView2 exposes a single JSON message channel instead of WKWebView's
  // messageHandlers namespace. Keep the public bridge API identical so native
  // settings work on both desktop platforms.
  if (typeof window !== "undefined" && window.chrome?.webview) {
    try {
      window.chrome.webview.postMessage(typeof message === "string" ? message : JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Post a generic message to either native host. */
export function postNativeMessage(message) {
  return post(message);
}

const CLOUD_EXPORT_EVENT = "tokentracker:cloud-export-result";
const CLOUD_EXPORT_MAX_BYTES = 5 * 1024 * 1024;
const CLOUD_EXPORT_NAME = /^tokentracker-cloud-[A-Za-z0-9][A-Za-z0-9_-]{0,150}\.(csv|json)$/;

function cloudExportError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Native saves acknowledge the actual write. Browser callers use their Blob fallback. */
export function saveCloudUsageExport({ filename, content, format, signal }) {
  const native = typeof window !== "undefined" && (
    isNativeEmbed() || isNativeWindowsApp() || isNativeLinuxApp() || isNativeApp()
  );
  if (!native) return Promise.resolve(null);
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  if ((format !== "csv" && format !== "json") || typeof filename !== "string"
    || !CLOUD_EXPORT_NAME.test(filename) || !filename.endsWith(`.${format}`)
    || typeof content !== "string" || !content || content.includes("\0")
    || new TextEncoder().encode(content).byteLength > CLOUD_EXPORT_MAX_BYTES) {
    return Promise.reject(cloudExportError("invalid_export"));
  }

  const mac = window.webkit?.messageHandlers?.nativeBridge;
  const win = window.chrome?.webview;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (window.__TOKENTRACKER_CLOUD_EXPORT__ !== true
    || !(typeof mac?.postMessage === "function" || typeof win?.postMessage === "function"
      || typeof invoke === "function")) {
    return Promise.reject(cloudExportError("unsupported"));
  }
  const requestId = crypto.randomUUID();
  const stem = filename.slice(0, -(format.length + 1));
  const payload = { type: "saveCloudUsageExport", requestId, filename, content, format };
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener(CLOUD_EXPORT_EVENT, receive);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const acknowledge = (detail) => {
      if (!detail || detail.requestId !== requestId) return;
      const savedName = detail.filename;
      const collisionName = typeof savedName === "string" && savedName.startsWith(`${stem}-`)
        && /^-[1-9]\d{0,2}\.(csv|json)$/.test(savedName.slice(stem.length)) && savedName.endsWith(`.${format}`);
      if (detail.saved === true && (savedName === filename || collisionName)) {
        finish(null, { saved: true, filename: detail.filename });
      } else {
        const code = ["invalid_export", "forbidden_source", "save_failed", "unsupported"]
          .includes(detail.errorCode) ? detail.errorCode : "save_failed";
        finish(cloudExportError(code));
      }
    };
    const receive = (event) => acknowledge(event.detail);
    window.addEventListener(CLOUD_EXPORT_EVENT, receive);
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(cloudExportError("save_timeout")), 15000);
    if (signal?.aborted) { abort(); return; }
    try {
      if (typeof mac?.postMessage === "function") mac.postMessage(payload);
      else if (typeof win?.postMessage === "function") win.postMessage(JSON.stringify(payload));
      else Promise.resolve(invoke("save_cloud_usage_export", { message: payload }))
        .then(acknowledge, () => finish(cloudExportError("save_failed")));
    } catch {
      finish(cloudExportError("save_failed"));
    }
  });
}

export function notifyNative({ title, body, id }) {
  return postNativeMessage({ type: "notify", title, body, id });
}

export function requestNativeSettings() {
  return post({ type: "getSettings" });
}

export function setNativeSetting(key, value) {
  return post({ type: "setSetting", key, value });
}

export function nativeAction(name) {
  return post({ type: "action", name });
}

export function requestNativeSystemAppearance() {
  return post({ type: "getSystemAppearance" });
}

/**
 * macOS Dashboard 窗口：与 Web 主题同步 NSWindow.appearance。
 * `theme === "system"` 时原生侧将窗口 appearance 置为跟随系统；系统切换时再由原生推送 `native:systemAppearanceChanged`（WKWebView 内 matchMedia 常不刷新）。
 * @param {"light" | "dark"} resolvedTheme
 * @param {"light" | "dark" | "system"} theme
 */
export function syncNativeChromeAppearance(resolvedTheme, theme) {
  if (!isNativeEmbed()) return;
  const isDark = resolvedTheme === "dark";
  post({ type: "setChromeAppearance", isDark, theme: theme ?? "system" });
}

/**
 * Subscribe to native settings updates. Returns an unsubscribe function.
 * The handler is invoked with the settings object (`detail` of the CustomEvent).
 */
export function onNativeSettings(handler) {
  if (typeof window === "undefined") return () => {};
  const listener = (event) => {
    if (event && event.detail && typeof event.detail === "object") {
      handler(event.detail);
    }
  };
  window.addEventListener("native:settings", listener);
  return () => window.removeEventListener("native:settings", listener);
}

/** Desktop-pet settings are supported by the macOS, Windows and Linux native hosts. */
export function isPetBridgeAvailable() {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.webkit?.messageHandlers?.nativeBridge || window.chrome?.webview || isNativeLinuxApp(),
  );
}

function postPetMessage(message) {
  if (typeof window === "undefined") return false;
  const macHandler = window.webkit?.messageHandlers?.nativeBridge;
  if (macHandler) {
    try {
      macHandler.postMessage(message);
      return true;
    } catch { return false; }
  }
  if (window.chrome?.webview) {
    try {
      window.chrome.webview.postMessage(JSON.stringify(message));
      return true;
    } catch { return false; }
  }
  // Linux Tauri host: replies arrive as `native:petSettings` events, same as the others.
  if (isNativeLinuxApp()) {
    try {
      window.__TAURI_INTERNALS__.invoke("pet_bridge", { message })?.catch?.(() => {});
      return true;
    } catch { return false; }
  }
  return false;
}

export function requestNativePetSettings() {
  return postPetMessage({ type: "getPetSettings" });
}

export function setNativePetSetting(key, value) {
  return postPetMessage({ type: "setPetSetting", key, value });
}

export function refreshNativePetCatalog() {
  return postPetMessage({ type: "refreshPetCatalog" });
}

export function onNativePetSettings(handler) {
  if (typeof window === "undefined") return () => {};
  const listener = (event) => {
    if (event?.detail && typeof event.detail === "object") handler(event.detail);
  };
  window.addEventListener("native:petSettings", listener);
  return () => window.removeEventListener("native:petSettings", listener);
}
