// Pure pricing-lookup logic. No I/O, no async. Tested in isolation.
//
// Resolve order:
//   0. CURATED source exact match (source-specific pricing)
//   1. CURATED exact match (self-defined aliases like kiro-*, hy3-*)
//   2. LiteLLM exact match (mainstream claude/gpt-5/gemini)
//   3. CURATED alias (e.g. "auto" -> "composer-1")
//   4. CURATED fuzzy substring (e.g. "kiro-future-xyz" matches via "kiro")
//   5. LiteLLM suffix-strip (gpt-5-codex-high-fast -> gpt-5-codex)
//   5b. LiteLLM provider-prefix strip (mimo-v2.5-pro -> openrouter/xiaomi/mimo-v2.5-pro)
//   6. LiteLLM reverse substring (longest-key first)
//   7. null  (caller decides what to do — typically zero-pricing + negative cache)

const SUFFIX_STRIP_PATTERNS = [
  /-xhigh-fast$/,
  /-high-fast$/,
  /-medium-fast$/,
  /-low-fast$/,
  /-xhigh$/,
  /-high$/,
  /-medium$/,
  /-low$/,
  /-fast$/,
];

function stripReasoningSuffix(model) {
  for (const re of SUFFIX_STRIP_PATTERNS) {
    if (re.test(model)) return model.replace(re, "");
  }
  return model;
}

function normalizeAntigravityModel(model) {
  if (!model || typeof model !== "string") return model;
  let lower = model
    .trim()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(thinking|xhigh|high|medium|low|fast)\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  lower = stripReasoningSuffix(lower);

  if (lower.startsWith("gemini-claude-") || lower.startsWith("gemini-gpt-")) {
    lower = lower.substring(7);
  }

  if (/^gemini-3\.\d+-flash-lite/.test(lower)) return "gemini-2.5-flash-lite";
  if (/^gemini-3\.\d+-flash/.test(lower)) return "gemini-2.5-flash";
  if (/^gemini-3\.\d+-pro/.test(lower)) return "gemini-2.5-pro";
  if (/^claude-(sonnet|opus|haiku)-4\.\d+/.test(lower)) {
    return lower.replace(/^claude-(sonnet|opus|haiku)-4\.(\d+)/, "claude-$1-4-$2");
  }
  if (lower.startsWith("gpt-oss-120b")) return "antigravity-gpt-oss-120b";

  return lower;
}

// Zed stores model names inconsistently across versions and providers: a mix
// of canonical ids (`gpt-5.5`, `claude-opus-4.8`) and human display names
// (`Claude Sonnet 4`, `GPT-5 (Preview)`, `Gemini 3 Pro (Preview)`). Map both to
// the pricing engine's keys for cost lookup ONLY — the raw name is still what
// gets stored/displayed. Unlike normalizeAntigravityModel we must NOT strip the
// word "fast" (it is part of `grok-code-fast-1`) and we keep dotted GPT minors
// (`gpt-5.2`) while hyphenating Claude minors (`claude-opus-4.8` ->
// `claude-opus-4-8`) to match each family's LiteLLM/curated key style.
function normalizeZedModel(model) {
  if (!model || typeof model !== "string") return model;
  let m = model
    .trim()
    .replace(/\([^)]*\)/g, " ") // drop "(Preview)" and similar qualifiers
    .toLowerCase()
    .replace(/[^a-z0-9./]+/g, "-") // spaces/underscores -> hyphen; keep . and /
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (/^claude-(sonnet|opus|haiku)-\d+\.\d+/.test(m)) {
    m = m.replace(/^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)/, "$1-$2");
  }
  return m;
}

