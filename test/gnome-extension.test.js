const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const extensionDir = path.resolve(
  __dirname,
  "..",
  "TokenTrackerLinux",
  "gnome-extension",
  "tokentracker@tokentracker.cc",
);

test("GNOME extension parses as an ES module", () => {
  // Piped through stdin so Node 20 (no module detection) still checks it as ESM.
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: fs.readFileSync(path.join(extensionDir, "extension.js")),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("GNOME extension metadata matches its directory and lists shell versions", () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(extensionDir, "metadata.json"), "utf8"));
  // GNOME only loads an extension whose uuid equals its directory name.
  assert.equal(metadata.uuid, path.basename(extensionDir));
  assert.ok(Array.isArray(metadata["shell-version"]) && metadata["shell-version"].length > 0);
  for (const version of metadata["shell-version"]) {
    assert.match(version, /^\d+$/);
  }
});

// extension.js imports gi:// modules, so load just the response check (and
// the error classes it throws) out of the source and run it for real.
function loadResponseCheck() {
  const source = fs.readFileSync(path.join(extensionDir, "extension.js"), "utf8");
  const classes = source.match(/^class \w+Error extends Error \{\}$/gm) ?? [];
  const start = source.indexOf("function parseResponse(");
  const end = source.indexOf("\n}\n", start) + 2;
  assert.ok(classes.length === 2 && start >= 0 && end > start, "parseResponse / error classes not found");
  return new Function(
    `${classes.join("\n")}\n${source.slice(start, end)}\nreturn { ServerError, ForeignServerError, parseResponse };`,
  )();
}

test("GNOME extension treats unusable JSON from the app as a server error", () => {
  const { ServerError, parseResponse } = loadResponseCheck();
  // `null` used to throw outside the refresh's catch; `[]` rendered as 0 / $0.
  for (const body of ["null", "[]", "[{\"totals\":{}}]", "42", "\"ok\"", "true"]) {
    assert.throws(() => parseResponse(200, body, "/functions/x"), ServerError, body);
  }
  assert.throws(() => parseResponse(500, "", "/functions/x"), ServerError);
  assert.throws(() => parseResponse(503, "<html></html>", "/functions/x"), ServerError);
  assert.throws(() => parseResponse(401, '{"error":"nope"}', "/functions/x"), ServerError);
  assert.deepEqual(parseResponse(200, '{"totals":{"total_tokens":5}}', "/functions/x"), {
    totals: { total_tokens: 5 },
  });
});

test("GNOME extension treats a reply from another service on its port as offline", () => {
  const { ServerError, ForeignServerError, parseResponse } = loadResponseCheck();
  const cases = [
    [404, '{"error":"not found"}'],
    [404, "<html>Not Found</html>"],
    [200, "<!doctype html><title>Some other app</title>"],
    [403, "Forbidden"],
  ];
  for (const [status, body] of cases) {
    assert.throws(
      () => parseResponse(status, body, "/functions/x"),
      (e) => e instanceof ForeignServerError && !(e instanceof ServerError),
      `${status} ${body}`,
    );
  }
});
