const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const {
  buildOpencodePlugin,
  upsertOpencodePlugin,
  resolveOpencodePluginDir,
  PLUGIN_MARKER,
  DEFAULT_EVENT,
  DEFAULT_PLUGIN_NAME,
} = require("../src/lib/opencode-config");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOTIFY_PATH = "/Users/x/.tokentracker/bin/notify.cjs";

// Regression guard for issue #189: on Windows the OpenCode plugin spawned
// `/usr/bin/env node ...`. /usr/bin/env does not exist on Windows, so the Bun
// shell exec failed and its error message leaked into the OpenCode TUI input
// box (overwriting the user's next prompt). The plugin must invoke `node`
// directly (portable on Windows + Unix) and quiet the command so no subprocess
// output ever reaches the TUI.
test("opencode plugin does not hardcode /usr/bin/env (Windows portability)", () => {
  const plugin = buildOpencodePlugin({ notifyPath: NOTIFY_PATH });
  assert.ok(!plugin.includes("/usr/bin/env"), "plugin must not reference /usr/bin/env");
  assert.match(plugin, /\$`node \$\{notifyPath\} --source=opencode`/);
});

test("opencode plugin quiets the spawned command so output cannot leak into the TUI", () => {
  const plugin = buildOpencodePlugin({ notifyPath: NOTIFY_PATH });
  assert.match(plugin, /--source=opencode`\.quiet\(\)/);
});

test("opencode plugin keeps its identifying shape", () => {
  const plugin = buildOpencodePlugin({ notifyPath: NOTIFY_PATH });
  assert.ok(plugin.includes(PLUGIN_MARKER), "plugin must carry the marker");
  assert.ok(plugin.includes(DEFAULT_EVENT), "plugin must filter on the default event");
  assert.ok(plugin.includes(JSON.stringify(NOTIFY_PATH)), "plugin must embed the notify path");
});

// Three loaders read one generated file (issue #646). Verified against real
// binaries: opencode 1.18.30 rejects a default export that lacks server()
// ("must default export an object with server()") and rejects a default export
// without an id ("must export id"); opencode 2.x rejects the bare v1 named
// export ("Plugin must export a default definition with an id and an effect or
// setup function"). Dropping any of the three shapes below breaks one of them.
test("opencode plugin satisfies the v1 named, v1 default and v2 default loaders", () => {
  const plugin = buildOpencodePlugin({ notifyPath: NOTIFY_PATH });
  assert.match(plugin, /export const TokenTrackerPlugin = server;/, "older opencode v1 reads the named export");
  assert.match(plugin, /export default \{[\s\S]*\bid: "tokentracker",/, "both v1 and v2 require an id on the default export");
  assert.match(plugin, /export default \{[\s\S]*\bserver,/, "current v1 requires server() on the default export");
  assert.match(plugin, /export default \{[\s\S]*\bsetup: async \(\) => \{\},/, "v2 requires setup() on the default export");
  // The notify spawn must stay reachable from the v1 path; v2's PluginContext
  // has no event stream, so setup() is deliberately inert there.
  assert.match(plugin, /const server = async \(\{ \$ \}\) => \{/);
});

test("generated opencode plugin is syntactically valid ES module", () => {
  const dir = tmpDir("tokentracker-opencode-plugin-");
  const file = path.join(dir, "tokentracker.mjs");
  fs.writeFileSync(file, buildOpencodePlugin({ notifyPath: NOTIFY_PATH }), "utf8");
  // `node --check` throws on a syntax error; success means the plugin parses.
  assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", file]));
});

test("upsert regenerates a stale plugin when the builder output changes", async () => {
  const configDir = tmpDir("tokentracker-opencode-config-");
  const pluginDir = resolveOpencodePluginDir({ configDir });
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginPath = path.join(pluginDir, DEFAULT_PLUGIN_NAME);

  // Seed with the old, buggy /usr/bin/env form.
  const stale =
    `// ${PLUGIN_MARKER}\n` +
    `const notifyPath = ${JSON.stringify(NOTIFY_PATH)};\n` +
    `export const TokenTrackerPlugin = async ({ $ }) => ({\n` +
    `  event: async ({ event }) => {\n` +
    `    const proc = $\`/usr/bin/env node \${notifyPath} --source=opencode\`;\n` +
    `  }\n` +
    `});\n`;
  fs.writeFileSync(pluginPath, stale, "utf8");

  const result = await upsertOpencodePlugin({ configDir, notifyPath: NOTIFY_PATH });
  assert.equal(result.changed, true);
  const updated = fs.readFileSync(pluginPath, "utf8");
  assert.ok(!updated.includes("/usr/bin/env"), "stale /usr/bin/env plugin must be rewritten");
  assert.match(updated, /\.quiet\(\)/);

  // Second upsert is a no-op (idempotent).
  const again = await upsertOpencodePlugin({ configDir, notifyPath: NOTIFY_PATH });
  assert.equal(again.changed, false);
});
