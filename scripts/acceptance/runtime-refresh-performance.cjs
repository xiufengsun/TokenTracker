// Compare full replacement with incremental refresh using a real packaged
// runtime. Writes only inside a unique temporary directory, never user data.
// Usage: node scripts/acceptance/runtime-refresh-performance.cjs <package-root>
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { copyRuntimeTree } = require("../../src/lib/runtime-copy");

async function main() {
  if (!process.argv[2]) throw new Error("Pass a TokenTracker package directory");
  const source = path.resolve(process.argv[2]);
  const pkg = JSON.parse(await fs.readFile(path.join(source, "package.json")));
  if (pkg.name !== "tokentracker-cli") throw new Error("Expected a TokenTracker package");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tt-runtime-performance-"));
  const installed = path.join(root, "app");
  const entries = ["src", "bin", "dashboard/dist", "node_modules", "package.json"];
  try {
    const samples = [];
    for (const mode of ["full-copy", "full-replace", "incremental", "incremental"]) {
      const start = performance.now();
      if (mode.startsWith("full")) await fs.rm(installed, { recursive: true, force: true });
      for (const entry of entries) {
        const from = path.join(source, entry);
        const to = path.join(installed, entry);
        if (mode === "incremental") await copyRuntimeTree(from, to);
        else {
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.cp(from, to, { recursive: true });
        }
      }
      samples.push({ mode, elapsedMs: Math.round(performance.now() - start) });
    }
    console.log(JSON.stringify({ platform: process.platform, node: process.version, version: pkg.version, samples }, null, 2));
  } finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("tt-runtime-performance-")) {
      throw new Error("Unexpected benchmark cleanup path");
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
