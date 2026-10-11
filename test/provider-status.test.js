const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  fetchProviderServiceStatus,
  resetProviderStatusCache,
  STATUS_PAGE_SPECS,
} = require("../src/lib/provider-status");
const { getUsageLimits, resetUsageLimitsCache } = require("./helpers/usage-limits");

function statuspageResponse(indicator, description, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return {
        page: { updated_at: "2026-07-26T08:00:00.000Z" },
        status: { indicator, description },
      };
    },
  };
}

describe("fetchProviderServiceStatus", () => {
  beforeEach(() => resetProviderStatusCache());

  it("parses a Statuspage.io reading and carries the public page URL", async () => {
    let requestedUrl = null;
    const status = await fetchProviderServiceStatus("claude", {
      fetchImpl: async (url) => {
        requestedUrl = url;
        return statuspageResponse("major", "Elevated errors on Claude models");
      },
    });
    assert.equal(requestedUrl, STATUS_PAGE_SPECS.claude.apiUrl);
    assert.deepEqual(status, {
      indicator: "major",
      description: "Elevated errors on Claude models",
      updated_at: "2026-07-26T08:00:00.000Z",
      url: STATUS_PAGE_SPECS.claude.pageUrl,
    });
  });

  it("returns null for unknown providers without fetching", async () => {
    let fetchCalls = 0;
    const status = await fetchProviderServiceStatus("not-a-provider", {
      fetchImpl: async () => {
        fetchCalls += 1;
        return statuspageResponse("none", "");
      },
    });
    assert.equal(status, null);
    assert.equal(fetchCalls, 0);
  });

  it("returns null on malformed payloads and unexpected indicators", async () => {
    const malformed = await fetchProviderServiceStatus("claude", {
      fetchImpl: async () => ({ ok: true, async json() { return { unexpected: true }; } }),
    });
    assert.equal(malformed, null);

    resetProviderStatusCache();
    const badIndicator = await fetchProviderServiceStatus("claude", {
      fetchImpl: async () => statuspageResponse("exploded", "??"),
    });
    assert.equal(badIndicator, null);
  });

  it("serves the cached reading within the TTL without refetching", async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return statuspageResponse("minor", "Degraded performance");
    };
    const t0 = Date.now();
    const first = await fetchProviderServiceStatus("claude", { fetchImpl, nowMs: t0 });
    const second = await fetchProviderServiceStatus("claude", { fetchImpl, nowMs: t0 + 60_000 });
    assert.equal(fetchCalls, 1);
    assert.deepEqual(second, first);

    // TTL elapsed → refetch.
    await fetchProviderServiceStatus("claude", { fetchImpl, nowMs: t0 + 6 * 60_000 });
    assert.equal(fetchCalls, 2);
  });

  it("falls back to the last good reading when a probe fails, then ages it out", async () => {
    const t0 = Date.now();
    const good = await fetchProviderServiceStatus("claude", {
      fetchImpl: async () => statuspageResponse("critical", "Full outage"),
      nowMs: t0,
    });
    assert.equal(good.indicator, "critical");

    const failing = async () => { throw new Error("network down"); };
    const stale = await fetchProviderServiceStatus("claude", {
      fetchImpl: failing,
      nowMs: t0 + 10 * 60_000,
    });
    assert.deepEqual(stale, good);

    // Past the last-good window the reading ages out to null instead of
    // resurrecting an hours-old incident banner.
    const agedOut = await fetchProviderServiceStatus("claude", {
      fetchImpl: failing,
      nowMs: t0 + 40 * 60_000,
    });
    assert.equal(agedOut, null);
  });

  it("never throws on fetch rejection or non-OK responses", async () => {
    const rejected = await fetchProviderServiceStatus("claude", {
      fetchImpl: async () => { throw new Error("boom"); },
    });
    assert.equal(rejected, null);

    resetProviderStatusCache();
    const notOk = await fetchProviderServiceStatus("claude", {
      fetchImpl: async () => statuspageResponse("minor", "x", { ok: false }),
    });
    assert.equal(notOk, null);
  });
});

describe("usage-limits claude service_status integration", () => {
  const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

  function writeClaudeCreds(home) {
    const dir = path.join(home, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oauth-status" } }),
    );
  }

  function claudeUsageResponse() {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        five_hour: { utilization: 7, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day: { utilization: 40, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      }),
    });
  }

  async function runLimits(statusBehavior) {
    resetUsageLimitsCache();
    resetProviderStatusCache();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-provider-status-"));
    try {
      writeClaudeCreds(tmp);
      return await getUsageLimits({
        home: tmp,
        platform: "linux",
        providerTimeoutMs: 2000,
        securityRunner() { return { status: 1, stdout: "" }; },
        commandRunner() { return { status: 1, stdout: "" }; },
        fetchImpl(url) {
          if (url === CLAUDE_USAGE_URL) return claudeUsageResponse();
          if (url === STATUS_PAGE_SPECS.claude.apiUrl) return statusBehavior();
          return Promise.reject(new Error("unmocked"));
        },
      });
    } finally {
      resetUsageLimitsCache();
      resetProviderStatusCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("attaches an active incident to the claude limits object", async () => {
    const result = await runLimits(() => Promise.resolve(statuspageResponse("major", "Elevated errors")));
    assert.equal(result.claude.configured, true);
    assert.equal(result.claude.error, null);
    assert.equal(result.claude.service_status.indicator, "major");
    assert.equal(result.claude.service_status.description, "Elevated errors");
    assert.equal(result.claude.service_status.url, STATUS_PAGE_SPECS.claude.pageUrl);
  });

  it("omits service_status entirely when the provider reports all-operational", async () => {
    const result = await runLimits(() => Promise.resolve(statuspageResponse("none", "All Systems Operational")));
    assert.equal(result.claude.configured, true);
    assert.equal("service_status" in result.claude, false);
  });

  it("keeps the limits response intact when the status probe fails", async () => {
    const result = await runLimits(() => Promise.reject(new Error("status page unreachable")));
    assert.equal(result.claude.configured, true);
    assert.equal(result.claude.error, null);
    assert.equal(result.claude.five_hour.utilization, 7);
    assert.equal("service_status" in result.claude, false);
  });
});
