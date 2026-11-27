export const EN_LOCALE = "en";
export const ZH_CN_LOCALE = "zh-CN";
export const ZH_TW_LOCALE = "zh-TW";
export const JA_LOCALE = "ja";
export const KO_LOCALE = "ko";
export const DE_LOCALE = "de";

// Traditional-Chinese script (Hant) or Traditional-Chinese regions (Taiwan, Hong Kong, Macau).
// Everything else under zh-* (zh, zh-Hans, zh-CN, zh-SG, …) resolves to Simplified.
const TRADITIONAL_CHINESE_TAG = /^zh[-_](hant|tw|hk|mo)\b/i;

// Map a BCP-47-ish language tag to a supported resolved locale, or null if unsupported.
function classifyLanguageTag(tag: string): string | null {
  if (/^zh(?:[-_]|$)/i.test(tag)) {
    return TRADITIONAL_CHINESE_TAG.test(tag) ? ZH_TW_LOCALE : ZH_CN_LOCALE;
  }
  if (/^ja(?:[-_]|$)/i.test(tag)) return JA_LOCALE;
  if (/^ko(?:[-_]|$)/i.test(tag)) return KO_LOCALE;
  if (/^de(?:[-_]|$)/i.test(tag)) return DE_LOCALE;
  return null;
}

export function normalizeResolvedLocale(value: unknown) {
  if (typeof value !== "string") return EN_LOCALE;
  return classifyLanguageTag(value.trim()) || EN_LOCALE;
}
