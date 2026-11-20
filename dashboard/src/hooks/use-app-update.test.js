import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNewerVersion, normalizeVersion } from "./use-app-update.js";
import { LocaleProvider } from "../ui/foundation/LocaleProvider.jsx";
import { SidebarUpdatePill } from "../ui/components/SidebarUpdatePill.jsx";

/**
 * Install a mock WebView2 bridge on `window.chrome.webview` and mark native-app mode.
 * @returns {Array<object>}
 */
function installWindowsBridge() {
  const messages = [];
  window.localStorage.setItem("tokentracker_native_app", "1");
  window.chrome = {
    webview: {
      postMessage(raw) {
        messages.push(typeof raw === "string" ? JSON.parse(raw) : raw);
      },
    },
  };
  return messages;
}

/**
 * Dispatch a `native:settings` event from the simulated Windows host.
 * @param {object} detail
 */
function pushNativeSettings(detail) {
  window.dispatchEvent(new CustomEvent("native:settings", { detail }));
}

/**
 * Render SidebarUpdatePill wrapped in LocaleProvider.
 * @param {{ collapsed?: boolean }} props
 */
function renderPill(props = { collapsed: false }) {
  return render(
    React.createElement(
      LocaleProvider,
      null,
      React.createElement(SidebarUpdatePill, props),
    ),
  );
}

