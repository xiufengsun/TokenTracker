// Verify the final sandbox refund using the merchant delivery log and the owner’s billing account.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WaffoPancake } from "@waffo/pancake-ts";
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const [qa, config, targetOrder] = process.argv.slice(2).map(load);
const base =
  "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev";
assert.equal(qa.TT_QA_BASE_URL, base);
const target = base + "/functions/tokentracker-waffo-webhook";
assert.equal(qa.TT_QA_BASE_URL, base);
const sdk = new WaffoPancake({
  environment: "test",
  merchantId: config.WAFFO_MERCHANT_ID,
  privateKey: config.WAFFO_PRIVATE_KEY,
  fetch: async (input, init) => {
    assert.equal(new URL(input).origin, "https://api.waffo.ai");
    assert.equal(new URL(input).pathname, "/v1/graphql");
    const headers = new Headers(init.headers);
    headers.set("X-Environment", "test");
    return fetch(input, { ...init, headers, redirect: "error" });
  },
});
let token, refresh;
async function api(path, data) {
  const res = await fetch(base + path, {
    method: data ? "POST" : "GET",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.ok(res.ok, "QA account HTTP " + res.status);
  return res.json();
}
try {
  const session = await api("/api/auth/sessions?client_type=mobile", {
    email: qa.TT_QA_EMAIL,
    password: qa.TT_QA_PASSWORD,
  });
  assert.equal(session.user?.id, qa.TT_QA_ID);
  token = session.accessToken;
  refresh = session.refreshToken;
  const order = await api(
    "/functions/tokentracker-billing?action=order&id=" +
      encodeURIComponent(targetOrder.tt_order),
  );
  const account = await api("/functions/tokentracker-billing?action=account");
  const res = await sdk.graphql.query({
    query: `query ($storeId:String!) { webhookDeliveries(storeId:$storeId,limit:100){eventType payload webhookUrl status httpStatus attemptCount lastAttemptedAt} }`,
    variables: { storeId: config.WAFFO_STORE_ID },
  });
  assert.ok(
    Array.isArray(res.data?.webhookDeliveries),
    "Missing Waffo deliveries",
  );
  const deliveries = res.data.webhookDeliveries
    .filter((e) => {
      const body =
        typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload;
      return (
        e.webhookUrl === target &&
        body?.mode === "test" &&
        body?.data?.orderMerchantExternalId === targetOrder.tt_order
      );
    })
    .map((e) => ({
      event: e.eventType,
      status: e.status,
      http: e.httpStatus,
      attempts: e.attemptCount,
    }));
  assert.equal(account.environment, "sandbox");
  assert.equal(order.order.payment_state, "refunded");
  assert.equal(account.membership.status, "expired");
  assert.equal(account.membership.access_source, "none");
  assert.equal(account.membership.can_upload_cloud, false);
  assert.equal(account.payments.length, 1);
  assert.deepEqual(
    [
      account.payments[0].currency,
      account.payments[0].amount_cents,
      account.payments[0].refunded_cents,
    ],
    ["USD", 499, 499],
  );
  assert.equal(account.subscriptions.length, 1);
  assert.equal(account.subscriptions[0].cancel_at_period_end, true);
  for (const event of [
    "subscription.activated",
    "subscription.payment_succeeded",
    "subscription.canceling",
    "refund.succeeded",
  ]) {
    assert.ok(
      deliveries.some(
        (x) => x.event === event && x.status === "success" && x.http === 200,
      ),
      "Missing successful sandbox delivery for " + event,
    );
  }
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      environment: account.environment,
      order: order.order.status,
      charge: order.order.payment_state,
      membership: account.membership.status,
      source: account.membership.access_source,
      read: account.membership.can_read_cloud,
      upload: account.membership.can_upload_cloud,
      payment_rows: account.payments.length,
      payment_amounts: account.payments.map((p) => ({
        currency: p.currency,
        amount: p.amount_cents,
        refunded: p.refunded_cents,
      })),
      subscriptions: account.subscriptions.map((s) => ({
        status: s.status,
        cancel_at_period_end: s.cancel_at_period_end,
      })),
      deliveries,
    }),
  );
} finally {
  if (refresh)
    await api("/api/auth/logout?client_type=mobile", { refreshToken: refresh });
}
