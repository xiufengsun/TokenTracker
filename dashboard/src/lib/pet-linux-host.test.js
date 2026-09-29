import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStats,
  buildTopModels,
  readCurrency,
  readDark,
  relayedStorage,
  resolveDisplayTokens,
  startLinuxPetHost,
} from "./pet-linux-host.js";

function storage(values = {}) {
  return { getItem: (key) => (key in values ? values[key] : null) };
}

function jsonResponse(body, headers = {}) {
  return {
    ok: true,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
  };
}

describe("resolveDisplayTokens", () => {
  it("prefers a positive billable total, then a positive raw total", () => {
    expect(resolveDisplayTokens({ billable_total_tokens: 10, total_tokens: 99 })).toBe(10);
    expect(resolveDisplayTokens({ billable_total_tokens: 0, total_tokens: "42" })).toBe(42);
    expect(resolveDisplayTokens({ billable_total_tokens: 0 })).toBe(0);
    expect(resolveDisplayTokens(undefined)).toBe(0);
  });
});

describe("buildTopModels", () => {
  it("merges model names case-insensitively and keeps the heaviest provider", () => {
    const models = buildTopModels({
      sources: [
        { source: "codex", models: [{ model: "gpt-5", totals: { total_tokens: 300 } }] },
        { source: "cursor", models: [
          { model: "GPT-5", totals: { total_tokens: 100 } },
          { model: "claude", totals: { total_tokens: 600 } },
          { model: "empty", totals: { total_tokens: 0 } },
        ] },
      ],
    });
    expect(models).toEqual([
      { name: "claude", percent: "60.0", source: "cursor" },
      { name: "gpt-5", percent: "40.0", source: "codex" },
    ]);
  });

  it("returns at most five models", () => {
    const models = Array.from({ length: 7 }, (_, i) => ({ model: `m${i}`, totals: { total_tokens: i + 1 } }));
    expect(buildTopModels({ sources: [{ source: "x", models }] })).toHaveLength(5);
  });
});

describe("buildStats", () => {
  it("maps the summary, heatmap and models into the pet's stats shape", () => {
    const stats = buildStats(
      {
        totals: { total_tokens: 500, total_cost_usd: "1.25", conversation_count: 3 },
        rolling: {
          last_7d: { active_days: 4, totals: { total_tokens: 7000 } },
          last_30d: { avg_per_active_day: 900, totals: { total_tokens: 30000 } },
        },
      },
      { streak: 5, activeDays: 40 },
      [],
    );
    expect(stats).toMatchObject({
      todayTokens: 500,
      todayCostUsd: 1.25,
      conversations: 3,
      last7dTokens: 7000,
      last7dActiveDays: 4,
      last30dTokens: 30000,
      last30dAvgPerDay: 900,
      streakDays: 5,
      activeDaysAllTime: 40,
    });
  });
});

describe("readDark", () => {
  it("follows the dashboard theme, then the system preference", () => {
    const win = { matchMedia: () => ({ matches: true }) };
    expect(readDark(storage({ "tokentracker-theme": "light" }), win)).toBe(false);
    expect(readDark(storage({ "tokentracker-theme": "dark" }), win)).toBe(true);
    expect(readDark(storage({ "tokentracker-theme": "system" }), win)).toBe(true);
  });
});

describe("relayed dashboard preferences", () => {
  it("reads currency and rates relayed by the host", () => {
    const store = relayedStorage({
      __ttPetStorage: { currency: "EUR", exchangeRates: JSON.stringify({ EUR: 0.5 }), theme: "dark" },
    });
    expect(readCurrency(store)).toEqual({ symbol: "€", rate: 0.5 });
    expect(readDark(store, {})).toBe(true);
  });

  it("falls back to default rates and USD", () => {
    expect(readCurrency(relayedStorage({ __ttPetStorage: {} }))).toEqual({ symbol: "$", rate: 1 });
    expect(readCurrency(relayedStorage({ __ttPetStorage: { currency: "EUR", exchangeRates: "{bad" } })).rate)
      .toBeGreaterThan(0);
  });

  it("re-pushes context when the host relays new preferences", () => {
    const currency = vi.fn();
    window.addEventListener("pet:currency", currency);
    const stop = startLinuxPetHost({ fetchImpl: async () => ({ ok: false }) });
    currency.mockClear();
    window.__ttPetStorage = { currency: "GBP" };
    window.dispatchEvent(new Event("pet:storage"));
    stop();
    window.removeEventListener("pet:currency", currency);
    expect(currency).toHaveBeenCalled();
    expect(window.__ttPetCurrency.symbol).toBe("£");
    delete window.__ttPetStorage;
  });
});

