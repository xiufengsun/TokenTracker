import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuBarSection } from "./MenuBarSection.jsx";

const nativeSettingsMock = vi.hoisted(() => ({
  settings: {
    toastOnReset: true,
    confettiOnReset: true,
    launchAtLogin: false,
    launchAtLoginSupported: true,
    launchSilently: true,
    launchSilentlySupported: true,
    autoUpdateEnabled: true,
  },
  setSetting: vi.fn(),
  runAction: vi.fn(),
}));

vi.mock("../../hooks/use-native-settings.js", () => ({
  useNativeSettings: () => ({
    available: true,
    settings: nativeSettingsMock.settings,
    setSetting: nativeSettingsMock.setSetting,
    runAction: nativeSettingsMock.runAction,
  }),
}));

vi.mock("../../lib/copy", () => ({
  copy: (key) => key,
}));

describe("MenuBarSection limit-reset feedback", () => {
  beforeEach(() => {
    nativeSettingsMock.setSetting.mockReset();
  });

  it("shows independent toast and confetti settings", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MenuBarSection />
      </MemoryRouter>,
    );

    const toastSwitch = screen.getByRole("switch", {
      name: "settings.menubar.toastOnReset",
    });
    const confettiSwitch = screen.getByRole("switch", {
      name: "settings.menubar.confettiOnReset",
    });

    expect(toastSwitch).toHaveAttribute("aria-checked", "true");
    expect(confettiSwitch).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      await user.click(toastSwitch);
      await user.click(confettiSwitch);
    });

    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("toastOnReset", false);
    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("confettiOnReset", false);
  });

  it("toggles automatic updates independently of manual checks", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MenuBarSection />
      </MemoryRouter>,
    );

    const autoUpdateSwitch = screen.getByRole("switch", {
      name: "settings.menubar.autoUpdate",
    });
    expect(autoUpdateSwitch).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      await user.click(autoUpdateSwitch);
    });

    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("autoUpdateEnabled", false);
    // Manual check stays available: the button is untouched by the toggle.
    expect(
      screen.getByRole("button", { name: /settings\.menubar\.checkUpdates/ }),
    ).toBeEnabled();
  });

  it("toggles silent start from the panel", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MenuBarSection />
      </MemoryRouter>,
    );

    const silentSwitch = screen.getByRole("switch", {
      name: "settings.menubar.silentStart",
    });
    expect(silentSwitch).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      await user.click(silentSwitch);
    });

    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("launchSilently", false);
  });

  it("hides silent start when the platform does not support it", () => {
    const original = nativeSettingsMock.settings;
    nativeSettingsMock.settings = { ...original, launchSilentlySupported: false };
    try {
      render(
        <MemoryRouter>
          <MenuBarSection />
        </MemoryRouter>,
      );

      expect(
        screen.queryByRole("switch", { name: "settings.menubar.silentStart" }),
      ).toBeNull();
      // The launch-at-login gate is independent and stays visible.
      expect(
        screen.getByRole("switch", { name: "settings.menubar.launchAtLogin" }),
      ).toBeInTheDocument();
    } finally {
      nativeSettingsMock.settings = original;
    }
  });
});
