const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("bot frame generation leaves predictable neighbor files intact and cleans its private build directory", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-bot-engine-temp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generator = path.resolve(__dirname, "../scripts/gen-bot-frames.cjs");
  const script = `
    const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
    const root = os.tmpdir();
    const files = ['bot-engine-entry-' + process.pid + '.mjs', 'bot-engine-' + process.pid + '.cjs'];
    for (const file of files) fs.writeFileSync(path.join(root, file), 'preserve this neighbor', { flag: 'wx' });
    process.argv.push('--check');
    require(process.argv[1]);
    const neighborsIntact = files.every(file => fs.readFileSync(path.join(root, file), 'utf8') === 'preserve this neighbor');
    const privateBuildsLeft = fs.readdirSync(root).filter(name => name.startsWith('tokentracker-bot-engine-')).length;
    process.stdout.write('\\nTEMP_RESULT:' + JSON.stringify({ neighborsIntact, privateBuildsLeft }));
  `;
  const result = cp.spawnSync(process.execPath, ["-e", script, generator], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
    env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const report = JSON.parse(result.stdout.split("TEMP_RESULT:").at(-1));
  assert.deepEqual(report, { neighborsIntact: true, privateBuildsLeft: 0 });
});
