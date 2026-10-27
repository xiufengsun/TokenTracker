"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { openLock, writeFileAtomic } = require("./fs");
const { isAccountLevelSource } = require("./source-metadata");

const SCHEMA = "tokentracker.local-usage.v1";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_DEVICES = 32;
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens",
  "unclassified_input_tokens", "reasoning_output_tokens", "total_tokens", "billable_total_tokens", "conversation_count",
  ...["long_context_", "priority_", "priority_long_context_", "ultrafast_", "ultrafast_long_context_"].flatMap((prefix) =>
    ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "reasoning_output_tokens"].map((field) => prefix + field))];
const ROW_FIELDS = new Set(["source", "model", "hour_start", "total_cost_usd", ...TOKEN_FIELDS]);
const validId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(id);
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }
function count(rows, field = "total_tokens") {
  const result = rows.reduce((sum, row) => sum + (row[field] ?? row.total_tokens), 0);
  if (!Number.isSafeInteger(result)) fail("invalid_snapshot");
  return result;
}
function displayCount(rows) {
  const total = count(rows);
  return count(rows, "billable_total_tokens") || total;
}

function cleanRow(row, strict = false) {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !Number.isSafeInteger(row.total_tokens) || row.total_tokens < 0 ||
      typeof row.source !== "string" || !/^[a-z0-9_-]{1,80}$/.test(row.source) ||
      typeof row.model !== "string" || !row.model.trim() || row.model.length > 200 || /[\x00-\x1f]/.test(row.model) ||
      !validTime(row.hour_start) || Date.parse(row.hour_start) % 1_800_000 !== 0 ||
      (strict && Object.keys(row).some((key) => !ROW_FIELDS.has(key)))) fail("invalid_snapshot");
  const result = { source: row.source, model: row.model, hour_start: row.hour_start };
  for (const field of TOKEN_FIELDS) {
    const value = row[field] ?? (field === "billable_total_tokens" ? row.total_tokens : 0);
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_snapshot");
    if (value || Object.hasOwn(row, field) || field === "total_tokens" || field === "billable_total_tokens") result[field] = value;
  }
  if (Object.hasOwn(row, "total_cost_usd")) {
    if (row.total_cost_usd === null) {
      if (!(result.unclassified_input_tokens > 0)) fail("invalid_snapshot");
      result.total_cost_usd = null;
    } else if (!Number.isFinite(row.total_cost_usd) || row.total_cost_usd < 0) fail("invalid_snapshot");
    else result.total_cost_usd = row.total_cost_usd;
  }
  return result;
}

function validateSnapshot(value) {
  if (!value || value.schema !== SCHEMA || value.scope !== "device-history" ||
      Object.keys(value).some((key) => !["schema", "scope", "machine", "sequence", "exported_at", "rows"].includes(key)) ||
      !validId(value.machine?.id) || typeof value.machine.name !== "string" || value.machine.name.length > 128 ||
      /[\x00-\x1f]/.test(value.machine.name) || typeof value.machine.platform !== "string" || value.machine.platform.length > 30 ||
      Object.keys(value.machine).some((key) => !["id", "name", "platform"].includes(key)) ||
      !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !validTime(value.exported_at) ||
      !Array.isArray(value.rows) || value.rows.length > 100_000 || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail("invalid_snapshot");
  const rows = value.rows.map((row) => cleanRow(row, true));
  const keys = new Set();
  for (const row of rows) {
    const key = JSON.stringify([row.source, row.model, row.hour_start]);
    if (isAccountLevelSource(row.source) || keys.has(key)) fail("invalid_snapshot");
    keys.add(key);
  }
  count(rows);
  // cleanRow may insert billable_total_tokens and drop omitted zeros, so the
  // serialized size after normalization can exceed the pre-clean check above.
  // Reject before commit: an accepted oversize snapshot would make later
  // validateSnapshot reads fail and hide the import from Settings removal.
  const normalized = { ...value, machine: { ...value.machine }, rows };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_BYTES) fail("invalid_snapshot");
  return normalized;
}

