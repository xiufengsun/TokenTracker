import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppLayout } from "./Sidebar.jsx";

const LABELS = {
  "nav.group.general": "General",
  "nav.group.tools": "Tools",
  "nav.group.account": "Account",
  "nav.usage": "Usage",
  "nav.sessions": "Sessions",
  "nav.limits": "Limits",
  "nav.leaderboard": "Leaderboard",
  "nav.achievements": "Achievements",
  "nav.widgets": "Widgets",
  "nav.pet": "Desktop pet",
  "nav.skills": "Skills",
  "nav.ip_check": "IP check",
  "nav.service_status": "Service status",
  "nav.settings": "Settings",
  "nav.expand": "Expand sidebar",
  "nav.collapse": "Collapse sidebar",
  "nav.menu": "Open navigation menu",
  "nav.close_menu": "Close navigation menu",
  "nav.aside_label": "Main navigation",
  "nav.nav_label": "Primary navigation",
  "shared.github.star": "Star",
};

vi.mock("../../lib/copy", () => ({
  copy: (key) => LABELS[key] || key,
}));

vi.mock("../../hooks/useTheme.js", () => ({
  useTheme: () => ({ theme: "system", resolvedTheme: "light", setTheme: vi.fn() }),
}));

vi.mock("../../hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));

vi.mock("../../lib/native-bridge.js", () => ({
  isNativeApp: () => false,
  isNativeEmbed: () => false,
  isNativeWindowsApp: () => false,
  isNativeLinuxApp: () => false,
}));

vi.mock("../dashboard/util/should-fetch-github-stars.js", () => ({
  shouldFetchGithubStars: () => false,
}));

vi.mock("../../components/InsforgeUserHeaderControls.jsx", () => ({
  InsforgeUserHeaderControls: () => <button type="button" aria-label="Account control" />,
}));

let desktopMatches = false;
let mediaListeners;

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <AppLayout>
        <main />
      </AppLayout>
    </MemoryRouter>,
  );
}

describe("AppLayout sidebar controls", () => {
  beforeEach(() => {
    window.localStorage.clear();
    desktopMatches = false;
    mediaListeners = new Set();
    window.matchMedia = vi.fn((query) => ({
      matches: query === "(min-width: 1024px)" ? desktopMatches : false,
      media: query,
      onchange: null,
      addEventListener: (_type, listener) => mediaListeners.add(listener),
      removeEventListener: (_type, listener) => mediaListeners.delete(listener),
      addListener: (_listener) => {},
      removeListener: (_listener) => {},
      dispatchEvent: vi.fn(),
    }));
  });

  it("collapses and expands the desktop sidebar and persists the preference", async () => {
    const user = userEvent.setup();
    renderLayout();

    const sidebar = screen.getByRole("complementary", { name: "Main navigation" });
    const collapseButton = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    expect(collapseButton).toHaveAttribute("aria-expanded", "true");

    await act(async () => user.click(collapseButton));

    expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
    expect(window.localStorage.getItem("tt.sidebarCollapsed")).toBe("1");
    expect(screen.getByRole("link", { name: "Usage" })).toHaveAttribute("aria-label", "Usage");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");

    await act(async () => user.click(screen.getByRole("button", { name: "Expand sidebar" })));

    expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
    expect(window.localStorage.getItem("tt.sidebarCollapsed")).toBe("0");
  });

  it("moves focus into the mobile drawer and closes it with the dedicated button", async () => {
    const user = userEvent.setup();
    renderLayout();

    const openButton = screen.getByRole("button", { name: "Open navigation menu" });
    await act(async () => user.click(openButton));

    const drawer = screen.getByRole("dialog", { name: "Main navigation" });
    const closeButton = screen.getByRole("button", { name: "Close navigation menu" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(openButton).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(closeButton);

    await act(async () => user.click(closeButton));

    expect(screen.queryByRole("dialog", { name: "Main navigation" })).not.toBeInTheDocument();
    expect(openButton).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(openButton);
  });

  it("closes the mobile drawer with Escape and backdrop clicks", async () => {
    const user = userEvent.setup();
    renderLayout();
    const openButton = screen.getByRole("button", { name: "Open navigation menu" });

    await act(async () => user.click(openButton));
    await act(async () => user.keyboard("{Escape}"));
    expect(screen.queryByRole("dialog", { name: "Main navigation" })).not.toBeInTheDocument();

    await act(async () => user.click(openButton));
    const backdrop = document.querySelector(".bg-black\\/40");
    expect(backdrop).toBeInTheDocument();
    await act(async () => user.click(backdrop));
    expect(screen.queryByRole("dialog", { name: "Main navigation" })).not.toBeInTheDocument();
  });

  it("keeps Tab focus within the mobile drawer", async () => {
    const user = userEvent.setup();
    renderLayout();
    await act(async () => user.click(screen.getByRole("button", { name: "Open navigation menu" })));

    const drawer = screen.getByRole("dialog", { name: "Main navigation" });
    const focusable = drawer.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    await act(async () => user.tab());
    expect(document.activeElement).toBe(first);

    first.focus();
    await act(async () => user.tab({ shift: true }));
    expect(document.activeElement).toBe(last);
  });

  it("closes an open drawer when the viewport crosses the desktop breakpoint", async () => {
    const user = userEvent.setup();
    renderLayout();
    const openButton = screen.getByRole("button", { name: "Open navigation menu" });
    const mainContent = document.getElementById("app-main-content");
    await act(async () => user.click(openButton));
    expect(screen.getByRole("dialog", { name: "Main navigation" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    await act(async () => {
      desktopMatches = true;
      mediaListeners.forEach((listener) => listener({ matches: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(screen.queryByRole("dialog", { name: "Main navigation" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(mainContent);
    expect(document.activeElement).not.toBe(openButton);
  });
});
