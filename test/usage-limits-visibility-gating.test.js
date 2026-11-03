const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  getUsageLimits,
  normalizeHiddenProviders,
  resetUsageLimitsCache,
  USAGE_LIMITS_PROVIDER_IDS,
} = require("./helpers/usage-limits");

// Counting deps: with every provider hidden the aggregate must not touch the
// network, spawn a subprocess, or read the host keyring — that is the whole
// point of the visibility gate (#956).
function makeCountingDeps() {
  const counts = { fetch: 0, command: 0, security: 0 };
  return {
    counts,
    options: {
      platform: "linux",
      providerTimeoutMs: 2000,
      securityRunner() {
        counts.security += 1;
        return { status: 1, stdout: "" };
      },
      commandRunner(command, args) {
        counts.command += 1;
        return { status: 1, stdout: "", stderr: "" };
      },
      fetchImpl() {
        counts.fetch += 1;
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: () => null },
          json: async () => ({}),
        });
      },
    },
  };
}

function assertExactSentinel(row, label) {
  assert.ok(row && typeof row === "object", `${label} row must exist`);
  assert.equal(row.configured, false, `${label} must be not-configured`);
  assert.deepEqual(
    Object.keys(row).sort(),
    ["configured"],
    `${label} must be the exact sentinel — no error, windows, plan label, or provenance may leak`,
  );
}

