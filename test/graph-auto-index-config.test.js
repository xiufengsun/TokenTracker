const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path").posix;
const { loadGraphConfig } = require("../scripts/graph/lib/config.cjs");

test("loadGraphConfig collects tsconfig paths and defaults", () => {
  const fakeFs = {
    readdirSync: () => ["tsconfig.json", "tsconfig.scip.json", "README.md"],
    statSync: () => ({ isFile: () => true }),
  };
  const config = loadGraphConfig({ rootDir: "/repo", fs: fakeFs, path });
  assert.deepEqual(
    config.tsconfigPaths.sort(),
    ["/repo/tsconfig.json", "/repo/tsconfig.scip.json"].sort(),
  );
  assert.equal(config.thresholds.maxNoiseRatio, 0.15);
  assert.equal(config.thresholds.splitMinFiles, 200);
});
