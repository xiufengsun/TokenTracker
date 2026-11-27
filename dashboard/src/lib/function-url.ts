import { CLOUDFLARE_API_URL, OFFICIAL_INSFORGE_URL } from "./insforge-deployment-config.mjs";

const PROD_API_URL = "https://srctyff5.us-east.insforge.app";
const PROD_FUNCTIONS_URL = "https://srctyff5.function2.insforge.app";

export function dataBaseUrlFor(baseUrl: string) {
  const root = baseUrl.replace(/\/$/, "");
  const runtime = typeof window === "undefined" ? undefined : window.__TOKENTRACKER_RUNTIME_CONFIG__;
  const enabled = runtime !== undefined
    ? runtime?.cloudflareReads === true
    : import.meta.env.VITE_TOKENTRACKER_CLOUDFLARE_READS === "1";
  return enabled && root === OFFICIAL_INSFORGE_URL ? CLOUDFLARE_API_URL : root;
}

// Match the CLI route: only the verified production deployment bypasses its
// API proxy. Custom and self-hosted backends retain their existing function URL.
export function functionUrlFor(baseUrl: string, slug: string) {
  const root = String(baseUrl || "").trim().replace(/\/$/, "");
  return root === PROD_API_URL
    ? `${PROD_FUNCTIONS_URL}/${slug}`
    : `${root}/functions/${slug}`;
}

export async function fetchFunctionResponse(url: string, init: RequestInit = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, init);
  const method = String(init.method || "GET").toUpperCase();
  const target = new URL(String(url));
  if (response.status === 404 && (method === "GET" || method === "HEAD")
      && target.origin === PROD_FUNCTIONS_URL) {
    const legacy = new URL(`${PROD_API_URL}/functions${target.pathname}`);
    legacy.search = target.search;
    return fetchImpl(legacy.toString(), init);
  }
  return response;
}
