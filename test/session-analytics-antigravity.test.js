"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runSql } = require("./helpers/sqlite-write");
const { buildSessionAnalytics, discoverSessionFiles, listSessionsForBrowser, resolveSessionSidecarPath, summarizeSessions, sessionsToCsv, resumeCommandFor } = require("../src/lib/session-analytics");
const { parseAntigravityIncremental, listAntigravityTranscripts, extractAntigravityGenInfo } = require("../src/lib/rollout");
const { readAntigravitySessions } = require("../src/lib/antigravity-session");

const ID = "12345678-1234-4234-8234-123456789abc";
const AT = "2026-11-13T08:00:00Z";
const SECRET = "private prompt and tool arguments must never survive";
function vi(n) {
  let value = BigInt(n), bytes = [];
  do { let byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function number(n, value) { return Buffer.concat([vi(n * 8), vi(value)]); }
function bytes(n, value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([vi(n * 8 + 2), vi(b.length), b]);
}
const stamp = () => number(1, Date.parse(AT) / 1000);
// ModelUsageStats wire contract: model=1, input=2, output=3,
// cache-write=4, cache-read=5, thinking=9, response=10, response-id=11.
function generation(input = 100, response = "response-a") {
  return bytes(1, Buffer.concat([
    bytes(19, "claude-opus-4-6"),
    bytes(4, Buffer.concat([number(1, 1026), number(2, input), number(3, 30), number(4, 5),
      number(5, 200), number(9, 10), number(10, 20), bytes(11, response)])),
    bytes(9, bytes(4, stamp())),
    bytes(20, Buffer.concat([bytes(1, "last_step_index"), bytes(2, "0")])),
  ]));
}
function fixture(t, { variant = "antigravity-cli", transcript = false, empty = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-antigravity-session-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".gemini", variant);
  const db = path.join(root, "conversations", ID + ".db");
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const metadata = Buffer.concat([bytes(1, bytes(1, "file:///repo/antigravity")), bytes(2, stamp())]);
  runSql(db, `CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
    CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB);
    INSERT INTO trajectory_metadata_blob VALUES ('metadata', X'${metadata.toString("hex")}');`);
  if (!empty) runSql(db, `INSERT INTO gen_metadata VALUES (0, X'${generation().toString("hex")}')`);
  let file = db;
  if (transcript) {
    file = path.join(root, "brain", ID, ".system_generated", "logs", "transcript.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      { type: "USER_INPUT", step_index: 0, created_at: AT, content: SECRET },
      { type: "PLANNER_RESPONSE", step_index: 1, created_at: AT, content: SECRET, thinking: SECRET, tool_calls: [{ name: "edit", arguments: SECRET }] },
    ].map(JSON.stringify).join("\n") + "\n");
  }
  return { home, root, db, file };
}
async function hourly(home, files, cursors = {}) {
  const queuePath = path.join(home, "usage.jsonl");
  const result = await parseAntigravityIncremental({ sessionFiles: files, cursors, queuePath, source: "antigravity" });
  const latest = new Map(fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const row = JSON.parse(l); return [row.source + "|" + row.model + "|" + row.hour_start, row];
  }));
  return { result, rows: [...latest.values()], queuePath };
}

test("native wire counters exclude the model enum and preserve the output split and cache writes", () => {
  const info = extractAntigravityGenInfo(generation());
  assert.equal(info.uncachedInput, 100);
  assert.equal(info.textOutput, 20);
  assert.equal(info.reasoningOutput, 10);
  assert.equal(info.cacheWrite, 5);
  assert.equal(info.responseId, "response-a");
});

