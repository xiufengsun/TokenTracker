// Compare synthetic pricing evidence against retrieved edge artifacts. No provider or database requests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deployedCalculator } from "./report-deployed-calculator.mjs";
import { build } from "esbuild";

const archive = process.argv[2];
assert.ok(
  archive,
  "Pass a directory containing trusted InsForge deployed function sources",
);
const module = (
  await build({
    stdin: {
      contents:
        'export {computeRowCost} from "./src/report-pricing";export {publicRowCost} from "./src/report-public-pricing"',
      resolveDir: import.meta.dirname + "/..",
    },
    bundle: true,
    write: false,
    target: "node24",
    platform: "node",
    format: "esm",
  })
).outputFiles[0];
const { computeRowCost, publicRowCost } = await import(
  "data:text/javascript;base64," +
    Buffer.from(module.contents).toString("base64")
);
const tokens = {
  input_tokens: 100000,
  cached_input_tokens: 100000,
  cache_creation_input_tokens: 200000,
  output_tokens: 300000,
  reasoning_output_tokens: 10000,
};
const zero = Object.fromEntries(Object.keys(tokens).map((k) => [k, 0]));
const provenance = (mode) => ({
  version: 1,
  covered_tokens:
    mode === "partial"
      ? { ...zero, input_tokens: 25000 }
      : mode === "missing"
        ? zero
        : tokens,
  reported_usd: mode === "zero" || mode === "missing" ? 0 : 0.25,
  has_reported: mode !== "missing",
  has_allocated: mode === "allocated",
  has_missing: ["partial", "missing"].includes(mode),
  origins: [],
});
const stats = [];
for (const name of [
  "account-summary",
  "account-daily",
  "account-model-breakdown",
  "leaderboard-profile",
  "leaderboard-refresh",
]) {
  const { src, calculate: ref } = deployedCalculator(archive, name);
  assert.ok(src.includes("usage_cost_provenance_v1"));
  const calc = name.startsWith("account-") ? computeRowCost : publicRowCost;
  let count = 0;
  for (const source of [
    "grok",
    "cursor",
    "codex",
    "claude",
    "muse",
    "cline",
    "lmstudio",
  ])
    for (const model of [
      "grok-4.7",
      "grok-4.7:batch",
      "grok-4.7 (Flex)",
      "grok-build-free",
      "grok-bot-xyz",
      "unknown",
      "gpt-5.4",
      "claude-fable-5-2",
      "deepseek-v4-pro",
    ])
      for (const tier of ["peak", "off_peak"]) {
        const row = {
          ...tokens,
          source,
          model,
          bucket: "",
          pricing_tier: tier,
          conversations: 1,
          total_tokens: 710000,
        };
        for (const p of source === "grok" ||
        (source === "cursor" && model.startsWith("grok-bot-"))
          ? [
              undefined,
              ...["zero", "full", "partial", "allocated", "missing"].map(
                provenance,
              ),
            ]
          : [undefined]) {
          const v = { ...row, cost_provenance: p };
          const computed = calc(v),
            expected = ref(v);
          assert.ok(
            Number.isFinite(computed) && Math.abs(computed - expected) < 1e-9,
            `Mismatch for ${name} ${source} ${model} ${tier}`,
          );
          count++;
        }
      }
  stats.push({
    function: name,
    sha256: createHash("sha256").update(src).digest("hex"),
    synthetic_comparisons: count,
  });
}
console.log(JSON.stringify({ matched: true, stats }));
