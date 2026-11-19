const assert = require("node:assert/strict");
const { it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fetchAntigravityLimits, normalizeAntigravityQuotaSummary, cacheExpiresAtMs } = require("./helpers/usage-limits");

const reset = "2030-01-01T00:00:00Z";
const cliPayload = {
  status: "SUCCESS",
  num_turns: 0,
  command: { name: "usage", data: { groups: [{ buckets: [
    { id: "3p-weekly", remaining_fraction: 0.58, reset_time: reset },
    { id: "3p-5h", remaining_fraction: 0.82, reset_time: reset },
    { id: "gemini-weekly", remaining_fraction: 0.40, reset_time: reset },
    { id: "gemini-5h", remaining_fraction: 0.90, reset_time: reset },
    { id: "gemini-argon-wtu-weekly", remaining_fraction: 0.73, reset_time: reset },
  ] }] } },
};

function installFakeAgy(home, platform = "win32") {
  const executable = platform === "win32"
    ? path.join(home, "AppData", "Local", "agy", "bin", "agy.exe")
    : path.join(home, ".local", "bin", "agy");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, "fixture", { mode: 0o755 });
  return fs.realpathSync(executable);
}

function runnerFor(payload, calls, home, version = "1.5.9") {
  const agy = installFakeAgy(home);
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "powershell.exe") {
      return { status: 0, stdout: JSON.stringify([{ ProcessId: 654, CommandLine: `"${agy}"` }]) };
    }
    if (command === agy && args[0] === "--version") return { status: 0, stdout: `${version}\n` };
    if (command === agy) return { status: 0, stdout: JSON.stringify(payload) };
    if (command === "netstat.exe") {
      return { status: 0, stdout: "TCP  127.0.0.1:51234  0.0.0.0:0  LISTENING  654" };
    }
    throw new Error(`Unexpected command ${command}`);
  };
}

