const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const { parseOpenCodeStatusPayload } = require("../src/lib/opencode-status");
const {
  fetchProviderServiceStatus,
  resetProviderStatusCache,
  STATUS_PAGE_SPECS,
} = require("../src/lib/provider-status");

function openCodePayload(overrides = {}) {
  return {
    updatedAt: 1_700_000_000_000,
    status: "operational",
    components: [
      { service: "console", status: "operational", reason: "none" },
      { service: "go", status: "operational", reason: "none" },
    ],
    ...overrides,
  };
}

describe("parseOpenCodeStatusPayload", () => {
  it("maps an all-operational payload to none with the feed timestamp", () => {
    const parsed = parseOpenCodeStatusPayload(openCodePayload());
    assert.equal(parsed.status.indicator, "none");
    assert.equal(parsed.status.description, "");
    assert.equal(parsed.page.updated_at, new Date(1_700_000_000_000).toISOString());
  });

  it("defaults missing components to an empty list", () => {
    const parsed = parseOpenCodeStatusPayload({ status: "operational" });
    assert.equal(parsed.status.indicator, "none");
    assert.equal(parsed.status.description, "");
  });

  it("degrades to the worst component and lists the affected services", () => {
    const parsed = parseOpenCodeStatusPayload(
      openCodePayload({
        components: [
          { service: "console", status: "operational", reason: "none" },
          { service: "go", status: "partial_outage", reason: "elevated errors" },
          { service: "inference", status: "degraded", reason: "slow" },
        ],
      }),
    );
    assert.equal(parsed.status.indicator, "major");
    assert.match(parsed.status.description, /\bgo\b/);
    assert.match(parsed.status.description, /inference/);
  });

  it("lets the top-level status escalate past the components", () => {
    const parsed = parseOpenCodeStatusPayload(
      openCodePayload({
        status: "major_outage",
        components: [{ service: "console", status: "operational", reason: "none" }],
      }),
    );
    assert.equal(parsed.status.indicator, "critical");
  });

  it("treats unknown non-operational statuses as minor", () => {
    const parsed = parseOpenCodeStatusPayload(
      openCodePayload({
        components: [{ service: "logs", status: "investigating", reason: "???" }],
      }),
    );
    assert.equal(parsed.status.indicator, "minor");
    assert.match(parsed.status.description, /logs/);
  });

  it("throws instead of inventing 'operational' when the payload is not understood", () => {
    assert.throws(() => parseOpenCodeStatusPayload(null));
    assert.throws(() => parseOpenCodeStatusPayload("operational"));
    assert.throws(() => parseOpenCodeStatusPayload([{ service: "console" }]));
    assert.throws(() => parseOpenCodeStatusPayload({ components: [] }));
    assert.throws(() => parseOpenCodeStatusPayload(openCodePayload({ components: { service: "console" } })));
    assert.throws(() => parseOpenCodeStatusPayload(openCodePayload({ components: [{ status: "operational" }] })));
  });
});

describe("fetchProviderServiceStatus('opencode')", () => {
  beforeEach(() => resetProviderStatusCache());

  it("reads the JSON status feed and returns a Statuspage-shaped reading", async () => {
    let requested = null;
    const reading = await fetchProviderServiceStatus("opencode", {
      nowMs: 1_700_000_000_000,
      fetchImpl: async (url, init) => {
        requested = { url, accept: init?.headers?.Accept };
        return {
          ok: true,
          json: async () => openCodePayload({
            components: [{ service: "go", status: "degraded", reason: "slow" }],
          }),
        };
      },
    });
    assert.equal(requested.url, STATUS_PAGE_SPECS.opencode.apiUrl);
    assert.equal(requested.accept, "application/json");
    assert.deepEqual(reading, {
      indicator: "minor",
      description: "go",
      updated_at: new Date(1_700_000_000_000).toISOString(),
      url: STATUS_PAGE_SPECS.opencode.pageUrl,
    });
  });

  it("caches within the TTL and does not refetch", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => openCodePayload() };
    };
    const t0 = 1_700_000_000_000;
    const first = await fetchProviderServiceStatus("opencode", { fetchImpl, nowMs: t0 });
    const second = await fetchProviderServiceStatus("opencode", { fetchImpl, nowMs: t0 + 60_000 });
    assert.equal(calls, 1);
    assert.deepEqual(second, first);
    await fetchProviderServiceStatus("opencode", { fetchImpl, nowMs: t0 + 6 * 60_000 });
    assert.equal(calls, 2);
  });

  it("returns null and never throws when the feed is unparseable", async () => {
    const reading = await fetchProviderServiceStatus("opencode", {
      nowMs: 1_700_000_000_000,
      fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("not json"); } }),
    });
    assert.equal(reading, null);
  });
});
