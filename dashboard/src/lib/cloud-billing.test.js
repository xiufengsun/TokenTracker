import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloudAnnualSavings,
  cloudBillingRequest,
  cloudCheckoutLaunched,
  CloudBillingError,
} from "./cloud-billing";
import {
  clearCloudPurchase,
  cloudOrderState,
  getCloudPurchaseRequest,
  getCloudCheckoutRestartRequest,
  readCloudPurchase,
  saveCloudPurchase,
} from "./cloud-checkout.js";

const token = `${btoa(JSON.stringify({ alg: "HS256" })).replace(/=+$/, "")}.${btoa(JSON.stringify({ sub: "account-1" })).replace(/=+$/, "")}.test`;
const orderId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Cloud billing API", () => {
  it("does not treat a rejected RPC in a 200 response as a completed mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ ok: false, code: "cloud_machine_limit" }),
            { status: 200 },
          ),
        ),
    );
    await expect(
      cloudBillingRequest("resume-device", {
        auth: token,
        body: { machine_id: orderId },
      }),
    ).rejects.toMatchObject({ code: "cloud_machine_limit" });
  });
  it("requires a user JWT before reaching any account or checkout endpoint", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(cloudBillingRequest("account")).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
    await expect(
      cloudBillingRequest("checkout", { auth: "anonymous-key", body: {} }),
    ).rejects.toBeInstanceOf(CloudBillingError);
    expect(request).not.toHaveBeenCalled();
  });
  it("loads the catalog publicly and adds the current JWT to user requests", async () => {
    const request = vi.fn().mockImplementation(
      () =>
        new Response(JSON.stringify({ membership: { status: "free" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", request);
    await cloudBillingRequest("catalog");
    expect(request.mock.calls[0][1].headers.Authorization).toBeUndefined();
    await cloudBillingRequest("account", { auth: async () => token });
    expect(request.mock.calls[1][1].headers.Authorization).toBe(
      `Bearer ${token}`,
    );
  });
  it("keeps the server order in a 202 ambiguous provider response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            order: { id: orderId },
            pending: true,
            error: "checkout_confirmation_pending",
          }),
          { status: 202 },
        ),
      ),
    );
    expect(
      await cloudBillingRequest("checkout", {
        auth: token,
        body: { request_id: orderId },
      }),
    ).toMatchObject({ order: { id: orderId }, pending: true });
  });
  it("reports server errors and network failures without inventing success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "order_not_found" }), {
          status: 404,
        }),
      ),
    );
    await expect(
      cloudBillingRequest("order", { auth: token, params: { id: orderId } }),
    ).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(
      cloudBillingRequest("checkout", { auth: token, body: {} }),
    ).rejects.toMatchObject({ code: "billing_network_error" });
  });
});

