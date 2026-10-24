const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseVsCodeCopilotChatIncremental, parseRolloutIncremental } = require('../src/lib/rollout');
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

test('shared cursors retain Fast/Ultrafast premiums alongside unknown Copilot input across repeated scans', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-copilot-speed-tiers-'));
  t.mock.method(os, 'homedir', () => tmp);
  try {
    const queuePath = path.join(tmp, 'queue.jsonl');
    const cursors = {};
    const rolloutFiles = [];
    for (const tier of ['priority', 'ultrafast']) {
      const file = path.join(tmp, `${tier}.jsonl`);
      const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10,
        reasoning_output_tokens: 0, total_tokens: 110 };
      await fs.writeFile(file, [
        { type: 'session_meta', timestamp: '2026-09-01T10:00:00Z', payload: { id: tier, cwd: tmp, model: 'gpt-6.1-sol' } },
        { type: 'event_msg', timestamp: '2026-09-01T10:00:01Z', payload: { type: 'thread_settings_applied',
          thread_settings: { model: 'gpt-6.1-sol', service_tier: tier } } },
        { type: 'event_msg', timestamp: '2026-09-01T10:00:02Z', payload: { type: 'token_count',
          info: { total_token_usage: usage, last_token_usage: usage } } },
      ].map(value => JSON.stringify(value)).join('\n') + '\n');
      rolloutFiles.push(file);
    }
    await parseRolloutIncremental({ rolloutFiles, cursors, queuePath });
    const codex = (await fs.readFile(queuePath, 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(codex.priority_input_tokens, 60);
    assert.equal(codex.ultrafast_input_tokens, 60);
    const standard = computeRowCost({ ...codex, priority_input_tokens: 0, priority_cached_input_tokens: 0,
      priority_output_tokens: 0, ultrafast_input_tokens: 0, ultrafast_cached_input_tokens: 0, ultrafast_output_tokens: 0 });
    assert.ok(Math.abs(computeRowCost(codex) - standard * 4) < 1e-9, 'two equal requests cost 2x + 6x their individual base');
    const sessionPath = path.join(tmp, 'copilot.json');
    await fs.writeFile(sessionPath, JSON.stringify({ requests: [{ requestId: 'unknown',
      modelId: 'customendpoint/vendor/gpt-6.1-sol', timestamp: Date.parse('2026-09-01T10:15:00Z'),
      promptTokens: 1000, completionTokens: 100 }] }));
    await parseVsCodeCopilotChatIncremental({ sessionPaths: [sessionPath], cursors, queuePath });
    const copilot = JSON.parse((await fs.readFile(queuePath, 'utf8')).trim().split('\n').at(-1));
    const summary = await request(createLocalApiHandler({ queuePath }), 'usage-summary');
    assert.equal(summary.totals.total_tokens, 1320);
    assert.equal(summary.totals.unclassified_input_tokens, 1000);
    assert.equal(summary.totals.total_cost_usd, null);
    assert.equal(summary.totals.cost_status, 'partial');
    assert.ok(Math.abs(Number(summary.totals.known_cost_usd) - computeRowCost(codex) - computeKnownRowCost(copilot)) < 1e-9);
    const restored = JSON.parse(JSON.stringify(cursors));
    assert.equal((await parseRolloutIncremental({ rolloutFiles, cursors: restored, queuePath })).bucketsQueued, 0);
    assert.equal((await parseVsCodeCopilotChatIncremental({ sessionPaths: [sessionPath], cursors: restored, queuePath })).bucketsQueued, 0);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

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
    assert.equal(computeKnownRowCost({ ...row, source: 'grok', total_cost_usd: 999 }), 0.005,
      'partial input cannot make a provider cost look like a proven subtotal');
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
    assert.equal(buildAllModels(fleet)[0].tokens.unclassified, 1000000);
    // A fully classified row must not turn the mixed source/model total
    // into an apparently complete cost, even after dashboard aggregation.
    const complete = { ...row, hour_start: '2026-09-01T10:30:00Z',
      usage_precision: undefined, unclassified_input_tokens: 0,
      input_tokens: 100, output_tokens: 10, total_tokens: 110, billable_total_tokens: 110,
      priority_input_tokens: 100, priority_output_tokens: 10,
      long_context_input_tokens: 100, long_context_output_tokens: 10,
      priority_long_context_input_tokens: 100, priority_long_context_output_tokens: 10 };
    await fs.appendFile(queuePath, JSON.stringify(complete) + '\n');
    const mixed = await request(handler, 'usage-summary');
    assert.equal(mixed.totals.total_tokens, 1000210);
    assert.equal(mixed.totals.total_cost_usd, null);
    assert.equal(mixed.totals.cost_status, 'partial');
    assert.ok(Math.abs(Number(mixed.totals.known_cost_usd) - (0.005 + computeRowCost(complete))) < 1e-9);
    const mixedBreakdown = await request(handler, 'usage-model-breakdown');
    assert.equal(mixedBreakdown.sources[0].models[0].totals.known_cost_usd, mixed.totals.known_cost_usd,
      'per-row priority and long-context premiums survive model aggregation');
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
