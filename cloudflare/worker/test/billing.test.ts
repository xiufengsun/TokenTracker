import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, expect, it } from "vitest";
import billingSchema from "../../migrations/0020_billing.sql?raw";
import uniqueSchema from "../../migrations/0022_waffo_unique_bindings.sql?raw";
import waffoSchema from "../../migrations/0021_waffo.sql?raw";
import { checkout } from "../src/billing-orders";
import { cancelPending, restartOrder } from "../src/billing-recovery";
import { claimGift } from "../src/billing-gifts";
import { receiveWaffoWebhook } from "../src/billing";
import { readMembership } from "../src/billing-membership";
import { waffoLedger } from "../src/billing-ledger";
import type { WaffoConfig } from "../../../dashboard/edge-patches/cloud/waffo";

const order = {
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "00000000-0000-4000-8000-000000000002",
  provider: "waffo" as const,
  environment: "sandbox" as const,
  billing_mode: "recurring" as const,
  sku: "cloud_usd_monthly",
  currency: "USD" as const,
  amount_cents: 499,
  term_months: 1,
  provider_order_id: null,
  provider_price_id: "PROD_" + "a".repeat(22),
  checkout_url: null,
  status: "pending",
  expires_at: "2027-01-01T00:00:00Z",
};
const remoteId = "ORD_" + "b".repeat(22),
  paymentId = "PAY_" + "c".repeat(22);
const rel = (hours: number) =>
  new Date(Date.now() + hours * 3600000).toISOString();
const st = (sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args);

beforeAll(async () => {
  for (const block of [billingSchema, waffoSchema, uniqueSchema])
    for (const sql of block.split(";"))
      if (sql.trim()) await env.DB.prepare(sql).run();
  await st(
    "CREATE TABLE IF NOT EXISTS tokentracker_devices(user_id TEXT,created_at TEXT)",
  ).run();
});
beforeEach(async () => {
  for (const table of [
    "billing_ledger_revision",
    ...[
      "gift_grants",
      "gift_codes",
      "gift_batches",
      "gift_attempts",
      "checkout_operations",
      "accounts",
      "events",
      "waffo_authorizations",
      "waffo_periods",
      "waffo_attempts",
      "payments",
      "subscriptions",
      "orders",
      "policy",
      "catalog",
    ].map((s) => "tokentracker_cloud_" + s),
  ]) {
    await env.DB.prepare("DELETE FROM " + table).run();
  }
  await env.DB.batch([
    st(
      "INSERT INTO tokentracker_cloud_policy VALUES ('sandbox','active','2025-01-01T00:00:00Z','hosted')",
    ),
    st(
      "INSERT INTO tokentracker_cloud_catalog VALUES('cloud_usd_monthly','USD',499,1,'recurring',1)",
    ),
    st(
      `INSERT INTO tokentracker_cloud_orders(id,user_id,environment,request_id,provider,sku,currency,amount_cents,term_months,
      status,provider_price_id,billing_mode,created_at,expires_at) VALUES(?,?,'sandbox',?,'waffo','cloud_usd_monthly','USD',499,1,'pending',?,'recurring',?,?)`,
      order.id,
      order.user_id,
      crypto.randomUUID(),
      order.provider_price_id,
      rel(-24),
      rel(1),
    ),
  ]);
});
const membership = () => readMembership(env.DB, order.user_id, "sandbox");

