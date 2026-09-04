import { describe, expect, it } from "vitest";
import { formatProviderDisplayName } from "./provider-display.js";

describe("formatProviderDisplayName", () => {
  it.each([
    ["lmstudio", "LM Studio"],
    ["unsloth", "Unsloth Studio"],
  ])("formats %s with its product casing", (value, expected) => {
    expect(formatProviderDisplayName(value)).toBe(expected);
  });

  it.each(["anythingllm", "AnythingLLM", "anything-llm", "anything_llm"])(
    "normalizes %s to the official AnythingLLM casing",
    (value) => {
      expect(formatProviderDisplayName(value)).toBe("AnythingLLM");
    },
  );

  it("preserves the existing generic capitalization fallback", () => {
    expect(formatProviderDisplayName("cursor")).toBe("Cursor");
    expect(formatProviderDisplayName("CODEX")).toBe("CODEX");
    expect(formatProviderDisplayName("")).toBe("");
  });

  it("uses the AStudio product name", () => {
    expect(formatProviderDisplayName("acode")).toBe("AStudio");
    expect(formatProviderDisplayName("ACODE")).toBe("AStudio");
  });

  it("gives Pi routed providers distinct readable names", () => {
    expect(formatProviderDisplayName("pi-anthropic")).toBe("Pi · Anthropic");
    expect(formatProviderDisplayName("PI-GITHUB-COPILOT")).toBe("Pi · GitHub Copilot");
  });

  it("names Dots both standalone and pi-routed", () => {
    expect(formatProviderDisplayName("dots")).toBe("Dots");
    expect(formatProviderDisplayName("DOTS")).toBe("Dots");
    expect(formatProviderDisplayName("pi-dots")).toBe("Pi · Dots");
    expect(formatProviderDisplayName("PI-DOTS")).toBe("Pi · Dots");
  });

  it("names pi backends that are not in the enumerated list", () => {
    expect(formatProviderDisplayName("pi-xai")).toBe("Pi · xAI");
    expect(formatProviderDisplayName("pi-opencode-go")).toBe("Pi · OpenCode Go");
    expect(formatProviderDisplayName("pi")).toBe("Pi");
  });

  it("gives Prime Agent routed providers distinct readable names", () => {
    expect(formatProviderDisplayName("prime-agent")).toBe("Prime Agent");
    expect(formatProviderDisplayName("prime-agent-anthropic")).toBe("Prime Agent · Anthropic");
    expect(formatProviderDisplayName("PRIME_AGENT_GITHUB_COPILOT")).toBe("Prime Agent · GitHub Copilot");
  });

  it("formats omp as oh-my-pi", () => {
    expect(formatProviderDisplayName("omp")).toBe("oh-my-pi");
    expect(formatProviderDisplayName("OMP")).toBe("oh-my-pi");
  });

  it("uses the registered DeepSeek Harness product name for current and legacy sources", () => {
    expect(formatProviderDisplayName("dsh")).toBe("DeepSeek Harness");
    expect(formatProviderDisplayName("deepseek")).toBe("DeepSeek Harness");
  });

  it.each(["trae-cn", "TRAE-CN", "Trae_Cn", "TRAE Work CN"])(
    "uses the catalog-backed TRAE Work CN name for %s",
    (value) => {
      expect(formatProviderDisplayName(value)).toBe("TRAE Work CN");
    },
  );
});
