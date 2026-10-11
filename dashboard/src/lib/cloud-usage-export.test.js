/** @vitest-environment jsdom */
import http from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchCloudUsageExport, serializeCloudUsageExport, cloudExportCsvCell } from "./cloud-usage-export";

const target = vi.hoisted(() => ({ base: "", key: "fixture-anon" }));
vi.mock("./insforge-config", () => ({ getInsforgeRemoteUrl: () => target.base, getInsforgeAnonKey: () => target.key }));
vi.mock("./native-bridge.js", () => ({ saveCloudUsageExport: async () => null }));
const userId = "11111111-1111-4111-8111-111111111111";
let server;
let requests;
let handler;
const membership = { environment: "live", membership: { can_read_cloud: true, phase: "active", status: "active", read_only_until: null } };
const row = { day: "2026-10-01", total_tokens: 100, billable_total_tokens: 100, input_tokens: 60,
  output_tokens: 20, cached_input_tokens: 10, cache_creation_input_tokens: 5, reasoning_output_tokens: 5,
  conversation_count: 2, total_cost_usd: 0.125, prompt: "private-prompt-canary", session_id: "private-session-canary",
  provider_credentials: "private-credential-canary", project: "private-project-canary", path: "private-path-canary", models: { "=SUM(1,2)": 100 } };
function token(id = userId, expiry = Date.now() / 1000 + 300) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ sub: id, role: "authenticated", exp: expiry })).toString("base64url");
  return header + "." + claims + "." + createHmac("sha256", "isolated-export-fixture").update(header + "." + claims).digest("base64url");
}
function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value));
}
const options = () => ({ userId, auth: async () => token(), from: "2026-09-01", to: "2026-10-10",
  fetchImpl: (url, init) => {
    expect(init.cache).toBe("no-store"); expect(init.redirect).toBe("error");
    // Node fetch rejects JSDOM's AbortSignal realm. Keep real HTTP and every
    // owner/window check; transport cancellation has separate component tests.
    const { signal: _signal, ...transport } = init;
    return fetch(url, transport);
  } });
beforeEach(async () => {
  requests = [];
  handler = (url, res) => json(res, url.pathname.endsWith("tokentracker-billing") ? membership :
    { from: "2026-10-01", to: "2026-10-10", data: [row] });
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ url, headers: req.headers });
    handler(url, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  target.base = "http://127.0.0.1:" + server.address().port;
  target.key = "fixture-anon";
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); });

it("uses four fresh authenticated HTTP calls and exports only server daily metrics and explicit scope", async () => {
  const first = await fetchCloudUsageExport(options());
  const second = await fetchCloudUsageExport(options());
  expect(requests).toHaveLength(8);
  expect(requests.every(r => r.headers.authorization?.startsWith("Bearer "))).toBe(true);
  expect(requests.filter(r => r.url.pathname.endsWith("daily")).every(r => r.url.searchParams.get("tz_offset_minutes") === "0")).toBe(true);
  expect(first.metadata.requested_range.from).toBe("2026-09-01");
  expect(first.metadata.effective_range.from).toBe("2026-10-01");
  expect(first.rows[0]).toMatchObject({ total_tokens: 100, estimated_cost_usd: 0.125, conversation_count: 2 });
  expect(first.metadata).toMatchObject({ source: "cloud", timezone: "UTC", cost_basis: "estimated", cost_currency: "USD", row_count: 1 });
  for (const format of ["csv", "json"]) {
    const content = serializeCloudUsageExport(second, format);
    expect(content).not.toMatch(/private-(?:prompt|session|credential|project|path)-canary|SUM\(1,2\)/);
    expect(content).toContain("2026-10-01");
    expect(content).toContain("0.125");
  }
});

it.each([401, 402])("propagates fresh HTTP %s and never falls back to a successful earlier payload", async status => {
  handler = (_url, res) => json(res, { error: "denied" }, status);
  await expect(fetchCloudUsageExport(options())).rejects.toMatchObject({ status });
  expect(requests).toHaveLength(1);
});

it("denies a refreshed expired token before contacting the next endpoint", async () => {
  let calls = 0;
  await expect(fetchCloudUsageExport({ ...options(), auth: async () => ++calls === 1 ? token() : token(userId, 1) })).rejects.toMatchObject({ status: 401 });
  expect(requests).toHaveLength(1);
});