describe("startLinuxPetHost", () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    for (const key of Object.keys(window)) if (key.startsWith("__ttPet")) delete window[key];
  });

  it("pushes usage, limits and connection state into the page", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.startsWith("/functions/tokentracker-usage-summary")) {
        return jsonResponse({ totals: { total_tokens: 1234, total_cost_usd: "0.5" } });
      }
      if (url.startsWith("/functions/tokentracker-usage-limits")) return jsonResponse({ claude: {} });
      if (url.startsWith("/functions/tokentracker-usage-heatmap")) {
        return jsonResponse({ streak_days: 2, active_days: 9 });
      }
      return jsonResponse({ sources: [] });
    });
    const usage = vi.fn();
    window.addEventListener("pet:usage", usage);

    stop = startLinuxPetHost({ fetchImpl, now: () => new Date(2026, 8, 26, 12) });
    await vi.waitFor(() => expect(usage).toHaveBeenCalled());
    window.removeEventListener("pet:usage", usage);

    expect(window.__ttPetTokens).toBe(1234);
    expect(window.__ttPetCostUsd).toBe(0.5);
    expect(window.__ttPetStats.streakDays).toBe(2);
    expect(window.__ttPetConnected).toBe(true);
    await vi.waitFor(() => expect(window.__ttPetLimits).toEqual({ claude: {} }));
    const summaryUrl = fetchImpl.mock.calls.map(([url]) => url).find((u) => u.includes("usage-summary"));
    expect(summaryUrl).toContain("from=2026-09-26&to=2026-09-26");
    expect(summaryUrl).toContain("account=1");
  });

  it("reports increases without a hardcoded model name", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let tokens = 1000;
    const fetchImpl = async (url) => {
      if (url.startsWith("/functions/tokentracker-usage-summary")) {
        return jsonResponse({ totals: { total_tokens: tokens, total_cost_usd: "1" } });
      }
      return jsonResponse({ sources: [] });
    };
    const status = vi.fn();
    window.addEventListener("pet:model-status", status);
    const usage = vi.fn();
    window.addEventListener("pet:usage", usage);
    stop = startLinuxPetHost({ fetchImpl });
    await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1));
    tokens = 1500;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(status).toHaveBeenCalled());
    window.removeEventListener("pet:model-status", status);
    window.removeEventListener("pet:usage", usage);
    vi.useRealTimers();
    const detail = status.mock.calls[0][0].detail;
    expect(detail.tokensDelta).toBe(500);
    expect(detail.modelName).toBeUndefined();
  });

  it("reports the pet as disconnected when the server is unreachable", async () => {
    const connected = vi.fn();
    window.addEventListener("pet:connected", connected);
    stop = startLinuxPetHost({ fetchImpl: async () => { throw new Error("offline"); } });
    await vi.waitFor(() => expect(connected).toHaveBeenCalled());
    window.removeEventListener("pet:connected", connected);
    expect(window.__ttPetConnected).toBe(false);
  });

  it("marks the pet hovered while the pointer is inside the page", () => {
    stop = startLinuxPetHost({ fetchImpl: async () => ({ ok: false }) });
    document.dispatchEvent(new MouseEvent("mousemove"));
    expect(window.__ttPetHover).toBe(true);
    document.documentElement.dispatchEvent(new MouseEvent("mouseleave"));
    expect(window.__ttPetHover).toBe(false);
  });
});
