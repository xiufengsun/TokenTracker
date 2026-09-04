// Canonical list of supported coding agents, in display order. Shared by the
// marketing landing carousel and the dashboard auth/expired gate so the two
// surfaces can't drift. Names are tooltip/a11y metadata only.

export const AGENT_LOGOS = [
  { id: 1, name: "Claude Code", provider: "claude" },
  { id: 2, name: "Codex", provider: "codex" },
  { id: 3, name: "Cursor", provider: "cursor" },
  { id: 4, name: "Gemini", provider: "gemini" },
  { id: 5, name: "Antigravity", provider: "antigravity" },
  { id: 6, name: "Kiro", provider: "kiro" },
  { id: 7, name: "OpenCode", provider: "opencode" },
  { id: 8, name: "OpenClaw", provider: "openclaw" },
  { id: 9, name: "Every Code", provider: "every-code" },
  { id: 10, name: "Hermes", provider: "hermes" },
  { id: 11, name: "GitHub Copilot", provider: "copilot" },
  { id: 12, name: "Kimi", provider: "kimi" },
  { id: 13, name: "CodeBuddy", provider: "codebuddy" },
  { id: 14, name: "WorkBuddy", provider: "workbuddy" },
  { id: 15, name: "Grok", provider: "grok" },
  { id: 16, name: "oh-my-pi", provider: "omp" },
  { id: 17, name: "Pi", provider: "pi" },
  { id: 18, name: "Dots", provider: "dots" },
  { id: 19, name: "Prime Agent", provider: "prime-agent" },
  { id: 20, name: "Craft", provider: "craft" },
  { id: 21, name: "Reasonix", provider: "reasonix" },
  { id: 22, name: "Kilo CLI", provider: "kilo-cli" },
  { id: 23, name: "Kilo Code", provider: "kilocode" },
  { id: 24, name: "Roo Code", provider: "roocode" },
  { id: 25, name: "Zed", provider: "zed" },
  { id: 26, name: "Goose", provider: "goose" },
  { id: 27, name: "Droid", provider: "droid" },
  { id: 28, name: "Mimo", provider: "mimo" },
  { id: 29, name: "ZCode", provider: "zcode" },
  { id: 30, name: "Qoder", provider: "qoder" },
  { id: 31, name: "AnythingLLM", provider: "anythingllm" },
  { id: 32, name: "Claude Science", provider: "claude-science" },
  { id: 33, name: "DeepSeek Harness", provider: "dsh" },
  {
    id: 34,
    // No hardcoded English fallback name: every consumer renders through
    // copy() (LogoCarousel prefers nameKey; see LogoCarousel.test.jsx), so a
    // parallel "name" string would just duplicate the copy.csv entry.
    nameKey: "provider.display.trae_work_cn",
    provider: "trae-cn",
  },
  { id: 35, name: "AStudio", provider: "acode" },
  { id: 36, name: "LM Studio", provider: "lmstudio" },
  { id: 37, name: "Unsloth Studio", provider: "unsloth" },
];
