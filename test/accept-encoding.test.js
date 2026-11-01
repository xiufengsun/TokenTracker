const test = require("node:test");
const assert = require("node:assert/strict");
const { pickEncoding, negotiateEncoding } = require("../src/lib/accept-encoding");

test("accept-encoding picks the highest-quality supported encoding", () => {
  assert.equal(pickEncoding("gzip"), "gzip");
  assert.equal(pickEncoding("br"), "br");
  assert.equal(pickEncoding("br;q=0.4, gzip;q=0.9"), "gzip");
  assert.equal(pickEncoding("br;q=0, gzip"), "gzip");
  assert.equal(pickEncoding("gzip;q=0"), null);
  assert.equal(pickEncoding("*"), "br");
  assert.equal(pickEncoding("br;q=0, *;q=1"), "gzip");
  assert.equal(pickEncoding("gzip;q=0.5, *;q=0.9"), "br");
  assert.equal(pickEncoding("br;q=0, gzip;q=0, *;q=1"), null);
  assert.equal(pickEncoding(""), null);
});

test("accept-encoding distinguishes an explicit identity exclusion from no compression support", () => {
  assert.deepEqual(negotiateEncoding(""), { encoding: null, identityAllowed: true });
  assert.deepEqual(negotiateEncoding("gzip;q=0"), { encoding: null, identityAllowed: true });
  assert.deepEqual(negotiateEncoding("identity;q=0"), { encoding: null, identityAllowed: false });
  assert.deepEqual(negotiateEncoding("identity;q=0, gzip;q=0.5"), { encoding: "gzip", identityAllowed: false });
  assert.deepEqual(negotiateEncoding("br;q=0, *;q=0"), { encoding: null, identityAllowed: false });
  assert.deepEqual(negotiateEncoding("*;q=0, identity;q=1"), { encoding: null, identityAllowed: true });
});
