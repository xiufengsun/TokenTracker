import {
  getNativeOAuthBridge,
  isNativeEmbed,
  isNativeLinuxApp,
  isNativeWindowsApp,
  postNativeMessage,
} from "./native-bridge.js";
import { getInsforgeRemoteUrl } from "./insforge-config";

const STORAGE_PREFIX = "tt.cloud.purchase.";
const PURCHASE_FIELDS = [
  "sku", "provider", "request_id", "order_id", "retry_order_id", "retry_request_id",
];
function purchaseRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = {};
  for (const field of PURCHASE_FIELDS) {
    if (typeof value[field] === "string" && value[field].length <= 128)
      record[field] = value[field];
  }
  return record;
}
function purchaseKey(userId) {
  return `${STORAGE_PREFIX}${encodeURIComponent(getInsforgeRemoteUrl() || "unconfigured")}.${userId}`;
}
export const CLOUD_ORDER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readCloudPurchase(userId) {
  try {
    const value = JSON.parse(
      localStorage.getItem(purchaseKey(userId)) || "null",
    );
    if (value?.userId !== undefined && value.userId !== userId) return null;
    const record = purchaseRecord(value);
    return record ? { ...record, userId } : null;
  } catch {
    return null;
  }
}
export function saveCloudPurchase(userId, value) {
  try {
    const record = purchaseRecord(value);
    if (!record) return;
    localStorage.setItem(
      purchaseKey(userId),
      JSON.stringify(record),
    );
  } catch {
    /* URL still preserves order recovery. */
  }
}
export function clearCloudPurchase(userId) {
  try {
    localStorage.removeItem(purchaseKey(userId));
  } catch {
    /* ignore */
  }
}
export function getCloudPurchaseRequest(userId, sku, provider) {
  const current = readCloudPurchase(userId);
  if (
    current?.sku === sku &&
    current.provider === provider &&
    current.request_id
  )
    return current;
  if (current?.request_id) throw new Error("checkout_request_conflict");
  const value = { sku, provider, request_id: crypto.randomUUID() };
  saveCloudPurchase(userId, value);
  return value;
}

export function getCloudCheckoutRestartRequest(userId, order) {
  const current = readCloudPurchase(userId);
  if (current?.order_id && current.order_id !== order.id)
    throw new Error("checkout_request_conflict");
  if (current?.request_id && !current.order_id)
    throw new Error("checkout_request_conflict");
  if (current?.retry_order_id === order.id && current.retry_request_id)
    return current;
  const value = {
    ...current,
    sku: order.sku,
    provider: order.provider,
    order_id: order.id,
    retry_order_id: order.id,
    retry_request_id: crypto.randomUUID(),
  };
  saveCloudPurchase(userId, value);
  return value;
}

export function cloudOrderState(order, membership) {
  if (!order) return "review";
  if (order.payment_state === "refunded") return "refunded";
  if (order.status === "paid") {
    if (membership?.status === "active") return "success";
    if (membership?.status === "expired") return "expired";
    return "activating";
  }
  if (["closed", "canceled", "cancelled"].includes(order.status))
    return "canceled";
  if (
    order.status === "expired" ||
    (order.expires_at && Date.parse(order.expires_at) <= Date.now())
  )
    return "expired";
  return order.checkout_url ? "awaiting" : "creating";
}

export async function openCloudExternal(url, { sameTab = false } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error("invalid_provider_checkout_url");
  }
  if (
    target.username || target.password ||
    (
      target.protocol !== "https:" &&
      !(
        target.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(target.hostname)
      )
    )
  )
    throw new Error("invalid_provider_checkout_url");
  if (isNativeLinuxApp()) {
    const bridge = getNativeOAuthBridge();
    if (!bridge) throw new Error("browser_open_failed");
    await bridge.postMessage(target.toString());
  }
  else if (isNativeEmbed() || isNativeWindowsApp()) {
    if (
      !postNativeMessage({
        type: "action",
        name: "openURL",
        value: target.toString(),
      })
    )
      throw new Error("browser_open_failed");
  } else if (sameTab) {
    // Checkout follows an async request, so a new window may be blocked.
    window.location.assign(target.toString());
  } else {
    window.open(target.toString(), "_blank", "noopener,noreferrer");
  }
}
