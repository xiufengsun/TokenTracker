const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  fetchOpencodeGoLimits,
  collectOpencodeGoLocal,
  discoverOpencodeDbPaths,
  resolveOpencodeDataDir,
  isOpencodeDbFilename,
  goDollarLimits,
  weekStartMs,
  detectSubscriptionStatus,
} = require("../src/lib/opencode-go-limits");

// node:sqlite is the write path for building a fixture DB. It's available on the
// project's test runtime (Node ≥22.18). If a future runner lacks it, skip the
// DB-backed cases rather than failing the suite.
let sqlite = null;
try {
  sqlite = require("node:sqlite");
} catch (_e) {
  sqlite = null;
}

const HOUR = 3600 * 1000;
// Wed 2026-06-24 12:00 UTC — mid-week, mid-month: now-6h is still in the same
// UTC week, and the month anchor (June 1) is well before the week start.
const NOW_MS = Date.UTC(2026, 5, 24, 12, 0, 0);

function makeMessageRow(db, { id, providerID, role, cost, createdMs }) {
  const data = JSON.stringify({
    providerID,
    role,
    cost,
    time: { created: createdMs },
  });
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "sess_1", createdMs, createdMs, data);
}

function buildFixtureDb(dir) {
  const dbPath = path.join(dir, "opencode.db");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
  );
  const weekStart = weekStartMs(NOW_MS);
  const monthStart = Date.UTC(2026, 5, 1);

  const rows = [
    // In the 5h session window → counts toward session + weekly + monthly.
    { id: "A", providerID: "opencode-go", role: "assistant", cost: 6.0, createdMs: NOW_MS - 1 * HOUR },
    // Outside 5h but in this week → weekly + monthly only.
    { id: "B", providerID: "opencode-go", role: "assistant", cost: 3.0, createdMs: NOW_MS - 6 * HOUR },
    // In this month but before the week start → monthly only.
    { id: "C", providerID: "opencode-go", role: "assistant", cost: 12.0, createdMs: monthStart + 1 * HOUR },
    // Previous month → excluded from every window.
    { id: "D", providerID: "opencode-go", role: "assistant", cost: 100.0, createdMs: monthStart - 1 * HOUR },
    // Free-tier provider → excluded by the providerID filter.
    { id: "E", providerID: "opencode", role: "assistant", cost: 50.0, createdMs: NOW_MS - 1 * HOUR },
    // User role → excluded by the role filter.
    { id: "F", providerID: "opencode-go", role: "user", cost: 50.0, createdMs: NOW_MS - 1 * HOUR },
  ];
  for (const r of rows) makeMessageRow(db, r);
  db.close();
  // Sanity: keep `weekStart` meaningful for the layout assumptions above.
  assert.ok(monthStart + 1 * HOUR < weekStart, "fixture: C must precede the week start");
  return dbPath;
}

describe("opencode-go local helpers (pure)", () => {
  it("isOpencodeDbFilename matches opencode.db and channel variants only", () => {
    assert.equal(isOpencodeDbFilename("opencode.db"), true);
    assert.equal(isOpencodeDbFilename("opencode-nightly.db"), true);
    assert.equal(isOpencodeDbFilename("opencode.db-wal"), false);
    assert.equal(isOpencodeDbFilename("opencode.db-shm"), false);
    assert.equal(isOpencodeDbFilename("mimocode.db"), false);
    assert.equal(isOpencodeDbFilename("opencode-.db"), false);
  });

  it("resolveOpencodeDataDir honors env/home precedence and returns null without a base", () => {
    assert.equal(resolveOpencodeDataDir({ env: { OPENCODE_HOME: "/x/oc" } }), "/x/oc");
    assert.equal(
      resolveOpencodeDataDir({ env: { XDG_DATA_HOME: "/x/data" } }),
      path.join("/x/data", "opencode"),
    );
    assert.equal(
      resolveOpencodeDataDir({ env: { HOME: "/home/u" } }),
      path.join("/home/u", ".local", "share", "opencode"),
    );
    // `home` arg (what getUsageLimits threads in) is the base when env has none.
    assert.equal(
      resolveOpencodeDataDir({ home: "/home/h", env: {} }),
      path.join("/home/h", ".local", "share", "opencode"),
    );
    // No home, empty env → null, so synthetic test envs never read the dev's DB.
    assert.equal(resolveOpencodeDataDir({ env: {} }), null);
  });

  it("goDollarLimits defaults to $12/$30/$60 and parses a valid override", () => {
    assert.deepEqual(goDollarLimits({}), { session: 12, weekly: 30, monthly: 60 });
    assert.deepEqual(goDollarLimits({ TOKENTRACKER_OPENCODE_GO_LIMITS: "5, 15, 40" }), {
      session: 5,
      weekly: 15,
      monthly: 40,
    });
    // Malformed → fall back to defaults.
    assert.deepEqual(goDollarLimits({ TOKENTRACKER_OPENCODE_GO_LIMITS: "5,bad" }), {
      session: 12,
      weekly: 30,
      monthly: 60,
    });
  });

  it("recognizes the inactive Go page without treating generic pages as inactive", () => {
    assert.equal(
      detectSubscriptionStatus('<button data-slot="subscribe-button">Subscribe Go</button>'),
      "inactive",
    );
    assert.equal(
      detectSubscriptionStatus('<button data-slot="manage-subscription">Manage</button>'),
      "unknown",
    );
  });
});