// Claude desktop/CLI sometimes reports display-style names such as
// `claude-opus-4.8` or `Claude Opus 4.8`, while curated keys use Anthropic's
// historical dash style (`claude-opus-4-8`). Relay/gateway backends (OpenRouter
// and API proxies) add a provider path prefix and may invert tier/version order
// — e.g. `anthropic/claude-4.6-opus-20260205` — which previously rendered $0
// because the prefix slash got flattened to a dash and the order never matched.
function normalizeClaudeModel(model) {
  if (!model || typeof model !== "string") return model;
  // Drop the provider path prefix relays prepend ("anthropic/...",
  // "openrouter/anthropic/...") so only the bare Claude id reaches the cleanup
  // and lookups below. Without this the "/" is flattened to "-" by the regex
  // step, breaking both the exact and provider-prefix-strip matches.
  const base = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  let m = base
    .trim()
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (/^claude-(sonnet|opus|haiku)-\d+\.\d+/.test(m)) {
    return m.replace(/^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)/, "$1-$2");
  }
  if (/^(sonnet|opus|haiku)-\d+[.-]\d+/.test(m)) {
    return m
      .replace(/^(sonnet|opus|haiku)-/, "claude-$1-")
      .replace(/^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)/, "$1-$2");
  }
  // Some relays invert tier/version order (`claude-4.6-opus` instead of the
  // canonical `claude-opus-4-6`). Restore it ONLY for major>=4 — Claude 3.x is
  // genuinely version-first (`claude-3-5-sonnet`, `claude-3-opus`) and must stay
  // untouched.
  if (/^claude-(?:[4-9]|\d{2,})[.-]\d+-(?:sonnet|opus|haiku)/.test(m)) {
    return m.replace(/^claude-(\d+)[.-](\d+)-(sonnet|opus|haiku)/, "claude-$3-$1-$2");
  }

  return m;
}

// Cursor decorates model ids with reasoning effort and sometimes places the
// Claude version before the tier. Normalize those lookup-only aliases while
// preserving Grok 4.5's distinct Fast SKU (its rate is not the base rate).
function normalizeCursorModel(model) {
  if (!model || typeof model !== "string") return model;
  let m = model
    .trim()
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const parts = m.split("-");
  const isFast = parts.includes("fast");

  if (/^(?:cursor-)?grok-4[.-]5(?:-|$)/.test(m)) {
    return isFast ? "cursor-grok-4.5-fast" : "cursor-grok-4.5";
  }

  // `fast` can be a separately priced SKU (for example composer-2-fast and
  // claude-opus-5-fast). Preserve it for the exact lookups below; when it is
  // merely a decoration, lookupPricing's later suffix-strip still falls back
  // to the base LiteLLM model.
  const decorations = new Set(["thinking", "xhigh", "high", "medium", "low"]);
  m = parts.filter((part) => !decorations.has(part)).join("-");
  if (m.startsWith("claude-")) return normalizeClaudeModel(m);
  return m;
}

// WorkBuddy's auto-router records the model as the literal "auto" and never
// exposes the underlying model it picked. That collides with Cursor's curated
// alias ("auto" -> "composer-1"), which would misprice WorkBuddy usage as
// Cursor's Composer. Map it instead to hy3-preview-agent — WorkBuddy's default
// Tencent Hunyuan model — mirroring how Cursor's "auto" maps to its own default
// (composer-1). The auto-router can pick pricier models, so this can slightly
// under-count, but it tracks the token cost of WorkBuddy's representative model
// rather than an unrelated vendor's. (The raw "auto" string is still
// stored/displayed; only the pricing lookup is remapped.)
function normalizeWorkbuddyModel(model) {
  if (typeof model === "string" && model.trim().toLowerCase() === "auto") {
    return "hy3-preview-agent";
  }
  return model;
}

function normalizeIFlytekMaasModel(model) {
  if (!model || typeof model !== "string") return model;
  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  // AStudio's iFlytek MaaS automatic routing does not expose the underlying
  // model; its pricing is currently kept aligned with GLM-5.3.
  if (lower === "auto" || lower.endsWith("-auto")) return "xopglm53";
  // The default Agent slug maps to the Spark X2 service in the supplied price list.
  if (lower === "xsparkx2agent") return "xsparkx2";
  return trimmed;
}

// Unsloth Studio can mix local engines and paid API providers in one database.
// The parser qualifies metered models with their provider and marks local,
// subscription-backed, or ambiguous custom routes as unpriced. Returning a
// sentinel here prevents the generic reverse-substring matcher from mistaking
// a locally hosted model name for the similarly named cloud SKU.
function normalizeUnslothModel(model) {
  if (typeof model !== "string") return model;
  const lower = model.trim().toLowerCase();
  if (lower.startsWith("local/") || lower.startsWith("unpriced/")) {
    return "__tokentracker_unpriced_unsloth_model__";
  }
  return model;
}

// Per-source model-name normalizers, applied at pricing-lookup time only (the
// raw model name is preserved for storage/display). Add a source here when its
// model strings don't match the LiteLLM/curated keys verbatim.
const SOURCE_MODEL_NORMALIZERS = {
  acode: normalizeIFlytekMaasModel,
  antigravity: normalizeAntigravityModel,
  claude: normalizeClaudeModel,
  cursor: normalizeCursorModel,
  "pi-anthropic": normalizeClaudeModel,
  "prime-agent-anthropic": normalizeClaudeModel,
  zed: normalizeZedModel,
  unsloth: normalizeUnslothModel,
  workbuddy: normalizeWorkbuddyModel,
};

