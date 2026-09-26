const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  injectLinuxOAuthBridge,
  linuxOAuthHandoffHtml,
  linuxOAuthHandoffTarget,
  requestWantsLinuxOAuthHandoff,
} = require("../src/commands/serve");

const CODE = "a".repeat(64);
const LINUX = { TOKENTRACKER_APP_SHELL: "linux" };

function page(pathname, { accept = "text/html", method = "GET" } = {}) {
  return {
    req: { method, headers: { accept } },
    url: new URL(pathname, "http://127.0.0.1:17680"),
  };
}

test("linux shell hands a browser oauth return to the running app", () => {
  const target = `tokentracker://auth/callback?insforge_code=${CODE}`;
  const { req, url } = page(`/?insforge_code=${CODE}`);
  assert.equal(linuxOAuthHandoffTarget(url, LINUX), target);
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, LINUX), target);
  assert.match(linuxOAuthHandoffHtml(target), new RegExp(`location\\.replace\\(${JSON.stringify(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
});

test("the in-app exchange page is served to the webview", () => {
  const { req, url } = page(`/auth/callback?insforge_code=${CODE}&app=1`);
  assert.equal(linuxOAuthHandoffTarget(url, LINUX), null);
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, LINUX), null);
});

test("a cli or browser session is not redirected onto the custom scheme", () => {
  const { req, url } = page(`/?insforge_code=${CODE}`);
  assert.equal(linuxOAuthHandoffTarget(url, {}), null);
  assert.equal(linuxOAuthHandoffTarget(url, { TOKENTRACKER_APP_SHELL: "macos" }), null);
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, {}), null);
});

test("ambiguous or malformed codes stay on the dashboard", () => {
  const linux = LINUX;
  assert.equal(linuxOAuthHandoffTarget(new URL(`http://127.0.0.1:17680/?insforge_code=${CODE}&insforge_code=${"b".repeat(64)}`), linux), null);
  assert.equal(linuxOAuthHandoffTarget(new URL("http://127.0.0.1:17680/?insforge_code=short"), linux), null);
  assert.equal(linuxOAuthHandoffTarget(new URL("http://127.0.0.1:17680/?insforge_code=https://evil.example"), linux), null);
});

test("oauth handoff ignores asset and api requests", () => {
  const asset = page(`/assets/app.js?insforge_code=${CODE}`, { accept: "*/*" });
  assert.equal(requestWantsLinuxOAuthHandoff(asset.req, asset.url, LINUX), null);
  const api = page(`/api/summary?insforge_code=${CODE}`, { accept: "application/json" });
  assert.equal(requestWantsLinuxOAuthHandoff(api.req, api.url, LINUX), null);
});

test("linux dashboard html installs the oauth bridge before the bundle", () => {
  const html = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>";
  const injected = injectLinuxOAuthBridge(html, LINUX);
  assert.match(injected, /<head[^>]*><script>.*open_oauth/);
  assert.equal(injectLinuxOAuthBridge(injected, LINUX), injected);
  assert.equal(injectLinuxOAuthBridge(html, {}), html);
});
