import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE } from "../../../lib/locale";
import { LinuxTopBarCard } from "./LinuxTopBarCard.jsx";

const host = vi.hoisted(() => ({ linux: true }));

vi.mock("../../../lib/native-bridge.js", () => ({
  isNativeLinuxApp: () => host.linux,
  isNativeWindowsApp: () => false,
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

describe("LinuxTopBarCard", () => {
  beforeEach(() => {
    setCopyLocale(EN_LOCALE);
    localStorage.clear();
    host.linux = true;
  });

  it("links Linux users to the GNOME extension's setup guide in the browser", () => {
    render(<LinuxTopBarCard />);
    expect(screen.getByText("Track usage in your top bar")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Set up/ });
    expect(link.getAttribute("href")).toContain(
      "TokenTrackerLinux/gnome-extension/tokentracker@tokentracker.cc",
    );
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("never shows outside the Linux app", () => {
    host.linux = false;
    render(<LinuxTopBarCard />);
    expect(screen.queryByText("Track usage in your top bar")).toBeNull();
  });

  it("dismisses permanently", async () => {
    const { unmount } = render(<LinuxTopBarCard />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss top bar tip" }));
    expect(screen.queryByText("Track usage in your top bar")).toBeNull();
    unmount();
    render(<LinuxTopBarCard />);
    expect(screen.queryByText("Track usage in your top bar")).toBeNull();
  });
});
