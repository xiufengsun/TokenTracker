// Uses the migration QA owner only. A sandbox checkout session is created; no payment is submitted.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const qa = JSON.parse(readFileSync(process.argv[2], "utf8"));
const origin =
  "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev";
assert.equal(qa.TT_QA_BASE_URL, origin);
const endpoint = "/functions/tokentracker-billing?action=";
let token, refresh;
async function api(path, body, auth = true) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(auth && token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw Error(
      "QA " +
        path.split("&")[0] +
        " HTTP " +
        response.status +
        " " +
        String(data.error).slice(0, 100),
    );
  return data;
}
const catalog = await api(endpoint + "catalog");
assert.equal(catalog.environment, "sandbox");
assert.equal(catalog.providers.waffo, true);
const sku = "cloud_usd_monthly";
const plan = catalog.prices.find((item) => item.sku === sku);
assert.ok(plan && plan.currency === "USD" && plan.billing_mode === "recurring");
try {
  const login = await api(
    "/api/auth/sessions?client_type=mobile",
    { email: qa.TT_QA_EMAIL, password: qa.TT_QA_PASSWORD },
    false,
  );
  assert.ok(
    login.user?.id &&
      login.user.id === qa.TT_QA_ID &&
      typeof login.accessToken === "string",
  );
  token = login.accessToken;
  refresh = login.refreshToken;
  const before = await api(endpoint + "account");
  assert.equal(before.environment, "sandbox");
  assert.equal(before.payments.length, 0);
  const request = {
    provider: "waffo",
    sku,
    request_id: "aef46322-d2c4-452c-a548-fdd95c27597c",
  };
  const first = await api(endpoint + "checkout", request);
  assert.ok(first.order?.checkout_url, "Provider session receipt missing");
  const url = new URL(first.order.checkout_url);
  assert.ok(
    url.origin === "https://pancake.waffo.ai" &&
      url.searchParams.get("test") === "true",
  );
  const replay = await api(endpoint + "checkout", request);
  assert.ok(
    first.order.id === replay.order.id &&
      replay.order.checkout_url === url.href,
    "Idempotency mismatch",
  );
  const state = await api(
    endpoint + "order&id=" + encodeURIComponent(first.order.id),
  );
  assert.equal(state.order.status, "ready");
  assert.equal(state.order.payment_state, "unpaid");
  const reconciliation = await api(endpoint + "reconcile", {
    id: first.order.id,
  });
  assert.equal(reconciliation.confirmed, false);
  const after = await api(endpoint + "account");
  assert.equal(after.payments.length, 0);
  assert.equal(before.membership.status, after.membership.status);
  console.log(
    JSON.stringify({
      environment: catalog.environment,
      sku,
      amount_cents: plan.amount_cents,
      order_fingerprint: createHash("sha256")
        .update(first.order.id)
        .digest("hex")
        .slice(0, 16),
      checkout_host: url.host,
      checkout_test: true,
      status: state.order.status,
      payment_state: state.order.payment_state,
      replay_same_receipt: true,
      reconciled: reconciliation.confirmed,
      payments_before: 0,
      payments_after: 0,
      membership: after.membership.status,
      ran_at: new Date().toISOString(),
    }),
  );
} finally {
  if (refresh)
    await api(
      "/api/auth/logout?client_type=mobile",
      { refreshToken: refresh },
      false,
    );
}
