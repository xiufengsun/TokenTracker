import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../lib/copy";
import IpCheckPage from "./IpCheckPage.jsx";

const historyKey = "claude_ip_history";
const previousHistory = [{ ip: "192.0.2.2", cc: "us", geo: "Previous city", time: "2026-01-01T00:00:00Z" }];

async function renderPage() {
  let view;
  await act(async () => {
    view = render(<IpCheckPage />);
    await vi.advanceTimersByTimeAsync(0);
  });
  return view;
}

describe("IP check history storage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("cdn-cgi/trace")) return { ok: true, text: async () => "ip=192.0.2.1\nloc=US\n" };
      if (url.includes("ip138") || url.includes("my.ip.cn")) return { ok: false, text: async () => "" };
      return { ok: true, json: async () => ({
        ip: "192.0.2.1", country: "United States", countryCode: "US", country_code: "US",
        trust_score: 90, asn: "AS0", city: "Current city",
      }) };
    }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("saves detected history and clears it through the page control", async () => {
    const { container } = await renderPage();
    expect(JSON.parse(localStorage.getItem(historyKey))).toMatchObject([{ ip: "192.0.2.1", cc: "us" }]);
    expect(container.querySelector("#ipHistoryContent")).toHaveTextContent("192.0.2.1");
    fireEvent.click(screen.getByRole("button", { name: copy("ipcheck.history.clear") }));
    expect(localStorage.getItem(historyKey)).toBeNull();
    expect(container.querySelector("#ipHistoryContent")).toHaveTextContent(copy("ipcheck.history.empty"));
  });

  it("finishes detection and renders stored history when the quota is exceeded", async () => {
    localStorage.setItem(historyKey, JSON.stringify(previousHistory));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    const { container } = await renderPage();
    expect(write).toHaveBeenCalledWith(historyKey, expect.any(String));
    expect(container.querySelector("#ipAddrClaude")).toHaveTextContent("192.0.2.1");
    expect(container.querySelector("#ipHistoryContent")).toHaveTextContent("Previous city");
    expect(JSON.parse(localStorage.getItem(historyKey))).toEqual(previousHistory);
  });

  it("keeps the readable history when clearing storage is denied", async () => {
    const { container } = await renderPage();
    const stored = localStorage.getItem(historyKey);
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Access denied", "SecurityError");
    });
    const errors = [];
    const onError = (event) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener("error", onError);
    try {
      fireEvent.click(screen.getByRole("button", { name: copy("ipcheck.history.clear") }));
      expect(remove).toHaveBeenCalledWith(historyKey);
      expect(errors).toEqual([]);
      expect(localStorage.getItem(historyKey)).toBe(stored);
      expect(container.querySelector("#ipHistoryContent")).toHaveTextContent("192.0.2.1");
    } finally {
      window.removeEventListener("error", onError);
    }
  });
});
