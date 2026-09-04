"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");

function queueRow({ source, model, hourStart, totalTokens }) {
  return {
    source,
    model,
    hour_start: hourStart,
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
    billable_total_tokens: totalTokens,
    conversation_count: 1,
  };
}

async function callEndpoint(handler, endpoint) {
  const url = new URL(`http://localhost${endpoint}`);
  const chunks = [];
  const req = {
    method: "GET",
    url: url.pathname + url.search,
    headers: { host: "localhost" },
  };
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(body) {
      if (body) chunks.push(body);
    },
  };
  assert.equal(await handler(req, res, url), true);
  assert.equal(res.statusCode, 200);
  return JSON.parse(chunks.join(""));
}

test("local usage APIs preserve raw AStudio model IDs", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-astudio-model-id-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const day = new Date().toISOString().slice(0, 10);
    const rows = [
      queueRow({ source: "acode", model: "xopglm52", hourStart: `${day}T02:00:00.000Z`, totalTokens: 100 }),
      queueRow({ source: "acode", model: "xsparkx2agent", hourStart: `${day}T03:00:00.000Z`, totalTokens: 50 }),
      queueRow({ source: "acode", model: "custom-service-id", hourStart: `${day}T04:00:00.000Z`, totalTokens: 25 }),
      queueRow({ source: "codex", model: "xopglm52", hourStart: `${day}T05:00:00.000Z`, totalTokens: 10 }),
    ];
    await fs.promises.writeFile(queuePath, `${rows.map(JSON.stringify).join("\n")}\n`);
    const handler = createLocalApiHandler({ queuePath });

    const query = `from=${day}&to=${day}&tz=UTC`;
    const daily = await callEndpoint(handler, `/functions/tokentracker-usage-daily?${query}`);
    assert.deepEqual(daily.data[0].models, {
      xopglm52: 110,
      xsparkx2agent: 50,
      "custom-service-id": 25,
    });

    const hourly = await callEndpoint(
      handler,
      `/functions/tokentracker-usage-hourly?day=${day}&tz=UTC`,
    );
    assert.deepEqual(hourly.data.map((row) => Object.keys(row.models)[0]), [
      "xopglm52",
      "xsparkx2agent",
      "custom-service-id",
      "xopglm52",
    ]);

    const monthly = await callEndpoint(handler, `/functions/tokentracker-usage-monthly?${query}`);
    assert.deepEqual(monthly.data[0].models, daily.data[0].models);

    const heatmap = await callEndpoint(handler, "/functions/tokentracker-usage-heatmap?weeks=1&tz=UTC");
    const heatmapCell = heatmap.weeks.flat().find((cell) => cell.day === day);
    assert.deepEqual(heatmapCell.models, daily.data[0].models);

    const breakdown = await callEndpoint(
      handler,
      `/functions/tokentracker-usage-model-breakdown?${query}`,
    );
    const astudio = breakdown.sources.find((entry) => entry.source === "acode");
    assert.deepEqual(
      astudio.models.map(({ model, model_id }) => ({ model, model_id })),
      [
        { model: "xopglm52", model_id: "xopglm52" },
        { model: "xsparkx2agent", model_id: "xsparkx2agent" },
        { model: "custom-service-id", model_id: "custom-service-id" },
      ],
    );
    const codex = breakdown.sources.find((entry) => entry.source === "codex");
    assert.deepEqual(codex.models[0], {
      ...codex.models[0],
      model: "xopglm52",
      model_id: "xopglm52",
    });
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});
