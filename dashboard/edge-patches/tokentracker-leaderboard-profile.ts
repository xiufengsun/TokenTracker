/**
 * Tokentracker leaderboard profile (DETAIL).
 *
 * Aggregates a single user's hourly rows into a rich profile payload used by
 * the in-page profile modal: hero totals, streak, best day, model favorites,
 * per-provider breakdown, 365-day activity heatmap and a period-scoped daily
 * trend.
 *
 * Previous implementation returned the existing snapshot row. The modal
 * needs time-series data the snapshot table doesn't carry, so the usage rows
 * come from the shared `account_usage_grouped(_cached)` RPC: Postgres does the
 * two-class cross-device aggregation at DAY grain (the modal only aggregates
 * by day), and repeat modal opens hit the shared 30s cache instead of
 * re-walking up to 60 pages of raw hourly rows per view.
 *
 * Pricing tables are inline-mirrored from `tokentracker-leaderboard-refresh.ts`
 * to keep `getModelPricing` / `computeRowCost` byte-for-byte aligned across
 * cloud aggregators. Memory: feedback_model_pricing_sync — every edit here
 * MUST be mirrored to refresh.ts and src/lib/local-api.js.
 */
import { createClient } from "npm:@insforge/sdk";

const SOURCES_WITH_AUTHORITATIVE_COST = new Set(["grok"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
};
const BLOCKED_LEADERBOARD_USER_IDS = new Set(
  (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function verifyCallerUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
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
    const payloadStr = new TextDecoder().decode(b64urlToBytes(parts[1]));
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

function getClient() {
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  return createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    edgeFunctionToken: serviceRoleKey,
    anonKey: anonKey ?? undefined,
    isServerMode: true,
  });
}

// ─────────────────────────── Pricing (mirror from refresh.ts) ──────────────────────────
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
  // Three durable capability tiers: sol (flagship) / terra (balanced default) /
  // luna (lightweight). Codex reports the tier in the model id (gpt-5.6-sol,
  // + reasoning-effort variants like gpt-5.6-solhigh). Not yet in LiteLLM.
  "gpt-5.6-sol": { input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 },
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
};
const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
// iFlytek MaaS prices used by the AStudio source: RMB per million tokens,
// converted at 7.2 RMB/USD and rounded to two decimal places. Models without a cache-hit
// price use the regular input price; cache writes use the regular input price as well.
// AStudio homepage: https://agent.xfyun.cn/
// Official pricing source: https://maas.xfyun.cn/modelSquare
const IFLYTEK_MAAS_MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write?: number }> = {
  "xopglm53": { input: 1.11, output: 3.89, cache_read: 0.28, cache_write: 1.11 },
  "xopdeepseekv4pro0813": { input: 1.25, output: 3.75, cache_read: 0.04, cache_write: 1.25 },
  "xopdeepseekv4flash0731": { input: 0.14, output: 0.28, cache_read: 0.03, cache_write: 0.14 },
  "xopkimik27code": { input: 0.90, output: 3.75, cache_read: 0.90, cache_write: 0.90 },
  "xopglm52": { input: 1.11, output: 3.89, cache_read: 0.28, cache_write: 1.11 },
  "xopdeepseekv4flash": { input: 0.14, output: 0.28, cache_read: 0.03, cache_write: 0.14 },
  "xopkimik26": { input: 0.90, output: 3.75, cache_read: 0.18, cache_write: 0.90 },
  "xopdeepseekv4pro": { input: 1.67, output: 3.33, cache_read: 0.14, cache_write: 1.67 },
  "xopqwen36v35b": { input: 0.15, output: 0.90, cache_read: 0.15, cache_write: 0.15 },
  "xophunyuan7bmt": { input: 0.07, output: 0.28, cache_read: 0.07, cache_write: 0.07 },
  "xoppaddleocrv16": { input: 0.00, output: 0.00, cache_read: 0.00, cache_write: 0.00 },
  "xsparkx2flash": { input: 0.14, output: 0.28, cache_read: 0.14, cache_write: 0.14 },
  "xopglm51": { input: 1.11, output: 3.89, cache_read: 0.22, cache_write: 1.11 },
  "xsparkx2": { input: 0.42, output: 0.42, cache_read: 0.42, cache_write: 0.42 },
  "xop35qwen2b": { input: 0.03, output: 0.06, cache_read: 0.03, cache_write: 0.03 },
  "xopqwen35397b": { input: 0.17, output: 1.00, cache_read: 0.17, cache_write: 0.17 },
  "xminimaxm25": { input: 0.29, output: 1.17, cache_read: 0.29, cache_write: 0.29 },
  "xopglm5": { input: 0.83, output: 3.06, cache_read: 0.17, cache_write: 0.83 },
  "xopkimik25": { input: 0.56, output: 2.92, cache_read: 0.56, cache_write: 0.56 },
  "xopdeepseekv32": { input: 0.14, output: 0.21, cache_read: 0.14, cache_write: 0.14 },
  "xop3qwencodernext": { input: 0.35, output: 1.39, cache_read: 0.35, cache_write: 0.35 },
  "xopglmv47flash": { input: 0.14, output: 0.21, cache_read: 0.14, cache_write: 0.14 },
  "xopglm47blth2": { input: 0.56, output: 2.22, cache_read: 0.56, cache_write: 0.56 },
  "xop3qwen32bvl": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "xopdeepseekocr": { input: 0.00, output: 0.00, cache_read: 0.00, cache_write: 0.00 },
  "xophunyuanocr": { input: 0.00, output: 0.00, cache_read: 0.00, cache_write: 0.00 },
  "xop3qwen80bnext": { input: 0.08, output: 0.33, cache_read: 0.08, cache_write: 0.08 },
  "xop3qwen235b2507": { input: 0.17, output: 1.67, cache_read: 0.17, cache_write: 0.17 },
  "xop3qwen30b2507": { input: 0.06, output: 0.63, cache_read: 0.06, cache_write: 0.06 },
  "xop3qwen235b": { input: 0.17, output: 1.67, cache_read: 0.17, cache_write: 0.17 },
  "xop3qwen30b": { input: 0.06, output: 0.63, cache_read: 0.06, cache_write: 0.06 },
  "xop3qwen32b": { input: 0.17, output: 1.67, cache_read: 0.17, cache_write: 0.17 },
  "xdeepseekv3": { input: 0.22, output: 0.89, cache_read: 0.22, cache_write: 0.22 },
  "xdeepseekr1": { input: 0.44, output: 1.78, cache_read: 0.44, cache_write: 0.44 },
  "xdeepseekr1qwen32b": { input: 0.22, output: 0.67, cache_read: 0.22, cache_write: 0.22 },
  "xopkimik2blth": { input: 0.56, output: 2.22, cache_read: 0.56, cache_write: 0.56 },
  "xopkimik2blins": { input: 0.56, output: 2.22, cache_read: 0.56, cache_write: 0.56 },
  "xop3qwen8breranker": { input: 0.00, output: 0.00, cache_read: 0.00, cache_write: 0.00 },
  "xop3qwen8bembedding": { input: 0.00, output: 0.00, cache_read: 0.00, cache_write: 0.00 },
  "xop3qwen0b6": { input: 0.04, output: 0.42, cache_read: 0.04, cache_write: 0.04 },
  "xop3qwen4b": { input: 0.04, output: 0.42, cache_read: 0.04, cache_write: 0.04 },
  "xqwen257bchat": { input: 0.07, output: 0.14, cache_read: 0.07, cache_write: 0.07 },
  "xop3qwen14b": { input: 0.14, output: 1.39, cache_read: 0.14, cache_write: 0.14 },
  "xop3qwen8b": { input: 0.07, output: 0.69, cache_read: 0.07, cache_write: 0.07 },
  "xsparkprox": { input: 1.11, output: 5.56, cache_read: 1.11, cache_write: 1.11 },
  "xspark13b6k": { input: 0.28, output: 0.83, cache_read: 0.28, cache_write: 0.28 },
  "spark mini": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "spark mini instruct": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "spark tiny": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "internlm2.5_7b_chat": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "internlm2.5_1.8b_chat": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "qwen_v2.5_7b_base": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "xsqwen2d53b": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "qwen_v2.5_3b_base": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "qwen_v2.5_1.5b_instruct": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "qwen_v2.5_1.5b_base": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "qwen_v2.5_0.5b_instruct": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "qwen_v2.5_0.5b_base": { input: 0.28, output: 1.11, cache_read: 0.28, cache_write: 0.28 },
  "xsqwenv2s1b5c": { input: 0.14, output: 0.28, cache_read: 0.14, cache_write: 0.14 },
  "xsqwenv2s0b5c": { input: 0.28, output: 0.56, cache_read: 0.28, cache_write: 0.28 },
  "xqwen14bchat": { input: 0.28, output: 0.83, cache_read: 0.28, cache_write: 0.28 },
};
function normalizeIFlytekMaasModel(model: string) {
  const lower = model.trim().toLowerCase();
  if (lower === "auto" || lower.endsWith("-auto")) return "xopglm53";
  if (lower === "xsparkx2agent") return "xsparkx2";
  return lower;
}

