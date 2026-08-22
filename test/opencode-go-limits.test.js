const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  readConfig,
  parseWindowUsage,
  parseDataSlotFormat,
  parseHumanReadableTime,
  buildWindow,
  extractWindows,
  fetchOpencodeGoLimits,
  fetchOpencodeGoApiLimits,
  readApiKey,
  resolveWorkspaceId,
  parseWorkspaceIds,
  looksSignedOut,
} = require("../src/lib/opencode-go-limits");

// Real SolidStart hydration snippet shape captured from
// https://opencode.ai/workspace/<id>/go (slkiser/opencode-quota PR #41).
function ssrHtml() {
  return `
    <html><body>
    <script>self.__next_f.push([1,"rollingUsage:$R[3]={usagePercent:42,resetInSec:12345}"])</script>
    <script>self.__next_f.push([1,"weeklyUsage:$R[4]={usagePercent:18,resetInSec:678901}"])</script>
    <script>self.__next_f.push([1,"monthlyUsage:$R[5]={usagePercent:7,resetInSec:2592000}"])</script>
    </body></html>
  `;
}

// Reset-first field order — solid hydration order can vary per build.
function ssrHtmlResetFirst() {
  return `
    <html><body>
    <script>self.__next_f.push([1,"monthlyUsage:$R[5]={resetInSec:2592000,usagePercent:7}"])</script>
    </body></html>
  `;
}

// Newer HTML format that uses data-slot attrs (no SSR hydration output).
function dataSlotHtml() {
  return `
    <html><body>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Rolling Usage</span>
      <span data-slot="usage-value">42%</span>
      <span data-slot="reset-time">Resets in 3 hours 25 minutes</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Weekly Usage</span>
      <span data-slot="usage-value">18%</span>
      <span data-slot="reset-time">Resets in 2 days 4 hours</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Monthly Usage</span>
      <span data-slot="usage-value">7%</span>
      <span data-slot="reset-now"></span>
    </div>
    </body></html>
  `;
}

function apiUsagePayload() {
  return {
    useBalance: false,
    rollingUsage: { status: "ok", usagePercent: 42, resetInSec: 12345 },
    weeklyUsage: { status: "ok", usagePercent: 18, resetInSec: 678901 },
    monthlyUsage: { status: "ok", usagePercent: 7, resetInSec: 2592000 },
  };
}

describe("readConfig", () => {
  it("returns null when env has no auth cookie", () => {
    assert.equal(readConfig({ OPENCODE_GO_WORKSPACE_ID: "wrk_1" }), null);
    assert.equal(readConfig({}), null);
    assert.equal(readConfig(null), null);
  });
  it("returns config with empty workspaceId when only auth cookie is present", () => {
    const out = readConfig({
      OPENCODE_GO_AUTH_COOKIE: "  cookie  ",
    });
    assert.deepEqual(out, { workspaceId: "", authCookie: "cookie" });
  });
  it("returns the trimmed values when both vars are present", () => {
    const out = readConfig({
      OPENCODE_GO_WORKSPACE_ID: "  wrk_1  ",
      OPENCODE_GO_AUTH_COOKIE: "  cookie  ",
    });
    assert.deepEqual(out, { workspaceId: "wrk_1", authCookie: "cookie" });
  });
  it("ignores non-string values for auth cookie", () => {
    assert.equal(
      readConfig({ OPENCODE_GO_WORKSPACE_ID: "wrk_1", OPENCODE_GO_AUTH_COOKIE: 123 }),
      null,
    );
  });
});

describe("readApiKey", () => {
  it("returns a trimmed API key and ignores non-string values", () => {
    assert.equal(readApiKey({ OPENCODE_GO_API_KEY: "  sk-go-key  " }), "sk-go-key");
    assert.equal(readApiKey({ OPENCODE_GO_API_KEY: 123 }), "");
    assert.equal(readApiKey({}), "");
    assert.equal(readApiKey(null), "");
  });
});

