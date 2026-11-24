import { describe, expect, it } from "vitest";
import { buildProfileOptions, mergeKnownProfiles, profileSourceIds } from "./profile-filter.js";

// Spec: a provider split into profiles reports "<provider>@<profile>" sources
// next to the plain "<provider>" for its native directory. The selector lists
// those, and only those, and stays hidden for everyone who did not split.

describe("profileSourceIds", () => {
  it("keeps the native source and every profile of a split provider, native first", () => {
    expect(profileSourceIds(["claude@work", "claude", "claude@personal"])).toEqual([
      "claude",
      "claude@personal",
      "claude@work",
    ]);
  });

  it("drops providers that have no profile source", () => {
    expect(profileSourceIds(["claude", "claude@work", "codex", "cursor"])).toEqual(["claude", "claude@work"]);
  });

  it("is empty when nothing is split", () => {
    expect(profileSourceIds(["claude", "codex"])).toEqual([]);
    expect(profileSourceIds([])).toEqual([]);
  });

  it("normalizes case and spaces, drops blanks and duplicates", () => {
    expect(profileSourceIds([" Claude@Work ", "claude@work", "", null, undefined, "CLAUDE"])).toEqual([
      "claude",
      "claude@work",
    ]);
  });

  it("returns an empty list for a non-array", () => {
    expect(profileSourceIds(undefined)).toEqual([]);
    expect(profileSourceIds(null)).toEqual([]);
    expect(profileSourceIds("claude@work")).toEqual([]);
  });
});

describe("mergeKnownProfiles", () => {
  it("remembers profiles seen earlier when a period no longer reports them", () => {
    const first = mergeKnownProfiles([], ["claude", "claude@work"]);
    const second = mergeKnownProfiles(first, ["claude"]);
    expect(second).toEqual(["claude", "claude@work"]);
  });

  it("adds new profiles in sorted order", () => {
    expect(mergeKnownProfiles(["claude", "claude@work"], ["claude@personal"])).toEqual([
      "claude",
      "claude@personal",
      "claude@work",
    ]);
  });

  it("returns the same array when nothing new was seen, so state does not re-render", () => {
    const known = ["claude", "claude@work"];
    expect(mergeKnownProfiles(known, ["claude@work"])).toBe(known);
    expect(mergeKnownProfiles(known, [])).toBe(known);
  });
});

describe("buildProfileOptions", () => {
  it("is empty with fewer than two sources, so the selector stays hidden", () => {
    expect(buildProfileOptions([])).toEqual([]);
    expect(buildProfileOptions(["claude"])).toEqual([]);
    expect(buildProfileOptions(undefined)).toEqual([]);
  });

  it("starts with All profiles, labels the native one as the default and names the rest", () => {
    expect(buildProfileOptions(["claude", "claude@personal", "claude@work"])).toEqual([
      { value: "", label: "All profiles" },
      { value: "claude", label: "Claude (default)" },
      { value: "claude@personal", label: "Claude · personal" },
      { value: "claude@work", label: "Claude · work" },
    ]);
  });

  it("uses the source id, lowercased, as the option value", () => {
    const options = buildProfileOptions(["Claude", "Claude@Work"]);
    expect(options.map((o) => o.value)).toEqual(["", "claude", "claude@work"]);
  });
});
