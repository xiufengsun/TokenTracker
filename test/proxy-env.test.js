const assert = require("node:assert/strict");
const test = require("node:test");

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseMacProxyOutput,
  pickProxyUrl,
  resolveSystemProxyEnv,
  relaunchWithProxyEnvIfNeeded,
  applyUndiciProxyIfNeeded,
  createProxyDispatcher,
  runProxyConnectivityTest,
  getLastProxyApplyError,
  resetProxyApplyStateForTests,
  invalidateSystemProxyCache,
  resolveEffectiveProxySource,
} = require("../src/lib/proxy-env");

test("parseMacProxyOutput extracts enabled HTTPS system proxy", () => {
  const output = `
<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
}
`;

  assert.equal(parseMacProxyOutput(output), "http://127.0.0.1:7897");
});

test("resolveSystemProxyEnv enables Node env proxy for explicit proxy env", () => {
  assert.deepEqual(
    resolveSystemProxyEnv({
      env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
      platform: "linux",
    }),
    { NODE_USE_ENV_PROXY: "1" },
  );
});

test("resolveSystemProxyEnv reads macOS system proxy when no proxy env exists", () => {
  resetProxyApplyStateForTests();
  const result = resolveSystemProxyEnv({
    env: {},
    platform: "darwin",
    commandRunner(command, args) {
      assert.equal(command, "scutil");
      assert.deepEqual(args, ["--proxy"]);
      return {
        status: 0,
        stdout: "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n",
      };
    },
  });

  assert.deepEqual(result, {
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    HTTP_PROXY: "http://127.0.0.1:7897",
  });
});

test("relaunchWithProxyEnvIfNeeded only relaunches serve-like commands once", () => {
  resetProxyApplyStateForTests();
  const calls = [];
  const result = relaunchWithProxyEnvIfNeeded({
    argv: ["serve", "--no-open"],
    originalArgv: ["bin/tracker.js", "serve", "--no-open"],
    env: {},
    platform: "darwin",
    nodePath: "/usr/local/bin/node",
    commandRunner(command, args, options) {
      calls.push({ command, args, options });
      if (command === "scutil") {
        return {
          status: 0,
          stdout: "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\n",
        };
      }
      return { status: 0 };
    },
  });

  assert.deepEqual(result, { status: 0 });
  assert.equal(calls[1].command, "/usr/local/bin/node");
  assert.deepEqual(calls[1].args, ["bin/tracker.js", "serve", "--no-open"]);
  assert.equal(calls[1].options.env.NODE_USE_ENV_PROXY, "1");
  assert.equal(calls[1].options.env.HTTPS_PROXY, "http://127.0.0.1:7897");
  assert.equal(calls[1].options.env.TOKENTRACKER_PROXY_ENV_APPLIED, "1");

  const skipped = relaunchWithProxyEnvIfNeeded({
    argv: ["serve"],
    env: { TOKENTRACKER_PROXY_ENV_APPLIED: "1" },
    platform: "darwin",
    commandRunner() {
      throw new Error("should not run");
    },
  });
  assert.equal(skipped, null);
});

test("pickProxyUrl honors uppercase, lowercase, and ALL_PROXY env vars", () => {
  assert.equal(pickProxyUrl({}), null);
  assert.equal(pickProxyUrl({ HTTPS_PROXY: "http://h:1" }), "http://h:1");
  assert.equal(pickProxyUrl({ https_proxy: "http://l:2" }), "http://l:2");
  assert.equal(pickProxyUrl({ HTTP_PROXY: "http://h:3" }), "http://h:3");
  assert.equal(pickProxyUrl({ ALL_PROXY: "socks5://a:4" }), "socks5://a:4");
  // HTTPS_PROXY beats HTTP_PROXY when both are set
  assert.equal(
    pickProxyUrl({ HTTPS_PROXY: "http://h:1", HTTP_PROXY: "http://h:9" }),
    "http://h:1",
  );
});

