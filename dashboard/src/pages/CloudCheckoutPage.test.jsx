import React from "react";
import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../lib/copy";
import { CloudCheckoutPage } from "./CloudCheckoutPage.jsx";
import { CloudPage } from "./CloudPage.jsx";
import { readCloudPurchase, saveCloudPurchase } from "../lib/cloud-checkout.js";
import { beginCloudAction, beginCloudOrderAction } from "../lib/cloud-action-intent.js";

const NumberFormat = Intl.NumberFormat;

// The decorative animation relies on browser observers; this suite verifies billing behavior.
vi.mock("@lucasmarkes/hairline/react", () => ({
  Relay: () => null,
  Plot: () => null,
  Exploded: () => null,
  Terrain: () => null,
  Laptop: () => null,
  Hub: () => null,
}));

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  refresh: vi.fn(),
  signedIn: true,
  userId: "account-1",
  phase: "active",
  environment: "sandbox",
  providers: { waffo: true, alipay: false, wechat: false, paddle: false },
  getAccessToken: vi.fn(),
  external: vi.fn(),
  pendingOrders: [],
  conflictOrders: [],
  hostingMode: "hosted",
  accountMembership: undefined,
  accountLoading: false,
  actualCatalog: false,
  accountError: null,
  subscriptions: [],
  payments: [],
  gifts: [],
  catalogPrices: undefined,
  localHost: true,
  syncOn: false,
  openLoginModal: vi.fn(),
  authLoading: false,
}));
vi.mock("../contexts/LoginModalContext.jsx", () => ({
  useLoginModal: () => ({ openLoginModal: mocks.openLoginModal }),
}));
const orderId = "11111111-1111-4111-8111-111111111111";
const successorId = "22222222-2222-4222-8222-222222222222";
const membership = { status: "free", trial_available: true };
const prices = [
  {
    sku: "cloud_usd_monthly_fixed",
    billing_mode: "fixed",
    currency: "USD",
    amount_cents: 499,
    term_months: 1,
  },
  {
    sku: "cloud_usd_yearly_fixed",
    billing_mode: "fixed",
    currency: "USD",
    amount_cents: 3999,
    term_months: 12,
  },
  {
    sku: "cloud_usd_monthly",
    billing_mode: "recurring",
    currency: "USD",
    amount_cents: 499,
    term_months: 1,
  },
  {
    sku: "cloud_usd_yearly",
    billing_mode: "recurring",
    currency: "USD",
    amount_cents: 3999,
    term_months: 12,
  },
];
vi.mock("../hooks/use-cloud-billing.js", async () => {
  const actual = await vi.importActual("../hooks/use-cloud-billing.js");
  return {
    useCloudCatalog: () => mocks.actualCatalog ? actual.useCloudCatalog() : ({
      catalog: {
        environment: mocks.environment,
        policy: { phase: mocks.phase, launch_at: "2000-01-01", hosting_mode: mocks.hostingMode },
        prices: mocks.catalogPrices || prices,
        providers: mocks.providers,
        limits: {
          machines: 99,
          sync_minutes: 15,
          hourly_history_days: 90,
          daily_history_months: 24,
          trial_days: 7,
        },
      },
      loading: false,
    }),
    useCloudAccount: () => ({
      account: { membership: mocks.hostingMode === "self_hosted"
        ? { ...membership, status: "self_hosted", hosting_mode: "self_hosted", trial_available: false, can_read_cloud: true, can_upload_cloud: true }
        : mocks.accountMembership === undefined ? membership : mocks.accountMembership,
        pending_orders: mocks.pendingOrders, conflict_orders: mocks.conflictOrders, subscriptions: mocks.subscriptions, payments: mocks.payments, gifts: mocks.gifts },
      loading: mocks.accountLoading,
      error: mocks.accountError,
      auth: {
        enabled: true,
        loading: mocks.authLoading,
        signedIn: mocks.signedIn,
        user: mocks.signedIn ? { id: mocks.userId } : null,
        getAccessToken: mocks.getAccessToken,
      },
      refresh: mocks.refresh,
    }),
  };
});
vi.mock("../lib/cloud-billing", async () => ({
  ...(await vi.importActual("../lib/cloud-billing")),
  cloudBillingRequest: mocks.request,
}));
vi.mock("../lib/cloud-checkout.js", async () => ({
  ...(await vi.importActual("../lib/cloud-checkout.js")),
  openCloudExternal: mocks.external,
}));
vi.mock("../lib/cloud-sync-prefs", async () => ({
  ...(await vi.importActual("../lib/cloud-sync-prefs")),
  isLocalDashboardHost: () => mocks.localHost,
  getCloudSyncEnabled: () => mocks.syncOn,
}));

const click = (target) =>
  act(async () => {
    await userEvent.click(target);
  });

