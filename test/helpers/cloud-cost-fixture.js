"use strict";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { setup, migration } = require("./cloud-usage-archive-fixture");
const { eventCostCoverage } = require("../../src/lib/cost-provenance");
const COST_MIGRATION = "20261124022850_usage-cost-provenance.sql";
const row = (usd = 0, tokens = 100) => {
  const r = { hour_start: "2026-01-02T02:00:00Z", source: "grok", model: "grok-4.7", input_tokens: tokens,
    cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
    total_tokens: tokens, billable_total_tokens: tokens, conversations: 1, total_cost_usd: usd ?? 0 };
  r.cost_coverage = eventCostCoverage(r, usd, "grok_usd");
  return r;
};
async function fixture({ apply = true, archive = true } = {}) {
  const db = await setup();
  const call = async (name, args = []) => (await db.query(`SELECT ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) AS result`, args)).rows[0].result;
  await db.exec(migration("20261003120000_cloud-subscriptions.sql"));
  await db.exec(migration("20261004120000_cloud-machine-access.sql"));
  if (archive) await db.exec(migration("20261005120000_cloud-usage-archive.sql"));
  if (apply) await db.exec(migration(COST_MIGRATION));
  await db.exec("UPDATE tokentracker_cloud_policy SET phase='active',launch_at=now() WHERE environment='sandbox'");
  const user = randomUUID(), token = randomUUID(), upload = randomUUID();
  await db.query("INSERT INTO auth.users VALUES($1)", [user]);
  await call("cloud_start_trial", [user, "sandbox"]);
  assert.equal((await call("cloud_issue_device_token", [user, "sandbox", "Cost fixture", "web", randomUUID(), ["Cost fixture"], randomUUID(), token, false, null])).ok, true);
  const device = (await db.query("SELECT device_id FROM tokentracker_device_tokens WHERE token_hash=$1", [token])).rows[0].device_id;
  const ingest = (rows, name = "cloud_ingest_usage_cost_v1") => call(name, [token, "sandbox", JSON.stringify(rows), "[]", upload]);
  return { db, call, user, token, device, ingest };
}

module.exports = { fixture, row, COST_MIGRATION };