test("applyUndiciProxyIfNeeded sets a ProxyAgent dispatcher when proxy env exists", () => {
  let captured = null;
  const FakeAgent = function (url) {
    this.url = url;
    captured = this;
  };
  const setter = (dispatcher) => {
    captured = dispatcher;
  };

  resetProxyApplyStateForTests();
  const result = applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
    setGlobalDispatcher: setter,
    ProxyAgent: FakeAgent,
    Agent: function () {},
  });

  assert.deepEqual(result, { ok: true, proxyUrl: "http://127.0.0.1:7897" });
  assert.ok(captured instanceof FakeAgent);
  assert.equal(captured.url, "http://127.0.0.1:7897");
});

test("applyUndiciProxyIfNeeded is a no-op when no env and no system proxy exist", () => {
  resetProxyApplyStateForTests();
  let called = false;
  const result = applyUndiciProxyIfNeeded({
    env: {},
    platform: "linux",
    commandRunner() {
      throw new Error("scutil must not run off darwin");
    },
    setGlobalDispatcher: () => {
      called = true;
    },
    ProxyAgent: function () {},
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("applyUndiciProxyIfNeeded in system mode uses the scutil proxy when env is empty", () => {
  resetProxyApplyStateForTests();
  let captured = null;
  let probes = 0;
  function FakeAgent(url) {
    this.url = url;
    captured = this;
  }
  const result = applyUndiciProxyIfNeeded({
    env: {},
    platform: "darwin",
    commandRunner() {
      probes += 1;
      return {
        status: 0,
        stdout: "HTTPSEnable : 1\nHTTPSProxy : 192.168.1.1\nHTTPSPort : 8118\n",
      };
    },
    setGlobalDispatcher: (dispatcher) => {
      captured = dispatcher;
    },
    ProxyAgent: FakeAgent,
    Agent: function () {},
    proxyConfig: { mode: "system" },
  });
  assert.deepEqual(result, { ok: true, proxyUrl: "http://192.168.1.1:8118" });
  assert.ok(captured instanceof FakeAgent);
  assert.equal(captured.url, "http://192.168.1.1:8118");
  assert.equal(probes, 1);
});

test("applyUndiciProxyIfNeeded swallows ProxyAgent construction errors in env mode", () => {
  resetProxyApplyStateForTests();
  const warnings = [];
  const result = applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "not-a-url" },
    setGlobalDispatcher: () => {},
    ProxyAgent: function () {
      throw new Error("bad url");
    },
    Agent: function () {},
    warn: (msg) => warnings.push(msg),
  });
  assert.equal(result, null);
  assert.equal(warnings.length, 0);
  assert.equal(getLastProxyApplyError(), null);
});

test("applyUndiciProxyIfNeeded installs a fail-closed dispatcher on manual construction failure", () => {
  resetProxyApplyStateForTests();
  const warnings = [];
  let installed = null;
  function DirectAgent() {
    this.direct = true;
  }
  const result = applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: (dispatcher) => {
      installed = dispatcher;
    },
    ProxyAgent: function () {
      throw new Error("bad url");
    },
    Agent: DirectAgent,
    warn: (msg) => warnings.push(msg),
    proxyConfig: { mode: "manual", protocol: "socks5", host: "127.0.0.1", port: 7890 },
  });
  assert.deepEqual(result, { ok: false, error: "bad url" });
  assert.ok(installed);
  assert.equal(installed instanceof DirectAgent, false);
  assert.equal(typeof installed.dispatch, "function");
  assert.equal(getLastProxyApplyError(), "bad url");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /outbound traffic is blocked/);
});

test("applyUndiciProxyIfNeeded prefers a manual config over env vars", () => {
  resetProxyApplyStateForTests();
  let captured = null;
  const FakeAgent = function (url) {
    this.url = url;
    captured = this;
  };
  const result = applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "http://env-proxy:1" },
    setGlobalDispatcher: (dispatcher) => {
      captured = dispatcher;
    },
    ProxyAgent: FakeAgent,
    Agent: function () {},
    proxyConfig: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 },
  });
  assert.deepEqual(result, { ok: true, proxyUrl: "http://127.0.0.1:7890" });
  assert.ok(captured instanceof FakeAgent);
  assert.equal(captured.url, "http://127.0.0.1:7890");
});

