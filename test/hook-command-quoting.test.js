const assert = require("node:assert/strict");
const { test } = require("node:test");

const { buildHookCommand } = require("../src/lib/claude-config");
const { buildGeminiHookCommand } = require("../src/lib/gemini-config");

// quoteArg must escape backslashes BEFORE quotes: a Windows path ending in a
// backslash (`C:\foo\`) would otherwise render as `"...\"` — the trailing
// backslash escapes the closing quote and corrupts the whole hook command.
const BUILDERS = [
  ["claude-config buildHookCommand", (p) => buildHookCommand(p, "claude", { platform: "linux" })],
  ["gemini-config buildGeminiHookCommand", (p) => buildGeminiHookCommand(p, { platform: "linux" })],
];

for (const [name, build] of BUILDERS) {
  test(`${name}: simple posix path stays unquoted`, () => {
    assert.equal(
      build("/usr/local/lib/notify.cjs").includes('"'),
      false,
    );
  });

  test(`${name}: windows path with spaces doubles backslashes inside quotes`, () => {
    const cmd = build("C:\\Users\\My User\\notify.cjs");
    assert.match(cmd, /"C:\\\\Users\\\\My User\\\\notify\.cjs"/);
  });

  test(`${name}: trailing backslash cannot escape the closing quote`, () => {
    const cmd = build("C:\\token tracker\\");
    // The quoted argument must end with an escaped backslash then the quote,
    // never a bare \" (which would swallow the closing quote).
    assert.match(cmd, /"C:\\\\token tracker\\\\"/);
  });

  test(`${name}: embedded quotes stay escaped`, () => {
    const cmd = build('/tmp/we"ird/notify.cjs');
    assert.match(cmd, /"\/tmp\/we\\"ird\/notify\.cjs"/);
  });
}
