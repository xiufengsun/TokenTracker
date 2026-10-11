const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const repoRoot = path.join(__dirname, "..");
const tsconfigPath = path.join(repoRoot, "dashboard/tsconfig.json");
const pkgPath = path.join(repoRoot, "dashboard/package.json");
const lockPath = path.join(repoRoot, "dashboard/package-lock.json");
const eslintPath = path.join(repoRoot, "dashboard/.eslintrc.cjs");

async function read(pathname) {
  return fs.readFile(pathname, "utf8");
}

function getTscCommand() {
  // Run the compiler installed by dashboard's npm ci using this test's Node.
  // execFile cannot launch npm.cmd on Windows without a shell; resolving the
  // local compiler also avoids a network/package-manager fallback in tests.
  const compiler = require.resolve("typescript/bin/tsc", {
    paths: [path.join(repoRoot, "dashboard")],
  });
  return {
    cmd: process.execPath,
    args: [
      compiler,
      "--noEmit",
      "--pretty",
      "false",
      "-p",
      "dashboard/tsconfig.json",
    ],
  };
}

test("dashboard has tsconfig", async () => {
  await read(tsconfigPath);
});

test("vite env types are declared", async () => {
  const viteEnv = await read(path.join(repoRoot, "dashboard/src/vite-env.d.ts"));
  assert.ok(viteEnv.includes("interface ImportMetaEnv"), "expected ImportMetaEnv declaration");
});

test("dashboard package defines typecheck", async () => {
  const pkg = JSON.parse(await read(pkgPath));
  assert.ok(pkg.scripts?.typecheck, "expected typecheck script");
});

test("eslint uses typescript parser", async () => {
  const eslint = await read(eslintPath);
  assert.ok(eslint.includes("@typescript-eslint/parser"));
});

test("hooks and core lib files are migrated to TS", async () => {
  for (const file of [
    "dashboard/src/hooks/use-activity-heatmap.ts",
    "dashboard/src/hooks/use-usage-data.ts",
    "dashboard/src/hooks/use-trend-data.ts",
    "dashboard/src/hooks/use-usage-model-breakdown.ts",
    "dashboard/src/lib/api.ts",
  ]) {
    await fs.readFile(path.join(repoRoot, file));
  }
});

test("lib layer is fully migrated to TS", async () => {
  const libFiles = [
    "details",
    "activity-heatmap",
    "daily",
    "api",
    "timezone",
    "config",
    "mock-data",
    "date-range",
    "copy",
    "safe-browser",
    "format",
    "model-breakdown",
    "detail-sort",
  ];

  for (const name of libFiles) {
    await fs.readFile(path.join(repoRoot, `dashboard/src/lib/${name}.ts`));
  }
});

test("tsc command uses the installed locked compiler with the current Node", async () => {
  const { cmd, args } = getTscCommand();
  const lock = JSON.parse(await read(lockPath));
  const installedPackage = require.resolve("typescript/package.json", {
    paths: [path.join(repoRoot, "dashboard")],
  });
  const installedVersion = JSON.parse(await read(installedPackage)).version;
  assert.equal(installedVersion, lock.packages["node_modules/typescript"].version);
  assert.equal(cmd, process.execPath);
  assert.equal(args[0], path.join(path.dirname(installedPackage), "bin", "tsc"));
});

test("tsc validates migrated TS files", async () => {
  const { cmd, args } = getTscCommand();
  await execFileAsync(cmd, args, { cwd: repoRoot });
});
