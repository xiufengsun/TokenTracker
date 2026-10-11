import { describe, expect, it } from "vitest";
import {
  getPaginationFlags,
  pageContainingRank,
  prependMeRowToPage,
} from "../leaderboard-ui";

describe("getPaginationFlags", () => {
  it("keeps next enabled when totalPages is unknown", () => {
    const flags = getPaginationFlags({ page: 1, totalPages: null });
    expect(flags.canPrev).toBe(false);
    expect(flags.canNext).toBe(true);
  });

  it("disables next when totalPages is 0", () => {
    const flags = getPaginationFlags({ page: 1, totalPages: 0 });
    expect(flags.canPrev).toBe(false);
    expect(flags.canNext).toBe(false);
  });

  it("disables next when on last page", () => {
    const flags = getPaginationFlags({ page: 5, totalPages: 5 });
    expect(flags.canPrev).toBe(true);
    expect(flags.canNext).toBe(false);
  });
});

describe("prependMeRowToPage", () => {
  it("keeps server paid identity on the pinned row without changing rank or usage", () => {
    const entries = [{ rank: 21, total_tokens: "30" }];
    for (const proActive of [true, false, undefined, "true", 1]) {
      const me = { rank: 1, user_id: "paid-owner", total_tokens: "155", pro_active: proActive };
      const result = prependMeRowToPage({ entries, me, meLabel: "YOU" });
      expect(result[0].pro_active).toBe(proActive === true);
      expect(result[0].rank).toBe(1);
      expect(result[0].total_tokens).toBe("155");
      expect(result[1]).toBe(entries[0]);
    }
  });

  it("prepends a pinned me row when current page does not contain me", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      is_me: false,
      display_name: "Anonymous",
      avatar_url: null,
      gpt_tokens: "1",
      claude_tokens: "2",
      total_tokens: "3",
    }));

    const me = { rank: 237, gpt_tokens: "10", claude_tokens: "20", total_tokens: "30" };
    const result = prependMeRowToPage({ entries, me, meLabel: "YOU" });

    expect(result).toHaveLength(21);
    expect(result[0]?.is_pinned).toBe(true);
    expect(result[0]?.is_me).toBe(true);
    expect(result[0]?.rank).toBe(237);
    expect(result[0]?.total_tokens).toBe("30");
    expect(result[0]?.display_name).toBe("YOU");
    expect(result[1]?.rank).toBe(1);
    expect(result[20]?.rank).toBe(20);
  });

  it("does not prepend when current page already contains me naturally", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      is_me: false,
      display_name: "Anonymous",
      total_tokens: "3",
    }));
    entries[7].is_me = true;

    const me = { rank: 8, total_tokens: "30" };
    const result = prependMeRowToPage({ entries, me, meLabel: "YOU" });

    expect(result).toBe(entries);
    expect(result.some((r) => r?.is_pinned)).toBe(false);
  });

  it("does not prepend when me rank is missing", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      rank: i + 1,
      total_tokens: "3",
    }));

    const me = { rank: null };
    const result = prependMeRowToPage({ entries, me, meLabel: "YOU" });

    expect(result).toBe(entries);
  });

  it("returns entries unchanged when me is null", () => {
    const entries = [{ rank: 1, total_tokens: "3" }];
    const result = prependMeRowToPage({ entries, me: null, meLabel: "YOU" });
    expect(result).toBe(entries);
  });
});

describe("pageContainingRank", () => {
  it("returns the page index that contains the given rank", () => {
    expect(pageContainingRank(1, 20)).toBe(1);
    expect(pageContainingRank(20, 20)).toBe(1);
    expect(pageContainingRank(21, 20)).toBe(2);
    expect(pageContainingRank(237, 20)).toBe(12);
    expect(pageContainingRank(237, 50)).toBe(5);
  });

  it("returns null for invalid input", () => {
    expect(pageContainingRank(null, 20)).toBeNull();
    expect(pageContainingRank(5, 0)).toBeNull();
    expect(pageContainingRank("x", 20)).toBeNull();
  });
});