it("keeps grants from extending across refunded or unpurchased gaps", async () => {
  expect((await membership()).status).toBe("free");
  const payment = (id: string, start: number, end: number, refund: number) =>
    st(
      `INSERT INTO tokentracker_cloud_payments
    (id,order_id,user_id,provider,environment,transaction_id,currency,amount_cents,refunded_cents,starts_at,ends_at,paid_at)
    VALUES(?,?,?,'waffo','sandbox',?,'USD',499,?,?,?,?)`,
      id,
      order.id,
      order.user_id,
      id,
      refund,
      rel(start),
      rel(end),
      rel(-1),
    );
  await env.DB.batch([
    payment("a", -24, 24, 0),
    payment("b", 12, 35, 0),
    payment("c", 32, 60, 499),
    payment("d", 48, 72, 0),
  ]);
  const m = await membership();
  expect(m.status).toBe("active");
  expect(m.access_source).toBe("payment");
  expect(m.machine_limit).toBe(99);
  expect(Date.parse(m.expires_at!) - Date.now()).toBeCloseTo(35 * 3600000, -3);
  expect(
    (await readMembership(env.DB, "other", "sandbox")).can_read_cloud,
  ).toBe(false);
});

it("records provider-confirmed charges once, rejects changed evidence, and preserves lifecycle ordering", async () => {
  const ledger = waffoLedger(env.DB, order);
  const start = rel(-24),
    end = rel(24);
  const base = {
    p_order_id: order.id,
    p_environment: "sandbox",
    p_waffo_order_id: remoteId,
    p_provider_price_id: order.provider_price_id,
  };
  await ledger.call("cloud_register_waffo_attempt", {
    ...base,
    p_billing_mode: "recurring",
  });
  await ledger.call("cloud_record_waffo_period", {
    ...base,
    p_period_number: 1,
    p_starts_at: start,
    p_ends_at: end,
  });
  expect((await membership()).can_upload_cloud).toBe(false);
  const common = {
    order_id: order.id,
    subscription_id: remoteId,
    waffo_order_id: remoteId,
    provider_price_id: order.provider_price_id,
  };
  const auth = {
    ...common,
    kind: "authorization",
    event_id: "auth",
    action_id: "PAY_auth",
    transaction_id: "PAY_auth",
    currency: "USD",
    period_number: 0,
    amount_cents: 0,
    base_amount_cents: 499,
    occurred_at: start,
  };
  await ledger.call("cloud_record_waffo_authorization", {
    p_environment: "sandbox",
    p_event: auth,
  });
  expect((await membership()).can_upload_cloud).toBe(false);
  const pay = {
    ...common,
    event_id: "first",
    kind: "payment",
    action_id: paymentId,
    transaction_id: paymentId,
    period_number: 1,
    starts_at: start,
    ends_at: end,
    currency: "USD",
    base_amount_cents: 499,
    amount_cents: 499,
    occurred_at: start,
  };
  const apply = (...entries: unknown[]) =>
    ledger.call("cloud_apply_waffo_events", {
      p_environment: "sandbox",
      p_events: entries,
    });
  const badRefund = {
    ...common,
    event_id: "cannot-commit",
    kind: "refund",
    action_id: "REF_bad",
    transaction_id: paymentId,
    currency: "USD",
    amount_cents: 500,
    occurred_at: start,
  };
  await expect(apply(pay, badRefund)).rejects.toThrow(
    "payment_evidence_conflict",
  );
  expect(
    await st("SELECT count(*) n FROM tokentracker_cloud_events").first("n"),
  ).toBe(0);
  expect((await membership()).can_upload_cloud).toBe(false);
  await Promise.all([apply(pay), apply(pay)]);
  expect(
    await st("SELECT count(*) AS n FROM tokentracker_cloud_payments").first(
      "n",
    ),
  ).toBe(1);
  expect((await membership()).access_source).toBe("payment");
  await expect(apply({ ...pay, amount_cents: 999 })).rejects.toThrow(
    "payment_evidence_conflict",
  );
  const cancel = {
    ...common,
    event_id: "cancel",
    kind: "subscription",
    action_id: "cancel",
    status: "canceled",
    occurred_at: rel(-1),
  };
  await apply(cancel, {
    ...cancel,
    event_id: "old",
    action_id: "old",
    status: "active",
    occurred_at: rel(-2),
  });
  expect(
    await st("SELECT status FROM tokentracker_cloud_subscriptions").first(
      "status",
    ),
  ).toBe("canceled");
  expect((await membership()).can_upload_cloud).toBe(true);
  const refund = {
    ...common,
    event_id: "refund",
    kind: "refund",
    action_id: "REF_x",
    transaction_id: paymentId,
    currency: "USD",
    amount_cents: 499,
    occurred_at: rel(-0.5),
  };
  await apply(refund, refund);
  expect((await membership()).status).toBe("expired");
  expect(
    await st("SELECT refunded_cents FROM tokentracker_cloud_payments").first(
      "refunded_cents",
    ),
  ).toBe(499);
  expect(
    await st(
      "SELECT status FROM tokentracker_cloud_events WHERE event_id='old'",
    ).first("status"),
  ).toBe("outdated");
});

