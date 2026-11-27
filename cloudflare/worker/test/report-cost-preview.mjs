// Exercise the actual CLI capability/ACK protocol and account/public cost responses on the synthetic QA Worker.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { drainQueueToCloud } = require("../../../src/commands/sync.js");
const base = process.env.TT_QA_BASE_URL;
assert.equal(
  base,
  "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev",
);
assert.match(process.env.TT_QA_EMAIL || "", /@example\.invalid$/);
assert.ok(process.env.TT_QA_ID && process.env.TT_QA_REFRESH_SECRET);
async function call(path, body, auth, expected = 200, refresh = false) {
  const r = await fetch(new URL(path, base), {
    redirect: "error",
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: "Bearer " + auth } : {}),
      ...(refresh
        ? { "x-refresh-secret": process.env.TT_QA_REFRESH_SECRET }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (r.status !== expected)
    throw new Error(
      path.split("?")[0] + " HTTP " + r.status + " expected " + expected,
    );
  return r.json();
}
const route = (k) => "/functions/tokentracker-" + k;
const token = (
  await call("/api/auth/sessions?client_type=mobile", {
    email: process.env.TT_QA_EMAIL,
    password: process.env.TT_QA_PASSWORD,
  })
).accessToken;
assert.ok(token);
const acct = await call(route("billing") + "?action=account", undefined, token);
assert.equal(acct.environment, "sandbox");
if (!acct.membership.can_read_cloud)
  await call(route("billing") + "?action=trial", {}, token);
const trial = await call(route("device-flow-authorize"), {
  client_info: "cost-e2e",
  machine_id: "qa-cost-" + randomUUID(),
});
await call(route("device-flow-grant"), { user_code: trial.user_code }, token);
const { device_token, device_id } = await call(route("device-flow-poll"), {
  device_code: trial.device_code,
});
assert.ok(device_token && device_id);
const day = new Date().toISOString().slice(0, 10),
  ts = day + "T02:00:00.000Z",
  p = "?from=" + day + "&to=" + day + "&tz=UTC";
const id = process.env.TT_QA_ID,
  rand = randomUUID().slice(0, 8);
const summary = async () =>
  Number(
    (await call(route("account-summary") + p, undefined, token)).totals
      .total_cost_usd,
  );
const daily = async () =>
  Number(
    (await call(route("account-daily") + p, undefined, token)).data.reduce(
      (n, r) => n + Number(r.total_cost_usd),
      0,
    ),
  );
const refresh = () =>
  call(
    route("leaderboard-refresh"),
    { period: "week", force_refresh: true },
    null,
    200,
    true,
  );
const ranking = async () =>
  Number(
    (await call(route("leaderboard") + "?period=week&user_id=" + id)).me
      ?.estimated_cost_usd || 0,
  );
const profile = async () =>
  Number(
    (
      await call(
        route("leaderboard-profile") + "?period=week&user_id=" + id,
        undefined,
        token,
      )
    ).totals.estimated_cost_usd,
  );
const exact = (n, m) =>
  assert.ok(Math.abs(n - m) < 1e-6, `Cost differs: ${n} vs ${m}`);
await refresh();
const before = await Promise.all([summary(), daily(), ranking(), profile()]);
const zeros = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};
const coverage = (usd, origin, unreported = 0) => ({
  version: 1,
  reported_usd: usd,
  reported_events: 1,
  missing_events: unreported ? 1 : 0,
  allocated_events: origin === "grok_allocated" ? 1 : 0,
  origins: [origin],
  unreported_tokens: { ...zeros, input_tokens: unreported },
});
const rows = [
  ["grok", "grok-4.7", 1_000_000, 1.25, coverage(1.25, "grok_usd", 500_000)],
  ["cursor", "grok-bot-zero-" + rand, 12, 0, coverage(0, "cursor_csv_cost")],
  ["grok", "opaque-" + rand, 100, 0.12, coverage(0.12, "grok_allocated")],
  ["grok", "qa-legacy-" + rand, 25, 0.03, null],
  ["cursor", "grok-bot-old-" + rand, 12, 1.5, null],
].map(([source, model, n, cost, proof]) => ({
  ...zeros,
  source,
  model,
  hour_start: ts,
  input_tokens: n,
  total_tokens: n,
  total_cost_usd: cost,
  conversation_count: 1,
  ...(proof ? { cost_coverage: proof } : {}),
}));
const dir = mkdtempSync(join(tmpdir(), "tt-cost-qa-")),
  queuePath = join(dir, "usage.jsonl"),
  queueStatePath = join(dir, "offset.json");
try {
  writeFileSync(
    queuePath,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    { mode: 0o600 },
  );
  const upload = await drainQueueToCloud({
    baseUrl: base,
    deviceToken: device_token,
    queuePath,
    queueStatePath,
  });
  assert.equal(upload.inserted, rows.length);
  assert.equal(
    JSON.parse(readFileSync(queueStatePath, "utf8")).offset,
    statSync(queuePath).size,
  );
  await refresh();
  const after = await Promise.all([summary(), daily(), ranking(), profile()]);
  for (let i = 0; i < 4; i++) exact(after[i] - before[i], 2.4);
  const models = (
    await call(
      route("account-model-breakdown") + p + "&device_id=" + device_id,
      undefined,
      token,
    )
  ).sources.flatMap((s) => s.models);
  for (const [index, label] of [
    "mixed",
    "provider_reported",
    "allocated",
    "provider_reported",
    "unpriced",
  ].entries()) {
    const m = models.find((m) => m.model === rows[index].model);
    assert.equal(m.cost_source, label);
    if (index === 2) assert.equal(m.has_allocated_cost, true);
  }
  await call(
    route("ingest"),
    {
      cost_coverage_version: 1,
      hourly: [
        {
          ...rows[1],
          cost_coverage: { ...rows[1].cost_coverage, unexpected: "synthetic" },
        },
      ],
    },
    device_token,
    400,
  );
  console.log(
    JSON.stringify({
      synthetic_usage_buckets: rows.length,
      all_five_consumers: true,
      queue_acknowledged: true,
      delta_usd: 2.4,
      invalid_coverage_status: 400,
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
