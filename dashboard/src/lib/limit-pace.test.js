import { describe, expect, it } from "vitest";
import { computePace } from "./limit-pace.js";

describe("computePace", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");

  it("uses the exact window length and reverses the mark in remaining mode", () => {
    const base = { usedPercent: 42, windowSeconds: 5 * 3600, resetMs: now + 3 * 3600 * 1000, now };
    expect(computePace({ ...base, mode: "used" }).pacePercent).toBeCloseTo(40);
    expect(computePace({ ...base, mode: "remaining" }).pacePercent).toBeCloseTo(60);
    expect(computePace({ ...base, windowSeconds: 7 * 86400, resetMs: now + 3.5 * 86400 * 1000, mode: "used" }).pacePercent).toBeCloseTo(50);
  });

  it("does not infer a marker from an unknown window length or an expired reset", () => {
    const base = { usedPercent: 42, mode: "used", now };
    expect(computePace({ ...base, windowSeconds: null, resetMs: now + 3600_000 }).pacePercent).toBeNull();
    expect(computePace({ ...base, windowSeconds: 5 * 3600, resetMs: now }).pacePercent).toBeNull();
    expect(computePace({ ...base, windowSeconds: 5 * 3600, resetMs: now - 1000 }).expectedPercent).toBeNull();
  });
});
