import {
  isValidJwtShape,
  resolveAuthAccessToken,
  type AuthTokenProvider,
} from "./auth-token";
import { fetchFunctionResponse, functionUrlFor } from "./function-url";
import { getInsforgeAnonKey, getInsforgeRemoteUrl } from "./insforge-config";
import { cloudPromptOwnerFromToken, publishCloudPromptBilling } from "./cloud-prompt-policy.js";

export type CloudProvider = "waffo" | "paddle" | "wechat" | "alipay";
export type CloudPrice = {
  sku: string;
  currency: "CNY" | "USD";
  amount_cents: number;
  term_months: number;
  billing_mode: "recurring" | "fixed";
};
export type CloudMembership = {
  status:
    "legacy_free" | "active" | "trial" | "transition" | "expired" | "free" | "self_hosted";
  hosting_mode?: "hosted" | "self_hosted";
  expires_at?: string | null;
  access_source?: "payment" | "gift" | "mixed" | "none";
  has_gift?: boolean;
  gift_expires_at?: string | null;
  trial_ends_at?: string | null;
  trial_available: boolean;
  transition_ends_at?: string | null;
  read_only_until?: string | null;
  can_read_cloud: boolean;
  can_upload_cloud: boolean;
  machine_limit: number | null;
  sync_interval_seconds: number;
};
export type CloudCatalog = {
  environment: "sandbox" | "live";
  policy: { phase: "preview" | "active"; launch_at: string | null; hosting_mode?: "hosted" | "self_hosted" };
  checkout_verified?: boolean;
  prices: CloudPrice[];
  providers: { waffo: boolean } & Partial<Record<Exclude<CloudProvider, "waffo">, boolean>>;
  limits: {
    machines: number | null;
    sync_minutes: number;
    hourly_history_days: number | null;
    daily_history_months: number | null;
    trial_days: number;
  };
};
export type CloudOrder = {
  id: string;
  provider: CloudProvider;
  sku: string;
  currency: "CNY" | "USD";
  amount_cents: number;
  billing_mode?: "recurring" | "fixed";
  status: string;
  payment_state?: "unpaid" | "paid" | "partially_refunded" | "refunded";
  checkout_url?: string | null;
  expires_at?: string | null;
  retry_payment_conflict_at?: string | null;
};
export type CloudGift = {
  id: string;
  duration_days: 30 | 90 | 365;
  redeemed_at: string;
  starts_at: string;
  ends_at: string;
  revoked_at: string | null;
  state: "active" | "pending" | "expired" | "revoked";
};
export type CloudAccount = {
  environment?: "sandbox" | "live";
  membership: CloudMembership;
  gift_redemption_available?: boolean;
  redemption_restriction?: string | null;
  gifts?: CloudGift[];
  payments: {
    id: string;
    provider: CloudProvider;
    currency: "CNY" | "USD";
    amount_cents: number;
    refunded_cents: number;
    starts_at: string;
    ends_at: string;
    paid_at: string;
  }[];
  subscriptions: {
    provider?: CloudProvider;
    provider_subscription_id: string;
    status: string;
    cancel_at_period_end: boolean;
    next_billed_at?: string | null;
  }[];
  pending_orders?: CloudOrder[];
  conflict_orders?: CloudOrder[];
};

export class CloudBillingError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}

export async function cloudBillingRequest<T>(
  action: string,
  {
    auth,
    body,
    params,
    signal,
  }: {
    auth?: AuthTokenProvider;
    body?: Record<string, unknown>;
    params?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const requestInstance = getInsforgeRemoteUrl();
  const requestAnonKey = getInsforgeAnonKey();
  const assertInstance = () => {
    if (requestInstance !== getInsforgeRemoteUrl() || requestAnonKey !== getInsforgeAnonKey())
      throw new CloudBillingError("instance_changed", 409);
  };
  const headers: Record<string, string> = { apikey: requestAnonKey };
  if (action !== "catalog") {
    const token = await resolveAuthAccessToken(auth);
    assertInstance();
    if (!isValidJwtShape(token))
      throw new CloudBillingError("authentication_required", 401);
    headers.Authorization = `Bearer ${token}`;
  }
  const url = new URL(
    functionUrlFor(requestInstance, "tokentracker-billing"),
  );
  url.searchParams.set("action", action);
  for (const [key, value] of Object.entries(params || {}))
    url.searchParams.set(key, value);
  if (body) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    assertInstance();
    response = await fetchFunctionResponse(url.toString(), {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal || AbortSignal.timeout(25_000),
    });
  } catch (error) {
    assertInstance();
    if (action === "catalog") publishCloudPromptBilling(action, null, null);
    if (signal?.aborted) throw error;
    throw new CloudBillingError("billing_network_error");
  }
  assertInstance();
  const result = await response.json().catch(() => null);
  assertInstance();
  // 202 retains the server order identity after an ambiguous provider response.
  if (
    !response.ok ||
    result?.ok === false ||
    (typeof result?.error === "string" && response.status !== 202)
  ) {
    if (action === "catalog") publishCloudPromptBilling(action, null, null);
    throw new CloudBillingError(
      result?.code || result?.error || "billing_operation_failed",
      response.status,
    );
  }
  if (!result || typeof result !== "object") {
    if (action === "catalog") publishCloudPromptBilling(action, null, null);
    throw new CloudBillingError("billing_operation_failed", response.status);
  }
  publishCloudPromptBilling(action, result, cloudPromptOwnerFromToken(headers.Authorization?.slice(7)));
  assertInstance();
  return result as T;
}

export function cloudCheckoutLaunched(catalog: CloudCatalog | null) {
  if (!catalog || catalog.policy?.phase !== "active") return false;
  const launch = Date.parse(catalog.policy.launch_at || "");
  return Number.isFinite(launch) && launch <= Date.now();
}

export function formatCloudMoney(cents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function cloudAnnualSavings(
  monthly: CloudPrice | undefined,
  annual: CloudPrice | undefined,
) {
  if (
    !monthly ||
    !annual ||
    monthly.currency !== annual.currency ||
    monthly.amount_cents <= 0
  )
    return 0;
  return Math.max(
    0,
    Math.round((1 - annual.amount_cents / (monthly.amount_cents * 12)) * 100),
  );
}
