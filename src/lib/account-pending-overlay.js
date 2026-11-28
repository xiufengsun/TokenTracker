"use strict";

// The cloud account view only knows what this device has uploaded. On the free
// tier that is one upload window per UTC day, so everything appended to the
// queue after that window is missing from the cross-device aggregate until the
// next day, and "Today" read 0 for most of the day (#1132). This module finds
// the rows this device changed since its last upload and folds the difference
// into the cloud payload:
//
//   shown = cloud + local(rows now) - local(same rows at upload time)
//
// Both local payloads come from the local endpoint builders, run over the
// cloud response's own range, grid and day boundaries. Keys this device did
// not touch since the upload cancel out and are never read.
//
// The overlay is only added when the cloud's contents are known (see
// drainQueueToCloud in sync.js): the upload cursor must sit on the baseline a
// full drain established, and no upload may be in flight. Otherwise the cloud
// aggregate is served as it is: behind, but never double-counted.

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setImmediate: yieldToRequests } = require("node:timers/promises");
const { isAccountLevelSource } = require("./source-metadata");

const CHUNK_BYTES = 64 * 1024;
// drainQueueToCloud spends at most 90 s per run; a marker older than this was
// left by a sync that died mid-request (no upload is running, but the baseline
// stays unknown until the next drain).
const UPLOAD_IN_FLIGHT_STALE_MS = 5 * 60_000;
const SPEED_TIER_FIELDS = ["priority_", "ultrafast_"].flatMap((prefix) =>
  ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens"]
    .map((field) => `${prefix}${field}`));
const TOKEN_FIELDS = [
  "total_tokens",
  "billable_total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "conversation_count",
  ...SPEED_TIER_FIELDS,
];
const COST_FIELDS = ["total_cost_usd", "priority_cost_usd", "ultrafast_cost_usd"];
const ALL_FIELDS = [...TOKEN_FIELDS, ...COST_FIELDS];

// null when this device has no readable upload cursor: without it there is no
// way to tell what the cloud already holds. `key` changes with every cursor,
// baseline or in-flight transition, so a caller can tell whether an upload
// moved while it was reading the cloud.
function describeUploadState(text) {
  let state;
  try { state = JSON.parse(text); } catch { return null; }
  const offset = Number(state?.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  const uploadingMs = Date.parse(state.uploadingSince);
  return {
    offset,
    // A request in flight (or one a dead sync left behind) may have stored
    // rows past the cursor.
    baselineKnown: Number(state.cloudBaselineOffset) === offset && !state.uploadingSince,
    uploading: Number.isFinite(uploadingMs) && Date.now() - uploadingMs < UPLOAD_IN_FLIGHT_STALE_MS,
    key: JSON.stringify([offset, state.updatedAt ?? null, state.cloudBaselineOffset ?? null, state.uploadingSince ?? null]),
  };
}

function uploadStatePath(queuePath) {
  return path.join(path.dirname(queuePath), "queue.state.json");
}

async function readUploadState(queuePath) {
  try { return describeUploadState(await fs.readFile(uploadStatePath(queuePath), "utf8")); } catch { return null; }
}

// Synchronous so a caller can snapshot the cursor without yielding.
function readUploadStateSync(queuePath) {
  try { return describeUploadState(fsSync.readFileSync(uploadStatePath(queuePath), "utf8")); } catch { return null; }
}

// Mirrors the identity and row shape readQueueBatch (sync.js) uploads, so the
// "at upload time" side matches what the cloud actually stored.
function parseUploadRow(line, normalizeRow) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (!row || typeof row !== "object" || row.kind) return null;
  if (typeof row.hour_start !== "string" || !row.hour_start) return null;
  const source = (typeof row.source === "string" ? row.source.trim().toLowerCase() : "") || "codex";
  const model = (typeof row.model === "string" ? row.model.trim() : "") || "unknown";
  const normalized = { ...normalizeRow({ ...row, source, model }) };
  // The cloud schema has no backend dimension; upload strips it.
  delete normalized.backend_usage;
  // The account edges ignore a bare provider-reported total (Grok, Cline) and
  // read reported cost only from cost_coverage, which stays on the row; price
  // the delta the same way.
  delete normalized.total_cost_usd;
  return {
    key: `${source}|${model}|${row.hour_start}`,
    row: normalized,
    // Account-level sources (Cursor, TRAE CN) are the same account seen from
    // every device; the cloud keeps one canonical row per key (and reads TRAE
    // CN from session states), so adding this device's copy would double it.
    accountLevel: isAccountLevelSource(source),
  };
}

