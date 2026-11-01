const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const { parseDeepSeekStatusPage } = require("../src/lib/deepseek-status");
const {
  fetchProviderServiceStatus,
  resetProviderStatusCache,
  STATUS_PAGE_SPECS,
} = require("../src/lib/provider-status");

function deepseekHtml(activeChanges, { updatedAt = 1_700_000_000_000, marker = true } = {}) {
  const flight = marker
    ? JSON.stringify({ page: {}, active_changes: activeChanges, initialDataUpdatedAt: updatedAt })
    : JSON.stringify({ page: {} });
  return `<!doctype html><html><body><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`;
}

describe("parseDeepSeekStatusPage", () => {
  it("treats an empty active_changes array as operational", () => {
    const payload = parseDeepSeekStatusPage(deepseekHtml([]));
    assert.equal(payload.status.indicator, "none");
    assert.equal(payload.status.description, "");
    assert.equal(payload.page.updated_at, new Date(1_700_000_000_000).toISOString());
  });

  it("maps degraded / partial / full outages to the Statuspage scale", () => {
    const degraded = parseDeepSeekStatusPage(deepseekHtml([{ name: "Elevated errors", status: "degraded" }]));
    assert.equal(degraded.status.indicator, "minor");
    assert.equal(degraded.status.description, "Elevated errors");

    const partial = parseDeepSeekStatusPage(deepseekHtml([{ name: "Search API down", status: "partial_outage" }]));
    assert.equal(partial.status.indicator, "major");

    const full = parseDeepSeekStatusPage(deepseekHtml([{ name: "All down", status: "full_outage" }]));
    assert.equal(full.status.indicator, "critical");
  });

  it("reports the worst change when several are active", () => {
    const payload = parseDeepSeekStatusPage(deepseekHtml([
      { name: "minor thing", status: "degraded" },
      { name: "major thing", status: "major_outage" },
    ]));
    assert.equal(payload.status.indicator, "critical");
    assert.match(payload.status.description, /major thing/);
  });

  it("treats an unknown change status as a minor incident", () => {
    const payload = parseDeepSeekStatusPage(deepseekHtml([{ name: "mystery", status: "weird_state" }]));
    assert.equal(payload.status.indicator, "minor");
  });

  it("throws instead of inventing 'operational' when the page is not understood", () => {
    assert.throws(() => parseDeepSeekStatusPage("<html><body>no rsc here</body></html>"));
    assert.throws(() => parseDeepSeekStatusPage(deepseekHtml([], { marker: false })));
    assert.throws(() => parseDeepSeekStatusPage(""));
    // active_changes must be an array; null / object must not fall through to
    // some later array in the document and masquerade as "all operational".
    assert.throws(() => parseDeepSeekStatusPage(deepseekHtml(null)));
    assert.throws(() => parseDeepSeekStatusPage(deepseekHtml({ unexpected: "shape" })));
  });
});

describe("fetchProviderServiceStatus('deepseek')", () => {
  beforeEach(() => resetProviderStatusCache());

  it("reads the HTML status page and returns a Statuspage-shaped reading", async () => {
    let requested = null;
    const reading = await fetchProviderServiceStatus("deepseek", {
      nowMs: 1_700_000_000_000,
      fetchImpl: async (url, init) => {
        requested = { url, accept: init?.headers?.Accept };
        return { ok: true, async text() { return deepseekHtml([{ name: "Elevated errors", status: "degraded" }]); } };
      },
    });
    assert.equal(requested.url, STATUS_PAGE_SPECS.deepseek.apiUrl);
    assert.equal(requested.accept, "text/html");
    assert.deepEqual(reading, {
      indicator: "minor",
      description: "Elevated errors",
      updated_at: new Date(1_700_000_000_000).toISOString(),
      url: STATUS_PAGE_SPECS.deepseek.pageUrl,
    });
  });

  it("caches within the TTL and does not refetch", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, async text() { return deepseekHtml([]); } };
    };
    const t0 = 1_700_000_000_000;
    const first = await fetchProviderServiceStatus("deepseek", { fetchImpl, nowMs: t0 });
    const second = await fetchProviderServiceStatus("deepseek", { fetchImpl, nowMs: t0 + 60_000 });
    assert.equal(calls, 1);
    assert.deepEqual(second, first);
    await fetchProviderServiceStatus("deepseek", { fetchImpl, nowMs: t0 + 6 * 60_000 });
    assert.equal(calls, 2);
  });

  it("returns null and never throws when the page is unparseable", async () => {
    const reading = await fetchProviderServiceStatus("deepseek", {
      nowMs: 1_700_000_000_000,
      fetchImpl: async () => ({ ok: true, async text() { return "<html>no data</html>"; } }),
    });
    assert.equal(reading, null);
  });
});
