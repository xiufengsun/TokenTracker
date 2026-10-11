export const OFFICIAL_INSFORGE_URL = "https://srctyff5.us-east.insforge.app";

export function isPublicAnonKey(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const key = value.trim();
  if (key.startsWith("ik_")) return false;
  if (/^anon_(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(key)) return true;
  try {
    const parts = key.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role === "anon";
  } catch { return false; }
}

export function validateInsforgeDeployment({ baseUrl, anonKey, strictPair = false,
  defaultBaseUrl = OFFICIAL_INSFORGE_URL, defaultAnonKey = "" } = {}) {
  const configuredUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
  const configuredKey = typeof anonKey === "string" ? anonKey.trim() : "";
  let normalized;
  try {
    const parsed = new URL(configuredUrl || defaultBaseUrl);
    if (parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) throw new Error();
    normalized = parsed.toString().replace(/\/+$/, "");
  } catch {
    return { baseUrl: "", anonKey: "", errorCode: "invalid_backend_url" };
  }
  const custom = normalized !== defaultBaseUrl.replace(/\/+$/, "");
  if ((custom || strictPair) && !configuredKey)
    return { baseUrl: "", anonKey: "", errorCode: "missing_backend_anon_key" };
  if (custom && defaultAnonKey && configuredKey === defaultAnonKey)
    return { baseUrl: "", anonKey: "", errorCode: "missing_backend_anon_key" };
  const selectedKey = configuredKey || defaultAnonKey;
  if (selectedKey && !isPublicAnonKey(selectedKey))
    return { baseUrl: "", anonKey: "", errorCode: "invalid_backend_anon_key" };
  return { baseUrl: normalized, anonKey: selectedKey, errorCode: null };
}

export function validateInsforgeBuildEnv(env) {
  return validateInsforgeDeployment({
    baseUrl: env?.VITE_INSFORGE_BASE_URL || env?.VITE_TOKENTRACKER_BACKEND_BASE_URL,
    anonKey: env?.VITE_INSFORGE_ANON_KEY || env?.VITE_TOKENTRACKER_BACKEND_ANON_KEY,
  });
}
