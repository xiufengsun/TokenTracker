export type BillingEnvironment = "sandbox" | "live";
export type PaymentProvider = "paddle" | "wechat" | "alipay" | "waffo";

export interface CloudOrder {
  id: string;
  user_id: string;
  environment: BillingEnvironment;
  provider: PaymentProvider;
  sku: string;
  currency: "USD" | "CNY";
  amount_cents: number;
  term_months: number;
  billing_mode?: "fixed" | "recurring";
  provider_order_id: string | null;
  provider_checkout_id?: string | null;
  waffo_order_id?: string | null;
  retry_order_id?: string | null;
  retry_payment_conflict_at?: string | null;
  provider_price_id?: string | null;
  checkout_url: string | null;
  status: string;
  expires_at: string;
}

export class BillingError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BillingError("invalid_provider_payload");
  return value as Record<string, unknown>;
}

export function text(value: unknown, maxLength = 200): string {
  if (typeof value !== "string" || !value || value.length > maxLength) throw new BillingError("invalid_provider_field");
  return value;
}

export function cents(value: unknown): number {
  if ((typeof value !== "string" || !/^\d+$/.test(value)) &&
    (typeof value !== "number" || !Number.isInteger(value))) throw new BillingError("invalid_provider_amount");
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 2147483647) throw new BillingError("invalid_provider_amount");
  return amount;
}

export function decimalCents(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new BillingError("invalid_provider_amount");
  const [whole, decimal = ""] = value.split(".");
  return cents(Number(whole) * 100 + Number(decimal.padEnd(2, "0")));
}

export function isoDate(value: unknown): string {
  const date = text(value);
  if (!Number.isFinite(Date.parse(date))) throw new BillingError("invalid_provider_date");
  return new Date(date).toISOString();
}

export function uuid(value: unknown): string {
  const id = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new BillingError("invalid_order_id");
  return id;
}

export interface PaymentEvent {
  event_id: string;
  kind: "payment" | "refund" | "subscription";
  action_id: string;
  order_id: string;
  occurred_at: string;
  transaction_id?: string;
  currency?: string;
  base_amount_cents?: number;
  amount_cents?: number;
  refund_total_cents?: number;
  subscription_id?: string;
  starts_at?: string;
  ends_at?: string;
  status?: string;
  cancel_at_period_end?: boolean;
  next_billed_at?: string | null;
  waffo_order_id?: string;
  provider_price_id?: string;
  period_number?: number;
}

export type Fetcher = typeof fetch;

export async function providerJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new BillingError("payment_provider_unavailable", 502);
  return object(await response.json().catch(() => null));
}
