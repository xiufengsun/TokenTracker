const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseVsCodeCopilotChatIncremental } = require('../src/lib/rollout');
const { createLocalApiHandler } = require('../src/lib/local-api');
const { computeRowCost, computeKnownRowCost } = require('../src/lib/pricing');

async function request(handler, endpoint) {
  const url = new URL(`http://localhost/functions/tokentracker-${endpoint}?from=2026-09-01&to=2026-09-01&tz=UTC`);
  let body;
  const res = { setHeader() {}, writeHead(status) { assert.equal(status, 200); },
    end(value) { body = value; } };
  assert.equal(await handler({ method: 'GET', headers: {host: 'localhost'}, url: url.pathname + url.search }, res, url), true);
  return JSON.parse(body);
}

test('VS Code aggregate input survives parser, real pricing and local API without claiming a full cost', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-vscode-accounting-'));
  t.mock.method(os, "homedir", () => tmp);
  try {
    const sessionPath = path.join(tmp, 'session.json');
    const queuePath = path.join(tmp, 'queue.jsonl');
    await fs.writeFile(sessionPath, JSON.stringify({ requests: [{
      requestId: 'review-reproduction', modelId: 'customendpoint/vendor/gpt-6-astra',
      timestamp: Date.parse('2026-09-01T10:15:00Z'), promptTokens: 1000000, completionTokens: 100,
    }] }));
    const cursors = {};
    await parseVsCodeCopilotChatIncremental({sessionPaths: [sessionPath], queuePath, cursors});
    const row = JSON.parse((await fs.readFile(queuePath, 'utf8')).trim());
    assert.equal(row.unclassified_input_tokens, 1000000);
    assert.equal(row.total_tokens, row.unclassified_input_tokens + row.input_tokens + row.output_tokens + row.cached_input_tokens + row.cache_creation_input_tokens + row.reasoning_output_tokens);
    assert.equal(computeRowCost(row), null);
    assert.equal(computeKnownRowCost(row), 0.005);
    const handler = createLocalApiHandler({queuePath});
    const summary = await request(handler, 'usage-summary');
    assert.equal(summary.totals.unclassified_input_tokens, 1000000);
    assert.equal(summary.totals.total_tokens, 1000100);
    assert.equal(summary.totals.total_cost_usd, null);
    assert.equal(summary.totals.cost_status, 'partial');
    assert.equal(Number(summary.totals.known_cost_usd), 0.005);
    const daily = await request(handler, 'usage-daily');
    assert.equal(daily.data[0].cost_status, 'partial');
    assert.equal(daily.data[0].total_cost_usd, null);
    const breakdown = await request(handler, 'usage-model-breakdown');
    assert.equal(breakdown.sources[0].totals.cost_status, 'partial');
    assert.equal(breakdown.sources[0].models[0].totals.total_cost_usd, null);
    assert.equal(Number(breakdown.sources[0].models[0].totals.known_cost_usd), 0.005);
    const { loadDashboardModule } = require('./helpers/load-dashboard-module');
    const { buildFleetData, buildAllModels } = await loadDashboardModule('dashboard/src/lib/model-breakdown.ts');
    const fleet = buildFleetData(breakdown);
    assert.equal(fleet[0].usage, 1000100);
    assert.equal(fleet[0].usd, null);
    assert.equal(fleet[0].costPartial, true);
    assert.equal(buildAllModels(fleet)[0].costPartial, true);
    assert.equal(buildAllModels(fleet)[0].cost, null);
    // A fully classified row must not turn the mixed source/model total
    // into an apparently complete cost, even after dashboard aggregation.
    const complete = { ...row, hour_start: '2026-09-01T10:30:00Z',
      usage_precision: undefined, unclassified_input_tokens: 0,
      input_tokens: 100, output_tokens: 10, total_tokens: 110, billable_total_tokens: 110 };
    await fs.appendFile(queuePath, JSON.stringify(complete) + '\n');
    const mixed = await request(handler, 'usage-summary');
    assert.equal(mixed.totals.total_tokens, 1000210);
    assert.equal(mixed.totals.total_cost_usd, null);
    assert.equal(mixed.totals.cost_status, 'partial');
    assert.ok(Math.abs(Number(mixed.totals.known_cost_usd) - (0.005 + computeRowCost(complete))) < 1e-9);
    const again = await parseVsCodeCopilotChatIncremental({sessionPaths: [sessionPath], queuePath, cursors: JSON.parse(JSON.stringify(cursors))});
    assert.equal(again.bucketsQueued, 0);
    // Upgrade an existing v2 cursor, including an unchanged snapshot. Its
    // previously missing input column must be filled once, never added twice.
    const legacy = JSON.parse(JSON.stringify(cursors));
    legacy.copilotVsCode.version = 2;
    for (const b of Object.values(legacy.hourly.buckets)) delete b.totals.unclassified_input_tokens;
    for (const f of Object.values(legacy.copilotVsCode.files)) {
      for (const b of Object.values(f.snapshotTotals || {})) delete b.totals.unclassified_input_tokens;
    }
    await parseVsCodeCopilotChatIncremental({sessionPaths: [sessionPath], queuePath, cursors: legacy});
    const upgraded = JSON.parse((await fs.readFile(queuePath, 'utf8')).trim().split('\n').at(-1));
    assert.equal(upgraded.unclassified_input_tokens, 1000000);
    assert.equal(upgraded.total_tokens, 1000100);
    assert.equal((await parseVsCodeCopilotChatIncremental({sessionPaths: [sessionPath], queuePath, cursors: legacy})).bucketsQueued, 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