describe("useAppUpdate & SidebarUpdatePill", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.chrome;
    delete window.webkit;
    delete window.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.chrome;
    delete window.webkit;
    delete window.__TAURI_INTERNALS__;
  });

  it("normalizes and compares dotted version strings", () => {
    expect(normalizeVersion("v1.5.12+abc")).toBe("1.5.12");
    expect(isNewerVersion("1.5.9", "v1.5.10")).toBe(true);
    expect(isNewerVersion("1.5.10", "1.5.10")).toBe(false);
    expect(isNewerVersion("1.6.0", "1.5.12")).toBe(false);
  });

  it("Scenario 1: renders nothing when no update is available", () => {
    installWindowsBridge();
    const { container } = renderPill({ collapsed: false });

    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.12",
        latestVersion: "1.5.12",
        updateAvailable: false,
        updateBusy: false,
      });
    });

    expect(container.firstChild).toBeNull();
  });

  it("Scenario 2: renders expanded and collapsed update pill when an update is available", () => {
    installWindowsBridge();
    const { rerender } = renderPill({ collapsed: false });

    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: true,
        updateBusy: false,
      });
    });

    const button = screen.getByRole("button", { name: /1\.5\.12/i });
    expect(button).toBeTruthy();
    expect(button.textContent).toContain("1.5.12");

    rerender(
      React.createElement(
        LocaleProvider,
        null,
        React.createElement(SidebarUpdatePill, { collapsed: true }),
      ),
    );
    const collapsedButton = screen.getByRole("button", { name: /1\.5\.12/i });
    expect(collapsedButton).toBeTruthy();
  });

  it("Scenario 3 & 4: opens confirmation modal, cancels on Later, and dispatches updateNow on Update Now", () => {
    const messages = installWindowsBridge();
    renderPill({ collapsed: false });

    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: true,
        updateBusy: false,
      });
    });

    messages.length = 0;
    const pillButton = screen.getByRole("button", { name: /1\.5\.12/i });
    fireEvent.click(pillButton);

    const laterButton = screen.getByRole("button", { name: /Later|稍后|稍後/i });
    fireEvent.click(laterButton);
    expect(messages.filter((m) => m.type === "action")).toHaveLength(0);

    fireEvent.click(pillButton);
    const updateNowButton = screen.getByRole("button", { name: /Update Now|立即更新/i });
    fireEvent.click(updateNowButton);

    const actions = messages.filter((m) => m.type === "action");
    expect(actions).toEqual([{ type: "action", name: "updateNow" }]);
  });

  it("reopens modal and surfaces error alert when native update fails", async () => {
    installWindowsBridge();
    renderPill({ collapsed: false });

    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: true,
        updateBusy: false,
        updateError: null,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /1\.5\.12/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Update Now|立即更新/i }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: true,
        updateBusy: false,
        updateError: "Update verification failed",
      });
    });

    expect(screen.getByRole("dialog")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Update verification failed");
  });

  it("hides sidebar update banner on web/cloud, macOS, and Linux clients", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    window.sessionStorage.setItem(
      "tt.githubLatestRelease",
      JSON.stringify({
        latestVersion: "9.9.9",
        htmlUrl: "https://github.com/xiufengsun/TokenTracker/releases/latest",
        timestamp: Date.now(),
      }),
    );

    // Web / cloud mode (no native bridge)
    const webRender = renderPill({ collapsed: false });
    expect(webRender.container.firstChild).toBeNull();
    webRender.unmount();

    // Linux Tauri host
    window.__TAURI_INTERNALS__ = { invoke: vi.fn() };
    const linuxRender = renderPill({ collapsed: false });
    expect(linuxRender.container.firstChild).toBeNull();
    linuxRender.unmount();
    delete window.__TAURI_INTERNALS__;

    // macOS WKWebView host
    window.localStorage.setItem("tokentracker_native_app", "1");
    window.webkit = {
      messageHandlers: {
        nativeBridge: { postMessage: vi.fn() },
      },
    };
    const macRender = renderPill({ collapsed: false });
    act(() => {
      pushNativeSettings({
        platform: "macos",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: true,
        updateBusy: false,
      });
    });
    expect(macRender.container.firstChild).toBeNull();
    macRender.unmount();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hides sidebar update banner before initial Windows native settings arrive", () => {
    installWindowsBridge();
    window.sessionStorage.setItem(
      "tt.githubLatestRelease",
      JSON.stringify({
        latestVersion: "9.9.9",
        htmlUrl: "https://github.com/xiufengsun/TokenTracker/releases/latest",
        timestamp: Date.now(),
      }),
    );

    const { container } = renderPill({ collapsed: false });
    expect(container.firstChild).toBeNull();
  });

  it("keeps download and install progress visible after confirming from the sidebar", async () => {
    installWindowsBridge();
    const { rerender } = renderPill({ collapsed: false });

    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: true,
        updateInProgress: false,
        updateBusy: false,
        updateStatus: "Update to 1.5.12",
        updateError: null,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /1\.5\.12/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /Update Now|立即更新/i }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Downloading state turns updateAvailable=false; the pill must remain visible with progress.
    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: false,
        updateInProgress: true,
        updateBusy: true,
        updateStatus: "Downloading 42%",
        updateError: null,
      });
    });

    const downloadingButton = screen.getByRole("button", {
      name: /Downloading 42%/i,
    });
    expect(downloadingButton).toBeDisabled();
    expect(downloadingButton.textContent).toContain("Downloading 42%");
    expect(screen.queryByRole("dialog")).toBeNull();

    // Collapsed mode also preserves the progress indicator.
    rerender(
      React.createElement(
        LocaleProvider,
        null,
        React.createElement(SidebarUpdatePill, { collapsed: true }),
      ),
    );
    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: false,
        updateInProgress: true,
        updateBusy: true,
        updateStatus: "Downloading 88%",
        updateError: null,
      });
    });
    expect(
      screen.getByRole("button", { name: /Downloading 88%/i }),
    ).toBeDisabled();

    // If verification fails after download, the pill switches back and reopens the error modal.
    act(() => {
      pushNativeSettings({
        platform: "windows",
        version: "1.5.9",
        latestVersion: "1.5.12",
        updateAvailable: true,
        updateInProgress: false,
        updateBusy: false,
        updateStatus: "Update to 1.5.12",
        updateError: "Update verification failed",
      });
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Update verification failed",
    );
  });
});
