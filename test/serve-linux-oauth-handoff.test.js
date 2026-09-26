const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
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

function appMark(pending) {
  const mark = () => {
    mark.taken += 1;
    const was = pending;
    pending = false;
    return was;
  };
  mark.taken = 0;
  return mark;
}

test("linux shell hands the app's browser oauth return to the running app", () => {
  const target = `tokentracker://auth/callback?insforge_code=${CODE}`;
  const { req, url } = page(`/auth/callback?insforge_code=${CODE}`);
  assert.equal(linuxOAuthHandoffTarget(url, LINUX), target);
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, appMark(true), LINUX), target);
  assert.match(linuxOAuthHandoffHtml(target), new RegExp(`location\\.replace\\(${JSON.stringify(target).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
});

test("a sign-in made in a normal browser tab stays in that tab", () => {
  const { req, url } = page(`/?insforge_code=${CODE}`);
  const mark = appMark(false);
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, mark, LINUX), null);
  assert.equal(mark.taken, 1);
});

test("the app's mark relays one return only", () => {
  const { req, url } = page(`/auth/callback?insforge_code=${CODE}`);
  const mark = appMark(true);
  assert.ok(requestWantsLinuxOAuthHandoff(req, url, mark, LINUX));
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, mark, LINUX), null);
});

test("the in-app exchange page is served to the webview without spending the mark", () => {
  const { req, url } = page(`/auth/callback?insforge_code=${CODE}&app=1`);
  const mark = appMark(true);
  assert.equal(linuxOAuthHandoffTarget(url, LINUX), null);
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, mark, LINUX), null);
  assert.equal(mark.taken, 0);
});

test("a cli or browser session is not redirected onto the custom scheme", () => {
  const { req, url } = page(`/?insforge_code=${CODE}`);
  assert.equal(linuxOAuthHandoffTarget(url, {}), null);
  assert.equal(linuxOAuthHandoffTarget(url, { TOKENTRACKER_APP_SHELL: "macos" }), null);
  assert.equal(linuxOAuthHandoffTarget(url, { TOKENTRACKER_APP_SHELL: "windows" }), null);
  assert.equal(requestWantsLinuxOAuthHandoff(req, url, appMark(true), {}), null);
});

test("ambiguous or malformed codes stay on the dashboard", () => {
  const linux = LINUX;
  assert.equal(linuxOAuthHandoffTarget(new URL(`http://127.0.0.1:17680/?insforge_code=${CODE}&insforge_code=${"b".repeat(64)}`), linux), null);
  assert.equal(linuxOAuthHandoffTarget(new URL("http://127.0.0.1:17680/?insforge_code=short"), linux), null);
  assert.equal(linuxOAuthHandoffTarget(new URL("http://127.0.0.1:17680/?insforge_code=https://evil.example"), linux), null);
});

test("oauth handoff ignores asset and api requests", () => {
  const mark = appMark(true);
  const asset = page(`/assets/app.js?insforge_code=${CODE}`, { accept: "*/*" });
  assert.equal(requestWantsLinuxOAuthHandoff(asset.req, asset.url, mark, LINUX), null);
  const api = page(`/api/summary?insforge_code=${CODE}`, { accept: "application/json" });
  assert.equal(requestWantsLinuxOAuthHandoff(api.req, api.url, mark, LINUX), null);
  assert.equal(mark.taken, 0);
});
