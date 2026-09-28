"use strict";

// The six account-* edge endpoints must each honor an optional ?device_id=
// query param. UUID syntax is checked at the edge; ownership and active-device
// scoping are resolved atomically inside account_usage_grouped_v2. The shared
// cache RPC delegates every miss to v2, so cache hits cannot bypass that
// ownership contract. This avoids the old per-request devices SELECT while
// keeping another user's device from ever narrowing the result.

const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert");

const ROOT = path.join(__dirname, "..");
const EDGE_DIR = "dashboard/edge-patches";

const ENDPOINTS = [
  "tokentracker-account-daily.ts",
  "tokentracker-account-summary.ts",
  "tokentracker-account-hourly.ts",
  "tokentracker-account-monthly.ts",
  "tokentracker-account-heatmap.ts",
  "tokentracker-account-model-breakdown.ts",
];

function readEdge(name) {
  return fs.readFileSync(path.join(ROOT, EDGE_DIR, name), "utf8");
}

test("every account-* endpoint delegates guarded device scoping through the shared cache RPC", () => {
  for (const name of ENDPOINTS) {
    const src = readEdge(name);
    assert.ok(
      src.includes('url.searchParams.get("device_id")'),
      `${name}: does not read the device_id query param`,
    );
    assert.match(src, /const requestedDeviceId\s*=\s*rawDeviceId\s*&&\s*\/\^\[0-9a-f\]/u,
      `${name}: must reject malformed device UUIDs before the RPC`);
    // summary/heatmap call a compact RPC that itself delegates to
    // account_usage_grouped_cached (see the fold-account-summary-and-heatmap
    // migration), so device scoping is still resolved atomically in Postgres.
    assert.ok(
      src.includes('rpc("account_usage_grouped_cached"') ||
        src.includes('rpc("account_summary_compact"') ||
        src.includes('rpc("account_heatmap_compact"') ||
        src.includes('rpc("account_model_breakdown_compact"') ||
        src.includes('rpc("account_daily_compact"'),
      `${name}: must use the cached atomic device-scoping RPC`,
    );
    assert.match(src, /p_device_id:\s*requestedDeviceId/u,
      `${name}: must pass the requested device to the RPC`);
    assert.ok(!src.includes('.from("tokentracker_devices")'),
      `${name}: must not restore the extra devices SELECT`);
  }
});

test("the shared cache delegates misses to the atomic v2 device-scoping RPC", () => {
  const migration = fs.readFileSync(
    path.join(ROOT, "migrations/20260718071507_add-shared-account-usage-cache.sql"),
    "utf8",
  );
  assert.match(migration, /public\.account_usage_grouped_v2\(/u);
  assert.match(migration, /p_user_id,\s*p_device_id,/u);
});

test("v2 RPC narrows only to an active device owned by the requested user", () => {
  const migration = fs.readFileSync(
    path.join(ROOT, "migrations/20260717013000_harden-backend-hot-paths.sql"),
    "utf8",
  );
  assert.match(migration, /d\.user_id\s*=\s*p_user_id/u, "RPC must scope devices to the user");
  assert.match(migration, /d\.revoked_at\s+IS\s+NULL/u, "RPC must exclude revoked devices");
  assert.match(migration, /p_device_id\s*=\s*ANY\(ids\)/u,
    "RPC must narrow only when the requested device belongs to the active set");
});

test("account-devices endpoint exists, verifies JWT, queries devices, sums per-device", () => {
  const src = readEdge("tokentracker-account-devices.ts");
  assert.ok(src.includes("verifiedUserIdFromJwt"), "missing JWT verification");
  assert.ok(
    src.includes('.from("tokentracker_devices")'),
    "does not query tokentracker_devices",
  );
  assert.ok(
    src.includes('.select("id, device_name, platform, created_at")'),
    "account-devices must select id, device_name, platform, created_at",
  );
  assert.ok(src.includes('.is("revoked_at", null)'), "must filter revoked devices");
  assert.ok(src.includes('.eq("user_id"'), "must filter devices by user_id");
  assert.ok(src.includes("account_usage_grouped"), "does not sum usage via the RPC");
  assert.ok(src.includes("total_tokens"), "does not return per-device total_tokens");
});

// Two per-device summing invariants (both regressed in the shipped v0.61.0 card):
//   1. The UTC query window is widened ±1 day for TZ shifts, so the tz-local day
//      buckets the RPC returns MUST be trimmed back to [from, to] — otherwise a
//      single-day view sums ~3 days per device.
//   2. The RPC's account-level branch ignores p_device_ids, so account-level
//      sources (cursor) MUST be excluded from per-device sums — otherwise every
//      device gets the user's entire account-level total added (N identical
//      phantom-device rows).
test("account-devices trims day buckets to [from, to] and excludes account-level sources", () => {
  const src = readEdge("tokentracker-account-devices.ts");
  assert.ok(
    /day\s*<\s*fromDay\s*\|\|\s*day\s*>\s*toDay/.test(src),
    "per-device sum must skip buckets outside the requested [from, to] day range",
  );
  assert.ok(
    /ACCOUNT_LEVEL_SOURCES\.has\(/.test(src),
    "per-device sum must skip account-level sources (no device attribution)",
  );
});

// The account-level usage excluded from per-device sums must still be returned
// (as account_sources) so the card total reconciles with the dashboard total.
test("account-devices returns account-level source totals alongside devices", () => {
  const src = readEdge("tokentracker-account-devices.ts");
  assert.ok(
    /p_device_ids:\s*\[\]/.test(src),
    "account-source sum must call the RPC with an empty p_device_ids (account branch only)",
  );
  assert.ok(
    src.includes("account_sources: accountSources"),
    "response must include the account_sources array",
  );
});

test("account-devices is NOT in the pricing-parity mirror set (no MODEL_PRICING block)", () => {
  const src = readEdge("tokentracker-account-devices.ts");
  assert.ok(!src.includes("const MODEL_PRICING"), "account-devices must not embed a pricing block");
});
