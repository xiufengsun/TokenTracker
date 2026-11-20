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

test("GNOME extension ships in the deb, rpm and Arch packages", () => {
  const root = path.resolve(__dirname, "..");
  const uuid = path.basename(extensionDir);
  const files = fs.readdirSync(extensionDir).filter((f) => f !== "README.md").sort();
  const conf = JSON.parse(fs.readFileSync(path.join(root, "TokenTrackerLinux/src-tauri/tauri.conf.json"), "utf8"));
  for (const format of ["deb", "rpm"]) {
    const mapped = conf.bundle.linux[format].files;
    const expected = Object.fromEntries(
      files.map((f) => [`/usr/share/gnome-shell/extensions/${uuid}/${f}`, `../gnome-extension/${uuid}/${f}`]),
    );
    assert.deepEqual(mapped, expected, format);
  }
  const pkgbuild = fs.readFileSync(path.join(root, "TokenTrackerLinux/packaging/arch/tokentracker-linux/PKGBUILD"), "utf8");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release-dmg.yml"), "utf8");
  const loopOver = (text, head) => text.split("\n").find((line) => line.includes(head)) ?? "";
  for (const f of files) {
    assert.ok(loopOver(pkgbuild, "for _file in").includes(f), `PKGBUILD installs ${f}`);
    assert.ok(loopOver(workflow, "for file in metadata.json").includes(f), `release checks ${f}`);
  }
  assert.match(workflow, /verify_gnome_extension "deb"/);
  assert.match(workflow, /verify_gnome_extension "rpm"/);
  const validator = fs.readFileSync(path.join(root, "TokenTrackerLinux/scripts/validate-package.sh"), "utf8");
  for (const f of files) {
    assert.ok(validator.includes(`usr/share/gnome-shell/extensions/${uuid}/${f}`), f);
  }
});

// extension.js imports gi:// modules, so load just the response check (and
// the error classes it throws) out of the source and run it for real.
function loadResponseCheck() {
  const source = fs.readFileSync(path.join(extensionDir, "extension.js"), "utf8").replace(/\r\n/g, "\n");
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

function loadLimitRows() {
  const source = fs.readFileSync(path.join(extensionDir, "extension.js"), "utf8").replace(/\r\n/g, "\n");
  const namesStart = source.indexOf("const PROVIDER_NAMES = {");
  const windowEnd = source.indexOf("};", source.indexOf("const WINDOW_NAMES = {")) + 2;
  const helpersStart = source.indexOf("function formatDuration(");
  const helpersEnd = source.indexOf("\n}\n", source.indexOf("function percentOf(")) + 2;
  const rowsStart = source.indexOf("function limitRows(");
  const rowsEnd = source.indexOf("\n}\n", rowsStart) + 2;
  assert.ok(
    namesStart >= 0 && windowEnd > namesStart && helpersStart >= 0 && rowsStart >= 0,
    "limitRows helpers not found in extension.js",
  );
  return new Function(
    `${source.slice(namesStart, windowEnd)}\n${source.slice(helpersStart, helpersEnd)}\n${source.slice(rowsStart, rowsEnd)}\nreturn { PROVIDER_NAMES, limitRows };`,
  )();
}

test("GNOME extension maps Muse Code 5h and 7d quota windows with display name", () => {
  const { PROVIDER_NAMES, limitRows } = loadLimitRows();
  assert.equal(PROVIDER_NAMES.muse, "Muse Code");
  const rows = limitRows({
    muse: {
      configured: true,
      error: null,
      plan_label: "Power",
      primary_window: {
        used_percent: 24,
        reset_at: "2026-11-11T12:00:00.000Z",
        limit_window_seconds: 18000,
      },
      secondary_window: {
        used_percent: 9,
        reset_at: "2026-11-17T00:00:00.000Z",
        limit_window_seconds: 604800,
      },
    },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Muse Code");
  assert.equal(rows[0].label, "5h");
  assert.equal(rows[0].percent, 24);
  assert.equal(rows[1].name, "Muse Code");
  assert.equal(rows[1].label, "7d");
  assert.equal(rows[1].percent, 9);

  const idleRows = limitRows({
    muse: {
      configured: true,
      error: null,
      plan_label: "Power",
      primary_window: {
        used_percent: 0,
        reset_at: null,
        limit_window_seconds: 18000,
      },
      secondary_window: null,
    },
  });
  assert.deepEqual(idleRows, [
    { name: "Muse Code", label: "5h", percent: 0, reset: null },
  ]);
});