describe("parseHumanReadableTime", () => {
  it("parses day/hour/minute/second combinations", () => {
    assert.equal(parseHumanReadableTime("3 hours 25 minutes"), 3 * 3600 + 25 * 60);
    assert.equal(parseHumanReadableTime("2 days 4 hours"), 2 * 86400 + 4 * 3600);
    assert.equal(parseHumanReadableTime("45 seconds"), 45);
    assert.equal(parseHumanReadableTime("1 day 2 hours 3 minutes 4 seconds"), 86400 + 7200 + 180 + 4);
  });
  it("returns 0 for reset-now aliases", () => {
    assert.equal(parseHumanReadableTime("now"), 0);
    assert.equal(parseHumanReadableTime("Reset now"), 0);
    assert.equal(parseHumanReadableTime("reset-now"), 0);
  });
  it("returns null when no duration is present", () => {
    assert.equal(parseHumanReadableTime(""), null);
    assert.equal(parseHumanReadableTime("hello world"), null);
    assert.equal(parseHumanReadableTime(null), null);
  });
});

describe("parseWindowUsage", () => {
  it("extracts usage + reset from the pct-first ordering", () => {
    const out = parseWindowUsage(ssrHtml(), "rollingUsage");
    assert.deepEqual(out, { usagePercent: 42, resetInSec: 12345 });
  });
  it("extracts usage + reset from the reset-first ordering", () => {
    const out = parseWindowUsage(ssrHtmlResetFirst(), "monthlyUsage");
    assert.deepEqual(out, { usagePercent: 7, resetInSec: 2592000 });
  });
  it("returns null when the window is absent", () => {
    const out = parseWindowUsage("<html>nope</html>", "rollingUsage");
    assert.equal(out, null);
  });
  it("parses a wrapper format without the legacy $R[N] anchor (#225 regression)", () => {
    // opencode dropped the `:$R[N]={…}` SSR wrapper; field names are unchanged.
    const html =
      '{rollingUsage:{usagePercent:2,resetInSec:100},weeklyUsage:{usagePercent:17,resetInSec:200}}';
    assert.deepEqual(parseWindowUsage(html, "rollingUsage"), { usagePercent: 2, resetInSec: 100 });
    assert.deepEqual(parseWindowUsage(html, "weeklyUsage"), { usagePercent: 17, resetInSec: 200 });
  });
  it("parses assignment with equal sign (= or :=)", () => {
    const html1 = '{rollingUsage:{usagePercent=42,resetInSec=100}}';
    const html2 = 'weeklyUsage:= {usagePercent:= 15, resetInSec:=200}';
    assert.deepEqual(parseWindowUsage(html1, "rollingUsage"), { usagePercent: 42, resetInSec: 100 });
    assert.deepEqual(parseWindowUsage(html2, "weeklyUsage"), { usagePercent: 15, resetInSec: 200 });
  });
});

describe("buildWindow", () => {
  it("clamps usage_percent to [0, 100] and emits an ISO reset_at", () => {
    const nowMs = 1_700_000_000_000;
    assert.deepEqual(buildWindow({ usagePercent: 42, resetInSec: 60, nowMs }), {
      used_percent: 42,
      reset_at: new Date(nowMs + 60_000).toISOString(),
    });
    assert.deepEqual(buildWindow({ usagePercent: -5, resetInSec: 0, nowMs }), {
      used_percent: 0,
      reset_at: new Date(nowMs).toISOString(),
    });
    assert.deepEqual(buildWindow({ usagePercent: 250, resetInSec: 0, nowMs }), {
      used_percent: 100,
      reset_at: new Date(nowMs).toISOString(),
    });
  });
  it("returns null for invalid percent or resetInSec", () => {
    assert.equal(buildWindow({ usagePercent: null, resetInSec: 1, nowMs: 0 }), null);
    assert.equal(buildWindow({ usagePercent: 1, resetInSec: -1, nowMs: 0 }), null);
    assert.equal(buildWindow({ usagePercent: 1, resetInSec: NaN, nowMs: 0 }), null);
  });
});

