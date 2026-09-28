"use strict";

// Source-level guardrails for the heatmap's two wire formats. The edge runs on
// Deno and cannot be imported here, so these lock the properties the CLI-side
// expander in src/lib/heatmap-compact.js silently depends on.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const edgePath = path.join(__dirname, "..", "dashboard", "edge-patches", "tokentracker-account-heatmap.ts");
const edge = fs.readFileSync(edgePath, "utf8");

test("the compact branch is opt-in, so shipped clients keep the dense payload", () => {
  assert.match(edge, /const wantsCompact = url\.searchParams\.get\("format"\) === "compact"/);
  assert.match(edge, /if \(wantsCompact\) \{/);
});

test("both formats read the same active_days, computed once off the grid", () => {
  const computed = edge.indexOf("const activeDays = cells.filter((c) => c.billable_total_tokens > 0).length;");
  assert.notEqual(computed, -1, "active_days must be computed once, not per branch");
  assert.equal(
    edge.match(/cells\.filter\(\(c\) => c\.billable_total_tokens > 0\)\.length/g).length,
    1,
    "a second copy of this expression is how the two formats drift apart",
  );
  assert.equal(edge.match(/active_days: activeDays,/g).length, 2, "both branches must use it");
  // And it must be computed before either branch can return.
  assert.ok(computed < edge.indexOf("if (wantsCompact)"));
});

test("the compact rows are projected from the same cells the dense grid uses", () => {
  // Projecting from `compactDays` instead would skip the from..to clamp and the
  // Number() coercions, and the two formats would disagree on the edges.
  assert.match(edge, /const days = cells\s*\.filter\(\(c\) => c\.models !== null\)\s*\.map\(/);
  assert.match(edge, /return \[c\.day, c\.total_tokens, pairs\];/);
});

test("the model dictionary is built in first-appearance order and emitted with the rows", () => {
  // Order is the index space the client resolves against, so it has to come
  // from one pass over the same rows, not from a separate sort or a Set.
  assert.match(edge, /const modelNames: string\[\] = \[\];/);
  assert.match(edge, /idx = modelNames\.length;\s*modelNames\.push\(name\);/);
  assert.match(edge, /pairs\.push\(idx, c\.models!\[name\]\);/);
  assert.match(edge, /model_names: modelNames,/);
});

test("the compact payload carries max_value, the only input to level the client lacks", () => {
  assert.match(edge, /max_value: maxValue,/);
});

test("the dense branch still emits whole weeks of seven", () => {
  assert.match(edge, /for \(let i = 0; i < cells\.length; i \+= 7\) \{\s*weeksArr\.push\(cells\.slice\(i, i \+ 7\)\);/);
});

test("the level thresholds in the edge match the ones the client reimplements", () => {
  const { expandHeatmapCompact } = require("../src/lib/heatmap-compact");
  // Pull the edge's own cut points out of the source and drive the client with
  // them, so an edit to either side has to be made on both.
  const calcLevel = edge.slice(edge.indexOf("const calcLevel ="), edge.indexOf("const cells:"));
  const cuts = [...calcLevel.matchAll(/if \(r <= ([\d.]+)\) return (\d)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(cuts, [[0.25, 1], [0.5, 2], [0.75, 3]]);
  const maxValue = 1000;
  const days = cuts.map(([ratio], i) => [`2026-09-0${i + 1}`, ratio * maxValue, []]);
  const out = expandHeatmapCompact({
    format: "compact",
    from: "2026-09-01",
    to: "2026-09-07",
    week_starts_on: "sun",
    active_days: cuts.length,
    streak_days: 0,
    max_value: maxValue,
    model_names: [],
    days,
  });
  const levels = out.weeks.flat().slice(0, cuts.length).map((c) => c.level);
  assert.deepEqual(levels, cuts.map(([, level]) => level));
});

test("gzip stays out of this function", () => {
  // The gateway decompresses an encoded edge response and forwards it plain, so
  // a Content-Encoding branch here burns CPU twice and saves nothing. Verified
  // on the wire 2026-09-20; see the comment above `json()`.
  assert.ok(!/Content-Encoding/i.test(edge.replace(/\/\*[\s\S]*?\*\//g, "")), "no gzip branch outside the comment");
});