it("verifies the original signed Waffo protocol and requires provider confirmation", async () => {
  const rsa = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pem = (part: string, raw: ArrayBuffer) =>
    `-----BEGIN ${part} KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(raw)))}\n-----END ${part} KEY-----`;
  const config: WaffoConfig = {
    environment: "sandbox",
    storeId: "STO_" + "s".repeat(22),
    merchantId: "MER_" + "m".repeat(22),
    privateKey: pem(
      "PRIVATE",
      (await crypto.subtle.exportKey("pkcs8", rsa.privateKey)) as ArrayBuffer,
    ),
    productIds: { cloud_usd_monthly: order.provider_price_id },
    checkoutPage: "https://www.tokentracker.cc/billing/checkout",
    webhookPublicKey: {
      test: pem(
        "PUBLIC",
        (await crypto.subtle.exportKey("spki", rsa.publicKey)) as ArrayBuffer,
      ),
    },
  };
  const start = rel(-2),
    end = rel(22);
  const money = { amount: "499", currency: "USD", display: "4.99" };
  const totals = {
    currency: "USD",
    subtotal: "4.99",
    taxAmount: "0.00",
    total: "4.99",
    taxCategory: "saas",
  };
  const remote = {
    id: remoteId,
    storeId: config.storeId,
    status: "active",
    testMode: true,
    currency: "USD",
    orderMerchantExternalId: order.id,
    metadata: JSON.stringify({
      tokentracker_order_id: order.id,
      tokentracker_user_id: order.user_id,
      tokentracker_environment: "sandbox",
    }),
    createdAt: start,
    updatedAt: rel(-1),
    productVersion: {
      id: "VER_" + "v".repeat(22),
      productId: order.provider_price_id,
      prices: [
        {
          currency: "USD",
          priceInfo: { amount: "4.99", taxCategory: "saas", trialAmount: null },
        },
      ],
      metadata: "{}",
      billingPeriod: "monthly",
    },
    priceSnapshot: {
      currency: "USD",
      regularPhase: totals,
      specialPhase: null,
      specialPhaseDays: null,
    },
    billingPeriod: "monthly",
    isInTrial: false,
    willRenew: true,
    changeOriginOrderId: null,
    supersededByOrderId: null,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    currentPeriodNumber: 1,
    payments: [
      {
        id: paymentId,
        orderId: remoteId,
        status: "succeeded",
        testMode: true,
        orderMerchantExternalId: order.id,
        createdAt: start,
        periodNumber: 1,
        amount: money,
        snapshotAmountDetails: { ...totals, phase: "regular" },
        pspAmountDetails: { currency: "USD", amount: "4.99" },
        refunds: [],
      },
    ],
  };
  const timestamp = String(Date.now());
  const payload = JSON.stringify({
    id: "n1",
    eventId: "e1",
    mode: "test",
    storeId: config.storeId,
    eventType: "subscription.payment_succeeded",
    timestamp: new Date().toISOString(),
    data: { orderMerchantExternalId: order.id, orderId: remoteId, paymentId },
  });
  const signed = async (raw: string, transmitted = raw) => {
    const bytes = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      rsa.privateKey,
      new TextEncoder().encode(timestamp + "." + raw),
    );
    return new Request("https://test.local/webhook", {
      method: "POST",
      body: transmitted,
      headers: {
        "x-waffo-signature": `t=${timestamp},v1=${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`,
      },
    });
  };
  let paid = false,
    calls = 0;
  const provider: typeof fetch = async (input, init) => {
    expect(String(input)).toMatch(/^https:\/\/api.waffo.ai\//);
    expect(new Headers(init?.headers).get("X-Merchant-Id")).toBe(
      config.merchantId,
    );
    calls++;
    return Response.json({
      data: {
        subscriptionOrdersCount: 1,
        subscriptionOrders: [paid ? remote : { ...remote, payments: [] }],
      },
    });
  };
  await expect(
    receiveWaffoWebhook(
      await signed(payload, payload + " "),
      env.DB,
      config,
      provider,
    ),
  ).rejects.toThrow("invalid_signature");
  const otherStore = JSON.stringify({
    ...JSON.parse(payload),
    storeId: "STO_" + "x".repeat(22),
  });
  await expect(
    receiveWaffoWebhook(await signed(otherStore), env.DB, config, provider),
  ).rejects.toThrow("payment_environment_mismatch");
  const otherMode = JSON.stringify({ ...JSON.parse(payload), mode: "prod" });
  await expect(
    receiveWaffoWebhook(await signed(otherMode), env.DB, config, provider),
  ).rejects.toThrow();
  await st(
    "INSERT INTO tokentracker_cloud_policy VALUES ('live','active','2025-01-01T00:00:00Z','hosted')",
  ).run();
  const liveId = crypto.randomUUID();
  await st(
    `INSERT INTO tokentracker_cloud_orders(id,user_id,environment,request_id,provider,sku,currency,amount_cents,term_months,
    status,provider_price_id,billing_mode,created_at,expires_at) SELECT ?,user_id,'live',request_id,provider,sku,currency,
    amount_cents,term_months,status,provider_price_id,billing_mode,created_at,expires_at FROM tokentracker_cloud_orders WHERE id=?`,
    liveId,
    order.id,
  ).run();
  const otherOrder = JSON.stringify({
    ...JSON.parse(payload),
    data: { ...JSON.parse(payload).data, orderMerchantExternalId: liveId },
  });
  await expect(
    receiveWaffoWebhook(await signed(otherOrder), env.DB, config, provider),
  ).rejects.toThrow("order_not_found");
  expect(calls).toBe(0);
  await expect(
    receiveWaffoWebhook(await signed(payload), env.DB, config, provider),
  ).rejects.toThrow("waffo_notification_pending");
  expect((await membership()).status).toBe("free");
  paid = true;
  expect(
    (await receiveWaffoWebhook(await signed(payload), env.DB, config, provider))
      .status,
  ).toBe(200);
  expect(
    (await receiveWaffoWebhook(await signed(payload), env.DB, config, provider))
      .status,
  ).toBe(200);
  expect(
    await st("SELECT count(*) AS n FROM tokentracker_cloud_payments").first(
      "n",
    ),
  ).toBe(1);
  expect((await membership()).can_read_cloud).toBe(true);
});

