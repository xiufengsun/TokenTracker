"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeQoderTokens,
  parseQoderDbIncremental,
  resolveQoderDbPath,
  resolveQoderDbPaths,
  resolveQoderCnDbPaths,
} = require("../src/lib/rollout");

function tempQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-qoder-"));
  return {
    dir,
    queuePath: path.join(dir, "queue.jsonl"),
  };
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("normalizeQoderTokens separates cached input without double-counting", () => {
  assert.deepEqual(
    normalizeQoderTokens(JSON.stringify({
      prompt_tokens: 58_299,
      cached_tokens: 57_853,
      completion_tokens: 2_812,
      max_input_tokens: 200_000,
    })),
    {
      input_tokens: 446,
      cached_input_tokens: 57_853,
      cache_creation_input_tokens: 0,
      output_tokens: 2_812,
      reasoning_output_tokens: 0,
      total_tokens: 61_111,
      billable_total_tokens: 61_111,
    },
  );
});

test("parseQoderDbIncremental aggregates assistant calls and counts one request once", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const dbMessages = [
    {
      row_id: 2,
      id: "assistant-1",
      session_id: "session-1",
      request_id: "request-1",
      gmt_create: 1_784_681_696_263,
      token_info: JSON.stringify({
        prompt_tokens: 56_880,
        cached_tokens: 0,
        completion_tokens: 773,
      }),
      model_info: JSON.stringify({ model_key: "quest-ultimate" }),
    },
    {
      row_id: 4,
      id: "assistant-2",
      session_id: "session-1",
      request_id: "request-1",
      gmt_create: 1_784_681_701_844,
      token_info: JSON.stringify({
        prompt_tokens: 57_855,
        cached_tokens: 56_878,
        completion_tokens: 186,
      }),
      model_info: "{}",
      record_extra: JSON.stringify({ modelConfig: { key: "quest-ultimate" } }),
    },
  ];

  const first = await parseQoderDbIncremental({ dbMessages, cursors, queuePath });
  assert.equal(first.messagesProcessed, 2);
  assert.equal(first.eventsAggregated, 2);
  assert.ok(first.bucketsQueued >= 1);

  const qoderRows = queueRows(queuePath).filter(
    (row) => row.source === "qoder" && row.model === "quest-ultimate",
  );
  assert.equal(qoderRows.length, 1);
  assert.deepEqual(
    {
      input: qoderRows[0].input_tokens,
      cached: qoderRows[0].cached_input_tokens,
      output: qoderRows[0].output_tokens,
      total: qoderRows[0].total_tokens,
      conversations: qoderRows[0].conversation_count,
    },
    {
      input: 56_880 + 977,
      cached: 56_878,
      output: 773 + 186,
      total: 56_880 + 773 + 57_855 + 186,
      conversations: 1,
    },
  );

  const before = fs.readFileSync(queuePath, "utf8");
  const second = await parseQoderDbIncremental({ dbMessages, cursors, queuePath });
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before);
});

test("parseQoderDbIncremental replaces a corrected message contribution", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const row = {
    row_id: 1,
    id: "assistant-1",
    session_id: "session-1",
    request_id: "request-1",
    gmt_create: 1_784_681_696_263,
    model_info: JSON.stringify({ model_key: "quest-ultimate" }),
    token_info: JSON.stringify({
      prompt_tokens: 100,
      cached_tokens: 80,
      completion_tokens: 10,
    }),
  };
  await parseQoderDbIncremental({ dbMessages: [row], cursors, queuePath });
  row.token_info = JSON.stringify({
    prompt_tokens: 90,
    cached_tokens: 70,
    completion_tokens: 5,
  });
  await parseQoderDbIncremental({ dbMessages: [row], cursors, queuePath });

  const qoderRows = queueRows(queuePath).filter(
    (item) => item.source === "qoder" && item.model === "quest-ultimate",
  );
  const latest = qoderRows.at(-1);
  assert.equal(latest.input_tokens, 20);
  assert.equal(latest.cached_input_tokens, 70);
  assert.equal(latest.output_tokens, 5);
  assert.equal(latest.total_tokens, 95);
  assert.equal(latest.conversation_count, 1);
});

test("parseQoderDbIncremental moves request ownership when an earlier assistant row appears", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const later = {
    row_id: 2,
    id: "assistant-later",
    session_id: "session-1",
    request_id: "request-1",
    gmt_create: 1_784_681_701_844,
    model_info: JSON.stringify({ model_key: "quest-ultimate" }),
    token_info: JSON.stringify({
      prompt_tokens: 90,
      cached_tokens: 70,
      completion_tokens: 5,
    }),
  };
  await parseQoderDbIncremental({ dbMessages: [later], cursors, queuePath });

  const earlier = {
    ...later,
    row_id: 1,
    id: "assistant-earlier",
    gmt_create: 1_784_681_696_263,
    token_info: JSON.stringify({
      prompt_tokens: 100,
      cached_tokens: 80,
      completion_tokens: 10,
    }),
  };
  await parseQoderDbIncremental({ dbMessages: [earlier, later], cursors, queuePath });

  const latest = queueRows(queuePath)
    .filter((item) => item.source === "qoder" && item.model === "quest-ultimate")
    .at(-1);
  assert.equal(latest.conversation_count, 1);
});

