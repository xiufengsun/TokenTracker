import { BillingError, object, type BillingEnvironment } from "./contracts.ts";
import type { billingClient } from "./runtime.ts";

type Client = ReturnType<typeof billingClient>;

// Codes are hashed before the database call. Only ASCII formatting is accepted.
export async function giftCodeHash(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || value.length > 256 || /[^\x00-\x7f]/.test(value)) return null;
  const canonical = value.replace(/[- \t\r\n\f\v]/g, "").toUpperCase();
  if (!/^TTPRO[0-9A-F]{32}$/.test(canonical)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function missingGiftRpc(error: Record<string, unknown>, name: string): boolean {
  const message = String(error.message || "");
  return (error.code === "PGRST202" || error.code === "42883") && message.includes(name);
}

export async function giftAccount(client: Client, userId: string, environment: BillingEnvironment) {
  const result = await client.database.rpc("cloud_gift_account", { p_user_id: userId, p_environment: environment });
  if (result.error) {
    if (missingGiftRpc(object(result.error), "cloud_gift_account")) {
      return { gifts: [], gift_redemption_available: false };
    }
    throw new BillingError("billing_operation_failed", 503);
  }
  return object(result.data);
}

export async function redeemGift(client: Client, userId: string, environment: BillingEnvironment,
  code: unknown, requestId: string) {
  const result = await client.database.rpc("cloud_redeem_gift", {
    p_user_id: userId, p_environment: environment, p_code_hash: await giftCodeHash(code), p_request_id: requestId,
  });
  if (result.error) {
    if (missingGiftRpc(object(result.error), "cloud_redeem_gift")) throw new BillingError("gift_not_available", 503);
    throw new BillingError("billing_operation_failed", 503);
  }
  const data = object(result.data);
  if (data.ok === false) return { status: Number(data.status) || 400, data: { error: data.code, retry_after: data.retry_after } };
  if (data.ok !== true || !data.gift || !data.membership) throw new BillingError("billing_operation_failed", 503);
  return { status: 200, data: { gift: data.gift, membership: data.membership, already_redeemed: data.reused === true } };
}