for (const transcript of [false, true]) {
  test(`Antigravity ${transcript ? "transcript + db" : "db-only CLI"} has matching Usage and Sessions totals and safe resume`, async (t) => {
    const { home, file } = fixture(t, { transcript });
    const discovery = await discoverSessionFiles(home, { HOME: home }, { probeWsl: false });
    assert.deepEqual(discovery.antigravity, [file]);
    const cursors = {};
    const usage = await hourly(home, [file], cursors);
    assert.equal(usage.rows.reduce((sum, r) => sum + r.total_tokens, 0), 335);
    const rows = await buildSessionAnalytics({ home, force: true });
    const row = rows.find((r) => r.source === "antigravity");
    assert.equal(row.tokens.input_tokens, 100);
    assert.equal(row.tokens.reasoning_output_tokens, 10);
    assert.equal(row.tokens.output_tokens, 20);
    assert.equal(row.tokens.cache_creation_input_tokens, 5);
    assert.equal(row.total_tokens, 335);
    assert.equal(row.usage_precision, "reported");
    const browser = listSessionsForBrowser(rows).sessions.find((r) => r.source === "antigravity");
    assert.equal(browser.resume_command, `agy --conversation ${ID}`);
    assert.equal(browser.model_usage[0].model, "claude-opus-4-6");
    assert.equal(browser.usage_buckets[0].total_tokens, 335);
    assert.equal(JSON.stringify(rows).includes(SECRET), false);
    assert.equal(JSON.stringify(browser).includes(SECRET), false);
    const exported = JSON.stringify(summarizeSessions(rows)) + sessionsToCsv(rows);
    assert.equal(exported.includes(ID), false);
    assert.equal(exported.includes("/repo/antigravity"), false);
    const before = fs.readFileSync(usage.queuePath, "utf8");
    await hourly(home, [file], cursors);
    assert.equal(fs.readFileSync(usage.queuePath, "utf8"), before);
    const refreshed = await buildSessionAnalytics({ home, recheck: true });
    assert.equal(refreshed.filter((r) => r.source === "antigravity").length, 1);
    assert.equal(refreshed.find((r) => r.source === "antigravity").total_tokens, 335);
  });
}

test("discovery counts transcript and database once; desktop rows do not promise CLI resume", async (t) => {
  const { home, file } = fixture(t, { variant: "antigravity", transcript: true });
  assert.deepEqual(await listAntigravityTranscripts(path.join(home, ".gemini")), [file]);
  const rows = await buildSessionAnalytics({ home, force: true });
  assert.equal(listSessionsForBrowser(rows).sessions[0].resume_command, null);
  assert.equal(resumeCommandFor("antigravity", "bad;id", "antigravity-cli"), null);
  assert.equal((await readAntigravitySessions([file, file])).length, 1);
});

test("empty CLI conversation is visible as unavailable usage", async (t) => {
  const { home } = fixture(t, { empty: true });
  const rows = await buildSessionAnalytics({ home, force: true });
  const row = listSessionsForBrowser(rows).sessions[0];
  assert.equal(row.source, "antigravity");
  assert.equal(row.usage_precision, "unavailable");
  assert.equal(row.usage_is_incomplete, true);
  assert.equal(row.resume_command, `agy --conversation ${ID}`);
});

test("native generations with the same response id are counted once", async (t) => {
  const { home, db } = fixture(t);
  runSql(db, `INSERT INTO gen_metadata VALUES (1, X'${generation().toString("hex")}')`);
  const rows = await readAntigravitySessions([db]);
  assert.equal(rows[0].tokens.total_tokens, 335);
  assert.equal(rows[0].model_calls, 1);
  const usage = await hourly(home, [db]);
  assert.equal(usage.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
});

test("a corrupt optional CLI workspace cache does not hide valid usage", async (t) => {
  const { root, db } = fixture(t);
  runSql(db, "DELETE FROM trajectory_metadata_blob");
  fs.mkdirSync(path.join(root, "cache"), { recursive: true });
  for (const value of ["{incomplete", "null", JSON.stringify([ID]), JSON.stringify({ "relative/path": ID })]) {
    fs.writeFileSync(path.join(root, "cache", "last_conversations.json"), value);
    const [row] = await readAntigravitySessions([db]);
    assert.equal(row.tokens.total_tokens, 335);
    assert.equal(row.project_ref, null);
  }
});

test("a long transcript does not exceed the JavaScript argument limit", async (t) => {
  const { file } = fixture(t, { transcript: true });
  const record = JSON.stringify({ type: "GENERIC", created_at: AT });
  fs.appendFileSync(file, (record + "\n").repeat(150_000));
  const [row] = await readAntigravitySessions([file]);
  assert.equal(row.tokens.total_tokens, 335);
  assert.equal(row.started_at, AT.replace("Z", ".000Z"));
});

test("status detects a db-only Antigravity CLI install", (t) => {
  const { home } = fixture(t);
  const { execFileSync } = require("node:child_process");
  const result = execFileSync(process.execPath, [path.join(__dirname, "..", "bin", "tracker.js"), "status"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData"),
      GEMINI_HOME: path.join(home, ".gemini"), CODEX_HOME: path.join(home, ".codex"),
      TOKENTRACKER_WSL_MODE: "native-only" },
  });
  assert.match(result, /- Antigravity: .*found/);
});

