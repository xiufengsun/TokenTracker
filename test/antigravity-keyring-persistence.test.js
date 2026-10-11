const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { fetchAntigravityLimits, writeAntigravityLinuxSecretRaw } = require("../src/lib/usage-limits");
const { runCommand } = require("../src/lib/command-runner");

const NOW = Date.parse("2026-08-31T00:00:00Z");
const ATTRS = ["service", "gemini", "username", "antigravity"];

/** Encode the Secret Service format used by agy's Go keyring adapter. */
function encode(payload, base64) {
  const json = JSON.stringify(payload);
  return base64 ? `go-keyring-base64:${Buffer.from(json).toString("base64")}` : json;
}

/** Decode the stored fixture without assuming the entry used base64. */
function decode(raw) {
  return JSON.parse(raw.startsWith("go-keyring-base64:")
    ? Buffer.from(raw.slice("go-keyring-base64:".length), "base64").toString("utf8")
    : raw);
}

/** Create a temporary home and remove it after the test finishes. */
function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-keyring-write-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Return fixed quota or plan data after checking the renewed bearer token. */
function quotaResponse(url, options, accessToken) {
  assert.equal(options.headers.Authorization, `Bearer ${accessToken}`);
  return { ok: true, status: 200, json: async () => String(url).includes("retrieveUserQuotaSummary")
    ? { groups: [{ buckets: [{ bucketId: "3p-weekly", remainingFraction: 0.75, resetTime: "2099-01-01T00:00:00Z" }] }] }
    : { paidTier: { name: "Google AI Pro" } } };
}

for (const base64 of [false, true]) {
  test(`two polls preserve rotated refresh tokens (${base64 ? "base64" : "JSON"} entry)`, async (t) => {
    const home = tempHome(t);
    let stored = encode({
      token: { access_token: "access-old", refresh_token: "refresh-old", expiry: "2020-01-01T00:00:00Z" },
      auth_method: "consumer",
      id_token: "fixture-id-token",
    }, base64);
    let writes = 0;
    let refreshes = 0;
    let expectedRefresh = "refresh-old";
    let expectedAccess;
    const secretToolRunner = async (bin, args, options) => {
      assert.equal(bin, "secret-tool");
      if (args[0] === "lookup") {
        assert.deepEqual(args, ["lookup", ...ATTRS]);
        return { status: 0, stdout: stored };
      }
      assert.deepEqual(args, ["store", "--label", "Antigravity", ...ATTRS]);
      assert.equal(args.some((arg) => arg.includes("refresh-")), false, "tokens must not be command arguments");
      assert.equal(typeof options.input, "string", "secret-tool receives its payload on stdin");
      stored = options.input;
      writes += 1;
      return { status: 0, stdout: "" };
    };
    const fetchImpl = async (url, options) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        assert.equal(options.body.get("refresh_token"), expectedRefresh);
        refreshes += 1;
        expectedAccess = `access-new-${refreshes}`;
        expectedRefresh = `refresh-new-${refreshes}`;
        return { ok: true, status: 200, json: async () => ({
          access_token: expectedAccess, refresh_token: expectedRefresh, expires_in: 3600,
        }) };
      }
      return quotaResponse(url, options, expectedAccess);
    };
    const options = { home, platform: "linux", secretToolRunner, fetchImpl, commandRunner: () => ({ status: 1, stdout: "" }) };
    const first = await fetchAntigravityLimits({ ...options, nowMs: NOW });
    assert.equal(first.error, null);
    assert.equal(writes, 1, "refresh must be saved before the next poll");
    assert.equal(stored.startsWith("go-keyring-base64:"), base64, "preserve the keyring encoding");
    assert.equal(decode(stored).token.refresh_token, "refresh-new-1");
    assert.equal(decode(stored).token.expiry, new Date(NOW + 3600_000).toISOString());
    assert.equal(decode(stored).id_token, "fixture-id-token");
    assert.equal(decode(stored).auth_method, "consumer");

    const fresh = await fetchAntigravityLimits({ ...options, nowMs: NOW + 1000 });
    assert.equal(fresh.error, null);
    assert.equal(refreshes, 1, "a fresh saved access token should not refresh again");
    assert.equal(writes, 1);

    const second = await fetchAntigravityLimits({ ...options, nowMs: NOW + 7200_000 });
    assert.equal(second.error, null);
    assert.equal(refreshes, 2, "an expired saved token must use the rotated refresh token");
    assert.equal(writes, 2);
    assert.equal(decode(stored).token.refresh_token, "refresh-new-2");
  });
}

test("a 401 retry uses the token rotated earlier in the same request", async (t) => {
  const home = tempHome(t);
  let stored = JSON.stringify({ token: { access_token: "old", refresh_token: "refresh-old", expiry: "2020-01-01T00:00:00Z" } });
  let refreshes = 0;
  let quotaCalls = 0;
  const result = await fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async (_bin, args, options) => {
      if (args[0] === "store") stored = options.input;
      return { status: 0, stdout: stored };
    },
    commandRunner: () => ({ status: 1, stdout: "" }),
    async fetchImpl(url, options) {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        assert.equal(options.body.get("refresh_token"), refreshes === 0 ? "refresh-old" : "refresh-rotated");
        refreshes += 1;
        return { ok: true, status: 200, json: async () => ({
          access_token: `renewed-${refreshes}`, refresh_token: "refresh-rotated", expires_in: 3600,
        }) };
      }
      if (String(url).includes("retrieveUserQuotaSummary") && quotaCalls++ === 0) return { ok: false, status: 401 };
      return quotaResponse(url, options, "renewed-2");
    },
  });
  assert.equal(result.error, null);
  assert.equal(refreshes, 2);
  assert.equal(decode(stored).token.access_token, "renewed-2");
});

