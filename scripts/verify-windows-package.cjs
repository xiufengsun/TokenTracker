// Check a self-contained Windows payload against the checkout that built it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const publish = path.resolve(process.argv[2] || "TokenTrackerWin/publish");
const reportPath = process.argv[3];
const runtime = path.join(publish, "EmbeddedServer", "tokentracker");
const required = ["TokenTracker.exe", "TokenTracker.dll", "EmbeddedServer/node.exe",
  "EmbeddedServer/tokentracker/bin/tracker.js", "EmbeddedServer/tokentracker/package-lock.json",
  ...["index.html", "pet.html", "quota.html", "pricing.html", "terms.html", "privacy.html"]
    .map(name => `EmbeddedServer/tokentracker/dashboard/dist/${name}`)];
for (const name of required) assert.ok(fs.statSync(path.join(publish, name)).isFile(), `Missing ${name}`);

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), `Unexpected package link: ${entry.name}`);
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : [filename];
  });
}
let matched = 0;
for (const name of ["src", "dashboard/dist", "bin/tracker.js", "package.json", "package-lock.json"]) {
  const source = path.join(root, name);
  const expected = fs.statSync(source).isDirectory() ? files(source) : [source];
  const target = path.join(runtime, name);
  const actual = fs.statSync(target).isDirectory() ? files(target) : [target];
  assert.deepEqual(actual.map(file => path.relative(target, file)).sort(),
    expected.map(file => path.relative(source, file)).sort(), `File inventory differs: ${name}`);
  for (const file of expected) {
    assert.deepEqual(fs.readFileSync(path.join(runtime, path.relative(root, file))), fs.readFileSync(file),
      `Embedded input differs: ${path.relative(root, file)}`);
    matched++;
  }
}
const packageFiles = files(publish);
for (const file of packageFiles) {
  assert.ok(!/^(?:\.env(?:\..*)?|project\.json|credentials\.json|.*private.*\.pem)$/i.test(path.basename(file)),
    `Private configuration in package: ${path.relative(publish, file)}`);
}
const report = {
  sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  version: JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8")).version,
  matchedInputs: matched,
  files: packageFiles.map(file => {
    const bytes = fs.readFileSync(file);
    return { path: path.relative(publish, file).replaceAll("\\", "/"),
      bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }),
};
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ sourceSha: report.sourceSha, version: report.version,
  matchedInputs: matched, packageFiles: packageFiles.length }));
