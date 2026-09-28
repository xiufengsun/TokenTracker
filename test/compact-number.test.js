const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadDashboardModule } = require("./helpers/load-dashboard-module");

test("formatCompactNumber rounds and carries", async () => {
  const mod = await loadDashboardModule("dashboard/src/lib/format.ts");
  const formatCompactNumber = mod.formatCompactNumber;

  assert.equal(typeof formatCompactNumber, "function");

  assert.equal(formatCompactNumber(999), "999");
  assert.equal(formatCompactNumber(1000), "1K");
  assert.equal(formatCompactNumber(1200), "1.2K");
  assert.equal(formatCompactNumber(999949), "999.9K");
  assert.equal(formatCompactNumber(999950), "1M");
  assert.equal(formatCompactNumber(1000000), "1M");
  assert.equal(formatCompactNumber(1250000), "1.3M");
  assert.equal(formatCompactNumber(999950000), "1B");
  assert.equal(formatCompactNumber(1000000000), "1B");
  assert.equal(formatCompactNumber(1250000000), "1.3B");
  assert.equal(formatCompactNumber(999949999999), "999.9B");
  assert.equal(formatCompactNumber(999950000000), "1T");
  assert.equal(formatCompactNumber(1000000000000), "1T");
  assert.equal(formatCompactNumber(98621200000000), "98.6T");
  assert.equal(formatCompactNumber(-98621200000000), "-98.6T");
  assert.equal(formatCompactNumber(98621200000000, { trillionSuffix: "Bio." }), "98.6Bio.");
});
