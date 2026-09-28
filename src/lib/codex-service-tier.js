// Codex service-tier attribution.
//
// The request tier is NOT on the token_count rows. Codex emits it as its own
// rollout record — `type: "event_msg"`, `payload.type:
// "thread_settings_applied"`, `payload.thread_settings.service_tier` — written
// immediately before the `turn_context` of the turn it applies to. A session's
// first turn has no such record, and CLI-originated sessions
// (originator codex_cli_rs / codex-tui) often have none at all: on a 1213-file
// local corpus only 167 files carried the event, covering 25% of token_count
// events.
//
// Attribution rule, and the only one the log shape permits: a token_count row
// belongs to the most recent preceding thread_settings_applied. With no
// preceding record the tier is unknown, and unknown is never guessed — it is
// billed at Standard, exactly as before this file existed.

"use strict";

// Cheap line prefilter for parsers that avoid JSON.parse on most records.
const CODEX_SERVICE_TIER_MARKER = '"thread_settings_applied"';

// Observed values on the local corpus are "default" (814) and "priority" (58).
// "priority" is what the CLI writes for what OpenAI's price table and the Codex
// UI both call Fast; accept the product-facing spelling too so a future rename
// does not silently fall back to Standard.
const PRIORITY_SERVICE_TIERS = new Set(["priority", "fast"]);

function readCodexServiceTier(obj) {
  if (!obj || obj.type !== "event_msg") return null;
  const payload = obj.payload;
  if (!payload || typeof payload !== "object") return null;
  if (payload.type !== "thread_settings_applied") return null;
  const settings = payload.thread_settings;
  if (!settings || typeof settings !== "object") return null;
  const tier = settings.service_tier;
  if (typeof tier !== "string" || !tier.trim()) return null;
  return tier.trim().toLowerCase();
}

function isPriorityServiceTier(tier) {
  return typeof tier === "string" && PRIORITY_SERVICE_TIERS.has(tier);
}

module.exports = {
  CODEX_SERVICE_TIER_MARKER,
  PRIORITY_SERVICE_TIERS,
  readCodexServiceTier,
  isPriorityServiceTier,
};
