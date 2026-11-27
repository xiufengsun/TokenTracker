import { normalizeResolvedLocale } from "../../../dashboard/src/lib/locale-tag";
import { nonce } from "./auth";

declare const __NATIVE_RETURN_COPY__: Record<string, [string, string, string]>;

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function nativeReturnPage(destination: URL, request: Request, headers: Headers) {
  const language = request.headers.get("Accept-Language")?.split(",")[0]?.split(";")[0]?.trim();
  const locale = normalizeResolvedLocale(language);
  const [title, returning, open] = __NATIVE_RETURN_COPY__[locale];
  const scriptNonce = nonce();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Language", locale);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'nonce-${scriptNonce}'; script-src 'nonce-${scriptNonce}'`);
  return new Response(`<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · TokenTracker</title>
<style nonce="${scriptNonce}">
:root{color-scheme:dark;font:14px/1.5 system-ui,sans-serif;color:#fff;background:#050605}
body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center}
main{padding:24px;text-align:center;max-width:24rem}
svg{display:block;margin:0 auto;padding:12px;border-radius:50%;background:rgba(34,197,94,.15);color:#4ade80}
h1{font-size:20px;line-height:1.35;font-weight:600;margin:16px 0 0}
p{font-size:14px;line-height:1.5;color:#a1a1aa;margin:6px 0 20px}
#open-app{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;
min-height:44px;padding:8px 16px;border-radius:10px;background:#f4f4f5;color:#18181b;
font-size:13px;line-height:18px;font-weight:500;text-decoration:none}
#open-app:hover{background:#fff}#open-app:active{background:#d4d4d8}
#open-app:focus-visible{outline:2px solid #4ade80;outline-offset:4px}
</style></head><body><main>
<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
<h1>${escape(title)}</h1><p>${escape(returning)}</p>
<a id="open-app" href="${escape(destination.href)}">${escape(open)}</a>
</main><script nonce="${scriptNonce}">window.location.assign(document.getElementById("open-app").href);</script></body></html>`, { headers });
}
