const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("skill import and link fallback preserve files in Unicode home directories", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skill-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "用户资料");
  const grokHome = path.join(root, "原始技能");
  const source = path.join(grokHome, "skills", "copy-fixture");
  const files = {
    "SKILL.md": "---\nname: Copy Fixture\ndescription: Isolated test skill\n---\n",
    "references/参考.md": "complete UTF-8 fixture: 中文\n",
    "assets/nested/example.json": '{"copied":true}\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.writeFileSync(path.join(source, relative), contents);
  }
  fs.mkdirSync(home);
  const modulePath = path.resolve(__dirname, "../src/lib/skills-manager.js");
  const script = `
    const fs = require('node:fs');
    const skills = require(process.argv[1]);
    fs.symlinkSync = () => { throw Object.assign(new Error('fixture link access denied'), { code: 'EPERM' }); };
    const result = skills.importLocalSkill('copy-fixture', ['grok', 'codex']);
    process.stdout.write(JSON.stringify({ id: result.id, targets: result.targets }));
  `;
  // Keep the copy in a child: affected Node22 builds can terminate natively,
  // which must be an assertion failure rather than killing the entire suite.
  const result = cp.spawnSync(process.execPath, ["-e", script, modulePath], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
    env: {
      PATH: path.dirname(process.execPath),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      TMP: root,
      TEMP: root,
      TOKENTRACKER_GROK_HOME: grokHome,
    },
  });
  assert.equal(result.status, 0, `isolated skill copy exited ${result.status}: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { id: "local:copy-fixture", targets: ["grok", "codex"] });
  const managed = path.join(home, ".tokentracker", "skills", "managed", "copy-fixture");
  const target = path.join(home, ".codex", "skills", "copy-fixture");
  for (const dir of [source, managed, target]) {
    assert.ok(!fs.lstatSync(dir).isSymbolicLink(), "fallback produces a real directory");
    for (const [relative, contents] of Object.entries(files)) {
      assert.equal(fs.readFileSync(path.join(dir, relative), "utf8"), contents);
    }
  }
});
