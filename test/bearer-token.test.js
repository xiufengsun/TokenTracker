const assert = require("node:assert/strict");
const cp = require("node:child_process");
const { test } = require("node:test");
const { parseBearerToken } = require("../src/lib/bearer-token");

test("bearer parsing preserves opaque tokens and accepts case and horizontal separators", () => {
  assert.equal(parseBearerToken("Bearer opaque.token-_"), "opaque.token-_");
  assert.equal(parseBearerToken("bEaReR\t  token"), "token");
  assert.equal(parseBearerToken("Bearer token "), "token ");
});

test("bearer parsing rejects empty tokens, other schemes and line breaks", () => {
  for (const value of [undefined, null, "", "Bearer", "Bearer \t ", "Basic token",
    "Prefix Bearer token", "Bearer\ntoken", "Bearer token\r\nother"]) {
    assert.equal(parseBearerToken(value), null);
  }
});

test("an adversarial malformed authorization value completes within the isolated process budget", () => {
  const modulePath = require.resolve("../src/lib/bearer-token");
  const result = cp.spawnSync(process.execPath, ["-e",
    "const {parseBearerToken}=require(process.argv[1]); process.stdout.write(JSON.stringify(parseBearerToken('Bearer '+ ' '.repeat(1000000)+'\\n\\n')));",
    modulePath], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stdout, "null");
});
