import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../lib/copy";
import { formatCloudMoney } from "../lib/cloud-billing";
import { CloudPage } from "./CloudPage.jsx";

const state = vi.hoisted(() => ({ account: null, loading: false, catalogPrices: undefined, providerAvailable: true, signedIn: true, openLoginModal: vi.fn() }));
const prices = [
  { sku: "cloud_usd_monthly_fixed", billing_mode: "fixed", currency: "USD", amount_cents: 499, term_months: 1 },
  { sku: "cloud_usd_yearly_fixed", billing_mode: "fixed", currency: "USD", amount_cents: 3999, term_months: 12 },
  { sku: "cloud_usd_monthly", billing_mode: "recurring", currency: "USD", amount_cents: 699, term_months: 1 },
  { sku: "cloud_usd_yearly", billing_mode: "recurring", currency: "USD", amount_cents: 5999, term_months: 12 },
];

vi.mock("@lucasmarkes/hairline/react", () => ({ Hub: () => null }));
vi.mock("../contexts/LoginModalContext.jsx", () => ({
  useLoginModal: () => ({ openLoginModal: state.openLoginModal }),
}));
vi.mock("../hooks/use-cloud-billing.js", () => ({
  useCloudCatalog: () => ({
    catalog: {
      environment: "live",
      policy: { phase: "active", launch_at: "2000-01-01", hosting_mode: "hosted" },
      prices: state.catalogPrices === undefined ? prices : state.catalogPrices,
      providers: { waffo: state.providerAvailable },
      limits: { machines: 99, sync_minutes: 15, hourly_history_days: 90, daily_history_months: 24, trial_days: 7 },
    },
    loading: false,
  }),
  useCloudAccount: () => ({
    account: state.account,
    loading: state.loading,
    auth: { signedIn: state.signedIn, user: state.signedIn ? { id: "renewal-user" } : null, getAccessToken: vi.fn() },
    refresh: vi.fn(),
  }),
}));

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function Page() {
  return <MemoryRouter initialEntries={["/cloud"]}><CloudPage /><Location /></MemoryRouter>;
}

const click = (target) => act(async () => { await userEvent.click(target); });
const activeMembership = { status: "active", trial_available: false, access_source: "payment", expires_at: "2099-10-11T00:00:00Z" };

