const test = require("node:test");
const assert = require("node:assert/strict");
const { waffoCheckoutVerified } = require("./helpers/load-cloud-module")("runtime");

test("only an explicitly verified, launched live checkout may trigger purchase prompts", () => {
  const previous = global.Deno;
  const env = { TOKENTRACKER_BILLING_ENVIRONMENT: "live" };
  global.Deno = { env: { get: key => env[key] } };
  const now = Date.parse("2026-10-08T00:00:00Z");
  const policy = { phase: "active", launch_at: "2026-10-07T00:00:00Z" };
  try {
    assert.equal(waffoCheckoutVerified(policy, true, now), false);
    env.TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED = "true";
    assert.equal(waffoCheckoutVerified(policy, true, now), true);
    assert.equal(waffoCheckoutVerified(policy, false, now), false);
    assert.equal(waffoCheckoutVerified({ ...policy, phase: "preview" }, true, now), false);
    assert.equal(waffoCheckoutVerified({ ...policy, launch_at: "2026-10-09T00:00:00Z" }, true, now), false);
    for (const launch_at of [null, undefined, "not-a-date"]) {
      assert.equal(waffoCheckoutVerified({ ...policy, launch_at }, true, now), false);
    }
    env.TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED = "1";
    assert.equal(waffoCheckoutVerified(policy, true, now), false);
    env.TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED = "true";
    env.TOKENTRACKER_BILLING_ENVIRONMENT = "sandbox";
    assert.equal(waffoCheckoutVerified(policy, true, now), false);
  } finally {
    global.Deno = previous;
  }
});