describe("collectOpencodeGoLocal (real fixture DB)", { skip: !sqlite }, () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-test-"));
    buildFixtureDb(tmpDir);
  });
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  });

  it("discovers the fixture opencode.db via OPENCODE_HOME", () => {
    const paths = discoverOpencodeDbPaths({ env: { OPENCODE_HOME: tmpDir } });
    assert.deepEqual(paths, [path.join(tmpDir, "opencode.db")]);
  });

  it("discovers the fixture opencode.db via the home arg", () => {
    // home/.local/share/opencode is the production discovery path.
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-home-"));
    try {
      const ocDir = path.join(homeDir, ".local", "share", "opencode");
      fs.mkdirSync(ocDir, { recursive: true });
      fs.copyFileSync(path.join(tmpDir, "opencode.db"), path.join(ocDir, "opencode.db"));
      const paths = discoverOpencodeDbPaths({ home: homeDir, env: {} });
      assert.deepEqual(paths, [path.join(ocDir, "opencode.db")]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("sums opencode-go cost per window against the dollar caps", async () => {
    const out = await collectOpencodeGoLocal({ env: { OPENCODE_HOME: tmpDir }, nowMs: NOW_MS });
    assert.ok(out, "expected a local result");
    assert.equal(out.source, "local");
    // session: A ($6) / $12 = 50%
    assert.equal(out.primary_window.used_percent, 50);
    // weekly: A+B ($9) / $30 = 30%
    assert.equal(out.secondary_window.used_percent, 30);
    // monthly: A+B+C ($21) / $60 = 35%  (D excluded: previous month)
    assert.equal(out.tertiary_window.used_percent, 35);
    // session reset = oldest in-session row (A) + 5h
    assert.equal(
      out.primary_window.reset_at,
      new Date(NOW_MS - 1 * HOUR + 5 * HOUR).toISOString(),
    );
  });

  it("honors the dollar-limit override", async () => {
    // session $6 against a $24 cap = 25%
    const out = await collectOpencodeGoLocal({
      env: { OPENCODE_HOME: tmpDir, TOKENTRACKER_OPENCODE_GO_LIMITS: "24,30,60" },
      nowMs: NOW_MS,
    });
    assert.equal(out.primary_window.used_percent, 25);
  });

  it("returns null when no opencode.db exists", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-empty-"));
    try {
      assert.equal(await collectOpencodeGoLocal({ env: { OPENCODE_HOME: empty }, nowMs: NOW_MS }), null);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

// opencode2 (OpenCode v2 beta) rewrote the storage layer: the `message` table
// became `session_message` (role is now a `type` column) and the provider
// moved under `$.model.providerID`. The local cost estimate must keep working
// against both generations sharing the same file.
describe("collectOpencodeGoLocal (opencode2 session_message fixture)", { skip: !sqlite }, () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-v2-test-"));
    buildV2FixtureDb(tmpDir);
  });
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  });

  function makeSessionMessageRow(db, { id, providerID, type, cost, createdMs }) {
    const data = JSON.stringify({
      model: { id: "x-preview-f-free", providerID },
      type,
      cost,
      time: { created: createdMs },
    });
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, 0, ?, ?, ?)",
    ).run(id, "sess_v2_1", type, createdMs, createdMs, data);
  }

  function buildV2FixtureDb(dir) {
    const dbPath = path.join(dir, "opencode.db");
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    const weekStart = weekStartMs(NOW_MS);
    const monthStart = Date.UTC(2026, 5, 1);

    const rows = [
      // Mirrors the v1 fixture layout so window math stays comparable.
      { id: "A", providerID: "opencode-go", type: "assistant", cost: 6.0, createdMs: NOW_MS - 1 * HOUR },
      { id: "B", providerID: "opencode-go", type: "assistant", cost: 3.0, createdMs: NOW_MS - 6 * HOUR },
      { id: "C", providerID: "opencode-go", type: "assistant", cost: 12.0, createdMs: monthStart + 1 * HOUR },
      { id: "D", providerID: "opencode-go", type: "assistant", cost: 100.0, createdMs: monthStart - 1 * HOUR },
      // Nested provider filter must exclude non-Go providers…
      { id: "E", providerID: "opencode", type: "assistant", cost: 50.0, createdMs: NOW_MS - 1 * HOUR },
      // …and the `type` column replaces the old role filter.
      { id: "F", providerID: "opencode-go", type: "user", cost: 50.0, createdMs: NOW_MS - 1 * HOUR },
    ];
    for (const r of rows) makeSessionMessageRow(db, r);
    db.close();
    assert.ok(monthStart + 1 * HOUR < weekStart, "fixture: C must precede the week start");
  }

  it("sums opencode-go cost per window from the session_message table", async () => {
    const out = await collectOpencodeGoLocal({ env: { OPENCODE_HOME: tmpDir }, nowMs: NOW_MS });
    assert.ok(out, "expected a local result");
    assert.equal(out.source, "local");
    // Same expectations as the v1 fixture: A / A+B / A+B+C.
    assert.equal(out.primary_window.used_percent, 50);
    assert.equal(out.secondary_window.used_percent, 30);
    assert.equal(out.tertiary_window.used_percent, 35);
  });
});

