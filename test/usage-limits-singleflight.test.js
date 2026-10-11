const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const kiroProbe = `${process.platform === "win32" ? "where" : "which"} kiro-cli`;

const {
  getUsageLimits,
  resetUsageLimitsCache,
  runCommand,
} = require("../src/lib/usage-limits");

function makeCountingDeps() {
  const commandCalls = [];
  let fetchCalls = 0;
  return {
    commandCalls,
    countFetchCalls: () => fetchCalls,
    options: {
      platform: "linux",
      providerTimeoutMs: 2000,
      securityRunner() {
        return { status: 1, stdout: "" };
      },
      // Async (slow) runner: keeps the fetch round in flight long enough for a
      // concurrent caller to arrive, and exercises the await path in runCommand.
      commandRunner(command, args) {
        commandCalls.push([command, ...(args || [])].join(" "));
        return new Promise((resolve) => {
          setTimeout(() => resolve({ status: 1, stdout: "", stderr: "" }), 50);
        });
      },
      fetchImpl() {
        fetchCalls += 1;
        return Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) });
      },
    },
  };
}

describe("getUsageLimits single-flight", () => {
  it("shares one upstream fetch round across concurrent cache misses", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-singleflight-"));
    // Clear provider env so the OpenCode Go scraper doesn't fetch in this test.
    const savedEnv = {
      OPENCODE_GO_WORKSPACE_ID: process.env.OPENCODE_GO_WORKSPACE_ID,
      OPENCODE_GO_AUTH_COOKIE: process.env.OPENCODE_GO_AUTH_COOKIE,
    };
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    try {
      const { commandCalls, countFetchCalls, options } = makeCountingDeps();
      const opts = { home: tmp, ...options };

      const [r1, r2] = await Promise.all([getUsageLimits(opts), getUsageLimits(opts)]);

      assert.equal(r1, r2, "concurrent callers must resolve to the same result object");
      assert.equal(
        commandCalls.filter((c) => c === kiroProbe).length,
        1,
        "Kiro probe must run once for two concurrent requests",
      );
      assert.equal(
        commandCalls.filter((c) => c.startsWith("/bin/ps")).length,
        1,
        "Antigravity ps probe must run once for two concurrent requests",
      );
      assert.equal(countFetchCalls(), 0, "no provider is configured, so no HTTP fetch expected");
    } finally {
      if (savedEnv.OPENCODE_GO_WORKSPACE_ID !== undefined) {
        process.env.OPENCODE_GO_WORKSPACE_ID = savedEnv.OPENCODE_GO_WORKSPACE_ID;
      }
      if (savedEnv.OPENCODE_GO_AUTH_COOKIE !== undefined) {
        process.env.OPENCODE_GO_AUTH_COOKIE = savedEnv.OPENCODE_GO_AUTH_COOKIE;
      }
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reuses the in-flight fetch when the cache is cleared mid-flight (refresh=1 path)", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-singleflight-refresh-"));
    try {
      const { commandCalls, options } = makeCountingDeps();
      const opts = { home: tmp, ...options };

      const p1 = getUsageLimits(opts);
      // local-api.js clears the cache before calling getUsageLimits on refresh=1.
      resetUsageLimitsCache();
      const p2 = getUsageLimits(opts);
      const [r1, r2] = await Promise.all([p1, p2]);

      assert.equal(r1, r2, "refresh arriving mid-flight reuses the in-flight fetch");
      assert.equal(commandCalls.filter((c) => c === kiroProbe).length, 1);

      // Once settled, the in-flight slot is released: a fresh refresh triggers a new round.
      resetUsageLimitsCache();
      await getUsageLimits(opts);
      assert.equal(
        commandCalls.filter((c) => c === kiroProbe).length,
        2,
        "a refresh after settlement must trigger a new fetch round",
      );
    } finally {
      resetUsageLimitsCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runCommand (async)", () => {
  it("returns a spawnSync-shaped result from a real process", async () => {
    const result = await runCommand(
      null,
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);"],
      { timeout: 10_000 },
    );
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.error, undefined);
  });

  it("runs commands concurrently without blocking the event loop", async () => {
    const sleeper = () =>
      runCommand(
        null,
        process.execPath,
        ["-e", "process.stdout.write(String(Date.now())); setTimeout(() => {}, 400);"],
        { timeout: 10_000 },
      );
    const [a, b] = await Promise.all([sleeper(), sleeper()]);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    // With spawnSync, the second process cannot start until the first one's
    // 400ms timer completes. Comparing child start times proves overlap without
    // making the assertion sensitive to overall test-run CPU contention.
    const startDelta = Math.abs(Number(a.stdout) - Number(b.stdout));
    assert.ok(startDelta < 300, `expected overlapping child processes, starts differed by ${startDelta}ms`);
  });

  it("kills the child and reports ETIMEDOUT when the timeout elapses", async () => {
    const started = Date.now();
    const result = await runCommand(
      null,
      process.execPath,
      ["-e", "setTimeout(() => {}, 10_000);"],
      { timeout: 200 },
    );
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.equal(result.status, null);
    assert.ok(Date.now() - started < 3000, "timeout must settle promptly");
  });

  it("wraps a synchronous injected runner's result in a promise", async () => {
    const fake = { status: 0, stdout: "hello\n", stderr: "" };
    const promise = runCommand(() => fake, "anything", []);
    assert.ok(typeof promise.then === "function");
    assert.equal(await promise, fake);
  });
});
