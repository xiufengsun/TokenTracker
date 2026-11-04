const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const edgePath = path.join(
  __dirname,
  "..",
  "dashboard",
  "edge-patches",
  "tokentracker-user-badges-refresh.ts",
);
const edge = fs.readFileSync(edgePath, "utf8");
const codeBody = edge.replace(/^\/\*[\s\S]*?\*\//, "");

test("user-badges refresh edge requires privileged auth before RPC", () => {
  assert.match(codeBody, /authorizePrivileged/);
  assert.match(codeBody, /LEADERBOARD_REFRESH_SECRET/);
  assert.match(codeBody, /x-refresh-secret/);
  assert.match(codeBody, /INSFORGE_SERVICE_ROLE_KEY/);
  assert.match(
    codeBody,
    /if \(!authorizePrivileged\(req\)\) return json\(\{ error: "Unauthorized" \}, 401\)/,
  );
  const authCheck = codeBody.indexOf("authorizePrivileged(req)");
  const rpcCall = codeBody.indexOf('rpc("user_badges_refresh")');
  assert.notEqual(authCheck, -1);
  assert.notEqual(rpcCall, -1);
  assert.ok(authCheck < rpcCall, "auth gate must precede user_badges_refresh RPC");
});

test("user-badges refresh edge rejects non-POST and has no signed-in write path", () => {
  assert.match(codeBody, /req\.method !== "POST"/);
  assert.doesNotMatch(codeBody, /verifiedClaimsFromJwt/);
  assert.doesNotMatch(codeBody, /RefreshAuthorization/);
});