// Parses complete lines in [start, end). Returns the offset just past the last
// complete line; a tail a writer is still producing is left for the next read.
async function readLines(file, start, end, target, normalizeRow) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = start;
  let consumed = start;
  let carry = Buffer.alloc(0);
  while (position < end) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK_BYTES, end - position), position);
    if (!bytesRead) break;
    position += bytesRead;
    const chunk = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
    let lineStart = 0;
    let newline;
    while ((newline = chunk.indexOf(0x0a, lineStart)) !== -1) {
      const line = chunk.toString("utf8", lineStart, newline);
      if (line.trim()) {
        const entry = parseUploadRow(line, normalizeRow);
        if (entry) target.set(entry.key, entry);
      }
      lineStart = newline + 1;
    }
    consumed = position - (chunk.length - lineStart);
    carry = chunk.subarray(lineStart);
    await yieldToRequests();
  }
  return consumed;
}

function sameRow(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Keeps the latest uploaded entry per key (everything before the upload
// offset) and the latest pending entry per key (everything after it).
// Re-reading the prefix only happens when the offset or the file identity
// changes, i.e. after an upload; growth parses only the appended bytes.
function createPendingUploadReader({ normalizeRow = (row) => row } = {}) {
  let cache = null;
  // Reads share one cache; an older read must not overwrite the pending rows
  // a newer one already parsed, so they run one at a time.
  let tail = Promise.resolve();

  async function load(queuePath, offset) {
    let file;
    try {
      file = await fs.open(queuePath, "r");
    } catch (error) {
      if (error?.code === "ENOENT") { cache = null; return null; }
      throw error;
    }
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}`;
      const size = stat.size;
      if (offset > size) { cache = null; return null; }
      const reusable = cache && cache.queuePath === queuePath && cache.identity === identity &&
        cache.offset === offset && size >= cache.consumed;
      if (!reusable) {
        const uploaded = new Map();
        const prefixEnd = await readLines(file, 0, offset, uploaded, normalizeRow);
        // The uploader only advances past complete lines, so a mid-line offset
        // means the queue was rewritten under it: skip until it settles.
        if (prefixEnd !== offset) { cache = null; return null; }
        cache = { queuePath, identity, offset, consumed: offset, uploaded, pending: new Map(), version: 0 };
      }
      if (size > cache.consumed) {
        cache.consumed = await readLines(file, cache.consumed, size, cache.pending, normalizeRow);
        cache.version += 1;
      }
      return cache;
    } finally {
      await file.close();
    }
  }

  // `key`, `baselineKnown` and `uploading` describe the upload cursor (see
  // describeUploadState).
  // `delta` holds { after, before, uploadedHourStarts } for the keys whose
  // usage changed since the upload (before = the uploaded version, absent for
  // new keys), or null when there is nothing that may be added.
  async function readNow(queuePath) {
    const uploadState = await readUploadState(queuePath);
    if (!uploadState) { cache = null; return { key: "", baselineKnown: false, uploading: false, delta: null }; }
    const { key, baselineKnown, uploading } = uploadState;
    const result = { key, baselineKnown, uploading, delta: null };
    if (!uploadState.baselineKnown || uploadState.uploading) return result;
    const state = await load(queuePath, uploadState.offset);
    if (!state || state.pending.size === 0) return result;
    if (state.changed?.version !== state.version) {
      const after = [];
      const before = [];
      for (const [key, entry] of state.pending) {
        if (entry.accountLevel) continue;
        const previous = state.uploaded.get(key);
        if (previous && sameRow(previous.row, entry.row)) continue;
        after.push(entry.row);
        if (previous) before.push(previous.row);
      }
      const uploadedHourStarts = new Set();
      for (const entry of state.uploaded.values()) uploadedHourStarts.add(entry.row.hour_start);
      state.changed = { version: state.version, value: after.length ? { after, before, uploadedHourStarts } : null };
    }
    result.delta = state.changed.value;
    return result;
  }

  function read(queuePath) {
    const run = tail.then(() => readNow(queuePath));
    tail = run.catch(() => {});
    return run;
  }

  return { read };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampDelta(base, plus, minus) {
  return Math.max(0, num(base) + num(plus) - num(minus));
}

// Adds plus - minus to every token/cost field the target exposes (or that the
// delta introduces), keeping each field's wire type: costs travel as fixed(6)
// strings in some payloads and numbers in others.
function applyFields(target, plus, minus, fields) {
  for (const field of fields) {
    const has = (o) => o != null && o[field] !== undefined && o[field] !== null;
    if (!has(target) && !has(plus) && !has(minus)) continue;
    const template = has(target) ? target[field] : has(plus) ? plus[field] : minus[field];
    const next = clampDelta(target[field], plus?.[field], minus?.[field]);
    target[field] = typeof template === "string" ? next.toFixed(6) : next;
  }
}

function applyModels(target, plus, minus) {
  const plusModels = plus?.models;
  const minusModels = minus?.models;
  if (!plusModels && !minusModels) return;
  if (!target.models || typeof target.models !== "object") target.models = {};
  for (const name of new Set([...Object.keys(plusModels || {}), ...Object.keys(minusModels || {})])) {
    target.models[name] = clampDelta(target.models[name], plusModels?.[name], minusModels?.[name]);
  }
}

// A zeroed copy of the delta's token/cost fields, as the base for an entry
// the cloud does not have yet.
function zeroTotals(entry) {
  const out = {};
  for (const field of TOKEN_FIELDS) if (entry?.[field] !== undefined) out[field] = 0;
  for (const field of COST_FIELDS) if (entry?.[field] !== undefined) out[field] = typeof entry[field] === "string" ? "0.000000" : 0;
  return out;
}

function indexBy(rows, keyField) {
  return new Map((Array.isArray(rows) ? rows : []).filter(Boolean).map((row) => [row[keyField], row]));
}

function mergeBuckets(cloudRows, plusRows, minusRows, keyField) {
  const out = Array.isArray(cloudRows) ? cloudRows : [];
  const index = indexBy(out, keyField);
  const plusIndex = indexBy(plusRows, keyField);
  const minusIndex = indexBy(minusRows, keyField);
  let inserted = false;
  for (const key of new Set([...plusIndex.keys(), ...minusIndex.keys()])) {
    let target = index.get(key);
    if (!target) {
      const plus = plusIndex.get(key);
      if (!plus) continue; // the cloud never had it, so there is nothing to subtract from
      target = { [keyField]: key, ...zeroTotals(plus) };
      out.push(target);
      index.set(key, target);
      inserted = true;
    }
    applyFields(target, plusIndex.get(key), minusIndex.get(key), ALL_FIELDS);
    applyModels(target, plusIndex.get(key), minusIndex.get(key));
  }
  if (inserted) out.sort((a, b) => String(a[keyField]).localeCompare(String(b[keyField])));
  return out;
}

// Sums daily rows whose day falls in [from, to].
function sumDays(rows, from, to) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.day < from || row.day > to) continue;
    for (const field of ALL_FIELDS) if (row[field] !== undefined) out[field] = num(out[field]) + num(row[field]);
  }
  return out;
}

function daySpan(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 86_400_000) + 1 : 0;
}

// `plus`/`minus` are daily payloads covering the summary's range and both
// rolling windows, so every figure is summed over the cloud's own bounds.
function mergeSummary(cloud, plus, minus, newlyActiveDays) {
  if (cloud.totals && cloud.from && cloud.to) {
    applyFields(cloud.totals, sumDays(plus.data, cloud.from, cloud.to), sumDays(minus.data, cloud.from, cloud.to), ALL_FIELDS);
    if (cloud.days !== undefined) {
      cloud.days = Math.min(daySpan(cloud.from, cloud.to), num(cloud.days) + newlyActiveDays(cloud.from, cloud.to));
    }
  }
  for (const window of ["last_7d", "last_30d"]) {
    const target = cloud.rolling?.[window];
    if (!target?.from || !target?.to) continue;
    if (!target.totals) target.totals = {};
    applyFields(target.totals, sumDays(plus.data, target.from, target.to), sumDays(minus.data, target.from, target.to),
      ["billable_total_tokens", "conversation_count"]);
    target.active_days = Math.min(daySpan(target.from, target.to), num(target.active_days) + newlyActiveDays(target.from, target.to));
    if ("avg_per_active_day" in target) {
      target.avg_per_active_day = target.active_days > 0
        ? Math.round(num(target.totals.billable_total_tokens) / target.active_days)
        : 0;
    }
  }
  return cloud;
}

// Same level formula as the cloud heatmap edge and the local builder.
function relevel(cells) {
  const values = cells.map((cell) => num(cell.billable_total_tokens)).filter((value) => value > 0);
  const max = values.length ? Math.max(...values) : 0;
  for (const cell of cells) {
    const value = num(cell.billable_total_tokens);
    if (value <= 0) cell.level = 0;
    else if (max === 0) cell.level = 1;
    else {
      const ratio = value / max;
      cell.level = ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
    }
  }
}

// `plus`/`minus` are daily payloads covering the cloud grid's days.
function mergeHeatmap(cloud, plus, minus) {
  if (!Array.isArray(cloud.weeks)) return cloud;
  const cells = cloud.weeks.flat().filter((cell) => cell && typeof cell.day === "string");
  const byDay = indexBy(cells, "day");
  const plusDays = indexBy(plus.data, "day");
  const minusDays = indexBy(minus.data, "day");
  const touched = [];
  for (const day of new Set([...plusDays.keys(), ...minusDays.keys()])) {
    const target = byDay.get(day);
    if (!target) continue; // outside the cloud's grid
    applyFields(target, plusDays.get(day), minusDays.get(day), ["total_tokens", "billable_total_tokens"]);
    applyModels(target, plusDays.get(day), minusDays.get(day));
    touched.push(day);
  }
  relevel(cells);
  cloud.active_days = cells.filter((cell) => num(cell.billable_total_tokens) > 0).length;
  if (cloud.total_cost_usd !== undefined && touched.length) {
    const first = touched.reduce((a, b) => (a < b ? a : b));
    const last = touched.reduce((a, b) => (a > b ? a : b));
    applyFields(cloud, sumDays(plus.data, first, last), sumDays(minus.data, first, last), ["total_cost_usd"]);
  }
  return cloud;
}

function mergeModelBreakdown(cloud, plus, minus) {
  if (!Array.isArray(cloud.sources)) cloud.sources = [];
  const sources = indexBy(cloud.sources, "source");
  const plusSources = indexBy(plus.sources, "source");
  const minusSources = indexBy(minus.sources, "source");
  for (const name of new Set([...plusSources.keys(), ...minusSources.keys()])) {
    const p = plusSources.get(name);
    const m = minusSources.get(name);
    let target = sources.get(name);
    if (!target) {
      if (!p) continue;
      target = { ...p, totals: zeroTotals(p.totals), models: [] };
      cloud.sources.push(target);
      sources.set(name, target);
    }
    if (!target.totals) target.totals = {};
    applyFields(target.totals, p?.totals, m?.totals, ALL_FIELDS);
    if (!Array.isArray(target.models)) target.models = [];
    const models = indexBy(target.models, "model");
    const plusModels = indexBy(p?.models, "model");
    const minusModels = indexBy(m?.models, "model");
    for (const modelName of new Set([...plusModels.keys(), ...minusModels.keys()])) {
      let model = models.get(modelName);
      const pm = plusModels.get(modelName);
      if (!model) {
        if (!pm) continue;
        model = { ...pm, totals: zeroTotals(pm.totals) };
        target.models.push(model);
        models.set(modelName, model);
      }
      if (!model.totals) model.totals = {};
      applyFields(model.totals, pm?.totals, minusModels.get(modelName)?.totals, ALL_FIELDS);
    }
    target.models.sort((a, b) => num(b.totals?.total_tokens) - num(a.totals?.total_tokens));
  }
  return cloud;
}

// `plus`/`minus` are local payloads for the changed rows now / at upload time:
// daily payloads for the summary and the heatmap, the endpoint's own shape
// otherwise. Returns a new payload; `cloud` (possibly a shared cache entry) is
// untouched.
function mergeAccountPayload(usageSlug, cloud, plus, minus, options = {}) {
  if (!cloud || typeof cloud !== "object" || !plus) return cloud;
  const out = structuredClone(cloud);
  minus = minus || {};
  switch (usageSlug) {
    case "tokentracker-usage-summary":
      return mergeSummary(out, plus, minus, options.newlyActiveDays || (() => 0));
    case "tokentracker-usage-daily":
      out.data = mergeBuckets(out.data, plus.data, minus.data, "day");
      return out;
    case "tokentracker-usage-hourly":
      out.data = mergeBuckets(out.data, plus.data, minus.data, "hour");
      return out;
    case "tokentracker-usage-monthly":
      out.data = mergeBuckets(out.data, plus.data, minus.data, "month");
      return out;
    case "tokentracker-usage-heatmap":
      return mergeHeatmap(out, plus, minus);
    case "tokentracker-usage-model-breakdown":
      return mergeModelBreakdown(out, plus, minus);
    default:
      return cloud;
  }
}

module.exports = { createPendingUploadReader, mergeAccountPayload, readUploadStateSync };
