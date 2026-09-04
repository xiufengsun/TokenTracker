const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const cp = require("node:child_process");
const { test } = require("node:test");

const { cmdStatus } = require("../src/commands/status");
const { mockPlatform, mockMethod } = require("./helpers/mock");

function runSql(dbPath, sql) {
  cp.execFileSync("sqlite3", [dbPath, sql], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

test("status prints last upload timestamps from upload.throttle.json", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      `notify = ["/usr/bin/env", "node", ${JSON.stringify(path.join(tmp, ".tokentracker", "bin", "notify.cjs"))}]\n`,
      "utf8",
    );

    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify(
        { baseUrl: "https://config.example", deviceToken: "t", deviceId: "d" },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "cursors.json"),
      JSON.stringify({ updatedAt: "2025-12-18T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(trackerDir, "queue.jsonl"), "", "utf8");
    await fs.writeFile(
      path.join(trackerDir, "queue.state.json"),
      JSON.stringify({ offset: 0 }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "openclaw.signal"),
      "2026-02-12T00:00:00.000Z\n",
      "utf8",
    );

    const lastSuccessMs = 1766053145522; // 2025-12-18T10:19:05.522Z
    const nextAllowedAtMs = lastSuccessMs + 1000;
    await fs.writeFile(
      path.join(trackerDir, "upload.throttle.json"),
      JSON.stringify(
        { version: 1, lastSuccessMs, nextAllowedAtMs, backoffUntilMs: 0, backoffStep: 0 },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdStatus();

    assert.match(out, /- Base URL: https:\/\/config\.example/);
    assert.match(out, /- Last upload: 2025-12-18T10:19:05\.522Z/);
    assert.match(out, /- Last OpenClaw-triggered sync: 2026-02-12T00:00:00.000Z/);
    assert.match(out, /- Next upload after: 2025-12-18T10:19:06\.522Z/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status reports Codex notify unset when config points to another command", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-notify-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      'notify = ["/Applications/SkyComputerUseClient", "turn-ended"]\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify({ baseUrl: "https://config.example", deviceToken: "t" }) + "\n",
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdStatus();

    assert.match(out, /- Codex notify: unset/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status JSON reports Acode notify and session paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-acode-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAcodeHome = process.env.TOKENTRACKER_ACODE_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    const acodeHome = path.join(tmp, ".acode-custom");
    process.env.TOKENTRACKER_ACODE_HOME = acodeHome;
    const notifyPath = path.join(tmp, ".tokentracker", "bin", "notify.cjs");
    await fs.mkdir(path.join(acodeHome, "sessions", "2026", "08", "31"), { recursive: true });
    await fs.mkdir(path.join(acodeHome, "archived_sessions"), { recursive: true });
    await fs.writeFile(
      path.join(acodeHome, "config.toml"),
      `notify = ["/usr/bin/env", "node", ${JSON.stringify(notifyPath)}, "--source=acode"]\n`,
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };
    await cmdStatus(["--json"]);

    const status = JSON.parse(out);
    assert.equal(status.hooks.acode_notify, true);
    assert.equal(status.providers.acode.installed, true);
    assert.match(status.providers.acode.detail, /\.acode-custom/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevAcodeHome === undefined) delete process.env.TOKENTRACKER_ACODE_HOME;
    else process.env.TOKENTRACKER_ACODE_HOME = prevAcodeHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status JSON reports Copilot canonical store diagnostics", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-copilot-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    const copilotHome = path.join(tmp, ".copilot");
    const storeDb = path.join(copilotHome, "session-store.db");
    const appDb = path.join(copilotHome, "data.db");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.mkdir(copilotHome, { recursive: true });
    await fs.writeFile(appDb, "", "utf8");
    runSql(storeDb, `
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (6);
      CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        token_details_json TEXT,
        created_at TEXT
      );
      INSERT INTO assistant_usage_events
        (id, session_id, model, input_tokens, output_tokens, created_at)
      VALUES
        (1, 'status-session', 'gpt-5.6-luna', 10, 1, '2026-07-10T10:00:00Z'),
        (2, 'status-session', 'gpt-5.6-luna', 20, 2, '2026-07-10T10:30:00Z');
    `);
    await fs.writeFile(
      path.join(trackerDir, "cursors.json"),
      JSON.stringify({
        copilotStore: {
          active: true,
          dbs: {
            [storeDb]: {
              adoptedAt: "2026-07-10T10:00:00.000Z",
              lastId: 2,
              malformedEventCount: 1,
              resetGapEventCount: 2,
            },
          },
        },
      }),
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };
    await cmdStatus(["--json"]);

    const status = JSON.parse(out);
    assert.equal(status.copilot.canonical, true);
    assert.equal(status.copilot.source_mode, "canonical-degraded");
    assert.equal(status.copilot.app_db_mode, "observe-only");
    assert.equal(
      status.copilot.coverage,
      "per-request-post-adoption; legacy-aggregate-pre-adoption",
    );
    assert.equal(status.copilot.store_details[0].schema_version, 6);
    assert.equal(status.copilot.store_details[0].event_count, 2);
    assert.equal(status.copilot.store_details[0].last_event_id, 2);
    assert.equal(
      status.copilot.store_details[0].last_event_at,
      "2026-07-10T10:30:00.000Z",
    );
    assert.equal(status.copilot.malformed_event_count, 1);
    assert.equal(status.copilot.reset_gap_event_count, 2);
    assert.equal(status.copilot.degraded, true);
    assert.match(status.copilot.degraded_reasons[0], /valid timestamp/);
    assert.ok(
      status.copilot.degraded_reasons.some((reason) =>
        /legacy cursor\/reset race/.test(reason),
      ),
    );
    assert.match(status.copilot.recommended_action, /tokentracker sync/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status native-only mode does not probe WSL distros", async (t) => {
  mockPlatform(t, "win32");
  let wslCalls = 0;
  mockMethod(t, cp, "execFileSync", (cmd) => {
    if (cmd === "wsl.exe") wslCalls++;
    throw new Error("unexpected child process call");
  });

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-wsl-mode-"));
  const prevEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    TOKENTRACKER_WSL_MODE: process.env.TOKENTRACKER_WSL_MODE,
  };
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.LOCALAPPDATA = path.join(tmp, "AppData", "Local");
    process.env.APPDATA = path.join(tmp, "AppData", "Roaming");
    process.env.TOKENTRACKER_WSL_MODE = "native-only";

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdStatus();

    assert.equal(wslCalls, 0);
    assert.match(out, /- WSL mode: native-only/);
  } finally {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.stdout.write = prevWrite;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status does not migrate legacy tracker directory", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-legacy-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");

    const legacyTrackerDir = path.join(tmp, ".legacy-tracker-root", "tracker");
    await fs.mkdir(legacyTrackerDir, { recursive: true });
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });

    await fs.writeFile(
      path.join(process.env.CODEX_HOME, "config.toml"),
      'notify = [\"/usr/bin/env\", \"node\", \"~/.legacy-tracker-root/bin/notify.cjs\"]\n',
      "utf8",
    );

    await fs.writeFile(
      path.join(legacyTrackerDir, "config.json"),
      JSON.stringify(
        { baseUrl: "https://example.invalid", deviceToken: "t", deviceId: "d" },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyTrackerDir, "cursors.json"),
      JSON.stringify({ updatedAt: "2025-12-18T00:00:00.000Z" }) + "\n",
      "utf8",
    );
    await fs.writeFile(path.join(legacyTrackerDir, "queue.jsonl"), "", "utf8");
    await fs.writeFile(
      path.join(legacyTrackerDir, "queue.state.json"),
      JSON.stringify({ offset: 0 }) + "\n",
      "utf8",
    );

    const lastSuccessMs = 1766053145522; // 2025-12-18T10:19:05.522Z
    const nextAllowedAtMs = lastSuccessMs + 1000;
    await fs.writeFile(
      path.join(legacyTrackerDir, "upload.throttle.json"),
      JSON.stringify(
        { version: 1, lastSuccessMs, nextAllowedAtMs, backoffUntilMs: 0, backoffStep: 0 },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    await cmdStatus();

    assert.match(out, /- Base URL: unset/);
    assert.match(out, /- Last upload: never/);
    const newTrackerDir = path.join(tmp, ".tokentracker", "tracker");
    await assert.rejects(fs.stat(newTrackerDir));
    await fs.stat(legacyTrackerDir);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status renders the Trae SOLO entitlement snapshot from Local State", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-trae-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevTraeHome = process.env.TOKENTRACKER_TRAE_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    const traeHome = path.join(tmp, "trae-solo");
    process.env.TOKENTRACKER_TRAE_HOME = traeHome;

    // Trae install so detection reports installed.
    await fs.mkdir(path.join(traeHome, "User", "globalStorage"), { recursive: true });
    await fs.writeFile(
      path.join(traeHome, "User", "globalStorage", "storage.json"),
      JSON.stringify({
        "iCubeServerData://icube.cloudide": JSON.stringify({
          entitlementInfo: {
            identityStr: "Pro",
            identity: 3,
            hasPackage: true,
            isDollarUsageBilling: false,
            proPeriod: "year",
            enableSoloBuilder: true,
            enableSoloCoder: false,
            detail: { fastRequestPer: 20, inWaitlist: false },
          },
        }),
      }),
      "utf8",
    );

    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify({ baseUrl: "https://config.example", deviceToken: "t" }) + "\n",
      "utf8",
    );
    // No source=trae queue row is needed: the entitlement render path reads
    // the Trae Local State storage.json directly (queue is token-count-only).
    await fs.writeFile(
      path.join(trackerDir, "queue.state.json"),
      JSON.stringify({ offset: 0 }) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(trackerDir, "cursors.json"),
      JSON.stringify({ updatedAt: "2026-08-07T01:30:00.000Z" }) + "\n",
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };

    // --json: the summary must expose the entitlement under providers.trae.
    await cmdStatus(["--json"]);
    const summary = JSON.parse(out);
    assert.equal(summary.providers.trae.installed, true);
    assert.ok(summary.providers.trae.detail.endsWith("storage.json"));
    assert.equal(summary.providers.trae.entitlement.identity, "Pro");
    assert.equal(summary.providers.trae.entitlement.pro_period, "year");
    assert.equal(summary.providers.trae.entitlement.enable_solo_builder, true);
    assert.equal(summary.providers.trae.entitlement.fast_request_per, 20);
    // captured_at is the storage.json mtime, not a queue hour_start.
    assert.match(summary.providers.trae.entitlement.captured_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Text render: the plan line must describe the snapshot.
    out = "";
    await cmdStatus();
    // Not "passive reader" — that wording means "tokens are counted" on every
    // other provider line, and Trae contributes no usage at all.
    assert.match(out, /- Trae SOLO: plan info only, no token usage \(/);
    assert.doesNotMatch(out, /- Trae SOLO: passive reader/);
    assert.match(out, /- Trae SOLO plan: plan Pro, year period, package billing/);
    assert.match(out, /20 fast requests\/hr/);
    assert.match(out, /snapshot \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevTraeHome === undefined) delete process.env.TOKENTRACKER_TRAE_HOME;
    else process.env.TOKENTRACKER_TRAE_HOME = prevTraeHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// TRAE Work CN install detection + auth state (PR #474): a RESOLVABLE default
// path does not mean the app is installed - the macOS resolver always derives
// one. installed must mean the storage file actually EXISTS (same semantics
// as the sync path), and the auth state must distinguish not-signed-in /
// readable / malformed / unreadable.
// ---------------------------------------------------------------------------

test("status trae-cn installed=false when the default path resolves but no storage file exists", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-traecn-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevAppData = process.env.APPDATA;
  const prevTraeCnHome = process.env.TOKENTRACKER_TRAE_CN_HOME;
  const prevTraeCnUsage = process.env.TOKENTRACKER_TRAE_CN_USAGE;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.APPDATA = path.join(tmp, "AppData", "Roaming");
    delete process.env.TOKENTRACKER_TRAE_CN_HOME;
    delete process.env.TOKENTRACKER_TRAE_CN_USAGE;

    // Nothing is created under the default TRAE SOLO CN path: the resolver
    // still derives it, but the file is absent -> NOT installed.
    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };
    await cmdStatus(["--json"]);
    const summary = JSON.parse(out);
    assert.equal(summary.providers["trae-cn"].installed, false, "absent storage file must not report installed");

    out = "";
    await cmdStatus();
    assert.doesNotMatch(out, /- Trae SOLO CN: usage sync/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevTraeCnHome === undefined) delete process.env.TOKENTRACKER_TRAE_CN_HOME;
    else process.env.TOKENTRACKER_TRAE_CN_HOME = prevTraeCnHome;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevTraeCnUsage === undefined) delete process.env.TOKENTRACKER_TRAE_CN_USAGE;
    else process.env.TOKENTRACKER_TRAE_CN_USAGE = prevTraeCnUsage;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status trae-cn installed=true with auth readable when the storage file exists", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-traecn-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevTraeCnHome = process.env.TOKENTRACKER_TRAE_CN_HOME;
  const prevTraeCnUsage = process.env.TOKENTRACKER_TRAE_CN_USAGE;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    // Platform-independent: the default-path resolver is darwin-only, so point
    // the env override at a synthetic install. Same semantics under test:
    // storage.json exists -> installed=true, auth readable.
    process.env.TOKENTRACKER_TRAE_CN_HOME = path.join(tmp, "trae-install");
    delete process.env.TOKENTRACKER_TRAE_CN_USAGE;

    const storageDir = path.join(
      process.env.TOKENTRACKER_TRAE_CN_HOME, "User", "globalStorage",
    );
    await fs.mkdir(storageDir, { recursive: true });
    await fs.writeFile(
      path.join(storageDir, "storage.json"),
      JSON.stringify({ "iCubeAuthInfo://icube.cloudide": { token: "fake.jwt.value", refreshToken: "synthetic" } }),
      "utf8",
    );

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };
    await cmdStatus(["--json"]);
    const summary = JSON.parse(out);
    assert.equal(summary.providers["trae-cn"].installed, true);
    assert.equal(summary.providers["trae-cn"].auth, "readable");
    assert.equal(summary.providers["trae-cn"].usage_opt_in, false, "opt-in stays off by default");

    out = "";
    await cmdStatus();
    // Signed in but not opted in is the one actionable state here: the user
    // has TRAE Work CN installed and readable, and a single env var is all
    // that stands between them and usage data. Flag it so the line does not
    // read like the ~30 other neutral install lines around it (#492).
    assert.match(out, /- ⚠ Trae SOLO CN: usage sync off \(set TOKENTRACKER_TRAE_CN_USAGE=1 to enable\), auth readable/);
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevTraeCnHome === undefined) delete process.env.TOKENTRACKER_TRAE_CN_HOME;
    else process.env.TOKENTRACKER_TRAE_CN_HOME = prevTraeCnHome;
    if (prevTraeCnUsage === undefined) delete process.env.TOKENTRACKER_TRAE_CN_USAGE;
    else process.env.TOKENTRACKER_TRAE_CN_USAGE = prevTraeCnUsage;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status trae-cn installed=false for a custom TOKENTRACKER_TRAE_CN_HOME that does not exist", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-traecn-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevTraeCnHome = process.env.TOKENTRACKER_TRAE_CN_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.TOKENTRACKER_TRAE_CN_HOME = path.join(tmp, "no-such-install");

    let out = "";
    process.stdout.write = (chunk, enc, cb) => {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    };
    await cmdStatus(["--json"]);
    const summary = JSON.parse(out);
    assert.equal(summary.providers["trae-cn"].installed, false, "env override pointing at nothing is not installed");
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevTraeCnHome === undefined) delete process.env.TOKENTRACKER_TRAE_CN_HOME;
    else process.env.TOKENTRACKER_TRAE_CN_HOME = prevTraeCnHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("status trae-cn distinguishes malformed vs unreadable storage", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-status-traecn-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevTraeCnHome = process.env.TOKENTRACKER_TRAE_CN_HOME;
  const prevWrite = process.stdout.write;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    const traeCnHome = path.join(tmp, "trae-cn-data");
    process.env.TOKENTRACKER_TRAE_CN_HOME = traeCnHome;

    const capture = () => {
      let out = "";
      process.stdout.write = (chunk, enc, cb) => {
        out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
        if (typeof cb === "function") cb();
        return true;
      };
      return async () => {
        await cmdStatus(["--json"]);
        return JSON.parse(out);
      };
    };

    // Present but malformed JSON -> malformed (NOT not-signed-in, NOT unreadable).
    const storageDir = path.join(traeCnHome, "User", "globalStorage");
    await fs.mkdir(storageDir, { recursive: true });
    await fs.writeFile(path.join(storageDir, "storage.json"), "{not json", "utf8");
    let run = capture();
    let summary = await run();
    assert.equal(summary.providers["trae-cn"].installed, true);
    assert.equal(summary.providers["trae-cn"].auth, "malformed");

    // A storage path that exists but cannot be READ as a file (EISDIR: the
    // resolved storage.json is itself a directory) -> unreadable, the
    // fail-closed IO state, distinct from malformed.
    await fs.rm(path.join(storageDir, "storage.json"), { force: true });
    await fs.mkdir(path.join(storageDir, "storage.json"), { recursive: true });
    run = capture();
    summary = await run();
    assert.equal(summary.providers["trae-cn"].installed, true);
    assert.equal(summary.providers["trae-cn"].auth, "unreadable");
  } finally {
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevTraeCnHome === undefined) delete process.env.TOKENTRACKER_TRAE_CN_HOME;
    else process.env.TOKENTRACKER_TRAE_CN_HOME = prevTraeCnHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