describe("fetchOpencodeGoLimits source selection (real fixture DB)", { skip: !sqlite }, () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-go-fetch-"));
    buildFixtureDb(tmpDir);
  });
  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      /* best effort */
    }
  });

  it("does not present local DB history as a verified subscription by default", async () => {
    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_HOME: tmpDir },
      nowMs: NOW_MS,
      fetchImpl: async () => {
        throw new Error("network must not be touched without a cookie");
      },
    });
    assert.deepEqual(out, { configured: false });
  });

  it("keeps the local estimate available only as an explicit opt-in", async () => {
    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_HOME: tmpDir, TOKENTRACKER_OPENCODE_GO_LOCAL_ESTIMATE: "1" },
      nowMs: NOW_MS,
      fetchImpl: async () => {
        throw new Error("network must not be touched without a cookie");
      },
    });
    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(out.source, "local-estimate");
    assert.equal(out.subscription_status, "unknown");
    assert.equal(out.primary_window.used_percent, 50);
  });

  it("does not fall back to local history when the authenticated page says Go is inactive", async () => {
    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_HOME: tmpDir, OPENCODE_GO_WORKSPACE_ID: "wrk_1", OPENCODE_GO_AUTH_COOKIE: "cookie" },
      nowMs: NOW_MS,
      // This is the rendered inactive workspace page: it offers Subscribe Go
      // instead of the active subscription's usage-item rows.
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        async text() {
          return '<html><button data-slot="subscribe-button">Subscribe Go</button></html>';
        },
      }),
    });
    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(out.subscription_status, "inactive");
    assert.equal(out.primary_window, undefined);
    assert.equal(out.source, undefined);
  });

  it("does not fall back to local history for an authenticated parse failure unless opted in", async () => {
    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_HOME: tmpDir, OPENCODE_GO_WORKSPACE_ID: "wrk_1", OPENCODE_GO_AUTH_COOKIE: "cookie" },
      nowMs: NOW_MS,
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        async text() {
          return "<html>authenticated page with an unexpected layout</html>";
        },
      }),
    });
    assert.equal(out.configured, true);
    assert.match(out.error, /Could not parse any known OpenCode Go dashboard usage windows/);
    assert.equal(out.source, undefined);
  });

  it("cookie present and scrape succeeds → web wins over local", async () => {
    const ssr =
      '<script>self.__next_f.push([1,"rollingUsage:$R[3]={usagePercent:2,resetInSec:60}"])</script>' +
      '<script>self.__next_f.push([1,"weeklyUsage:$R[4]={usagePercent:17,resetInSec:600}"])</script>' +
      '<script>self.__next_f.push([1,"monthlyUsage:$R[5]={usagePercent:8,resetInSec:6000}"])</script>';
    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_HOME: tmpDir, OPENCODE_GO_WORKSPACE_ID: "wrk_1", OPENCODE_GO_AUTH_COOKIE: "cookie" },
      nowMs: NOW_MS,
      fetchImpl: async () => ({ status: 200, ok: true, async text() { return ssr; } }),
    });
    assert.equal(out.source, "web");
    assert.equal(out.subscription_status, "active");
    // Exact server values, not the local estimate (which would be 50/30/35).
    assert.equal(out.primary_window.used_percent, 2);
    assert.equal(out.secondary_window.used_percent, 17);
    assert.equal(out.tertiary_window.used_percent, 8);
  });
});
