import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../../lib/copy";
import { readCloudAction } from "../../lib/cloud-action-intent.js";
import { saveCloudPurchase } from "../../lib/cloud-checkout.js";
import { CloudMembershipCard } from "./CloudMembershipCard.jsx";

const mocks = vi.hoisted(() => ({
  account: null,
  request: vi.fn(),
  refresh: vi.fn(),
  getAccessToken: vi.fn(),
  external: vi.fn(),
  clearToken: vi.fn(),
  userId: "account-1",
  signedIn: true,
  openLogin: vi.fn(),
}));
vi.mock("../../hooks/use-cloud-billing.js", () => ({
  useCloudAccount: () => ({
    account: mocks.account,
    auth: {
      signedIn: mocks.signedIn,
      user: { id: mocks.userId },
      getAccessToken: mocks.getAccessToken,
    },
    refresh: mocks.refresh,
  }),
}));
vi.mock("../../contexts/LoginModalContext.jsx", () => ({ useLoginModal: () => ({ openLoginModal: mocks.openLogin }) }));
vi.mock("../../lib/cloud-billing", async () => ({
  ...(await vi.importActual("../../lib/cloud-billing")),
  cloudBillingRequest: mocks.request,
}));
vi.mock("../../lib/cloud-checkout.js", async () => ({
  ...(await vi.importActual("../../lib/cloud-checkout.js")),
  openCloudExternal: mocks.external,
}));
vi.mock("../../lib/local-api-auth", () => ({
  getLocalApiAuthHeaders: async () => ({}),
}));
vi.mock("../../lib/cloud-sync-prefs", async () => ({
  ...(await vi.importActual("../../lib/cloud-sync-prefs")),
  clearCloudDeviceSession: mocks.clearToken,
}));
const orderId = "11111111-1111-4111-8111-111111111111";
const click = (target) =>
  act(async () => {
    await userEvent.click(target);
  });
const hover = (target) =>
  act(async () => {
    await userEvent.hover(target);
  });
const openPaymentHistory = () => click(screen.getByRole("button", { name: copy("cloud.billing.title") }));

