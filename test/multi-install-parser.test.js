const assert = require("node:assert/strict");
const { test } = require("node:test");

const { multiInstallParse, emptyResult } = require("../src/lib/multi-install-parser");

function addToBucket(cursors, key, input, output) {
  const existing = cursors.hourly?.buckets?.[key];
  const prevInput = existing?.totals?.input_tokens || 0;
  const prevOutput = existing?.totals?.output_tokens || 0;
  cursors.hourly.buckets[key] = {
    totals: { input_tokens: prevInput + input, output_tokens: prevOutput + output },
  };
}

test("emptyResult returns zeroed result", () => {
  const r = emptyResult();
  assert.equal(r.recordsProcessed, 0);
  assert.equal(r.eventsAggregated, 0);
  assert.equal(r.bucketsQueued, 0);
});

test("multiInstallParse returns emptyResult when no paths", async () => {
  const r = await multiInstallParse({
    paths: { native: null, wsl: null },
    parserFn: async () => ({ recordsProcessed: 5 }),
    providerName: "test",
    cursors: { hourly: {} },
    getParams: () => ({}),
  });
  assert.equal(r.recordsProcessed, 0);
});

test("multiInstallParse single path passes through directly", async () => {
  const cursors = { hourly: {} };
  const r = await multiInstallParse({
    paths: { native: "/path", wsl: null },
    parserFn: async ({ cursors: c }) => {
      c.testKey = "was-called";
      return { recordsProcessed: 10, eventsAggregated: 5, bucketsQueued: 3 };
    },
    providerName: "test",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });
  assert.equal(r.recordsProcessed, 10);
  assert.equal(cursors.testKey, "was-called");
});