describe("purchase recovery and server state", () => {
  it("persists only purchase recovery fields, excluding credentials and account details", () => {
    saveCloudPurchase("account-1", {
      sku: "cloud_usd_monthly", provider: "waffo", request_id: orderId,
      userId: "account-2", email: "private@example.invalid", password: "private-password",
      accessToken: "private-access-token", refreshToken: "private-refresh-token",
      checkout_url: "https://checkout.example/?session=private",
      nested: { authorization: "private-authorization" },
    });
    expect(localStorage.length).toBe(1);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)))).toEqual({
      sku: "cloud_usd_monthly", provider: "waffo", request_id: orderId,
    });
    expect(readCloudPurchase("account-1")).toMatchObject({ userId: "account-1", request_id: orderId });
    expect(readCloudPurchase("account-2")).toBeNull();
  });
  it("filters legacy cache extras and refuses a mismatched legacy owner", () => {
    saveCloudPurchase("account-1", { sku: "cloud_usd_monthly", request_id: orderId });
    const key = localStorage.key(0);
    localStorage.setItem(key, JSON.stringify({ userId: "account-1", request_id: orderId, password: "private-password" }));
    expect(readCloudPurchase("account-1")).toEqual({ userId: "account-1", request_id: orderId });
    localStorage.setItem(key, JSON.stringify({ userId: "account-2", request_id: orderId }));
    expect(readCloudPurchase("account-1")).toBeNull();
  });
  it("keeps one restart request bound to the owned unpaid order and account", () => {
    const order = { id: orderId, sku: "cloud_usd_yearly", provider: "waffo" };
    const first = getCloudCheckoutRestartRequest("account-1", order);
    expect(first.retry_order_id).toBe(orderId);
    expect(getCloudCheckoutRestartRequest("account-1", order).retry_request_id).toBe(first.retry_request_id);
    expect(readCloudPurchase("account-2")).toBeNull();
    expect(() => getCloudCheckoutRestartRequest("account-1", { ...order, id: "another-order" }))
      .toThrow("checkout_request_conflict");
    clearCloudPurchase("account-1");
    getCloudPurchaseRequest("account-1", "cloud_usd_monthly", "waffo");
    expect(() => getCloudCheckoutRestartRequest("account-1", order)).toThrow("checkout_request_conflict");
  });
  it("reuses one request identity across retries and refuses to replace an unresolved purchase", () => {
    const first = getCloudPurchaseRequest(
      "account-1",
      "cloud_usd_yearly_fixed",
      "waffo",
    );
    expect(
      getCloudPurchaseRequest("account-1", "cloud_usd_yearly_fixed", "waffo")
        .request_id,
    ).toBe(first.request_id);
    expect(() =>
      getCloudPurchaseRequest("account-1", "cloud_usd_monthly_fixed", "waffo"),
    ).toThrow("checkout_request_conflict");
    saveCloudPurchase("account-1", { ...first, order_id: orderId });
    expect(readCloudPurchase("account-2")).toBeNull();
    expect(readCloudPurchase("account-1")?.order_id).toBe(orderId);
    clearCloudPurchase("account-1");
    expect(
      getCloudPurchaseRequest("account-1", "cloud_usd_yearly_fixed", "waffo")
        .request_id,
    ).not.toBe(first.request_id);
  });
  it("uses server order and membership rather than checkout redirects", () => {
    expect(cloudOrderState({ status: "paid", payment_state: "refunded" }, { status: "active" })).toBe("refunded");
    expect(
      cloudOrderState(
        { status: "ready", checkout_url: "https://checkout.example" },
        { status: "active" },
      ),
    ).toBe("awaiting");
    expect(cloudOrderState({ status: "paid" }, { status: "free" })).toBe(
      "activating",
    );
    expect(cloudOrderState({ status: "paid" }, { status: "active" })).toBe(
      "success",
    );
    expect(cloudOrderState({ status: "paid" }, { status: "expired" })).toBe(
      "expired",
    );
    expect(cloudOrderState({ status: "closed" }, { status: "free" })).toBe(
      "canceled",
    );
    expect(
      cloudOrderState(
        { status: "ready", expires_at: "2000-01-01" },
        { status: "free" },
      ),
    ).toBe("expired");
  });
  it("calculates actual annual discounts and requires an active, reached launch date", () => {
    for (const billing_mode of ["recurring", "fixed"]) {
      expect(cloudAnnualSavings(
        { currency: "USD", amount_cents: 499, term_months: 1, sku: "month", billing_mode },
        { currency: "USD", amount_cents: 3999, term_months: 12, sku: "year", billing_mode },
      )).toBe(33);
    }
    expect(
      cloudCheckoutLaunched({
        policy: { phase: "preview", launch_at: "2000-01-01" },
      }),
    ).toBe(false);
    expect(
      cloudCheckoutLaunched({
        policy: { phase: "active", launch_at: "2099-01-01" },
      }),
    ).toBe(false);
    expect(
      cloudCheckoutLaunched({
        policy: { phase: "active", launch_at: "2000-01-01" },
      }),
    ).toBe(true);
  });
});
