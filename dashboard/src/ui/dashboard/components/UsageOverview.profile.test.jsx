import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../foundation/ThemeProvider.jsx";
import { UsageOverview } from "./UsageOverview";

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
});

const themeValue = { theme: "light", resolvedTheme: "light", setTheme: vi.fn(), toggleTheme: vi.fn() };

function renderOverview(props) {
  return render(
    createElement(
      ThemeContext.Provider,
      { value: themeValue },
      createElement(UsageOverview, {
        period: "month",
        periods: ["day", "month"],
        onPeriodChange: () => {},
        summaryValue: "0",
        summaryLabel: "Total",
        fleetData: [],
        from: "2026-06-01",
        to: "2026-06-30",
        ...props,
      }),
    ),
  );
}

const PROFILES = [
  { value: "", label: "All profiles" },
  { value: "claude", label: "Claude (default)" },
  { value: "claude@work", label: "Claude · work" },
];

describe("UsageOverview profile selector", () => {
  it("lists the profiles and reports the chosen source", async () => {
    const onProfileChange = vi.fn();
    renderOverview({ profileOptions: PROFILES, selectedProfile: "", onProfileChange });
    await userEvent.click(screen.getByLabelText("Filter by profile"));
    await userEvent.click(await screen.findByRole("option", { name: "Claude · work" }));
    expect(onProfileChange).toHaveBeenCalledWith("claude@work");
  });

  it("can go back to all profiles", async () => {
    const onProfileChange = vi.fn();
    renderOverview({ profileOptions: PROFILES, selectedProfile: "claude@work", onProfileChange });
    await userEvent.click(screen.getByLabelText("Filter by profile"));
    await userEvent.click(await screen.findByRole("option", { name: "All profiles" }));
    expect(onProfileChange).toHaveBeenCalledWith("");
  });

  it("shows the selected profile on the control", () => {
    renderOverview({ profileOptions: PROFILES, selectedProfile: "claude@work", onProfileChange: () => {} });
    expect(screen.getByLabelText("Filter by profile")).toHaveTextContent("Claude · work");
  });

  it("is hidden when nothing is split (no options)", () => {
    renderOverview({ profileOptions: [], selectedProfile: "", onProfileChange: () => {} });
    expect(screen.queryByLabelText("Filter by profile")).toBeNull();
  });

  it("is hidden with a single option", () => {
    renderOverview({
      profileOptions: [{ value: "", label: "All profiles" }],
      selectedProfile: "",
      onProfileChange: () => {},
    });
    expect(screen.queryByLabelText("Filter by profile")).toBeNull();
  });

  it("is hidden when the page passes no profile props at all", () => {
    renderOverview({});
    expect(screen.queryByLabelText("Filter by profile")).toBeNull();
  });

  it("sits next to the device selector without replacing it", () => {
    renderOverview({
      profileOptions: PROFILES,
      selectedProfile: "",
      onProfileChange: () => {},
      deviceOptions: [
        { value: "", label: "All devices" },
        { value: "d1", label: "MacBook" },
      ],
      selectedDevice: "",
      onDeviceChange: () => {},
    });
    expect(screen.getByLabelText("Filter by profile")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by device")).toBeInTheDocument();
  });
});
