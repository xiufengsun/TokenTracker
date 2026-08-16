import { describe, expect, it } from "vitest";
import { addMonthsUtc, countdownText, cycleView, remainingLabel } from "./subscription-display";

const UTC = Date.UTC;

function iso(ms) {
  return new Date(ms).toISOString();
}

function makeSubscription(overrides = {}) {
  return {
    service: "GPT",
    plan: "Plus",
    provider: null,
    cycle: "monthly",
    autoRenew: true,
    nextBillingAt: iso(UTC(2026, 7, 16, 6, 0)),
    ...overrides,
  };
}

describe("addMonthsUtc", () => {
  it("clamps Jan 31 to the last day of the target month", () => {
    expect(addMonthsUtc(UTC(2026, 0, 31, 12, 0), 1)).toBe(UTC(2026, 1, 28, 12, 0));
    expect(addMonthsUtc(UTC(2028, 0, 31, 12, 0), 1)).toBe(UTC(2028, 1, 29, 12, 0)); // leap year
  });

  it("keeps the anchor day when the target month is long enough", () => {
    expect(addMonthsUtc(UTC(2026, 7, 15, 9, 30), -1)).toBe(UTC(2026, 6, 15, 9, 30));
  });
});

describe("cycleView", () => {
  it("returns null for an unparseable date", () => {
    expect(cycleView(makeSubscription({ nextBillingAt: "not a date" }), Date.now())).toBeNull();
  });

  it("defaults legacy records without a cycle to monthly", () => {
    const now = UTC(2026, 7, 10, 0, 0);
    const view = cycleView(
      { ...makeSubscription(), cycle: undefined, nextBillingAt: iso(UTC(2026, 7, 16, 6, 0)) },
      now,
    );
    // Aug 16 end -> Jul 16 start; cycle spans 31 days, not 30/365.
    expect(view.startMs).toBe(UTC(2026, 6, 16, 6, 0));
    expect(view.cycleDays).toBe(31);
  });

  it("computes an exact future cycle for a non-renewing record", () => {
    const now = UTC(2026, 7, 10, 6, 0);
    const view = cycleView(
      makeSubscription({ autoRenew: false, nextBillingAt: iso(UTC(2026, 7, 16, 6, 0)) }),
      now,
    );
    expect(view.startMs).toBe(UTC(2026, 6, 16, 6, 0));
    expect(view.endMs).toBe(UTC(2026, 7, 16, 6, 0));
    expect(view.progress).toBeCloseTo(25 / 31, 10);
    expect(view.expired).toBe(false);
  });

  it("marks only non-renewing records as expired past their date", () => {
    const now = UTC(2026, 7, 18, 0, 0);
    const view = cycleView(
      makeSubscription({ autoRenew: false, nextBillingAt: iso(UTC(2026, 7, 16, 6, 0)) }),
      now,
    );
    expect(view.expired).toBe(true);
    expect(view.progress).toBe(1);
    expect(view.endMs).toBe(UTC(2026, 7, 16, 6, 0)); // no rolling for manual records
  });

  it("rolls an auto-renew record forward and clamps short months", () => {
    // Recorded renewal Jan 31: the next cycle ends Feb 28 (not Mar 2/3), the
    // one after that Mar 28, so the anchor day never drifts.
    const now = UTC(2026, 2, 5, 0, 0);
    const view = cycleView(
      makeSubscription({ nextBillingAt: iso(UTC(2026, 0, 31, 12, 0)) }),
      now,
    );
    expect(view.endMs).toBe(UTC(2026, 2, 28, 12, 0));
    expect(view.startMs).toBe(UTC(2026, 1, 28, 12, 0));
    expect(view.expired).toBe(false);
  });

  it("rolls weekly records by whole weeks", () => {
    const now = UTC(2026, 2, 18, 0, 0); // 17 days after the recorded end
    const view = cycleView(
      makeSubscription({ cycle: "weekly", nextBillingAt: iso(UTC(2026, 2, 1, 0, 0)) }),
      now,
    );
    expect(view.endMs).toBe(UTC(2026, 2, 22, 0, 0)); // ceil(17/7) = 3 weeks ahead
    expect(view.cycleDays).toBe(7);
  });

  it("advances a weekly record a full week when now lands exactly on the renewal", () => {
    // ceil(0/7) alone adds zero weeks, which would pin the bar at 100% with
    // an expired-style label while autoRenew says otherwise.
    const endMs = UTC(2026, 2, 1, 0, 0);
    const view = cycleView(
      makeSubscription({ cycle: "weekly", nextBillingAt: iso(endMs) }),
      endMs,
    );
    expect(view.endMs).toBe(endMs + 7 * 86400000);
    expect(view.progress).toBe(0);
    expect(view.expired).toBe(false);
  });

  it("rolls yearly records by calendar years with leap clamping", () => {
    const now = UTC(2026, 2, 5, 0, 0);
    const view = cycleView(
      makeSubscription({ cycle: "yearly", nextBillingAt: iso(UTC(2024, 1, 29, 12, 0)) }),
      now,
    );
    // Feb 29 2024 -> Feb 28 2025 -> Feb 28 2026 (still past `now`) -> Feb 28 2027.
    expect(view.endMs).toBe(UTC(2027, 1, 28, 12, 0));
  });

  it("derives cycle bounds in UTC across DST transition days", () => {
    // 2026-03-08 is the US DST jump, 2026-03-29 the EU one. Local-time getters
    // would shift the computed start by an hour; UTC math must not.
    for (const endMs of [UTC(2026, 2, 8, 12, 0), UTC(2026, 2, 29, 12, 0)]) {
      const view = cycleView(
        makeSubscription({ autoRenew: false, nextBillingAt: iso(endMs) }),
        endMs - 14 * 86400000,
      );
      expect(view.endMs).toBe(endMs);
      expect(new Date(view.startMs).toISOString()).toBe(
        iso(addMonthsUtc(endMs, -1)),
      );
    }
  });

  it("renders the same cycle regardless of the viewer's time zone", () => {
    const record = makeSubscription({
      nextBillingAt: iso(UTC(2026, 2, 8, 12, 0)), // US DST transition day
    });
    const now = UTC(2026, 2, 1, 9, 0);
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const newYork = cycleView(record, now);
      process.env.TZ = "Asia/Shanghai";
      const shanghai = cycleView(record, now);
      expect(newYork).toEqual(shanghai);
      expect(newYork.startMs).toBe(UTC(2026, 1, 8, 12, 0));
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe("remainingLabel / countdownText", () => {
  it("formats minutes, hours, and days", () => {
    const now = UTC(2026, 7, 16, 0, 0);
    expect(remainingLabel(now + 5 * 60000, now)).toBe("5m");
    expect(remainingLabel(now + 17 * 3600000, now)).toBe("17h");
    expect(remainingLabel(now + 6 * 86400000, now)).toBe("6d");
    expect(countdownText(now + 6 * 86400000 + 2 * 3600000 + 3 * 60000, now)).toBe(
      "in 6d 2h 3m",
    );
  });

  it("says Expired once the end has passed", () => {
    const now = UTC(2026, 7, 16, 0, 0);
    expect(remainingLabel(now - 1, now)).toBe("Expired");
    expect(countdownText(now - 1, now)).toBe("Expired");
  });

  it("does not mutate the record it renders", () => {
    const record = makeSubscription({ autoRenew: true, nextBillingAt: iso(UTC(2026, 0, 31, 12, 0)) });
    const snapshot = { ...record };
    cycleView(record, UTC(2026, 2, 5, 0, 0));
    expect(record).toEqual(snapshot);
  });
});