test("resolveQoderDbPath supports the macOS default and explicit override", () => {
  assert.equal(
    resolveQoderDbPath({ home: "/Users/test", env: {}, platform: "darwin" }),
    path.join("/Users/test", "Library", "Application Support", "Qoder", "SharedClientCache", "cache", "db", "local.db"),
  );
  assert.equal(
    resolveQoderDbPath({
      home: "/Users/test",
      env: { QODER_DB_PATH: "/tmp/qoder.db" },
      platform: "darwin",
    }),
    path.resolve("/tmp/qoder.db"),
  );
});

test("resolveQoderDbPaths discovers native and WSL Qoder databases on Windows", () => {
  const paths = resolveQoderDbPaths({
    home: "C:\\Users\\test",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming", TOKENTRACKER_WSL_MODE: "both" },
    platform: "win32",
    deps: {
      existsSync() {
        return true;
      },
      discoverWslHome() {
        return "\\\\wsl$\\Ubuntu\\home\\test\\.config\\Qoder";
      },
    },
  });
  assert.equal(
    paths.native,
    path.join("C:\\Users\\test\\AppData\\Roaming", "Qoder", "SharedClientCache", "cache", "db", "local.db"),
  );
  assert.equal(
    paths.wsl,
    path.join("\\\\wsl$\\Ubuntu\\home\\test\\.config\\Qoder", "SharedClientCache", "cache", "db", "local.db"),
  );
});

test("resolveQoderCnDbPaths points at the QoderCN data directory", () => {
  const paths = resolveQoderCnDbPaths({
    home: "/Users/test",
    env: {},
    platform: "darwin",
  });
  assert.equal(
    paths.native,
    path.join("/Users/test", "Library", "Application Support", "QoderCN", "SharedClientCache", "cache", "db", "local.db"),
  );
  assert.equal(paths.wsl, null);
});

test("parseQoderDbIncremental with qoder-cn source keeps a separate cursor and bucket namespace", async (t) => {
  const { dir, queuePath } = tempQueue();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cursors = {};
  const dbMessages = [
    {
      row_id: 1,
      id: "cn-assistant-1",
      session_id: "cn-session-1",
      request_id: "cn-request-1",
      gmt_create: 1_784_681_696_263,
      token_info: JSON.stringify({
        prompt_tokens: 56_880,
        cached_tokens: 0,
        completion_tokens: 773,
      }),
      model_info: JSON.stringify({ model_key: "quest-ultimate" }),
    },
  ];

  const first = await parseQoderDbIncremental({
    dbMessages,
    cursors,
    queuePath,
    sourceKey: "qoder-cn",
    cursorKey: "qoder-cn",
  });
  assert.equal(first.eventsAggregated, 1);
  assert.equal(first.bucketsQueued, 1);

  // Buckets land under the qoder-cn source, never the international one.
  const cnRows = queueRows(queuePath).filter((row) => row.source === "qoder-cn");
  assert.equal(cnRows.length, 1);
  assert.equal(cnRows[0].input_tokens, 56_880);
  assert.equal(cnRows[0].output_tokens, 773);
  assert.ok(cursors["qoder-cn"], "qoder-cn cursor namespace is populated");
  assert.equal(cursors.qoder, undefined, "international cursor stays untouched");

  // A re-run is a no-op — the incremental cursor is namespaced, not shared.
  const before = fs.readFileSync(queuePath, "utf8");
  const second = await parseQoderDbIncremental({
    dbMessages,
    cursors,
    queuePath,
    sourceKey: "qoder-cn",
    cursorKey: "qoder-cn",
  });
  assert.equal(second.eventsAggregated, 0);
  assert.equal(second.bucketsQueued, 0);
  assert.equal(fs.readFileSync(queuePath, "utf8"), before);
});

test("resolveQoderCnDbPaths ignores QODER_HOME and honors QODER_CN_HOME", () => {
  // QODER_HOME points at the international install and must never redirect the
  // CN resolver onto the same DB (that would double-count every message).
  const withoutOverride = resolveQoderCnDbPaths({
    home: "/Users/test",
    env: { QODER_HOME: "/int-home" },
    platform: "darwin",
  });
  assert.equal(
    withoutOverride.native,
    path.join("/Users/test", "Library", "Application Support", "QoderCN", "SharedClientCache", "cache", "db", "local.db"),
  );

  const withOverride = resolveQoderCnDbPaths({
    home: "/Users/test",
    env: { QODER_CN_HOME: "/cn-home" },
    platform: "darwin",
  });
  assert.equal(
    withOverride.native,
    path.resolve("/cn-home", "SharedClientCache", "cache", "db", "local.db"),
  );
});