describe("parseDataSlotFormat", () => {
  it("extracts three windows from the data-slot HTML fallback", () => {
    const out = parseDataSlotFormat(dataSlotHtml());
    assert.equal(out.rolling?.usagePercent, 42);
    assert.equal(out.rolling?.resetInSec, 3 * 3600 + 25 * 60);
    assert.equal(out.weekly?.usagePercent, 18);
    assert.equal(out.monthly?.usagePercent, 7);
    assert.equal(out.monthly?.resetInSec, 0);
  });
  it("returns an empty object when no usage-items are present", () => {
    assert.deepEqual(parseDataSlotFormat("<html></html>"), {});
  });
});

describe("extractWindows", () => {
  it("prefers SSR hydration output and builds three ISO windows", () => {
    const nowMs = 1_700_000_000_000;
    const out = extractWindows(ssrHtml(), nowMs);
    assert.equal(out.rolling?.used_percent, 42);
    assert.equal(out.weekly?.used_percent, 18);
    assert.equal(out.monthly?.used_percent, 7);
    assert.equal(out.rolling?.reset_at, new Date(nowMs + 12345_000).toISOString());
    assert.equal(out.monthly?.reset_at, new Date(nowMs + 2592000_000).toISOString());
  });
  it("falls back to data-slot parsing when SSR is absent", () => {
    const nowMs = 1_700_000_000_000;
    const out = extractWindows(dataSlotHtml(), nowMs);
    assert.equal(out.rolling?.used_percent, 42);
    assert.equal(out.weekly?.used_percent, 18);
    assert.equal(out.monthly?.used_percent, 7);
  });
  it("returns three nulls when neither parser matches", () => {
    const out = extractWindows("<html>nope</html>", 0);
    assert.equal(out.rolling, null);
    assert.equal(out.weekly, null);
    assert.equal(out.monthly, null);
  });
  it("returns only the windows that successfully parse", () => {
    const partial = `<script>self.__next_f.push([1,"rollingUsage:$R[3]={usagePercent:42,resetInSec:60}"])</script>`;
    const out = extractWindows(partial, 0);
    assert.equal(out.rolling?.used_percent, 42);
    assert.equal(out.weekly, null);
    assert.equal(out.monthly, null);
  });
});