// Imported snapshots never enter the append-only queue or its cloud upload offset.
// Keep rows separate until aggregation so pricing annotations and device identity
// survive (e.g. reported costs and long-context/priority subsets).
function createLocalUsageTransfer({ queuePath, normalizeRow, identity }) {
  const directory = path.dirname(queuePath);
  const statePath = path.join(directory, "local-usage.json");
  let cachedRaw;
  let cachedState;
  let cachedView;
  const importedCache = new WeakMap();
  async function state() {
    try {
      const chunks = [];
      let size = 0;
      // Open once and bound the actual read, including a possible growth or
      // replacement since another process last observed the ledger's size.
      for await (const chunk of createReadStream(statePath, { end: MAX_STATE_BYTES })) {
        size += chunk.length;
        if (size > MAX_STATE_BYTES) fail("invalid_state", 503);
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks, size).toString("utf8");
      if (raw === cachedRaw) return cachedState;
      const value = JSON.parse(raw);
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
          !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !value.imports ||
          typeof value.imports !== "object" || Array.isArray(value.imports) || Object.keys(value.imports).length > MAX_DEVICES) fail("invalid_state", 503);
      cachedRaw = raw;
      cachedState = value;
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, revision: 0, sequence: 0, imports: {} };
      fail("invalid_state", 503);
    }
  }
  async function ownRows() {
    let raw;
    try { raw = await fs.readFile(queuePath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const rows = new Map();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { fail("invalid_queue", 409); }
      if (!row || typeof row !== "object") fail("invalid_queue", 409);
      if (Object.hasOwn(row, "_ttsync")) fail("legacy_imports", 409);
      if (row.kind) continue;
      const normalized = normalizeRow(row);
      if (!Number.isFinite(Date.parse(normalized.hour_start))) fail("invalid_queue", 409);
      // A field allowlist is essential: never export arbitrary parser metadata.
      const clean = cleanRow({ ...normalized, hour_start: new Date(normalized.hour_start).toISOString() });
      rows.set(JSON.stringify([clean.source, clean.model, clean.hour_start]), clean);
    }
    return [...rows.values()];
  }
  async function locked(action) {
    await fs.mkdir(directory, { recursive: true });
    const locks = [];
    try {
      for (const name of ["local-usage.lock", "sync.lock"]) {
        const lock = await openLock(path.join(directory, name), { quietIfLocked: true });
        if (!lock) fail("transfer_busy", 409);
        locks.push(lock);
      }
      return await action();
    } finally { for (const lock of locks.reverse()) await lock.release(); }
  }
  async function write(value) {
    value.revision++;
    if (!Number.isSafeInteger(value.revision)) fail("invalid_state", 503);
    const contents = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(contents) > MAX_STATE_BYTES) fail("too_many_devices");
    await writeFileAtomic(statePath, contents, { mode: 0o600 });
    cachedRaw = undefined;
    cachedState = undefined;
  }
  function self() {
    const machine = identity();
    if (!validId(machine?.id)) fail("identity_unavailable", 503);
    return { id: machine.id, name: String(machine.name || machine.id).slice(0, 128), platform: String(machine.platform || "").slice(0, 30) };
  }
  function imported(value) {
    if (importedCache.has(value)) return importedCache.get(value);
    const entries = Object.entries(value.imports).map(([id, entry]) => {
      const snapshot = validateSnapshot(entry.snapshot);
      if (snapshot.machine.id !== id || !validTime(entry.imported_at)) fail("invalid_state", 503);
      return { ...entry, snapshot };
    });
    importedCache.set(value, entries);
    return entries;
  }
  function inspect(snapshot, value, rows) {
    if (snapshot.machine.id === self().id) fail("self_import");
    const previous = Object.hasOwn(value.imports, snapshot.machine.id) ? value.imports[snapshot.machine.id].snapshot : null;
    const same = previous && snapshot.sequence === previous.sequence;
    if (same && digest(snapshot) !== digest(previous)) fail("snapshot_conflict", 409);
    const action = !previous ? "added" : same ? "unchanged" : snapshot.sequence < previous.sequence ? "outdated" : "updated";
    const entries = imported(value);
    const own = rows.filter((row) => !isAccountLevelSource(row.source));
    const before = displayCount([...own, ...entries.flatMap((entry) => entry.snapshot.rows)]);
    const after = ["added", "updated"].includes(action) ? displayCount([...own, ...snapshot.rows,
      ...entries.filter((entry) => entry.snapshot.machine.id !== snapshot.machine.id).flatMap((entry) => entry.snapshot.rows)]) : before;
    return { action, before, after, machine: snapshot.machine, exported_at: snapshot.exported_at,
      token: digest([snapshot, value.revision, rows]) };
  }
  return {
    async exportSnapshot() {
      return locked(async () => {
        const value = structuredClone(await state());
        const rows = (await ownRows()).filter((row) => !isAccountLevelSource(row.source));
        const snapshot = validateSnapshot({ schema: SCHEMA, scope: "device-history", machine: self(),
          sequence: value.sequence + 1, exported_at: new Date().toISOString(), rows });
        value.sequence++;
        await write(value);
        return snapshot;
      });
    },
    async preview(input) {
      const snapshot = validateSnapshot(input);
      return locked(async () => inspect(snapshot, await state(), await ownRows()));
    },
    async importSnapshot(input, token) {
      const snapshot = validateSnapshot(input);
      return locked(async () => {
        const value = structuredClone(await state());
        const preview = inspect(snapshot, value, await ownRows());
        if (preview.token !== token) fail("preview_changed", 409);
        if (["added", "updated"].includes(preview.action)) {
          if (preview.action === "added" && Object.keys(value.imports).length >= MAX_DEVICES) fail("too_many_devices");
          value.imports = { ...value.imports, [snapshot.machine.id]: { snapshot, imported_at: new Date().toISOString() } };
          await write(value);
        }
        return preview;
      });
    },
    async remove(id) {
      if (!validId(id)) fail("unknown_device", 404);
      return locked(async () => {
        const value = structuredClone(await state());
        if (!Object.hasOwn(value.imports, id)) fail("unknown_device", 404);
        delete value.imports[id];
        await write(value);
      });
    },
    async hasImports() { return imported(await state()).length > 0; },
    async view(rows, device = "") {
      const value = await state();
      if (!device) {
        const entries = imported(value);
        if (!entries.length) return rows;
        if (cachedView?.own === rows && cachedView.state === value) return cachedView.rows;
        const combined = [...rows, ...entries.flatMap((entry) => entry.snapshot.rows)];
        cachedView = { own: rows, state: value, rows: combined };
        return combined;
      }
      if (device === `local:${self().id}`) return rows.filter((row) => !isAccountLevelSource(row.source));
      const entry = imported(value).find((item) => device === `local:${item.snapshot.machine.id}`);
      if (!entry) fail("unknown_device", 404);
      return entry.snapshot.rows;
    },
    async devices(rows, inRange) {
      const value = await state();
      const machine = self();
      const entries = imported(value);
      const rangeTotals = (rows) => {
        const selected = rows.filter(inRange);
        return { total_tokens: count(selected), billable_total_tokens: count(selected, "billable_total_tokens") };
      };
      const devices = [{ id: `local:${machine.id}`, machine_id: machine.id, device_name: machine.name,
        platform: machine.platform, isCurrent: true,
        ...rangeTotals(rows.filter((row) => !isAccountLevelSource(row.source))) },
      ...entries.map(({ snapshot, imported_at }) => ({ id: `local:${snapshot.machine.id}`, machine_id: snapshot.machine.id,
        device_name: snapshot.machine.name, platform: snapshot.machine.platform,
        ...rangeTotals(snapshot.rows), imported_at, exported_at: snapshot.exported_at }))];
      const accounts = new Map();
      for (const row of rows.filter((row) => isAccountLevelSource(row.source) && inRange(row))) {
        const totals = accounts.get(row.source) || { total_tokens: 0, billable_total_tokens: 0 };
        totals.total_tokens += row.total_tokens;
        totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens;
        accounts.set(row.source, totals);
      }
      const names = devices.map((device) => device.device_name);
      for (const device of devices) {
        if (names.filter((name) => name === device.device_name).length > 1) {
          device.device_name += ` · ${device.machine_id.slice(-8)}`;
        }
      }
      return { revision: value.revision, current_device_id: `local:${machine.id}`, devices,
        account_sources: [...accounts].map(([source, totals]) => ({ source, ...totals })) };
    },
  };
}

module.exports = { createLocalUsageTransfer, MAX_BYTES };
