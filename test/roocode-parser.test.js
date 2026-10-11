/**
 * Roo Code parser unit test.
 *
 * Roo Code is a Cline-derived VS Code extension (rooveterinaryinc.roo-cline)
 * that stores tasks at:
 *   <User globalStorage>/rooveterinaryinc.roo-cline/tasks/<uuid>/ui_messages.json
 *   <same dir>/api_conversation_history.json
 *
 * Token data lives inside ui_messages entries where {type:"say", say:"api_req_started"}
 * with `text` being a JSON-stringified payload {tokensIn, tokensOut, cacheReads,
 * cacheWrites, apiProtocol, cost}. The model id lives in a <model>…</model>
 * tag inside <environment_details> blocks in api_conversation_history.json.
 *
 * Local end-to-end: this user's machine has no Roo Code install, so we build a
 * synthetic fixture under a temp dir and point a custom env at it via
 * TOKENTRACKER_KILOCODE_ROOTS (Roo Code reuses the same root resolver).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  resolveRoocodeTaskFiles,
  readRoocodeTaskModel,
  normalizeRoocodeModel,
  parseRoocodeIncremental,
} = require("../src/lib/rollout");

function setupFixture({ tasks }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roocode-fix-"));
  const tasksDir = path.join(root, "User", "globalStorage", "rooveterinaryinc.roo-cline", "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const t of tasks) {
    const taskDir = path.join(tasksDir, t.uuid);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "ui_messages.json"), JSON.stringify(t.uiMessages));
    if (t.history != null) {
      fs.writeFileSync(path.join(taskDir, "api_conversation_history.json"), t.history);
    }
  }
  return root;
}

function fakeEnv(root) {
  return {
    HOME: os.homedir(),
    TOKENTRACKER_KILOCODE_ROOTS: root, // Roo Code reuses resolveKilocodeRoots
  };
}

test("resolveRoocodeTaskFiles finds tasks via TOKENTRACKER_KILOCODE_ROOTS env", () => {
  const root = setupFixture({
    tasks: [
      { uuid: "task-a", uiMessages: [] },
      { uuid: "task-b", uiMessages: [] },
    ],
  });
  const files = resolveRoocodeTaskFiles(fakeEnv(root));
  assert.equal(files.length, 2);
  assert.equal(path.basename(files[0].filePath), "ui_messages.json");
  assert.match(path.basename(path.dirname(files[0].filePath)), /^task-(a|b)$/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("readRoocodeTaskModel returns the LATEST <model> tag from sibling history", () => {
  const root = setupFixture({
    tasks: [
      {
        uuid: "task-1",
        uiMessages: [],
        history:
          "<environment_details>\n<model>claude-3-5-sonnet-20241022</model>\n</environment_details>" +
          "\n[user]: hi\n" +
          "<environment_details>\n<model>claude-3-7-sonnet-20250219</model>\n</environment_details>",
      },
    ],
  });
  const files = resolveRoocodeTaskFiles(fakeEnv(root));
  const model = readRoocodeTaskModel(files[0].filePath);
  assert.equal(model, "claude-3-7-sonnet-20250219");
  fs.rmSync(root, { recursive: true, force: true });
});

test("readRoocodeTaskModel returns null when sibling missing or no tag", () => {
  const root = setupFixture({
    tasks: [
      { uuid: "task-empty", uiMessages: [] }, // no history file
      { uuid: "task-no-tag", uiMessages: [], history: "no env block at all" },
    ],
  });
  const files = resolveRoocodeTaskFiles(fakeEnv(root)).sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );
  assert.equal(readRoocodeTaskModel(files[0].filePath), null);
  assert.equal(readRoocodeTaskModel(files[1].filePath), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("normalizeRoocodeModel falls back: explicit > protocol > unknown", () => {
  assert.equal(
    normalizeRoocodeModel({ explicitModel: "claude-3-7-sonnet", apiProtocol: "anthropic" }),
    "claude-3-7-sonnet",
  );
  assert.equal(
    normalizeRoocodeModel({ explicitModel: null, apiProtocol: "anthropic" }),
    "protocol:anthropic",
  );
  assert.equal(
    normalizeRoocodeModel({ explicitModel: "", apiProtocol: "" }),
    "unknown",
  );
  assert.equal(
    normalizeRoocodeModel({ explicitModel: null, apiProtocol: null }),
    "unknown",
  );
});

test("parseRoocodeIncremental aggregates tokens and dedupes across re-runs", async () => {
  const ts1 = Date.UTC(2026, 4, 21, 14, 0, 0); // 2026-05-21T14:00:00Z (bucket A)
  const ts2 = Date.UTC(2026, 4, 21, 14, 35, 0); // bucket B (different half-hour)
  const root = setupFixture({
    tasks: [
      {
        uuid: "task-alpha",
        history:
          "<environment_details>\n<model>claude-3-7-sonnet-20250219</model>\n</environment_details>",
        uiMessages: [
          {
            type: "say",
            say: "api_req_started",
            ts: ts1,
            text: JSON.stringify({
              tokensIn: 1000,
              tokensOut: 250,
              cacheReads: 500,
              cacheWrites: 50,
              apiProtocol: "anthropic",
              cost: 0.012,
            }),
          },
          // zero-token entry must be marked seen but not aggregated
          {
            type: "say",
            say: "api_req_started",
            ts: ts1 + 1,
            text: JSON.stringify({ tokensIn: 0, tokensOut: 0, cacheReads: 0, cacheWrites: 0 }),
          },
          {
            type: "say",
            say: "api_req_deleted", // user-removed turn — still bills
            ts: ts2,
            text: JSON.stringify({
              tokensIn: 800,
              tokensOut: 100,
              cacheReads: 0,
              cacheWrites: 0,
              apiProtocol: "anthropic",
            }),
          },
        ],
      },
    ],
  });

  const queuePath = path.join(root, "queue.jsonl");
  const cursors = {};

  // ── First run: should aggregate two non-zero entries into two buckets ──
  const res1 = await parseRoocodeIncremental({
    taskFiles: resolveRoocodeTaskFiles(fakeEnv(root)),
    cursors,
    queuePath,
  });
  assert.equal(res1.recordsProcessed, 3, "all 3 records iterated");
  assert.equal(res1.eventsAggregated, 2, "two non-zero events aggregated");
  assert.ok(res1.bucketsQueued > 0);
  assert.ok(fs.existsSync(queuePath));

  const queueLines = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean);
  const rows = queueLines.map((l) => JSON.parse(l));
  const roocodeRows = rows.filter((r) => r.source === "roocode");
  assert.ok(roocodeRows.length >= 2, "queue contains roocode rows");
  for (const row of roocodeRows) {
    assert.equal(row.model, "claude-3-7-sonnet-20250219");
    assert.ok(row.input_tokens >= 0 && row.output_tokens >= 0);
    assert.equal(
      row.total_tokens,
      row.input_tokens + row.output_tokens + row.cache_creation_input_tokens + row.cached_input_tokens,
    );
  }

  // ── Second run (idempotency under stress) ──
  // Mtime-cached skip kicks in: file size + mtime unchanged → entire file
  // is skipped, so recordsProcessed == 0. Dedup via seenIds is the backup
  // path if the file later changes but the same entries reappear.
  const res2 = await parseRoocodeIncremental({
    taskFiles: resolveRoocodeTaskFiles(fakeEnv(root)),
    cursors,
    queuePath,
  });
  assert.equal(res2.eventsAggregated, 0, "second run aggregates nothing (idempotent)");
  // No new queue rows after second run
  const queueLines2 = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(queueLines2.length, queueLines.length, "queue size stable after re-run");

  fs.rmSync(root, { recursive: true, force: true });
});

test("parseRoocodeIncremental counts tokens back-filled into an api_req_started placeholder (in-flight race)", async () => {
  // Cline-family extensions write `api_req_started` with zero tokens at
  // request START, then rewrite the SAME message (same ts) with real token
  // counts on completion. A sync racing the in-flight request used to mark
  // the zero placeholder as seen, permanently dropping the back-filled
  // tokens.
  const ts = Date.UTC(2026, 4, 21, 14, 0, 0);
  const placeholder = {
    type: "say",
    say: "api_req_started",
    ts,
    text: JSON.stringify({ request: "..." }), // no token fields yet
  };
  const root = setupFixture({
    tasks: [
      {
        uuid: "task-backfill",
        history:
          "<environment_details>\n<model>claude-3-7-sonnet-20250219</model>\n</environment_details>",
        uiMessages: [placeholder],
      },
    ],
  });
  const queuePath = path.join(root, "queue.jsonl");
  const cursors = {};

  // Run 1: sync hits the in-flight placeholder — nothing aggregated.
  const res1 = await parseRoocodeIncremental({
    taskFiles: resolveRoocodeTaskFiles(fakeEnv(root)),
    cursors,
    queuePath,
  });
  assert.equal(res1.eventsAggregated, 0, "placeholder must not be aggregated");

  // The request completes: Roo rewrites the SAME message in place.
  const backfilled = {
    ...placeholder,
    text: JSON.stringify({
      tokensIn: 1200,
      tokensOut: 300,
      cacheReads: 0,
      cacheWrites: 0,
      apiProtocol: "anthropic",
    }),
  };
  const uiPath = path.join(
    root,
    "User",
    "globalStorage",
    "rooveterinaryinc.roo-cline",
    "tasks",
    "task-backfill",
    "ui_messages.json",
  );
  fs.writeFileSync(uiPath, JSON.stringify([backfilled]));

  // Run 2: the back-filled tokens must be counted.
  const res2 = await parseRoocodeIncremental({
    taskFiles: resolveRoocodeTaskFiles(fakeEnv(root)),
    cursors,
    queuePath,
  });
  assert.equal(res2.eventsAggregated, 1, "back-filled tokens must be counted");
  const rows = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.source === "roocode");
  const last = rows[rows.length - 1];
  assert.equal(last.input_tokens, 1200);
  assert.equal(last.output_tokens, 300);

  // Run 3: unchanged file — still idempotent.
  const res3 = await parseRoocodeIncremental({
    taskFiles: resolveRoocodeTaskFiles(fakeEnv(root)),
    cursors,
    queuePath,
  });
  assert.equal(res3.eventsAggregated, 0, "no double count after back-fill");

  fs.rmSync(root, { recursive: true, force: true });
});

test("parseRoocodeIncremental falls back to protocol:<apiProtocol> when history missing", async () => {
  const ts = Date.UTC(2026, 4, 21, 15, 0, 0);
  const root = setupFixture({
    tasks: [
      {
        uuid: "task-no-history",
        // no history file → readRoocodeTaskModel returns null
        uiMessages: [
          {
            type: "say",
            say: "api_req_started",
            ts,
            text: JSON.stringify({
              tokensIn: 100,
              tokensOut: 20,
              cacheReads: 0,
              cacheWrites: 0,
              apiProtocol: "openai",
            }),
          },
        ],
      },
    ],
  });

  const queuePath = path.join(root, "queue.jsonl");
  const cursors = {};
  await parseRoocodeIncremental({
    taskFiles: resolveRoocodeTaskFiles(fakeEnv(root)),
    cursors,
    queuePath,
  });

  const rows = fs
    .readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.source === "roocode");
  assert.ok(rows.length > 0);
  assert.equal(rows[0].model, "protocol:openai");

  fs.rmSync(root, { recursive: true, force: true });
});

test("parseRoocodeIncremental rejects malformed JSON gracefully (no throw)", async () => {
  const root = setupFixture({
    tasks: [
      {
        uuid: "broken-task",
        uiMessages: [
          {
            type: "say",
            say: "api_req_started",
            ts: Date.now(),
            text: "not-json{",
          },
        ],
      },
    ],
  });
  const queuePath = path.join(root, "queue.jsonl");
  const res = await parseRoocodeIncremental({
    taskFiles: resolveRoocodeTaskFiles(fakeEnv(root)),
    cursors: {},
    queuePath,
  });
  assert.equal(res.eventsAggregated, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
