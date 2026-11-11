import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabsSection } from "./LabsSection.jsx";

const nativeSettingsMock = vi.hoisted(() => ({
  available: true,
  settings: {
    dynamicIslandSupported: true,
    dynamicIslandEnabled: false,
    hideMenuBarIcon: false,
  },
  setSetting: vi.fn(),
}));

vi.mock("../../hooks/use-native-settings.js", () => ({
  useNativeSettings: () => ({
    available: nativeSettingsMock.available,
    settings: nativeSettingsMock.settings,
    setSetting: nativeSettingsMock.setSetting,
  }),
}));

vi.mock("../../lib/copy", () => ({
  copy: (key) => key,
}));

describe("LabsSection Dynamic Island expand-on-hover setting", () => {
  beforeEach(() => {
    nativeSettingsMock.available = true;
    nativeSettingsMock.settings = {
      dynamicIslandSupported: true,
      dynamicIslandEnabled: false,
      hideMenuBarIcon: false,
    };
    nativeSettingsMock.setSetting.mockReset();
  });

  afterEach(cleanup);

  it("hides expand-on-hover when Dynamic Island is unsupported or disabled", () => {
    nativeSettingsMock.available = false;
    nativeSettingsMock.settings = {
      dynamicIslandSupported: true,
      dynamicIslandEnabled: true,
      dynamicIslandExpandOnHover: true,
    };
    const { rerender } = render(<LabsSection />);

    expect(
      screen.queryByRole("switch", { name: "settings.labs.island_expand_on_hover.aria" }),
    ).not.toBeInTheDocument();

    nativeSettingsMock.available = true;
    nativeSettingsMock.settings = {
      dynamicIslandSupported: false,
      dynamicIslandEnabled: true,
      dynamicIslandExpandOnHover: true,
    };
    rerender(<LabsSection />);

    expect(
      screen.queryByRole("switch", { name: "settings.labs.island_expand_on_hover.aria" }),
    ).not.toBeInTheDocument();

    nativeSettingsMock.settings = {
      dynamicIslandSupported: true,
      dynamicIslandEnabled: false,
      dynamicIslandExpandOnHover: true,
    };
    rerender(<LabsSection />);

    expect(
      screen.getByRole("switch", { name: "settings.labs.island.aria" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByRole("switch", { name: "settings.labs.island_hide_menubar.aria" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "settings.labs.island_expand_on_hover.aria" }),
    ).not.toBeInTheDocument();
  });

  it("defaults expand-on-hover to unchecked when undefined or false and enables on click", async () => {
    const user = userEvent.setup();
    nativeSettingsMock.settings = {
      dynamicIslandSupported: true,
      dynamicIslandEnabled: true,
      hideMenuBarIcon: false,
    };
    const { rerender } = render(<LabsSection />);

    expect(screen.getByText("settings.labs.island_expand_on_hover.label")).toBeInTheDocument();
    expect(screen.getByText("settings.labs.island_expand_on_hover.hint")).toBeInTheDocument();

    const switches = screen.getAllByRole("switch");
    const hideMenuBarIndex = switches.findIndex(
      (node) => node.getAttribute("aria-label") === "settings.labs.island_hide_menubar.aria",
    );
    const expandOnHoverIndex = switches.findIndex(
      (node) => node.getAttribute("aria-label") === "settings.labs.island_expand_on_hover.aria",
    );
    expect(expandOnHoverIndex).toBe(hideMenuBarIndex + 1);

    const expandSwitch = screen.getByRole("switch", {
      name: "settings.labs.island_expand_on_hover.aria",
    });
    expect(expandSwitch).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      await user.click(expandSwitch);
    });
    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith(
      "dynamicIslandExpandOnHover",
      true,
    );

    nativeSettingsMock.setSetting.mockReset();
    nativeSettingsMock.settings = {
      dynamicIslandSupported: true,
      dynamicIslandEnabled: true,
      hideMenuBarIcon: false,
      dynamicIslandExpandOnHover: false,
    };
    rerender(<LabsSection />);

    expect(expandSwitch).toHaveAttribute("aria-checked", "false");
    await act(async () => {
      await user.click(expandSwitch);
    });
    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith(
      "dynamicIslandExpandOnHover",
      true,
    );
  });

  it("reflects enabled expand-on-hover state and disables on click", async () => {
    const user = userEvent.setup();
    nativeSettingsMock.settings = {
      dynamicIslandSupported: true,
      dynamicIslandEnabled: true,
      hideMenuBarIcon: false,
      dynamicIslandExpandOnHover: true,
    };
    render(<LabsSection />);

    const expandSwitch = screen.getByRole("switch", {
      name: "settings.labs.island_expand_on_hover.aria",
    });
    expect(expandSwitch).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      await user.click(expandSwitch);
    });

    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith(
      "dynamicIslandExpandOnHover",
      false,
    );
  });
});