test("WSL native reads clean up their snapshot on success and failure", async (t) => {
  const { db } = fixture(t);
  const wsl = require("../src/lib/wsl-probe");
  const { readAntigravityNativeSession } = require("../src/lib/antigravity-native");
  let cleaned = 0;
  t.mock.method(wsl, "isUncPath", () => true);
  t.mock.method(wsl, "snapshotSqliteDb", (source) => {
    assert.equal(source, db);
    return { path: db, cleanup() { cleaned++; } };
  });
  const session = await readAntigravityNativeSession(db);
  assert.equal(session.events.length, 1);
  assert.equal(cleaned, 1);
  fs.writeFileSync(db, "invalid sqlite");
  await assert.rejects(readAntigravityNativeSession(db));
  assert.equal(cleaned, 2);
});

for (const host of ["wsl$", "wsl.localhost"]) {
  test("WSL workspace URLs preserve encoded names and the " + host + " distro root", async (t) => {
    const { db } = fixture(t, { variant: "antigravity-ide" });
    const wsl = require("../src/lib/wsl-probe");
    const { readAntigravityNativeSession } = require("../src/lib/antigravity-native");
    const metadata = Buffer.concat([
      bytes(1, bytes(1, "file:///home/user/repo%20name/%E4%B8%AD%E6%96%87")), bytes(2, stamp()),
    ]);
    runSql(db, "UPDATE trajectory_metadata_blob SET data=X'" + metadata.toString("hex") + "'");
    const source = "//" + host + "/Ubuntu/home/user/.gemini/antigravity-ide/conversations/" + ID + ".db";
    t.mock.method(wsl, "snapshotSqliteDb", (original) => {
      assert.equal(original, source);
      return { path: db, cleanup() {} };
    });
    const session = await readAntigravityNativeSession(source);
    assert.equal(session.cwd, path.win32.join("//" + host + "/Ubuntu", "home", "user", "repo name", "中文"));
  });
}

test("WSL snapshots do not re-anchor a recorded Windows drive URL", async (t) => {
  const { db } = fixture(t);
  const wsl = require("../src/lib/wsl-probe");
  const { readAntigravityNativeSession } = require("../src/lib/antigravity-native");
  const metadata = Buffer.concat([bytes(1, bytes(1, "file:///C:/repo%20name")), bytes(2, stamp())]);
  runSql(db, "UPDATE trajectory_metadata_blob SET data=X'" + metadata.toString("hex") + "'");
  const source = "//wsl.localhost/Ubuntu/home/user/.gemini/antigravity-cli/conversations/" + ID + ".db";
  t.mock.method(wsl, "snapshotSqliteDb", () => ({ path: db, cleanup() {} }));
  const session = await readAntigravityNativeSession(source);
  assert.equal(session.cwd, process.platform === "win32" ? path.win32.join("C:/", "repo name") : "/C:/repo name");
});

