const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path").posix;
const { scanDomainMetrics } = require("../scripts/graph/lib/metrics.cjs");

test("scanDomainMetrics counts files and noise", () => {
  const fakeFs = {
    readdirSync: (p) => {
      if (p === "/repo/src") return ["a.ts", "fixtures"];
      if (p === "/repo/src/fixtures") return ["x.ts"];
      return [];
    },
    statSync: (p) => ({ isDirectory: () => p.endsWith("fixtures") }),
  };
  const metrics = scanDomainMetrics({
    rootDir: "/repo",
    domains: [{ name: "src", paths: ["src"] }],
    fs: fakeFs,
    path,
  });
  assert.equal(metrics[0].fileCount, 2);
  assert.equal(metrics[0].noiseCount, 1);
});

test("scanDomainMetrics skips node_modules", () => {
  const fakeFs = {
    readdirSync: (p) => {
      if (p === "/repo/src") return ["a.ts", "node_modules"];
      if (p === "/repo/src/node_modules") return ["bad.ts"];
      return [];
    },
    statSync: (p) => ({ isDirectory: () => p.endsWith("node_modules") }),
  };
  const metrics = scanDomainMetrics({
    rootDir: "/repo",
    domains: [{ name: "src", paths: ["src"] }],
    fs: fakeFs,
    path,
  });
  assert.equal(metrics[0].fileCount, 1);
});
