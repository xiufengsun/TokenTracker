import { BillingError } from "../../dashboard/edge-patches/cloud/contracts.ts";
import { billingClient, failure, json, signedInUser } from "../../dashboard/edge-patches/cloud/runtime.ts";

type Handler = (req: Request) => Promise<Response>;
export type AccessKind = "user" | "ingest" | "authorize" | "poll" | "management";
function allowedUsers(): string[] {
  const raw = Deno.env.get("TOKENTRACKER_SANDBOX_ACCESS_USER_IDS") || "";
  const ids = raw.split(",").map(id => id.trim().toLowerCase());
  if (raw.length > 8192 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new BillingError("sandbox_access_not_configured", 503);
  }
  return ids;
}
async function authenticatedUser(req: Request, users: string[]) {
  const id = await signedInUser(req);
  try {
    const part = req.headers.get("Authorization")!.split(".")[1];
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    if (claims.role !== "authenticated") throw Error();
  } catch { throw new BillingError("sign_in_required", 401); }
  if (!users.includes(id.toLowerCase())) throw new BillingError("sandbox_access_user_not_allowed", 403);
  return id;
}
async function boundedInput(req: Request) {
  if (Number(req.headers.get("Content-Length")) > 16_384) throw new BillingError("request_too_large", 413);
  const raw = await req.clone().text();
  if (new TextEncoder().encode(raw).length > 16_384) throw new BillingError("request_too_large", 413);
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
function verificationOrigin() {
  try {
    const url = new URL(Deno.env.get("TOKENTRACKER_SANDBOX_ACCESS_SITE_URL") || "");
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw Error();
    return url.origin;
  } catch { throw new BillingError("sandbox_access_site_not_configured", 503); }
}

export function guardAccess(handler: Handler, kind: AccessKind): Handler {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return await handler(req);
    try {
      const users = allowedUsers();
      let callerUserId: string | null = null;
      if (kind === "ingest") {
        const token = req.headers.get("Authorization")?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
        if (!token) throw new BillingError("sandbox_device_token_rejected", 401);
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))))
          .map(value => value.toString(16).padStart(2, "0")).join("");
        const result = await billingClient().database.from("tokentracker_device_tokens")
          .select("user_id,cloud_environment").eq("token_hash", hash).is("revoked_at", null).maybeSingle();
        if (result.error) throw new BillingError("sandbox_access_unavailable", 503);
        if (!result.data || result.data.cloud_environment !== "sandbox") throw new BillingError("sandbox_device_token_rejected", 401);
        if (!users.includes(String(result.data.user_id).toLowerCase())) throw new BillingError("sandbox_access_user_not_allowed", 403);
      } else {
        const userId = await authenticatedUser(req, users);
        callerUserId = userId;
        const input = req.method === "POST" ? await boundedInput(req) : {};
        const deviceCode = typeof input?.device_code === "string" ? input.device_code.trim() : "";
        if (kind === "poll") {
          if (!/^[0-9a-f]{64}$/.test(deviceCode)) return json({ status: "unknown" }, 404);
          const result = await billingClient().database.from("tokentracker_device_codes")
            .select("user_id,status,expires_at").eq("device_code", deviceCode).maybeSingle();
          if (result.error) throw new BillingError("sandbox_access_unavailable", 503);
          if (!result.data) return json({ status: "unknown" }, 404);
          if (result.data?.user_id && String(result.data.user_id).toLowerCase() !== userId.toLowerCase()) {
            throw new BillingError("sandbox_access_user_not_allowed", 403);
          }
          if (Date.now() > Date.parse(String(result.data.expires_at))) return json({ status: "expired" }, 410);
          // An approved owner cannot change through the grant RPC. Waiting here
          // avoids minting for a peer who grants a pending code between reads.
          if (result.data.status !== "approved" || !result.data.user_id) return json({ status: "pending" });
        }
        if (kind === "management") {
          const methods: Record<string, string> = { account: "GET", devices: "GET", "remove-device": "POST", "resume-device": "POST", "redeem-gift": "POST" };
          const action = new URL(req.url).searchParams.get("action") || "account";
          if (!Object.hasOwn(methods, action)) throw new BillingError("sandbox_management_action_not_allowed", 404);
          if (methods[action] !== req.method) throw new BillingError("method_not_allowed", 405);
        }
      }
      const origin = kind === "authorize" ? verificationOrigin() : null;
      const response = await handler(req);
      if (kind === "poll" && response.ok) {
        const result = await response.json();
        if ((result.status === "approved" || Object.hasOwn(result, "device_token")) &&
          String(result.user_id).toLowerCase() !== callerUserId?.toLowerCase()) {
          throw new BillingError("sandbox_access_user_not_allowed", 403);
        }
        return Response.json(result, { status: response.status, headers: response.headers });
      }
      if (origin && response.ok) {
        const result = await response.json();
        result.verification_uri = `${origin}/device`;
        result.verification_uri_complete = `${origin}/device?user_code=${encodeURIComponent(result.user_code)}`;
        return Response.json(result, { status: response.status, headers: response.headers });
      }
      return response;
    } catch (error) { return failure(error); }
  };
}
