// LiteLLM data loader: 24h disk cache + bundled seed snapshot fallback.
// Fetches from upstream once when cache is missing or stale, then keeps a
// per-process in-memory map. fetchModelPricing() is async; subsequent reads
// (lookupPricing in matcher.js) operate on the in-memory map synchronously.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const LITELLM_PRICING_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const SEED_SNAPSHOT_PATH = path.resolve(__dirname, "seed-snapshot.json");

function readJsonSync(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

async function readJsonAsync(p) {
  const raw = await fsp.readFile(p, "utf8");
  return JSON.parse(raw);
}

function isFresh(stat, ttlMs) {
  if (!stat) return false;
  return Date.now() - stat.mtimeMs < ttlMs;
}

async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function loadSeedSnapshot() {
  // Sync read is fine — file is bundled and small (~250KB). Falling back to
  // sync avoids a race with caller's synchronous lookup if seed must answer
  // immediately.
  try {
    const data = readJsonSync(SEED_SNAPSHOT_PATH);
    try {
      const resolved = require.resolve(SEED_SNAPSHOT_PATH);
      if (require.cache[resolved]) delete require.cache[resolved];
    } catch {}
    return data;
  } catch (e) {
    // Tolerate missing seed in dev environments where the build script
    // hasn't run yet. Empty data = LiteLLM lookup miss = falls back to
    // CURATED only.
    return {};
  }
}

async function fetchUpstream({ url = LITELLM_PRICING_URL, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`LiteLLM fetch failed: HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function writeCache(cachePath, data) {
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  // Persist only the slimmed shape (4 cost fields) to keep disk small and
  // make the cache file easy to inspect/edit.
  const slim = {};
  let kept = 0;
  for (const [name, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object" || name.startsWith("_")) continue;
    const out = {};
    let hasAny = false;
    for (const f of [
      "input_cost_per_token",
      "output_cost_per_token",
      "cache_read_input_token_cost",
      "cache_creation_input_token_cost",
    ]) {
      const v = entry[f];
      if (typeof v === "number" && Number.isFinite(v)) {
        out[f] = v;
        hasAny = true;
      }
    }
    if (hasAny) {
      slim[name] = out;
      kept++;
    }
  }
  const payload = {
    _meta: {
      source: LITELLM_PRICING_URL,
      cached_at: new Date().toISOString(),
      kept_models: kept,
    },
    ...slim,
  };
  await fsp.writeFile(cachePath, JSON.stringify(payload) + "\n");
  return slim;
}

// Public: load LiteLLM data into memory. Resolution chain:
//   1. disk cache (if mtime < ttl)
//   2. fetch upstream + write disk cache
//   3. stale disk cache (network failed)
//   4. bundled seed snapshot (fresh install / offline)
async function loadLitellmData({
  cachePath,
  ttlMs = DEFAULT_TTL_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  fetchImpl = fetchUpstream,
  url = LITELLM_PRICING_URL,
  logger = null,
} = {}) {
  if (!cachePath) {
    throw new Error("loadLitellmData: cachePath is required");
  }
  const log = (level, msg) => {
    if (logger && typeof logger[level] === "function") logger[level](msg);
  };

  // 1. Fresh disk cache
  const stat = await statSafe(cachePath);
  if (isFresh(stat, ttlMs)) {
    try {
      const data = await readJsonAsync(cachePath);
      delete data._meta;
      return { data, source: "disk-cache" };
    } catch (e) {
      log("warn", `[pricing] disk cache unreadable: ${e?.message || e}`);
    }
  }

  // 2. Fetch upstream
  try {
    const upstream = await fetchImpl({ url, timeoutMs: fetchTimeoutMs });
    const slim = await writeCache(cachePath, upstream);
    return { data: slim, source: "upstream" };
  } catch (e) {
    log("warn", `[pricing] upstream fetch failed: ${e?.message || e}`);
  }

  // 3. Stale disk cache (better than seed)
  if (stat) {
    try {
      const data = await readJsonAsync(cachePath);
      delete data._meta;
      log("warn", "[pricing] using stale disk cache");
      return { data, source: "stale-cache" };
    } catch (e) {
      log("warn", `[pricing] stale cache unreadable: ${e?.message || e}`);
    }
  }

  // 4. Bundled seed snapshot
  const seed = await loadSeedSnapshot();
  delete seed._meta;
  return { data: seed, source: "seed-snapshot" };
}

module.exports = {
  LITELLM_PRICING_URL,
  DEFAULT_TTL_MS,
  loadLitellmData,
  loadSeedSnapshot,
  fetchUpstream,
};
