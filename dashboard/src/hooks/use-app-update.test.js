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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.chrome;
    delete window.webkit;
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
});
