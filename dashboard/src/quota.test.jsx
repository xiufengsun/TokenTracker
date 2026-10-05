import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuotaWidget } from "./quota.jsx";

afterEach(() => { delete window.chrome; });
describe("desktop quota interactions", () => {
  it("receives native data, expands, selects periods and collapses with Escape", () => {
    let receive;
    const postMessage = vi.fn();
    window.chrome = { webview: { postMessage, addEventListener: (_, callback) => { receive = callback; }, removeEventListener: vi.fn() } };
    render(<QuotaWidget />);
    act(() => receive({ data: { type: "quota:context", locale: "en", selected: [], limits: {
      codex: { configured: true, primary_window: { used_percent: 25 }, secondary_window: { used_percent: 40 } },
    } } }));
    expect(screen.getByText("75")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Expand limits" })[0]);
    expect(postMessage).toHaveBeenCalledWith("quota:expand");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "75");
    fireEvent.click(screen.getByRole("button", { name: "Choose limits" }));
    const choices = screen.getAllByRole("button", { pressed: false });
    fireEvent.click(choices[0]);
    expect(postMessage.mock.calls.some(([message]) => typeof message === "string" && message.includes('"quota:select"'))).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith("quota:collapse");
  });
});

it("closes from compact and expanded views without expanding or opening the dashboard", () => {
  const postMessage = vi.fn();
  window.chrome = { webview: { postMessage, addEventListener: vi.fn(), removeEventListener: vi.fn() } };
  render(<QuotaWidget />);
  postMessage.mockClear();
  fireEvent.click(screen.getByRole("button", {name:"Close widget"}));
  expect(postMessage.mock.calls).toEqual([["quota:close"]]);
  fireEvent.click(screen.getAllByRole("button", {name:"Expand limits"})[0]);
  postMessage.mockClear();
  fireEvent.click(screen.getByRole("button", {name:"Close widget"}));
  expect(postMessage.mock.calls).toEqual([["quota:close"]]);
});