test("a partial transcript tail keeps the readable batch and is picked up when completed", async (t) => {
  const { home, file, db } = fixture(t, { transcript: true });
  const controlDb = path.join(home, ".gemini", "antigravity", "conversations", "control-session.db");
  fs.mkdirSync(path.dirname(controlDb), { recursive: true });
  fs.copyFileSync(db, controlDb);
  runSql(controlDb, "UPDATE gen_metadata SET data=X'" + generation(50, "response-control").toString("hex") + "'");
  const nextAt = "2026-11-13T08:01:00Z";
  const pending = JSON.stringify({ type: "USER_INPUT", created_at: nextAt, content: SECRET });
  fs.appendFileSync(file, pending.slice(0, -1));
  const rows = await buildSessionAnalytics({ home, force: true });
  assert.equal(rows.length, 2);
  assert.equal(rows.skippedFiles, 0);
  assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 620);
  const cli = rows.find((row) => row.antigravity_variant === "antigravity-cli");
  assert.equal(cli.turns, 1);
  assert.equal(cli.ended_at, AT.replace("Z", ".000Z"));
  fs.appendFileSync(file, "}\n");
  const refreshed = await buildSessionAnalytics({ home, recheck: true });
  assert.equal(refreshed.length, 2);
  const updated = refreshed.find((row) => row.antigravity_variant === "antigravity-cli");
  assert.equal(updated.turns, 2);
  assert.equal(updated.ended_at, nextAt.replace("Z", ".000Z"));
  assert.equal(updated.total_tokens, 335);
  assert.equal(JSON.stringify(refreshed).includes(SECRET), false);
});

test("turn metadata stops at the same malformed record as the Usage parser", async (t) => {
  const { file } = fixture(t, { transcript: true });
  fs.appendFileSync(file, "{broken\n" + JSON.stringify({
    type: "USER_INPUT", created_at: "2026-11-13T08:02:00Z", content: SECRET,
  }) + "\n");
  const [row] = await readAntigravitySessions([file]);
  assert.equal(row.turns, 1);
  assert.equal(row.tokens.total_tokens, 335);
  assert.equal(row.ended_at, AT.replace("Z", ".000Z"));
});

test("the reader revision repairs cached Antigravity metadata without source file changes", async (t) => {
  const { home } = fixture(t);
  const [original] = await buildSessionAnalytics({ home, force: true });
  const sidecar = resolveSessionSidecarPath(home);
  fs.writeFileSync(sidecar, JSON.stringify({ ...original, project_ref: "/stale-workspace" }) + "\n");
  const metaPath = sidecar + ".meta.json";
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  delete meta.antigravity_session_version;
  for (const entry of Object.values(meta.files)) entry.stat_key = entry.stat_key.replace(/^v1:/, "");
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const [refreshed] = await buildSessionAnalytics({ home });
  assert.equal(refreshed.project_ref, original.project_ref);
  assert.equal(refreshed.total_tokens, 335);
});

