import { afterEach, describe, expect, it, vi } from "vitest";

import { getNativeOAuthBridge } from "./native-bridge.js";

describe("getNativeOAuthBridge", () => {
  afterEach(() => {
    delete window.webkit;
    delete window.__TAURI_INTERNALS__;
  });

  it("is null in a normal browser", () => {
    expect(getNativeOAuthBridge()).toBeNull();
  });

  it("uses the macOS/Windows nativeOAuth handler when present", () => {
    const handler = { postMessage: vi.fn() };
    window.webkit = { messageHandlers: { nativeOAuth: handler } };
    expect(getNativeOAuthBridge()).toBe(handler);
  });

  it("calls the Linux Tauri command when no handler could be attached", () => {
    const invoke = vi.fn(() => Promise.resolve());
    window.__TAURI_INTERNALS__ = { invoke };
    getNativeOAuthBridge().postMessage("https://auth.example/authorize");
    expect(invoke).toHaveBeenCalledWith("open_oauth", { url: "https://auth.example/authorize" });
  });
});
