import { createClient } from "npm:@insforge/sdk@1.4.5";
import { billingUserId } from "../../dashboard/edge-patches/cloud/auth.ts";
import { BillingError } from "../../dashboard/edge-patches/cloud/contracts.ts";

export const NATIVE_SANDBOX_REALM = "tokentracker-native-sandbox-v1";
export const NATIVE_SANDBOX_SLUG = "tokentracker-native-sandbox-gateway";
export const NATIVE_SANDBOX_BACKEND = "https://srctyff5.us-east.insforge.app";
export const NATIVE_SANDBOX_FUNCTIONS = "https://srctyff5.function2.insforge.app";
export const NATIVE_SANDBOX_URL = `${NATIVE_SANDBOX_FUNCTIONS}/${NATIVE_SANDBOX_SLUG}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS: Record<string, string> = {
  ...Object.fromEntries(["summary", "daily", "hourly", "monthly", "heatmap", "model-breakdown", "devices"]
    .map(name => [`tokentracker-account-${name}`, "GET"])),
  "tokentracker-device-token-issue": "POST", "tokentracker-device-rename": "PATCH", "tokentracker-ingest": "POST",
  "tokentracker-device-flow-authorize": "POST", "tokentracker-device-flow-grant": "POST", "tokentracker-device-flow-poll": "POST",
};
const BILLING_METHODS: Record<string, string> = { catalog: "GET", account: "GET", devices: "GET", order: "GET",
  checkout: "POST", "restart-checkout": "POST", reconcile: "POST", cancel: "POST", portal: "POST", trial: "POST",
  "remove-device": "POST", "resume-device": "POST", "redeem-gift": "POST" };
const MANAGEMENT = new Set(["account", "devices", "remove-device", "resume-device", "redeem-gift"]);
type TokenRow = { user_id: string; cloud_environment: string; revoked_at: unknown } | null;
type Dependencies = { getEnv?: (name: string) => string | undefined; fetchImpl?: typeof fetch;
  lookupToken?: (hash: string) => Promise<TokenRow> };

function ids(raw?: string) {
  const values = (raw || "").split(",").map(value => value.trim().toLowerCase());
  if (!raw || raw.length > 8192 || values.some(value => !UUID.test(value))) throw new BillingError("sandbox_gateway_not_configured", 503);
  return new Set(values);
}
function origin(value: string, loopback = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error();
  return url.origin;
}
async function bounded(stream: ReadableStream<Uint8Array> | null, max: number) {
  if (!stream) return "";
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new BillingError("request_too_large", 413); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(bytes);
}
function safeBusiness(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(safeBusiness);
  if (!value || typeof value !== "object") return true;
  return Object.entries(value).every(([key, child]) =>
    !/password|private.?key|api.?key|secret|refresh.?token|access.?token|authorization/i.test(key) &&
    (key !== "environment" || child === "sandbox") &&
    (key !== "checkout_url" || !child || sandboxCheckoutUrl(child)) && safeBusiness(child));
}
export function sandboxCheckoutUrl(value: unknown) {
  try {
    const raw = String(value), url = new URL(raw);
    return raw.startsWith("https://pancake.waffo.ai/") && url.origin === "https://pancake.waffo.ai" && !url.port && !url.username && !url.password && !url.hash &&
      /^\/store\/[0-9A-Za-z_-]+\/checkout\/cs_[0-9A-Za-z_-]+$/.test(url.pathname) &&
      url.searchParams.getAll("test").length === 1 && url.searchParams.get("test") === "true" &&
      !url.searchParams.has("csId") && !url.searchParams.has("cs_id");
  } catch { return false; }
}

export function createNativeSandboxGateway(dependencies: Dependencies = {}) {
  const get = dependencies.getEnv || ((name: string) => Deno.env.get(name));
  const request = dependencies.fetchImpl || fetch;
  const lookup = dependencies.lookupToken || (async (hash: string): Promise<TokenRow> => {
    const baseUrl = get("INSFORGE_BASE_URL"), service = get("INSFORGE_SERVICE_ROLE_KEY"), anon = get("INSFORGE_ANON_KEY") || get("ANON_KEY");
    if (baseUrl?.replace(/\/$/, "") !== NATIVE_SANDBOX_BACKEND || !service || !anon) throw new BillingError("sandbox_gateway_not_configured", 503);
    const client = createClient({ baseUrl, edgeFunctionToken: service, anonKey: anon, isServerMode: true });
    const result = await client.database.from("tt_cloud_qa_tokentracker_device_tokens")
      .select("user_id,cloud_environment,revoked_at").eq("token_hash", hash).is("revoked_at", null).maybeSingle();
    if (result.error) throw new BillingError("sandbox_gateway_unavailable", 503);
    return result.data as TokenRow;
  });
  return async (req: Request): Promise<Response> => {
    const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "X-TokenTracker-Sandbox-Realm": NATIVE_SANDBOX_REALM, "X-TokenTracker-Billing-Environment": "sandbox" });
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
    try {
      const users = ids(get("TOKENTRACKER_SANDBOX_GATEWAY_USER_IDS"));
      const access = ids(get("TOKENTRACKER_SANDBOX_ACCESS_USER_IDS"));
      const finance = ids(get("TOKENTRACKER_SANDBOX_USER_IDS"));
      let returnOrigin: string, origins: Set<string>;
      try {
        returnOrigin = origin(get("TOKENTRACKER_SANDBOX_BILLING_SITE_URL") || "");
        const configured = (get("TOKENTRACKER_SANDBOX_GATEWAY_ORIGINS") || "").split(",").map(value => origin(value.trim(), true));
        origins = new Set([...configured, returnOrigin]);
      } catch { throw new BillingError("sandbox_gateway_not_configured", 503); }
      const callerOrigin = req.headers.get("Origin");
      if (callerOrigin && !origins.has(callerOrigin)) throw new BillingError("sandbox_gateway_origin_rejected", 403);
      if (callerOrigin) { headers.set("Access-Control-Allow-Origin", callerOrigin); headers.set("Vary", "Origin"); }
      if (req.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-TokenTracker-Sandbox-Realm");
        return new Response(null, { status: 204, headers });
      }
      const url = new URL(req.url);
      const mode = url.searchParams.get("mode");
      if (["mode", "fn", "action"].some(key => url.searchParams.getAll(key).length > 1)) throw new BillingError("invalid_gateway_route", 400);
      if (mode === "profile" && req.method === "GET" && url.searchParams.size === 1) return json({ schemaVersion: 1,
        realm: NATIVE_SANDBOX_REALM, environment: "sandbox", backendBaseUrl: NATIVE_SANDBOX_BACKEND,
        gatewayUrl: NATIVE_SANDBOX_URL, returnSiteOrigin: returnOrigin, returnPath: "/billing/checkout", protocol: "tokentracker-qa",
        auth: { issuerUnchanged: true, brokerRequired: true, refreshCookieCsrfRequired: true },
        functions: { ...METHODS, "tokentracker-billing": Object.fromEntries(Object.entries(BILLING_METHODS).filter(([action]) => action !== "portal")) },
        blockedBillingActions: ["portal"] });
      if (req.headers.get("x-tokentracker-sandbox-realm") !== NATIVE_SANDBOX_REALM) throw new BillingError("sandbox_gateway_realm_required", 403);
      if (["cookie", "x-csrf-token", "apikey", "x-api-key", "x-tokentracker-instance"].some(key => req.headers.has(key))) throw new BillingError("sandbox_gateway_credentials_rejected", 403);
      const name = url.searchParams.get("fn");
      const identity = mode === "identity" && req.method === "GET" && url.searchParams.size === 1;
      const deviceIdentity = mode === "device-identity" && req.method === "GET" && url.searchParams.size === 1;
      if (mode && !identity && !deviceIdentity || !identity && !deviceIdentity && !name) throw new BillingError("invalid_gateway_route", 404);
      let target: string | undefined, financeRoute = false;
      if (!identity && !deviceIdentity) {
        if (["environment", "url", "target", "baseUrl", "backend", "slug"].some(key => url.searchParams.has(key))) throw new BillingError("invalid_gateway_route", 400);
        if (name === "tokentracker-billing") {
          const action = url.searchParams.get("action") || "account";
          if (!Object.hasOwn(BILLING_METHODS, action)) throw new BillingError("invalid_gateway_route", 404);
          if (action === "portal") throw new BillingError("sandbox_portal_not_isolated", 503);
          if (BILLING_METHODS[action] !== req.method) throw new BillingError("method_not_allowed", 405);
          financeRoute = !MANAGEMENT.has(action);
          target = financeRoute ? "tokentracker-billing-sandbox" : "tokentracker-billing-access-sandbox";
        } else {
          if (!name || !Object.hasOwn(METHODS, name)) throw new BillingError("invalid_gateway_route", 404);
          if (METHODS[name] !== req.method) throw new BillingError("method_not_allowed", 405);
          target = name + "-sandbox";
        }
      }
      const authorization = req.headers.get("Authorization") || "";
      let user: string;
      if (name === "tokentracker-ingest" || deviceIdentity) {
        const token = authorization.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
        if (!token) throw new BillingError("sandbox_device_token_rejected", 401);
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map(value => value.toString(16).padStart(2, "0")).join("");
        const row = await lookup(hash);
        if (!row || row.cloud_environment !== "sandbox" || row.revoked_at !== null || !UUID.test(row.user_id)) throw new BillingError("sandbox_device_token_rejected", 401);
        user = row.user_id.toLowerCase();
      } else {
        user = (await billingUserId(authorization, { jwtSecret: get("JWT_SECRET"), jwtPublicKey: get("JWT_PUBLIC_KEY") })).toLowerCase();
        const claims = JSON.parse(atob(authorization.slice(7).trim().split(".")[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(authorization.slice(7).trim().split(".")[1].length / 4) * 4, "=")));
        if (claims.role !== "authenticated") throw new BillingError("sign_in_required", 401);
      }
      if (!users.has(user) || !access.has(user) || financeRoute && !finance.has(user)) throw new BillingError("sandbox_gateway_user_rejected", 403);
      if (identity) return json({ realm: NATIVE_SANDBOX_REALM, environment: "sandbox", user_id: user, authenticated: true, billing_allowed: finance.has(user) });
      if (deviceIdentity) return json({ realm: NATIVE_SANDBOX_REALM, environment: "sandbox", user_id: user, authenticated: true, upload_scope: "qa_device" });
      let body: string | undefined;
      if (req.method !== "GET") {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("Content-Type") || "")) throw new BillingError("json_content_type_required", 415);
        body = await bounded(req.body, name === "tokentracker-ingest" ? 1_048_576 : 16_384);
        let input; try { input = JSON.parse(body); } catch { throw new BillingError("invalid_request_body", 400); }
        if (!input || typeof input !== "object" || Array.isArray(input) || input.environment !== undefined ||
          name === "tokentracker-billing" && input.provider !== undefined && input.provider !== "waffo") throw new BillingError("invalid_request_body", 400);
      }
      const upstream = new URL(`${NATIVE_SANDBOX_FUNCTIONS}/${target}`);
      for (const [key, value] of url.searchParams) if (key !== "fn") upstream.searchParams.append(key, value);
      let response;
      try { response = await request(upstream, { method: req.method, headers: { Authorization: authorization,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
      catch { throw new BillingError("sandbox_gateway_unavailable", 502); }
      let value; try { value = JSON.parse(await bounded(response.body, 4_194_304)); } catch { throw new BillingError("sandbox_gateway_invalid_response", 502); }
      if (!value || typeof value !== "object" || !safeBusiness(value)) throw new BillingError("sandbox_gateway_invalid_response", 502);
      if (!response.ok) {
        const code = typeof value.error === "string" && /^[a-z0-9_]{1,100}$/.test(value.error) ? value.error : "sandbox_request_rejected";
        return json({ error: code, ...(typeof value.membership === "object" ? { membership: value.membership } : {}) }, response.status);
      }
      return json(value, response.status);
    } catch (error) { return json({ error: error instanceof BillingError ? error.code : "sandbox_gateway_unavailable" }, error instanceof BillingError ? error.status : 503); }
  };
}

export default createNativeSandboxGateway();
