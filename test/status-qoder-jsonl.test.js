"use strict";

// Regression test for the status JSON/light summary ignoring the new Qoder
// JSONL path: a JSONL-only install (no legacy local.db) must still report
// `installed: true` with a non-empty detail pointing at the projects dir.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cmdStatus,
  summarizeQoderDetail,
  formatQoderCreditsLine,
} = require("../src/commands/status");

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "QODER_PROJECTS_DIR",
  "QODER_CN_PROJECTS_DIR",
  "QODER_DB_PATH",
  "QODER_HOME",
  "QODER_CN_DB_PATH",
  "QODER_CN_HOME",
];

function saveEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved) {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

async function captureJsonStatus() {
  // NOTE: under `node --test` the runner multiplexes binary IPC frames over
  // process.stdout.write, so the capture must forward every chunk to the real
  // writer (swallowing breaks runner accounting) and only record the single
  // string chunk cmdStatus(["--json"]) emits (it starts with "{").
  const prevWrite = process.stdout.write.bind(process.stdout);
  let jsonOut = "";
  process.stdout.write = function (...args) {
    const [chunk, enc, cb] = args;
    // cmdStatus(["--json"]) emits the summary as one string chunk starting
    // with "{". Record it without forwarding (keeps test output clean);
    // forward everything else so runner IPC/TAP accounting stays intact.
    if (typeof chunk === "string" && chunk.startsWith("{")) {
      jsonOut += chunk;
      if (typeof enc === "function") enc();
      else if (typeof cb === "function") cb();
      return true;
    }
    return prevWrite(...args);
  };
  try {
    await cmdStatus(["--json"]);
  } finally {
    process.stdout.write = prevWrite;
  }
  return JSON.parse(jsonOut);
}

test("summarizeQoderDetail joins legacy DB and new JSONL paths", () => {
  assert.equal(summarizeQoderDetail("", ""), "");
  assert.equal(summarizeQoderDetail("native: /a/local.db", ""), "native: /a/local.db");
  assert.equal(summarizeQoderDetail("", "/h/.qoder/projects (3 sessions)"), "/h/.qoder/projects (3 sessions)");
  assert.equal(
    summarizeQoderDetail("native: /a/local.db", "/h/.qoder/projects (3 sessions)"),
    "native: /a/local.db + /h/.qoder/projects (3 sessions)",
  );
});

test("status JSON reports JSONL-only Qoder install with projects-dir detail", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-status-qoder-jsonl-"));
  const saved = saveEnv();
  try {
    const projectsDir = path.join(tmp, "projects");
    fs.mkdirSync(path.join(projectsDir, "proj-slug"), { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, "proj-slug", "sess.jsonl"),
      JSON.stringify({ type: "assistant" }) + "\n",
      "utf8",
    );
    // Isolated home (no legacy local.db anywhere) + explicit projects override.
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.QODER_PROJECTS_DIR = projectsDir;
    delete process.env.QODER_CN_PROJECTS_DIR;
    delete process.env.QODER_DB_PATH;
    delete process.env.QODER_HOME;
    delete process.env.QODER_CN_DB_PATH;
    delete process.env.QODER_CN_HOME;

    const summary = await captureJsonStatus();
    const qoder = summary.providers.qoder;
    assert.equal(qoder.installed, true);
    assert.ok(qoder.detail.includes(projectsDir), `detail should contain projects dir, got: ${qoder.detail}`);
    assert.ok(qoder.detail.includes("(1 sessions)"), `detail should contain session count, got: ${qoder.detail}`);
    // CN shares the default dir and must not claim the intl files as its own.
    assert.equal(summary.providers["qoder-cn"].installed, false);
  } finally {
    restoreEnv(saved);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("status JSON joins legacy DB and JSONL paths with ' + '", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-status-qoder-both-"));
  const saved = saveEnv();
  try {
    const projectsDir = path.join(tmp, "projects");
    fs.mkdirSync(path.join(projectsDir, "proj-slug"), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, "proj-slug", "sess.jsonl"), "{}\n", "utf8");
    const legacyDb = path.join(tmp, "local.db");
    fs.writeFileSync(legacyDb, "", "utf8");
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.QODER_PROJECTS_DIR = projectsDir;
    process.env.QODER_DB_PATH = legacyDb;
    delete process.env.QODER_CN_PROJECTS_DIR;
    delete process.env.QODER_HOME;
    delete process.env.QODER_CN_DB_PATH;
    delete process.env.QODER_CN_HOME;

    const summary = await captureJsonStatus();
    const qoder = summary.providers.qoder;
    assert.equal(qoder.installed, true);
    assert.ok(qoder.detail.includes(" + "), `detail should join both paths, got: ${qoder.detail}`);
    assert.ok(qoder.detail.includes(legacyDb), `detail should contain legacy DB, got: ${qoder.detail}`);
    assert.ok(qoder.detail.includes(projectsDir), `detail should contain projects dir, got: ${qoder.detail}`);
  } finally {
    restoreEnv(saved);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("status credits line comes from the sidecar the sync wrote", async () => {
  // A credit-billed Qoder install queues 0 tokens, so `status` alone reads as
  // "tracked, but nothing counted". The sidecar total has to appear.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-status-qoder-credits-"));
  try {
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    fs.mkdirSync(trackerDir, { recursive: true });
    assert.equal(
      formatQoderCreditsLine(tmp, "qoder-credits.json"),
      "",
      "no sidecar means no credits claim",
    );
    fs.writeFileSync(
      path.join(trackerDir, "qoder-credits.json"),
      JSON.stringify({
        version: 1,
        source: "qoder-usage-summary",
        total_credits: 1234.5678,
        record_count: 42,
        session_count: 3,
        file_count: 1,
        latest_at: "2026-11-03T14:00:00.000Z",
        updated_at: "2026-11-03T14:00:00.000Z",
      }),
      "utf8",
    );
    assert.equal(
      formatQoderCreditsLine(tmp, "qoder-credits.json"),
      " · 1234.57 credits over 42 turns (credits only, no token counts)",
    );
    // The CN card must not read the international sidecar.
    assert.equal(formatQoderCreditsLine(tmp, "qoder-cn-credits.json"), "");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