describe("fetchOpencodeGoLimits", () => {
  const cfg = { OPENCODE_GO_WORKSPACE_ID: "wrk_01", OPENCODE_GO_AUTH_COOKIE: "cookie" };
  const apiCfg = { OPENCODE_GO_API_KEY: "sk-go-key" };

  function jsonResponse(status, body) {
    return {
      status,
      ok: status >= 200 && status < 300,
      async text() {
        return typeof body === "string" ? body : JSON.stringify(body);
      },
    };
  }

  it("returns { configured: false } when env is missing", async () => {
    const out = await fetchOpencodeGoLimits({ env: {}, fetchImpl: async () => jsonResponse(200, "") });
    assert.deepEqual(out, { configured: false });
  });

  it("maps the official API response to the three dashboard windows", async () => {
    let capturedUrl = null;
    let capturedInit = null;
    const out = await fetchOpencodeGoApiLimits({
      apiKey: "sk-go-key",
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return jsonResponse(200, apiUsagePayload());
      },
      nowMs: 1_700_000_000_000,
      timeoutMs: 1_000,
    });

    assert.equal(capturedUrl, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(capturedInit.method, "GET");
    assert.equal(capturedInit.headers.Authorization, "Bearer sk-go-key");
    assert.equal(capturedInit.headers.Accept, "application/json");
    assert.equal(out.error, null);
    assert.equal(out.subscription_status, "active");
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.secondary_window?.used_percent, 18);
    assert.equal(out.tertiary_window?.used_percent, 7);
    assert.equal(out.primary_window?.reset_at, new Date(1_700_000_000_000 + 12345_000).toISOString());
  });

  it("prefers the official API when both an API key and legacy cookie are configured", async () => {
    let requests = 0;
    const out = await fetchOpencodeGoLimits({
      env: { ...apiCfg, ...cfg },
      fetchImpl: async (url) => {
        requests += 1;
        assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
        return jsonResponse(200, apiUsagePayload());
      },
      nowMs: 1_700_000_000_000,
    });

    assert.equal(requests, 1);
    assert.equal(out.source, "api");
    assert.equal(out.primary_window?.used_percent, 42);
  });

  it("parses the live API shape {usage:{rolling:{percent,resetsAt}}}", async () => {
    const out = await fetchOpencodeGoLimits({
      env: apiCfg,
      fetchImpl: async () =>
        jsonResponse(200, {
          useBalance: false,
          usage: {
            rolling: { percent: 42, resetsAt: "2026-08-21T18:00:00.000Z" },
            weekly: { percent: 18, resetsAt: "2026-08-24T00:00:00.000Z" },
            monthly: { percent: 7, resetsAt: "2026-09-01T00:00:00.000Z" },
          },
        }),
      nowMs: Date.parse("2026-08-21T14:45:35.000Z"),
    });

    assert.equal(out.error, null);
    assert.equal(out.source, "api");
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.primary_window?.reset_at, "2026-08-21T18:00:00.000Z");
    assert.equal(out.secondary_window?.used_percent, 18);
    assert.equal(out.tertiary_window?.used_percent, 7);
  });

  it("falls back to a valid legacy window when the modern window is incomplete", async () => {
    const out = await fetchOpencodeGoLimits({
      env: apiCfg,
      fetchImpl: async () =>
        jsonResponse(200, {
          useBalance: false,
          // Modern rolling present but unusable on its own (percent without
          // any reset info) -> buildWindow() returns null; the resolver must
          // fall through to the legacy window instead of dropping it.
          usage: { rolling: { percent: 99 } },
          rollingUsage: { status: "ok", usagePercent: 42, resetInSec: 12345 },
        }),
      nowMs: 1_700_000_000_000,
    });

    assert.equal(out.error, null);
    assert.equal(out.primary_window?.used_percent, 42, "legacy rolling must survive");
    assert.equal(
      out.primary_window?.reset_at,
      new Date(1_700_000_000_000 + 12345_000).toISOString(),
    );
  });

  it("returns actionable authentication errors from the official API", async () => {
    const unauthorized = await fetchOpencodeGoLimits({
      env: apiCfg,
      fetchImpl: async () => jsonResponse(401, { type: "error" }),
    });
    assert.match(unauthorized.error, /not entitled to an OpenCode Go subscription/);

    const forbidden = await fetchOpencodeGoLimits({
      env: apiCfg,
      fetchImpl: async () => jsonResponse(403, { type: "error" }),
    });
    assert.match(forbidden.error, /subscription required/);
  });

  it("does not hide an API authentication error behind a legacy cookie", async () => {
    let requests = 0;
    const out = await fetchOpencodeGoLimits({
      env: { ...apiCfg, ...cfg },
      fetchImpl: async (url) => {
        requests += 1;
        assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
        return jsonResponse(401, { type: "error" });
      },
    });

    assert.equal(requests, 1);
    assert.match(out.error, /not entitled to an OpenCode Go subscription/);
  });

  it("falls back to the legacy dashboard scrape when the official API is temporarily unavailable", async () => {
    const urls = [];
    const out = await fetchOpencodeGoLimits({
      env: { ...apiCfg, ...cfg },
      fetchImpl: async (url) => {
        urls.push(url);
        if (url === "https://opencode.ai/zen/go/v1/usage") return jsonResponse(503, "down");
        if (url === "https://opencode.ai/workspace/wrk_01/go") return jsonResponse(200, ssrHtml());
        return jsonResponse(404, "not found");
      },
      nowMs: 1_700_000_000_000,
    });

    assert.deepEqual(urls, [
      "https://opencode.ai/zen/go/v1/usage",
      "https://opencode.ai/workspace/wrk_01/go",
    ]);
    assert.equal(out.source, "web");
    assert.equal(out.primary_window?.used_percent, 42);
  });

  it("surfaces an API payload without usage windows", async () => {
    const out = await fetchOpencodeGoLimits({
      env: apiCfg,
      fetchImpl: async () => jsonResponse(200, { useBalance: false }),
    });
    assert.match(out.error, /did not include any known usage windows/);
  });

  it("returns the three windows on a 200 SSR-hydration response", async () => {
    let capturedUrl = null;
    let capturedInit = null;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, ssrHtml());
    };
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl, nowMs: 1_700_000_000_000 });
    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(out.plan_label, undefined, "no plan_label — the brand 'OpenCode Go' is the row title");
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.secondary_window?.used_percent, 18);
    assert.equal(out.tertiary_window?.used_percent, 7);
    assert.equal(
      capturedUrl,
      "https://opencode.ai/workspace/wrk_01/go",
      "URL must be the public Go dashboard",
    );
    assert.equal(
      capturedInit.headers.Cookie,
      "auth=cookie",
      "Cookie is sent verbatim as `auth=<value>` per slkiser/opencode-quota#41",
    );
    assert.match(capturedInit.headers["User-Agent"], /Mozilla/);
  });

  it("falls back to data-slot HTML when SSR hydration is absent", async () => {
    const fetchImpl = async () => jsonResponse(200, dataSlotHtml());
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl, nowMs: 1_700_000_000_000 });
    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.tertiary_window?.used_percent, 7);
  });

  it("fills each missing window from the HTML fallback (per-window, not all-or-nothing)", async () => {
    // SSR exposes rolling + weekly but drops monthly; the rendered HTML still
    // carries all three data-slot items. The fallback must recover monthly
    // without clobbering the two SSR values.
    const partial = `
      <html><body>
      <script>self.__next_f.push([1,"rollingUsage:$R[3]={usagePercent:42,resetInSec:60}"])</script>
      <script>self.__next_f.push([1,"weeklyUsage:$R[4]={usagePercent:18,resetInSec:600}"])</script>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Rolling Usage</span>
        <span data-slot="usage-value">99%</span>
        <span data-slot="reset-time">Resets in 1 hours</span>
      </div>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Weekly Usage</span>
        <span data-slot="usage-value">99%</span>
        <span data-slot="reset-time">Resets in 1 hours</span>
      </div>
      <div data-slot="usage-item">
        <span data-slot="usage-label">Monthly Usage</span>
        <span data-slot="usage-value">77%</span>
        <span data-slot="reset-time">Resets in 1 hours</span>
      </div>
      </body></html>
    `;
    const fetchImpl = async () => jsonResponse(200, partial);
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl, nowMs: 1_700_000_000_000 });
    assert.equal(out.configured, true);
    // SSR values preserved (42, 18) even though the data-slot block would say 99%.
    assert.equal(out.primary_window?.used_percent, 42);
    assert.equal(out.secondary_window?.used_percent, 18);
    // Monthly recovered from the HTML fallback.
    assert.equal(out.tertiary_window?.used_percent, 77);
  });

  it("surfaces 401/403 as a re-auth error", async () => {
    const fetchImpl = async () => jsonResponse(401, "login");
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /Not signed in to OpenCode Go/);
  });

  it("surfaces 5xx as a generic error", async () => {
    const fetchImpl = async () => jsonResponse(503, "down");
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /503/);
  });

  it("surfaces a parse error when the dashboard HTML has no known windows", async () => {
    const fetchImpl = async () => jsonResponse(200, "<html>oops totally different</html>");
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /Could not parse any known OpenCode Go dashboard usage windows/);
  });

  it("surfaces network errors as a configured error", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET boom");
    };
    const out = await fetchOpencodeGoLimits({ env: cfg, fetchImpl });
    assert.equal(out.configured, true);
    assert.match(out.error, /ECONNRESET/);
  });

  it("auto-resolves workspace ID from cookie when not configured in env (GET path)", async () => {
    let workspaceResolved = false;
    let dashboardFetched = false;
    const fetchImpl = async (url, init) => {
      if (url.includes("_server") && init.method === "GET") {
        workspaceResolved = true;
        return jsonResponse(200, 'self.__next_f.push([1,"id=\\"wrk_auto_01\\""])');
      }
      if (url.includes("/workspace/wrk_auto_01/go")) {
        dashboardFetched = true;
        return jsonResponse(200, ssrHtml());
      }
      return jsonResponse(404, "not found");
    };

    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_GO_AUTH_COOKIE: "cookie" },
      fetchImpl,
      nowMs: 1_700_000_000_000,
    });

    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(workspaceResolved, true);
    assert.equal(dashboardFetched, true);
    assert.equal(out.primary_window?.used_percent, 42);
  });

  it("auto-resolves workspace ID from cookie when not configured in env (POST path fallback)", async () => {
    let getCalled = false;
    let postCalled = false;
    let dashboardFetched = false;
    const fetchImpl = async (url, init) => {
      if (url.includes("_server") && init.method === "GET") {
        getCalled = true;
        return jsonResponse(200, "null"); // GET yields no workspaces
      }
      if (url.includes("_server") && init.method === "POST") {
        postCalled = true;
        return jsonResponse(200, '[{"id":"wrk_auto_02"}]'); // POST returns JSON array
      }
      if (url.includes("/workspace/wrk_auto_02/go")) {
        dashboardFetched = true;
        return jsonResponse(200, ssrHtml());
      }
      return jsonResponse(404, "not found");
    };

    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_GO_AUTH_COOKIE: "cookie" },
      fetchImpl,
      nowMs: 1_700_000_000_000,
    });

    assert.equal(out.configured, true);
    assert.equal(out.error, null);
    assert.equal(getCalled, true);
    assert.equal(postCalled, true);
    assert.equal(dashboardFetched, true);
    assert.equal(out.primary_window?.used_percent, 42);
  });

  it("surfaces errors when auto-resolution fails due to invalid session (401)", async () => {
    const fetchImpl = async (url, init) => {
      if (url.includes("_server")) {
        return jsonResponse(401, "unauthorized");
      }
      return jsonResponse(404, "not found");
    };
    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_GO_AUTH_COOKIE: "cookie" },
      fetchImpl,
    });
    assert.equal(out.configured, true);
    assert.match(out.error, /Failed to resolve Workspace ID/);
  });

  it("surfaces errors when no workspaces can be found", async () => {
    const fetchImpl = async (url, init) => {
      if (url.includes("_server")) {
        return jsonResponse(200, "null");
      }
      return jsonResponse(404, "not found");
    };
    const out = await fetchOpencodeGoLimits({
      env: { OPENCODE_GO_AUTH_COOKIE: "cookie" },
      fetchImpl,
    });
    assert.equal(out.configured, true);
    assert.match(out.error, /Could not auto-resolve OpenCode Workspace ID/);
  });
});

