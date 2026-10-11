const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path").posix;
const { discoverDomains } = require("../scripts/graph/lib/domain-discovery.cjs");

test("discoverDomains picks known roots that exist", () => {
  const fakeFs = {
    existsSync: (p) => ["/repo/src", "/repo/packages"].includes(p),
    statSync: () => ({ isDirectory: () => true }),
  };
  const domains = discoverDomains({ rootDir: "/repo", fs: fakeFs, path });
  assert.deepEqual(domains.map((d) => d.name).sort(), ["packages", "src"]);
});
