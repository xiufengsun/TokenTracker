import { copy } from "./copy";

/** Canonical usage-limits provider ids (order defaults in useLimitsDisplayPrefs). */
export const LIMIT_PROVIDER_IDS = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "kimi",
  "kiro",
  "grok",
  "copilot",
  "antigravity",
  "zcode",
  "opencodeGo",
  "commandCode",
  "qoder",
  "qoderCn",
  "codingPlan",
  "agentPlan",
  "devin",
  "workbuddy",
];

/** Keys for ProviderIcon — mono logos use inline SVG; colored logos use /brand-logos/. */
export const LIMIT_PROVIDER_ICON_KEYS = {
  claude: "CLAUDE",
  codex: "CODEX",
  cursor: "CURSOR",
  gemini: "GEMINI",
  kimi: "KIMI",
  kiro: "KIRO",
  grok: "GROK",
  copilot: "COPILOT",
  antigravity: "ANTIGRAVITY",
  zcode: "ZCODE",
  // Reuse the existing OpenCode brand mark — same vendor, separate product
  // (Go is a paid subscription tracked via dashboard scrape).
  opencodeGo: "OPENCODE",
  // CommandCode has no standalone square brand mark; it reuses the docs
  // double-chevron glyph via the CommandCodeIcon mono component below.
  commandCode: "COMMAND-CODE",
  qoder: "QODER",
  // The CN edition ships its own green-crescent brand mark, distinct from the
  // international black double-crescent — resolved to the QODER-CN icon asset.
  qoderCn: "QODER-CN",
  // Volcano Engine Ark Coding Plan — own brand mark under /brand-logos/.
  codingPlan: "VOLCANO-ARK",
  // Volcano Engine Ark Agent Plan — shares the same Ark brand mark.
  agentPlan: "VOLCANO-ARK",
  // Devin (devin.ai) — the three-hexagon "nodes" mark under /brand-logos/.
  devin: "DEVIN",
  // WorkBuddy uses one product row for either regional edition.
  workbuddy: "WORKBUDDY",
};

export function limitProviderIconKey(id) {
  return LIMIT_PROVIDER_ICON_KEYS[id] || null;
}

export function limitProviderName(id) {
  switch (id) {
    case "claude":
      return copy("limits.provider.claude");
    case "codex":
      return copy("limits.provider.codex");
    case "cursor":
      return copy("limits.provider.cursor");
    case "gemini":
      return copy("limits.provider.gemini");
    case "kimi":
      return copy("limits.provider.kimi");
    case "kiro":
      return copy("limits.provider.kiro");
    case "grok":
      return copy("limits.provider.grok");
    case "copilot":
      return copy("limits.provider.copilot");
    case "antigravity":
      return copy("limits.provider.antigravity");
    case "zcode":
      return copy("limits.provider.zcode");
    case "opencodeGo":
      return copy("limits.provider.opencode_go");
    case "commandCode":
      return copy("limits.provider.command_code");
    case "qoder":
      return copy("limits.provider.qoder");
    case "qoderCn":
      return copy("limits.provider.qoder_cn");
    case "codingPlan":
      return copy("limits.provider.ark_coding_plan");
    case "agentPlan":
      return copy("limits.provider.ark_agent_plan");
    case "devin":
      return copy("limits.provider.devin");
    case "workbuddy":
      return copy("limits.provider.workbuddy");
    default:
      return String(id || "");
  }
}