test("multiInstallParse dual paths merge when no prefer set (default)", async () => {
  const cursors = { hourly: { buckets: {} } };

  const r = await multiInstallParse({
    paths: { native: "/native", wsl: "/wsl" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      addToBucket(c, "hermes|gpt-4|2026-01-01T00:00:00.000Z", 100, 50);
      return { recordsProcessed: 1, eventsAggregated: 1, bucketsQueued: 1 };
    },
    providerName: "hermes",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(r.recordsProcessed, 2);
  // Both installs contributed to the same bucket — merged without filtering
  const bucket = cursors.hourly.buckets["hermes|gpt-4|2026-01-01T00:00:00.000Z"];
  assert.ok(bucket);
  assert.equal(bucket.totals.input_tokens, 200, "both installs merged (100+100)");
  assert.equal(bucket.totals.output_tokens, 100, "both installs merged (50+50)");
});

test("multiInstallParse cursor isolation between installs", async () => {
  const cursors = { hourly: {} };

  await multiInstallParse({
    paths: { native: "/a", wsl: "/b" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      c.hermes = { startedAt: resolvedPath === "/a" ? 100 : 200 };
      return { recordsProcessed: 1 };
    },
    providerName: "hermes",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(cursors.hermes.native.startedAt, 100);
  assert.equal(cursors.hermes.wsl.startedAt, 200);
});

test("multiInstallParse partial parse failure propagates error", async () => {
  const cursors = { hourly: {} };

  await assert.rejects(
    () => multiInstallParse({
      paths: { native: "/a", wsl: "/b" },
      parserFn: async ({ resolvedPath, cursors: c }) => {
        if (resolvedPath === "/a") c.hermes = { done: true };
        if (resolvedPath === "/b") throw new Error("second install failed");
        return { recordsProcessed: 1 };
      },
      providerName: "hermes",
      cursors,
      getParams: (path) => ({ resolvedPath: path }),
    }),
    { message: "second install failed" },
  );

  assert.deepEqual(cursors.hermes.native, { done: true }, "first install's cursor state should be preserved");
});

test("cursor-store retry preserves the activated fallback namespaces", async () => {
  const cursors = { opencode: { native: { old: true }, wsl: { old: true } } };
  await assert.rejects(
    () => multiInstallParse({
      paths: { native: "/a", wsl: "/b" },
      parserFn: async ({ cursors: current }) => {
        current.opencode = { native: { fallback: true }, wsl: { fallback: true } };
        const error = new Error("retry");
        error.code = "TOKENTRACKER_CURSOR_STORE_RETRY";
        throw error;
      },
      providerName: "opencode",
      cursors,
      getParams: () => ({}),
    }),
    (error) => error?.code === "TOKENTRACKER_CURSOR_STORE_RETRY",
  );
  assert.deepEqual(cursors.opencode, {
    native: { fallback: true },
    wsl: { fallback: true },
  });
});

test("multiInstallParse empty install produces correct partial result", async () => {
  const cursors = { hourly: { buckets: {} } };

  const r = await multiInstallParse({
    paths: { native: "/native-data", wsl: "/wsl-empty" },
    parserFn: async ({ resolvedPath, cursors: c }) => {
      if (resolvedPath === "/wsl-empty") return { recordsProcessed: 0 };
      c.hourly.buckets["test|model|2026-01-01T00:00:00.000Z"] = {
        totals: { input_tokens: 100, output_tokens: 50 },
      };
      return { recordsProcessed: 5, eventsAggregated: 3, bucketsQueued: 1 };
    },
    providerName: "test",
    cursors,
    getParams: (path) => ({ resolvedPath: path }),
  });

  assert.equal(r.recordsProcessed, 5, "only the non-empty install's records");
  assert.equal(r.eventsAggregated, 3);
  assert.equal(r.bucketsQueued, 1);
});

test("multiInstallParse dual-to-single transition with namespaced cursor", async () => {
  const cursors = {
    hourly: { buckets: {} },
    hermes: {
      native: { lastCompletedStartedAt: 100, snapshots: { s1: { in: 50 } } },
      wsl: { lastCompletedStartedAt: 200, snapshots: { s2: { in: 25 } } },
    },
  };

  // Call with only one active path (simulates switching from both to single mode)
  const r = await multiInstallParse({
    paths: { native: "/native-only", wsl: null },
    parserFn: async ({ cursors: c }) => {
      // The cursor should have been flattened — verify the expected keys
      const state = c.hermes;
      assert.ok(state.lastCompletedStartedAt !== undefined,
        "single-path parse should see flat cursor, not namespace wrapper");
      assert.equal(state.native, undefined, "namespace keys should not exist in flat cursor");
      return { recordsProcessed: 1 };
    },
    providerName: "hermes",
    cursors,
    getParams: (path) => ({ hermesPath: path }),
  });

  assert.equal(r.recordsProcessed, 1);
});

test("adapter normalizing messagesProcessed to recordsProcessed works with multiInstallParse", async () => {
  const cursors = { hourly: {} };
  async function adapter({ dbPath, ...rest }) {
    const result = await rawParser({ dbPath, ...rest });
    return {
      recordsProcessed: result.messagesProcessed || 0,
      eventsAggregated: result.eventsAggregated || 0,
      bucketsQueued: result.bucketsQueued || 0,
    };
  }
  async function rawParser({ dbPath, cursors: c }) {
    c.adapterTest = { lastPath: dbPath };
    return { messagesProcessed: 42, eventsAggregated: 10, bucketsQueued: 5 };
  }
  const r = await multiInstallParse({
    paths: { native: "/db", wsl: null },
    parserFn: adapter,
    providerName: "adapterTest",
    cursors,
    getParams: (path) => ({ dbPath: path }),
  });
  assert.equal(r.recordsProcessed, 42);
  assert.equal(r.eventsAggregated, 10);
  assert.equal(r.bucketsQueued, 5);
  assert.equal(cursors.adapterTest.lastPath, "/db");
});

test("adapter normalizing messagesProcessed works in dual mode", async () => {
  const cursors = { hourly: { buckets: {} } };
  const seen = [];
  async function adapter({ dbPath, ...rest }) {
    const result = await rawParser({ dbPath, ...rest });
    seen.push({ dbPath, result });
    return {
      recordsProcessed: result.messagesProcessed || 0,
      eventsAggregated: result.eventsAggregated || 0,
      bucketsQueued: result.bucketsQueued || 0,
    };
  }
  const counts = { "/native": 10, "/wsl": 32 };
  async function rawParser({ dbPath, cursors: c }) {
    const prev = c.adapterTest?.lastCount || 0;
    c.adapterTest = { lastCount: prev + counts[dbPath], lastPath: dbPath };
    return { messagesProcessed: counts[dbPath], eventsAggregated: counts[dbPath], bucketsQueued: 1 };
  }
  const r = await multiInstallParse({
    paths: { native: "/native", wsl: "/wsl" },
    parserFn: adapter,
    providerName: "adapterTest",
    cursors,
    getParams: (path) => ({ dbPath: path }),
  });
  assert.equal(seen.length, 2, `adapter called twice, got ${seen.length}`);
  assert.equal(seen[0].dbPath, "/native");
  assert.equal(seen[1].dbPath, "/wsl");
  assert.equal(r.recordsProcessed, 42, "10+32 from both installs");
  assert.equal(r.eventsAggregated, 42);
  assert.equal(r.bucketsQueued, 2);
  assert.deepStrictEqual(Object.keys(cursors.adapterTest).sort(), ["native", "wsl"]);
  assert.equal(cursors.adapterTest.native.lastCount, 10);
  assert.equal(cursors.adapterTest.wsl.lastCount, 32);
});
