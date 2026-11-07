import { describe, expect, it, vi } from "vitest";
import {
  fetchProviderResets,
  groupResetsByDay,
  normalizeProviderResets,
  PROVIDER_RESETS_URL,
} from "./provider-resets.js";

// Trimmed from a live https://claude-resets.com/api/resets response (2026-11-03).
const PAYLOAD = {
  providers: {
    claude: {
      events: [
        { id: "c3", date: "2026-09-22T16:44:06Z", kind: "reset", resetType: "banked", scope: "Pro, Max + Team", note: "Banked reset", url: "https://x.com/ClaudeDevs/status/c3" },
        { id: "c1", date: "2026-04-16T20:02:04Z", kind: "reset", scope: "all", note: "Reset 5-hour and weekly limits.", url: "https://x.com/ClaudeDevs/status/c1" },
        { id: "c2", date: "2026-05-06T16:36:21Z", kind: "policy", scope: "paid plans", note: "Doubled limits", url: "https://x.com/ClaudeDevs/status/c2" },
        { id: "bad", date: "not-a-date", kind: "reset" },
      ],
    },
    codex: {
      events: [
        { id: "x1", date: "2026-11-01T00:43:20Z", kind: "reset", resetType: "banked", note: "Banked 1/2", url: "https://x.com/thsottiaux/status/x1" },
        { id: "x2", date: "2026-10-28T06:29:38Z", kind: "reset", resetType: "regular", note: "And it's done.", url: "javascript:alert(1)" },
      ],
    },
  },
  meta: {},
};

describe("normalizeProviderResets", () => {
  it("keeps only reset events, oldest first, and classifies banked vs regular", () => {
    const out = normalizeProviderResets(PAYLOAD);
    expect(out.claude.map((e) => [e.id, e.type])).toEqual([
      ["c1", "regular"],
      ["c3", "banked"],
    ]);
    expect(out.codex.map((e) => [e.id, e.type])).toEqual([
      ["x2", "regular"],
      ["x1", "banked"],
    ]);
  });

  it("drops non-https source links", () => {
    const out = normalizeProviderResets(PAYLOAD);
    expect(out.codex[0].url).toBeNull();
    expect(out.codex[1].url).toBe("https://x.com/thsottiaux/status/x1");
  });

  it("returns empty lists for a provider the tracker omits", () => {
    expect(normalizeProviderResets({ providers: { claude: { events: [] } } })).toEqual({ claude: [], codex: [] });
  });

  it("rejects a payload without providers", () => {
    expect(() => normalizeProviderResets({ detail: "Not Found" })).toThrow();
  });
});

describe("groupResetsByDay", () => {
  it("buckets events into the heatmap's local day", () => {
    const { codex } = normalizeProviderResets(PAYLOAD);
    // 2026-11-01T00:43Z is still Oct 31 in New York (UTC-4 on that date).
    const ny = groupResetsByDay(codex, { timeZone: "America/New_York" });
    expect(ny.get("2026-10-31").banked.map((e) => e.id)).toEqual(["x1"]);
    expect(ny.get("2026-10-28").regular.map((e) => e.id)).toEqual(["x2"]);

    const utc = groupResetsByDay(codex, { timeZone: "UTC" });
    expect(utc.get("2026-11-01").banked).toHaveLength(1);
    expect(utc.has("2026-10-31")).toBe(false);
  });

  it("falls back to the browser zone on an invalid zone", () => {
    const { claude } = normalizeProviderResets(PAYLOAD);
    expect(groupResetsByDay(claude, { timeZone: "Not/AZone" }).size).toBe(2);
  });
});

describe("fetchProviderResets", () => {
  it("reads the tracker endpoint", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => PAYLOAD }));
    const out = await fetchProviderResets({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(PROVIDER_RESETS_URL, expect.objectContaining({ method: "GET" }));
    expect(out.codex).toHaveLength(2);
  });

  it("throws on an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(fetchProviderResets({ fetchImpl })).rejects.toThrow("503");
  });
});
