"use strict";

// Shared last-good disk-cache pipeline for usage-limits providers (issue #941).
//
// Fifteen providers shipped their own copy of the same pipeline: a cache file
// under ~/.tokentracker/tracker/, written only on a successful live read
// (tmp + rename, cached_at stamped), read back only when the live read failed
// with a transient error and every cached window still lies in the future.
// The copies differed almost exclusively in three parameters — the identity
// partition key, the field/window list, and the TTL gates — so this module
// folds the pipeline into one factory plus the storage primitives. Per the
// umbrella issue the UI already renders stale results on every surface, so a
// provider adopting this helper needs no UI change.
//
// Red lines every parameterization must keep (issue #941):
//   1. actionable auth/config errors punch through — the cache never masks them;
//   2. a window whose reset has already rolled over is never served as current;
//   3. windows without a reset stamp are bounded by cached_at + a TTL
//      (the global max-age, or an explicit unknownResetTtlMs);
//   4. multi-identity providers partition the cache so one account's bars can
//      never be pinned by another's entry.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Clock skew tolerated when a cache stamp lies slightly in the future (copied
// files, VM pauses): up to one minute past `now` still counts as usable.
const FUTURE_STAMP_SKEW_MS = 60_000;

// ISO-8601 strings only (the shape every provider stamps via
// `new Date(ms).toISOString()`). Returns ms, or null when absent/unparseable.
function parseTimeMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function resolveTrackerDir({ home, trackerDir } = {}) {
  if (typeof trackerDir === "string" && trackerDir.trim()) return trackerDir.trim();
  return path.join(home || os.homedir(), ".tokentracker", "tracker");
}

// Reads and parses a cache file, collapsing every I/O / JSON error into null —
// a broken cache file must degrade to "no cache", never to a thrown error.
function readCacheJson(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

// Atomic write: write a same-directory tmp file, then rename over the target.
// Readers therefore see either the previous or the next payload, never a torn
// one. Failures are swallowed by design — a cache write must never turn a
// successful live read into a failed poll.
function writeCacheJsonAtomic(cachePath, payload) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, cachePath);
  } catch (_error) {}
}

function clearCacheFile(cachePath) {
  try {
    fs.rmSync(cachePath, { force: true });
  } catch (_error) {}
}

/**
 * Builds the read/write/clear facade for one provider's last-good cache.
 *
 * Options:
 *   file              filename, or ({ namespace }) => filename for
 *                     namespace-partitioned files (qoder / qoder-cn).
 *   key               payload wrapper key ("kimi" → `{ kimi: {...} }`);
 *                     null stores the entry flat at the top level (ark).
 *   fields            { name: kind } — kinds: "string" (write `|| null`,
 *                     read typeof check), "number" (Number.isFinite both
 *                     sides), "raw" (`?? null` both sides), "boolTrue"
 *                     (`=== true` both sides). A field may instead be
 *                     { read, write } functions for bespoke shapes
 *                     (claude's weekly_scoped array).
 *   windowKeys        object windows gated per-window by their reset stamp;
 *                     dead windows become null (or vanish — sparseWindowKeys).
 *   sparseWindowKeys  window keys omitted from the payload entirely when
 *                     absent/dead (qoder's tertiary_window), instead of
 *                     being written/read as null.
 *   windowResetField  per-window reset field name ("reset_at"; claude uses
 *                     "resets_at").
 *   resetTimeMode     "iso" (default) | "unix-seconds" (codex).
 *   maxAgeMs          global fresh-keeping bound; number, (rawEntry) => number
 *                     for source-dependent bounds (opencode-go), or null for
 *                     no global gate (ark — undated windows ride
 *                     unknownResetTtlMs alone). Default: 7 days.
 *   maxAgeGate        "always" (reject old snapshots up front) |
 *                     "ifNoDatedSurvivor" (qoder: a snapshot with a
 *                     future-dated window outlives the global max-age; the
 *                     gate then only bounds undated survivors).
 *   unknownResetTtlMs keep-without-reset bound for windows carrying no reset
 *                     stamp (12h where used); default: keep (the global
 *                     max-age already bounds them).
 *   stale             true (fallback reads — the standard annotation) |
 *                     false | "byAge" (stale = older than freshTtlMs, qoder)
 *                     | null (omit the field entirely, antigravity).
 *   freshTtlMs        required by stale: "byAge".
 *   cachedFlag        include `cached: true` in reads (antigravity/qoder/ark).
 *   source            read-side provenance for `source`:
 *                     { const: "disk-cache" } (ark) | "provenance" (qoder —
 *                     fresh hits re-serve the written source, older hits
 *                     report "disk-cache"; #955). The field is written from
 *                     record.source as a plain string-or-null.
 *   identityField     entry field holding the partition key ("identity";
 *                     ark: "profile_identity"). null = unpartitioned.
 *   identityRequired  true: a read/write without an identity is refused and a
 *                     stored identity must match (cursor-family, fail-closed).
 *                     false: mismatch only rejects when the caller could
 *                     establish an identity at all (ark, fail-open).
 *   writeGuard        (record) => bool; default: configured, error-free, and
 *                     carrying at least one window. Ark overrides (its
 *                     normalizer already threw on windowless payloads).
 *   dirOverride       option name overriding the tracker dir
 *                     ("trackerDir", opencode-go).
 */
