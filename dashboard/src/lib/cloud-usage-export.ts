import { resolveAuthAccessToken, isValidJwtShape, type AuthTokenProvider } from "./auth-token";
import { functionUrlFor, fetchFunctionResponse } from "./function-url";
import { getInsforgeRemoteUrl, getInsforgeAnonKey } from "./insforge-config";
import { saveCloudUsageExport } from "./native-bridge.js";

const METRICS = ["total_tokens", "billable_total_tokens", "input_tokens", "output_tokens", "cached_input_tokens",
  "cache_creation_input_tokens", "reasoning_output_tokens", "conversation_count", "total_cost_usd"] as const;
type Metric = Exclude<typeof METRICS[number], "total_cost_usd"> | "estimated_cost_usd";
export type CloudUsageExport = {
  schema: "tokentracker.cloud-usage.v1";
  metadata: { source: "cloud"; backend_origin: string; exported_at: string; timezone: "UTC";
    requested_range: { from: string; to: string }; effective_range: { from: string; to: string };
    device_scope: "all" | "selected"; aggregation: "daily_all_providers"; cost_currency: "USD"; cost_basis: "estimated"; row_count: number };
  rows: ({ day: string } & Record<Metric, number>)[];
};
export class CloudUsageExportError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}
function validDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
function tokenOwner(token: string, expected: string) {
  if (!isValidJwtShape(token)) throw new CloudUsageExportError("export_auth_required", 401);
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "=")));
    // This binds a response to the current UI account. The server verifies the JWT.
    if ((claims.sub || claims.user_id) !== expected || claims.role !== "authenticated" ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw Error();
  } catch { throw new CloudUsageExportError("export_auth_required", 401); }
}
function membershipScope(value: any) {
  if (typeof value?.membership?.can_read_cloud !== "boolean") throw new CloudUsageExportError("export_invalid_data", 503);
  if (!value.membership.can_read_cloud) throw new CloudUsageExportError("export_access_denied", 402);
  const member = value.membership;
  return JSON.stringify([value.environment, member.phase, member.status, member.hosting_mode,
    member.expires_at, member.trial_ends_at, member.transition_ends_at, member.read_only_until]);
}

export async function fetchCloudUsageExport({ userId, auth, from, to, deviceId = null, signal,
  assertCurrent = () => {}, fetchImpl = fetch }: {
  userId: string; auth: AuthTokenProvider; from: string; to: string; deviceId?: string | null;
  signal?: AbortSignal; assertCurrent?: () => void; fetchImpl?: typeof fetch;
}): Promise<CloudUsageExport> {
  if (!validDay(from) || !validDay(to) || from > to) throw new CloudUsageExportError("export_invalid_dates", 400);
  if (typeof auth !== "function") throw new CloudUsageExportError("export_auth_required", 401);
  if (!userId || deviceId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId))
    throw new CloudUsageExportError("export_invalid_scope", 400);
  const baseUrl = getInsforgeRemoteUrl(), anonKey = getInsforgeAnonKey();
  if (!baseUrl) throw new CloudUsageExportError("export_instance_changed", 409);
  const check = () => {
    if (signal?.aborted) throw new CloudUsageExportError("export_cancelled", 409);
    assertCurrent();
    if (baseUrl !== getInsforgeRemoteUrl() || anonKey !== getInsforgeAnonKey())
      throw new CloudUsageExportError("export_instance_changed", 409);
  };
  async function read(slug: string, params: Record<string, string>) {
    check();
    const token = await resolveAuthAccessToken(auth);
    check();
    tokenOwner(token || "", userId);
    const url = new URL(functionUrlFor(baseUrl, slug));
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const requestController = new AbortController();
    const abort = () => requestController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 25_000);
    try {
      const response = await fetchFunctionResponse(url.toString(), { method: "GET", cache: "no-store", redirect: "error",
        signal: requestController.signal,
        headers: { Accept: "application/json", Authorization: "Bearer " + token, ...(anonKey ? { apikey: anonKey } : {}) } }, fetchImpl);
      check();
      if (!response.ok) throw new CloudUsageExportError(response.status === 401 ? "export_auth_required"
        : response.status === 402 || response.status === 403 ? "export_access_denied" : "export_failed", response.status);
      const value = await response.json();
      check();
      return value;
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
  }
  const initial = membershipScope(await read("tokentracker-billing", { action: "account" }));
  const params = { from, to, tz_offset_minutes: "0", ...(deviceId ? { device_id: deviceId } : {}) };
  await read("tokentracker-account-daily", params);
  if (membershipScope(await read("tokentracker-billing", { action: "account" })) !== initial)
    throw new CloudUsageExportError("export_access_changed", 409);
  // The final data request rechecks the server's live readable window. A policy
  // or UTC-day change must not export the earlier request's wider cached rows.
  const data = await read("tokentracker-account-daily", params);
  if (!validDay(data?.from) || !validDay(data?.to) || data.from < from || data.to > to || data.from > data.to ||
      !Array.isArray(data.data) || data.data.length > 1096) throw new CloudUsageExportError("export_invalid_data", 503);
  const days = new Set<string>();
  const rows = data.data.map((row: any) => {
    if (!validDay(row?.day) || row.day < data.from || row.day > data.to || days.has(row.day))
      throw new CloudUsageExportError("export_invalid_data", 503);
    days.add(row.day);
    const result = { day: row.day } as { day: string } & Record<Metric, number>;
    for (const field of METRICS) {
      const value = row[field];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
          field !== "total_cost_usd" && !Number.isSafeInteger(value)) throw new CloudUsageExportError("export_invalid_data", 503);
      result[field === "total_cost_usd" ? "estimated_cost_usd" : field] = value;
    }
    return result;
  }).sort((a: { day: string }, b: { day: string }) => a.day.localeCompare(b.day));
  check();
  return { schema: "tokentracker.cloud-usage.v1", metadata: { source: "cloud", backend_origin: new URL(baseUrl).origin,
    exported_at: new Date().toISOString(), timezone: "UTC", requested_range: { from, to },
    effective_range: { from: data.from, to: data.to }, device_scope: deviceId ? "selected" : "all",
    aggregation: "daily_all_providers", cost_currency: "USD", cost_basis: "estimated", row_count: rows.length }, rows };
}

