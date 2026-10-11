/**
 * Claude Code WSL dual-install support (#307).
 *
 * Verifies:
 *   - a merged native + WSL(UNC-style) file list parses both installs with
 *     per-file cursors keyed by absolute path (natural per-install isolation)
 *   - file-identity-hash dedup: an identical never-parsed copy of a session
 *     file (native + synced WSL view) is skipped WHOLESALE (not merely
 *     zero-event'd by the message-hash layer) and marked duplicateOf
 *   - divergent copies are both parsed; message hashes still prevent
 *     double-counting of the overlapping prefix
 *   - dedup layer stays dormant for single-environment lists (no fileId cost)
 *   - subagent detection is path-separator agnostic (UNC backslashes)
 *   - computeClaudeGroundTruthBuckets accepts multiple rootDirs and dedups
 *     cross-root messages
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { parseClaudeIncremental } = require("../src/lib/rollout");
const { computeClaudeGroundTruthBuckets } = require("../src/lib/claude-categorizer");

function tmpdir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assistantLine({ msgId, reqId, ts, input = 100, output = 50, model = "claude-sonnet-4" }) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    requestId: reqId,
    message: { id: msgId, model, usage: { input_tokens: input, output_tokens: output } },
  });
}

function userLine(ts) {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "text", text: "hi" }] },
  });
}

// Exercise the UNC-prefix branch with a readable alias on each host. Windows
// uses its extended local-path syntax; neither fixture is a live WSL mount.
function uncAlias(p) {
  return process.platform === "win32" ? path.toNamespacedPath(p) : `/${p}`;
}

// queue.jsonl is append-only and buckets carry cumulative absolutes; readers
// take the LATEST entry per (source, model, hour_start).
function sumLatestPerBucket(rows, field) {
  const latest = new Map();
  for (const r of rows) latest.set(`${r.source}|${r.model}|${r.hour_start}`, r);
  return [...latest.values()].reduce((s, r) => s + (r[field] || 0), 0);
}

test("claude dual-install: merged list parses both installs, cursors keyed per path", async (t) => {
  const dir = tmpdir(t, "claude-dual-");
  const nativeFile = path.join(dir, "native-proj", "s1.jsonl");
  const wslFileReal = path.join(dir, "wsl-proj", "s2.jsonl");
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.mkdirSync(path.dirname(wslFileReal), { recursive: true });
  fs.writeFileSync(nativeFile, assistantLine({ msgId: "m-native", reqId: "r1", ts: "2026-01-01T10:15:00.000Z", input: 100 }) + "\n");
  fs.writeFileSync(wslFileReal, assistantLine({ msgId: "m-wsl", reqId: "r2", ts: "2026-01-01T11:15:00.000Z", input: 200 }) + "\n");
  const wslFile = uncAlias(wslFileReal);

  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const result = await parseClaudeIncremental({
    projectFiles: [nativeFile, wslFile],
    cursors,
    queuePath,
    source: "claude",
  });

  assert.equal(result.filesProcessed, 2);
  assert.equal(result.eventsAggregated, 2);
  assert.ok(cursors.files[nativeFile], "native path key");
  assert.ok(cursors.files[wslFile], "wsl UNC path key");

  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sumLatestPerBucket(rows, "input_tokens"), 300, "both environments aggregated");
});

test("claude dual-install: identical synced copy is skipped wholesale via file hash", async (t) => {
  const dir = tmpdir(t, "claude-dup-");
  const nativeFile = path.join(dir, "native-proj", "s1.jsonl");
  const wslFileReal = path.join(dir, "wsl-proj", "s1.jsonl");
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.mkdirSync(path.dirname(wslFileReal), { recursive: true });
  const content = assistantLine({ msgId: "m1", reqId: "r1", ts: "2026-01-01T10:15:00.000Z", input: 100 }) + "\n";
  fs.writeFileSync(nativeFile, content);
  fs.writeFileSync(wslFileReal, content);
  const wslFile = uncAlias(wslFileReal);

  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const result = await parseClaudeIncremental({
    projectFiles: [nativeFile, wslFile],
    cursors,
    queuePath,
    source: "claude",
  });

  // Wholesale skip: the duplicate never reaches parseClaudeFile. Message-hash
  // dedup alone would still report filesProcessed === 2 with zero events.
  assert.equal(result.filesProcessed, 1, "duplicate not parsed at all");
  assert.equal(result.eventsAggregated, 1);
  const dupCursor = cursors.files[wslFile];
  assert.ok(dupCursor, "duplicate still gets a caught-up cursor");
  assert.equal(dupCursor.duplicateOf, nativeFile);
  assert.equal(dupCursor.offset, Buffer.byteLength(content), "cursor parked at EOF");
  assert.ok(cursors.files[nativeFile].fileId, "primary caches its fileId");

  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sumLatestPerBucket(rows, "input_tokens"), 100, "counted exactly once");

  // If the WSL copy later diverges (new tail line), only the tail is parsed
  // and a genuinely new message is counted once.
  fs.appendFileSync(wslFileReal, assistantLine({ msgId: "m2", reqId: "r2", ts: "2026-01-01T10:45:00.000Z", input: 30 }) + "\n");
  const second = await parseClaudeIncremental({
    projectFiles: [nativeFile, wslFile],
    cursors,
    queuePath,
    source: "claude",
  });
  assert.equal(second.eventsAggregated, 1, "only the new tail message");
});

test("claude dual-install: divergent copies both parse; overlap guarded by message hashes", async (t) => {
  const dir = tmpdir(t, "claude-div-");
  const nativeFile = path.join(dir, "native-proj", "s1.jsonl");
  const wslFileReal = path.join(dir, "wsl-proj", "s1.jsonl");
  fs.mkdirSync(path.dirname(nativeFile), { recursive: true });
  fs.mkdirSync(path.dirname(wslFileReal), { recursive: true });
  const shared = assistantLine({ msgId: "m1", reqId: "r1", ts: "2026-01-01T10:15:00.000Z", input: 100 });
  // Same first message, but the WSL copy carries an extra turn → different
  // size → different fileId → both files parse; the shared message dedups
  // via the message-hash layer.
  fs.writeFileSync(nativeFile, shared + "\n");
  fs.writeFileSync(
    wslFileReal,
    shared + "\n" + assistantLine({ msgId: "m2", reqId: "r2", ts: "2026-01-01T10:20:00.000Z", input: 40 }) + "\n",
  );
  const wslFile = uncAlias(wslFileReal);

  const queuePath = path.join(dir, "queue.jsonl");
  const cursors = {};
  const result = await parseClaudeIncremental({
    projectFiles: [nativeFile, wslFile],
    cursors,
    queuePath,
    source: "claude",
  });

  assert.equal(result.filesProcessed, 2, "divergent copies are both parsed");
  assert.equal(result.eventsAggregated, 2, "shared message counted once, extra turn once");
  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sumLatestPerBucket(rows, "input_tokens"), 140);
});

test("claude single-environment list keeps the dedup layer dormant", async (t) => {
  const dir = tmpdir(t, "claude-single-");
  const a = path.join(dir, "p", "a.jsonl");
  const b = path.join(dir, "p", "b.jsonl");
  fs.mkdirSync(path.dirname(a), { recursive: true });
  const content = assistantLine({ msgId: "m1", reqId: "r1", ts: "2026-01-01T10:15:00.000Z" }) + "\n";
  // Identical content in one environment (e.g. a manual backup copy) is the
  // message-hash layer's job — file-level dedup must not kick in without a
  // native/UNC mix, so no fileId bookkeeping appears on the cursors.
  fs.writeFileSync(a, content);
  fs.writeFileSync(b, content);

  const cursors = {};
  const result = await parseClaudeIncremental({
    projectFiles: [a, b],
    cursors,
    queuePath: path.join(dir, "queue.jsonl"),
    source: "claude",
  });
  assert.equal(result.filesProcessed, 2);
  assert.equal(result.eventsAggregated, 1, "message hash still dedups");
  assert.equal(cursors.files[a].fileId, undefined);
  assert.equal(cursors.files[b].duplicateOf, undefined);
});

test("claude subagent detection is separator-agnostic", async (t) => {
  const dir = tmpdir(t, "claude-sep-");
  fs.mkdirSync(path.join(dir, "p"), { recursive: true });
  // POSIX allows backslashes inside a file name — this simulates the string
  // shape of a Windows UNC path (…\subagents\…) hitting the regex.
  const subagentStyle = path.join(dir, "p", "sess\\subagents\\agent-a.jsonl");
  const mainStyle = path.join(dir, "p", "main.jsonl");
  fs.mkdirSync(path.dirname(subagentStyle), { recursive: true });
  fs.writeFileSync(subagentStyle, userLine("2026-01-01T10:15:00.000Z") + "\n");
  fs.writeFileSync(mainStyle, userLine("2026-01-01T10:15:00.000Z") + "\n");

  const cursors = {};
  await parseClaudeIncremental({
    projectFiles: [subagentStyle, mainStyle],
    cursors,
    queuePath: path.join(dir, "queue.jsonl"),
    source: "claude",
  });

  const buckets = Object.values(cursors.hourly?.buckets || {});
  const conversations = buckets.reduce((s, b) => s + (b.totals?.conversation_count || 0), 0);
  assert.equal(conversations, 1, "backslash subagent path must not count as a main session");
});

test("computeClaudeGroundTruthBuckets merges multiple roots and dedups across them", async (t) => {
  const dir = tmpdir(t, "claude-truth-");
  const rootA = path.join(dir, "native", "projects");
  const rootB = path.join(dir, "wsl", "projects");
  fs.mkdirSync(path.join(rootA, "proj"), { recursive: true });
  fs.mkdirSync(path.join(rootB, "proj"), { recursive: true });

  const shared = assistantLine({ msgId: "m1", reqId: "r1", ts: "2026-01-01T10:15:00.000Z", input: 100 });
  fs.writeFileSync(path.join(rootA, "proj", "s1.jsonl"), shared + "\n");
  // WSL root: the synced copy of s1 plus a WSL-only session.
  fs.writeFileSync(path.join(rootB, "proj", "s1.jsonl"), shared + "\n");
  fs.writeFileSync(
    path.join(rootB, "proj", "s2.jsonl"),
    assistantLine({ msgId: "m2", reqId: "r2", ts: "2026-01-01T11:15:00.000Z", input: 60 }) + "\n",
  );

  const result = await computeClaudeGroundTruthBuckets({ rootDirs: [rootA, rootB] });
  assert.equal(result.fileList.length, 3, "all files from both roots enumerated");
  const totalInput = result.rows.reduce((s, r) => s + (r.input_tokens || 0), 0);
  assert.equal(totalInput, 160, "cross-root duplicate message counted once");

  // Legacy single-root call keeps working.
  const single = await computeClaudeGroundTruthBuckets({ rootDir: rootA });
  assert.equal(single.fileList.length, 1);
});