test("applyUndiciProxyIfNeeded mode=off installs a direct Agent and ignores env", () => {
  resetProxyApplyStateForTests();
  let captured = null;
  function DirectAgent() {
    this.direct = true;
    captured = this;
  }
  function FakeProxy(url) {
    this.url = url;
    captured = this;
  }
  const result = applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "http://env-proxy:1" },
    setGlobalDispatcher: (dispatcher) => {
      captured = dispatcher;
    },
    ProxyAgent: FakeProxy,
    Agent: DirectAgent,
    proxyConfig: { mode: "off" },
  });
  assert.equal(result, null);
  assert.ok(captured instanceof DirectAgent);
});

test("createProxyDispatcher uses ProxyAgent for http and socks5 URLs", () => {
  const FakeAgent = function (url) {
    this.url = url;
  };
  const socks = createProxyDispatcher("socks5://127.0.0.1:7890", { ProxyAgent: FakeAgent });
  assert.ok(socks instanceof FakeAgent);
  assert.equal(socks.url, "socks5://127.0.0.1:7890");
  const httpDispatcher = createProxyDispatcher("http://127.0.0.1:7890", { ProxyAgent: FakeAgent });
  assert.ok(httpDispatcher instanceof FakeAgent);
});

test("applyUndiciProxyIfNeeded closes the previous owned dispatcher after a successful swap", async () => {
  resetProxyApplyStateForTests();
  const closed = [];
  function FakeAgent(url) {
    this.url = url;
    this.close = async () => {
      closed.push(this.url);
    };
  }
  applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "http://first:1" },
    setGlobalDispatcher: () => {},
    ProxyAgent: FakeAgent,
    Agent: function () {},
  });
  applyUndiciProxyIfNeeded({
    env: { HTTPS_PROXY: "http://second:2" },
    setGlobalDispatcher: () => {},
    ProxyAgent: FakeAgent,
    Agent: function () {},
  });
  await Promise.resolve();
  assert.deepEqual(closed, ["http://first:1"]);
});

test("applyUndiciProxyIfNeeded replaces a working manual dispatcher with fail-closed on later construct failure", async () => {
  resetProxyApplyStateForTests();
  const closed = [];
  let installed = null;
  function GoodAgent(url) {
    this.url = url;
    this.close = async () => {
      closed.push(this.url);
    };
  }
  applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: (dispatcher) => {
      installed = dispatcher;
    },
    ProxyAgent: GoodAgent,
    Agent: function () {},
    proxyConfig: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 1 },
  });
  assert.ok(installed instanceof GoodAgent);
  const failed = applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: (dispatcher) => {
      installed = dispatcher;
    },
    ProxyAgent: function () {
      throw new Error("cannot build");
    },
    Agent: function () {},
    warn: () => {},
    proxyConfig: { mode: "manual", protocol: "socks5", host: "127.0.0.1", port: 2 },
  });
  assert.equal(failed.ok, false);
  assert.equal(installed instanceof GoodAgent, false);
  assert.equal(typeof installed.dispatch, "function");
  await Promise.resolve();
  assert.deepEqual(closed, ["http://127.0.0.1:1"]);
});