function getModelPricing(model: string, source = "") {
  if (!model) return ZERO_PRICING;
  if (source.toLowerCase() === "acode") {
    const iFlytekMaasPricing = IFLYTEK_MAAS_MODEL_PRICING[normalizeIFlytekMaasModel(model)];
    if (iFlytekMaasPricing) return iFlytekMaasPricing;
  }
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
  // fallback (which defaults to the balanced terra tier).
  if (lower.includes("gpt-5.6-sol")) return MODEL_PRICING["gpt-5.6-sol"];
  if (lower.includes("gpt-5.6-terra")) return MODEL_PRICING["gpt-5.6-terra"];
  if (lower.includes("gpt-5.6-luna")) return MODEL_PRICING["gpt-5.6-luna"];
  if (lower.includes("gpt-5.6")) return MODEL_PRICING["gpt-5.6-terra"];
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
  if (lower === "auto") return MODEL_PRICING["composer-1"];
  return ZERO_PRICING;
}

function getRowPricing(row: { model?: string; source?: string; hour_start?: string; pricing_tier?: string }) {
  const pricing = getModelPricing(row.model || "", row.source);
  if ((row.source || "").toLowerCase() === "acode") return pricing;
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

interface UsageRow {
  source: string;
  model: string;
  total_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_cost_usd?: number | null;
  pricing_tier?: string;
}

// One row per (UTC day, source, model) as returned by account_usage_grouped
// with p_trunc="day" and no tz override.
interface GroupedRow extends UsageRow {
  bucket: string;
}

function computeRowCost(row: UsageRow): number {
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
  const reasoningIncludedInOutput =
    row.source === "codex" || row.source === "acode" || row.source === "every-code";
  const reasoningCost = reasoningIncludedInOutput
    ? 0
    : (row.reasoning_output_tokens || 0) * (p.output || 0);
  return (
    ((row.input_tokens || 0) * (p.input || 0) +
      (row.output_tokens || 0) * (p.output || 0) +
      (row.cached_input_tokens || 0) * (p.cache_read || 0) +
      (row.cache_creation_input_tokens || 0) * (p.cache_write || 0) +
      reasoningCost) /
    1_000_000
  );
}

/** Map raw `source` to the canonical bucket used by the modal's by_provider list. */
const KNOWN_SOURCES = new Set([
  "acode", "codex", "claude", "gemini", "cursor", "opencode", "openclaw",
  "hermes", "kiro", "copilot", "pi-anthropic", "pi-github-copilot",
  "pi-copilot", "kimi", "droid",
]);
function canonicalSource(s: string) {
  return KNOWN_SOURCES.has(s) ? s : "other";
}

// Account-level sources (data from a per-ACCOUNT cloud API, e.g. Cursor's usage
// CSV — NOT machine-local logs) are stored IDENTICALLY on every device that
// synced them, so they must be DEDUPED across devices, not summed. Machine-level
// sources are real independent per-machine work and SUM across active devices.
// The dedup itself now runs inside the account_usage_grouped RPC; this constant
// remains as the parity anchor checked against src/lib/source-metadata.js, the
// RPC, and tokentracker-leaderboard-refresh.ts
// (parity: test/account-source-parity.test.js).
// deno-lint-ignore no-unused-vars
const ACCOUNT_LEVEL_SOURCES = new Set<string>(["cursor", "trae-cn"]);

// ─────────────────────────── Window bounds ──────────────────────────
function normalizeTimeZone(value: string | null): string | null {
  const timeZone = value?.trim();
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return null;
  }
}