// Memoise the sorted-by-length LiteLLM key list. Reverse-substring scan walks
// this once per uncached model; ~2k keys × negligible per-iteration cost, but
// computing the sort on every call would add up across a sync.
const sortedKeysCache = new WeakMap();
function getSortedKeys(litellm) {
  let cached = sortedKeysCache.get(litellm);
  if (!cached) {
    cached = Object.keys(litellm).sort((a, b) => b.length - a.length);
    sortedKeysCache.set(litellm, cached);
  }
  return cached;
}

function buildDotRestoredModel(model) {
  if (typeof model !== "string") return "";
  const lower = model.toLowerCase();
  const restored = lower.replace(/(\d+)-(\d+)/g, "$1.$2");
  return restored === lower ? "" : restored;
}

function lookupExactCaseInsensitive(table, model) {
  if (!table || !model) return null;
  if (table[model]) return table[model];
  const lower = model.toLowerCase();
  for (const key of Object.keys(table)) {
    if (key.toLowerCase() === lower) return table[key];
  }
  return null;
}

function lookupContainedExactCaseInsensitive(table, model) {
  if (!table || !model) return null;
  const lower = model.toLowerCase();
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key.toLowerCase())) return table[key];
  }
  return null;
}

function lookupPricing(model, { curated, litellm, source } = {}) {
  if (!model || typeof model !== "string") {
    return { hit: false, source: "empty", value: null };
  }
  const normalize =
    typeof source === "string" ? SOURCE_MODEL_NORMALIZERS[source.toLowerCase()] : null;
  const lookupModel = normalize ? normalize(model) : model;
  const lower = lookupModel.toLowerCase();
  const dotForm = buildDotRestoredModel(lookupModel);

  // 0. CURATED source exact. Source-specific prices apply only to their source,
  // preventing collisions with public prices for same-named models from other CLIs.
  const sourceKey = typeof source === "string" ? source.toLowerCase() : "";
  const sourceExact = curated.source_exact?.[sourceKey];
  if (sourceExact) {
    const sourceValue = lookupExactCaseInsensitive(sourceExact, lookupModel);
    if (sourceValue) {
      return { hit: true, source: "curated:source-exact", value: sourceValue };
    }
  }

  // 1. CURATED exact
  if (curated.exact && curated.exact[lookupModel]) {
    return { hit: true, source: "curated:exact", value: curated.exact[lookupModel] };
  }
  const curatedDotExact = lookupExactCaseInsensitive(curated.exact, dotForm);
  if (curatedDotExact) {
    return { hit: true, source: "curated:exact-dot", value: curatedDotExact };
  }
  const curatedDotContainedExact = lookupContainedExactCaseInsensitive(curated.exact, dotForm);
  if (curatedDotContainedExact) {
    return { hit: true, source: "curated:exact-dot", value: curatedDotContainedExact };
  }

  // 2. LiteLLM exact
  if (litellm && litellm[lookupModel]) {
    return { hit: true, source: "litellm:exact", value: litellm[lookupModel] };
  }
  const litellmDotExact = lookupExactCaseInsensitive(litellm, dotForm);
  if (litellmDotExact) {
    return { hit: true, source: "litellm:exact-dot", value: litellmDotExact };
  }

  // 3. CURATED alias (literal mapping like "auto" -> "composer-1")
  if (curated.alias && curated.alias[lookupModel] && curated.exact[curated.alias[lookupModel]]) {
    return {
      hit: true,
      source: "curated:alias",
      value: curated.exact[curated.alias[lookupModel]],
    };
  }

  // 4. CURATED fuzzy substring. Also try a dot-restored variant of the input
  // (digits separated by `-` rejoined as `.`) so providers that dash-normalize
  // numeric segments — Droid emits `glm-5-1-0` for upstream `GLM-5.1` — still
  // resolve against dot-keyed curated entries like `glm-5.1`, `glm-4.6`, etc.
  // The regex only fires on digit-dash-digit, so `claude-3-7-sonnet`,
  // `gpt-5-codex`, `gemini-2-5-pro` are unaffected (no digit-pair to rejoin or
  // no matching curated key).
  if (Array.isArray(curated.fuzzy)) {
    for (const { match, ref } of curated.fuzzy) {
      if (!match || !ref) continue;
      const needle = match.toLowerCase();
      if (!curated.exact[ref]) continue;
      if (lower.includes(needle)) {
        return { hit: true, source: "curated:fuzzy", value: curated.exact[ref] };
      }
      if (dotForm && dotForm.includes(needle)) {
        return { hit: true, source: "curated:fuzzy", value: curated.exact[ref] };
      }
    }
  }

  // 5. LiteLLM suffix-strip
  if (litellm) {
    const stripped = stripReasoningSuffix(lookupModel);
    if (stripped !== lookupModel && litellm[stripped]) {
      return { hit: true, source: "litellm:strip", value: litellm[stripped] };
    }
  }

  // 5b. LiteLLM provider-prefix strip. Queue rows store the bare model name
  // (e.g. "mimo-v2.5-pro"), but LiteLLM keys are provider-qualified (e.g.
  // "openrouter/xiaomi/mimo-v2.5-pro"), so the exact lookups above miss. Match
  // any key whose path suffix equals the bare model. When several providers
  // expose the same model, pick the lexicographically smallest key so the
  // resolved price is deterministic and independent of JSON ordering. Runs
  // AFTER curated alias/fuzzy so e.g. Cursor's "auto" still resolves to
  // composer-1 rather than a LiteLLM "*/auto" entry.
  if (litellm) {
    const suffix = "/" + lower;
    let best = null;
    for (const key of Object.keys(litellm)) {
      if (key.length > suffix.length && key.toLowerCase().endsWith(suffix)) {
        if (best === null || key < best) best = key;
      }
    }
    if (best) return { hit: true, source: "litellm:prefix-strip", value: litellm[best] };
  }

  // 6. LiteLLM reverse substring (longest-key first)
  if (litellm) {
    const sorted = getSortedKeys(litellm);
    for (const key of sorted) {
      const keyLower = key.toLowerCase();
      // Only accept if model is a superset of key (model contains key), to
      // avoid e.g. "gpt-5" matching "gpt-5-pro" in the wrong direction.
      if (lower.includes(keyLower) || (dotForm && dotForm.includes(keyLower))) {
        return { hit: true, source: "litellm:fuzzy", value: litellm[key] };
      }
    }
  }

  return { hit: false, source: "miss", value: null };
}