it("replays a lost checkout response with the same provider key, expiry and operation receipt", async () => {
  const rsa = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pk = (await crypto.subtle.exportKey(
    "pkcs8",
    rsa.privateKey,
  )) as ArrayBuffer;
  const cfg: WaffoConfig = {
    environment: "sandbox",
    merchantId: "MER_" + "m".repeat(22),
    storeId: "STO_" + "s".repeat(22),
    privateKey:
      "-----BEGIN PRIVATE KEY-----\n" +
      btoa(String.fromCharCode(...new Uint8Array(pk))) +
      "\n-----END PRIVATE KEY-----",
    productIds: { [order.sku]: order.provider_price_id },
    checkoutPage: "https://www.tokentracker.cc/billing/checkout",
  };
  const request = String(
    await st(
      "SELECT request_id FROM tokentracker_cloud_orders WHERE id=?",
      order.id,
    ).first("request_id"),
  );
  const keys: string[] = [];
  const expiresAt = rel(0.25),
    sessionId = "cs_1234";
  const provider: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/graphql")
      return Response.json({
        data: {
          subscriptionProduct: {
            id: order.provider_price_id,
            storeId: cfg.storeId,
            status: "active",
            metadata: "{}",
            billingPeriod: "monthly",
            prices: [
              {
                currency: "USD",
                priceInfo: {
                  amount: "4.99",
                  taxCategory: "saas",
                  trialAmount: null,
                },
              },
            ],
          },
        },
      });
    expect(path).toBe("/v1/actions/checkout/create-session");
    keys.push(String(new Headers(init?.headers).get("X-Idempotency-Key")));
    if (keys.length === 1) return new Response(null, { status: 502 });
    return Response.json({
      data: {
        sessionId,
        expiresAt,
        checkoutUrl:
          "https://pancake.waffo.ai/store/test/checkout/" + sessionId,
      },
    });
  };
  expect(
    (await checkout(env.DB, order.user_id, cfg, order.sku, request, provider))
      .status,
  ).toBe(202);
  expect(
    (await checkout(env.DB, order.user_id, cfg, order.sku, request, provider))
      .status,
  ).toBe(200);
  expect(
    (await checkout(env.DB, order.user_id, cfg, order.sku, request, provider))
      .status,
  ).toBe(200);
  expect(keys).toEqual(
    Array(2).fill("tokentracker-sandbox-checkout-" + order.id),
  );
  expect(
    await st(
      "SELECT expires_at FROM tokentracker_cloud_orders WHERE id=?",
      order.id,
    ).first("expires_at"),
  ).toBe(expiresAt);
  expect(
    await st(
      "SELECT sum(uncertain) n FROM tokentracker_cloud_checkout_operations WHERE order_id=?",
      order.id,
    ).first("n"),
  ).toBe(1);
  expect(
    await st(
      "SELECT count(*) n FROM tokentracker_cloud_checkout_operations WHERE finished_at IS NULL",
    ).first("n"),
  ).toBe(0);
});

