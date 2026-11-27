const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { fetchCursorGrokBotUsage } = require("../src/lib/cursor-config");
const { parseCursorApiIncremental } = require("../src/lib/rollout");

const date = "2026-11-25T00:02:00.000Z";
const timestamp = Date.parse(date);
const bot = { date, model: "grok-bot-automation", inputTokens: 100, outputTokens: 20 };
const record = { timestamp, model: bot.model, tokenUsage: { inputTokens: 100, outputTokens: 20, totalCents: 8.1732 } };

test("Cursor reads personal and current-user team usage, preserving identical billed occurrences", async () => {
  const scopes = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/GetTeams")) return Response.json({ teams: [{ id: 41 }] });
    if (url.endsWith("/GetMe")) return Response.json({ userId: 13 });
    const { teamId, userId } = JSON.parse(options.body);
    scopes.push({ teamId, userId });
    const records = teamId ? [record] : [record, record, { ...record, model: "other-model" }];
    return Response.json({ totalUsageEventsCount: records.length, usageEventsDisplay: records });
  };
  const args = { accessToken: "fixture-token", sinceMs: timestamp - 1000, untilMs: timestamp + 1000 };
  const results = await fetchCursorGrokBotUsage({ ...args, fetchImpl });
  assert.deepEqual(scopes, [{ teamId: undefined, userId: undefined }, { teamId: 41, userId: 13 }]);
  assert.deepEqual(results.map(r => r.tokenUsage.totalCents), [8.1732, 8.1732, 8.1732]);
  await assert.rejects(fetchCursorGrokBotUsage({ ...args, fetchImpl: async (url, opts) =>
    url.endsWith("/GetFilteredUsageEvents")
      ? Response.json({ totalUsageEventsCount: 2, usageEventsDisplay: [record] })
      : fetchImpl(url, opts) }), /Incomplete Cursor usage event pages/);
});

test("Cursor Bot cost does not erase other models or disappear in a later CSV refresh", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-grok-reported-cost-"));
  try {
    const queuePath = path.join(dir, "queue.jsonl");
    const cursors = {};
    const parse = (records, grokBotRecords = []) => parseCursorApiIncremental({ records, cursors, queuePath, grokBotRecords });
    await parse([{ ...bot, cost: 0 }, { ...bot, model: "claude-opus-4.6" }]);
    await parse([], [{ ...bot, tokenUsage: { totalCents: 8.1732 } }]);
    assert.equal((await parse([{ ...bot, cost: 0 }, { ...bot, model: "claude-opus-4.6" }])).bucketsQueued, 0);
    const queue = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse);
    const recent = Object.fromEntries(queue.map(r => [r.model, r]));
    assert.equal(recent["grok-bot-automation"].cost_coverage.reported_usd, 0.081732);
    assert.equal(recent["grok-bot-automation"].total_tokens, 120);
    assert.equal(recent["claude-opus-4.6"].total_tokens, 120);
    assert.deepEqual(queue.map(r => r.total_tokens), [120, 120, 120]);
    // A CSV correction is still authoritative when it carries a different token basis.
    await parse([{ ...bot, inputTokens: 90, cost: 0 }], [{ ...bot, tokenUsage: { totalCents: 8.1732 } }]);
    const changed = (await fs.readFile(queuePath, "utf8")).trim().split("\n").map(JSON.parse)
      .filter(r => r.model === bot.model).at(-1);
    assert.equal(changed.total_tokens, 110);
    assert.equal(changed.cost_coverage.reported_usd, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
