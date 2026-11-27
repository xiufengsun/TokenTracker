import { safeGetItem, safeSetItem } from "./safe-browser";
import { EN_LOCALE, normalizeResolvedLocale } from "./locale-tag";

export const LOCALE_STORAGE_KEY = "tokentracker-locale";
export const SYSTEM_LOCALE = "system";
export { EN_LOCALE, DE_LOCALE, JA_LOCALE, KO_LOCALE, ZH_CN_LOCALE, ZH_TW_LOCALE, normalizeResolvedLocale } from "./locale-tag";

export function normalizeLocalePreference(value: any) {
  if (value === SYSTEM_LOCALE) return SYSTEM_LOCALE;
  return normalizeResolvedLocale(value);
}

function getBrowserLanguages() {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length) {
    return navigator.languages.filter((value) => typeof value === "string");
  }
  return typeof navigator.language === "string" ? [navigator.language] : [];
}

export function resolvePreferredLocale(preference: any, languages = getBrowserLanguages()) {
  const normalized = normalizeLocalePreference(preference);
  if (normalized !== SYSTEM_LOCALE) return normalized;
  // Use only the primary (most preferred) language, not any zh entry in the list.
  // Many English macOS users keep zh-Hans-CN as a secondary language for input methods or
  // fallback menus — scanning the whole array mis-resolves their primary "en" to Chinese.
  // See issue #54.
  const primary = languages
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  if (!primary) return EN_LOCALE;
  return normalizeResolvedLocale(primary);
}

export function getInitialLocalePreference() {
  return normalizeLocalePreference(safeGetItem(LOCALE_STORAGE_KEY) || SYSTEM_LOCALE);
}

export function persistLocalePreference(preference: any) {
  return safeSetItem(LOCALE_STORAGE_KEY, normalizeLocalePreference(preference));
}