test("runProxyConnectivityTest uses a temporary dispatcher and never sets the global", async () => {
  resetProxyApplyStateForTests();
  let setterCalled = false;
  let closed = 0;
  function FakeAgent(url) {
    this.url = url;
    this.close = async () => {
      closed += 1;
    };
  }
  const result = await runProxyConnectivityTest({
    proxyUrl: "socks5://127.0.0.1:7890",
    targetUrl: "https://www.tokentracker.cc",
    fetchImpl: async () => ({ status: 204 }),
    ProxyAgent: FakeAgent,
    Agent: function () {},
    setGlobalDispatcher: () => {
      setterCalled = true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
  assert.equal(setterCalled, false);
  await Promise.resolve();
  assert.equal(closed, 1);
});

test("proxy diagnostics do not stringify unknown exceptions or expose multiline traces", async () => {
  let stringified = false;
  const unknown = { toString() { stringified = true; return "private stack detail"; } };
  const parts = {
    ProxyAgent: function () { this.close = async () => {}; },
    Agent: function () {},
    setGlobalDispatcher: () => {},
  };
  const options = { ...parts, proxyUrl: "http://127.0.0.1:7890", targetUrl: "https://example.test" };
  const failed = await runProxyConnectivityTest({ ...options, fetchImpl: async () => { throw unknown; } });
  assert.equal(failed.error, "Proxy request failed");
  const multiline = await runProxyConnectivityTest({ ...options, fetchImpl: async () => {
    throw new Error("connection failed\n    at private-file.js:1\nprivate stack detail");
  } });
  assert.equal(multiline.error, "connection failed");
  for (const setup of [{ ProxyAgent: function () { throw unknown; } },
    { setGlobalDispatcher: () => { throw unknown; } }]) {
    resetProxyApplyStateForTests();
    const result = applyUndiciProxyIfNeeded({ ...parts, ...setup, env: {}, warn: () => {},
      proxyConfig: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 } });
    assert.equal(result.ok, false);
    assert.ok(!result.error.includes("private stack detail"));
  }
  assert.equal(stringified, false);
  resetProxyApplyStateForTests();
});

test("resolveSystemProxyEnv honors manual and off before env/scutil", () => {
  assert.deepEqual(
    resolveSystemProxyEnv({
      env: { HTTPS_PROXY: "http://env:1" },
      platform: "linux",
      proxyConfig: { mode: "off" },
    }),
    null,
  );
  assert.equal(
    resolveSystemProxyEnv({
      env: { HTTPS_PROXY: "http://env:1" },
      platform: "linux",
      proxyConfig: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 },
    }),
    null,
  );
});

test("createProxyDispatcher constructs a real undici ProxyAgent for socks5", () => {
  const undici = require("undici");
  const dispatcher = createProxyDispatcher("socks5://127.0.0.1:7890", {
    ProxyAgent: undici.ProxyAgent,
  });
  assert.ok(dispatcher instanceof undici.ProxyAgent);
  closeQuietlyForTest(dispatcher);
});

function closeQuietlyForTest(dispatcher) {
  if (dispatcher && typeof dispatcher.close === "function") {
    Promise.resolve(dispatcher.close()).catch(() => {});
  }
}

test("applyUndiciProxyIfNeeded actually swaps the real undici dispatcher", () => {
  const undici = require("undici");
  const previous = undici.getGlobalDispatcher();
  let created = null;
  try {
    resetProxyApplyStateForTests();
    const result = applyUndiciProxyIfNeeded({
      env: { HTTPS_PROXY: "http://127.0.0.1:7897" },
    });
    assert.deepEqual(result, { ok: true, proxyUrl: "http://127.0.0.1:7897" });
    created = undici.getGlobalDispatcher();
    assert.notEqual(created, previous);
    assert.ok(created instanceof undici.ProxyAgent);
  } finally {
    undici.setGlobalDispatcher(previous);
    closeQuietlyForTest(created);
    resetProxyApplyStateForTests();
  }
});

test("resolveSystemProxyEnv returns null in manual mode and does not relaunch", () => {
  const proxyConfig = { mode: "manual", protocol: "socks5", host: "10.0.0.1", port: 1080 };
  assert.equal(
    resolveSystemProxyEnv({
      env: {},
      platform: "linux",
      proxyConfig,
    }),
    null,
  );
  const result = relaunchWithProxyEnvIfNeeded({
    argv: ["serve"],
    originalArgv: ["bin/tracker.js", "serve"],
    env: {},
    platform: "linux",
    nodePath: "/usr/local/bin/node",
    commandRunner() {
      throw new Error("should not relaunch or probe scutil in manual mode");
    },
    proxyConfig,
  });
  assert.equal(result, null);
});

test("switching from manual to system uses the scutil proxy, not the leftover manual URL", () => {
  resetProxyApplyStateForTests();
  const env = {};
  let installed = null;
  function FakeProxy(url) {
    this.url = url;
  }
  function DirectAgent() {
    this.direct = true;
  }
  const setter = (dispatcher) => {
    installed = dispatcher;
  };
  applyUndiciProxyIfNeeded({
    env,
    setGlobalDispatcher: setter,
    ProxyAgent: FakeProxy,
    Agent: DirectAgent,
    proxyConfig: { mode: "manual", protocol: "http", host: "10.0.0.1", port: 1080 },
  });
  assert.ok(installed instanceof FakeProxy);
  assert.equal(installed.url, "http://10.0.0.1:1080");

  // Manual must not have injected HTTPS_PROXY; system then cannot pick it up.
  assert.equal(
    resolveSystemProxyEnv({ env, platform: "linux", proxyConfig: { mode: "manual", protocol: "http", host: "10.0.0.1", port: 1080 } }),
    null,
  );
  assert.equal(env.HTTPS_PROXY, undefined);

  applyUndiciProxyIfNeeded({
    env,
    platform: "darwin",
    commandRunner() {
      return {
        status: 0,
        stdout: "HTTPSEnable : 1\nHTTPSProxy : 192.168.1.1\nHTTPSPort : 8118\n",
      };
    },
    setGlobalDispatcher: setter,
    ProxyAgent: FakeProxy,
    Agent: DirectAgent,
    proxyConfig: { mode: "system" },
  });
  assert.ok(installed instanceof FakeProxy);
  assert.equal(installed.url, "http://192.168.1.1:8118");
  assert.notEqual(installed.url, "http://10.0.0.1:1080");
});

test("switching from manual to system without a system proxy installs a direct Agent", () => {
  resetProxyApplyStateForTests();
  let installed = null;
  function FakeProxy(url) {
    this.url = url;
  }
  function DirectAgent() {
    this.direct = true;
  }
  const setter = (dispatcher) => {
    installed = dispatcher;
  };
  applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: setter,
    ProxyAgent: FakeProxy,
    Agent: DirectAgent,
    proxyConfig: { mode: "manual", protocol: "http", host: "10.0.0.1", port: 1080 },
  });
  applyUndiciProxyIfNeeded({
    env: {},
    platform: "linux",
    setGlobalDispatcher: setter,
    ProxyAgent: FakeProxy,
    Agent: DirectAgent,
    proxyConfig: { mode: "system" },
  });
  assert.ok(installed instanceof DirectAgent);
  assert.notEqual(installed.url, "http://10.0.0.1:1080");
});

