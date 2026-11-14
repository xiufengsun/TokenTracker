import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ThemeContext } from "../../foundation/ThemeProvider.jsx";
import { UsageOverview } from "./UsageOverview";

// jsdom doesn't implement matchMedia — stub it once before all tests
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

const themeValue = {
  theme: "light",
  resolvedTheme: "light",
  setTheme: vi.fn(),
  toggleTheme: vi.fn(),
};

function Wrapper({ children }) {
  return (
    <ThemeContext.Provider value={themeValue}>
      {children}
    </ThemeContext.Provider>
  );
}

const baseProps = {
  period: "month", periods: ["day", "month"], onPeriodChange: () => {},
  summaryValue: "0", summaryLabel: "Total", fleetData: [],
  from: "2026-06-01", to: "2026-06-30",
};

describe("UsageOverview device dropdown", () => {
  it("renders the device select when 2+ devices and fires onDeviceChange", async () => {
    const onDeviceChange = vi.fn();
    render(
      <UsageOverview
        {...baseProps}
        deviceOptions={[
          { value: "", label: "All devices" },
          { value: "d1", label: "MacBook" },
          { value: "d2", label: "Mac mini" },
        ]}
        selectedDevice=""
        onDeviceChange={onDeviceChange}
      />,
      { wrapper: Wrapper },
    );
    const trigger = screen.getByLabelText("Filter by device");
    expect(trigger).toBeInTheDocument();
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByText("Mac mini"));
    expect(onDeviceChange).toHaveBeenCalledWith("d2");
  });

  it("hides the device select with fewer than 2 devices", () => {
    render(
      <UsageOverview {...baseProps} deviceOptions={[{ value: "", label: "All devices" }]} selectedDevice="" onDeviceChange={() => {}} />,
      { wrapper: Wrapper },
    );
    expect(screen.queryByLabelText("Filter by device")).toBeNull();
  });

  it("uses the scope-switch aria label when the unified scope/device filter is on", async () => {
    const onDeviceChange = vi.fn();
    render(
      <UsageOverview
        {...baseProps}
        accountScopeSwitchable
        deviceOptions={[
          { value: "__scope:local__", label: "This device" },
          { value: "d1", label: "MacBook" },
          { value: "", label: "Account-wide" },
        ]}
        selectedDevice=""
        onDeviceChange={onDeviceChange}
      />,
      { wrapper: Wrapper },
    );
    const trigger = screen.getByLabelText("Data scope");
    expect(trigger).toBeInTheDocument();
    await userEvent.click(trigger);
    // Prefer role=option — plain text can hit a non-interactive selected label.
    await userEvent.click(await screen.findByRole("option", { name: "MacBook" }));
    expect(onDeviceChange).toHaveBeenCalledWith("d1");
  });
});
