import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE } from "../../../lib/locale";
import { LinuxPetCard } from "./LinuxPetCard.jsx";

const host = vi.hoisted(() => ({
  linux: true,
  available: true,
  settings: { visible: false },
  setSetting: vi.fn(),
}));

vi.mock("../../../hooks/use-pet-settings.js", () => ({
  usePetSettings: () => ({
    available: host.available,
    settings: host.settings,
    setSetting: host.setSetting,
  }),
}));

vi.mock("../../../lib/native-bridge.js", () => ({
  isNativeLinuxApp: () => host.linux,
}));

vi.mock("../../foundation/ClawdAnimated.jsx", () => ({
  ClawdAnimated: () => null,
}));

vi.mock("motion/react", async () => {
  const React = await import("react");
  const motion = new Proxy({}, {
    get: (_target, tag) => React.forwardRef(function MotionElement(
      { children, initial, animate, exit, transition, whileHover, whileTap, ...props },
      ref,
    ) {
      return React.createElement(tag, { ...props, ref }, children);
    }),
  });
  return {
    AnimatePresence: ({ children }) => children,
    motion,
    useReducedMotion: () => true,
  };
});

describe("LinuxPetCard", () => {
  beforeEach(() => {
    setCopyLocale(EN_LOCALE);
    localStorage.clear();
    host.linux = true;
    host.available = true;
    host.settings = { visible: false };
    host.setSetting.mockClear();
  });

  it("offers to show the pet in the Linux app while it is off", async () => {
    render(<LinuxPetCard />);
    expect(screen.getByText("Meet your desktop pet")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pet settings/ }).getAttribute("href")).toBe("/pet-settings");

    await userEvent.click(screen.getByRole("button", { name: "Show pet" }));
    expect(host.setSetting).toHaveBeenCalledWith("visible", true);
  });

  it("stays hidden once the pet is already on", () => {
    host.settings = { visible: true };
    render(<LinuxPetCard />);
    expect(screen.queryByText("Meet your desktop pet")).toBeNull();
  });

  it("never shows outside the Linux app", () => {
    host.linux = false;
    render(<LinuxPetCard />);
    expect(screen.queryByText("Meet your desktop pet")).toBeNull();
  });

  it("stays hidden when the pet bridge is unavailable", () => {
    host.available = false;
    render(<LinuxPetCard />);
    expect(screen.queryByText("Meet your desktop pet")).toBeNull();
  });

  it("dismisses permanently", async () => {
    const { unmount } = render(<LinuxPetCard />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss desktop pet tip" }));
    expect(screen.queryByText("Meet your desktop pet")).toBeNull();
    unmount();
    render(<LinuxPetCard />);
    expect(screen.queryByText("Meet your desktop pet")).toBeNull();
  });
});
