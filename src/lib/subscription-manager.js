const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");

const { readJsonStrict, writeFileAtomic, chmod600IfPossible } = require("./fs");

// Manual subscription manager: user-entered billing plans (service, plan,
// auto-renew flag, next renewal/expiry timestamp). Distinct from
// subscriptions.js (auto-detected local plan tiers) and usage-limits.js
// (rate-limit window resets) — see issue #460.
const STORE_FILE = "subscription-manager.json";
const STORE_VERSION = 1;
const MAX_TEXT_LENGTH = 120;
const CYCLE_UNITS = new Set(["weekly", "monthly", "yearly"]);

function resolveSubscriptionsPath(trackerDir) {
  return path.join(trackerDir, STORE_FILE);
}

function normalizeText(value, { required, field, maxLength = MAX_TEXT_LENGTH } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

// Accepts epoch milliseconds or any Date-parseable string. Stored values are
// UTC ISO strings truncated to whole minutes so comparisons stay clean and a
// second-level drift between input formats never changes the billed minute.
function normalizeBillingTime(value) {
  let ms;
  if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("nextBillingAt is required");
    ms = new Date(trimmed).getTime();
  } else {
    throw new Error("nextBillingAt is required");
  }
  if (!Number.isFinite(ms)) throw new Error("nextBillingAt must be a valid date");
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

// Billing cycle length. Drives the progress bar span and how far an
// auto-renew subscription rolls forward after a recorded renewal passes.
// Defaults to monthly so pre-cycle records keep their original semantics.
function normalizeCycle(value) {
  if (value === null || value === undefined) return "monthly";
  if (typeof value !== "string" || !CYCLE_UNITS.has(value)) {
    throw new Error("cycle must be one of: weekly, monthly, yearly");
  }
  return value;
}

function normalizeSubscriptionFields(fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("subscription must be an object");
  }
  if (typeof fields.autoRenew !== "boolean") {
    throw new Error("autoRenew must be a boolean");
  }
  return {
    service: normalizeText(fields.service, { required: true, field: "service" }),
    plan: normalizeText(fields.plan ?? null, { required: false, field: "plan" }),
    // Optional link to a usage-limits provider row (e.g. "codex"). The value
    // is a limits provider id but is not validated against the canonical list
    // here — the backend stays lenient, the dropdown constrains it in the UI.
    provider: normalizeText(fields.provider ?? null, {
      required: false,
      field: "provider",
      maxLength: 64,
    }),
    autoRenew: fields.autoRenew,
    cycle: normalizeCycle(fields.cycle),
    nextBillingAt: normalizeBillingTime(fields.nextBillingAt),
  };
}

function isValidStoredRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (typeof record.id !== "string" || !record.id) return false;
  if (typeof record.service !== "string" || !record.service) return false;
  if (typeof record.autoRenew !== "boolean") return false;
  if (typeof record.nextBillingAt !== "string") return false;
  return Number.isFinite(new Date(record.nextBillingAt).getTime());
}

// Read the store. Any state other than a clean file or a plainly missing one
// must never collapse into an empty store on its own: the next write would
// silently destroy every stored subscription (user-entered data that cannot
// be rebuilt from logs). Reads surface the damage as an error; only the write
// path may recover, and only after backing the original file up.
async function readStore(filePath, { forWrite = false } = {}) {
  const { status, value, error } = await readJsonStrict(filePath);
  if (status === "missing") {
    return { store: { version: STORE_VERSION, items: [] }, needsBackup: false };
  }
  if (status === "error") {
    // Unreadable (permissions, I/O error): refuse — a blind overwrite would
    // destroy data we were never able to see.
    throw new Error(`Cannot read subscription store: ${error?.message || String(error)}`);
  }
  if (status === "invalid" || !value || typeof value !== "object" || Array.isArray(value)) {
    if (!forWrite) {
      throw new Error("Subscription store is corrupted (invalid JSON)");
    }
    return { store: { version: STORE_VERSION, items: [] }, needsBackup: true };
  }
  if (!Array.isArray(value.items)) {
    // Valid JSON object without a usable items array: nothing recoverable
    // inside, so an empty store is honest. If the key exists with a wrong
    // type, keep the file backed up before a write replaces it.
    return {
      store: { version: STORE_VERSION, items: [] },
      needsBackup: value.items !== undefined,
    };
  }
  const items = [];
  let dropped = false;
  for (const item of value.items) {
    if (isValidStoredRecord(item)) {
      items.push(item);
    } else {
      dropped = true;
    }
  }
  const version = Number.isFinite(value.version) ? value.version : STORE_VERSION;
  return { store: { version, items }, needsBackup: dropped };
}