it("enforces pending order, single-use gift and owner-scoped redemption", async () => {
  const code = "TTPRO" + "A".repeat(32);
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await env.DB.batch([
    st(
      "INSERT INTO tokentracker_cloud_gift_batches VALUES('batch','sandbox',30,?,'QA',?,NULL)",
      rel(24),
      rel(-1),
    ),
    st(
      "INSERT INTO tokentracker_cloud_gift_codes VALUES('code','batch','sandbox',?,'AAAAAAAA')",
      hash,
    ),
  ]);
  const cfg: WaffoConfig = {
    environment: "sandbox",
    storeId: "",
    merchantId: "",
    privateKey: "",
    productIds: {},
    checkoutPage: "",
  };
  const request = crypto.randomUUID();
  expect(
    (await claimGift(env.DB, order.user_id, cfg, code, request)).data.error,
  ).toBe("gift_checkout_pending");
  const cancellation = await cancelPending(
    env.DB,
    order.user_id,
    cfg,
    order.id,
  );
  expect(cancellation.data.cancellation).toBe("cancelled");
  expect(
    (await claimGift(env.DB, order.user_id, cfg, code, request)).status,
  ).toBe(200);
  expect(
    (await claimGift(env.DB, order.user_id, cfg, code, request)).data
      .already_redeemed,
  ).toBe(true);
  expect((await membership()).access_source).toBe("gift");
  expect(
    (await claimGift(env.DB, "another", cfg, code, crypto.randomUUID())).data
      .error,
  ).toBe("gift_code_unavailable");
  expect(
    await st("SELECT count(*) n FROM tokentracker_cloud_gift_grants").first(
      "n",
    ),
  ).toBe(1);
});

