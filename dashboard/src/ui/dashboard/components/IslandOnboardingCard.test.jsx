import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setCopyLocale } from "../../../lib/copy";
import { EN_LOCALE } from "../../../lib/locale";
import { IslandOnboardingCard } from "./IslandOnboardingCard.jsx";

const native = vi.hoisted(() => ({
  available: true,
  settings: {
    dynamicIslandSupported: true,
    dynamicIslandEnabled: false,
  },
  setSetting: vi.fn(),
  windows: false,
  linux: false,
  toast: vi.fn(),
}));

vi.mock("../../../hooks/use-native-settings.js", () => ({
  useNativeSettings: () => ({
    available: native.available,
    settings: native.settings,
    setSetting: native.setSetting,
  }),
}));

vi.mock("../../../lib/native-bridge.js", () => ({
  isNativeWindowsApp: () => native.windows,
  isNativeLinuxApp: () => native.linux,
}));

vi.mock("../../components/Toast.jsx", () => ({
  showToast: (options) => native.toast(options),
}));

vi.mock("motion/react", async () => {
  const React = await import("react");
  const components = new Map();
  const motion = new Proxy({}, {
    get: (_target, tag) => {
      if (!components.has(tag)) {
        components.set(
          tag,
          React.forwardRef(function MotionElement(
            { children, initial, animate, exit, transition, whileHover, whileTap, ...props },
            ref,
          ) {
            return React.createElement(tag, { ...props, ref }, children);
          }),
        );
      }
      return components.get(tag);
    },
  });
  return {
    AnimatePresence: ({ children }) => children,
    motion,
    useReducedMotion: () => true,
  };
});

describe("IslandOnboardingCard", () => {
  beforeEach(() => {
    setCopyLocale(EN_LOCALE);
    window.localStorage.clear();
    native.available = true;
    native.settings = {
      dynamicIslandSupported: true,
      dynamicIslandEnabled: false,
    };
    native.windows = false;
    native.linux = false;
    native.setSetting.mockReset();
    native.toast.mockReset();
  });

  it("offers an explicit menu-bar replacement choice before enabling", async () => {
    const user = userEvent.setup();
    render(<IslandOnboardingCard />);

    expect(screen.getByText("Meet the Dynamic Island")).toBeInTheDocument();
    const replaceSwitch = screen.getByRole("switch", { name: "Toggle hide menu bar item" });
    expect(replaceSwitch).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      await user.click(replaceSwitch);
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Turn it on" }));
    });

    expect(native.setSetting.mock.calls).toEqual([
      ["dynamicIslandEnabled", true],
      ["hideMenuBarIcon", true],
    ]);
    expect(window.localStorage.getItem("islandOnboardingDismissed")).toBe("1");
    await waitFor(() => {
      expect(screen.queryByText("Meet the Dynamic Island")).not.toBeInTheDocument();
    });
  });

  it("keeps the menu-bar icon by default and offers a working undo", async () => {
    const user = userEvent.setup();
    render(<IslandOnboardingCard />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Turn it on" }));
    });

    expect(native.setSetting).toHaveBeenCalledTimes(1);
    expect(native.setSetting).toHaveBeenCalledWith("dynamicIslandEnabled", true);

    const toast = native.toast.mock.calls[0][0];
    await act(async () => {
      toast.data.onUndo();
    });

    expect(native.setSetting).toHaveBeenNthCalledWith(2, "hideMenuBarIcon", false);
    expect(native.setSetting).toHaveBeenNthCalledWith(3, "dynamicIslandEnabled", false);
    expect(window.localStorage.getItem("islandOnboardingDismissed")).toBeNull();
    await waitFor(() => {
      expect(screen.getByText("Meet the Dynamic Island")).toBeInTheDocument();
    });
  });

  it("stays hidden in the Windows native host", () => {
    native.available = false;
    native.windows = true;

    const { container } = render(<IslandOnboardingCard />);

    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden in the Linux native host", () => {
    native.available = false;
    native.linux = true;

    const { container } = render(<IslandOnboardingCard />);

    expect(container).toBeEmptyDOMElement();
  });
});
