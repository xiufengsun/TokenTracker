"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { fixture } = require("./helpers/self-host-fixture.cjs");

let instance;
test.before(async () => { instance = await fixture(); });
test.after(async () => { await instance?.close(); });

const issue = async (owner) => (await instance.request("tokentracker-device-token-issue",
  { device_name: "host", platform: "test", machine_id: randomUUID() }, owner)).data;
const row = (source, model, tokens) => ({
  hour_start: "2026-10-01T12:00:00Z", source, model,
  input_tokens: tokens, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0,
  reasoning_output_tokens: 0, total_tokens: tokens, billable_total_tokens: tokens,
  total_cost_usd: 0, conversation_count: 1,
});

test("self-host account views serve a Cursor grok-bot row uploaded without cost_coverage", async () => {
  const owner = await instance.user();
  const device = await issue(owner);
  const up = await instance.request("tokentracker-ingest",
    { buckets: [row("codex", "gpt-6", 100), row("cursor", "grok-bot-automation", 50)] }, device.token);
  assert.equal(up.response.status, 200, up.data.error);
  for (const slug of [
    "tokentracker-account-summary",
    "tokentracker-account-daily",
    "tokentracker-account-model-breakdown",
  ]) {
    const r = await instance.request(`${slug}?from=2026-10-01&to=2026-10-01&tz=UTC`, undefined, owner);
    assert.equal(r.response.status, 200, `${slug}: ${JSON.stringify(r.data)}`);
  }
});

test("self-host ingest advertises cost coverage v1 to 1.5.27 clients", async () => {
  const owner = await instance.user();
  const device = await issue(owner);
  const probe = await instance.request("tokentracker-ingest", { kind: "cost_capabilities" }, device.token);
  assert.equal(probe.response.status, 200, JSON.stringify(probe.data));
  assert.deepEqual(probe.data.cost_coverage_versions, [1]);
});
