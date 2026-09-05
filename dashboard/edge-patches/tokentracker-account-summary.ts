/**
 * InsForge Edge: account-wide usage summary (cross-device, aggregated by user_id).
 * Mirrors local-api.js `tokentracker-usage-summary` response schema.
 *
 * Auth: HS256 JWT_SECRET signature verification (same template as
 * tokentracker-device-token-issue). InsForge does NOT validate JWTs at the
 * gateway, so edge functions that expose per-user data MUST verify the
 * signature themselves — otherwise any caller can forge {"sub":"<victim>"}
 * and read another user's full token history.
 *
 * Cross-device aggregation lives server-side in the account_usage_grouped RPC
 * (this function just buckets/sums what the RPC returns). The RPC splits by
 * source class — see its header + test/account-source-parity.test.js:
 *   * MACHINE-LEVEL sources (claude/codex/gemini/...): real independent
 *     per-machine work → SUM across the user's ACTIVE devices (revoked_at IS
 *     NULL). The active-device filter + machine-stable device_name (the
 *     dashboard derives it from /functions/tokentracker-machine-id, see
 *     cloud-sync.ts resolveDeviceNameSuffix) drop historic device_id churn so
 *     SUM doesn't double-count one machine opened in multiple browsers.
 *   * ACCOUNT-LEVEL sources (cursor): data comes from a per-ACCOUNT cloud API,
 *     NOT machine logs, so every device that synced it stores an IDENTICAL
 *     copy. These are DEDUPED across ALL devices (one canonical whole row per
 *     hour/source/model), NOT summed. Summing multiplied a user's Cursor total
 *     by their device count — the v0.42–0.43 double-count bug (a 2-machine
 *     user's Cursor was ~2x; ~5% of their grand total).
 *
 *   Cross-device = additive (GitHub Discussion #101) still holds for the
 *   machine-level sources that motivated it. The dashboard total and the
 *   leaderboard rank now use the SAME two-class semantic
 *   (leaderboard-refresh.ts / leaderboard-profile.ts), so they agree.
 */
import { createClient } from "npm:@insforge/sdk";