test("switching between db-only and transcript-backed discovery never bills a cascade twice", async (t) => {
  const { home, root, db } = fixture(t);
  const cursors = {};
  await hourly(home, [db], cursors);
  const transcript = path.join(root, "brain", ID, ".system_generated", "logs", "transcript.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 1, created_at: AT, content: SECRET }) + "\n");
  const files = await listAntigravityTranscripts(path.join(home, ".gemini"));
  assert.deepEqual(files, [transcript]);
  const switched = await hourly(home, files, cursors);
  assert.equal(switched.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
  fs.unlinkSync(transcript);
  const fallback = await hourly(home, await listAntigravityTranscripts(path.join(home, ".gemini")), cursors);
  assert.equal(fallback.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
  assert.deepEqual(Object.keys(cursors.files), [db]);
});

test("an empty transcript keeps sibling database usage instead of zeroing the ledger", async (t) => {
  const { home, root, db } = fixture(t);
  const cursors = {};
  await hourly(home, [db], cursors);
  const transcript = path.join(root, "brain", ID, ".system_generated", "logs", "transcript.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  const files = await listAntigravityTranscripts(path.join(home, ".gemini"));
  assert.deepEqual(files, [transcript]);
  const switched = await hourly(home, files, cursors);
  assert.equal(switched.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
  const [session] = await readAntigravitySessions([transcript]);
  assert.equal(session.tokens.total_tokens, 335);
  assert.equal(session.usage_precision, "reported");
  assert.equal(JSON.stringify(switched.rows).includes(SECRET), false);
});

function shiftStep(blob, step) {
  const marker = Buffer.from(bytes(20, Buffer.concat([
    bytes(1, "last_step_index"), bytes(2, "0"),
  ]))).toString("hex");
  return blob.toString("hex").replace(marker, Buffer.from(bytes(20, Buffer.concat([
    bytes(1, "last_step_index"), bytes(2, String(step)),
  ]))).toString("hex"));
}

test("a transcript bills uncovered sibling generations once and does not rebill covered steps", async (t) => {
  const { home, db, file } = fixture(t, { transcript: true });
  const covered = generation();
  const uncovered = generation(40, "response-b");
  const shifted = shiftStep(uncovered, 4);
  runSql(db, "DELETE FROM gen_metadata; INSERT INTO gen_metadata VALUES (0, X'" + covered.toString("hex")
    + "'), (1, X'" + shifted + "')");
  const cursors = {};
  const usage = await hourly(home, [file], cursors);
  assert.equal(usage.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335 + 275);
  const saved = fs.readFileSync(usage.queuePath, "utf8");
  await hourly(home, [file], cursors);
  assert.equal(fs.readFileSync(usage.queuePath, "utf8"), saved);
  const [session] = await readAntigravitySessions([file]);
  assert.equal(session.tokens.total_tokens, 335 + 275);
  assert.equal(session.model_calls, 2);
  assert.equal(session.usage_precision, "reported");
  assert.equal(JSON.stringify(session).includes(SECRET), false);
});

test("a malformed record stops coverage at the cursor instead of hiding later native usage", async (t) => {
  const { home, db, file } = fixture(t, { transcript: true });
  runSql(db, "DELETE FROM gen_metadata; INSERT INTO gen_metadata VALUES (0, X'" + generation().toString("hex")
    + "'), (1, X'" + shiftStep(generation(40, "response-b"), 4) + "')");
  fs.appendFileSync(file, "{broken\n" + JSON.stringify({
    type: "PLANNER_RESPONSE", step_index: 5, created_at: AT, content: SECRET,
  }) + "\n");
  const cursors = {};
  const usage = await hourly(home, [file], cursors);
  assert.equal(usage.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335 + 275);
  const [session] = await readAntigravitySessions([file]);
  assert.equal(session.tokens.total_tokens, 335 + 275);
  assert.equal(session.turns, 1);
});

test("appending a planner response retracts the usage previously supplemented for that step", async (t) => {
  const { home, db, file } = fixture(t, { transcript: true });
  runSql(db, "DELETE FROM gen_metadata; INSERT INTO gen_metadata VALUES (0, X'" + generation().toString("hex")
    + "'), (1, X'" + shiftStep(generation(40, "response-b"), 4) + "')");
  const cursors = {};
  const first = await hourly(home, [file], cursors);
  assert.equal(first.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335 + 275);
  const before = fs.statSync(db).mtimeMs;
  fs.appendFileSync(file, JSON.stringify({
    type: "PLANNER_RESPONSE", step_index: 5, created_at: AT, content: SECRET,
  }) + "\n");
  assert.equal(fs.statSync(db).mtimeMs, before);
  const appended = await hourly(home, [file], cursors);
  assert.equal(appended.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335 + 275);
  const saved = fs.readFileSync(first.queuePath, "utf8");
  await hourly(home, [file], cursors);
  assert.equal(fs.readFileSync(first.queuePath, "utf8"), saved);
});

test("ordinary appends preserve supplements until each planner response arrives, including after restart", async (t) => {
  const { home, db, file } = fixture(t, { transcript: true });
  runSql(db, "DELETE FROM gen_metadata; INSERT INTO gen_metadata VALUES (0, X'" + generation().toString("hex")
    + "'), (1, X'" + shiftStep(generation(40, "response-b"), 4)
    + "'), (2, X'" + shiftStep(generation(20, "response-c"), 8) + "')");
  let cursors = {};
  const expected = 335 + 275 + 255;
  const first = await hourly(home, [file], cursors);
  assert.equal(first.rows.reduce((sum, row) => sum + row.total_tokens, 0), expected);
  assert.deepEqual(cursors.files[file].supplementedSteps, [5, 9]);

  for (const step of [5, 9]) {
    fs.appendFileSync(file, JSON.stringify({ type: "USER_INPUT", step_index: step - 1, created_at: AT, content: SECRET }) + "\n");
    const ordinary = await hourly(home, [file], cursors);
    assert.equal(ordinary.rows.reduce((sum, row) => sum + row.total_tokens, 0), expected);
    assert.deepEqual(cursors.files[file].supplementedSteps, step === 5 ? [5, 9] : [9]);
    // The next CLI invocation reloads only the persisted cursor, not parser state.
    cursors = JSON.parse(JSON.stringify(cursors));
    fs.appendFileSync(file, JSON.stringify({ type: "PLANNER_RESPONSE", step_index: step, created_at: AT, content: SECRET }) + "\n");
    const covered = await hourly(home, [file], cursors);
    assert.equal(covered.rows.reduce((sum, row) => sum + row.total_tokens, 0), expected);
    assert.deepEqual(cursors.files[file].supplementedSteps, step === 5 ? [9] : undefined);
  }
  const saved = fs.readFileSync(first.queuePath, "utf8");
  await hourly(home, [file], cursors);
  assert.equal(fs.readFileSync(first.queuePath, "utf8"), saved);
  const [session] = await readAntigravitySessions([file]);
  assert.equal(session.tokens.total_tokens, expected);
});

for (const partial of [false, true]) {
  test("a zero-line " + (partial ? "partial" : "empty") + " transcript cursor does not supplement native usage twice", async (t) => {
    const { home, db, file } = fixture(t, { transcript: true });
    const user = JSON.stringify({ type: "USER_INPUT", step_index: 0, created_at: AT, content: SECRET });
    fs.writeFileSync(file, partial ? user.slice(0, -1) : "");
    let cursors = {};
    const first = await hourly(home, [file], cursors);
    assert.equal(first.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
    assert.equal(cursors.files[file].lastLine, 0);
    const dbMtime = fs.statSync(db).mtimeMs;

    fs.appendFileSync(file, partial ? "}\n" : user + "\n");
    const appended = await hourly(home, [file], cursors);
    assert.equal(fs.statSync(db).mtimeMs, dbMtime);
    assert.equal(appended.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
    assert.equal(appended.result.bucketsQueued, 0);
    assert.deepEqual(cursors.files[file].supplementedSteps, [1]);
    cursors = JSON.parse(JSON.stringify(cursors));
    const saved = fs.readFileSync(first.queuePath, "utf8");
    await hourly(home, [file], cursors);
    assert.equal(fs.readFileSync(first.queuePath, "utf8"), saved);

    fs.appendFileSync(file, JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 1, created_at: AT, content: SECRET }) + "\n");
    const covered = await hourly(home, [file], cursors);
    assert.equal(covered.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
    assert.equal(cursors.files[file].supplementedSteps, undefined);
    const [session] = await readAntigravitySessions([file]);
    assert.equal(session.tokens.total_tokens, 335);
  });
}

test("an empty transcript cursor retracts supplemented usage once the planner step arrives", async (t) => {
  const { home, root, db } = fixture(t);
  const transcript = path.join(root, "brain", ID, ".system_generated", "logs", "transcript.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  const cursors = {};
  const first = await hourly(home, [transcript], cursors);
  assert.equal(first.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
  assert.equal(cursors.files[transcript].size, 0);
  fs.appendFileSync(transcript, JSON.stringify({
    type: "PLANNER_RESPONSE", step_index: 1, created_at: AT, content: SECRET,
  }) + "\n");
  assert.equal(fs.statSync(db).mtimeMs, fs.statSync(db).mtimeMs);
  const appended = await hourly(home, [transcript], cursors);
  assert.equal(appended.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
});

test("a previously scanned Antigravity directory stays incomplete on a temporary ENOENT", async (t) => {
  const { home, root } = fixture(t, { transcript: true });
  const brain = path.join(root, "brain");
  const conversations = path.join(root, "conversations");
  const complete = await buildSessionAnalytics({ home, force: true });
  assert.equal(complete.find((row) => row.source === "antigravity").total_tokens, 335);
  const sidecar = resolveSessionSidecarPath(home);
  const metaPath = sidecar + ".meta.json";
  const recorded = JSON.parse(fs.readFileSync(metaPath, "utf8")).antigravity_files;
  assert.equal(recorded.some((file) => file.includes(path.join("brain", ID))), true);
  const sidecarBefore = fs.readFileSync(sidecar, "utf8");
  const metaBefore = fs.readFileSync(metaPath, "utf8");
  fs.rmSync(brain, { recursive: true, force: true });
  fs.rmSync(conversations, { recursive: true, force: true });
  const retained = await buildSessionAnalytics({ home, cacheTtlMs: 0 });
  assert.equal(retained.find((row) => row.source === "antigravity").total_tokens, 335);
  assert.equal(retained.incompleteDirs.length, 1);
  assert.equal(fs.readFileSync(sidecar, "utf8"), sidecarBefore);
  assert.equal(fs.readFileSync(metaPath, "utf8"), metaBefore);
});

test("a never-installed Antigravity variant stays an empty inventory", async (t) => {
  const { home } = fixture(t);
  const discovered = await discoverSessionFiles(home, { HOME: home }, { probeWsl: false });
  assert.equal(discovered.incomplete.length, 0);
  assert.equal(discovered.antigravity.length, 1);
});

test("a failed native read retains the last complete sidecar and retries unchanged files", async (t) => {
  const { home, db } = fixture(t);
  await buildSessionAnalytics({ home, force: true });
  const sidecar = resolveSessionSidecarPath(home);
  const original = fs.readFileSync(sidecar, "utf8");
  const dbBytes = fs.readFileSync(db);
  fs.writeFileSync(db, "not a sqlite database");
  const partial = await buildSessionAnalytics({ home, recheck: true });
  assert.equal(partial.find((r) => r.source === "antigravity").total_tokens, 335);
  assert.equal(partial.skippedFiles, 1);
  assert.equal(fs.readFileSync(sidecar, "utf8"), original);
  fs.writeFileSync(db, dbBytes);
  const recovered = await buildSessionAnalytics({ home, recheck: true });
  assert.equal(recovered.skippedFiles, 0);
  assert.equal(recovered.find((r) => r.source === "antigravity").total_tokens, 335);
});

test("extractor revision corrects old model-enum input without duplicating the next sync", async (t) => {
  const { home, file } = fixture(t, { transcript: true });
  const cursors = {};
  const first = await hourly(home, [file], cursors);
  const previous = cursors.files[file];
  previous.extractorRevision = 1;
  // Recreate the previous extractor's ledger: +1026 enum tokens per call.
  for (const contribution of Object.values(previous.contributions)) {
    contribution.totals.input_tokens += 1026;
    contribution.totals.total_tokens += 1026;
    contribution.totals.billable_total_tokens += 1026;
  }
  for (const bucket of Object.values(cursors.hourly.buckets)) {
    bucket.totals.input_tokens += 1026;
    bucket.totals.total_tokens += 1026;
    bucket.totals.billable_total_tokens += 1026;
  }
  const corrected = await hourly(home, [file], cursors);
  assert.equal(corrected.rows.reduce((sum, row) => sum + row.total_tokens, 0), 335);
  const saved = fs.readFileSync(first.queuePath, "utf8");
  await hourly(home, [file], cursors);
  assert.equal(fs.readFileSync(first.queuePath, "utf8"), saved);
});

test("the local Sessions endpoint exposes Antigravity details and CLI resume without bodies", async (t) => {
  const { home } = fixture(t);
  const originalHome = os.homedir;
  os.homedir = () => home;
  try {
    const { createLocalApiHandler } = require("../src/lib/local-api");
    const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });
    const url = new URL("http://localhost/functions/tokentracker-sessions?refresh=1&from=2026-11-13&to=2026-11-13&tz=UTC");
    const chunks = [];
    const response = {
      statusCode: 200, setHeader() {}, writeHead(code) { this.statusCode = code; },
      write(value) { chunks.push(value); }, end(value) { if (value) chunks.push(value); },
    };
    await handler({ method: "GET", url: url.pathname + url.search, headers: { host: "localhost" } }, response, url);
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(chunks.join(""));
    assert.equal(payload.sessions[0].source, "antigravity");
    assert.equal(payload.sessions[0].input_tokens, 100);
    assert.equal(payload.sessions[0].reasoning_output_tokens, 10);
    assert.equal(payload.sessions[0].resume_command, `agy --conversation ${ID}`);
    assert.equal(chunks.join("").includes(SECRET), false);
  } finally {
    os.homedir = originalHome;
  }
});