describe("usage-limits visibility gating (#956)", () => {
  it("skips every hidden provider: no fetch, no subprocess, no keychain read", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-gating-"));
    const savedEnv = {
      OPENCODE_GO_WORKSPACE_ID: process.env.OPENCODE_GO_WORKSPACE_ID,
      OPENCODE_GO_AUTH_COOKIE: process.env.OPENCODE_GO_AUTH_COOKIE,
    };
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    try {
      const { counts, options } = makeCountingDeps();
      // devinEnabled is deliberately true while devin is hidden: the hidden
      // set must win — an opted-in provider the user hid stays unasked.
      const data = await getUsageLimits({
        home: tmp,
        ...options,
        devinEnabled: true,
        hiddenProviders: [...USAGE_LIMITS_PROVIDER_IDS],
      });

      assert.equal(counts.fetch, 0, "no upstream fetch may run for a fully hidden selection");
      assert.equal(counts.command, 0, "no subprocess may run for a fully hidden selection");
      assert.equal(counts.security, 0, "no keychain/credential read may run for a fully hidden selection");
      for (const id of USAGE_LIMITS_PROVIDER_IDS) {
        assertExactSentinel(data[id], id);
      }
    } finally {
      if (savedEnv.OPENCODE_GO_WORKSPACE_ID !== undefined) process.env.OPENCODE_GO_WORKSPACE_ID = savedEnv.OPENCODE_GO_WORKSPACE_ID;
      if (savedEnv.OPENCODE_GO_AUTH_COOKIE !== undefined) process.env.OPENCODE_GO_AUTH_COOKIE = savedEnv.OPENCODE_GO_AUTH_COOKIE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keeps fetching visible providers while hidden ones ship sentinels", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-gating-"));
    // A pristine temp home leaves every visible provider unconfigured (no local
    // credentials), so nothing would fetch. CommandCode keys off an env var
    // directly, making it the network probe: visible → counts.fetch grows,
    // hidden → its slot ships the sentinel with zero calls.
    const savedEnv = {
      COMMAND_CODE_API_KEY: process.env.COMMAND_CODE_API_KEY,
      OPENCODE_GO_WORKSPACE_ID: process.env.OPENCODE_GO_WORKSPACE_ID,
      OPENCODE_GO_AUTH_COOKIE: process.env.OPENCODE_GO_AUTH_COOKIE,
    };
    process.env.COMMAND_CODE_API_KEY = "gating-test-key";
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    try {
      const { counts, options } = makeCountingDeps();
      const data = await getUsageLimits({
        home: tmp,
        ...options,
        hiddenProviders: ["claude", "codex", "zcode", "commandCode"],
      });

      assertExactSentinel(data.claude, "claude");
      assertExactSentinel(data.codex, "codex");
      assertExactSentinel(data.zcode, "zcode");
      assertExactSentinel(data.commandCode, "commandCode");
      const visibleData = await getUsageLimits({
        home: tmp,
        ...options,
        hiddenProviders: ["claude", "codex", "zcode"],
      });
      assert.ok(counts.fetch > 0, "a visible credentialed provider must still be fetched");
      assert.ok(
        visibleData.commandCode.configured === true && Boolean(visibleData.commandCode.error),
        "the visible CommandCode attempt surfaces its failed fetch as an error row",
      );
    } finally {
      if (savedEnv.COMMAND_CODE_API_KEY !== undefined) process.env.COMMAND_CODE_API_KEY = savedEnv.COMMAND_CODE_API_KEY;
      else delete process.env.COMMAND_CODE_API_KEY;
      if (savedEnv.OPENCODE_GO_WORKSPACE_ID !== undefined) process.env.OPENCODE_GO_WORKSPACE_ID = savedEnv.OPENCODE_GO_WORKSPACE_ID;
      if (savedEnv.OPENCODE_GO_AUTH_COOKIE !== undefined) process.env.OPENCODE_GO_AUTH_COOKIE = savedEnv.OPENCODE_GO_AUTH_COOKIE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("partitions the memory cache by hidden set", async () => {
    resetUsageLimitsCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-limits-gating-"));
    const savedEnv = {
      COMMAND_CODE_API_KEY: process.env.COMMAND_CODE_API_KEY,
      OPENCODE_GO_WORKSPACE_ID: process.env.OPENCODE_GO_WORKSPACE_ID,
      OPENCODE_GO_AUTH_COOKIE: process.env.OPENCODE_GO_AUTH_COOKIE,
    };
    process.env.COMMAND_CODE_API_KEY = "gating-test-key";
    delete process.env.OPENCODE_GO_WORKSPACE_ID;
    delete process.env.OPENCODE_GO_AUTH_COOKIE;
    try {
      const { counts, options } = makeCountingDeps();
      const base = { home: tmp, ...options };
      // Selection A: CommandCode hidden → no fetch at all.
      await getUsageLimits({ ...base, hiddenProviders: ["commandCode"] });
      const afterA = counts.fetch;
      assert.equal(afterA, 0, "hidden CommandCode must not reach the network");
      // Same selection again → served from its partition, still no fetch.
      await getUsageLimits({ ...base, hiddenProviders: ["commandCode"] });
      assert.equal(counts.fetch, afterA, "the same hidden selection must be served from its cache partition");
      // Selection B: CommandCode visible → its own partition, fetched fresh.
      await getUsageLimits({ ...base, hiddenProviders: [] });
      assert.ok(
        counts.fetch > afterA,
        "a different hidden set must not reuse the previous selection's cache",
      );
    } finally {
      if (savedEnv.COMMAND_CODE_API_KEY !== undefined) process.env.COMMAND_CODE_API_KEY = savedEnv.COMMAND_CODE_API_KEY;
      else delete process.env.COMMAND_CODE_API_KEY;
      if (savedEnv.OPENCODE_GO_WORKSPACE_ID !== undefined) process.env.OPENCODE_GO_WORKSPACE_ID = savedEnv.OPENCODE_GO_WORKSPACE_ID;
      if (savedEnv.OPENCODE_GO_AUTH_COOKIE !== undefined) process.env.OPENCODE_GO_AUTH_COOKIE = savedEnv.OPENCODE_GO_AUTH_COOKIE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes hidden lists: dedupe, sort, drop unknown ids, empty → null", () => {
    assert.deepEqual(normalizeHiddenProviders("zcode, claude,claude"), ["claude", "zcode"]);
    assert.deepEqual(normalizeHiddenProviders(["qoderCn", "claude"]), ["claude", "qoderCn"]);
    assert.deepEqual(normalizeHiddenProviders(new Set(["devin"])), ["devin"]);
    assert.deepEqual(
      normalizeHiddenProviders("not-a-provider,claude"),
      ["claude"],
      "unknown ids are dropped so the gate only ever narrows",
    );
    assert.equal(normalizeHiddenProviders(""), null);
    assert.equal(normalizeHiddenProviders(",, "), null);
    assert.equal(normalizeHiddenProviders("unknown-thing"), null);
    assert.equal(normalizeHiddenProviders(undefined), null);
    assert.equal(normalizeHiddenProviders(null), null);
    assert.equal(normalizeHiddenProviders([]), null);
    assert.equal(normalizeHiddenProviders(["  "]), null);
  });
});
