import { copy } from "./copy";

const SPECIAL_PROVIDER_NAMES = {
  acode: "AStudio",
  anythingllm: "AnythingLLM",
  claudescience: "Claude Science",
  pianthropic: "Pi · Anthropic",
  pigithubcopilot: "Pi · GitHub Copilot",
  picopilot: "Pi · Copilot",
  dots: "Dots",
  pidots: "Pi · Dots",
  lmstudio: "LM Studio",
  unsloth: "Unsloth Studio",
};

const SPECIAL_PROVIDER_COPY_KEYS = {
  deepseek: "provider.display.deepseek_harness",
  dsh: "provider.display.deepseek_harness",
  omp: "provider.display.omp",
  traecn: "provider.display.trae_work_cn",
  traeworkcn: "provider.display.trae_work_cn",
};

function normalizedProviderKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

// Router agents (pi, Prime Agent) encode the routed backend in the source key
// itself (`pi-xai`, `prime-agent-github-copilot`) because each backend prices
// differently and must stay its own bucket — see piSourceForProvider() in
// src/lib/rollout.js. SPECIAL_PROVIDER_NAMES above only covers the backends
// seen so far; the slug is open-ended, so anything else lands here.
const ROUTED_PROVIDER_WORDS = {
  ai: "AI",
  api: "API",
  cli: "CLI",
  github: "GitHub",
  openai: "OpenAI",
  opencode: "OpenCode",
  xai: "xAI",
};

function formatRoutedProvider(suffix) {
  return suffix
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => ROUTED_PROVIDER_WORDS[part.toLowerCase()]
      ?? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function formatProviderDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const normalized = normalizedProviderKey(raw);
  if (normalized === "primeagent") return "Prime Agent";
  if (normalized.startsWith("primeagent") && normalized.length > "primeagent".length) {
    const provider = formatRoutedProvider(raw.replace(/^prime[-_ ]?agent[-_ ]?/i, ""));
    return provider ? `Prime Agent · ${provider}` : "Prime Agent";
  }
  const specialCopyKey = SPECIAL_PROVIDER_COPY_KEYS[normalized];
  if (specialCopyKey) return copy(specialCopyKey);

  const specialName = SPECIAL_PROVIDER_NAMES[normalized];
  if (specialName) return specialName;

  if (/^pi[-_ ]/i.test(raw)) {
    const provider = formatRoutedProvider(raw.slice(3));
    if (provider) return `Pi · ${provider}`;
  }

  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