function Location() {
  return (
    <output data-testid="location">
      {useLocation().pathname + useLocation().search}
    </output>
  );
}
function show(path, Page = CloudCheckoutPage) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Page />
      <Location />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setCopyLocale("en");
  // English copy assertions must not inherit the Windows host's currency locale.
  vi.spyOn(Intl, "NumberFormat").mockImplementation(
    (locale, options) => new NumberFormat(locale ?? "en-US", options),
  );
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  mocks.request.mockReset();
  mocks.external.mockReset();
  mocks.pendingOrders = [];
  mocks.conflictOrders = [];
  mocks.hostingMode = "hosted";
  mocks.accountMembership = undefined;
  mocks.accountLoading = false;
  mocks.actualCatalog = false;
  mocks.accountError = null;
  mocks.subscriptions = [];
  mocks.payments = [];
  mocks.gifts = [];
  mocks.catalogPrices = undefined;
  mocks.localHost = true;
  mocks.syncOn = false;
  mocks.openLoginModal.mockReset();
  mocks.authLoading = false;
  mocks.userId = "account-1";
  mocks.signedIn = true;
  mocks.phase = "active";
  mocks.environment = "sandbox";
  mocks.providers = { waffo: true, alipay: false, wechat: false, paddle: false };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, get: () => 0 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Cloud pricing and checkout", () => {
  it.each(["success", "refunded"])("refreshes shared membership once when a verified order enters %s", async (terminal) => {
    mocks.refresh.mockClear();
    let paid = false;
    const waiting = { ...prices[0], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: "https://pancake.waffo.ai/checkout" };
    mocks.request.mockImplementation(async (action) => {
      if (action !== "order") return {};
      return paid ? { order: { ...waiting, status: "paid", payment_state: terminal === "refunded" ? "refunded" : "paid" }, membership: { status: "active", expires_at: "2027-10-10" } } : { order: waiting, membership };
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("heading", { name: "Waiting for payment" });
    expect(mocks.refresh).not.toHaveBeenCalled();
    paid = true;
    fireEvent.focus(window);
    await screen.findByRole("heading", { name: terminal === "refunded" ? "This payment has been refunded" : "Your Cloud membership is active" });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    fireEvent.focus(window);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([[], [{ id: "revoked-recent", state: "revoked" }]])(
    "keeps a gift-holder's plan and checkout safe when recent history omits active access %j", (gifts) => {
      mocks.accountMembership = { status: "active", access_source: "gift", has_gift: true, trial_available: false };
      mocks.gifts = gifts;
      const view = show("/cloud", CloudPage);
      expect(screen.queryByRole("button", { name: "Subscribe to Cloud" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/settings?section=cloud");
      view.unmount();
      show("/billing/checkout?sku=cloud_usd_monthly");
      expect(screen.queryByRole("button", { name: /Continue to payment/ })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/settings?section=cloud");
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
  it.each([false, "true"])("does not block paid plans based on a non-true has_gift value %s", (hasGift) => {
    mocks.accountMembership = { status: "free", has_gift: hasGift, trial_available: false };
    mocks.gifts = [];
    const view = show("/cloud", CloudPage);
    expect(screen.getByRole("button", { name: "Subscribe to Cloud" })).toBeEnabled();
    expect(screen.queryByText(/active or upcoming Cloud gift/)).not.toBeInTheDocument();
    view.unmount();
    show("/billing/checkout?sku=cloud_usd_monthly");
    expect(screen.getByRole("button", { name: /Continue to payment/ })).toBeEnabled();
    expect(screen.queryByText(/active or upcoming Cloud gift/)).not.toBeInTheDocument();
  });
  it.each(["active", "pending"])("keeps new payments and trials unavailable while a gift is %s", (state) => {
    mocks.gifts = [{ id: "gift-1", state }];
    show("/cloud", CloudPage);
    expect(screen.getByText(/active or upcoming Cloud gift/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribe to Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try free for/ })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["/billing/checkout?sku=cloud_usd_monthly", "/billing/checkout?intent=trial"])("routes a direct gift-holder checkout to membership management %s", (path) => {
    mocks.gifts = [{ id: "gift-1", state: "pending" }];
    show(path);
    expect(screen.getByText(/active or upcoming Cloud gift/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("button", { name: /Continue to payment|Start 7-day trial/ })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("gives a stale checkout rejection a membership recovery action without losing its purchase request", async () => {
    mocks.request.mockRejectedValue({ code: "gift_membership_active" });
    show("/billing/checkout?sku=cloud_usd_monthly");
    await click(screen.getByRole("button", { name: /Continue to payment/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(/active or upcoming Cloud gift/);
    expect(screen.getByRole("link", { name: "Manage membership" })).toBeInTheDocument();
    expect(readCloudPurchase("account-1")).toMatchObject({ sku: "cloud_usd_monthly", request_id: expect.any(String) });
  });
  it("lets a signed-out desktop browser return an order reference without claiming payment or calling the order API", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    mocks.environment = "live";
    mocks.signedIn = false;
    show(`/billing/checkout?order=${orderId.toUpperCase()}`);
    expect(screen.getByRole("link", { name: "Open in TokenTracker" })).toHaveAttribute("href",
      `tokentracker://billing/return?order=${orderId}`);
    expect(screen.queryByRole("heading", { name: "Your Cloud access is ready" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("keeps the app return available on a Windows touch desktop", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
    mocks.environment = "live";
    mocks.signedIn = false;
    show(`/billing/checkout?order=${orderId}`);
    expect(screen.getByRole("link", { name: "Open in TokenTracker" })).toHaveAttribute("href",
      `tokentracker://billing/return?order=${orderId}`);
  });
  it.each(["sandbox", "native", "mobile", "tablet", "invalid", "trial", "duplicate"])("does not offer an ordinary app return for %s context", (context) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(context === "mobile" ? "iPhone" : "Macintosh");
    vi.spyOn(navigator, "platform", "get").mockReturnValue(context === "mobile" ? "iPhone" : "MacIntel");
    if (context === "tablet") vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
    mocks.environment = context === "sandbox" ? "sandbox" : "live";
    mocks.signedIn = false;
    if (context === "native") vi.stubGlobal("webkit", { messageHandlers: { nativeBridge: {} } });
    show(`/billing/checkout?order=${context === "invalid" ? "not-a-uuid" : orderId}${context === "trial" ? "&intent=trial" : context === "duplicate" ? `&order=${orderId}` : ""}`);
    expect(screen.queryByRole("link", { name: "Open in TokenTracker" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([CloudPage, CloudCheckoutPage])("shows a free private-instance state instead of official pricing or checkout", (Page) => {
    mocks.hostingMode = "self_hosted";
    show(Page === CloudPage ? "/cloud" : `/billing/checkout?order=${orderId}`, Page);
    expect(screen.getByRole("heading", { name: "Your free self-hosted instance" })).toBeInTheDocument();
    expect(screen.getByText(/operator manages server capacity, backups and history retention/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribe to Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue to payment/ })).not.toBeInTheDocument();
    expect(screen.queryByText("$39.99")).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["ready", "expired", "closed", "paid"])("blocks further checkout on a %s payment conflict without hiding paid status", async (status) => {
    mocks.request.mockResolvedValue({
      order: { ...prices[3], id: orderId, provider: "waffo", status,
        payment_state: status === "paid" ? "paid" : "unpaid",
        checkout_url: "https://pancake.waffo.ai/checkout?session=owned",
        retry_payment_conflict_at: "2026-10-07T15:00:00Z" },
      membership: status === "paid" ? { status: "active", expires_at: "2027-10-04" } : membership,
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/both the original and replacement orders/);
    expect(screen.getByRole("link", { name: "View payment bills" })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("button", { name: "Close checkout and try again" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open secure checkout" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Choose a plan" })).not.toBeInTheDocument();
    if (status === "paid") expect(screen.getByRole("heading", { name: "Your Cloud membership is active" })).toBeInTheDocument();
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it.each([CloudPage, CloudCheckoutPage])("blocks a new purchase when the account has a conflicting payment", (Page) => {
    mocks.pendingOrders = [{ id: orderId, retry_payment_conflict_at: "2026-10-07T15:00:00Z" }];
    show(Page === CloudPage ? "/cloud" : "/billing/checkout?sku=cloud_usd_yearly", Page);
    expect(screen.getByRole("alert")).toHaveTextContent(/contact support/);
    expect(screen.getByRole("button", { name: Page === CloudPage ? "Try free for 7 days" : /Continue to payment/ })).toBeDisabled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["paid", "closed"])("blocks new purchases from a %s conflict order even with no pending orders", (status) => {
    mocks.conflictOrders = [{ id: orderId, status, retry_payment_conflict_at: "2026-10-07T15:00:00Z" }];
    show("/cloud", CloudPage);
    expect(screen.getByRole("button", { name: "Try free for 7 days" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/duplicate charge/);
    cleanup();
    show("/billing/checkout?sku=cloud_usd_yearly");
    expect(screen.getByRole("button", { name: /Continue to payment/ })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/contact support/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["ready", "expired", "closed"])("offers an explicit restart for an unpaid Waffo %s checkout", async (status) => {
    const oldOrder = { ...prices[3], id: orderId, provider: "waffo", status,
      payment_state: "unpaid", checkout_url: "https://pancake.waffo.ai/checkout?session=old" };
    const successor = { ...oldOrder, id: successorId, status: "ready",
      checkout_url: "https://pancake.waffo.ai/checkout?session=new" };
    mocks.request.mockImplementation(async (action, options) => {
      if (action === "restart-checkout") return { order: successor, membership };
      return { order: options.params.id === successorId ? successor : oldOrder, membership };
    });
    show(`/billing/checkout?order=${orderId}`);
    const retryDetails = (await screen.findByText("Having trouble with payment?")).closest("details");
    if (!retryDetails.open) await click(screen.getByText("Having trouble with payment?"));
    await screen.findByRole("button", { name: "Close checkout and try again" });
    expect(mocks.request.mock.calls.filter(([action]) => action === "restart-checkout")).toHaveLength(0);
    expect(screen.getByText(/a payment in progress cannot restart/)).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Close checkout and try again" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`order=${successorId}`));
    const purchase = readCloudPurchase("account-1");
    expect(purchase.order_id).toBe(successorId);
    expect(purchase.retry_request_id).toBeUndefined();
    expect(mocks.request).toHaveBeenCalledWith("restart-checkout", expect.objectContaining({ body: {
      id: orderId, request_id: purchase.request_id,
    } }));
    expect(mocks.external).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Your Cloud membership is active" })).not.toBeInTheDocument();
  });
  it("reuses a persisted restart identity after a timeout and a terminal-order reload", async () => {
    const oldOrder = { ...prices[3], id: orderId, provider: "waffo", status: "expired", payment_state: "unpaid" };
    const successor = { ...oldOrder, id: successorId, status: "ready",
      checkout_url: "https://pancake.waffo.ai/checkout?session=new" };
    mocks.request.mockImplementation(async (action, options) => {
      if (action === "restart-checkout") throw { code: "billing_network_error" };
      return { order: options.params.id === successorId ? successor : oldOrder, membership };
    });
    const firstView = show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("button", { name: "Close checkout and try again" });
    await click(screen.getByRole("button", { name: "Close checkout and try again" }));
    await screen.findByRole("alert");
    const firstRequest = readCloudPurchase("account-1").retry_request_id;
    firstView.unmount();
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("button", { name: "Close checkout and try again" });
    expect(readCloudPurchase("account-1").retry_request_id).toBe(firstRequest);
    mocks.request.mockImplementation(async (action, options) => action === "restart-checkout"
      ? { order: successor, membership }
      : { order: options.params.id === successorId ? successor : oldOrder, membership });
    await click(screen.getByRole("button", { name: "Close checkout and try again" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`order=${successorId}`));
    const attempts = mocks.request.mock.calls.filter(([action]) => action === "restart-checkout");
    expect(attempts).toHaveLength(2);
    expect(attempts.every(([, options]) => options.body.request_id === firstRequest)).toBe(true);
  });
  it.each(["checkout_confirmation_pending", "waffo_notification_pending"])("preserves the old order when %s prevents restart", async (code) => {
    const order = { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid",
      checkout_url: "https://pancake.waffo.ai/checkout?session=old" };
    mocks.request.mockImplementation(async (action) => {
      if (action === "restart-checkout") throw { code, status: 409 };
      return { order, membership };
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("button", { name: "Close checkout and try again" });
    await click(screen.getByRole("button", { name: "Close checkout and try again" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot restart yet/);
    expect(screen.getByTestId("location")).toHaveTextContent(`order=${orderId}`);
    expect(readCloudPurchase("account-1").retry_order_id).toBe(orderId);
    expect(mocks.request.mock.calls.filter(([action]) => action === "checkout")).toHaveLength(0);
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("checks the original paid order when the server refuses a stale unpaid restart", async () => {
    let paid = false;
    const order = { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid",
      checkout_url: "https://pancake.waffo.ai/checkout?session=old" };
    mocks.request.mockImplementation(async (action) => {
      if (action === "restart-checkout") {
        paid = true;
        throw { code: "checkout_already_paid", status: 409 };
      }
      return paid
        ? { order: { ...order, status: "paid", payment_state: "paid" }, membership: { status: "active", expires_at: "2027-10-04" } }
        : { order, membership };
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("button", { name: "Close checkout and try again" });
    await click(screen.getByRole("button", { name: "Close checkout and try again" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/server has recorded payment/);
    expect(screen.getByTestId("location")).toHaveTextContent(`order=${orderId}`);
    await act(async () => { fireEvent.focus(window); });
    await screen.findByRole("heading", { name: "Your Cloud membership is active" });
    expect(screen.queryByRole("button", { name: "Close checkout and try again" })).not.toBeInTheDocument();
    expect(readCloudPurchase("account-1")).toBeNull();
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it.each([
    ["waffo", "paid", "paid"],
    ["waffo", "paid", "refunded"],
    ["waffo", "ready", "partially_refunded"],
    ["waffo", "ready", undefined],
    ["paddle", "ready", "unpaid"],
  ])("does not restart %s %s with payment state %s", async (provider, status, payment_state) => {
    mocks.request.mockResolvedValue({ order: { ...prices[3], id: orderId, provider, status, payment_state,
      checkout_url: "https://pancake.waffo.ai/checkout?session=owned" }, membership });
    show(`/billing/checkout?order=${orderId}`);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Close checkout and try again" })).not.toBeInTheDocument();
    expect(mocks.request.mock.calls.filter(([action]) => action === "restart-checkout")).toHaveLength(0);
  });
  it("keeps a completed restart response in its original account after switching accounts", async () => {
    let finishRestart;
    const order = { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid",
      checkout_url: "https://pancake.waffo.ai/checkout?session=old" };
    mocks.request.mockImplementation((action) => action === "restart-checkout"
      ? new Promise((resolve) => { finishRestart = resolve; })
      : Promise.resolve({ order, membership }));
    const view = show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("button", { name: "Close checkout and try again" });
    await click(screen.getByRole("button", { name: "Close checkout and try again" }));
    mocks.userId = "account-2";
    mocks.request.mockRejectedValue({ code: "order_not_found" });
    view.rerender(<MemoryRouter initialEntries={[`/billing/checkout?order=${orderId}`]}><CloudCheckoutPage /><Location /></MemoryRouter>);
    await screen.findByRole("alert");
    await act(async () => { finishRestart({ order: { ...order, id: successorId }, membership }); });
    expect(screen.getByTestId("location")).toHaveTextContent(`order=${orderId}`);
    expect(readCloudPurchase("account-2")).toBeNull();
    expect(readCloudPurchase("account-1").order_id).toBe(successorId);
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it.each([
    ["cloud_usd_monthly_fixed", "Pay with WeChat", /Pay once. No automatic renewal/],
    ["cloud_usd_monthly", "Credit card", /Renews automatically/],
  ])("discloses the Waffo payment and renewal method for %s", (sku, method, renewal) => {
    show(`/billing/checkout?sku=${sku}`);
    expect(screen.getByText("Secure checkout by Waffo")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(method))).toHaveTextContent(/new tab/);
    expect(screen.getAllByText(renewal).length).toBeGreaterThan(0);
    expect(screen.queryByText("Alipay")).not.toBeInTheDocument();
    expect(screen.queryByText("Secure checkout by Paddle")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue to payment/ })).toBeEnabled();
  });
  it.each(["free", "trial", "expired"])("changes only the matching SKU in an unstarted %s purchase", async (status) => {
    mocks.accountMembership = { status, trial_available: status === "free" };
    mocks.catalogPrices = [
      { ...prices[1], sku: "another_currency", currency: "CNY" },
      prices[0], prices[1], prices[3],
    ];
    show("/billing/checkout?sku=cloud_usd_yearly&source=plans");
    await click(screen.getByRole("switch", { name: "Auto-renewal" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?sku=cloud_usd_yearly_fixed&source=plans");
    expect(screen.getByRole("switch", { name: "Auto-renewal" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Continue to payment · $39.99" })).toBeEnabled();
    await click(screen.getByRole("switch", { name: "Auto-renewal" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?sku=cloud_usd_yearly&source=plans");
    expect(screen.getByRole("switch", { name: "Auto-renewal" })).toBeChecked();
    expect(readCloudPurchase("account-1")).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("does not offer another currency or period when the matching billing mode is unavailable", () => {
    mocks.catalogPrices = [
      prices[3], prices[0], { ...prices[1], currency: "CNY", sku: "other_currency" },
    ];
    show("/billing/checkout?sku=cloud_usd_yearly");
    expect(screen.queryByRole("switch", { name: "Auto-renewal" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("keeps the SKU unchanged if another tab has started a purchase since this review rendered", async () => {
    show("/billing/checkout?sku=cloud_usd_yearly");
    const toggle = screen.getByRole("switch", { name: "Auto-renewal" });
    saveCloudPurchase("account-1", { sku: prices[3].sku, provider: "waffo", request_id: orderId });
    await click(toggle);
    expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?sku=cloud_usd_yearly");
    expect(readCloudPurchase("account-1")).toMatchObject({ sku: prices[3].sku, request_id: orderId });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("locks the selected SKU during order creation and after the server order exists", async () => {
    let finishCheckout;
    mocks.request.mockReturnValue(new Promise((resolve) => { finishCheckout = resolve; }));
    show("/billing/checkout?sku=cloud_usd_monthly");
    await click(screen.getByRole("switch", { name: "Auto-renewal" }));
    await click(screen.getByRole("button", { name: /Continue to payment/ }));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith("checkout", expect.objectContaining({ body: expect.objectContaining({ sku: "cloud_usd_monthly_fixed" }) }));
    expect(screen.queryByRole("switch", { name: "Auto-renewal" })).not.toBeInTheDocument();
    await act(async () => { finishCheckout({
      order: { ...prices[0], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: "https://pancake.waffo.ai/checkout" },
      membership,
    }); });
    await screen.findByRole("heading", { name: "Waiting for payment" });
    expect(screen.queryByRole("switch", { name: "Auto-renewal" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(`/billing/checkout?order=${orderId}`);
    expect(readCloudPurchase("account-1")).toMatchObject({ sku: "cloud_usd_monthly_fixed", order_id: orderId });
    expect(mocks.request.mock.calls.every(([action, options]) => action !== "checkout" || options.body.sku === "cloud_usd_monthly_fixed")).toBe(true);
  });
  it.each(["active_term", "future_payment", "canceled_contract_term", "gift", "gift_source", "open_contract", "pending_order", "request_retry", "loading", "error", "unknown"])(
    "keeps billing mode locked for %s", (condition) => {
      if (["active_term", "canceled_contract_term"].includes(condition)) mocks.accountMembership = { status: "active", trial_available: false };
      if (condition === "future_payment") mocks.payments = [{ amount_cents: 499, refunded_cents: 0, ends_at: "2099-01-01" }];
      if (condition === "canceled_contract_term") mocks.subscriptions = [{ status: "active", cancel_at_period_end: true }];
      if (condition === "gift") mocks.gifts = [{ state: "pending" }];
      if (condition === "gift_source") mocks.accountMembership = { status: "active", access_source: "gift", trial_available: false };
      if (condition === "open_contract") mocks.subscriptions = [{ status: "past_due", cancel_at_period_end: false }];
      if (condition === "pending_order") mocks.pendingOrders = [{ id: orderId, status: "pending" }];
      if (condition === "request_retry") saveCloudPurchase("account-1", { sku: prices[1].sku, provider: "waffo", request_id: orderId });
      if (condition === "loading") mocks.accountLoading = true;
      if (condition === "error") mocks.accountError = { code: "billing_network_error" };
      if (condition === "unknown") mocks.accountMembership = null;
      show("/billing/checkout?sku=cloud_usd_yearly_fixed");
      expect(screen.queryByRole("switch", { name: "Auto-renewal" })).not.toBeInTheDocument();
      expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_yearly_fixed");
      if (["active_term", "canceled_contract_term"].includes(condition)) {
        expect(screen.getByText("Pay once. No automatic renewal.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Continue to payment/ })).toBeEnabled();
      }
      if (["gift", "gift_source"].includes(condition)) expect(screen.getByRole("link", { name: "Manage membership" })).toBeInTheDocument();
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
  it("waits for the catalog before describing a selected recurring plan's renewal terms", async () => {
    mocks.actualCatalog = true;
    let resolveCatalog;
    mocks.request.mockReturnValue(new Promise((resolve) => { resolveCatalog = resolve; }));
    show("/billing/checkout?sku=cloud_usd_monthly");
    expect(mocks.request).toHaveBeenCalledWith("catalog", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getAllByText("Loading Cloud availability…").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No automatic debit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Renews automatically/)).not.toBeInTheDocument();
    expect(screen.queryByText("/month")).not.toBeInTheDocument();
    await act(async () => {
      resolveCatalog({ environment: "sandbox", policy: { phase: "active", launch_at: "2000-01-01" }, prices,
        providers: { waffo: true }, limits: { machines: 5, sync_minutes: 15, hourly_history_days: 90, daily_history_months: 24, trial_days: 7 } });
    });
    expect(screen.getByText(/Renews automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/No automatic debit/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to payment · $4.99" })).toBeEnabled();
  });
  it("offers the free self-host path alongside concrete hosted benefits", () => {
    show("/cloud", CloudPage);
    expect(screen.getByText("Cross-device analysis")).toBeInTheDocument();
    expect(screen.getByText("Hosted history and exports")).toBeInTheDocument();
    expect(screen.getByText("Managed synchronization")).toBeInTheDocument();
    expect(screen.getByText(/Combine usage across your devices/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read deployment guidance" })).toHaveAttribute("href", "/self-host");
    expect(screen.getByText(/Free software; hosting and maintenance are up to you/)).toHaveTextContent(/Technical preview/);
  });
  it("keeps legacy orders separate from the new Waffo provider", async () => {
    mocks.request.mockResolvedValue({
      order: { ...prices[3], id: orderId, provider: "paddle", status: "ready", checkout_url: `https://www.tokentracker.cc/billing/checkout?order=${orderId}&_ptxn=txn_verified` }, membership,
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("heading", { name: "Waiting for payment" });
    expect(screen.queryByRole("button", { name: "Open secure checkout" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I've paid · Check status" })).toBeEnabled();
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("does not keep activating or polling a refunded payment when another membership is active", async () => {
    vi.useFakeTimers();
    mocks.request.mockResolvedValue({
      order: { ...prices[1], id: orderId, provider: "waffo", status: "paid", payment_state: "refunded", expires_at: "2027-10-04" },
      membership: { status: "active", expires_at: "2027-10-04" },
    });
    show(`/billing/checkout?order=${orderId}`);
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "This payment has been refunded" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("button", { name: "I've paid · Check status" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Checkout expires/)).not.toBeInTheDocument();
    const requests=mocks.request.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mocks.request.mock.calls.length).toBe(requests);
    expect(screen.queryByRole("heading", { name: "Your Cloud membership is active" })).not.toBeInTheDocument();
  });
  it("keeps an expired paid period distinct from an unpaid expired checkout", async () => {
    saveCloudPurchase("account-1", { order_id: orderId, retry_order_id: orderId, retry_request_id: successorId });
    mocks.request.mockResolvedValue({
      order: { ...prices[1], id: orderId, provider: "waffo", status: "paid", payment_state: "paid" },
      membership: { status: "expired", read_only_until: "2026-11-03" },
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("heading", { name: "This membership period has ended" });
    expect(screen.getByText(/payment remains in your account history/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Renew Cloud" })).toHaveAttribute("href", "/cloud");
    expect(screen.queryByRole("button", { name: "Close checkout and try again" })).not.toBeInTheDocument();
    expect(readCloudPurchase("account-1")).toBeNull();
  });
  it("shows a newly rejected sign-in before an earlier checkout error", async () => {
    mocks.request.mockImplementation(async (action) => {
      if (action === "reconcile") throw { code: "payment_provider_not_configured" };
      return { order: { ...prices[1], id: orderId, provider: "waffo", status: "pending" }, membership };
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("heading", { name: "Preparing your payment order" });
    await click(screen.getByRole("button", { name: "I've paid · Check status" }));
    await screen.findByRole("alert");
    mocks.request.mockRejectedValue({ code: "invalid_token", status: 401 });
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByRole("alert")).toHaveTextContent(/sign-in needs refreshing/);
    expect(screen.getByRole("button", { name: "Sign in to continue" })).toBeEnabled();
  });
  it("routes an unresolved earlier checkout to account recovery instead of suggesting another purchase", async () => {
    mocks.request.mockRejectedValue({ code: "pending_checkout_exists", status: 409 });
    show("/billing/checkout?sku=cloud_usd_yearly");
    await click(screen.getByRole("button", { name: "Continue to payment · $39.99" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/previous purchase is still unresolved/);
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/settings?section=cloud");
  });
  it("keeps a failed reconciliation visible across passive reads and retries the same order", async () => {
    const order = { ...prices[1], id: orderId, provider: "waffo", status: "pending" };
    mocks.request.mockImplementation(async (action) => {
      if (action === "reconcile") throw { code: "payment_provider_not_configured" };
      return { order, membership };
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("heading", { name: "Preparing your payment order" });
    await click(screen.getByRole("button", { name: "I've paid · Check status" }));
    await screen.findByRole("alert");
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByRole("alert")).toHaveTextContent("This payment method is not available right now.");
    await click(screen.getByRole("button", { name: "Retry", exact: true }));
    const reconciles=mocks.request.mock.calls.filter(([action])=>action === "reconcile");
    expect(reconciles).toHaveLength(2);
    expect(reconciles.every(([,options])=>options.body.id === orderId)).toBe(true);
    expect(screen.queryByRole("heading", { name: "Your Cloud membership is active" })).not.toBeInTheDocument();
  });
  it.each([1, 3])(
    "hands billing option %s to the owned Waffo checkout without granting membership",
    async (priceIndex) => {
      const url = "https://pancake.waffo.ai/checkout?session=verified";
      mocks.request.mockResolvedValue({
        order: { ...prices[priceIndex], id: orderId, provider: "waffo", status: "ready", checkout_url: url },
        membership,
      });
      show(`/billing/checkout?order=${orderId}`);
      await screen.findByRole("heading", { name: "Waiting for payment" });
      await click(screen.getByRole("button", { name: "Open secure checkout" }));
      expect(mocks.external).toHaveBeenCalledWith(url);
      expect(screen.getByRole("heading", { name: "Waiting for payment" })).toBeInTheDocument();
    },
  );
  it.each(["preview", "provider_disabled"])(
    "keeps an existing checkout closed when %s, while preserving payment recovery",
    async (condition) => {
      const order = {
        ...prices[1],
        id: orderId,
        provider: "waffo",
        status: "ready",
        checkout_url: "https://pancake.waffo.ai/checkout?session=verified",
      };
      if (condition === "preview") mocks.phase = "preview";
      else mocks.providers.waffo = false;
      mocks.request.mockResolvedValue({ order, membership });
      show(`/billing/checkout?order=${orderId}`);
      await screen.findByRole("heading", { name: "Waiting for payment" });
      expect(
        screen.queryByRole("button", { name: "Open secure checkout" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "I've paid · Check status" }),
      ).toBeEnabled();
    },
  );
  it("uses one global base price and selects the SKU by payment terms", async () => {
    mocks.accountMembership = { status: "expired", trial_available: false };
    show("/cloud", CloudPage);
    expect(screen.getByText("$39.99")).toBeInTheDocument();
    expect(screen.getByText("Equivalent to $3.33/month")).toBeInTheDocument();
    expect(screen.queryByText(/USD prices exclude tax/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Test pricing draft/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mainland China/ })).not.toBeInTheDocument();
    await click(screen.getByRole("switch", { name: "Auto-renewal", exact: true }));
    expect(screen.getByText("$39.99")).toBeInTheDocument();
    expect(screen.getByText("· Pay once")).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Buy Cloud" }));
    expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_yearly_fixed");
    await click(screen.getByRole("button", { name: "Monthly", exact: true }));
    expect(screen.getByText("$4.99")).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Buy Cloud" }));
    expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_monthly_fixed");
    await click(screen.getByRole("switch", { name: "Auto-renewal", exact: true }));
    expect(screen.getByText("$4.99")).toBeInTheDocument();
    expect(screen.getByText("· Cancel anytime")).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Subscribe to Cloud" }));
    expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_monthly");
    expect(screen.getByText("Complete local features, forever.")).toBeInTheDocument();
  });
  it("replaces a used trial with a primary purchase action without implying another no-card trial", async () => {
    mocks.accountMembership = { status: "expired", trial_available: false };
    show("/cloud", CloudPage);
    expect(screen.queryByRole("button", { name: /Try free for/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No card required. No automatic charge.")).not.toBeInTheDocument();
    expect(screen.getByText(copy("cloud.trial.used_hint"))).toBeInTheDocument();
    const subscribe = screen.getByRole("button", { name: "Subscribe to Cloud" });
    expect(subscribe).toBeEnabled();
    expect(subscribe).toHaveClass("bg-oai-black");
    await click(subscribe);
    expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_yearly");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([true, false])("offers one primary trial entry and the appropriate local action, signedIn=%s", async (signedIn) => {
    mocks.signedIn = signedIn;
    show("/cloud", CloudPage);
    const trial = screen.getByRole("button", { name: "Try free for 7 days" });
    expect(trial).toBeEnabled();
    expect(trial).toHaveClass("bg-oai-black");
    expect(screen.queryByText("No card required. No automatic charge.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribe to Cloud" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: signedIn ? "Open dashboard" : "Use the free app" })).toHaveAttribute("href", signedIn ? "/dashboard" : "/landing#download");
    await click(trial);
    if (signedIn) {
      expect(screen.getByTestId("location")).toHaveTextContent("intent=trial");
    } else {
      expect(screen.getByTestId("location")).toHaveTextContent("/cloud");
      const { nextPath } = mocks.openLoginModal.mock.calls.at(-1)[0];
      const selection = new URL(nextPath, "http://localhost");
      expect(selection.pathname).toBe("/billing/checkout");
      expect(selection.searchParams.get("intent")).toBe("trial");
      expect(selection.searchParams.get("sku")).toBe("cloud_usd_yearly");
      expect(selection.searchParams.get("flow")).toMatch(/^[a-f\d-]{36}$/i);
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["active", "past_due"])("offers management instead of a new purchase while an expired account has an open %s renewal contract", (status) => {
    mocks.accountMembership = { status: "expired", trial_available: false };
    mocks.subscriptions = [{ status, cancel_at_period_end: false }];
    show("/cloud", CloudPage);
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("button", { name: "Subscribe to Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try free for/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No card required. No automatic charge.")).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([
    ["cloud_usd_yearly", false],
    ["cloud_usd_monthly", true],
  ])("starts the selected %s trial directly and opens the dashboard without another dialog", async (sku, monthly) => {
    mocks.request.mockResolvedValue({ membership: { status: "trial", trial_ends_at: "2026-10-18" } });
    const view = show("/cloud", CloudPage);
    if (monthly) await click(screen.getByRole("button", { name: "Monthly", exact: true }));
    expect(screen.queryByRole("switch", { name: "Auto-renewal" })).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Try free for 7 days" }));
    const trialPath = screen.getByTestId("location").textContent;
    const selection = new URL(trialPath, "http://localhost");
    expect(selection.searchParams.get("intent")).toBe("trial");
    expect(selection.searchParams.get("sku")).toBe(sku);
    expect(selection.searchParams.get("flow")).toMatch(/^[a-f\d-]{36}$/i);
    expect(mocks.request).not.toHaveBeenCalled();
    view.unmount();
    show(trialPath);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start 7-day free trial" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboard"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith("trial", expect.objectContaining({ body: {} }));
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it.each(["preview", "provider_disabled", "invalid_sku"])("does not offer direct purchase from trial review when %s", (condition) => {
    if (condition === "preview") mocks.phase = "preview";
    if (condition === "provider_disabled") mocks.providers.waffo = false;
    show(`/billing/checkout?intent=trial&sku=${condition === "invalid_sku" ? "cloud_cny_yearly" : "cloud_usd_yearly"}`);
    expect(screen.queryByRole("link", { name: "Skip the trial and buy Cloud" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["loading", "error", "unknown"])("does not imply a trial is available while the account is %s", (state) => {
    mocks.accountMembership = null;
    mocks.accountLoading = state === "loading";
    mocks.accountError = state === "error" ? { code: "billing_network_error" } : null;
    show("/cloud", CloudPage);
    expect(screen.getByRole("button", { name: /Try free for/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Subscribe to Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByText("No card required. No automatic charge.")).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("does not create a new order for a retired regional SKU", () => {
    show("/billing/checkout?sku=cloud_cny_yearly");
    expect(screen.queryByRole("button", { name: /Continue to payment/ })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("disables payment and trial until launch and disables unconfigured providers", async () => {
    mocks.phase = "preview";
    show("/cloud", CloudPage);
    expect(
      screen.getByRole("button", { name: /Try free for/ }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Subscribe to Cloud" })).not.toBeInTheDocument();
    cleanup();
    mocks.accountMembership = { status: "expired", trial_available: false };
    show("/cloud", CloudPage);
    expect(screen.getByRole("button", { name: "Subscribe to Cloud" })).toBeDisabled();
    cleanup();
    mocks.phase = "active";
    mocks.providers.waffo = false;
    show("/billing/checkout?sku=cloud_usd_yearly");
    expect(
      screen.getByRole("button", { name: "Continue to payment · $39.99" }),
    ).toBeDisabled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("opens login immediately for a direct purchase while preserving its SKU and keeping plans behind it", () => {
    mocks.signedIn = false;
    show("/billing/checkout?sku=cloud_usd_yearly_fixed");
    expect(mocks.openLoginModal).toHaveBeenCalledWith(expect.objectContaining({
      nextPath: "/billing/checkout?sku=cloud_usd_yearly_fixed",
      closePath: "/cloud",
    }));
    expect(screen.getByRole("heading", { name: "Choose your plan" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Review your Cloud purchase" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in to continue" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("preserves a guest's monthly selection when opening login without leaving plans", async () => {
    mocks.signedIn = false;
    show("/cloud", CloudPage);
    await click(screen.getByRole("button", { name: "Monthly", exact: true }));
    await click(screen.getByRole("button", { name: "Try free for 7 days" }));
    const { nextPath } = mocks.openLoginModal.mock.calls.at(-1)[0];
    const selection = new URL(nextPath, "http://localhost");
    expect(selection.searchParams.get("intent")).toBe("trial");
    expect(selection.searchParams.get("sku")).toBe("cloud_usd_monthly");
    expect(selection.searchParams.get("flow")).toMatch(/^[a-f\d-]{36}$/i);
    expect(screen.getByTestId("location")).toHaveTextContent("/cloud");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("waits for auth restoration before prompting login and prompts only once", () => {
    mocks.signedIn = false;
    mocks.authLoading = true;
    const path = "/billing/checkout?intent=trial&sku=cloud_usd_monthly";
    const view = show(path);
    const refreshAuth = () => {
      view.rerender(<MemoryRouter initialEntries={[path]}><CloudCheckoutPage /><Location /></MemoryRouter>);
    };
    expect(mocks.openLoginModal).not.toHaveBeenCalled();
    mocks.authLoading = false;
    refreshAuth();
    expect(mocks.openLoginModal).toHaveBeenCalledTimes(1);
    refreshAuth();
    expect(mocks.openLoginModal).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each(["cloud_usd_monthly_fixed", "cloud_usd_yearly"])(
    "creates the selected %s order once and opens its secure payment page directly", async (sku) => {
      const price = prices.find((item) => item.sku === sku);
      const url = "https://pancake.waffo.ai/checkout?session=verified";
      const order = { ...price, id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: url };
      mocks.accountMembership = { status: "expired", trial_available: false };
      mocks.request.mockResolvedValue({ order, membership });
      const path = beginCloudAction({ trial: false, sku, userId: mocks.userId });
      show(path);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Continue to payment/ })).not.toBeInTheDocument();
      await waitFor(() => expect(mocks.external).toHaveBeenCalledWith(url, { sameTab: true }));
      const checkouts = mocks.request.mock.calls.filter(([action]) => action === "checkout");
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0][1].body).toMatchObject({ sku, provider: "waffo", request_id: expect.any(String) });
      expect(screen.getByTestId("location")).toHaveTextContent(`order=${orderId}`);
      expect(readCloudPurchase(mocks.userId)).toMatchObject({ sku, order_id: orderId });
    },
  );
  it.each(["trial", "purchase"])("does not execute a %s from a forged flow URL", (action) => {
    show(`/billing/checkout?${action === "trial" ? "intent=trial&" : ""}sku=cloud_usd_yearly&flow=${orderId}`);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: action === "trial" ? "Start 7-day free trial" : /Continue to payment/ })).toBeEnabled();
  });
  it("opens only the URL returned by the owned order refresh after direct creation", async () => {
    const verifiedUrl = "https://pancake.waffo.ai/checkout?session=verified-order";
    const order = { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid" };
    mocks.request.mockImplementation(async (action) => ({
      order: { ...order, checkout_url: action === "order" ? verifiedUrl : "https://pancake.waffo.ai/checkout?session=creation-response" },
      membership,
    }));
    const path = beginCloudAction({ trial: false, sku: prices[3].sku, userId: mocks.userId });
    show(path);
    await waitFor(() => expect(mocks.external).toHaveBeenCalledWith(verifiedUrl, { sameTab: true }));
    expect(mocks.external).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith("order", expect.objectContaining({ params: { id: orderId } }));
  });
  it("extends an active paid term with a fixed purchase directly", async () => {
    mocks.accountMembership = { status: "active", trial_available: false, access_source: "payment", expires_at: "2099-10-11T00:00:00Z" };
    const url = "https://pancake.waffo.ai/checkout?session=fixed-extension";
    const order = { ...prices[1], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: url };
    mocks.request.mockResolvedValue({ order, membership: mocks.accountMembership });
    const path = beginCloudAction({ trial: false, sku: prices[1].sku, userId: mocks.userId });
    show(path);
    await waitFor(() => expect(mocks.external).toHaveBeenCalledWith(url, { sameTab: true }));
    const checkouts = mocks.request.mock.calls.filter(([action]) => action === "checkout");
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0][1].body).toMatchObject({ sku: "cloud_usd_yearly_fixed" });
    expect(screen.getByTestId("location")).toHaveTextContent(`order=${orderId}`);
  });
  it("routes an active paid term's conflicting recurring purchase to membership management", async () => {
    mocks.accountMembership = { status: "active", trial_available: false, access_source: "payment", expires_at: "2099-10-11T00:00:00Z" };
    const path = beginCloudAction({ trial: false, sku: prices[3].sku, userId: mocks.userId });
    show(path);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=cloud"));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("does not open payment or change the route after an in-flight purchase's account changes", async () => {
    let finishCheckout;
    mocks.request.mockReturnValue(new Promise((resolve) => { finishCheckout = resolve; }));
    const path = beginCloudAction({ trial: false, sku: prices[3].sku, userId: mocks.userId });
    const view = show(path);
    await waitFor(() => { expect(mocks.request).toHaveBeenCalledTimes(1); });
    mocks.userId = "account-2";
    view.rerender(<MemoryRouter initialEntries={[path]}><CloudCheckoutPage /><Location /></MemoryRouter>);
    await act(async () => { finishCheckout({
      order: { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: "https://pancake.waffo.ai/checkout?session=account-1" },
      membership,
    }); });
    expect(screen.getByTestId("location")).toHaveTextContent(path);
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(readCloudPurchase("account-2")).toBeNull();
  });
  it.each([false, true])("ignores an in-flight direct action after its backend changes, trial=%s", async (trial) => {
    let finishAction;
    mocks.request.mockReturnValue(new Promise((resolve) => { finishAction = resolve; }));
    const path = beginCloudAction({ trial, sku: prices[3].sku, userId: mocks.userId });
    const view = show(path);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    vi.stubEnv("VITE_INSFORGE_BASE_URL", "https://another-instance.example");
    vi.stubEnv("VITE_INSFORGE_ANON_KEY", `anon_${"a".repeat(40)}`);
    view.rerender(<MemoryRouter initialEntries={[path]}><CloudCheckoutPage /><Location /></MemoryRouter>);
    await act(async () => { finishAction(trial ? {
      membership: { status: "trial", trial_ends_at: "2026-10-18" },
    } : {
      order: { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: "https://pancake.waffo.ai/checkout?session=previous-backend" },
      membership,
    }); });
    expect(screen.getByTestId("location")).toHaveTextContent(path);
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "Your Cloud trial has started" })).not.toBeInTheDocument();
  });
  it("cancels a waiting direct action when returning to plans and does not execute it on revisit", async () => {
    mocks.accountLoading = true;
    const path = beginCloudAction({ trial: true, sku: prices[3].sku, userId: mocks.userId });
    const view = show(path);
    expect(mocks.request).not.toHaveBeenCalled();
    await click(screen.getByRole("link", { name: "Back to plans" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/cloud");
    view.unmount();
    mocks.accountLoading = false;
    show(path);
    expect(screen.getByRole("button", { name: "Start 7-day free trial" })).toBeEnabled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it.each(["sku", "owner"])("does not execute a stored action after its %s changes", (change) => {
    const path = beginCloudAction({ trial: false, sku: "cloud_usd_yearly", userId: mocks.userId });
    if (change === "owner") mocks.userId = "account-2";
    show(change === "sku" ? path.replace("cloud_usd_yearly", "cloud_usd_monthly") : path);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("waits for restored auth and loaded membership before consuming a direct trial action", async () => {
    mocks.authLoading = true;
    mocks.accountLoading = true;
    mocks.request.mockResolvedValue({ membership: { status: "trial", trial_ends_at: "2026-10-18" } });
    const path = beginCloudAction({ trial: true, sku: "cloud_usd_yearly", userId: mocks.userId });
    const view = show(path);
    const refresh = () => {
      view.rerender(<MemoryRouter initialEntries={[path]}><CloudCheckoutPage /><Location /></MemoryRouter>);
    };
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.authLoading = false;
    refresh();
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.accountLoading = false;
    refresh();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/dashboard"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith("trial", expect.objectContaining({ body: {} }));
  });
  it("does not execute an already consumed trial action on another mount", async () => {
    let finishTrial;
    mocks.request.mockReturnValue(new Promise((resolve) => { finishTrial = resolve; }));
    const path = beginCloudAction({ trial: true, sku: "cloud_usd_yearly", userId: mocks.userId });
    const first = show(path);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    first.unmount();
    show(path);
    await act(async () => { finishTrial({ membership: { status: "trial", trial_ends_at: "2026-10-18" } }); });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location")).toHaveTextContent(path);
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("does not navigate to another account's dashboard when a pending trial completes", async () => {
    let finishTrial;
    mocks.request.mockReturnValue(new Promise((resolve) => { finishTrial = resolve; }));
    const path = beginCloudAction({ trial: true, sku: "cloud_usd_yearly", userId: mocks.userId });
    const view = show(path);
    await waitFor(() => { expect(mocks.request).toHaveBeenCalledTimes(1); });
    mocks.userId = "account-2";
    view.rerender(<MemoryRouter initialEntries={[path]}><CloudCheckoutPage /><Location /></MemoryRouter>);
    await act(async () => { finishTrial({ membership: { status: "trial", trial_ends_at: "2026-10-18" } }); });
    expect(screen.getByTestId("location")).toHaveTextContent(path);
    expect(screen.queryByRole("heading", { name: "Your Cloud trial has started" })).not.toBeInTheDocument();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it("returns an unavailable direct trial to plans without attempting activation", async () => {
    mocks.accountMembership = { status: "expired", trial_available: false };
    const path = beginCloudAction({ trial: true, sku: "cloud_usd_yearly", userId: mocks.userId });
    show(path);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/cloud"));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("returns to plans when the server rejects an already used direct trial", async () => {
    mocks.request.mockRejectedValue({ code: "trial_unavailable" });
    const path = beginCloudAction({ trial: true, sku: "cloud_usd_yearly", userId: mocks.userId });
    show(path);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/cloud"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.external).not.toHaveBeenCalled();
  });
  it("resumes an explicitly selected existing order directly after its owned refresh without another purchase", async () => {
    const url = "https://pancake.waffo.ai/checkout?session=existing-order";
    const order = { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: url };
    mocks.request.mockResolvedValue({ order, membership });
    const path = beginCloudOrderAction({ orderId, userId: mocks.userId });
    show(path);
    await waitFor(() => expect(mocks.external).toHaveBeenCalledWith(url, { sameTab: true }));
    expect(mocks.external).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith("order", expect.objectContaining({ params: { id: orderId } }));
    expect(mocks.request.mock.calls.every(([action]) => action === "order")).toBe(true);
    fireEvent.focus(window);
    await act(async () => {});
    expect(mocks.external).toHaveBeenCalledTimes(1);
  });
  it.each(["", `&flow=${successorId}`, "&success=1&status=paid"])(
    "does not redirect an ordinary order return automatically, query=%s", async (query) => {
      mocks.request.mockResolvedValue({
        order: { ...prices[3], id: orderId, provider: "waffo", status: "ready", payment_state: "unpaid", checkout_url: "https://pancake.waffo.ai/checkout?session=return" },
        membership,
      });
      show(`/billing/checkout?order=${orderId}${query}`);
      await screen.findByRole("heading", { name: "Waiting for payment" });
      expect(mocks.external).not.toHaveBeenCalled();
      expect(mocks.request.mock.calls.every(([action]) => action === "order")).toBe(true);
    },
  );
  it("does not auto-open an already consumed order resume after mounting again", async () => {
    const url = "https://pancake.waffo.ai/checkout?session=one-resume";
    mocks.request.mockResolvedValue({ order: { ...prices[3], id: orderId, provider: "waffo", status: "ready", checkout_url: url }, membership });
    const path = beginCloudOrderAction({ orderId, userId: mocks.userId });
    const first = show(path);
    await waitFor(() => expect(mocks.external).toHaveBeenCalledTimes(1));
    first.unmount();
    show(path);
    await screen.findByRole("heading", { name: "Waiting for payment" });
    expect(mocks.external).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls.every(([action]) => action === "order")).toBe(true);
  });
  it("waits for the selected new order's verification instead of opening the previous order's payment URL", async () => {
    const previousUrl = "https://pancake.waffo.ai/checkout?session=previous-order";
    const selectedUrl = "https://pancake.waffo.ai/checkout?session=selected-order";
    let finishSelectedOrder;
    mocks.request.mockImplementation((action, options) => {
      if (options.params?.id === orderId) return Promise.resolve({
        order: { ...prices[3], id: orderId, provider: "waffo", status: "ready", checkout_url: previousUrl },
        membership,
      });
      return new Promise((resolve) => { finishSelectedOrder = resolve; });
    });
    const initialPath = `/billing/checkout?order=${orderId}`;
    const view = show(initialPath);
    await screen.findByRole("heading", { name: "Waiting for payment" });
    expect(mocks.external).not.toHaveBeenCalled();
    const selectedPath = beginCloudOrderAction({ orderId: successorId, userId: mocks.userId });
    view.rerender(
      <MemoryRouter initialEntries={[initialPath]}>
        <CloudCheckoutPage />
        <Link to={selectedPath}>{"Resume another order"}</Link>
        <Location />
      </MemoryRouter>,
    );
    await click(screen.getByRole("link", { name: "Resume another order" }));
    expect(mocks.request).toHaveBeenCalledWith("order", expect.objectContaining({ params: { id: successorId } }));
    expect(mocks.external).not.toHaveBeenCalled();
    await act(async () => { finishSelectedOrder({
      order: { ...prices[3], id: successorId, provider: "waffo", status: "ready", checkout_url: selectedUrl },
      membership,
    }); });
    await waitFor(() => expect(mocks.external).toHaveBeenCalledWith(selectedUrl, { sameTab: true }));
    expect(mocks.external).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls.every(([action]) => action === "order")).toBe(true);
  });
  it("matches an uppercase order reference to the server's canonical UUID during explicit resume", async () => {
    const referencedId = "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF";
    const url = "https://pancake.waffo.ai/checkout?session=canonical-order";
    mocks.request.mockResolvedValue({
      order: { ...prices[3], id: referencedId.toLowerCase(), provider: "waffo", status: "ready", checkout_url: url },
      membership,
    });
    const path = beginCloudOrderAction({ orderId: referencedId, userId: mocks.userId });
    show(path);
    await waitFor(() => expect(mocks.external).toHaveBeenCalledWith(url, { sameTab: true }));
    expect(mocks.external).toHaveBeenCalledTimes(1);
  });
  it.each(["account", "backend"])("does not auto-open a resumed order after its %s changes during verification", async (change) => {
    let finishOrder;
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { finishOrder = resolve; }));
    mocks.request.mockRejectedValue({ code: "order_not_found" });
    const path = beginCloudOrderAction({ orderId, userId: mocks.userId });
    const view = show(path);
    await waitFor(() => { expect(mocks.request).toHaveBeenCalledTimes(1); });
    if (change === "account") mocks.userId = "account-2";
    else {
      vi.stubEnv("VITE_INSFORGE_BASE_URL", "https://another-instance.example");
      vi.stubEnv("VITE_INSFORGE_ANON_KEY", `anon_${"a".repeat(40)}`);
    }
    view.rerender(<MemoryRouter initialEntries={[path]}><CloudCheckoutPage /><Location /></MemoryRouter>);
    await act(async () => { finishOrder({
      order: { ...prices[3], id: orderId, provider: "waffo", status: "ready", checkout_url: "https://pancake.waffo.ai/checkout?session=previous-owner" },
      membership,
    }); });
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.every(([action]) => action === "order")).toBe(true);
    expect(screen.getByTestId("location")).toHaveTextContent(path);
  });
  it.each(["paid", "refunded", "expired"])("does not redirect an explicit resume when the verified order is %s", async (terminal) => {
    mocks.request.mockResolvedValue({
      order: { ...prices[3], id: orderId, provider: "waffo", status: terminal === "refunded" ? "paid" : terminal, payment_state: terminal === "refunded" ? "refunded" : "paid", checkout_url: "https://pancake.waffo.ai/checkout?session=terminal-order" },
      membership: { status: "active", expires_at: "2027-10-11" },
    });
    const path = beginCloudOrderAction({ orderId, userId: mocks.userId });
    show(path);
    await screen.findByRole("heading", { name: terminal === "paid" ? "Your Cloud membership is active" : terminal === "refunded" ? "This payment has been refunded" : "This order has expired" });
    expect(mocks.external).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.every(([action]) => action === "order")).toBe(true);
  });
  it("discloses trial end and read-only period before an explicit trial activation", async () => {
    mocks.request.mockResolvedValue({
      membership: { status: "trial", trial_ends_at: "2026-10-11" },
    });
    show("/billing/checkout?intent=trial");
    expect(screen.getByText(/30 days to view and export/)).toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
    await click(screen.getByRole("button", { name: "Start 7-day free trial" }));
    expect(mocks.request).toHaveBeenCalledWith(
      "trial",
      expect.objectContaining({ body: {} }),
    );
    await screen.findByRole("heading", {
      name: "Your Cloud trial has started",
    });
    expect(screen.getByRole("link", { name: "Set up Cloud sync" })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByText(copy("cloud.onboarding.local_next"))).toBeInTheDocument();
  });
  it.each([[true, false], [true, true], [false, false]])(
    "guides a paid checkout to sync setup only when local=%s and sync=%s", async (localHost, syncOn) => {
      mocks.localHost = localHost;
      mocks.syncOn = syncOn;
      mocks.request.mockResolvedValue({
        order: { ...prices[0], id: orderId, provider: "waffo", status: "paid", payment_state: "paid" },
        membership: { status: "active", expires_at: "2027-10-10" },
      });
      show(`/billing/checkout?order=${orderId}`);
      await screen.findByRole("heading", { name: "Your Cloud membership is active" });
      if (localHost && !syncOn) {
        expect(screen.getByRole("link", { name: "Set up Cloud sync" })).toHaveAttribute("href", "/settings?section=cloud");
      } else {
        expect(screen.queryByRole("link", { name: "Set up Cloud sync" })).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/dashboard");
      }
      if (!localHost) expect(screen.getByText(copy("cloud.onboarding.web_next"))).toBeInTheDocument();
      expect(localStorage.getItem("tokentracker_cloud_sync_enabled")).toBeNull();
      expect(mocks.request.mock.calls.every(([action]) => action === "order")).toBe(true);
    },
  );
  it("lets an exhausted trial without a selected SKU return to available plans", () => {
    mocks.accountMembership = { status: "expired", trial_available: false };
    show("/billing/checkout?intent=trial");
    expect(screen.getByRole("button", { name: "Start 7-day free trial" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "View Cloud plans" })).toHaveAttribute("href", "/cloud");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([
    ["en", "Start 7-day free trial", "Starting your Cloud trial", "Preparing your payment order"],
    ["zh", "开始 7 天免费试用", "正在开通云服务试用", "正在准备支付订单"],
    ["zh-TW", "開始 7 天免費試用", "正在開通雲服務試用", "正在準備付款訂單"],
  ])("describes a pending %s trial activation without presenting a payment order", async (locale, action, waiting, payment) => {
    setCopyLocale(locale);
    let resolveTrial;
    mocks.request.mockReturnValue(new Promise((resolve) => { resolveTrial = resolve; }));
    show("/billing/checkout?intent=trial");
    await click(screen.getByRole("button", { name: action }));
    expect(mocks.request).toHaveBeenCalledWith("trial", expect.objectContaining({ body: {} }));
    expect(screen.getByRole("heading", { name: waiting })).toBeInTheDocument();
    const status = screen.getAllByRole("status").find((node) => node.textContent === waiting);
    expect(status).toHaveTextContent(waiting);
    expect(status).not.toHaveTextContent(/payment|支付|付款/i);
    expect(screen.queryByText(payment)).not.toBeInTheDocument();
    await act(async () => { resolveTrial({ membership: { status: "trial", trial_ends_at: "2026-10-11" } }); });
    expect(screen.queryByText(waiting)).not.toBeInTheDocument();
  });
  it("reuses the same purchase request after a timeout and keeps the server pending order", async () => {
    const order = {
      ...prices[1],
      id: orderId,
      provider: "waffo",
      status: "pending",
    };
    mocks.request.mockImplementation(async (action) => {
      if (action === "order") return { order, membership };
      if (
        action === "checkout" &&
        mocks.request.mock.calls.filter(([name]) => name === "checkout")
          .length === 1
      )
        throw { code: "billing_network_error" };
      return { order, pending: true, error: "checkout_confirmation_pending" };
    });
    show("/billing/checkout?sku=cloud_usd_yearly_fixed");
    const button = screen.getByRole("button", { name: /Continue to payment/ });
    await click(button);
    await screen.findByText(/connection was interrupted/);
    const firstRequest = readCloudPurchase("account-1").request_id;
    await click(screen.getByRole("button", { name: /Continue to payment/ }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `order=${orderId}`,
      ),
    );
    const checkouts = mocks.request.mock.calls.filter(
      ([action]) => action === "checkout",
    );
    expect(checkouts).toHaveLength(2);
    expect(checkouts[1][1].body.request_id).toBe(firstRequest);
    expect(checkouts.every(([,options]) => options.body.provider === "waffo")).toBe(true);
    expect(screen.getByText(/order is saved/)).toBeInTheDocument();
  });
  it("does not grant membership from a forged payment redirect or a browser return", async () => {
    const url = "https://pancake.waffo.ai/checkout?session=verified";
    const order = {
      ...prices[3], id: orderId, provider: "waffo", status: "ready", checkout_url: url,
    };
    mocks.request.mockResolvedValue({ order, membership });
    show(`/billing/checkout?order=${orderId}&_ptxn=txn_forged&success=1&status=paid`);
    await screen.findByRole("heading", { name: "Waiting for payment" });
    await click(screen.getByRole("button", { name: "Open secure checkout" }));
    expect(mocks.external).toHaveBeenCalledWith(url);
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByRole("heading", { name: "Waiting for payment" })).toBeInTheDocument();
    expect(screen.queryByText("Your Cloud membership is active")).not.toBeInTheDocument();
    mocks.request.mockResolvedValue({
      order: { ...order, status: "paid" },
      membership: { status: "active", expires_at: "2027-10-04" },
    });
    await act(async () => { fireEvent.focus(window); });
    await screen.findByRole("heading", { name: "Your Cloud membership is active" });
  });
  it("offers server reconciliation even for an expired checkout", async () => {
    mocks.request.mockResolvedValue({
      order: {
        ...prices[1],
        id: orderId,
        provider: "waffo",
        status: "ready",
        expires_at: "2000-01-01",
      },
      membership,
    });
    show(`/billing/checkout?order=${orderId}`);
    await screen.findByRole("heading", { name: "This order has expired" });
    await click(
      screen.getByRole("button", { name: "I've paid · Check status" }),
    );
    expect(mocks.request).toHaveBeenCalledWith(
      "reconcile",
      expect.objectContaining({ body: { id: orderId } }),
    );
  });
});
