import { getInsforgeRemoteUrl } from "./insforge-config";

export const CLOUD_PROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_FRESH_MS = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const scenes = new Set(["sync", "view", "history", "devices"]);
const accessCodes = new Set([
  "cloud_membership_required", "cloud_read_only_expired", "cloud_history_window_exceeded",
  "cloud_machine_limit", "machine_limit_exceeded", "cloud_machine_paused",
]);
const accounts = new Map();
const listeners = new Set();
const volatileDismissals = new Map();
const writableStores = new WeakMap();
let catalogRecord = null;
let revision = 0;
function accountKey(userId) {
  return `${encodeURIComponent(getInsforgeRemoteUrl() || "unconfigured")}.${userId}`;
}

function changed() {
  revision += 1;
  for (const listener of listeners) listener();
}
export function subscribeCloudPrompts(listener) {
  if (listeners.size === 0 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}
function onStorage(event) {
  if (event.key?.startsWith("tt.cloud.prompt.") && event.key !== "tt.cloud.prompt.storage-check") changed();
}
export function cloudPromptRevision() { return revision; }
export function clearCloudPromptBackendState() {
  accounts.clear();
  catalogRecord = null;
  changed();
}
export function readCloudPromptState(userId) {
  const currentCatalog = catalogRecord?.baseUrl === getInsforgeRemoteUrl() ? catalogRecord : null;
  return { ...accounts.get(accountKey(userId)), catalog: currentCatalog?.value, catalogObservedAt: currentCatalog?.at };
}
export function cloudPromptOwnerFromToken(token) {
  try {
    const value = JSON.parse(atob(String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof value.sub === "string" && value.sub.length <= 128 ? value.sub : null;
  } catch { return null; }
}

// Observe existing responses only. No prompt makes a request or stores a JWT.
export function publishCloudPromptBilling(action, value, userId, now = Date.now()) {
  if (action === "catalog") {
    catalogRecord = { value, at: now, baseUrl: getInsforgeRemoteUrl() };
    changed();
    return;
  }
  if (!userId || !value || typeof value !== "object") return;
  const previous = accounts.get(accountKey(userId)) || {};
  const next = { ...previous };
  if (Number.isFinite(value.machine_count)) next.machineCount = value.machine_count;
  if (value.membership) {
    next.membership = value.membership;
    next.subscriptions = value.subscriptions || previous.subscriptions;
    next.paymentConflict = "conflict_orders" in value || "pending_orders" in value
      ? [...(value.conflict_orders || []), ...(value.pending_orders || [])].some((order) => order.retry_payment_conflict_at)
      : Boolean(value.order?.retry_payment_conflict_at || previous.paymentConflict);
    next.failure = value.membership.can_read_cloud && value.membership.can_upload_cloud &&
      previous.membership?.status !== value.membership.status ? null : previous.failure;
  } else if (!Number.isFinite(value.machine_count)) {
    return;
  }
  accounts.set(accountKey(userId), next);
  changed();
}
export function recordCloudPromptIntent(userId, scene) {
  if (!userId || !scenes.has(scene)) return;
  const previous = accounts.get(accountKey(userId)) || {};
  accounts.set(accountKey(userId), { ...previous, intent: scene, failure: null });
  changed();
}
export function clearCloudPromptIntent(userId) {
  if (!accounts.has(accountKey(userId))) return;
  accounts.set(accountKey(userId), { ...accounts.get(accountKey(userId)), intent: null, failure: null });
  changed();
}
export function recordCloudPromptFailure(userId, code, membership, source, details = {}) {
  if (!userId || !accessCodes.has(code)) return;
  const previous = accounts.get(accountKey(userId)) || {};
  const next = { ...previous, membership: membership || previous.membership,
    failure: { code, source } };
  if (Number.isFinite(details?.machineCount)) next.machineCount = details.machineCount;
  accounts.set(accountKey(userId), next);
  changed();
}
export function clearCloudPromptFailure(userId, source) {
  const previous = accounts.get(accountKey(userId));
  if (previous?.failure?.source !== source) return;
  accounts.set(accountKey(userId), { ...previous, failure: null });
  changed();
}

function browserStorage() {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}
function readDismissal(userId, storage) {
  const fallback = volatileDismissals.get(accountKey(userId)) || { scenes: {} };
  try {
    if (!storage) return { ...fallback, usable: false };
    if (!writableStores.has(storage)) {
      try {
        storage.setItem("tt.cloud.prompt.storage-check", "1");
        storage.removeItem("tt.cloud.prompt.storage-check");
        writableStores.set(storage, true);
      } catch { writableStores.set(storage, false); }
    }
    if (!writableStores.get(storage)) return { ...fallback, usable: false };
    const raw = storage.getItem(`tt.cloud.prompt.${accountKey(userId)}`);
    if (!raw) return { ...fallback, usable: true };
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !saved.scenes || typeof saved.scenes !== "object")
      return { ...fallback, usable: false };
    const mergedScenes = { ...saved.scenes };
    for (const [scene, until] of Object.entries(fallback.scenes))
      mergedScenes[scene] = Math.max(Number(mergedScenes[scene]) || 0, Number(until) || 0);
    return { ...saved, globalUntil: Math.max(saved.globalUntil || 0, fallback.globalUntil || 0),
      scenes: mergedScenes, usable: true };
  } catch { return { ...fallback, usable: false }; }
}
export function dismissCloudPrompt(userId, scene, now = Date.now(), storage = browserStorage()) {
  if (!userId || !scene) return;
  const current = readDismissal(userId, storage);
  const record = { version: 1, globalUntil: now + CLOUD_PROMPT_COOLDOWN_MS,
    scenes: { ...current.scenes, [scene]: now + CLOUD_PROMPT_COOLDOWN_MS } };
  volatileDismissals.set(accountKey(userId), record);
  try { storage?.setItem(`tt.cloud.prompt.${accountKey(userId)}`, JSON.stringify(record)); }
  catch { if (storage) writableStores.set(storage, false); }
  changed();
}
function cooling(userId, scene, promotional, now, storage) {
  const dismissal = readDismissal(userId, storage);
  return { usable: dismissal.usable,
    hidden: Number(dismissal.scenes[scene]) > now || (promotional && Number(dismissal.globalUntil) > now) };
}
function canOfferCloud(catalog, at, now) {
  const launch = Date.parse(catalog?.policy?.launch_at || "");
  return catalog?.environment === "live" && catalog?.policy?.phase === "active" &&
    Number.isFinite(launch) && launch <= now && catalog?.providers?.waffo === true && catalog.checkout_verified === true &&
    Number.isFinite(at) && now >= at && now - at <= CATALOG_FRESH_MS;
}

/** Trial, transition, and fixed paid-term reminders share a final 7-day window. */
export const CLOUD_DEADLINE_WINDOW_DAYS = 7;

function membershipDeadlineEnd(membership) {
  const status = membership?.status;
  if (status === "trial") return membership.trial_ends_at;
  if (status === "transition") return membership.transition_ends_at;
  if (status === "active") return membership.expires_at;
  return null;
}

function withinCloudDeadlineWindow(membership, subscriptions = [], now = Date.now()) {
  if (!membership) return false;
  const status = membership.status;
  if (!["active", "trial", "transition"].includes(status)) return false;
  if (status === "active" && subscriptions.some((item) =>
    ["active", "trialing"].includes(item.status) && !item.cancel_at_period_end)) return false;
  const remaining = Date.parse(membershipDeadlineEnd(membership) || "") - now;
  return Number.isFinite(remaining) && remaining > 0 && remaining <= CLOUD_DEADLINE_WINDOW_DAYS * DAY;
}

/** Sales CTAs only for multi-device accounts or an approaching trial/transition/paid end. */
export function cloudPromotionTargetReason(machineCount, membership, subscriptions = [], now = Date.now()) {
  if (withinCloudDeadlineWindow(membership, subscriptions, now)) return "deadline";
  if (Number(machineCount) >= 2) return "multi_device";
  return null;
}

export function cloudContextualPromptDecision({ userId, intentional = false, scene, membership,
  failure, subscriptions = [], catalog, catalogObservedAt, paymentConflict = false, machineCount,
  now = Date.now(), storage = browserStorage() }) {
  if (!userId || !intentional || !scenes.has(scene) || paymentConflict ||
    membership?.status === "self_hosted" || membership?.hosting_mode === "self_hosted" ||
    catalog?.policy?.hosting_mode === "self_hosted") return null;
  const code = failure?.code;
  const deviceIssue = ["cloud_machine_limit", "machine_limit_exceeded", "cloud_machine_paused"].includes(code);
  const historyIssue = code === "cloud_history_window_exceeded";
  const promptScene = deviceIssue ? "devices" : historyIssue ? "history" : scene;
  const available = membership?.can_read_cloud || membership?.can_upload_cloud;
  const paid = membership?.status === "active";
  const limited = deviceIssue || historyIssue || ["cloud_membership_required", "cloud_read_only_expired"].includes(code);
  if (membership && !membership.can_upload_cloud && (scene === "sync" || limited) &&
    subscriptions.some((item) => ["active", "trialing", "past_due", "paused"].includes(item.status) && !item.cancel_at_period_end)) {
    const cooldown = cooling(userId, promptScene, false, now, storage);
    if (cooldown.hidden) return null;
    return { scene: promptScene, kind: "operation", bodyKey: "cloud.prompt.billing_recovery",
      ctaKey: "cloud.action.view_bills", href: "/settings?section=cloud" };
  }
  if (paid || (available && scene !== "sync") || (deviceIssue && !membership)) {
    if (!deviceIssue && !historyIssue) return null;
    const cooldown = cooling(userId, promptScene, false, now, storage);
    if (cooldown.hidden) return null;
    return { scene: promptScene, kind: "operation", bodyKey: deviceIssue ? "cloud.prompt.devices_manage" : "cloud.prompt.history_window",
      ctaKey: "cloud.action.manage_membership", href: "/settings?section=cloud" };
  }
  if (membership?.can_upload_cloud) return null;
  if (scene !== "sync" && !limited) return null;
  const cooldown = cooling(userId, promptScene, true, now, storage);
  if (cooldown.hidden) return null;
  const ready = cooldown.usable && membership?.environment === "live" && membership?.phase === "active" &&
    canOfferCloud(catalog, catalogObservedAt, now);
  const reason = ready
    ? cloudPromotionTargetReason(machineCount, membership, subscriptions, now)
    : null;
  // Single-device free users keep learn-more explanations, not trial/purchase CTAs.
  if (ready && reason) {
    return { scene: promptScene, kind: "promotion", reason,
      bodyKey: `cloud.prompt.${promptScene}`,
      ctaKey: membership?.trial_available ? "cloud.prompt.try" : "cloud.action.view_plans",
      href: membership?.trial_available ? "/billing/checkout?intent=trial" : "/cloud" };
  }
  return { scene: promptScene, kind: "explanation",
    bodyKey: ready ? `cloud.prompt.${promptScene}` : "cloud.prompt.unconfirmed",
    ctaKey: "cloud.prompt.learn", href: "/cloud" };
}

export function cloudDeadlinePromptDecision({ userId, membership, subscriptions = [], now = Date.now(), storage = browserStorage() }) {
  if (!userId || !membership) return null;
  const status = membership.status;
  if (!["active", "trial", "transition"].includes(status)) return null;
  if (status === "active" && subscriptions.some((item) =>
    ["active", "trialing"].includes(item.status) && !item.cancel_at_period_end)) return null;
  const end = membershipDeadlineEnd(membership);
  if (!withinCloudDeadlineWindow(membership, subscriptions, now)) return null;
  const giftOnly = status === "active" && membership.access_source === "gift";
  const scene = giftOnly ? "deadline_gift" : `deadline_${status}`;
  const cooldown = cooling(userId, scene, false, now, storage);
  if (cooldown.hidden || !cooldown.usable) return null;
  return { scene, kind: "deadline", reason: "deadline", bodyKey: `cloud.prompt.${scene}`, date: end };
}