beforeEach(() => {
  setCopyLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  state.loading = false;
  state.catalogPrices = undefined;
  state.providerAvailable = true;
  state.signedIn = true;
  state.openLoginModal.mockReset();
  state.account = { membership: activeMembership, subscriptions: [], gifts: [] };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Cloud paid-term renewal", () => {
  it("extends a current paid term with fixed annual or monthly pricing", async () => {
    render(<Page />);
    expect(screen.getByText(formatCloudMoney(3999, "USD"))).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: copy("cloud.billing_mode.recurring") })).not.toBeInTheDocument();
    expect(screen.getByText(copy("cloud.billing_mode.fixed"))).toBeInTheDocument();
    await click(screen.getByRole("button", { name: copy("cloud.action.renew") }));
    expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?sku=cloud_usd_yearly_fixed");
    await click(screen.getByRole("button", { name: copy("cloud.term.monthly") }));
    expect(screen.getByText(formatCloudMoney(499, "USD"))).toBeInTheDocument();
    await click(screen.getByRole("button", { name: copy("cloud.action.renew") }));
    expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?sku=cloud_usd_monthly_fixed");
  });

  it("resolves loaded paid access to fixed pricing before exposing an enabled renewal", async () => {
    state.account = { membership: null, subscriptions: [], gifts: [] };
    state.loading = true;
    const view = render(<Page />);
    expect(screen.queryByRole("button", { name: copy("cloud.action.renew") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy("cloud.action.try", { days: 7 }) })).toBeDisabled();
    state.account = { membership: activeMembership, subscriptions: [], gifts: [] };
    state.loading = false;
    view.rerender(<Page />);
    expect(screen.queryByText(formatCloudMoney(5999, "USD"))).not.toBeInTheDocument();
    expect(screen.getByText(formatCloudMoney(3999, "USD"))).toBeInTheDocument();
    await click(screen.getByRole("button", { name: copy("cloud.action.renew") }));
    expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_yearly_fixed");
  });

  it("keeps a canceled renewal's remaining paid term and only offers a fixed extension", async () => {
    state.account.subscriptions = [{ status: "active", cancel_at_period_end: true, next_billed_at: "2099-10-11T00:00:00Z" }];
    render(<Page />);
    expect(screen.getByText(copy("cloud.status.active"))).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: copy("cloud.billing_mode.recurring") })).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: copy("cloud.action.renew") }));
    expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_yearly_fixed");
  });

  it.each(["active", "trialing", "past_due", "paused"])("keeps an uncanceled %s subscription in management", (status) => {
    state.account.subscriptions = [{ status, cancel_at_period_end: false }];
    render(<Page />);
    expect(screen.getByRole("link", { name: copy("cloud.action.manage_membership") })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("button", { name: copy("cloud.action.renew") })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: copy("cloud.billing_mode.recurring") })).not.toBeInTheDocument();
  });

  it("keeps gifted active access in management even without the optional gift list", () => {
    state.account.membership = { ...activeMembership, access_source: "gift" };
    render(<Page />);
    expect(screen.getByRole("link", { name: copy("cloud.action.manage_membership") })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("button", { name: copy("cloud.action.renew") })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: copy("cloud.billing_mode.recurring") })).not.toBeInTheDocument();
  });

  it("offers a trial without implying an automatic renewal contract", async () => {
    state.account.membership = { status: "free", trial_available: true };
    render(<Page />);
    expect(screen.queryByRole("switch", { name: copy("cloud.billing_mode.recurring") })).not.toBeInTheDocument();
    expect(screen.getByText(copy("cloud.plan.trial_setup_hint"))).toBeInTheDocument();
    await click(screen.getByRole("button", { name: copy("cloud.action.try", { days: 7 }) }));
    expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?intent=trial&sku=cloud_usd_yearly");
  });

  it.each([
    { condition: "missing prices", catalogPrices: null, signedIn: true },
    { condition: "empty prices", catalogPrices: [], signedIn: true },
    { condition: "missing selected annual plan", catalogPrices: prices.filter((price) => price.term_months === 1), signedIn: true },
    { condition: "missing prices", catalogPrices: null, signedIn: false },
    { condition: "empty prices", catalogPrices: [], signedIn: false },
    { condition: "missing selected annual plan", catalogPrices: prices.filter((price) => price.term_months === 1), signedIn: false },
  ])("keeps trial unavailable for $condition until a valid selected SKU exists, signedIn=$signedIn", async ({ catalogPrices, signedIn }) => {
    state.catalogPrices = catalogPrices;
    state.signedIn = signedIn;
    state.account.membership = { status: "free", trial_available: true };
    render(<Page />);
    const trial = screen.getByRole("button", { name: copy("cloud.action.try", { days: 7 }) });
    expect(trial).toBeDisabled();
    await click(trial);
    expect(screen.getByTestId("location")).toHaveTextContent("/cloud");
    expect(state.openLoginModal).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
  });

  it("keeps an eligible free trial available independently of payment provider readiness", async () => {
    state.providerAvailable = false;
    state.account.membership = { status: "free", trial_available: true };
    render(<Page />);
    const trial = screen.getByRole("button", { name: copy("cloud.action.try", { days: 7 }) });
    expect(trial).toBeEnabled();
    await click(trial);
    expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?intent=trial&sku=cloud_usd_yearly");
  });

  it.each(["free", "trial", "expired"])("preserves the purchase billing choice for a %s account without an available trial", async (status) => {
    state.account.membership = { status, trial_available: false };
    render(<Page />);
    const toggle = screen.getByRole("switch", { name: copy("cloud.billing_mode.recurring") });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await click(screen.getByRole("button", { name: copy("cloud.action.buy_pro") }));
    expect(screen.getByTestId("location")).toHaveTextContent("sku=cloud_usd_yearly_fixed");
    expect(screen.queryByRole("button", { name: copy("cloud.action.renew") })).not.toBeInTheDocument();
  });
});
