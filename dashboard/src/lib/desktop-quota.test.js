import { describe, it, expect } from "vitest";
import { desktopQuotaRows, quotaPeriodLabel, quotaResetCountdown, mergeQuotaSnapshot, selectQuotaRows } from "./desktop-quota.js";

describe("desktop quota snapshots", () => {
  it("keeps both fully available and exhausted quotas, without coercing missing values", () => {
    const rows = desktopQuotaRows({
      claude: { configured: true, five_hour: { utilization: 0 }, seven_day: { utilization: 100 } },
      codex: { configured: true, primary_window: { used_percent: null }, secondary_window: { used_percent: "" } },
    });
    expect(rows.map(row => row.remaining)).toEqual([100, 0]);
  });
  it("uses dashboard definitions for scoped windows and Unix reset times", () => {
    const rows = desktopQuotaRows({
      codex: { configured: true, primary_window: { used_percent: 25, reset_at: 1800000000 } },
      claude: { configured: true, weekly_scoped: [{ label: "Sonnet", utilization: 7 }] },
    });
    expect(rows.find(row => row.provider === "codex").resetMs).toBe(1800000000000);
    expect(rows.find(row => row.provider === "claude")).toMatchObject({ label: "Sonnet", remaining: 93 });
  });
  it("preserves known values on provider failure and clears them on disconnection", () => {
    const previous = { codex: { configured: true, primary_window: { used_percent: 38 } } };
    const failed = mergeQuotaSnapshot(previous, { codex: { configured: true, error: "timeout" } });
    expect(desktopQuotaRows(failed)[0]).toMatchObject({ remaining: 62, stale: true });
    expect(desktopQuotaRows(mergeQuotaSnapshot(previous, { codex: { configured: false } }))).toEqual([]);
    expect(desktopQuotaRows(mergeQuotaSnapshot(failed, previous))[0].stale).toBe(false);
  });
  it("never silently substitutes another provider for a missing pinned window", () => {
    const rows = [{ id: "claude:5h", provider: "claude" }, { id: "claude:7d", provider: "claude" }, { id: "codex:5h", provider: "codex" }];
    expect(selectQuotaRows(rows, []).map(row => row.id)).toEqual(["claude:5h", "codex:5h"]);
    expect(selectQuotaRows(rows, ["codex:7d"])).toEqual([]);
    expect(selectQuotaRows(rows, ["codex:5h", "claude:7d"]).map(row => row.id)).toEqual(["codex:5h", "claude:7d"]);
  });
});

it("normalizes provider durations and preserves model labels", () => {
  const rows = desktopQuotaRows({codex:{configured:true,secondary_window:{used_percent:29,limit_window_seconds:604800}},grok:{configured:true,period_type:"weekly",primary_window:{used_percent:73}}});
  const week = new Intl.NumberFormat("zh-CN",{style:"unit",unit:"day",unitDisplay:"short"}).format(7);
  expect(rows.map(row => quotaPeriodLabel(row,"zh-CN"))).toEqual([week,week]);
  expect(quotaPeriodLabel({...rows[0],periodSeconds:18000},"en")).toBe("5 hr");
  expect(quotaPeriodLabel({...rows[0],label:"Sonnet"},"zh-CN")).toBeNull();
});

it("uses only the duration defined by each provider window spec", () => {
  const rows = desktopQuotaRows({
    claude: { configured: true, five_hour: { utilization: 20 } },
    codex: { configured: true, primary_window: { used_percent: 30, limit_window_seconds: 90000 }, secondary_window: { used_percent: 40 } },
    opencodeGo: { configured: true, primary_window: { used_percent: 50 } },
  });

  expect(rows.find(row => row.id === "claude:5h").periodSeconds).toBe(18000);
  expect(rows.find(row => row.id === "codex:5h").periodSeconds).toBe(90000);
  expect(rows.find(row => row.id === "codex:7d").periodSeconds).toBeNull();
  expect(rows.find(row => row.id === "opencodeGo:5h")).toMatchObject({ periodSeconds: null, periodKey: "5h" });
  expect(quotaPeriodLabel(rows.find(row => row.id === "opencodeGo:5h"), "en")).toBeNull();
});

it("counts down from actual reset instead of a nominal seven day period", () => {
  const now = Date.parse("2026-09-27T09:01:14.19Z");
  const reset = Date.parse("2026-10-01T15:01:14.19Z");
  expect(quotaResetCountdown(reset,now,"en")).toBe("4 days 6 hr");
  expect(quotaResetCountdown(reset,reset,"en")).toBeNull();
  expect(quotaResetCountdown(NaN,now,"en")).toBeNull();
  expect(quotaResetCountdown(now+10000,now,"en")).toBe("1 min");
});