function createLimitsCache(options) {
  const {
    file,
    key,
    fields = {},
    windowKeys = [],
    sparseWindowKeys = [],
    windowResetField = "reset_at",
    resetTimeMode = "iso",
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    maxAgeGate = "always",
    unknownResetTtlMs = null,
    stale = true,
    freshTtlMs = null,
    cachedFlag = false,
    source = null,
    identityField = null,
    identityRequired = false,
    writeGuard = null,
    dirOverride = null,
  } = options;

  if (stale === "byAge" && !Number.isFinite(freshTtlMs)) {
    throw new Error("limits-cache: stale \"byAge\" requires freshTtlMs");
  }

  function cachePath({ home, namespace, trackerDir } = {}) {
    const name = typeof file === "function" ? file({ namespace }) : file;
    return path.join(resolveTrackerDir({ home, trackerDir: dirOverride ? trackerDir : undefined }), name);
  }

  function hasWindow(record) {
    return windowKeys.some((windowKey) => Boolean(record?.[windowKey]));
  }

  function shouldWrite(record) {
    if (writeGuard) return writeGuard(record);
    return Boolean(record?.configured) && !record.error && hasWindow(record);
  }

  // A window whose reset has already passed is stale data, not a usable
  // fallback — the quota rolled over, so serving its old usage would mislead.
  // Windows without a parseable stamp are kept unless unknownResetTtlMs
  // bounds them by the snapshot's age instead.
  function isWindowUsable(window, { cachedAtMs, nowMs } = {}) {
    if (!window || typeof window !== "object") return false;
    let resetAtMs;
    if (resetTimeMode === "unix-seconds") {
      const resetAt = Number(window[windowResetField]);
      resetAtMs = Number.isFinite(resetAt) && resetAt > 0 ? resetAt * 1000 : null;
    } else {
      resetAtMs = parseTimeMs(window[windowResetField]);
    }
    if (resetAtMs !== null) return resetAtMs > nowMs;
    if (unknownResetTtlMs !== null) {
      return Number.isFinite(cachedAtMs) && nowMs - cachedAtMs <= unknownResetTtlMs;
    }
    return true;
  }

  function writeField(field, kind, record) {
    if (typeof kind === "object" && kind !== null && typeof kind.write === "function") {
      return kind.write(record);
    }
    const value = record?.[field];
    switch (kind) {
      case "string":
        return value || null;
      case "number":
        return Number.isFinite(value) ? value : null;
      case "raw":
        return value ?? null;
      case "boolTrue":
        return value === true;
      default:
        return value ?? null;
    }
  }

  function readField(field, kind, raw, ctx) {
    if (typeof kind === "object" && kind !== null && typeof kind.read === "function") {
      return kind.read(raw, ctx);
    }
    const value = raw?.[field];
    switch (kind) {
      case "string":
        return typeof value === "string" ? value : null;
      case "number":
        return Number.isFinite(value) ? value : null;
      case "raw":
        return value ?? null;
      case "boolTrue":
        return value === true;
      default:
        return value ?? null;
    }
  }

  // Core validator: cached_at gates, identity gate, then the per-window reset
  // gates. Returns the servable record or null — a cache with no surviving
  // window must never pin an error-shaped result in place.
  function normalizeEntry(raw, { nowMs = Date.now(), identity, maxAgeMs: maxAgeOverride, stale: staleOverride } = {}) {
    const cachedAtMs = parseTimeMs(raw?.cached_at);
    if (!Number.isFinite(cachedAtMs)) return null;
    if (cachedAtMs > nowMs + FUTURE_STAMP_SKEW_MS) return null;

    if (identityField && identityRequired && !identity) return null;
    if (identityField && identity && raw?.[identityField] !== identity) return null;

    const effectiveMaxAge = typeof maxAgeMs === "function"
      ? maxAgeMs(raw)
      : maxAgeMs;

    // Per-window gates first; dropped windows become null (or vanish for
    // sparse keys) so a partially-dead snapshot still serves its survivors.
    const windows = {};
    let hasSurvivor = false;
    let hasDatedSurvivor = false;
    for (const windowKey of windowKeys) {
      const window = raw?.[windowKey];
      const usable = isWindowUsable(window, { cachedAtMs, nowMs });
      if (sparseWindowKeys.includes(windowKey)) {
        if (usable) {
          windows[windowKey] = window;
          hasSurvivor = true;
          if (parseTimeMs(window?.[windowResetField]) !== null) hasDatedSurvivor = true;
        }
      } else {
        windows[windowKey] = usable ? window : null;
        if (usable) {
          hasSurvivor = true;
          if (parseTimeMs(window?.[windowResetField]) !== null) hasDatedSurvivor = true;
        }
      }
    }
    if (windowKeys.length > 0 && !hasSurvivor) return null;

    if (effectiveMaxAge !== null) {
      if (maxAgeGate === "ifNoDatedSurvivor") {
        if (!hasDatedSurvivor && nowMs - cachedAtMs > effectiveMaxAge) return null;
      } else if (nowMs - cachedAtMs > (maxAgeOverride ?? effectiveMaxAge)) {
        return null;
      }
    }

    const normalized = {
      configured: true,
      error: null,
    };
    for (const [field, kind] of Object.entries(fields)) {
      normalized[field] = readField(field, kind, raw, { nowMs, cachedAtMs, isWindowUsable });
    }
    Object.assign(normalized, windows);
    if (cachedFlag) normalized.cached = true;

    const effectiveStale = staleOverride ?? stale;
    if (effectiveStale === "byAge") {
      normalized.stale = nowMs - cachedAtMs > freshTtlMs;
    } else if (effectiveStale !== null) {
      normalized.stale = effectiveStale;
    }
    normalized.cached_at = raw.cached_at;

    if (source !== null) {
      if (source === "provenance") {
        const writtenSource = typeof raw?.source === "string" && raw.source.trim()
          ? raw.source.trim()
          : null;
        // Provenance must describe the data's age, not the transport (#955):
        // a fresh hit re-serves the winning source it was written with, an
        // older hit honestly reports the disk cache.
        normalized.source = normalized.stale === false && writtenSource
          ? writtenSource
          : "disk-cache";
      } else if (typeof source === "object" && typeof source.const === "string") {
        normalized.source = source.const;
      }
    }

    return windowKeys.length > 0 || Object.keys(fields).length > 0 ? normalized : null;
  }

  function read(opts = {}) {
    const { home, namespace, trackerDir, nowMs = Date.now(), identity, maxAgeMs: maxAgeOverride, stale: staleOverride } = opts;
    if (identityField && identityRequired && !identity) return null;
    const parsed = readCacheJson(cachePath({ home, namespace, trackerDir }));
    const entry = key ? parsed?.[key] : parsed;
    return normalizeEntry(entry, { nowMs, identity, maxAgeMs: maxAgeOverride, stale: staleOverride });
  }

  function write(record, opts = {}) {
    const { home, namespace, trackerDir, nowMs = Date.now(), identity } = opts;
    if (identityField && identityRequired && !identity) return;
    if (!shouldWrite(record)) return;
    const entry = {};
    if (identityField && identityRequired) entry[identityField] = identity;
    for (const [field, kind] of Object.entries(fields)) {
      entry[field] = writeField(field, kind, record);
    }
    for (const windowKey of windowKeys) {
      if (sparseWindowKeys.includes(windowKey)) {
        if (record?.[windowKey]) entry[windowKey] = record[windowKey];
      } else {
        entry[windowKey] = record?.[windowKey] || null;
      }
    }
    entry.cached_at = new Date(nowMs).toISOString();
    const payload = key ? { [key]: entry } : entry;
    writeCacheJsonAtomic(cachePath({ home, namespace, trackerDir }), payload);
  }

  function clear(opts = {}) {
    clearCacheFile(cachePath(opts));
  }

  return {
    file,
    key,
    path: cachePath,
    hasWindow,
    isWindowUsable,
    normalize: normalizeEntry,
    read,
    write,
    clear,
  };
}

