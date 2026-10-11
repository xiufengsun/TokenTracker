import { getInsforgeInstanceFingerprint } from "./insforge-config";

const STORAGE_KEY = "tt.cloud.action";
const ACTION_TTL_MS = 30 * 60 * 1000;
const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memoryRecord = null;
let memoryOverride = false;

function loadRecord() {
  if (memoryOverride) return memoryRecord;
  let stored;
  try {
    stored = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryRecord;
  }
  try {
    memoryRecord = JSON.parse(stored || "null");
  } catch {
    memoryRecord = null;
  }
  return memoryRecord;
}

function saveRecord(record) {
  memoryRecord = record;
  try {
    if (record) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    else window.sessionStorage.removeItem(STORAGE_KEY);
    memoryOverride = false;
  } catch {
    // A failed deletion must also shadow an older stored action in this tab.
    memoryOverride = true;
  }
}

function beginAction(params, selection, userId) {
  params.set("flow", crypto.randomUUID());
  const nextPath = `/billing/checkout?${params}`;
  saveRecord({
    nextPath,
    ...selection,
    ownerId: typeof userId === "string" && userId ? userId : null,
    backend: getInsforgeInstanceFingerprint(),
    createdAt: Date.now(),
  });
  return nextPath;
}

export function beginCloudAction({ trial, sku, userId }) {
  if (typeof sku !== "string" || !sku.trim()) throw new TypeError("invalid_cloud_action_sku");
  const params = new URLSearchParams();
  if (trial === true) params.set("intent", "trial");
  params.set("sku", sku);
  return beginAction(params, { trial: trial === true, sku }, userId);
}

export function beginCloudOrderAction({ orderId, userId }) {
  if (typeof orderId !== "string" || !ORDER_ID_PATTERN.test(orderId)) throw new TypeError("invalid_cloud_action_order");
  const params = new URLSearchParams({ order: orderId });
  return beginAction(params, { trial: false, sku: null, orderId }, userId);
}

export function readCloudAction(nextPath, userId) {
  if (typeof nextPath !== "string" || !nextPath.startsWith("/billing/checkout?")) return null;
  const record = loadRecord();
  if (!record || typeof record !== "object" || Array.isArray(record) ||
    record.nextPath !== nextPath ||
    typeof record.backend !== "string" || !record.backend ||
    record.backend !== getInsforgeInstanceFingerprint() ||
    (record.ownerId !== null && (typeof record.ownerId !== "string" || !record.ownerId || record.ownerId !== userId)) ||
    !Number.isFinite(record.createdAt)) return null;
  const skuAction = typeof record.sku === "string" && Boolean(record.sku.trim()) &&
    typeof record.trial === "boolean" && record.orderId === undefined;
  const orderAction = record.trial === false && record.sku === null &&
    typeof record.orderId === "string" && ORDER_ID_PATTERN.test(record.orderId);
  if (!skuAction && !orderAction) return null;
  const age = Date.now() - record.createdAt;
  if (age < 0 || age >= ACTION_TTL_MS) return null;
  return { ...record };
}

export function consumeCloudAction(nextPath, userId) {
  if (typeof userId !== "string" || !userId) return null;
  const record = readCloudAction(nextPath, userId);
  if (!record) return null;
  saveRecord(null);
  return record;
}

export function clearCloudAction(nextPath) {
  if (typeof nextPath !== "string" || !nextPath) return;
  if (loadRecord()?.nextPath === nextPath) saveRecord(null);
}