// Convert one LiteLLM entry (per-token) to internal per-million USD shape.
// Missing fields stay missing — callers default with `(pricing.x || 0)`.
//
// Why the round: floating-point math means 1e-7 * 1e6 = 0.09999999999999999.
// Rounding to 10 significant decimals ($0.0000000001 / MTok) is well below
// any realistic price step but cleans up the printed/asserted numbers.
function roundToTenDecimals(n) {
  return Math.round(n * 1e10) / 1e10;
}

function convertLitellmEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  if (typeof entry.input_cost_per_token === "number") {
    out.input = roundToTenDecimals(entry.input_cost_per_token * 1_000_000);
  }
  if (typeof entry.output_cost_per_token === "number") {
    out.output = roundToTenDecimals(entry.output_cost_per_token * 1_000_000);
  }
  if (typeof entry.cache_read_input_token_cost === "number") {
    out.cache_read = roundToTenDecimals(entry.cache_read_input_token_cost * 1_000_000);
  }
  if (typeof entry.cache_creation_input_token_cost === "number") {
    out.cache_write = roundToTenDecimals(entry.cache_creation_input_token_cost * 1_000_000);
  }
  return Object.keys(out).length ? out : null;
}

// Build a per-million-USD map from a LiteLLM raw map (or seed snapshot which
// uses the same field names). Skips meta keys starting with "_".
function buildLitellmPerMillionMap(rawData) {
  if (!rawData || typeof rawData !== "object") return {};
  const out = {};
  for (const [name, entry] of Object.entries(rawData)) {
    if (name.startsWith("_")) continue;
    const converted = convertLitellmEntry(entry);
    if (converted) out[name] = converted;
  }
  return out;
}

module.exports = {
  lookupPricing,
  stripReasoningSuffix,
  normalizeAntigravityModel,
  normalizeIFlytekMaasModel,
  normalizeClaudeModel,
  normalizeCursorModel,
  normalizeZedModel,
  convertLitellmEntry,
  buildLitellmPerMillionMap,
};