test("refresh does not overwrite credentials changed by another process", async (t) => {
  const home = tempHome(t);
  const newer = { token: { access_token: "other-access", refresh_token: "other-refresh", expiry: "2099-01-01T00:00:00Z" } };
  let stored = JSON.stringify({ token: { access_token: "old", refresh_token: "refresh-old", expiry: "2020-01-01T00:00:00Z" } });
  let writes = 0;
  const result = await fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async (_bin, args) => {
      if (args[0] === "store") writes += 1;
      return { status: 0, stdout: stored };
    },
    commandRunner: () => ({ status: 1, stdout: "" }),
    async fetchImpl(url, options) {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        stored = JSON.stringify(newer);
        return { ok: true, status: 200, json: async () => ({ access_token: "renewed", refresh_token: "rotated", expires_in: 3600 }) };
      }
      return quotaResponse(url, options, "renewed");
    },
  });
  assert.equal(result.error, null);
  assert.equal(writes, 0);
  assert.deepEqual(decode(stored), newer);
});

test("refresh does not recreate an entry removed during sign-out", async (t) => {
  const home = tempHome(t);
  let signedOut = false;
  let writes = 0;
  const result = await fetchAntigravityLimits({
    home, platform: "linux", nowMs: NOW,
    secretToolRunner: async (_bin, args) => {
      if (args[0] === "store") writes += 1;
      return signedOut ? { status: 1, stdout: "" } : {
        status: 0, stdout: JSON.stringify({ token: { access_token: "old", refresh_token: "refresh-old", expiry: "2020-01-01T00:00:00Z" } }),
      };
    },
    commandRunner: () => ({ status: 1, stdout: "" }),
    async fetchImpl(url, options) {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        signedOut = true;
        return { ok: true, status: 200, json: async () => ({ access_token: "renewed", refresh_token: "rotated", expires_in: 3600 }) };
      }
      return quotaResponse(url, options, "renewed");
    },
  });
  assert.equal(result.error, null);
  assert.equal(writes, 0);
});

test("the command runner writes input to stdin rather than argv", async () => {
  const input = "synthetic-secret-with-quotes-\"";
  const result = await runCommand(null, process.execPath, [
    "-e",
    "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => process.stdout.write(input));",
  ], { input, timeout: 2000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, input);
});

test("the native Secret Service writer receives payload on stdin", { skip: process.platform !== "linux" }, async (t) => {
  const home = tempHome(t);
  const output = path.join(home, "stored.txt");
  const input = "go-keyring-base64:synthetic-payload";
  const spawn = cp.spawn;
  let spawned = false;
  t.mock.method(cp, "spawn", (bin, args, options) => {
    assert.equal(bin, "secret-tool");
    assert.deepEqual(args, ["store", "--label", "Antigravity", ...ATTRS]);
    assert.equal(options.stdio[0], "pipe");
    assert.equal(options.input, undefined, "do not forward the payload as a spawn option");
    spawned = true;
    return spawn(process.execPath, [
      "-e",
      "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => require('node:fs').writeFileSync(process.argv[1], input));",
      output,
    ], options);
  });
  assert.equal(await writeAntigravityLinuxSecretRaw(input), true);
  assert.equal(spawned, true);
  assert.equal(fs.readFileSync(output, "utf8"), input);
});

test("cancelling a native keyring write terminates its subprocess", { skip: process.platform !== "linux", timeout: 3000 }, async (t) => {
  const spawn = cp.spawn;
  let child;
  let closed;
  t.mock.method(cp, "spawn", (bin, args, options) => {
    assert.equal(bin, "secret-tool");
    assert.deepEqual(args, ["store", "--label", "Antigravity", ...ATTRS]);
    child = spawn(process.execPath, ["-e", "process.stdin.resume(); setTimeout(() => {}, 10000);"], options);
    closed = new Promise((resolve) => child.once("close", resolve));
    return child;
  });
  t.after(() => { if (child?.exitCode === null) child.kill("SIGKILL"); });
  const controller = new AbortController();
  const pending = writeAntigravityLinuxSecretRaw("fixture", { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, false);
  assert.ok(child);
  await closed;
  assert.ok(child.signalCode);
});

test("keyring writes settle on timeout even when the injected runner hangs", async () => {
  let signal;
  const started = Date.now();
  assert.equal(await writeAntigravityLinuxSecretRaw("fixture", {
    timeoutMs: 30,
    secretToolRunner(_bin, _args, options) { signal = options.signal; return new Promise(() => {}); },
  }), false);
  assert.ok(Date.now() - started < 500);
  assert.equal(signal.aborted, true);
});

test("writer errors and nonzero exits report failure without throwing", async () => {
  assert.equal(await writeAntigravityLinuxSecretRaw("fixture", { secretToolRunner() { throw new Error("missing"); } }), false);
  assert.equal(await writeAntigravityLinuxSecretRaw("fixture", { secretToolRunner: async () => ({ status: 1 }) }), false);
  assert.equal(await writeAntigravityLinuxSecretRaw("fixture", { secretToolRunner: async () => ({ error: new Error("ENOENT") }) }), false);
});

test("an aborted keyring write does not start a subprocess", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  assert.equal(await writeAntigravityLinuxSecretRaw("fixture", {
    signal: controller.signal,
    secretToolRunner() { calls += 1; return { status: 0 }; },
  }), false);
  assert.equal(calls, 0);
});
