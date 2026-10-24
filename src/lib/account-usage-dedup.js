"use strict";

/**
 * Account-level cross-device truth - JS reference implementation.
 *
 * Account-level sources (ACCOUNT_LEVEL_SOURCES in src/lib/source-metadata.js)
 * come from a per-ACCOUNT cloud API, so every device that syncs them stores
 * its own copy of the SAME account data. How to dedup depends on the source:
 *
 *   - 'cursor' has NO stable session identity: its rows are identical across
 *     devices, so the legacy whole-row MAX pick per (hour, source, model)
 *     dedups them (dedupeAccountLevelRows below).
 *   - 'trae-cn' is a CORRECTABLE snapshot: totals can be revised down, a
 *     session can move to another model or another half-hour. Hour-level
 *     dedup CANNOT express that (a fresh device's first data bucket cannot
 *     safely displace earlier hours - that would need an unproven "absent =
 *     deleted" contract - and a 10:00 -> 10:30 bucket migration strands the
 *     old hour). Canonical truth for trae-cn therefore lives at the SESSION
 *     level (tokentracker_account_session_states; migrations/
 *     20260817120000_account-session-states.sql): identity is
 *     (user_id, source, session_id) - device_id is NOT identity (the usage
 *     API request carries no device discriminator). Session-id evidence
 *     (2026-08-17): repeated-fetch stability VERIFIED, cross-window
 *     stability VERIFIED; cross-device same-account stability NOT DIRECTLY
 *     VERIFIED (no second independent device/auth experiment). Every
 *     observation of one
 *     session whole-row-replaces the previous state under a strict LWW
 *     guard, so the three correction classes collapse into ONE operation:
 *
 *     downward  S tokens 100 -> 60        replaced, total 60
 *     model     S model A -> B            replaced, only B remains
 *     bucket    S bucket 10:00 -> 10:30   replaced, only 10:30 remains
 *
 * ABSENCE is NOT PROVEN to mean deletion, so nothing ever deletes a session
 * row: a session missing from a non-empty snapshot asserts nothing, and an
 * empty snapshot asserts nothing at all.
 *
 * Freshness: the TRAE API exposes no provider-side ordering signal (probed
 * 2026-08-17: headers carry only CDN trace ids, rows carry no revision), so
 * snapshot_verified_at is the CLIENT logical fetch stamp (best-effort
 * cross-device ordering under clock skew - documented residual risk, NOT
 * strict correctness). It is stamped once per real fetch and replayed
 * verbatim by the append-only queue; the LWW guard applies strictly newer
 * (>) stamps only, so retries are idempotent and a re-delivered older
 * observation cannot displace a newer one. Equal stamps keep the
 * first-applied row (stable under retries).
 *
 * This module is the executable specification of that semantics; the
 * deployed SQL (migrations/20260817120000_account-session-states.sql upsert,
 * scripts/ops/account-usage-grouped-rpc.sql + leaderboard_hourly_dedup_v2
 * aggregation branches) implements the same algorithm and MUST stay in sync
 * - test/account-usage-dedup.test.js pins both.
 */

// Queue record kind the TRAE CN parser emits for one changed session's
// canonical observation (src/lib/rollout.js appendTraeCnSessionStates).
const SESSION_STATE_KIND = "account_session_state";

function parseMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Token columns that make up a canonical session state row (the SQL table's
// non-key, non-metadata columns).
const TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function normalizeStateRow(observation) {
  const source = String(observation?.source ?? "").trim().toLowerCase();
  const sessionId = String(observation?.session_id ?? "").trim();
  if (!source || !sessionId) return null;
  const verifiedMs = parseMs(observation?.snapshot_verified_at);
  if (verifiedMs === null) return null;
  const bucketStart = String(observation?.bucket_start ?? "");
  if (parseMs(bucketStart) === null) return null;
  const model = String(observation?.model ?? "");
  if (!model) return null;
  const row = {
    source,
    session_id: sessionId,
    model,
    bucket_start: bucketStart,
    snapshot_verified_at: observation.snapshot_verified_at,
  };
  for (const column of TOKEN_COLUMNS) {
    const value = Number(observation?.[column]);
    row[column] = Number.isFinite(value) ? value : 0;
  }
  if (Number(observation?.unclassified_input_tokens) > 0) {
    row.unclassified_input_tokens = Number(observation.unclassified_input_tokens);
  }
  return row;
}

/**
 * Whole-row LWW replace of canonical session states - mirrors
 * tokentracker_upsert_account_session_states() (migrations/
 * 20260817120000_account-session-states.sql): a row applies only when its
 * snapshot_verified_at is STRICTLY newer (>) than the stored one. Replays of
 * the same observation are no-ops; equal stamps keep the first-applied row.
 *
 * @param {Map<string, object>} states - canonical table keyed by
 *   `${source}|${session_id}` (mirrors the (user_id, source, session_id) PK
 *   for one account; mutated in place).
 * @param {Array<object>} observations - ingest batch (already deduped to one
 *   row per session by the edge, like the SQL batch upsert requires).
 * @returns {number} applied row count (mirrors the SQL ROW_COUNT return).
 */
function upsertAccountSessionStates(states, observations) {
  const table = states instanceof Map ? states : new Map();
  const batch = Array.isArray(observations) ? observations : [];
  let applied = 0;
  for (const observation of batch) {
    const row = normalizeStateRow(observation);
    if (!row) continue;
    const key = `${row.source}|${row.session_id}`;
    const stored = table.get(key);
    if (!stored) {
      table.set(key, row);
      applied += 1;
      continue;
    }
    const storedMs = parseMs(stored.snapshot_verified_at) ?? -Infinity;
    const rowMs = parseMs(row.snapshot_verified_at) ?? -Infinity;
    if (rowMs > storedMs) {
      table.set(key, row);
      applied += 1;
    }
  }
  return applied;
}

/**
 * Aggregate canonical session states into hourly rows - mirrors the trae-cn
 * branch of account_usage_grouped (scripts/ops/account-usage-grouped-rpc.sql)
 * and leaderboard_hourly_dedup_v2: SUM per (bucket_start, source, model),
 * conversations = session count.
 *
 * @param {Map<string, object>|Array<object>} states
 * @param {{from?: string, to?: string}} [opts] - optional [from, to) window.
 * @returns {Array<object>} rows shaped like tokentracker_hourly aggregates.
 */
function aggregateSessionStates(states, opts = {}) {
  const values = states instanceof Map ? [...states.values()] : Array.isArray(states) ? states : [];
  const fromMs = parseMs(opts.from ?? "");
  const toMs = parseMs(opts.to ?? "");
  const grouped = new Map();
  for (const state of values) {
    const row = normalizeStateRow(state);
    if (!row) continue;
    const bucketMs = parseMs(row.bucket_start);
    if (bucketMs === null) continue;
    if (fromMs !== null && bucketMs < fromMs) continue;
    if (toMs !== null && bucketMs >= toMs) continue;
    const key = `${row.bucket_start}||${row.source}||${row.model}`;
    const acc = grouped.get(key) || {
      hour_start: row.bucket_start,
      source: row.source,
      model: row.model,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
      conversations: 0,
    };
    for (const column of TOKEN_COLUMNS) acc[column] += row[column];
    if (row.unclassified_input_tokens) {
      acc.unclassified_input_tokens = (acc.unclassified_input_tokens || 0) + row.unclassified_input_tokens;
    }
    acc.conversations += 1;
    grouped.set(key, acc);
  }
  return [...grouped.values()].sort(
    (a, b) =>
      String(a.hour_start).localeCompare(String(b.hour_start)) ||
      String(a.source).localeCompare(String(b.source)) ||
      String(a.model).localeCompare(String(b.model)),
  );
}

// Mirrors the legacy SQL DISTINCT ON (hour, source, model)
// ORDER BY total_tokens DESC, updated_at DESC (device_id asc as the final
// deterministic tiebreak). Used ONLY for account-level sources without a
// stable session identity ('cursor') and watermark-less history.
function pickLegacyRow(rows) {
  let best = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const rowTotal = Number(row.total_tokens) || 0;
    const bestTotal = Number(best.total_tokens) || 0;
    if (rowTotal !== bestTotal) {
      if (rowTotal > bestTotal) best = row;
      continue;
    }
    const rowUpdated = parseMs(row.updated_at ?? "") ?? -Infinity;
    const bestUpdated = parseMs(best.updated_at ?? "") ?? -Infinity;
    if (rowUpdated !== bestUpdated) {
      if (rowUpdated > bestUpdated) best = row;
      continue;
    }
    if (String(row.device_id) < String(best.device_id)) best = row;
  }
  return best;
}

/**
 * Legacy whole-row MAX dedup for account-level hourly rows WITHOUT a stable
 * session identity ('cursor'): rows are identical across devices, so one
 * canonical row per (hour, source, model) suffices. Sources with a session
 * identity ('trae-cn') must instead aggregate from canonical session states
 * (aggregateSessionStates) - never from per-device hourly rows.
 *
 * @param {Array<{device_id: string, hour_start: string, source: string,
 *   model: string, updated_at?: string, total_tokens: number}>} rows -
 *   every device's tokentracker_hourly-shaped rows.
 * @returns {Array} canonical rows - one consistent row per (hour, model).
 */
function dedupeAccountLevelRows(rows) {
  if (!Array.isArray(rows)) return [];
  // Group rows by (source, hour_start); keep original row objects untouched.
  const byHour = new Map();
  for (const row of rows) {
    if (!row || typeof row.hour_start !== "string" || !row.hour_start) continue;
    const key = `${row.source}||${row.hour_start}`;
    const list = byHour.get(key) || [];
    list.push(row);
    byHour.set(key, list);
  }

  const out = [];
  for (const [, hourRows] of byHour) {
    const byModel = new Map();
    for (const row of hourRows) {
      const modelKey = row.model || "unknown";
      const list = byModel.get(modelKey) || [];
      list.push(row);
      byModel.set(modelKey, list);
    }
    for (const list of byModel.values()) {
      out.push(pickLegacyRow(list));
    }
  }
  return out;
}

/** Total tokens of a deduped row set - convenience for tests/diagnostics. */
function sumTotalTokens(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (acc, row) => acc + (Number(row?.total_tokens) || 0),
    0,
  );
}

module.exports = {
  SESSION_STATE_KIND,
  TOKEN_COLUMNS,
  upsertAccountSessionStates,
  aggregateSessionStates,
  dedupeAccountLevelRows,
  sumTotalTokens,
};