describe("looksSignedOut", () => {
  it("detects real sign-out / auth-required responses", () => {
    assert.equal(looksSignedOut('actor of type "public" is not associated'), true);
    assert.equal(looksSignedOut('not associated with an account'), true);
    assert.equal(looksSignedOut('Please log in to continue'), true);
    assert.equal(looksSignedOut('Sign in to your account'), true);
    assert.equal(looksSignedOut('redirect to auth/authorize'), true);
  });
  it("does NOT false-positive on workspace names containing common words", () => {
    assert.equal(looksSignedOut('{"id":"wrk_loginServiceApp"}'), false);
    assert.equal(looksSignedOut('workspace login_page'), false);
    assert.equal(looksSignedOut('wrk_sign_in_helper'), false);
    assert.equal(looksSignedOut('[{"name":"MyLoginTool"}]'), false);
  });
});

describe("parseWorkspaceIds", () => {
  it("extracts from SSR escaped-quote format", () => {
    assert.deepEqual(parseWorkspaceIds('id=\\"wrk_abc\\"'), ["wrk_abc"]);
  });
  it("extracts from JSON via walk fallback", () => {
    assert.deepEqual(parseWorkspaceIds('{"id":"wrk_json01"}'), ["wrk_json01"]);
  });
  it("extracts from nested JSON arrays", () => {
    assert.deepEqual(parseWorkspaceIds('[{"id":"wrk_a"},{"id":"wrk_b"}]'), ["wrk_a", "wrk_b"]);
  });
  it("returns empty array for content with no workspace IDs", () => {
    assert.deepEqual(parseWorkspaceIds('no ids here'), []);
    assert.deepEqual(parseWorkspaceIds('{"name":"hello"}'), []);
  });
  it("deduplicates IDs", () => {
    assert.deepEqual(parseWorkspaceIds('[{"id":"wrk_dup"},{"id":"wrk_dup"}]'), ["wrk_dup"]);
  });
});
