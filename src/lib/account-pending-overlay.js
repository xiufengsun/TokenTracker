"use strict";

// The cloud account view only knows what this device has uploaded. On the free
// tier that is one upload window per UTC day, so everything appended to the
// queue after that window is missing from the cross-device aggregate until the
// next day, and "Today" read 0 for most of the day (#1132). This module finds
// the rows this device changed since its last upload and folds the difference
// into the cloud payload:
//
//   shown = cloud + payload(rows now) - payload(same rows at upload time)
//
// Both payloads come from the local endpoint builders, so the delta is priced
// and bucketed exactly like the local view. Keys this device did not touch
// since the upload cancel out and are never read.

const fs = require("node:fs/promises");
const path = require("node:path");
const { setImmediate: yieldToRequests } = require("node:timers/promises");

const CHUNK_BYTES = 64 * 1024;
const TOKEN_FIELDS = [
  "total_tokens",
  "billable_total_tokens",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "conversation_count",
];
const COST_FIELDS = ["total_cost_usd", "priority_cost_usd", "ultrafast_cost_usd"];

// null when this device has no upload cursor (never synced, or unreadable):
// without it there is no way to tell what the cloud already holds.
async function readUploadedOffset(queuePath) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(path.dirname(queuePath), "queue.state.json"), "utf8"));
    const offset = Number(state?.offset);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
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
  // The cloud schema has no backend dimension; upload strips it, so pricing
  // the delta with it would disagree with the cloud's own rows.
  delete normalized.backend_usage;
  return { key: `${source}|${model}|${row.hour_start}`, row: normalized };
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
        if (entry) target.set(entry.key, entry.row);
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