// Internal cache-plumbing markers ride on provider slot results between the
// fetcher and the assembly; they are never payload and are stripped before the
// aggregate is served.
function stripInternalMarkers(record, markers) {
  if (!record || !markers.some((marker) => marker in record)) return record;
  const payload = { ...record };
  for (const marker of markers) delete payload[marker];
  return payload;
}

/**
 * The standard assembly-site integration, shared verbatim by the providers
 * whose fallback is the plain three-way shape:
 *
 *   success with windows → stamp fresh, write cache (generation-gated,
 *                          write-identity hook may refuse);
 *   actionable failure   → pass through untouched (auth/config errors must
 *                          never be hidden behind stale cache);
 *   transient failure    → serve the cache (replace or overlay), else the
 *                          failed slot itself.
 *
 * Async because at least one provider (copilot) re-derives its cache identity
 * through async storage; a failed poll must not block the embedded server's
 * event loop on that path.
 */
async function withLimitsCacheFallback(slot, {
  cache,
  hasWindow = null,
  nowMs = Date.now(),
  home,
  env,
  isCurrentGeneration = () => true,
  resolveWriteIdentity = () => undefined,
  resolveReadIdentity = () => undefined,
  beforeRead = null,
  passthrough = null,
  merge = "replace",
  markers = ["cache_identity", "auth_error"],
} = {}) {
  const slotHasWindow = hasWindow || cache.hasWindow;
  if (!slot || slot.configured === false) return slot;

  if (!slot.error && slotHasWindow(slot)) {
    const stamped = {
      ...slot,
      stale: false,
      cached_at: new Date(nowMs).toISOString(),
    };
    if (isCurrentGeneration()) {
      const identity = await resolveWriteIdentity(slot);
      if (identity) {
        cache.write(stamped, { home, nowMs, identity });
      }
    }
    return stripInternalMarkers(stamped, markers);
  }

  if (passthrough && passthrough(slot)) {
    return stripInternalMarkers(slot, markers);
  }

  // The slot's error object loses the fetcher's identity field when the outer
  // timeout race wins (the common failure mode this cache exists for), so the
  // read identity is re-derived here on the failure-only path. beforeRead may
  // be async — copilot re-derives its identity through the keychain and must
  // sample the wall clock only after that lookup (a slow poll can straddle a
  // reset), so its hook returns { identity, nowMs } in one awaited step.
  const readOptions = beforeRead ? await beforeRead(slot) : {};
  if (readOptions === null) return stripInternalMarkers(slot, markers);
  const cached = cache.read({
    home,
    nowMs: readOptions.nowMs ?? nowMs,
    identity: await (readOptions.identity !== undefined
      ? Promise.resolve(readOptions.identity)
      : resolveReadIdentity()),
  });
  const merged = cached
    ? (merge === "overlay" ? { ...slot, ...cached } : cached)
    : slot;
  return stripInternalMarkers(merged, markers);
}

module.exports = {
  parseTimeMs,
  resolveTrackerDir,
  readCacheJson,
  writeCacheJsonAtomic,
  clearCacheFile,
  createLimitsCache,
  stripInternalMarkers,
  withLimitsCacheFallback,
};
