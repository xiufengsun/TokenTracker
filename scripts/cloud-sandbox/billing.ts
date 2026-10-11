import billing from "../../dashboard/edge-patches/tokentracker-billing.ts";
import { BillingError } from "../../dashboard/edge-patches/cloud/contracts.ts";
import { failure, preflight, signedInUser } from "../../dashboard/edge-patches/cloud/runtime.ts";

export default async function (req: Request): Promise<Response> {
  const options = preflight(req);
  if (options) return options;
  try {
    const userId = await signedInUser(req);
    const value = Deno.env.get("TOKENTRACKER_SANDBOX_USER_IDS") || "";
    const users = value.split(",").map(id => id.trim().toLowerCase());
    if (value.length > 8192 || users.length === 0 ||
      users.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
      throw new BillingError("sandbox_not_configured", 503);
    }
    if (!users.includes(userId.toLowerCase())) throw new BillingError("sandbox_user_not_allowed", 403);
    return await billing(req);
  } catch (error) {
    return failure(error);
  }
}
