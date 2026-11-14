const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

async function writeQueue(queuePath, rows) {
  await fs.promises.writeFile(queuePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function callEndpoint(queuePath, endpoint) {
  const handler = createLocalApiHandler({ queuePath });
  const url = new URL(`http://localhost${endpoint}`);
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const chunks = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead() {},
    write(chunk) {
      chunks.push(chunk);
    },
    end(body) {
      if (body) chunks.push(body);
    },
  };
  const handled = await handler(req, res, url);
  assert.ok(handled, `endpoint must be handled: ${endpoint}`);
  return JSON.parse(chunks.join(""));
}

test("usage-model-breakdown threads conversation_count through for request-only sources (#948)", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-zero-token-visibility-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await writeQueue(queuePath, [
      {
        source: "qoder-cn",
        model: "qfmodel",
        hour_start: "2026-10-31T17:00:00.000Z",
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
        billable_total_tokens: 0,
        total_cost_usd: 0,
        conversation_count: 26,
      },
      {
        source: "claude",
        model: "claude-sonnet-4-6",
        hour_start: "2026-10-31T17:00:00.000Z",
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 0,
        total_tokens: 120,
        conversation_count: 1,
      },
    ]);

    const payload = await callEndpoint(
      queuePath,
      "/functions/tokentracker-usage-model-breakdown?from=2026-10-31&to=2026-10-31&tz=UTC",
    );

    const bySource = Object.fromEntries(payload.sources.map((s) => [s.source, s]));
    assert.equal(bySource["qoder-cn"].totals.total_tokens, 0);
    assert.equal(bySource["qoder-cn"].totals.conversation_count, 26);
    assert.equal(bySource["qoder-cn"].models[0].totals.conversation_count, 26);
    assert.equal(bySource.claude.totals.conversation_count, 1);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("Claude custom usage remains visible with unknown pricing in the local model API", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-custom-cost-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queuePath = path.join(dir, "queue.jsonl");
  const tokens = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
  await writeQueue(queuePath, [{ source: "claude", model: "claude-sonnet-4-6", hour_start: "2026-11-01T12:00:00.000Z", ...tokens,
    backend_usage: [{ backend: "custom", backend_origin: "https://gateway.example", ...tokens }] }]);
  const result = await callEndpoint(queuePath, "/functions/tokentracker-usage-model-breakdown?from=2026-11-01&to=2026-11-01");
  const model = result.sources.find((s) => s.source === "claude").models[0];
  assert.equal(model.model, "claude-sonnet-4-6");
  assert.equal(model.totals.total_tokens, 110);
  assert.equal(model.pricing.status, "unpriced");
  assert.equal(Number(model.totals.total_cost_usd), 0);
});