// A write is about to replace a store that contained unreadable data — keep
// a copy around first so nothing is lost without a trace. Copy (not rename):
// if the replacement write then fails, the canonical path must still hold the
// damaged original, otherwise the next write would treat it as missing and
// start from an empty store.
async function backupDamagedStore(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await fs.copyFile(filePath, `${filePath}.corrupt-${stamp}`);
  } catch (e) {
    if (e?.code !== "ENOENT") {
      throw new Error(`Cannot back up the damaged subscription store: ${e?.message || String(e)}`);
    }
  }
}

async function loadStoreForWrite(filePath) {
  const { store, needsBackup } = await readStore(filePath, { forWrite: true });
  if (needsBackup) await backupDamagedStore(filePath);
  return store;
}

async function writeStore(filePath, store) {
  // Private from creation: the 0o600 applies to the tmp file before the
  // rename, so a crash before the fallback chmod cannot leave a
  // world-readable store behind.
  await writeFileAtomic(filePath, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  await chmod600IfPossible(filePath);
}

function sortByNextBillingAt(items) {
  return [...items].sort((a, b) =>
    new Date(a.nextBillingAt).getTime() - new Date(b.nextBillingAt).getTime(),
  );
}

// In-process FIFO queue per store file. Every mutation is a full
// read-modify-write transaction; without serialization two concurrent writes
// read the same snapshot and the later one silently drops the earlier change
// (issue: 30 concurrent creates survived as a single record). The queue keeps
// independent store files unblocked while ordering operations on the same one.
const storeLocks = new Map();

function withStoreLock(filePath, operation) {
  const previous = storeLocks.get(filePath) || Promise.resolve();
  // Run even if the previous transaction rejected; its error already reached
  // its own caller and must not wedge the queue.
  const run = previous.then(operation, operation);
  storeLocks.set(filePath, run.then(() => undefined, () => undefined));
  return run;
}

async function listSubscriptions({ trackerDir }) {
  const { store } = await readStore(resolveSubscriptionsPath(trackerDir));
  return sortByNextBillingAt(store.items);
}

async function createSubscription({ trackerDir, fields }) {
  // Validate before taking the lock so a bad payload never queues a write.
  const normalized = normalizeSubscriptionFields(fields);
  const filePath = resolveSubscriptionsPath(trackerDir);
  return withStoreLock(filePath, async () => {
    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      ...normalized,
      createdAt: now,
      updatedAt: now,
    };
    const store = await loadStoreForWrite(filePath);
    store.items.push(record);
    await writeStore(filePath, store);
    return record;
  });
}

async function updateSubscription({ trackerDir, id, fields }) {
  if (typeof id !== "string" || !id) throw new Error("id is required");
  const filePath = resolveSubscriptionsPath(trackerDir);
  return withStoreLock(filePath, async () => {
    const store = await loadStoreForWrite(filePath);
    const index = store.items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Subscription not found");
    const existing = store.items[index];
    // Merge over the existing record so callers may send only changed fields.
    const merged = normalizeSubscriptionFields({ ...existing, ...(fields || {}) });
    const record = {
      ...existing,
      ...merged,
      updatedAt: new Date().toISOString(),
    };
    store.items[index] = record;
    await writeStore(filePath, store);
    return record;
  });
}

async function deleteSubscription({ trackerDir, id }) {
  if (typeof id !== "string" || !id) throw new Error("id is required");
  const filePath = resolveSubscriptionsPath(trackerDir);
  return withStoreLock(filePath, async () => {
    const store = await loadStoreForWrite(filePath);
    const index = store.items.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Subscription not found");
    store.items.splice(index, 1);
    await writeStore(filePath, store);
    return { removed: true };
  });
}

module.exports = {
  listSubscriptions,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  resolveSubscriptionsPath,
};
