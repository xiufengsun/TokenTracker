/**
 * TRAE Work CN sync wiring tests.
 *
 * All synthetic: no live API, no real JWT. Exercises the non-background auto
 * sync block (rolling 30-day range, storage-backed auth, single parser call)
 * and the gating that keeps every background / all-local variant from fetching.
 * The injected fetch + fixed now come through cmdSync's narrow context seam
 * (context.traeCnFetchImpl / context.traeCnNowMs).
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { cmdSync } = require("../src/commands/sync");
const { getSourceScope } = require("../src/lib/source-metadata");

const TRAE_CN_AUTH_KEY = "iCubeAuthInfo://icube.cloudide";
const TRAE_CN_USAGE_URL = "https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session";
const NOW_MS = 1_800_000_000_000;
const ROLLING_DAYS = 30 * 24 * 60 * 60;

function tokenCountLine({ ts, totalTokens }) {
  const usage = {
    input_tokens: totalTokens,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: totalTokens,
  };
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: { last_token_usage: usage, total_token_usage: usage },
    },
  });
}

async function withTempTraeEnv(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-trae-sync-"));
  const traeCnHome = path.join(home, "trae-cn-data");
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    CODE_HOME: process.env.CODE_HOME,
    GEMINI_HOME: process.env.GEMINI_HOME,
    OPENCODE_HOME: process.env.OPENCODE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    TOKENTRACKER_REASONIX_HOME: process.env.TOKENTRACKER_REASONIX_HOME,
    REASONIX_STATE_HOME: process.env.REASONIX_STATE_HOME,
    TOKENTRACKER_DEVICE_TOKEN: process.env.TOKENTRACKER_DEVICE_TOKEN,
    TOKENTRACKER_INSFORGE_BASE_URL: process.env.TOKENTRACKER_INSFORGE_BASE_URL,
    TOKENTRACKER_OPENCLAW_HOME: process.env.TOKENTRACKER_OPENCLAW_HOME,
    TOKENTRACKER_OPENCLAW_AGENT_ID: process.env.TOKENTRACKER_OPENCLAW_AGENT_ID,
    TOKENTRACKER_OPENCLAW_PREV_SESSION_ID: process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID,
    TOKENTRACKER_OPENCLAW_SESSION_KEY: process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY,
    TOKENTRACKER_TRAE_CN_HOME: process.env.TOKENTRACKER_TRAE_CN_HOME,
    TOKENTRACKER_TRAE_HOME: process.env.TOKENTRACKER_TRAE_HOME,
    TOKENTRACKER_TRAE_DB: process.env.TOKENTRACKER_TRAE_DB,
    TOKENTRACKER_TRAE_CN_USAGE: process.env.TOKENTRACKER_TRAE_CN_USAGE,
    TOKENTRACKER_WSL_MODE: process.env.TOKENTRACKER_WSL_MODE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = path.join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    process.env.CODEX_HOME = path.join(home, ".codex");
    process.env.CODE_HOME = path.join(home, ".code");
    process.env.GEMINI_HOME = path.join(home, ".gemini");
    process.env.OPENCODE_HOME = path.join(home, ".opencode");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.TOKENTRACKER_OPENCLAW_HOME = path.join(home, ".openclaw");
    process.env.TOKENTRACKER_TRAE_CN_HOME = traeCnHome;
    process.env.TOKENTRACKER_TRAE_HOME = path.join(home, "trae-data");
    delete process.env.TOKENTRACKER_TRAE_DB;
    process.env.TOKENTRACKER_TRAE_CN_USAGE = "1";
    delete process.env.TOKENTRACKER_REASONIX_HOME;
    delete process.env.REASONIX_STATE_HOME;
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    delete process.env.TOKENTRACKER_OPENCLAW_AGENT_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_PREV_SESSION_ID;
    delete process.env.TOKENTRACKER_OPENCLAW_SESSION_KEY;
    delete process.env.TOKENTRACKER_WSL_MODE;
    fs.mkdirSync(path.join(traeCnHome, "User", "globalStorage"), { recursive: true });
    return await fn({ home, traeCnHome });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeTraeCnStorage(traeCnHome, auth = { token: "fake-jwt-token", refreshToken: "synthetic" }) {
  fs.writeFileSync(
    path.join(traeCnHome, "User", "globalStorage", "storage.json"),
    JSON.stringify({ [TRAE_CN_AUTH_KEY]: auth }),
  );
}

function readSessionStateRows(home) {
  return readQueueRows(home).filter((row) => row.kind === "account_session_state");
}

function readQueueRows(home) {
  const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
  if (!fs.existsSync(queuePath)) return [];
  return fs.readFileSync(queuePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readCursors(home) {
  const cursorsPath = path.join(home, ".tokentracker", "tracker", "cursors.json");
  if (!fs.existsSync(cursorsPath)) return {};
  return JSON.parse(fs.readFileSync(cursorsPath, "utf8"));
}

function traeFetchOnce(body, requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    return { status: 200, ok: true, json: async () => body };
  };
}

function halfHourBucket(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const half = d.getUTCMinutes() >= 30 ? 30 : 0;
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), half, 0, 0),
  ).toISOString();
}

function sampleSession(usageTime) {
  return {
    session_id: "s1",
    model_name: "doubao-pro",
    usage_time: usageTime,
    input_token: 100,
    output_token: 10,
    cache_read_token: 0,
    cache_write_token: 0,
  };
}

test("non-background auto trae-cn sync fetches the exact rolling range and queues the row", async () => {
  await withTempTraeEnv(async ({ home, traeCnHome }) => {
    writeTraeCnStorage(traeCnHome);
    const endTime = Math.floor(NOW_MS / 1000);
    const startTime = Math.max(1, endTime - ROLLING_DAYS);
    const usageTime = startTime + 3600;
    const requests = [];
    const fetchImpl = traeFetchOnce(
      { user_usage_group_by_sessions: [sampleSession(usageTime)], total: 1 },
      requests,
    );

    await cmdSync(["--auto", "--source=trae-cn"], { traeCnFetchImpl: fetchImpl, traeCnNowMs: NOW_MS });

    assert.equal(requests.length, 1, "single page fetch");
    assert.equal(requests[0].url, TRAE_CN_USAGE_URL);
    assert.equal(requests[0].options.method, "POST");
    assert.equal(requests[0].options.headers["Content-Type"], "application/json");
    assert.equal(requests[0].options.headers.Authorization, "Cloud-IDE-JWT fake-jwt-token");
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.usage_type, [7]);
    assert.equal(body.start_time, startTime);
    assert.equal(body.end_time, endTime);
    assert.equal(body.page_num, 1);
    assert.equal(body.page_size, 20);

    const traeRows = readQueueRows(home).filter(
      (row) => row.source === "trae-cn" && !row.kind,
    );
    assert.equal(traeRows.length, 1);
    assert.equal(traeRows[0].model, "doubao-pro");
    assert.equal(traeRows[0].input_tokens, 100);
    assert.equal(traeRows[0].output_tokens, 10);
    assert.equal(traeRows[0].total_tokens, 110);
    assert.equal(traeRows[0].conversation_count, 1);
    assert.equal(traeRows[0].hour_start, halfHourBucket(usageTime));

    // The sync appends exactly one canonical session-state observation
    // after the bucket row (queue order: a device's rows land before the
    // states describing them).
    const queueLines = fs
      .readFileSync(path.join(home, ".tokentracker", "tracker", "queue.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(queueLines.length, 2, "bucket row then session state");
    const states = readSessionStateRows(home);
    assert.equal(states.length, 1);
    assert.equal(states[0].source, "trae-cn");
    assert.equal(states[0].session_id, "s1");
    assert.equal(states[0].model, "doubao-pro");
    assert.equal(states[0].bucket_start, halfHourBucket(usageTime));
    assert.equal(states[0].total_tokens, 110);
    assert.equal(
      Date.parse(states[0].snapshot_verified_at),
      NOW_MS,
      "logical fetch stamp is the fixed sync clock, not the enqueue moment",
    );

    const cursors = readCursors(home);
    assert.equal(cursors.traeCn.version, 1);
    assert.equal(cursors.traeCn.sessions["s1"].totals.input_tokens, 100);
    assert.equal(cursors.traeCn.sessions["s1"].bucketStart, halfHourBucket(usageTime));
    assert.equal(getSourceScope("trae-cn"), "account", "source-scope account");
  });
});

test("repeated fixed-now sync is idempotent (no token growth / no new queue row)", async () => {
  await withTempTraeEnv(async ({ home, traeCnHome }) => {
    writeTraeCnStorage(traeCnHome);
    const endTime = Math.floor(NOW_MS / 1000);
    const fetchImpl = traeFetchOnce({
      user_usage_group_by_sessions: [sampleSession(endTime - 86400)],
      total: 1,
    });
    await cmdSync(["--auto", "--source=trae-cn"], { traeCnFetchImpl: fetchImpl, traeCnNowMs: NOW_MS });

    const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
    const before = fs.readFileSync(queuePath, "utf8");
    await cmdSync(["--auto", "--source=trae-cn"], { traeCnFetchImpl: fetchImpl, traeCnNowMs: NOW_MS });
    assert.equal(fs.readFileSync(queuePath, "utf8"), before, "queue unchanged on repeat");

    const traeRows = readQueueRows(home).filter(
      (row) => row.source === "trae-cn" && !row.kind,
    );
    assert.equal(traeRows.length, 1);
    assert.equal(traeRows[0].total_tokens, 110);
    // The repeat re-appends nothing: unchanged sessions emit no session
    // state observation, so the queue stays byte-identical.
    assert.equal(readSessionStateRows(home).length, 1);
  });
});

test("background and all-local syncs never call the TRAE CN fetch", async () => {
  await withTempTraeEnv(async ({ home, traeCnHome }) => {
    writeTraeCnStorage(traeCnHome);
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    };
    const opts = { traeCnFetchImpl: fetchImpl, traeCnNowMs: NOW_MS };

    await cmdSync(["--auto", "--background"], opts);
    assert.equal(fetchCalls, 0);
    await cmdSync(["--auto", "--background", "--all-local-sources"], opts);
    assert.equal(fetchCalls, 0);
    await cmdSync(["--auto", "--background", "--source=trae-cn"], opts);
    assert.equal(fetchCalls, 0);

    assert.equal(
      readQueueRows(home).some((row) => row.source === "trae-cn"),
      false,
    );
  });
});

test("TRAE CN usage read stays off unless TOKENTRACKER_TRAE_CN_USAGE opts in", async () => {
  await withTempTraeEnv(async ({ home }) => {
    writeTraeCnStorage(path.join(home, "trae-cn-data"));
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    };

    const savedFlag = process.env.TOKENTRACKER_TRAE_CN_USAGE;
    delete process.env.TOKENTRACKER_TRAE_CN_USAGE;
    try {
      await cmdSync(["--auto", "--source=trae-cn"], {
        traeCnFetchImpl: fetchImpl,
        traeCnNowMs: NOW_MS,
      });
    } finally {
      if (savedFlag !== undefined) process.env.TOKENTRACKER_TRAE_CN_USAGE = savedFlag;
    }

    assert.equal(fetchCalls, 0, "no request without the opt-in flag");
    assert.equal(readQueueRows(home).some((row) => row.source === "trae-cn"), false);
    assert.equal(readCursors(home).traeCn, undefined);
  });
});

test("an absent TRAE CN storage file does not call the fetch", async () => {
  await withTempTraeEnv(async ({ home }) => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      throw new Error("should not fetch");
    };

    await cmdSync(["--auto", "--source=trae-cn"], {
      traeCnFetchImpl: fetchImpl,
      traeCnNowMs: NOW_MS,
    });

    assert.equal(fetchCalls, 0);
    assert.equal(readQueueRows(home).some((row) => row.source === "trae-cn"), false);
    assert.equal(readCursors(home).traeCn, undefined);
  });
});

test("perpetually over-capacity TRAE CN fetch (split depth exhausted) preserves the prior queue and cursor bytes", async () => {
  await withTempTraeEnv(async ({ home, traeCnHome }) => {
    writeTraeCnStorage(traeCnHome);
    const initialFetch = traeFetchOnce({
      user_usage_group_by_sessions: [sampleSession(Math.floor(NOW_MS / 1000) - 86400)],
      total: 1,
    });
    await cmdSync(["--auto", "--source=trae-cn"], {
      traeCnFetchImpl: initialFetch,
      traeCnNowMs: NOW_MS,
    });

    const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
    const cursorsPath = path.join(home, ".tokentracker", "tracker", "cursors.json");
    const queueBefore = fs.readFileSync(queuePath, "utf8");
    const traeCursorBefore = JSON.stringify(JSON.parse(fs.readFileSync(cursorsPath, "utf8")).traeCn);
    const overCapacityRequests = [];
    const overCapacityFetch = traeFetchOnce(
      {
        user_usage_group_by_sessions: [sampleSession(Math.floor(NOW_MS / 1000) - 86400)],
        total: 2001,
      },
      overCapacityRequests,
    );

    await cmdSync(["--auto", "--source=trae-cn"], {
      traeCnFetchImpl: overCapacityFetch,
      traeCnNowMs: NOW_MS,
    });

    // Every window (down to the split-depth ceiling) declares 2001 rows, so
    // the fetch fails closed after probing the bounded split tree.
    assert.ok(overCapacityRequests.length > 1, "window splitting was attempted");
    assert.ok(overCapacityRequests.length <= 511, "probe count stays within the depth ceiling");
    assert.equal(fs.readFileSync(queuePath, "utf8"), queueBefore, "prior queue remains byte-identical");
    const traeCursorAfter = JSON.stringify(JSON.parse(fs.readFileSync(cursorsPath, "utf8")).traeCn);
    assert.equal(traeCursorAfter, traeCursorBefore, "prior TRAE cursor remains byte-identical");
  });
});

test("over-capacity TRAE CN window is split and the staggered halves import atomically", async () => {
  await withTempTraeEnv(async ({ home, traeCnHome }) => {
    writeTraeCnStorage(traeCnHome);
    const endTime = Math.floor(NOW_MS / 1000);
    const startTime = Math.max(1, endTime - ROLLING_DAYS);
    const mid = startTime + Math.floor((endTime - startTime) / 2);
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      const body = JSON.parse(options.body);
      const overCapacity = body.start_time === startTime && body.end_time === endTime;
      if (overCapacity) {
        return { status: 200, ok: true, json: async () => ({ user_usage_group_by_sessions: [], total: 2001 }) };
      }
      const side = body.start_time === startTime ? "left" : "right";
      return {
        status: 200,
        ok: true,
        json: async () => ({
          user_usage_group_by_sessions: [
            {
              ...sampleSession(body.end_time),
              session_id: `split-${side}`,
            },
          ],
          total: 1,
        }),
      };
    };

    await cmdSync(["--auto", "--source=trae-cn"], { traeCnFetchImpl: fetchImpl, traeCnNowMs: NOW_MS });

    // Full window probes once, then the two staggered halves each paginate.
    assert.deepEqual(
      requests.map(({ options }) => {
        const body = JSON.parse(options.body);
        return [body.start_time, body.end_time];
      }),
      [[startTime, endTime], [startTime, mid], [mid + 1, endTime]],
    );
    const traeRows = readQueueRows(home).filter(
      (row) => row.source === "trae-cn" && !row.kind,
    );
    assert.equal(traeRows.length, 2, "both halves queue their row");
    const cursorSessions = readCursors(home).traeCn.sessions;
    assert.deepEqual(Object.keys(cursorSessions).sort(), ["split-left", "split-right"]);
    // Both halves emit their canonical session observations (one per
    // session), all stamped with the SAME logical fetch clock.
    const states = readSessionStateRows(home);
    assert.deepEqual(
      states.map((r) => r.session_id).sort(),
      ["split-left", "split-right"],
    );
    for (const state of states) {
      assert.equal(Date.parse(state.snapshot_verified_at), NOW_MS);
    }
  });
});

test("failed TRAE CN fetch skips parser/queue/cursor mutation while other providers continue", async () => {
  await withTempTraeEnv(async ({ home, traeCnHome }) => {
    writeTraeCnStorage(traeCnHome);
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    const opts = { traeCnFetchImpl: fetchImpl, traeCnNowMs: NOW_MS };

    // Scoped run: failing fetch must not create trae-cn queue rows or cursor state.
    await cmdSync(["--auto", "--source=trae-cn"], opts);
    assert.equal(readQueueRows(home).filter((row) => row.source === "trae-cn").length, 0);
    assert.equal(readCursors(home).traeCn, undefined);

    // Full run: an unrelated local provider still parses while trae-cn is skipped.
    const codexHome = process.env.CODEX_HOME;
    fs.mkdirSync(path.join(codexHome, "sessions", "2026", "06", "30"), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "sessions", "2026", "06", "30", "rollout-2026-06-30T00-00-00-aaaa-ffff.jsonl"),
      tokenCountLine({ ts: "2026-06-30T00:00:00.000Z", totalTokens: 31 }) + "\n",
      "utf8",
    );
    await cmdSync(["--auto"], opts);
    const rows = readQueueRows(home);
    assert.ok(rows.some((row) => row.source === "codex"), "unrelated provider continued");
    assert.ok(!rows.some((row) => row.source === "trae-cn"), "no trae-cn rows after failure");
    assert.equal(readCursors(home).traeCn, undefined);
  });
});