function normalizeTimeZoneOffset(value: string | null): number | null {
  if (value == null || value === "") return null;
  const offset = Number(value);
  if (!Number.isFinite(offset) || Math.abs(offset) > 14 * 60) return null;
  return Math.trunc(offset);
}

function zonedDayKey(date: Date, timeZone: string | null, offsetMinutes: number | null): string {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  }
  const shifted = offsetMinutes == null
    ? date
    : new Date(date.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function addCalendarDays(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function windowBoundsForPeriod(period: string, todayDay: string): { from_day: string; to_day: string } {
  const now = new Date(`${todayDay}T00:00:00Z`);
  if (period === "week") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) /* ISO Mon-start, matches leaderboard-refresh+dashboard */;
    const from = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 6);
    return { from_day: from, to_day: d.toISOString().slice(0, 10) };
  }
  if (period === "month") {
    const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    return { from_day: from, to_day: to };
  }
  // total: use heatmap range (365 days) — caller uses this same bound for trend
  const heatmapStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  heatmapStart.setUTCDate(heatmapStart.getUTCDate() - 364);
  return {
    from_day: heatmapStart.toISOString().slice(0, 10),
    to_day: todayDay,
  };
}

/** Compute current & longest consecutive-day streaks within a date set. */
function computeStreak(daysWithActivity: Set<string>, todayDay: string): { current_days: number; longest_days: number } {
  const todayUTC = new Date(`${todayDay}T00:00:00Z`);
  // Current: start from today; if today has nothing, allow yesterday as starting point.
  let cursor = new Date(todayUTC);
  let current = 0;
  if (!daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (daysWithActivity.has(cursor.toISOString().slice(0, 10))) {
    current += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  // Longest: walk all days chronologically.
  const sorted = Array.from(daysWithActivity).sort();
  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const d of sorted) {
    const dt = new Date(d + "T00:00:00Z");
    if (prev && dt.getTime() - prev.getTime() === 86_400_000) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
    prev = dt;
  }
  return { current_days: current, longest_days: longest };
}

// ─────────────────────────── Main handler ──────────────────────────
// deno-lint-ignore no-explicit-any
async function fetchDailyGroupedRows(
  client: any,
  userId: string,
  rangeStartIso: string,
  rangeEndIso: string,
  timeZone: string | null,
  timeZoneOffsetMinutes: number | null,
): Promise<GroupedRow[]> {
  // The two-class cross-device aggregation runs in Postgres
  // (account_usage_grouped), matching tokentracker-leaderboard-refresh.ts:
  //   * ACCOUNT-LEVEL sources (cursor, trae-cn): ONE canonical whole row
  //     per (bucket, source, model), across ALL devices (device-independent).
  //   * MACHINE-LEVEL sources: summed across the user's ACTIVE devices
  //     (revoked_at IS NULL), dropping historic device churn.
  // Day grain is enough — the modal only aggregates by day. The cached
  // variant serves repeat modal opens from the shared 30s Postgres cache
  // instead of re-walking raw hourly pages on every view.
  let hasActiveDevice = false;
  {
    const { data: devs, error: dErr } = await client.database
      .from("tokentracker_devices")
      .select("id")
      .eq("user_id", userId)
      .is("revoked_at", null)
      .limit(1);
    if (dErr) throw new Error(dErr.message);
    hasActiveDevice = Array.isArray(devs) && devs.length > 0;
  }

  // account_usage_grouped_v2 (backing the cached variant) short-circuits to
  // [] for users with no active devices — but account-level history (cursor)
  // is device-independent and must still show on their profile. The uncached
  // array variant with an empty id list returns exactly that account branch.
  const common = {
    p_user_id: userId,
    p_from: rangeStartIso,
    p_to: rangeEndIso,
    p_trunc: "day",
    p_tz: timeZone,
    p_offset_min: timeZoneOffsetMinutes,
  };
  const { data, error } = hasActiveDevice
    ? await client.database.rpc("account_usage_grouped_cached", { ...common, p_device_id: null })
    : await client.database.rpc("account_usage_grouped", { ...common, p_device_ids: [] });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as GroupedRow[];
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  const periodInput = url.searchParams.get("period") || "week";
  const period = ["week", "month", "total"].includes(periodInput) ? periodInput : "week";
  const timeZone = normalizeTimeZone(url.searchParams.get("tz"));
  const timeZoneOffsetMinutes = normalizeTimeZoneOffset(url.searchParams.get("tz_offset_minutes"));
  const now = new Date();
  const todayDay = zonedDayKey(now, timeZone, timeZoneOffsetMinutes);
  if (!userId) return json({ error: "user_id is required" }, 400);
  if (BLOCKED_LEADERBOARD_USER_IDS.has(userId)) return json({ error: "Not found" }, 404);

  const callerUserId = await verifyCallerUserId(req);
  const isSelf = Boolean(callerUserId && callerUserId === userId);
  const client = getClient();

  // Achievements only need the precomputed badge rows. Keep this authenticated
  // owner-only fast path before every profile/snapshot/hourly query below: the
  // full response scans up to 365 days of raw hourly rows and can take seconds
  // for a heavy user, while user_badges_full is a small indexed lookup.
  if (url.searchParams.get("view") === "badges") {
    if (!isSelf) return json({ error: "Forbidden" }, 403);
    const { data, error } = await client.database.rpc("user_badges_full", {
      p_user_id: userId,
      p_include_unearned: true,
    });
    if (error) return json({ error: error.message || "badge lookup failed" }, 500);
    return json({
      badges: Array.isArray(data) ? data : [],
      badges_include_unearned: true,
    });
  }

  // Privacy gate. Mirror the leaderboard list's exposure policy: if the user
  // already appears in the public snapshot table, their aggregate numbers are
  // visible to anyone scrolling the leaderboard — so the modal should not
  // gate them behind `leaderboard_public`. The `leaderboard_anonymous` flag
  // is enforced separately below by hiding display_name/avatar/github_url.
  // (A `leaderboard_public=true` check would 404 ~60% of listed rows here.)
  if (!isSelf) {
    const { data: snap } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("user_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (!snap) {
      return json({ error: "Not found" }, 404);
    }
  }

  // Hero/identity row: pull display_name + avatar from profile, and
  // anonymous/github flags + url from settings. Badges ride along in the same
  // round-trip: unearned (tier-0 progress) rows are included ONLY for the
  // verified owner. Fail-soft — a badges hiccup must not 500 the profile.
  const [settingsRes, profileRes, badgesRes] = await Promise.all([
    client.database
      .from("tokentracker_user_settings")
      .select("leaderboard_anonymous, github_url, show_github_url")
      .eq("user_id", userId)
      .maybeSingle(),
    client.database
      .from("tokentracker_user_profiles")
      .select("display_name, avatar_url")
      .eq("user_id", userId)
      .maybeSingle(),
    client.database
      .rpc("user_badges_full", { p_user_id: userId, p_include_unearned: isSelf })
      .then(
        (res: { data?: unknown; error?: unknown }) => res,
        () => ({ data: null, error: true }),
      ),
  ]);
  const badges = Array.isArray((badgesRes as { data?: unknown }).data)
    ? ((badgesRes as { data?: unknown }).data as Array<Record<string, unknown>>)
    : [];
  const settings = (settingsRes.data || {}) as {
    leaderboard_anonymous?: boolean;
    github_url?: string | null;
    show_github_url?: boolean;
  };
  const profile = (profileRes.data || {}) as {
    display_name?: string | null;
    avatar_url?: string | null;
  };

  // Rank: read from the period snapshot (the refresh job already computes it).
  // The query is pinned to the CURRENT (from_day, to_day) window — taking the
  // latest generated_at row for the period regardless of window returned the
  // PREVIOUS week/month's rank next to freshly-computed current-window totals
  // right after a window rollover ("Rank #3, 0 tokens").
  const periodBounds = windowBoundsForPeriod(period, todayDay);
  const snapshotBounds = windowBoundsForPeriod(period, now.toISOString().slice(0, 10));
  let snapFromDay = snapshotBounds.from_day;
  let snapToDay = snapshotBounds.to_day;
  if (period === "total") {
    // total snapshots are keyed (1970-01-01, <refresh day>) — mirror the
    // reader (tokentracker-leaderboard.ts) and resolve the latest pair.
    const { data: latestTotal } = await client.database
      .from("tokentracker_leaderboard_snapshots")
      .select("from_day, to_day")
      .eq("period", "total")
      .order("to_day", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lt = latestTotal as { from_day?: string; to_day?: string } | null;
    snapFromDay = (lt?.from_day ?? "1970-01-01").slice(0, 10);
    snapToDay = (lt?.to_day ?? new Date().toISOString()).slice(0, 10);
  }
  const { data: snapRow } = await client.database
    .from("tokentracker_leaderboard_snapshots")
    .select("rank, display_name, avatar_url, generated_at")
    .eq("user_id", userId)
    .eq("period", period)
    .eq("from_day", snapFromDay)
    .eq("to_day", snapToDay)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const snap = (snapRow || null) as { rank?: number | null; display_name?: string | null; avatar_url?: string | null; generated_at?: string | null } | null;

  // Heatmap window: trailing 365 days (always).
  const heatmapEndDay = addCalendarDays(todayDay, 1);
  const heatmapStartDay = addCalendarDays(heatmapEndDay, -365);
  // Period range may be wider than 365d ("total" maps to 365d here); we scan
  // the heatmap window and slice the period window from the same map.
  const periodEndDay = addCalendarDays(periodBounds.to_day, 1);
  const scanStartDay = heatmapStartDay < periodBounds.from_day ? heatmapStartDay : periodBounds.from_day;
  const scanEndDay = heatmapEndDay > periodEndDay ? heatmapEndDay : periodEndDay;
  // Widen one UTC day on both sides so every IANA/offset-shifted local bucket
  // is present before the day-key filters below trim the response.
  const scanStartIso = `${addCalendarDays(scanStartDay, -1)}T00:00:00Z`;
  const scanEndIso = `${addCalendarDays(scanEndDay, 1)}T00:00:00Z`;

  let groupedRows: GroupedRow[];
  try {
    groupedRows = await fetchDailyGroupedRows(
      client,
      userId,
      scanStartIso,
      scanEndIso,
      timeZone,
      timeZoneOffsetMinutes,
    );
  } catch (e) {
    return json({ error: (e as Error).message || "scan failed" }, 500);
  }

  // ── Aggregate into the modal's shape. Two parallel passes:
  //   - period-scoped: totals/by_provider/best_day/favorite_model/active_days/streak/daily_trend
  //   - 365d heatmap: per-day token totals
  const heatmapByDay = new Map<string, number>();
  // Per-day model breakdown for the hover tooltip. Same shape the dashboard
  // ActivityHeatmap consumes (cell.models = { [model_name]: tokens }).
  const heatmapModelsByDay = new Map<string, Map<string, number>>();
  const periodByDay = new Map<string, number>();
  const periodByDayCost = new Map<string, number>();
  const periodByProvider = new Map<string, { tokens: number; cost: number }>();
  const periodByModel = new Map<string, number>();
  let periodTotalTokens = 0;
  let periodTotalCost = 0;

  for (const row of groupedRows) {
    const day = String(row.bucket || "");
    if (!day) continue;
    const tokens = Number(row.total_tokens) || 0;
    const cost = computeRowCost(row);
    if (day >= heatmapStartDay && day < heatmapEndDay) {
      heatmapByDay.set(day, (heatmapByDay.get(day) || 0) + tokens);
      if (row.model && tokens > 0) {
        let dayModels = heatmapModelsByDay.get(day);
        if (!dayModels) {
          dayModels = new Map();
          heatmapModelsByDay.set(day, dayModels);
        }
        dayModels.set(row.model, (dayModels.get(row.model) || 0) + tokens);
      }
    }
    if (day >= periodBounds.from_day && day < periodEndDay) {
      periodByDay.set(day, (periodByDay.get(day) || 0) + tokens);
      periodByDayCost.set(day, (periodByDayCost.get(day) || 0) + cost);
      const src = canonicalSource(row.source);
      const provider = periodByProvider.get(src) || { tokens: 0, cost: 0 };
      provider.tokens += tokens;
      provider.cost += cost;
      periodByProvider.set(src, provider);
      if (row.model) periodByModel.set(row.model, (periodByModel.get(row.model) || 0) + tokens);
      periodTotalTokens += tokens;
      periodTotalCost += cost;
    }
  }

  // best_day in period. A grouped zero row is not activity and must not turn
  // an otherwise empty profile into a synthetic "best" day.
  let bestDay: { date: string; total_tokens: number; estimated_cost_usd: number } | null = null;
  for (const [day, tokens] of periodByDay.entries()) {
    if (tokens <= 0) continue;
    if (!bestDay || tokens > bestDay.total_tokens) {
      bestDay = { date: day, total_tokens: tokens, estimated_cost_usd: periodByDayCost.get(day) || 0 };
    }
  }

  // favorite_model
  let favoriteModel: { model_name: string; total_tokens: number } | null = null;
  for (const [model, tokens] of periodByModel.entries()) {
    if (!favoriteModel || tokens > favoriteModel.total_tokens) {
      favoriteModel = { model_name: model, total_tokens: tokens };
    }
  }

  // streak (over period — set of active day strings)
  const activeDaySet = new Set(
    Array.from(periodByDay.entries())
      .filter(([, tokens]) => tokens > 0)
      .map(([day]) => day),
  );
  const streak = computeStreak(activeDaySet, todayDay);

  // daily_trend (period, dense — include 0 days so frontend can chart cleanly)
  const dailyTrend: Array<{ date: string; total_tokens: number }> = [];
  for (let cur = new Date(`${periodBounds.from_day}T00:00:00Z`); cur < new Date(`${periodEndDay}T00:00:00Z`); cur.setUTCDate(cur.getUTCDate() + 1)) {
    const day = cur.toISOString().slice(0, 10);
    dailyTrend.push({ date: day, total_tokens: periodByDay.get(day) || 0 });
  }
  // heatmap (365d dense). `models` powers the dashboard ActivityHeatmap's
  // per-cell model breakdown tooltip. Days with no activity get no models
  // key (the heatmap component already handles that gracefully).
  const heatmap: Array<{ date: string; total_tokens: number; models?: Record<string, number> }> = [];
  for (let cur = new Date(`${heatmapStartDay}T00:00:00Z`); cur < new Date(`${heatmapEndDay}T00:00:00Z`); cur.setUTCDate(cur.getUTCDate() + 1)) {
    const day = cur.toISOString().slice(0, 10);
    const cell: { date: string; total_tokens: number; models?: Record<string, number> } = {
      date: day,
      total_tokens: heatmapByDay.get(day) || 0,
    };
    const dayModels = heatmapModelsByDay.get(day);
    if (dayModels && dayModels.size > 0) {
      cell.models = Object.fromEntries(dayModels);
    }
    heatmap.push(cell);
  }

  // by_provider sorted desc with percent
  const byProvider = Array.from(periodByProvider.entries())
    .map(([source, v]) => ({
      source,
      total_tokens: v.tokens,
      estimated_cost_usd: v.cost,
      percent: periodTotalTokens > 0 ? v.tokens / periodTotalTokens : 0,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);

  const activeDays = activeDaySet.size;
  const periodDayCount = dailyTrend.length || 1;
  const avgPerDayUsd = periodTotalCost / periodDayCount;

  const isAnonymous = Boolean(settings.leaderboard_anonymous);
  const displayName = isAnonymous
    ? "Anonymous"
    : (profile.display_name || snap?.display_name || "");
  const avatarUrl = isAnonymous ? null : (profile.avatar_url || snap?.avatar_url || null);
  const githubUrl = !isAnonymous && settings.show_github_url ? (settings.github_url || null) : null;

  return json({
    user: {
      user_id: userId,
      display_name: displayName,
      avatar_url: avatarUrl,
      github_url: githubUrl,
      is_anonymous: isAnonymous,
      rank: snap?.rank ?? null,
    },
    period: {
      kind: period,
      from: periodBounds.from_day,
      to: periodBounds.to_day,
      time_zone: timeZone,
      time_zone_offset_minutes: timeZoneOffsetMinutes,
      generated_at: snap?.generated_at || new Date().toISOString(),
    },
    totals: {
      total_tokens: periodTotalTokens,
      estimated_cost_usd: periodTotalCost,
      active_days: activeDays,
      avg_per_day_usd: avgPerDayUsd,
    },
    streak,
    best_day: bestDay,
    models: {
      count: periodByModel.size,
      favorite: favoriteModel,
    },
    by_provider: byProvider,
    heatmap,
    daily_trend: dailyTrend,
    badges,
    badges_include_unearned: isSelf,
  });
}