it("restarts an expired unused session once and binds concurrent charge callbacks to their original retry chain", async () => {
  const rsa = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pk = (await crypto.subtle.exportKey(
    "pkcs8",
    rsa.privateKey,
  )) as ArrayBuffer;
  const config: WaffoConfig = {
    environment: "sandbox",
    merchantId: "MER_" + "m".repeat(22),
    storeId: "STO_" + "s".repeat(22),
    privateKey:
      "-----BEGIN PRIVATE KEY-----\n" +
      btoa(String.fromCharCode(...new Uint8Array(pk))) +
      "\n-----END PRIVATE KEY-----",
    productIds: { [order.sku]: order.provider_price_id },
    checkoutPage: "https://www.tokentracker.cc/billing/checkout",
  };
  const retryRequest = crypto.randomUUID();
  const provider: typeof fetch = async (input, init) => {
    expect(new URL(String(input)).pathname).toBe("/v1/graphql");
    expect(JSON.parse(String(init?.body)).variables.ref).toBe(order.id);
    return Response.json({
      data: { subscriptionOrders: [], subscriptionOrdersCount: 0 },
    });
  };
  await st(
    "UPDATE tokentracker_cloud_orders SET expires_at=? WHERE id=?",
    rel(-2),
    order.id,
  ).run();
  const reopen = () =>
    restartOrder(
      env.DB,
      order.user_id,
      config,
      order.id,
      retryRequest,
      provider,
    );
  const [first, second] = await Promise.all([reopen(), reopen()]);
  expect(first.id).toBe(second.id);
  expect(first.request_id).toBe(retryRequest);
  expect((await reopen()).id).toBe(first.id);
  expect(
    await st(
      "SELECT status FROM tokentracker_cloud_orders WHERE id=?",
      order.id,
    ).first("status"),
  ).toBe("closed");
  expect(
    await st("SELECT count(*) n FROM tokentracker_cloud_orders").first("n"),
  ).toBe(2);
  const successor = await st(
    "SELECT * FROM tokentracker_cloud_orders WHERE id=?",
    first.id,
  ).first<typeof order>();
  expect(successor).toBeTruthy();
  await st(
    "UPDATE tokentracker_cloud_orders SET checkout_attempts=1 WHERE id=?",
    first.id,
  ).run();
  const ledger = waffoLedger(env.DB, order),
    start = rel(-6),
    end = rel(6);
  const args = {
    p_order_id: order.id,
    p_environment: "sandbox",
    p_waffo_order_id: remoteId,
    p_provider_price_id: order.provider_price_id,
  };
  await ledger.call("cloud_register_waffo_attempt", {
    ...args,
    p_billing_mode: "recurring",
  });
  await ledger.call("cloud_record_waffo_period", {
    ...args,
    p_period_number: 1,
    p_starts_at: start,
    p_ends_at: end,
  });
  const late = {
    order_id: order.id,
    kind: "payment",
    event_id: "late",
    action_id: paymentId,
    transaction_id: paymentId,
    subscription_id: remoteId,
    waffo_order_id: remoteId,
    provider_price_id: order.provider_price_id,
    period_number: 1,
    currency: "USD",
    starts_at: start,
    ends_at: end,
    occurred_at: start,
    base_amount_cents: 499,
    amount_cents: 499,
  };
  await ledger.call("cloud_apply_waffo_events", {
    p_environment: "sandbox",
    p_events: [late],
  });
  expect(
    await st(
      "SELECT count(*) n FROM tokentracker_cloud_orders WHERE retry_payment_conflict_at IS NOT NULL",
    ).first("n"),
  ).toBe(2);
  expect(
    await st("SELECT order_id FROM tokentracker_cloud_payments").first(
      "order_id",
    ),
  ).toBe(order.id);
  expect((await membership()).status).toBe("active");
});