beforeEach(() => {
  setCopyLocale("en");
  mocks.request.mockReset();
  mocks.refresh.mockReset();
  mocks.external.mockReset();
  mocks.clearToken.mockReset();
  mocks.userId = "account-1";
  mocks.signedIn = true;
  mocks.openLogin.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  mocks.account = {
    membership: {
      status: "active",
      expires_at: "2027-10-04",
      machine_limit: 5,
      can_read_cloud: true,
      can_upload_cloud: true,
    },
    subscriptions: [
      {
        provider: "waffo",
        provider_subscription_id: "sub_test",
        status: "active",
        cancel_at_period_end: false,
        next_billed_at: "2027-10-04",
      },
    ],
    payments: [],
    pending_orders: [{ id: orderId }],
    conflict_orders: [],
  };
  mocks.request.mockResolvedValue({
    machines: [
      {
        machine_id: "opaque-slot-1",
        name: "Work laptop",
        platform: "macOS",
        last_seen_at: null,
      },
    ],
    machine_limit: 5,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function show(props = {}) {
  return render(
    <MemoryRouter>
      <CloudMembershipCard {...props} /><Location />
    </MemoryRouter>,
  );
}

describe("Cloud membership management", () => {
  it("offers direct subscription navigation in the function group for a user without a recurring subscription", async () => {
    mocks.account.subscriptions = [];
    show();
    const tools = screen.getByRole("region", { name: copy("cloud.membership.tools_title") });
    const subscribe = within(tools).getByRole("link", { name: copy("cloud.action.subscribe") });
    expect(subscribe).toHaveAttribute("href", "/cloud");
    await click(subscribe);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.request.mock.calls.some(([action]) => action === "checkout")).toBe(false);
  });

  it("keeps a single subscription management entry in the function group for a subscribed user", async () => {
    show();
    await screen.findByText("Work laptop");
    const tools = screen.getByRole("region", { name: copy("cloud.membership.tools_title") });
    expect(within(tools).getByRole("button", { name: copy("cloud.action.manage_subscription") })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: copy("cloud.action.manage_subscription") })).toHaveLength(1);
    expect(within(tools).queryByRole("link", { name: copy("cloud.action.subscribe") })).not.toBeInTheDocument();
  });

  it("opens the shared login dialog in place for a signed-out Cloud settings panel", async () => {
    mocks.signedIn = false;
    show({ showTitle: false });
    expect(screen.queryByRole("heading", { name: "TokenTracker Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open dashboard|View Cloud plans/ })).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Sign in to continue" }));
    expect(mocks.openLogin).toHaveBeenCalledWith({ subtitle: copy("cloud.membership.signed_out") });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("keeps transition status and its deadline clear without adding navigation or auto-renewal", async () => {
    mocks.account.membership = { status: "transition", transition_ends_at: "2026-11-10", machine_limit: 99,
      can_read_cloud: true, can_upload_cloud: true };
    mocks.account.subscriptions = [];
    show({ showTitle: false });
    await screen.findByText("Work laptop");
    expect(screen.getByText(copy("cloud.membership.transition_until", { date: "Nov 10, 2026" }))).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open dashboard|View Cloud plans/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Renews on|Auto-renewal is off/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy("cloud.status.transition") })).not.toBeInTheDocument();
  });
  it("opens one titled action dialog at a time and restores the trigger on Escape", async () => {
    mocks.account.gift_redemption_available = true;
    show();
    await screen.findByText("Work laptop");
    const tools = screen.getByRole("region", { name: "Tools & billing" });
    expect(screen.queryByRole("heading", { name: "Tools & billing" })).not.toBeInTheDocument();
    expect(within(tools).queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(within(tools).queryByRole("textbox", { name: "Cloud gift code" })).not.toBeInTheDocument();
    const exportTrigger = within(tools).getByRole("button", { name: "Export Cloud usage" });
    await click(exportTrigger);
    const exportDialog = screen.getByRole("dialog", { name: "Export Cloud usage" });
    expect(within(exportDialog).getByRole("button", { name: "Download CSV" })).toBeVisible();
    expect(within(exportDialog).getAllByRole("heading", { name: "Export Cloud usage" })).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await act(async () => { await userEvent.keyboard("{Escape}"); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(exportTrigger).toHaveFocus();
    await click(within(tools).getByRole("button", { name: "Redeem Cloud code" }));
    const redeemDialog = screen.getByRole("dialog", { name: "Redeem Cloud code" });
    expect(within(redeemDialog).getByRole("textbox", { name: "Cloud gift code" })).toBeVisible();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Download CSV" })).not.toBeInTheDocument();
    expect(mocks.request.mock.calls.filter(([action]) => action === "redeem-gift")).toHaveLength(0);
  });
  it.each(["cloud.billing.title", "cloud.export.open", "cloud.gift.redeem_action"])("closes %s when its settings panel becomes hidden and does not reopen on return", async (key) => {
    mocks.account.gift_redemption_available = true;
    const view = show({ active: true });
    await screen.findByText("Work laptop");
    await click(screen.getByRole("button", { name: copy(key) }));
    expect(screen.getByRole("dialog", { name: copy(key) })).toBeVisible();
    view.rerender(<MemoryRouter><CloudMembershipCard active={false} /><Location /></MemoryRouter>);
    await waitFor(() => { expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); });
    view.rerender(<MemoryRouter><CloudMembershipCard active /><Location /></MemoryRouter>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps an in-flight redemption receipt when history hides its Cloud settings panel", async () => {
    mocks.account.gift_redemption_available = true;
    const view = show({ active: true });
    await screen.findByText("Work laptop");
    let finishRedemption;
    mocks.request.mockImplementation((action) => action === "redeem-gift"
      ? new Promise((resolve) => { finishRedemption = resolve; }) : Promise.resolve({ machines: [] }));
    mocks.refresh.mockResolvedValue({ ...mocks.account, gifts: [] });
    await click(screen.getByRole("button", { name: copy("cloud.gift.redeem_action") }));
    fireEvent.change(screen.getByRole("textbox", { name: copy("cloud.gift.code_label") }), { target: { value: "GIFT-CODE" } });
    await click(screen.getByRole("button", { name: copy("cloud.gift.confirm") }));
    await waitFor(() => { expect(finishRedemption).toBeTypeOf("function"); });
    view.rerender(<MemoryRouter><CloudMembershipCard active={false} /><Location /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await act(async () => { finishRedemption({ gift: { id: "gift-1", duration_days: 30, starts_at: "2026-10-11", ends_at: "2026-11-10" } }); });
    view.rerender(<MemoryRouter><CloudMembershipCard active /><Location /></MemoryRouter>);
    await click(screen.getByRole("button", { name: copy("cloud.gift.redeem_action") }));
    expect(screen.getByText(copy("cloud.gift.refresh_needed"))).toBeVisible();
    expect(screen.queryByRole("textbox", { name: copy("cloud.gift.code_label") })).not.toBeInTheDocument();
    expect(mocks.request.mock.calls.filter(([action]) => action === "redeem-gift")).toHaveLength(1);
  });
  it.each([
    [{ status: "trial", trial_ends_at: "2026-11-10" }, "cloud.membership.trial_until", "Nov 10, 2026"],
    [{ status: "active", expires_at: "2027-10-04" }, "cloud.membership.active_until", "Oct 4, 2027"],
    [{ status: "active", access_source: "gift", expires_at: "2027-10-04" }, "cloud.membership.gift_until", "Oct 4, 2027"],
    [{ status: "expired", expires_at: "2024-10-04" }, "cloud.membership.expired_on", "Oct 4, 2024"],
  ])("combines authoritative %j membership and its date into one summary", async (membership, key, date) => {
    mocks.account.membership = { ...membership, machine_limit: 99, can_read_cloud: true };
    mocks.account.subscriptions = [];
    show({ heading: "Cloud", showTitle: false }); await screen.findByText("Work laptop");
    expect(screen.getByText(copy(key, { date }))).toBeVisible();
    expect(screen.queryByRole("button", { name: copy("cloud.status.trial") })).not.toBeInTheDocument();
  });
  it.each([null, "invalid-date", "2099-10-04"])("keeps expired status honest without showing a future availability date (%s)", async (date) => {
    mocks.account.membership = { status: "expired", expires_at: date, can_read_cloud: false };
    mocks.account.subscriptions = [];
    show(); await screen.findByText("Work laptop");
    expect(screen.getByText(copy("cloud.status.expired"))).toBeVisible();
    expect(screen.queryByText(/Active until|Available until|2099/)).not.toBeInTheDocument();
  });
  it("keeps the supplied sync control inside the same card as billing tools and separate from devices", async () => {
    show({ syncControl: <button type="button">{copy("settings.account.cloudSync")}</button> });
    await screen.findByText("Work laptop");
    const tools = screen.getByRole("region", { name: "Tools & billing" });
    expect(within(tools).getByRole("button", { name: copy("settings.account.cloudSync") })).toBeInTheDocument();
    expect(within(tools).getByRole("button", { name: copy("cloud.billing.title") })).toBeInTheDocument();
    expect(within(tools).queryByText("Work laptop")).not.toBeInTheDocument();
  });
  it("groups pending payments and order lookup in one billing dialog", async () => {
    show();
    await screen.findByText("Work laptop");
    expect(screen.queryByRole("link", { name: /Continue payment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Order ID" })).not.toBeInTheDocument();
    await openPaymentHistory();
    expect(screen.getByRole("dialog", { name: copy("cloud.billing.title") })).toBeVisible();
    const continuePayment = screen.getByRole("link", { name: /Continue payment/ });
    expect(continuePayment).toBeVisible();
    expect(continuePayment).toHaveClass("sm:row-start-1", "sm:self-start", "sm:items-start", "min-h-10", "text-sm");
    expect(screen.queryByRole("textbox", { name: "Order ID" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find an order" })).toHaveAttribute("aria-expanded", "false");
    await click(screen.getByRole("link", { name: /Continue payment/ }));
    const nextPath = screen.getByTestId("location").textContent;
    expect(nextPath).toMatch(new RegExp(`^/billing/checkout\\?order=${orderId}&flow=`));
    expect(readCloudAction(nextPath, mocks.userId)).toMatchObject({ ownerId: mocks.userId, orderId, trial: false });
  });
  it("does not authorize an automatic payment from a modified pending-order click", async () => {
    show();
    await screen.findByText("Work laptop");
    await openPaymentHistory();
    fireEvent.click(screen.getByRole("link", { name: /Continue payment/ }), { ctrlKey: true });
    expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });
  it("keeps duplicate-payment review links explicit without authorizing checkout", async () => {
    mocks.account.pending_orders = [];
    mocks.account.conflict_orders = [{ id: orderId, retry_payment_conflict_at: "2026-10-07T15:00:00Z" }];
    show();
    await screen.findByText("Work laptop");
    await openPaymentHistory();
    await click(screen.getByRole("link", { name: /Review duplicate payment/ }));
    expect(screen.getByTestId("location")).toHaveTextContent(`/billing/checkout?order=${orderId}`);
    expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
  });
  it("authorizes only an explicitly entered valid order for the current account", async () => {
    show();
    await screen.findByText("Work laptop");
    await openPaymentHistory();
    await click(screen.getByRole("button", { name: "Find an order" }));
    expect(screen.getByRole("textbox", { name: "Order ID" })).toHaveFocus();
    fireEvent.change(screen.getByRole("textbox", { name: "Order ID" }), { target: { value: orderId } });
    await click(screen.getByRole("button", { name: "Recover order" }));
    const nextPath = screen.getByTestId("location").textContent;
    expect(readCloudAction(nextPath, mocks.userId)).toMatchObject({ ownerId: mocks.userId, orderId });
  });
  it("uses familiar OS labels without replacing an unknown device platform", async () => {
    mocks.request.mockResolvedValue({ machines: [
      { machine_id: "mac", name: "Mac laptop", platform: "MacIntel" },
      { machine_id: "win", name: "Work PC", platform: "Win32" },
      { machine_id: "other", name: "Other workstation", platform: "CustomOS" },
    ], machine_count: 3, machine_limit: 99 });
    show();
    await screen.findByText("Mac laptop");
    expect(screen.getByText("macOS")).toBeInTheDocument();
    expect(screen.getByText("Windows")).toBeInTheDocument();
    expect(screen.getByText("CustomOS")).toBeInTheDocument();
  });
  it("keeps payment history collapsed until it is requested", async () => {
    mocks.account.payments = [{ id: "receipt", provider: "waffo", currency: "USD", amount_cents: 499,
      refunded_cents: 0, paid_at: "2026-10-04", starts_at: "2026-10-04", ends_at: "2026-11-04" }];
    show();
    await screen.findByText("Work laptop");
    expect(screen.queryByText("Waffo", { exact: true })).not.toBeInTheDocument();
    await openPaymentHistory();
    await waitFor(() => expect(screen.getByText("Waffo", { exact: true })).toBeVisible());
  });
  it("uses a cached order only to prefill lookup when production receipts cannot identify that order", async () => {
    mocks.account.pending_orders = [];
    mocks.account.payments = [{ id: "independent-payment-id", provider: "waffo", currency: "USD", amount_cents: 499,
      paid_at: "2026-10-04", starts_at: "2026-10-04", ends_at: "2026-11-04" }];
    saveCloudPurchase("account-1", { sku: "cloud_usd_monthly", provider: "waffo", request_id: orderId, order_id: orderId });
    show(); await screen.findByText("Work laptop");
    await openPaymentHistory();
    expect(screen.queryByRole("link", { name: "Continue payment" })).not.toBeInTheDocument();
    expect(screen.queryByText(orderId)).not.toBeInTheDocument();
    expect(screen.getByText("Paid", { exact: true })).toBeVisible();
    expect(screen.queryByText(/Refunded/)).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Find an order" }));
    expect(screen.getByRole("textbox", { name: "Order ID" })).toHaveValue(orderId);
    expect(screen.getByRole("textbox", { name: "Order ID" })).toHaveFocus();
    expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
  });
  it("shows refunds only for positive refunded amounts and excludes settled pending records", async () => {
    mocks.account.pending_orders = [{ id: orderId, status: "paid" }];
    mocks.account.payments = [
      { id: "paid", provider: "waffo", currency: "USD", amount_cents: 499, refunded_cents: 0,
        paid_at: "2026-10-04", starts_at: "2026-10-04", ends_at: "2026-11-04" },
      { id: "refund", provider: "waffo", currency: "USD", amount_cents: 499, refunded_cents: 249,
        paid_at: "2026-09-04", starts_at: "2026-09-04", ends_at: "2026-10-04" },
    ];
    show(); await screen.findByText("Work laptop");
    await openPaymentHistory();
    expect(screen.queryByRole("link", { name: "Continue payment" })).not.toBeInTheDocument();
    const paidStatus = screen.getByText("Paid", { exact: true });
    const refundStatus = screen.getByText(copy("cloud.history.refunded", { amount: "US$2.49" }));
    expect(paidStatus).toBeVisible();
    expect(refundStatus).toBeVisible();
    for (const status of [paidStatus, refundStatus]) {
      expect(status).toHaveClass("sm:row-start-1", "sm:row-span-1", "sm:self-start", "text-sm");
      expect(status).not.toHaveClass("sm:row-span-2", "text-xs");
    }
  });
  it.each([true, false])("keeps the supplied Cloud heading visible for signed-in=%s without a duplicate brand heading", async (signedIn) => {
    mocks.signedIn = signedIn;
    show({ showTitle: false, heading: "Cloud" });
    expect(screen.getAllByRole("heading", { name: "Cloud", exact: true })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "TokenTracker Cloud" })).not.toBeInTheDocument();
  });
  it("shows payment recovery for past-due renewal instead of promising a renewal date", async () => {
    mocks.account.subscriptions[0].status = "past_due";
    mocks.account.subscriptions[0].next_billed_at = "2020-01-01";
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByText(/Payment needs attention/)).toBeInTheDocument();
    expect(screen.queryByText(/Renews/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manage subscription/ })).toBeEnabled();
  });
  it("provides Cloud file export controls directly in the read-only account card", async () => {
    mocks.account.membership.can_upload_cloud = false;
    show();
    await screen.findByText("Work laptop");
    await click(screen.getByRole("button", { name: "Export Cloud usage" }));
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy("trend.zoom.pick_range") })).toBeInTheDocument();
  });
  it.each([[], [{ id: "revoked-recent", state: "revoked", duration_days: 30 }]])(
    "honors current gift access even when recent history omits its active gift %j", async (gifts) => {
      mocks.account.membership.has_gift = true;
      mocks.account.gifts = gifts;
      mocks.account.subscriptions = [];
      mocks.account.pending_orders = [];
      show(); await screen.findByText("Work laptop");
      expect(screen.queryByRole("link", { name: "Renew Cloud" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "View Cloud plans" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open dashboard" })).not.toBeInTheDocument();
    },
  );
  it.each([false, "true"])("does not label has_gift %s as an authoritative gift", async (hasGift) => {
    mocks.account.membership.has_gift = hasGift;
    mocks.account.gifts = [];
    mocks.account.subscriptions = [];
    mocks.account.pending_orders = [];
    show(); await screen.findByText("Work laptop");
    expect(screen.queryByRole("link", { name: "Renew Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByText("Gifted Cloud")).not.toBeInTheDocument();
  });
  it("keeps gifted Cloud separate from paid bills and never invents a renewal", async () => {
    mocks.account.gift_redemption_available = true;
    mocks.account.membership.access_source = "gift";
    mocks.account.subscriptions = [];
    mocks.account.pending_orders = [];
    mocks.account.gifts = [{ id: "gift-1", duration_days: 30, starts_at: "2026-10-09", ends_at: "2026-11-08", state: "active" }];
    show(); await screen.findByText("Work laptop");
    expect(screen.getByText(/^Gifted Cloud until/)).toBeInTheDocument();
    expect(screen.queryByText("30 days of Cloud")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Redeem Cloud code" })).toBeEnabled();
    await click(screen.getByRole("button", { name: "Redeem Cloud code" }));
    expect(screen.getByRole("list", { name: "Cloud gifts" })).toBeInTheDocument();
    expect(screen.getByText("30 days of Cloud")).toBeInTheDocument();
    expect(screen.queryByText(/Renews on|Auto-renewal is off|Auto-renewal is paused/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Renew Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Waffo/)).not.toBeInTheDocument();
    expect(mocks.account.payments).toEqual([]);
  });
  it("keeps an upcoming gift and canceled recurring access distinct from the provider billing date", async () => {
    mocks.account.subscriptions[0].cancel_at_period_end = true;
    mocks.account.subscriptions[0].next_billed_at = "2027-11-04";
    mocks.account.membership.access_source = "payment";
    mocks.account.gifts = [{ id: "future-gift", duration_days: 90, starts_at: "2027-10-04", ends_at: "2028-01-02", state: "pending" }];
    show(); await screen.findByText("Work laptop");
    expect(screen.getByText(/^Active until/)).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Cloud gifts" }));
    expect(screen.getByText("Starts after current access")).toBeInTheDocument();
    expect(screen.getByText(/Active until/)).toHaveTextContent("Oct 4, 2027");
    expect(screen.getByText(/Auto-renewal is off/)).toBeInTheDocument();
    expect(screen.queryByText(/Renews on/)).not.toBeInTheDocument();
    expect(mocks.account.subscriptions[0].next_billed_at).toBe("2027-11-04");
  });
  it.each(["expired", "revoked"])("shows a %s gift without Cloud access or extra plan navigation", async (state) => {
    mocks.account.subscriptions = [];
    mocks.account.membership = { status: "free", access_source: "none", can_read_cloud: false, can_upload_cloud: false };
    mocks.account.gifts = [{ id: "old-gift", duration_days: 365, starts_at: "2024-10-09", ends_at: "2025-10-09", state }];
    show(); await screen.findByText("Work laptop");
    await click(screen.getByRole("button", { name: "Cloud gifts" }));
    expect(screen.getByText(state === "expired" ? "Expired" : "Revoked")).toBeInTheDocument();
    expect(screen.queryByText("Gifted Cloud")).not.toBeInTheDocument();
    expect(screen.queryByText("Cloud active")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View Cloud plans" })).not.toBeInTheDocument();
  });
  it("keeps self-hosted device management free without trial, prices or an official payment portal", async () => {
    mocks.account.membership = { status: "self_hosted", hosting_mode: "self_hosted", machine_limit: null,
      trial_available: false, can_read_cloud: true, can_upload_cloud: true };
    mocks.request.mockResolvedValue({ machines: [], machine_count: 3, machine_limit: null });
    show();
    await screen.findByText("3 registered sync devices");
    expect(screen.getByText("Self-hosted · free")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Self-hosted · free" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Manage subscription" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View Cloud plans" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel auto-renewal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue payment/ })).not.toBeInTheDocument();
  });
  it("shows payment conflicts with billing recovery and keeps the confirmed membership", async () => {
    mocks.account.subscriptions = [];
    mocks.account.pending_orders = [];
    mocks.account.conflict_orders = [{ id: orderId, status: "paid", retry_payment_conflict_at: "2026-10-07T15:00:00Z" }];
    mocks.account.payments = [{
      id: "waffo-paid", provider: "waffo", currency: "USD", amount_cents: 499, refunded_cents: 0,
      paid_at: "2026-10-04", starts_at: "2026-10-04", ends_at: "2026-11-04",
    }];
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByRole("alert")).toHaveTextContent(/duplicate charge/);
    expect(screen.getByText(/^Active until/)).toBeInTheDocument();
    await openPaymentHistory();
    expect(screen.getByRole("button", { name: "View payment bills" })).toBeEnabled();
    expect(screen.getByRole("link", { name: /Review duplicate payment/ })).toHaveAttribute("href", `/billing/checkout?order=${orderId}`);
    expect(screen.queryByRole("link", { name: "Renew Cloud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Continue payment/ })).not.toBeInTheDocument();
  });
  it("deduplicates a legacy pending entry against a closed conflict record", async () => {
    mocks.account.pending_orders = [{ id: orderId, status: "ready" }];
    mocks.account.conflict_orders = [{ id: orderId, status: "closed", retry_payment_conflict_at: "2026-10-07T15:00:00Z" }];
    show();
    await screen.findByText("Work laptop");
    await openPaymentHistory();
    expect(screen.getAllByRole("link", { name: /Review duplicate payment/ })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Continue payment/ })).not.toBeInTheDocument();
  });
  it("keeps the paid-access deadline distinct from the provider's next billing date", async () => {
    mocks.account.subscriptions[0].next_billed_at = "2027-11-04";
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByText(/Active until/)).toHaveTextContent("Oct 4, 2027");
    expect(screen.getByText(/Renews on/)).toHaveTextContent("Nov 4, 2027");
  });
  it("shows an ongoing provider renewal even after a full refund removes paid access", async () => {
    mocks.account.membership = {
      status: "expired", expires_at: null, can_read_cloud: false, can_upload_cloud: false,
    };
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByText("Cloud expired")).toBeInTheDocument();
    expect(screen.getByText(/Renews on/)).toHaveTextContent("Oct 4, 2027");
    expect(screen.queryByText(/Active until/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel auto-renewal" })).toBeEnabled();
    await click(screen.getByRole("button", { name: "Cancel auto-renewal" }));
    expect(screen.getByText(/current Cloud access stays as shown above/)).toBeInTheDocument();
    expect(screen.queryByText(/remains available until/)).not.toBeInTheDocument();
  });
  it.each([null, "invalid-date"])("does not guess a missing or invalid next billing date (%s) from membership expiry", async (date) => {
    mocks.account.subscriptions[0].next_billed_at = date;
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByText(/next billing date is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Renews on/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage subscription" })).toBeEnabled();
    expect(screen.getByText(/Active until/)).toHaveTextContent("Oct 4, 2027");
  });
  it("shows paused renewal separately while keeping explicit subscription management and cancellation", async () => {
    mocks.account.subscriptions[0].status = "paused";
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByText(/Auto-renewal is paused/)).toBeInTheDocument();
    expect(screen.queryByText(/Auto-renewal is off/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Renews on/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage subscription" })).toBeEnabled();
    await click(screen.getByRole("button", { name: "Cancel auto-renewal" }));
    expect(screen.getByRole("button", { name: "Confirm cancellation" })).toBeEnabled();
    expect(mocks.request.mock.calls.filter(([action])=>action === "cancel")).toHaveLength(0);
    await click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(mocks.request).toHaveBeenCalledWith("cancel", expect.objectContaining({ body: { subscription_id: "sub_test" } }));
  });
  it("discards device data returned for the previous account", async () => {
    let resolvePrevious;
    mocks.request.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePrevious = resolve; }),
    ).mockResolvedValue({
      machines: [{ machine_id: "new-device", name: "Second account device" }],
      machine_count: 1,
      machine_limit: 5,
    });
    const view = show();
    await act(async () => { await Promise.resolve(); });
    mocks.userId = "account-2";
    view.rerender(<MemoryRouter><CloudMembershipCard /></MemoryRouter>);
    await screen.findByText("Second account device");
    await act(async () => {
      resolvePrevious({
        machines: [{ machine_id: "private-old", name: "Private old laptop" }],
        machine_count: 1,
        machine_limit: 5,
      });
    });
    expect(screen.queryByText("Private old laptop")).not.toBeInTheDocument();
    expect(screen.getByText("Second account device")).toBeInTheDocument();
  });
  it.each(["remove-device", "resume-device"])(
    "does not clear the new account's local connection after a delayed %s",
    async (action) => {
      let resolveMutation;
      mocks.request.mockImplementation((name) => {
        if (name === action)
          return new Promise((resolve) => { resolveMutation = resolve; });
        return Promise.resolve({
          machines: [{
            machine_id: "current",
            name: mocks.userId === "account-1" ? "Old laptop" : "Second account device",
            status: action === "resume-device" ? "paused" : "active",
            is_current: true,
          }],
          machine_count: action === "resume-device" ? 0 : 1,
          machine_limit: 5,
        });
      });
      const view = show();
      await screen.findByText("Old laptop");
      if (action === "remove-device") {
        await click(screen.getByRole("button", { name: "Pause", exact: true }));
        await click(screen.getByRole("button", { name: "Pause Cloud sync" }));
      } else await click(screen.getByRole("button", { name: "Resume sync" }));
      mocks.userId = "account-2";
      view.rerender(<MemoryRouter><CloudMembershipCard /></MemoryRouter>);
      await screen.findByText("Second account device");
      await act(async () => { resolveMutation({ ok: true }); });
      expect(mocks.clearToken).not.toHaveBeenCalled();
      expect(screen.queryByText(/Cloud sync resumed/)).not.toBeInTheDocument();
      expect(screen.getByText("Second account device")).toBeInTheDocument();
    },
  );
  it("does not open a previous account's portal after an account switch", async () => {
    let resolvePortal;
    mocks.request.mockImplementation((action) => action === "portal"
      ? new Promise((resolve) => { resolvePortal = resolve; })
      : Promise.resolve({ machines: [], machine_count: 0, machine_limit: 5 }));
    const view = show();
    await click(screen.getByRole("button", { name: "Manage subscription" }));
    mocks.userId = "account-2";
    view.rerender(<MemoryRouter><CloudMembershipCard /></MemoryRouter>);
    await act(async () => { resolvePortal({ url: "https://pancake.waffo.ai/consumer/portal/login" }); });
    expect(mocks.external).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Manage subscription" })).toBeEnabled();
  });
  it("opens Waffo bills with an explicit purchase-email sign-in instruction", async () => {
    mocks.request.mockImplementation(async (action) => action === "portal"
      ? { url: "https://pancake.waffo.ai/consumer/portal/login" }
      : { machines: [], machine_count: 0, machine_limit: 5 });
    show();
    await screen.findByText("No Cloud devices linked yet.");
    expect(screen.queryByRole("button", { name: /sign in with the email used at checkout/ })).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Manage subscription" }));
    expect(mocks.request).toHaveBeenCalledWith("portal", expect.objectContaining({ body: { subscription_id: "sub_test" } }));
    expect(mocks.external).toHaveBeenCalledWith("https://pancake.waffo.ai/consumer/portal/login");
  });
  it("keeps legacy billing channels distinct from Waffo history", async () => {
    mocks.account.payments = ["waffo", "paddle", "wechat", "alipay"].map((provider) => ({
      id: provider, provider, currency: "USD", amount_cents: 599,
      refunded_cents: 0, paid_at: "2026-10-04", starts_at: "2026-10-04", ends_at: "2026-11-04",
    }));
    show();
    await screen.findByText("Work laptop");
    await openPaymentHistory();
    for (const name of ["Waffo", "Paddle", "WeChat Pay", "Alipay"])
      expect(screen.getByText(name, { exact: true })).toBeInTheDocument();
  });
  it("offers Waffo bills for a fixed-term purchase without a subscription", async () => {
    mocks.account.subscriptions = [];
    mocks.account.payments = [{
      id: "waffo-fixed", provider: "waffo", currency: "USD", amount_cents: 499,
      refunded_cents: 0, paid_at: "2026-10-04", starts_at: "2026-10-04", ends_at: "2026-11-04",
    }];
    mocks.request.mockImplementation(async (action) => action === "portal"
      ? { url: "https://pancake.waffo.ai/consumer/portal/login" }
      : { machines: [], machine_count: 0, machine_limit: 5 });
    show();
    await screen.findByText("No Cloud devices linked yet.");
    await openPaymentHistory();
    expect(screen.queryByRole("button", { name: /sign in with the email used at checkout/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel auto-renewal" })).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "View payment bills" }));
    expect(mocks.request).toHaveBeenCalledWith("portal", expect.objectContaining({ body: {} }));
    expect(mocks.external).toHaveBeenCalledWith("https://pancake.waffo.ai/consumer/portal/login");
    expect(screen.queryByRole("link", { name: "Renew Cloud" })).not.toBeInTheDocument();
  });
  it("keeps cancellation pending for explicit retry when the provider rejects it", async () => {
    mocks.request.mockImplementation(async (action) => {
      if (action === "cancel") throw { code: "billing_network_error" };
      return { machines: [], machine_count: 0, machine_limit: 5 };
    });
    show();
    await click(screen.getByRole("button", { name: "Cancel auto-renewal" }));
    await click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/connection was interrupted/);
    expect(screen.getByText(/Renews on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm cancellation" })).toBeEnabled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/Auto-renewal is off/)).not.toBeInTheDocument();
  });
  it("discards a cancellation failure from the previous account", async () => {
    let rejectCancel;
    mocks.request.mockImplementation((action) => action === "cancel"
      ? new Promise((_resolve, reject) => { rejectCancel = reject; })
      : Promise.resolve({ machines: [], machine_count: 0, machine_limit: 5 }));
    const view = show();
    await click(screen.getByRole("button", { name: "Cancel auto-renewal" }));
    await click(screen.getByRole("button", { name: "Confirm cancellation" }));
    mocks.userId = "account-2";
    view.rerender(<MemoryRouter><CloudMembershipCard /></MemoryRouter>);
    await act(async () => { rejectCancel({ code: "billing_network_error" }); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm cancellation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel auto-renewal" })).toBeEnabled();
  });
  it("keeps device context and the current token when the server rejects resume", async () => {
    mocks.request.mockImplementation(async (action) => {
      if (action === "resume-device") throw { code: "cloud_machine_limit" };
      return {
        machines: [
          {
            machine_id: "paused",
            name: "Paused laptop",
            status: "paused",
            is_current: true,
          },
        ],
        machine_count: 0,
        machine_limit: 5,
      };
    });
    show();
    await screen.findByText("Paused laptop");
    await click(screen.getByRole("button", { name: "Resume sync" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "reached its Cloud sync device limit",
    );
    expect(screen.getByText("Paused laptop")).toBeInTheDocument();
    expect(mocks.clearToken).not.toHaveBeenCalled();
    expect(screen.queryByText(/Cloud sync resumed/)).not.toBeInTheDocument();
  });
  it("resumes a paused device only after explicit action and replaces its current token", async () => {
    const paused = {
      machine_id: "opaque-slot-paused",
      name: "Paused laptop",
      is_current: true,
      status: "paused",
      last_seen_at: null,
    };
    const devices = {
      machines: [paused],
      machine_count: 0,
      machine_limit: 5,
      over_machine_limit: false,
    };
    mocks.request.mockImplementation(async (action) => {
      if (action === "resume-device") {
        paused.status = "active";
        devices.machine_count = 1;
        return {};
      }
      return devices;
    });
    show();
    await screen.findByText("Paused laptop");
    expect(screen.getByText("0 / 5 devices")).toBeInTheDocument();
    expect(
      mocks.request.mock.calls.filter(([action]) => action === "resume-device"),
    ).toHaveLength(0);
    await click(screen.getByRole("button", { name: "Resume sync" }));
    expect(mocks.request).toHaveBeenCalledWith(
      "resume-device",
      expect.objectContaining({ body: { machine_id: "opaque-slot-paused" } }),
    );
    expect(mocks.clearToken).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 / 5 devices")).toBeInTheDocument();
  });
  it("keeps resume disabled when all server-counted slots are occupied", async () => {
    mocks.request.mockResolvedValue({
      machines: [
        { machine_id: "paused", name: "Paused laptop", status: "paused" },
      ],
      machine_count: 5,
      machine_limit: 5,
    });
    show();
    await screen.findByText("Paused laptop");
    expect(screen.getByRole("button", { name: "Resume sync" })).toBeDisabled();
    expect(
      screen.getByText("Pause another device to free a sync slot."),
    ).toBeInTheDocument();
  });
  it("recovers the same request when a timeout happened before an order ID was returned", async () => {
    saveCloudPurchase("account-1", {
      sku: "cloud_cny_yearly",
      provider: "alipay",
      request_id: orderId,
    });
    show();
    await screen.findByText("Work laptop");
    await openPaymentHistory();
    expect(
      screen.getByRole("link", { name: "Resume previous purchase" }),
    ).toHaveAttribute("href", "/billing/checkout?sku=cloud_cny_yearly");
  });
  it("makes cancellation explicit and preserves the paid term", async () => {
    mocks.refresh.mockImplementation(async () => {
      mocks.account = {
        ...mocks.account,
        subscriptions: [{ ...mocks.account.subscriptions[0], cancel_at_period_end: true }],
      };
    });
    const view=show();
    await screen.findByText("Work laptop");
    expect(screen.getByText(/Renews on/)).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Cancel auto-renewal" }));
    expect(screen.getByText(/remains available until/)).toHaveTextContent(
      "2027",
    );
    expect(
      mocks.request.mock.calls.filter(([action]) => action === "cancel"),
    ).toHaveLength(0);
    await click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(mocks.request).toHaveBeenCalledWith(
      "cancel",
      expect.objectContaining({ body: { subscription_id: "sub_test" } }),
    );
    expect(mocks.refresh).toHaveBeenCalled();
    await act(async () => {
      view.rerender(<MemoryRouter><CloudMembershipCard /></MemoryRouter>);
    });
    expect(screen.getByText("Auto-renewal is off.")).toBeInTheDocument();
    expect(screen.queryByText(/Renews on/)).not.toBeInTheDocument();
    expect(screen.getByText(/Active until/)).toHaveTextContent("2027");
  });
  it("clears an ambiguous cancellation error only after the server confirms renewal is off", async () => {
    mocks.request.mockImplementation(async (action) => {
      if (action === "cancel") throw { code: "billing_network_error" };
      return { machines: [], machine_count: 0, machine_limit: 5 };
    });
    const view=show();
    await click(screen.getByRole("button", { name: "Cancel auto-renewal" }));
    await click(screen.getByRole("button", { name: "Confirm cancellation" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    mocks.account = {
      ...mocks.account,
      subscriptions: [{ ...mocks.account.subscriptions[0], cancel_at_period_end: true }],
    };
    await act(async () => {
      view.rerender(<MemoryRouter><CloudMembershipCard /></MemoryRouter>);
    });
    expect(screen.getByText("Auto-renewal is off.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm cancellation" })).not.toBeInTheDocument();
  });
  it("shows unknown sync time honestly and pauses only the confirmed device slot", async () => {
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByText("Last sync time unavailable")).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Pause", exact: true }));
    expect(
      screen.getByText(/Local data and existing Cloud history stay/),
    ).toBeInTheDocument();
    expect(
      mocks.request.mock.calls.filter(([action]) => action === "remove-device"),
    ).toHaveLength(0);
    await click(screen.getByRole("button", { name: "Pause Cloud sync" }));
    expect(mocks.request).toHaveBeenCalledWith(
      "remove-device",
      expect.objectContaining({ body: { machine_id: "opaque-slot-1" } }),
    );
  });
  it("discloses the server read-only deadline and provides pending-order recovery", async () => {
    mocks.account.membership = {
      status: "expired",
      read_only_until: "2026-11-03",
      machine_limit: 1,
      can_read_cloud: true,
      can_upload_cloud: false,
    };
    mocks.account.subscriptions = [];
    show();
    await screen.findByText("Work laptop");
    expect(screen.getByText(/Read and export its history until/)).toHaveTextContent(
      "Nov 3, 2026",
    );
    expect(screen.getByText(/Free daily community uploads and leaderboard participation continue/)).toHaveTextContent(/pause other active devices/);
    expect(screen.queryByRole("link", { name: "Open dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Cloud usage" })).toBeInTheDocument();
    await openPaymentHistory();
    expect(screen.getByRole("link", { name: /Continue payment/ })).toHaveAttribute(
      "href",
      `/billing/checkout?order=${orderId}`,
    );
    await click(screen.getByRole("button", { name: "Find an order" }));
    await act(async () => {
      await userEvent.type(
        screen.getByRole("textbox", { name: "Order ID" }),
        "invalid",
      );
    });
    await click(screen.getByRole("button", { name: "Recover order" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "complete TokenTracker order ID",
    );
  });
});