it("reads Windows agy quota with the CLI when its local RPC requires CSRF", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-win-cli-"));
  const calls = [];
  try {
    const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{"disableSlashCommands":true}');
    const result = await fetchAntigravityLimits({
      home,
      platform: "win32",
      commandRunner: runnerFor(cliPayload, calls, home),
      requestFn() { throw new Error("unauthenticated: missing CSRF token"); },
    });
    assert.equal(result.error, null);
    assert.equal(result.primary_window.used_percent, 42);
    assert.equal(result.secondary_window.used_percent, 18);
    assert.equal(result.tertiary_window.used_percent, 60);
    assert.equal(result.quaternary_window.used_percent, 10);
    assert.equal(result.argon_weekly_window.used_percent, 27);
    assert.equal(result.primary_window.reset_at, "2030-01-01T00:00:00.000Z");
    const cli = calls.find((call) => call.args.includes("/usage"));
    assert.deepEqual(cli.args, ["--settings", '{"disableSlashCommands":false}', "-p", "/usage", "--output-format", "json"]);
    assert.equal(cli.options.windowsHide, true);
    assert.equal(cli.options.useShell, false);
    assert.ok(!calls.some((call) => call.command === "netstat.exe"));
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), { disableSlashCommands: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("falls back to the local RPC when Windows agy emits invalid quota data", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-win-fallback-"));
  const calls = [];
  try {
    const malformed = { ...cliPayload, command: { data: { groups: [{ buckets: [
      { id: "3p-weekly", remaining_fraction: 1.5, reset_time: reset },
    ] }] } } };
    const result = await fetchAntigravityLimits({
      home,
      platform: "win32",
      commandRunner: runnerFor(malformed, calls, home),
      requestFn({ path: rpc }) {
        if (rpc.endsWith("GetUnleashData")) return { code: 0 };
        if (rpc.endsWith("RetrieveUserQuotaSummary")) return { groups: [{ buckets: [
          { bucketId: "3p-weekly", remainingFraction: 0.5, resetTime: reset },
        ] }] };
        throw new Error(`Unexpected RPC ${rpc}`);
      },
    });
    assert.equal(result.error, null);
    assert.equal(result.primary_window.used_percent, 50);
    assert.ok(calls.some((call) => call.args.includes("/usage")));
    assert.ok(calls.some((call) => call.command === "netstat.exe"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("does not execute an agy binary found outside the per-user installation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-untrusted-"));
  const calls = [];
  try {
    const trusted = installFakeAgy(home);
    const other = path.join(home, "other-user", "agy.exe");
    const result = await fetchAntigravityLimits({ home, platform: "win32", commandRunner(command, args) {
      calls.push({ command, args });
      if (command === "powershell.exe") return { status: 0, stdout: JSON.stringify([{ ProcessId: 654, CommandLine: `"${other}"` }]) };
      if (command === "netstat.exe") return { status: 0, stdout: "TCP  127.0.0.1:51234  0.0.0.0:0  LISTENING  654" };
      throw new Error("untrusted executable must not be run");
    }, requestFn({ path: rpc }) {
      if (rpc.endsWith("GetUnleashData")) return { code: 0 };
      if (rpc.endsWith("RetrieveUserQuotaSummary")) return { groups: [{ buckets: [
        { bucketId: "3p-weekly", remainingFraction: 0.5, resetTime: reset },
      ] }] };
      throw new Error("unexpected RPC");
    } });
    assert.equal(result.primary_window.used_percent, 50);
    assert.ok(!calls.some((call) => call.command === other || call.command === trusted));
    const scan = calls.find((call) => call.command === "powershell.exe");
    assert.match(scan.args.at(-1), /GetOwnerSid/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("rejects a symlinked CLI outside the per-user installation", { skip: process.platform === "win32" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-symlink-"));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-foreign-"));
  try {
    const executable = path.join(home, ".local", "bin", "agy");
    const target = path.join(foreign, "agy");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(target, "fixture", { mode: 0o755 });
    fs.symlinkSync(target, executable);
    const calls = [];
    await fetchAntigravityLimits({ home, platform: "linux", commandRunner(command, args) {
      calls.push({ command, args });
      if (command === "/bin/ps") return { status: 0, stdout: `123 ${executable}\n` };
      return { status: 1, stdout: "" };
    } });
    assert.ok(!calls.some((call) => call.command === executable || call.command === target));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

it("reserves fallback time and uses the IDE when a CLI read times out", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-ide-fallback-"));
  const calls = [];
  try {
    const executable = installFakeAgy(home);
    const result = await fetchAntigravityLimits({ home, platform: "win32", providerTimeoutMs: 1200,
      async commandRunner(command, args, options) {
        calls.push({ command, args, options });
        if (command === "powershell.exe") return { status: 0, stdout: JSON.stringify([
          { ProcessId: 654, CommandLine: `"${executable}"` },
          { ProcessId: 999, CommandLine: '"C:\\Antigravity\\language_server_windows_x64.exe" --app_data_dir antigravity --csrf_token fixture' },
        ]) };
        if (command === executable && args[0] === "--version") return { status: 0, stdout: "1.5.9" };
        if (command === executable) {
          await new Promise((resolve) => setTimeout(resolve, options.timeout));
          return { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) };
        }
        if (command === "netstat.exe") return { status: 0, stdout: "TCP  127.0.0.1:51234  0.0.0.0:0  LISTENING  999" };
        throw new Error("unexpected command");
      }, requestFn({ path: rpc }) {
        if (rpc.endsWith("GetUnleashData")) return { code: 0 };
        if (rpc.endsWith("RetrieveUserQuotaSummary")) return { groups: [{ buckets: [
          { bucketId: "3p-weekly", remainingFraction: 0.5, resetTime: reset },
        ] }] };
        throw new Error("unexpected RPC");
      } });
    assert.equal(result.primary_window.used_percent, 50);
    assert.ok(calls.some((call) => call.command === "netstat.exe"));
    const cli = calls.find((call) => call.args.includes("/usage"));
    assert.ok(cli.options.timeout < 1000, "CLI must leave part of the provider budget for fallback");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("still reaches the IDE when the CLI fails and the remote request hangs", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-timeout-"));
  try {
    const executable = installFakeAgy(home);
    const dir = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({
      token: { access_token: "fixture", expiry: "2099-01-01T00:00:00Z" },
    }));
    const result = await fetchAntigravityLimits({ home, platform: "win32", providerTimeoutMs: 1200,
      commandRunner(command, args) {
        if (command === "powershell.exe") return { status: 0, stdout: JSON.stringify([
          { ProcessId: 654, CommandLine: `"${executable}"` },
          { ProcessId: 999, CommandLine: '"C:\\Antigravity\\language_server_windows_x64.exe" --app_data_dir antigravity --csrf_token fixture' },
        ]) };
        if (command === executable && args[0] === "--version") return { status: 0, stdout: "1.5.9" };
        if (command === executable) return { status: 1, stdout: "" };
        if (command === "netstat.exe") return { status: 0, stdout: "TCP  127.0.0.1:51234  0.0.0.0:0  LISTENING  999" };
        throw new Error("unexpected command");
      }, fetchImpl() { return new Promise(() => {}); }, requestFn({ path: rpc }) {
        if (rpc.endsWith("GetUnleashData")) return { code: 0 };
        if (rpc.endsWith("RetrieveUserQuotaSummary")) return { groups: [{ buckets: [
          { bucketId: "3p-weekly", remainingFraction: 0.5, resetTime: reset },
        ] }] };
        throw new Error("unexpected RPC");
      } });
    assert.equal(result.primary_window.used_percent, 50);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("does not issue a prompt on agy versions predating read-only slash commands", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-old-cli-"));
  const calls = [];
  try {
    const result = await fetchAntigravityLimits({
      home, platform: "win32", commandRunner: runnerFor(cliPayload, calls, home, "1.1.10"),
      requestFn({ path: rpc }) {
        if (rpc.endsWith("GetUnleashData")) return { code: 0 };
        if (rpc.endsWith("RetrieveUserQuotaSummary")) return { groups: [{ buckets: [
          { bucketId: "3p-weekly", remainingFraction: 0.5, resetTime: reset },
        ] }] };
        throw new Error("unexpected RPC");
      },
    });
    assert.equal(result.primary_window.used_percent, 50);
    assert.ok(calls.some((call) => call.args[0] === "--version"));
    assert.ok(!calls.some((call) => call.args.includes("/usage")));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("keeps Argon optional and never turns malformed fractions into full or empty quota", () => {
  const wrap = (bucket) => ({ groups: [{ buckets: [bucket] }] });
  const onlyArgon = normalizeAntigravityQuotaSummary(wrap({
    bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0, resetTime: reset,
  }));
  assert.equal(onlyArgon.argon_weekly_window.used_percent, 100);
  const missing = normalizeAntigravityQuotaSummary(wrap({
    bucketId: "gemini-weekly", remainingFraction: 0.6, resetTime: reset,
  }));
  assert.equal(missing.argon_weekly_window, undefined);
  assert.throws(() => normalizeAntigravityQuotaSummary(wrap({
    bucketId: "gemini-argon-wtu-weekly", remainingFraction: 1.5, resetTime: reset,
  })), /no known buckets/);
});

it("persists the Argon window in the last-good cache and expires it at reset", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-argon-cache-"));
  const calls = [];
  try {
    const nowMs = Date.parse("2029-12-31T23:00:00Z");
    const live = await fetchAntigravityLimits({ home, platform: "win32", nowMs, commandRunner: runnerFor(cliPayload, calls, home) });
    assert.equal(live.argon_weekly_window.used_percent, 27);
    const offline = () => ({ status: 1, stdout: "" });
    const cached = await fetchAntigravityLimits({ home, platform: "win32", nowMs: nowMs + 60_000, commandRunner: offline });
    assert.equal(cached.cached, true);
    assert.equal(cached.argon_weekly_window.used_percent, 27);
    const expired = await fetchAntigravityLimits({ home, platform: "win32", nowMs: Date.parse("2030-01-01T00:00:01Z"), commandRunner: offline });
    assert.equal(expired.argon_weekly_window, undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("retains an Argon-only snapshot and refreshes at its reset", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-argon-only-"));
  try {
    const nowMs = Date.parse("2029-12-31T23:59:00Z");
    const payload = { ...cliPayload, command: { name: "usage", data: { groups: [{ buckets: [
      { id: "gemini-argon-wtu-weekly", remaining_fraction: 1, reset_time: reset },
    ] }] } } };
    const live = await fetchAntigravityLimits({ home, platform: "win32", nowMs, commandRunner: runnerFor(payload, [], home) });
    assert.equal(live.argon_weekly_window.used_percent, 0);
    assert.equal(cacheExpiresAtMs({ antigravity: live }, nowMs), Date.parse(reset));
    const cached = await fetchAntigravityLimits({ home, platform: "win32", nowMs: nowMs + 5000,
      commandRunner: () => ({ status: 1, stdout: "" }) });
    assert.equal(cached.cached, true);
    assert.equal(cached.argon_weekly_window.used_percent, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("uses a running CLI snapshot without mixing a different saved remote account", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-precedence-"));
  try {
    const dir = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({
      token: { access_token: "fixture", expiry: "2099-01-01T00:00:00Z" },
    }));
    let remoteCalls = 0;
    const result = await fetchAntigravityLimits({ home, platform: "win32", commandRunner: runnerFor(cliPayload, [], home),
      fetchImpl() { remoteCalls++; throw new Error("must not combine accounts"); } });
    assert.equal(result.argon_weekly_window.used_percent, 27);
    assert.equal(result.tertiary_window.used_percent, 60);
    assert.equal(remoteCalls, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("uses the installed Windows CLI when it is closed and no remote credential is available", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-closed-"));
  try {
    const executable = installFakeAgy(home);
    const calls = [];
    const result = await fetchAntigravityLimits({ home, platform: "win32", commandRunner(command, args, options) {
      calls.push({ command, args, options });
      if (command === "powershell.exe") return { status: 0, stdout: "[]" };
      if (command === executable && args[0] === "--version") return { status: 0, stdout: "1.1.11" };
      if (command === executable) return { status: 0, stdout: JSON.stringify(cliPayload) };
      throw new Error("unexpected command");
    } });
    assert.equal(result.argon_weekly_window.used_percent, 27);
    assert.ok(calls.some((call) => call.command === executable && call.args.includes("/usage")));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("reads Argon from a remote quota summary without requiring a CLI process", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-remote-argon-"));
  try {
    const dir = path.join(home, ".gemini", "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({
      token: { access_token: "fixture", expiry: "2099-01-01T00:00:00Z" },
    }));
    const result = await fetchAntigravityLimits({ home, platform: "win32", commandRunner: () => ({ status: 1, stdout: "" }),
      async fetchImpl(url) {
        if (String(url).includes("retrieveUserQuotaSummary")) return { ok: true, status: 200, async json() {
          return { groups: [{ buckets: [{ bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.73, resetTime: reset }] }] };
        } };
        return { ok: true, status: 200, async json() { return {}; } };
      },
    });
    assert.equal(result.argon_weekly_window.used_percent, 27);
    assert.equal(result.primary_window, null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("does not launch or read the CLI when Antigravity quota is disabled", async () => {
  const previous = process.env.TOKENTRACKER_DISABLE_ANTIGRAVITY_QUOTA;
  process.env.TOKENTRACKER_DISABLE_ANTIGRAVITY_QUOTA = "1";
  try {
    const result = await fetchAntigravityLimits({ commandRunner() { throw new Error("unexpected process"); } });
    assert.equal(result.configured, false);
  } finally {
    if (previous === undefined) delete process.env.TOKENTRACKER_DISABLE_ANTIGRAVITY_QUOTA;
    else process.env.TOKENTRACKER_DISABLE_ANTIGRAVITY_QUOTA = previous;
  }
});

it("uses the same read-only CLI path for a running Unix agy process", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-unix-"));
  try {
    const executable = installFakeAgy(home, "linux");
    const calls = [];
    const result = await fetchAntigravityLimits({ home, platform: "linux", commandRunner(command, args) {
      calls.push({ command, args });
      if (command === "/bin/ps") return { status: 0, stdout: `123 ${executable}\n` };
      if (command === executable && args[0] === "--version") return { status: 0, stdout: "1.5.9" };
      if (command === executable) return { status: 0, stdout: JSON.stringify(cliPayload) };
      throw new Error("unexpected command");
    } });
    assert.equal(result.argon_weekly_window.used_percent, 27);
    assert.ok(calls.some((call) => call.command === executable && call.args.includes("/usage")));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it("recognizes a current-user agy launched by name while executing only the trusted install", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-unix-path-"));
  try {
    const executable = installFakeAgy(home, "linux");
    const calls = [];
    const result = await fetchAntigravityLimits({ home, platform: "linux", commandRunner(command, args) {
      calls.push({ command, args });
      if (command === "/bin/ps") return { status: 0, stdout: "123 agy\n" };
      if (command === executable && args[0] === "--version") return { status: 0, stdout: "1.5.9" };
      if (command === executable) return { status: 0, stdout: JSON.stringify(cliPayload) };
      throw new Error("unexpected command");
    } });
    assert.equal(result.argon_weekly_window.used_percent, 27);
    assert.ok(calls.some((call) => call.command === executable && call.args.includes("/usage")));
    assert.ok(!calls.some((call) => call.command === "agy"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