// Keeps the latest uploaded row per key (everything before the upload offset)
// and the latest pending row per key (everything after it). Re-reading the
// prefix only happens when the offset or the file identity changes, i.e. after
// an upload; growth parses only the appended bytes.
function createPendingUploadReader({ normalizeRow = (row) => row } = {}) {
  let cache = null;

  async function load(queuePath) {
    const offset = await readUploadedOffset(queuePath);
    if (offset === null) { cache = null; return null; }
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

  // Returns { after, before } row arrays for the keys whose usage changed
  // since the upload (before = the uploaded version, absent for new keys), or
  // null when there is nothing to add.
  async function read(queuePath) {
    const state = await load(queuePath);
    if (!state || state.pending.size === 0) return null;
    if (state.changed?.version === state.version) return state.changed.value;
    const after = [];
    const before = [];
    const uploadedHourStarts = new Set();
    for (const [key, row] of state.pending) {
      const previous = state.uploaded.get(key);
      if (previous && sameRow(previous, row)) continue;
      after.push(row);
      if (previous) before.push(previous);
    }
    for (const row of state.uploaded.values()) uploadedHourStarts.add(row.hour_start);
    const value = after.length ? { after, before, uploadedHourStarts } : null;
    state.changed = { version: state.version, value };
    return value;
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

function applyBucket(target, plus, minus) {
  applyFields(target, plus, minus, TOKEN_FIELDS);
  applyFields(target, plus, minus, COST_FIELDS);
  applyModels(target, plus, minus);
}

// A zeroed copy of the delta's token/cost fields, as the base for an entry
// the cloud does not have yet.
function zeroTotals(entry) {
  const out = {};
  for (const field of TOKEN_FIELDS) if (entry?.[field] !== undefined) out[field] = 0;
  for (const field of COST_FIELDS) if (entry?.[field] !== undefined) out[field] = typeof entry[field] === "string" ? "0.000000" : 0;
  return out;
}

function mergeBuckets(cloudRows, plusRows, minusRows, keyField) {
  const out = Array.isArray(cloudRows) ? cloudRows : [];
  const index = new Map(out.map((row) => [row?.[keyField], row]));
  const plusIndex = new Map((plusRows || []).map((row) => [row[keyField], row]));
  const minusIndex = new Map((minusRows || []).map((row) => [row[keyField], row]));
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
    applyBucket(target, plusIndex.get(key), minusIndex.get(key));
  }
  if (inserted) out.sort((a, b) => String(a[keyField]).localeCompare(String(b[keyField])));
  return out;
}

function mergeSummary(cloud, plus, minus, { newlyActiveDays }) {
  if (cloud.totals) applyFields(cloud.totals, plus.totals, minus.totals, [...TOKEN_FIELDS, ...COST_FIELDS]);
  for (const [window, length] of [["last_7d", 7], ["last_30d", 30]]) {
    const target = cloud.rolling?.[window];
    if (!target) continue;
    if (!target.totals) target.totals = {};
    applyFields(target.totals, plus.rolling?.[window]?.totals, minus.rolling?.[window]?.totals, TOKEN_FIELDS);
    const added = newlyActiveDays(target.from, target.to);
    target.active_days = Math.min(length, num(target.active_days) + added);
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

function mergeHeatmap(cloud, plus, minus) {
  if (!Array.isArray(cloud.weeks)) return cloud;
  const cells = cloud.weeks.flat().filter((cell) => cell && typeof cell.day === "string");
  const byDay = new Map(cells.map((cell) => [cell.day, cell]));
  const plusCells = new Map((plus.weeks || []).flat().filter(Boolean).map((cell) => [cell.day, cell]));
  const minusCells = new Map((minus.weeks || []).flat().filter(Boolean).map((cell) => [cell.day, cell]));
  for (const day of new Set([...plusCells.keys(), ...minusCells.keys()])) {
    const target = byDay.get(day);
    if (!target) continue; // outside the cloud's grid
    const p = plusCells.get(day);
    const m = minusCells.get(day);
    if (!num(p?.total_tokens) && !num(m?.total_tokens) && !p?.models && !m?.models) continue;
    target.total_tokens = clampDelta(target.total_tokens, p?.total_tokens, m?.total_tokens);
    target.billable_total_tokens = clampDelta(target.billable_total_tokens, p?.billable_total_tokens, m?.billable_total_tokens);
    applyModels(target, p, m);
  }
  relevel(cells);
  cloud.active_days = cells.filter((cell) => num(cell.billable_total_tokens) > 0).length;
  if (cloud.total_cost_usd !== undefined) applyFields(cloud, plus, minus, ["total_cost_usd"]);
  return cloud;
}

function mergeModelBreakdown(cloud, plus, minus) {
  if (!Array.isArray(cloud.sources)) cloud.sources = [];
  const sources = new Map(cloud.sources.map((source) => [source.source, source]));
  const minusSources = new Map((minus.sources || []).map((source) => [source.source, source]));
  const names = new Set([...(plus.sources || []).map((s) => s.source), ...minusSources.keys()]);
  for (const name of names) {
    const p = (plus.sources || []).find((s) => s.source === name);
    const m = minusSources.get(name);
    let target = sources.get(name);
    if (!target) {
      if (!p) continue;
      target = { ...p, totals: zeroTotals(p.totals), models: [] };
      cloud.sources.push(target);
      sources.set(name, target);
    }
    if (!target.totals) target.totals = {};
    applyFields(target.totals, p?.totals, m?.totals, [...TOKEN_FIELDS, ...COST_FIELDS]);
    if (!Array.isArray(target.models)) target.models = [];
    const models = new Map(target.models.map((model) => [model.model, model]));
    const plusModels = new Map((p?.models || []).map((model) => [model.model, model]));
    const minusModels = new Map((m?.models || []).map((model) => [model.model, model]));
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
      applyFields(model.totals, pm?.totals, minusModels.get(modelName)?.totals, [...TOKEN_FIELDS, ...COST_FIELDS]);
    }
    target.models.sort((a, b) => num(b.totals?.total_tokens) - num(a.totals?.total_tokens));
  }
  return cloud;
}

// `plus`/`minus` are local payloads for the changed rows now / at upload time.
// Returns a new payload; `cloud` (possibly a shared cache entry) is untouched.
function mergeAccountPayload(usageSlug, cloud, plus, minus, options = {}) {
  if (!cloud || typeof cloud !== "object" || !plus) return cloud;
  const out = structuredClone(cloud);
  minus = minus || {};
  switch (usageSlug) {
    case "tokentracker-usage-summary":
      return mergeSummary(out, plus, minus, { newlyActiveDays: options.newlyActiveDays || (() => 0) });
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

module.exports = { createPendingUploadReader, mergeAccountPayload, readUploadedOffset };