const SOURCES_WITH_AUTHORITATIVE_COST = new Set(["grok"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Convert UTC timestamp to local YYYY-MM-DD (see local-api.js#getZonedParts).
 * Positive offsetMinutes = east of UTC.
 */
function zonedDayKey(hourStart: string, tz: string | null, offsetMinutes: number | null): string {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(hourStart));
      const y = parts.find((p) => p.type === "year")?.value;
      const m = parts.find((p) => p.type === "month")?.value;
      const d = parts.find((p) => p.type === "day")?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch { /* fall through */ }
  }
  if (offsetMinutes != null && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(new Date(hourStart).getTime() + offsetMinutes * 60000);
    return shifted.toISOString().slice(0, 10);
  }
  return hourStart.slice(0, 10);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Verify HS256 JWT against JWT_SECRET and return its sub. Mirrors the helper
 * in tokentracker-device-token-issue.ts. Returns null on any failure (bad
 * shape, bad signature, expired) — caller surfaces that as 401.
 */
async function verifiedUserIdFromJwt(authHeader: string | null): Promise<string | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as Record<string, unknown>;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    let ok = false;
    if (header.alg === "HS256") {
      const secret = Deno.env.get("JWT_SECRET");
      if (!secret) return null;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("HMAC", key, sig, data);
    } else if (header.alg === "RS256") {
      const publicKeyPem = Deno.env.get("JWT_PUBLIC_KEY");
      if (!publicKeyPem) return null;
      const publicKeyDer = Uint8Array.from(atob(publicKeyPem.replace(/-----[^-]+-----|\s/g, "")), (char) => char.charCodeAt(0));
      const key = await crypto.subtle.importKey("spki", publicKeyDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    } else return null;
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch { /* ignore */ }
  return null;
}

/** Per-model pricing (USD per million tokens). Synced from src/lib/local-api.js. */

// NOTE: MODEL_PRICING + getModelPricing synced from tokentracker-leaderboard-refresh.ts
// to fix dashboard cost under-reporting (e.g. mimo-v2.5-pro → $0, gpt-5.5 → fallback gpt-5).
// TODO: extract to a shared edge-pricing module; tracked in feedback_model_pricing_sync.
const MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }> = {
  // ── Anthropic Claude ──
  "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-5-fast": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-5-20250414": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-5-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-3-5-haiku-20241022": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  // ── OpenAI GPT / Codex ──
  "gpt-5": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-codex": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5-codex-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cache_read: 0.025 },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-high-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-xhigh-fast": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.1-codex-max-high": { input: 1.25, output: 10, cache_read: 0.125 },
  "gpt-5.2": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-high-fast": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-codex": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.2-codex-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.3-codex": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.3-codex-high": { input: 1.75, output: 14, cache_read: 0.175 },
  "gpt-5.4": { input: 2.5, output: 15, cache_read: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_read: 0.075 },
  // gpt-5.4-pro per developers.openai.com/api/docs/pricing; cache_read 3
  // mirrors the local LiteLLM entry. There is NO "-medium" SKU —
  // medium/high/xhigh are reasoning-effort levels billed at the base rate;
  // a stale "gpt-5.4-medium" 1.5/10 entry here undercut the local engine
  // (suffix-strip → gpt-5.4 at 2.5/15) by 40% until 2026-06.
  "gpt-5.4-pro": { input: 30, output: 180, cache_read: 3 },
  "gpt-5.5": { input: 5, output: 30, cache_read: 0.5 },
  // GPT-5.6 family (public 2026-07-09), developers.openai.com/api/docs/pricing.
  // Three durable capability tiers: sol (flagship and public alias) / terra (balanced) /
  // luna (lightweight). Codex reports the tier in the model id (gpt-5.6-sol,
  // + reasoning-effort variants like gpt-5.6-solhigh). Not yet in LiteLLM.
  "gpt-5.6-sol": { input: 4, output: 20, cache_read: 0.4, cache_write: 5 },
  "gpt-5.6-terra": { input: 2, output: 12, cache_read: 0.2, cache_write: 2.5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
  "gpt-5-mini": { input: 0.25, output: 2, cache_read: 0.025 },
  "o3": { input: 2, output: 8, cache_read: 0.5 },
  // ── Google Gemini ──
  "gemini-2.5-pro": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-06-05": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-pro-preview-05-06": { input: 1.25, output: 10, cache_read: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache_read: 0.03 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cache_read: 0.05 },
  "gemini-3-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cache_read: 0.2 },
  // ── Cursor Composer ──
  "composer-1": { input: 1.25, output: 10, cache_read: 0.125 },
  "composer-1.5": { input: 3.5, output: 17.5, cache_read: 0.35 },
  "composer-2": { input: 0.5, output: 2.5, cache_read: 0.2 },
  "composer-2-fast": { input: 1.5, output: 7.5, cache_read: 0.15 },
  // ── Moonshot Kimi ──
  "kimi-for-coding": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5": { input: 0.6, output: 2, cache_read: 0.15 },
  "kimi-k2.5-free": { input: 0, output: 0, cache_read: 0 },
  "kimi-k2.6": { input: 0.95, output: 4, cache_read: 0.16 },
  "kimi-k2.7-code": { input: 0.95, output: 4, cache_read: 0.19 },
  // Kimi K3 (released 2026-07-16; reported rates $3/M in, $15/M out, $0.30/M
  // cached). Kimi Code records the alias as bare "k3" (kimi-code/k3), hence
  // the separate "k3" exact key below. Not yet in LiteLLM.
  "kimi-k3": { input: 3, output: 15, cache_read: 0.3 },
  "k3": { input: 3, output: 15, cache_read: 0.3 },
  // ── Z.ai GLM (mirrored from src/lib/pricing/curated-overrides.json).
  //    LiteLLM only keys these under provider prefixes like `zai/glm-5`,
  //    `openrouter/z-ai/glm-4.6`, etc. The reverse-substring fallback in the
  //    matcher requires the user-supplied model name to CONTAIN the LiteLLM
  //    key, so the bare `glm-5.1` / `glm-4.6` strings reported by Claude
  //    Code-compatible GLM endpoints never match. Curate them here. ──
  // GLM-5.3: flagship keeps the 5.2 list rate; Flash is a distinct cheap SKU
  // (LiteLLM `zai/glm-5.3-flash`: $0.15/$0.50/$0.03 per MTok in/out/cache-read).
  "glm-5.3": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cache_read: 0.03 },
  "glm-5.2": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5.1": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "glm-5": { input: 1.0, output: 3.2, cache_read: 0.2 },
  "glm-5-turbo": { input: 1.2, output: 4.0, cache_read: 0.24 },
  "glm-4.7": { input: 0.6, output: 2.2, cache_read: 0.11 },
  "glm-4.7-flashx": { input: 0.07, output: 0.4, cache_read: 0.01 },
  "glm-4.7-flash": { input: 0, output: 0, cache_read: 0 },
  "glm-4.6": { input: 0.6, output: 2.2, cache_read: 0.11 },
  "glm-4.5": { input: 0.6, output: 2.2, cache_read: 0.11 },
  "glm-4.5-x": { input: 2.2, output: 8.9, cache_read: 0.45 },
  "glm-4.5-air": { input: 0.2, output: 1.1, cache_read: 0.03 },
  "glm-4.5-airx": { input: 1.1, output: 4.5, cache_read: 0.22 },
  "glm-4.5-flash": { input: 0, output: 0, cache_read: 0 },
  // ── MiniMax / DeepSeek ──
  "MiniMax-M2.7": { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.375 },
  "MiniMax-M2.7-highspeed": { input: 0.6, output: 2.4, cache_read: 0.06, cache_write: 0.375 },
  "minimax-m3": { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0 },
  "deepseek-v4-flash": { input: 0.44, output: 1.32, cache_read: 0.014, cache_write: 0.44 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cache_read: 0.044, cache_write: 1.32 },
  "deepseek-v4-flash-vision-exp": { input: 0.44, output: 1.32, cache_read: 0.014, cache_write: 0.44 },
  "deepseek-chat": { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.14 },
  "deepseek-reasoner": { input: 0.14, output: 0.28, cache_read: 0.0028, cache_write: 0.14 },
  // ── xAI Grok (mirrored from src/lib/pricing/curated-overrides.json;
  //    Grok parser emits cache_creation_input_tokens = 0, so cache_write is
  //    omitted — same as the canonical table). ──
  "grok-build": { input: 1.25, output: 2.50, cache_read: 0.20 },
  "cursor-grok-4.5": { input: 2, output: 6, cache_read: 0.5, cache_write: 0 },
  "cursor-grok-4.5-fast": { input: 4, output: 18, cache_read: 1, cache_write: 0 },
  "grok-4-0709": { input: 3.00, output: 15.00, cache_read: 0.75 },
  "grok-4": { input: 3.00, output: 15.00, cache_read: 0.75 },
  "grok-4-latest": { input: 3.00, output: 15.00, cache_read: 0.75 },
  "grok-4-fast": { input: 0.20, output: 0.50, cache_read: 0.05 },
  "grok-4-fast-reasoning": { input: 0.20, output: 0.50, cache_read: 0.05 },
  "grok-4-fast-non-reasoning": { input: 0.20, output: 0.50, cache_read: 0.05 },
  "grok-4-1-fast-non-reasoning": { input: 0.20, output: 0.50, cache_read: 0.05 },
  // ── AWS Kiro (mirrored byte-for-byte from src/lib/local-api.js to
  //    prevent cloud/local cost drift — Kiro routes through Bedrock,
  //    most commonly claude-sonnet-4). ──
  "kiro-agent": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "kiro-cli-agent": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  // ── Tencent CodeBuddy / WorkBuddy (hy3-preview family). Tencent TokenHub
  //    official rate: 1.2 / 0.4 (cache hit) / 4.0 RMB per MTok in/read/out,
  //    converted at ~7.2 RMB/USD. DeepSeek-style cache: cache_write = input. ──
  "hy3-preview-agent": { input: 0.167, output: 0.556, cache_read: 0.056, cache_write: 0.167 },
  "hy3-preview": { input: 0.167, output: 0.556, cache_read: 0.056, cache_write: 0.167 },
  // ── Misc / Free ──
  "glm-4.7-free": { input: 0, output: 0, cache_read: 0 },
  "nemotron-3-super-free": { input: 0, output: 0, cache_read: 0 },
  "mimo-v2-pro-free": { input: 0, output: 0, cache_read: 0 },
  "minimax-m2.1-free": { input: 0, output: 0, cache_read: 0 },
  "MiniMax-M2.1": { input: 0.5, output: 3, cache_read: 0.05 },
  // ── Xiaomi MiMo (mirrored from src/lib/pricing/seed-snapshot.json LiteLLM
  //    entries openrouter/xiaomi/mimo-*; queue rows report the bare names.
  //    Kept in lockstep with the matcher's litellm:prefix-strip resolution —
  //    cache_read for mimo-v2-flash uses novita's 0.02 (the lexicographically
  //    smallest provider key the matcher deterministically picks). ──
  "mimo-v2.5-pro": { input: 1, output: 3, cache_read: 0.2 },
  "mimo-v2.5": { input: 0.4, output: 2, cache_read: 0.08 },
  "mimo-v2-flash": { input: 0.1, output: 0.3, cache_read: 0.02 },
  // ── Sakana Fugu (OpenAI-compatible API via sakana.ai PAYG / OpenRouter,
  //    used through Codex/Cursor/Cline/ZCode etc.; mirrored from
  //    src/lib/pricing/curated-overrides.json). OpenRouter rate: $5/$30 per
  //    MTok in/out, cache_read $0.5/M; no cache-write surcharge so
  //    cache_write = input. ──
  "sakana/fugu-ultra": { input: 5, output: 30, cache_read: 0.5, cache_write: 5 },
  // ── Meituan LongCat-2.0, seen via ZCode custom-provider routing (#276;
  //    mirrored from src/lib/pricing/curated-overrides.json). Official
  //    longcat.chat launch-promo rate: RMB 2/0.04(cache hit)/8 per MTok
  //    in/read/out, converted at ~7.2 RMB/USD; standard list price is
  //    RMB 5/0.10/20 once the promo ends — re-verify before changing. No
  //    cache-write surcharge published, so cache_write = input. ──
  "longcat-2.0": { input: 0.278, output: 1.111, cache_read: 0.00556, cache_write: 0.278 },
  // ── StepFun Step 3.5/3.7 Flash (#283; mirrored from
  //    src/lib/pricing/curated-overrides.json). Official platform.stepfun.ai
  //    rates: 3.7-flash $0.20/$0.04(cache hit)/$1.15 per MTok in/read/out,
  //    3.5-flash $0.10/$0.02/$0.30. No cache-write surcharge published, so
  //    cache_write = input. ──
  "step-3.7-flash": { input: 0.2, output: 1.15, cache_read: 0.04, cache_write: 0.2 },
  "step-3.5-flash": { input: 0.1, output: 0.3, cache_read: 0.02, cache_write: 0.1 },
  // ── Alibaba Qwen3.8 (mirrored from src/lib/pricing/curated-overrides.json).
  //    Official rates per MTok in/read/write/out: Flash $0.15/$0.016/$0.20/
  //    $0.47, Max $2/$0.25/$2.50/$6 (verified 2026-09-05). LiteLLM carries
  //    together_ai/Qwen/Qwen3.8-Flash without cache fields and
  //    dashscope/qwen3.8-max without cache-write, so cache-heavy rows
  //    undercounted ~48x until these were pinned. ──
  "qwen3.8-flash": { input: 0.15, output: 0.47, cache_read: 0.016, cache_write: 0.2 },
  "qwen3.8-max": { input: 2, output: 6, cache_read: 0.25, cache_write: 2.5 },
};
const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

function getModelPricing(model: string) {
  if (!model) return ZERO_PRICING;
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  if (lower.includes("fable")) return MODEL_PRICING["claude-fable-5"];
  // Opus 5 fast mode bills at 2x the standard Opus tier ($10/$50), so the
  // -fast matcher must precede both the opus-5 and the generic opus fallback.
  if (lower.includes("opus-5-fast")) return MODEL_PRICING["claude-opus-5-fast"];
  if (lower.includes("opus-5")) return MODEL_PRICING["claude-opus-5"];
  if (lower.includes("opus")) return MODEL_PRICING["claude-opus-4-6"];
  if (lower.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5-20251001"];
  if (lower.includes("sonnet")) return MODEL_PRICING["claude-sonnet-4-6"];
  // gpt-5.6 tiers: sol/terra/luna carry reasoning-effort suffixes (solhigh,
  // etc.), so match by substring. Specific tiers precede the generic gpt-5.6
  // fallback (the public gpt-5.6 alias points to the flagship sol tier).
  if (lower.includes("gpt-5.6-sol")) return MODEL_PRICING["gpt-5.6-sol"];
  if (lower.includes("gpt-5.6-terra")) return MODEL_PRICING["gpt-5.6-terra"];
  if (lower.includes("gpt-5.6-luna")) return MODEL_PRICING["gpt-5.6-luna"];
  if (lower.includes("gpt-5.6")) return MODEL_PRICING["gpt-5.6-sol"];
  if (lower.includes("gpt-5.4-pro")) return MODEL_PRICING["gpt-5.4-pro"];
  if (lower.includes("gpt-5.4")) return MODEL_PRICING["gpt-5.4"];
  if (lower.includes("gpt-5.5")) return MODEL_PRICING["gpt-5.5"];
  if (lower.includes("gpt-5-mini")) return MODEL_PRICING["gpt-5-mini"];
  if (lower.includes("gpt-5.3")) return MODEL_PRICING["gpt-5.3-codex"];
  if (lower.includes("gpt-5.2")) return MODEL_PRICING["gpt-5.2"];
  // -codex-mini variants (e.g. gpt-5.1-codex-mini-high) must resolve before
  // the broader gpt-5.1 matcher — the base codex rate is 5x the mini rate.
  if (lower.includes("gpt-5.1-codex-mini")) return MODEL_PRICING["gpt-5.1-codex-mini"];
  if (lower.includes("gpt-5.1")) return MODEL_PRICING["gpt-5.1-codex"];
  if (lower.includes("gpt-5")) return MODEL_PRICING["gpt-5"];
  // gemini-3 pro tiers (gemini-3-pro, gemini-3.1-pro, -high, -customtools…)
  // must not fall through to the flash rate (4x undercount).
  if (lower.includes("gemini-3") && lower.includes("pro")) return MODEL_PRICING["gemini-3-pro-preview"];
  if (lower.includes("gemini-3")) return MODEL_PRICING["gemini-3-flash-preview"];
  if (lower.includes("gemini-2.5")) return MODEL_PRICING["gemini-2.5-pro"];
  if (lower.includes("minimax-m3")) return MODEL_PRICING["minimax-m3"];
  if (lower.includes("minimax-m2.7-highspeed")) return MODEL_PRICING["MiniMax-M2.7-highspeed"];
  if (lower.includes("minimax-m2.7")) return MODEL_PRICING["MiniMax-M2.7"];
  if (lower.includes("deepseek-v4-flash")) return MODEL_PRICING["deepseek-v4-flash"];
  if (lower.includes("deepseek-v4-pro")) return MODEL_PRICING["deepseek-v4-pro"];
  if (lower.includes("deepseek-reasoner")) return MODEL_PRICING["deepseek-reasoner"];
  if (lower.includes("deepseek-chat")) return MODEL_PRICING["deepseek-chat"];
  if (lower.includes("grok-4.5") && lower.includes("fast")) return MODEL_PRICING["cursor-grok-4.5-fast"];
  if (lower.includes("grok-4.5")) return MODEL_PRICING["cursor-grok-4.5"];
  if (lower.includes("grok-build")) return MODEL_PRICING["grok-build"];
  if (lower.includes("grok-4-fast")) return MODEL_PRICING["grok-4-fast"];
  // grok-4-1-fast-* must precede the generic grok-4 matcher. Cloud rows may
  // carry a provider prefix or `-latest` suffix (e.g. xai/grok-4-1-fast-
  // non-reasoning-latest), and the substring "grok-4-fast" does NOT match
  // "grok-4-1-fast" (the "-1-" separates them). Without this specific match
  // these rows fall through to grok-4 and get billed at $3/$15 MTok instead
  // of the $0.20/$0.50 MTok fast-tier rate (15x / 30x overestimate).
  if (lower.includes("grok-4-1-fast")) return MODEL_PRICING["grok-4-1-fast-non-reasoning"];
  if (lower.includes("grok-4")) return MODEL_PRICING["grok-4"];
  if (lower.includes("kimi-k3")) return MODEL_PRICING["kimi-k3"];
  // Bare "k3" alias from Kimi Code (or provider-prefixed "*/k3"); the exact
  // key above only catches the unprefixed form.
  if (lower === "k3" || lower.endsWith("/k3")) return MODEL_PRICING["kimi-k3"];
  if (lower.includes("kimi-k2.7-code")) return MODEL_PRICING["kimi-k2.7-code"];
  if (lower.includes("kimi-k2.6")) return MODEL_PRICING["kimi-k2.6"];
  if (lower.includes("kimi")) return MODEL_PRICING["kimi-k2.5"];
  // MiMo ordering: more specific suffixes first (mimo-v2.5-pro before
  // mimo-v2.5 which is a substring; the free tier is a distinct name).
  if (lower.includes("mimo-v2-pro-free")) return MODEL_PRICING["mimo-v2-pro-free"];
  if (lower.includes("mimo-v2.5-pro")) return MODEL_PRICING["mimo-v2.5-pro"];
  if (lower.includes("mimo-v2.5")) return MODEL_PRICING["mimo-v2.5"];
  if (lower.includes("mimo-v2-flash")) return MODEL_PRICING["mimo-v2-flash"];
  // GLM ordering: more specific suffixes (-airx/-air/-x/-flash/-flashx/-turbo)
  // must precede the base matchers. glm-5.1 must precede glm-5 (substring).
  if (lower.includes("glm-4.5-airx")) return MODEL_PRICING["glm-4.5-airx"];
  if (lower.includes("glm-4.5-air")) return MODEL_PRICING["glm-4.5-air"];
  if (lower.includes("glm-4.5-x")) return MODEL_PRICING["glm-4.5-x"];
  if (lower.includes("glm-4.5-flash")) return MODEL_PRICING["glm-4.5-flash"];
  if (lower.includes("glm-4.5")) return MODEL_PRICING["glm-4.5"];
  if (lower.includes("glm-4.7-flashx")) return MODEL_PRICING["glm-4.7-flashx"];
  if (lower.includes("glm-4.7-flash")) return MODEL_PRICING["glm-4.7-flash"];
  if (lower.includes("glm-4.7")) return MODEL_PRICING["glm-4.7"];
  if (lower.includes("glm-4.6")) return MODEL_PRICING["glm-4.6"];
  if (lower.includes("glm-5.3-flash")) return MODEL_PRICING["glm-5.3-flash"];
  if (lower.includes("glm-5.3")) return MODEL_PRICING["glm-5.3"];
  if (lower.includes("glm-5-turbo")) return MODEL_PRICING["glm-5-turbo"];
  if (lower.includes("glm-5.2")) return MODEL_PRICING["glm-5.2"];
  if (lower.includes("glm-5.1")) return MODEL_PRICING["glm-5.1"];
  if (lower.includes("glm-5")) return MODEL_PRICING["glm-5"];
  if (lower.includes("kiro")) return MODEL_PRICING["kiro-cli-agent"];
  if (lower.includes("hy3")) return MODEL_PRICING["hy3-preview-agent"];
  if (lower.includes("composer")) return MODEL_PRICING["composer-1"];
  if (lower.includes("fugu")) return MODEL_PRICING["sakana/fugu-ultra"];
  if (lower.includes("longcat")) return MODEL_PRICING["longcat-2.0"];
  // StepFun ordering: dated snapshots (step-3.5-flash-2603) hit the specific
  // matchers; bare "stepfun" (e.g. openrouter stepfun/…) falls back to 3.7.
  if (lower.includes("step-3.7-flash")) return MODEL_PRICING["step-3.7-flash"];
  if (lower.includes("step-3.5-flash")) return MODEL_PRICING["step-3.5-flash"];
  if (lower.includes("stepfun")) return MODEL_PRICING["step-3.7-flash"];
  // Qwen3.8 ordering: Flash and Max are distinct SKUs; neither needle is a
  // substring of the other, so flash-first mirrors the cheap-SKU-first GLM
  // convention without changing behaviour. Catches cased/dated variants like
  // "Qwen3.8-Flash" that miss the exact table key.
  if (lower.includes("qwen3.8-flash")) return MODEL_PRICING["qwen3.8-flash"];
  if (lower.includes("qwen3.8-max")) return MODEL_PRICING["qwen3.8-max"];
  if (lower === "auto") return MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}

function getRowPricing(row: { model?: string; hour_start?: string; pricing_tier?: string }) {
  const pricing = getModelPricing(row.model || "");
  const lower = String(row.model || "").toLowerCase();
  if (!lower.includes("deepseek-v4-flash") && !lower.includes("deepseek-v4-pro")) return pricing;
  let offPeak = row.pricing_tier === "off_peak";
  if (!row.pricing_tier && row.hour_start) {
    const timestamp = Date.parse(row.hour_start);
    if (Number.isFinite(timestamp)) {
      const hour = new Date(timestamp).getUTCHours();
      offPeak = !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
      // From 00:00 Beijing time on 2026-08-23 (2026-08-22T16:00Z) DeepSeek bills
      // whole Beijing weekends off-peak, peak hours included. That weekend runs
      // 16:00Z Friday to 16:00Z Sunday, so the +08:00 shift before getUTCDay()
      // is what puts both edges in the right place; reading the weekday off the
      // raw instant marks a different 48 hours. China has had no daylight saving
      // since 1991. https://api-docs.deepseek.com/quick_start/pricing/
      if (timestamp >= Date.UTC(2026, 7, 22, 16, 0, 0)) {
        const beijingDay = new Date(timestamp + 8 * 60 * 60 * 1000).getUTCDay();
        if (beijingDay === 0 || beijingDay === 6) offPeak = true;
      }
    }
  }
  if (!offPeak) return pricing;
  return { input: pricing.input * 0.5, output: pricing.output * 0.5, cache_read: pricing.cache_read * 0.5, cache_write: (pricing.cache_write || 0) * 0.5 };
}


interface HourlyRow {
  hour_start: string;
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  conversations: number | null;
}

interface GroupedRow {
  bucket: string;
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_cost_usd?: number | null;
  conversations: number | null;
  pricing_tier?: string;
}

const GROUPED_ROWS_TTL_MS = 30_000;
const GROUPED_ROWS_STALE_IF_ERROR_MS = 5 * 60_000;
const groupedRowsCache = new Map<string, { fetchedAt: number; rows: GroupedRow[] }>();
const groupedRowsInFlight = new Map<string, Promise<GroupedRow[]>>();

/**
 * Server-side aggregation. One RPC replaces the old N paginated 1000-row raw
 * fetches: account_usage_grouped() GROUPs BY (tz-local bucket, source, model)
 * in Postgres and returns a single JSONB array. SUM across the user's active
 * devices is byte-identical to the old in-edge aggregation; tz-local bucketing
 * uses `AT TIME ZONE` (same IANA database as the old JS Intl path, incl. DST).
 */
async function fetchGroupedRows(
  client: ReturnType<typeof createClient>,
  userId: string,
  requestedDeviceId: string | null,
  fromIso: string,
  toIso: string,
  trunc: "hour" | "day" | "month" | "none",
  tz: string | null,
  tzOffsetMinutes: number | null,
): Promise<GroupedRow[]> {
  const cacheKey = JSON.stringify([userId, requestedDeviceId, fromIso, toIso, trunc, tz, tzOffsetMinutes]);
  const cached = groupedRowsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < GROUPED_ROWS_TTL_MS) return cached.rows;
  const existing = groupedRowsInFlight.get(cacheKey);
  if (existing) return existing;

  const pending = (async () => {
    try {
      const { data, error } = await client.database.rpc("account_usage_grouped_cached", {
        p_user_id: userId,
        p_device_id: requestedDeviceId,
        p_from: fromIso,
        p_to: toIso,
        p_trunc: trunc,
        p_tz: tz,
        p_offset_min: tzOffsetMinutes,
      });
      if (error) throw new Error(error.message);
      const rows = (Array.isArray(data) ? data : []) as GroupedRow[];
      groupedRowsCache.set(cacheKey, { fetchedAt: Date.now(), rows });
      if (groupedRowsCache.size > 64) {
        const oldest = groupedRowsCache.keys().next().value;
        if (oldest) groupedRowsCache.delete(oldest);
      }
      return rows;
    } catch (error) {
      const stale = groupedRowsCache.get(cacheKey);
      if (stale && Date.now() - stale.fetchedAt < GROUPED_ROWS_STALE_IF_ERROR_MS) return stale.rows;
      throw error;
    }
  })().finally(() => groupedRowsInFlight.delete(cacheKey));
  groupedRowsInFlight.set(cacheKey, pending);
  return pending;
}

function computeRowCost(row: GroupedRow): number {
  // LM Studio developer-server and LM Link traffic is local inference. Its
  // logs do not represent Bionic Secure Cloud billing.
  if (row.source === "lmstudio") return 0;
  // Pi's GitHub Copilot provider is subscription-backed. Keep its token
  // counts, but do not reprice the recorded Claude model as Anthropic API use.
  if (row.source === "pi-github-copilot" || row.source === "pi-copilot") return 0;
  const reportedCost = Number(row.total_cost_usd);
  if (
    SOURCES_WITH_AUTHORITATIVE_COST.has(row.source) &&
    Number.isFinite(reportedCost) &&
    reportedCost > 0
  ) return reportedCost;
  // WorkBuddy's auto-router logs model="auto"; price it as its default Hunyuan
  // model (hy3-preview-agent) so it isn't billed as Cursor's composer-1. Mirrors
  // normalizeWorkbuddyModel in src/lib/pricing/matcher.js.
  const rawModel = String(row.model || "").trim();
  const unslothUnpriced =
    row.source === "unsloth" && /^(local|unpriced)\//i.test(rawModel);
  const modelForPricing = unslothUnpriced
    ? "__tokentracker_unpriced_unsloth_model__"
    : row.source === "workbuddy" && rawModel.toLowerCase() === "auto"
      ? "hy3-preview-agent"
      : rawModel;
  const p = getRowPricing({ ...row, model: modelForPricing });
  // Codex / every-code fold reasoning into output_tokens (OpenAI convention),
  // so charging reasoning_output_tokens again at the output rate double-counts.
  // Must stay in lockstep with src/lib/pricing/index.js:computeRowCost and
  // tokentracker-leaderboard-refresh.ts (both guard on source).
  const reasoningCost =
    row.source === "codex" || row.source === "every-code"
      ? 0
      : (Number(row.reasoning_output_tokens) || 0) * (p.output || 0);
  return (
    ((Number(row.input_tokens) || 0) * (p.input || 0) +
      (Number(row.output_tokens) || 0) * (p.output || 0) +
      (Number(row.cached_input_tokens) || 0) * (p.cache_read || 0) +
      (Number(row.cache_creation_input_tokens) || 0) * ((p.cache_write ?? 0)) +
      reasoningCost) /
    1_000_000
  );
}

interface DayAgg {
  day: string;
  total_tokens: number;
  billable_total_tokens: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  conversation_count: number;
}

function aggregateByDay(rows: GroupedRow[]): DayAgg[] {
  const byDay = new Map<string, DayAgg>();
  for (const row of rows) {
    const day = row.bucket;
    let a = byDay.get(day);
    if (!a) {
      a = {
        day,
        total_tokens: 0,
        billable_total_tokens: 0,
        total_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
      };
      byDay.set(day, a);
    }
    const tt = Number(row.total_tokens) || 0;
    a.total_tokens += tt;
    a.billable_total_tokens += tt;
    a.total_cost_usd += computeRowCost(row);
    a.input_tokens += Number(row.input_tokens) || 0;
    a.output_tokens += Number(row.output_tokens) || 0;
    a.cached_input_tokens += Number(row.cached_input_tokens) || 0;
    a.cache_creation_input_tokens += Number(row.cache_creation_input_tokens) || 0;
    a.reasoning_output_tokens += Number(row.reasoning_output_tokens) || 0;
    a.conversation_count += Number(row.conversations) || 0;
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  let from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!from || !to) return json({ error: "Missing from/to" }, 400);
  // Bound the span: every distinct range is a cold fill for the shared PG
  // cache and a full-history scan, so arbitrary from/to must not be accepted
  // verbatim. 3 years covers every real "total" view for years to come.
  const MAX_RANGE_DAYS = 1095;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
    const maxFromMs = toMs - MAX_RANGE_DAYS * 86_400_000;
    if (fromMs < maxFromMs) from = new Date(maxFromMs).toISOString().slice(0, 10);
  }
  const tz = url.searchParams.get("tz") || null;
  const tzOffsetRaw = url.searchParams.get("tz_offset_minutes");
  const tzOffsetMinutes = tzOffsetRaw != null && tzOffsetRaw !== "" ? Number(tzOffsetRaw) : null;

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const userId = await verifiedUserIdFromJwt(req.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  // The v2 RPC resolves and validates device ownership in the same database
  // statement as aggregation, avoiding a second PostgREST connection.
  const rawDeviceId = url.searchParams.get("device_id");
  const requestedDeviceId = rawDeviceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawDeviceId)
    ? rawDeviceId
    : null;

  // Range for requested [from, to]; widen ±1 day to capture TZ-shifted
  // edge hours for non-UTC callers.
  const startDate = new Date(`${from}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 1);
  const nextDay = new Date(`${to}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 2);
  const rangeStart = startDate.toISOString();
  const rangeEnd = nextDay.toISOString();

  // Anchor rolling windows to the caller's local "today" (matches daily
  // buckets which are keyed by local day via zonedDayKey).
  const todayStr = zonedDayKey(new Date().toISOString(), tz, tzOffsetMinutes);
  const todayUtcMidnight = new Date(`${todayStr}T00:00:00Z`);
  const thirtyAgo = new Date(todayUtcMidnight);
  thirtyAgo.setUTCDate(thirtyAgo.getUTCDate() - 29);
  const thirtyAgoStr = thirtyAgo.toISOString().slice(0, 10);
  // Widen ±1 UTC day around the local-day boundary for query safety.
  const rollingStartDate = new Date(`${(thirtyAgoStr < from ? thirtyAgoStr : from)}T00:00:00Z`);
  rollingStartDate.setUTCDate(rollingStartDate.getUTCDate() - 1);
  const rollingEndDate = new Date(todayUtcMidnight);
  rollingEndDate.setUTCDate(rollingEndDate.getUTCDate() + 2);
  const rollingStart = rollingStartDate.toISOString();
  const rollingEndNext = rollingEndDate;

  let allRows: GroupedRow[];
  try {
    allRows = await fetchGroupedRows(client, userId, requestedDeviceId, rollingStart, rollingEndNext.toISOString(), "day", tz, tzOffsetMinutes);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }

  const allDaily = aggregateByDay(allRows);
  const daily = allDaily.filter((d) => d.day >= from && d.day <= to);

  const totals = daily.reduce(
    (acc, r) => {
      acc.total_tokens += r.total_tokens;
      acc.billable_total_tokens += r.billable_total_tokens;
      acc.total_cost_usd += r.total_cost_usd || 0;
      acc.input_tokens += r.input_tokens;
      acc.output_tokens += r.output_tokens;
      acc.cached_input_tokens += r.cached_input_tokens;
      acc.cache_creation_input_tokens += r.cache_creation_input_tokens;
      acc.reasoning_output_tokens += r.reasoning_output_tokens;
      acc.conversation_count += r.conversation_count;
      return acc;
    },
    {
      total_tokens: 0,
      billable_total_tokens: 0,
      total_cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      conversation_count: 0,
    },
  );
  const totalCost = totals.total_cost_usd;

  const collectDays = (n: number) => {
    const out: DayAgg[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(todayUtcMidnight);
      d.setUTCDate(d.getUTCDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const dd = allDaily.find((x) => x.day === ds);
      if (dd) out.push(dd);
    }
    return out;
  };
  const sumDays = (days: DayAgg[]) =>
    days.reduce(
      (a, r) => {
        a.billable_total_tokens += r.billable_total_tokens;
        a.conversation_count += r.conversation_count;
        return a;
      },
      { billable_total_tokens: 0, conversation_count: 0 },
    );

  const l7 = collectDays(7);
  const l30 = collectDays(30);
  const l7t = sumDays(l7);
  const l30t = sumDays(l30);
  const l7from = new Date(todayUtcMidnight);
  l7from.setUTCDate(l7from.getUTCDate() - 6);
  const l30from = new Date(todayUtcMidnight);
  l30from.setUTCDate(l30from.getUTCDate() - 29);

  return json({
    from,
    to,
    days: daily.length,
    totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
    rolling: {
      last_7d: {
        from: l7from.toISOString().slice(0, 10),
        to: todayStr,
        active_days: l7.length,
        totals: l7t,
      },
      last_30d: {
        from: l30from.toISOString().slice(0, 10),
        to: todayStr,
        active_days: l30.length,
        totals: l30t,
        avg_per_active_day:
          l30.length > 0 ? Math.round(l30t.billable_total_tokens / l30.length) : 0,
      },
    },
  });
}
