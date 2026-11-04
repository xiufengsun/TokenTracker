import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "./AppearanceSection.jsx";
import { OVERVIEW_PERIOD_STORAGE_KEY } from "../../lib/overview-period-pref.js";

vi.mock("../../hooks/useTheme.js", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("../../hooks/useLocale.js", () => ({
  useLocale: () => ({ locale: "system", setLocale: vi.fn() }),
}));

vi.mock("../../hooks/useCurrency.js", () => ({
  useCurrency: () => ({
    currency: "USD",
    rate: 1,
    rateSource: "default",
    rateFetchedAt: null,
    setCurrency: vi.fn(),
  }),
}));

vi.mock("../../hooks/useTokenFormat.js", () => ({
  useTokenFormat: () => ({
    mode: "compact",
    setMode: vi.fn(),
    unitSystem: "english",
    setUnitSystem: vi.fn(),
    grouping: "thousand",
    setGrouping: vi.fn(),
  }),
}));

vi.mock("../../lib/copy", () => ({
  copy: (key) => key,
}));

describe("AppearanceSection opening range", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to month and saves the next opening range", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    const month = screen.getByRole("button", { name: "usage.period.month" });
    const day = screen.getByRole("button", { name: "usage.period.day" });
    expect(month).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("settings.appearance.overview_period.label")).toBeInTheDocument();

    await user.click(day);

    expect(day).toHaveAttribute("aria-pressed", "true");
    expect(month).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem(OVERVIEW_PERIOD_STORAGE_KEY)).toBe("day");
  });
});
