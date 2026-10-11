import billing from "../../dashboard/edge-patches/tokentracker-billing.ts";
import { BillingError, object } from "../../dashboard/edge-patches/cloud/contracts.ts";
import { base64Bytes } from "../../dashboard/edge-patches/cloud/cryptography.ts";
import { failure, preflight, signedInUser } from "../../dashboard/edge-patches/cloud/runtime.ts";

// A separate test cohort can exercise gifting without modifying the existing
// financial/access QA account roster or its installation fingerprint.
export default async function (req: Request): Promise<Response> {
  const options = preflight(req);
  if (options) return options;
  try {
    const user = await signedInUser(req);
    const payload = req.headers.get("Authorization")!.slice(7).trim().split(".")[1];
    const claims = object(JSON.parse(new TextDecoder().decode(base64Bytes(
      payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="),
    ))));
    if (claims.role !== "authenticated") throw new BillingError("sign_in_required", 401);
    const raw = Deno.env.get("TOKENTRACKER_SANDBOX_GIFT_USER_IDS") || "";
    const users = raw.split(",").map(value => value.trim().toLowerCase());
    if (!raw || raw.length > 8192 || users.some(value =>
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value))) throw new BillingError("sandbox_not_configured", 503);
    if (!users.includes(user.toLowerCase())) throw new BillingError("sandbox_user_not_allowed", 403);
    const action = new URL(req.url).searchParams.get("action") || "account";
    const methods: Record<string, string> = { catalog: "GET", account: "GET", "redeem-gift": "POST" };
    if (!Object.hasOwn(methods, action)) throw new BillingError("sandbox_management_action_not_allowed", 404);
    if (req.method !== methods[action]) throw new BillingError("method_not_allowed", 405);
    return await billing(req);
  } catch (error) { return failure(error); }
}