export function cloudExportCsvCell(value: unknown) {
  const text = String(value ?? "");
  const safe = /^[\s]*[=+\-@]/.test(text) ? "'" + text : text;
  return '"' + safe.replace(/"/g, '""') + '"';
}
export function serializeCloudUsageExport(document: CloudUsageExport, format: "csv" | "json") {
  if (format === "json") return JSON.stringify(document, null, 2) + "\n";
  const metadata = document.metadata;
  const columns = ["row_type", "source", "backend_origin", "exported_at", "timezone", "cost_currency", "cost_basis", "requested_from", "requested_to",
    "effective_from", "effective_to", "device_scope", "aggregation", "row_count", "day", ...METRICS.map(field => field === "total_cost_usd" ? "estimated_cost_usd" : field)];
  const scope = [metadata.source, metadata.backend_origin, metadata.exported_at, metadata.timezone, metadata.cost_currency, metadata.cost_basis,
    metadata.requested_range.from, metadata.requested_range.to, metadata.effective_range.from, metadata.effective_range.to,
    metadata.device_scope, metadata.aggregation, metadata.row_count];
  return [columns, ["metadata", ...scope, "", ...METRICS.map(() => "")], ...document.rows.map(row =>
    ["usage", ...scope, row.day, ...METRICS.map(field => row[field === "total_cost_usd" ? "estimated_cost_usd" : field])])]
    .map(row => row.map(cloudExportCsvCell).join(",")).join("\r\n") + "\r\n";
}
export async function downloadCloudUsageExport(payload: CloudUsageExport, format: "csv" | "json", {
  signal, assertCurrent = () => {},
}: { signal?: AbortSignal; assertCurrent?: () => void } = {}) {
  const content = serializeCloudUsageExport(payload, format);
  const filename = `tokentracker-cloud-usage-${payload.metadata.effective_range.from}-${payload.metadata.effective_range.to}.${format}`;
  const check = () => {
    if (signal?.aborted) throw new CloudUsageExportError("export_cancelled", 409);
    assertCurrent();
  };
  check();
  const saved = await saveCloudUsageExport({ filename, content, format, signal });
  check();
  if (saved?.saved === true) return;
  if (saved !== null) throw new CloudUsageExportError("export_failed", 503);
  const blob = new Blob([content], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