test("manual construction failure replaces a live direct dispatcher and blocks requests", async () => {
  const undici = require("undici");
  const previous = undici.getGlobalDispatcher();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  try {
    resetProxyApplyStateForTests();
    const direct = new undici.Agent();
    undici.setGlobalDispatcher(direct);
    const ok = await undici.fetch(url);
    assert.equal(ok.status, 200);
    await ok.body?.cancel?.();

    const result = applyUndiciProxyIfNeeded({
      env: {},
      setGlobalDispatcher: undici.setGlobalDispatcher,
      ProxyAgent: function () {
        throw new Error("bad url");
      },
      Agent: undici.Agent,
      warn: () => {},
      proxyConfig: { mode: "manual", protocol: "socks5", host: "127.0.0.1", port: 7890 },
    });
    assert.equal(result.ok, false);
    const current = undici.getGlobalDispatcher();
    assert.notEqual(current, direct);

    await assert.rejects(
      () => undici.fetch(url, { signal: AbortSignal.timeout(2000) }),
    );
  } finally {
    undici.setGlobalDispatcher(previous);
    resetProxyApplyStateForTests();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("scutil system-proxy probe is cached within the TTL including null results", () => {
  resetProxyApplyStateForTests();
  let probes = 0;
  const runner = () => {
    probes += 1;
    return {
      status: 0,
      stdout: "HTTPSEnable : 1\nHTTPSProxy : 10.0.0.9\nHTTPSPort : 9\n",
    };
  };
  const first = applyUndiciProxyIfNeeded({
    env: {},
    platform: "darwin",
    commandRunner: runner,
    setGlobalDispatcher: () => {},
    ProxyAgent: function (url) { this.url = url; },
    Agent: function () {},
    proxyConfig: { mode: "system" },
  });
  const second = resolveEffectiveProxySource({
    env: {},
    platform: "darwin",
    commandRunner: runner,
    proxyConfig: { mode: "system" },
  });
  assert.deepEqual(first, { ok: true, proxyUrl: "http://10.0.0.9:9" });
  assert.equal(second.proxyUrl, "http://10.0.0.9:9");
  assert.equal(second.source, "system");
  assert.equal(probes, 1);

  invalidateSystemProxyCache();
  resolveEffectiveProxySource({
    env: {},
    platform: "darwin",
    commandRunner: runner,
    proxyConfig: { mode: "system" },
  });
  assert.equal(probes, 2);
});

test("scutil cache stores a negative result so missing system proxy is not re-probed", () => {
  resetProxyApplyStateForTests();
  let probes = 0;
  const runner = () => {
    probes += 1;
    return { status: 0, stdout: "HTTPSEnable : 0\n" };
  };
  const first = resolveEffectiveProxySource({
    env: {},
    platform: "darwin",
    commandRunner: runner,
    proxyConfig: { mode: "system" },
  });
  const second = resolveEffectiveProxySource({
    env: {},
    platform: "darwin",
    commandRunner: runner,
    proxyConfig: { mode: "system" },
  });
  assert.equal(first.source, "none");
  assert.equal(second.source, "none");
  assert.equal(probes, 1);
});

test("invalid persisted manual config fail-closes and records applyError", () => {
  resetProxyApplyStateForTests();
  const warnings = [];
  let installed = null;
  function DirectAgent() {
    this.direct = true;
  }
  const result = applyUndiciProxyIfNeeded({
    env: {},
    platform: "linux",
    setGlobalDispatcher: (dispatcher) => {
      installed = dispatcher;
    },
    ProxyAgent: function (url) { this.url = url; },
    Agent: DirectAgent,
    warn: (msg) => warnings.push(msg),
    proxyConfig: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 99999 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.unprotected, undefined);
  assert.match(result.error, /invalid port|invalid manual proxy config/);
  assert.equal(installed instanceof DirectAgent, false);
  assert.equal(typeof installed.dispatch, "function");
  assert.ok(getLastProxyApplyError());
  assert.equal(warnings.length, 1);
});

test("fail-closed install failure returns unprotected: true", () => {
  resetProxyApplyStateForTests();
  const result = applyUndiciProxyIfNeeded({
    env: {},
    setGlobalDispatcher: () => {
      throw new Error("cannot install dispatcher");
    },
    ProxyAgent: function (url) { this.url = url; },
    Agent: function () {},
    warn: () => {},
    proxyConfig: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 7890 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.unprotected, true);
  assert.ok(result.error);
  assert.ok(getLastProxyApplyError());
});

test("bin/tracker.js aborts when apply reports unprotected", () => {
  const src = fs.readFileSync(path.join(__dirname, "../bin/tracker.js"), "utf8");
  assert.match(src, /unprotected\s*===\s*true/);
  assert.match(src, /process\.exit\(1\)/);
  assert.match(src, /手动代理无法生效且无法阻断出站流量，已中止/);
  assert.match(src, /outbound traffic could not be blocked/);
});

test("fail-closed manual configs report effective 'blocked', never 'none'", () => {
  resetProxyApplyStateForTests();
  // Corrupt manual config: normalizes back to system, but apply() fail-closes,
  // so the UI must not be told traffic is flowing directly.
  const corrupt = resolveEffectiveProxySource({
    env: {},
    platform: "darwin",
    commandRunner: () => ({ status: 0, stdout: "HTTPSEnable : 1\nHTTPSProxy : 10.0.0.9\nHTTPSPort : 9\n" }),
    proxyConfig: { mode: "manual", protocol: "http", host: "127.0.0.1", port: 99999 },
  });
  assert.equal(corrupt.source, "blocked");
  assert.equal(corrupt.proxyUrl, null);

  // Manual config that normalizes but cannot build a URL (malformed colon host).
  const unbuildable = resolveEffectiveProxySource({
    env: {},
    platform: "linux",
    proxyConfig: { mode: "manual", protocol: "http", host: "1:2:3", port: 1080 },
  });
  assert.equal(unbuildable.source, "blocked");

  // A usable manual config is unaffected.
  const good = resolveEffectiveProxySource({
    env: {},
    platform: "linux",
    proxyConfig: { mode: "manual", protocol: "socks5", host: "127.0.0.1", port: 1080 },
  });
  assert.equal(good.source, "manual");
  assert.equal(good.proxyUrl, "socks5://127.0.0.1:1080");
  resetProxyApplyStateForTests();
});