it("rejects another account returned by a late token refresh", async () => {
  let calls = 0;
  await expect(fetchCloudUsageExport({ ...options(), auth: async () => ++calls === 1 ? token() : token("22222222-2222-4222-8222-222222222222") }))
    .rejects.toMatchObject({ status: 401 });
  expect(requests).toHaveLength(1);
});

it("requires a live token getter instead of an object's stale fallback token", async () => {
  await expect(fetchCloudUsageExport({ ...options(), auth: { getAccessToken: async () => null, accessToken: token() } }))
    .rejects.toMatchObject({ status: 401 });
  expect(requests).toHaveLength(0);
});

it("stops after the real HTTP response if the selected instance changes during it", async () => {
  handler = (_url, res) => { target.base = "https://other-backend.invalid"; json(res, membership); };
  await expect(fetchCloudUsageExport(options())).rejects.toMatchObject({ code: "export_instance_changed" });
  expect(requests).toHaveLength(1);
});

it("does not export the first wider range after the final server window narrows", async () => {
  let daily = 0;
  handler = (url, res) => {
    if (url.pathname.endsWith("billing")) return json(res, membership);
    json(res, ++daily === 1 ? { from: "2026-09-01", to: "2026-10-10", data: [row] }
      : { from: "2026-10-05", to: "2026-10-10", data: [] });
  };
  const data = await fetchCloudUsageExport(options());
  expect(data.metadata.effective_range.from).toBe("2026-10-05");
  expect(data.rows).toEqual([]);
  expect(data.metadata.row_count).toBe(0);
  expect(serializeCloudUsageExport(data, "csv")).toContain('"metadata"');
  expect(serializeCloudUsageExport(data, "csv")).not.toContain('"usage"');
});

it("denies access lost at final account verification before exporting earlier data", async () => {
  let billing = 0;
  handler = (url, res) => {
    if (url.pathname.endsWith("billing")) return json(res, ++billing === 1 ? membership : { membership: { can_read_cloud: false } });
    json(res, { from: "2026-10-01", to: "2026-10-10", data: [row] });
  };
  await expect(fetchCloudUsageExport(options())).rejects.toMatchObject({ status: 402 });
  expect(requests).toHaveLength(3);
});

it("rejects a changed policy scope even when Cloud reads remain enabled", async () => {
  let billing = 0;
  handler = (url, res) => {
    if (url.pathname.endsWith("billing")) return json(res, ++billing === 1 ? membership :
      { ...membership, membership: { ...membership.membership, phase: "read_only", read_only_until: "2026-10-11T00:00:00Z" } });
    json(res, { from: "2026-10-01", to: "2026-10-10", data: [row] });
  };
  await expect(fetchCloudUsageExport(options())).rejects.toMatchObject({ code: "export_access_changed" });
  expect(requests).toHaveLength(3);
});

it("sends the selected device to both fresh daily reads", async () => {
  const deviceId = "33333333-3333-4333-8333-333333333333";
  const result = await fetchCloudUsageExport({ ...options(), deviceId });
  expect(requests.filter(r => r.url.pathname.endsWith("daily")).map(r => r.url.searchParams.get("device_id")))
    .toEqual([deviceId, deviceId]);
  expect(result.metadata.device_scope).toBe("selected");
});

it.each(["duplicate", "outside", "negative", "nonfinite"])("rejects %s metrics from a successful HTTP response", async malformed => {
  let rows = [row];
  if (malformed === "duplicate") rows = [row, row];
  if (malformed === "outside") rows = [{ ...row, day: "2026-09-01" }];
  if (malformed === "negative") rows = [{ ...row, total_tokens: -1 }];
  if (malformed === "nonfinite") rows = [{ ...row, total_cost_usd: null }];
  handler = (url, res) => json(res, url.pathname.endsWith("billing") ? membership :
    { from: "2026-10-01", to: "2026-10-10", data: rows });
  await expect(fetchCloudUsageExport(options())).rejects.toMatchObject({ code: "export_invalid_data" });
  expect(requests).toHaveLength(4);
});

it("CSV cells preserve delimiters/newlines and neutralize spreadsheet formula prefixes", () => {
  expect(cloudExportCsvCell('a,"b"\nnext')).toBe('"a,""b""\nnext"');
  for (const value of ["=SUM(1,2)", "+cmd", "-cmd", "@cmd", "\t=SUM(1,2)", "\r@cmd"]) {
    expect(cloudExportCsvCell(value).startsWith('"\'')).toBe(true);
  }
});
