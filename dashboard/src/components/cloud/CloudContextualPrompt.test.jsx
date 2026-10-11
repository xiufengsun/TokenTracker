import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCopyLocale } from "../../lib/copy";
import { publishCloudPromptBilling, recordCloudPromptIntent, recordCloudPromptFailure } from "../../lib/cloud-prompt-policy.js";
import { CloudContextualPrompt, CloudDeadlinePrompt } from "./CloudContextualPrompt.jsx";
import { readCloudAction } from "../../lib/cloud-action-intent.js";

const now = Date.parse("2026-10-08T08:00:00Z");
let userId;
let counter = 0;
const membership = { status: "free", environment: "live", phase: "active", trial_available: true,
  can_read_cloud: false, can_upload_cloud: false };
const catalog = { environment: "live", policy: { phase: "active", launch_at: "2026-10-01" }, providers: { waffo: true }, checkout_verified: true,
  prices: [{ sku: "cloud_usd_monthly", currency: "USD", amount_cents: 499, term_months: 1, billing_mode: "recurring" },
    { sku: "cloud_usd_yearly", currency: "USD", amount_cents: 3999, term_months: 12, billing_mode: "recurring" }] };
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function show(props = {}) {
  return render(<MemoryRouter><CloudContextualPrompt userId={userId} {...props} /><Location /></MemoryRouter>);
}
beforeEach(() => {
  setCopyLocale("en");
  vi.spyOn(Date, "now").mockReturnValue(now);
  localStorage.clear();
  sessionStorage.clear();
  userId = `component-user-${++counter}`;
  publishCloudPromptBilling("catalog", catalog, null, now);
  publishCloudPromptBilling("account", { membership }, userId, now);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("contextual Cloud panels", () => {
  it("does not render a popup or reminder on initial opening", () => {
    show();
    expect(screen.queryByRole("region", { name: "Cloud options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("offers the relevant trial inline after an action, keeps free use visible, and performs no request", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    recordCloudPromptIntent(userId, "sync");
    const local = vi.fn();
    show({ localHost: true, onContinueLocal: local });
    expect(screen.getByRole("link", { name: "Try Cloud free" })).toHaveAttribute("href", "/cloud");
    expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
    expect(screen.getByText(/leaderboard participation do not require membership/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { await userEvent.click(screen.getByRole("button", { name: "Use local data" })); });
    expect(local).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
  it("starts the default catalog trial only on an actual click with its account-owned action", async () => {
    const request = vi.spyOn(globalThis, "fetch");
    recordCloudPromptIntent(userId, "sync");
    show();
    expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
    await act(async () => { await userEvent.click(screen.getByRole("link", { name: "Try Cloud free" })); });
    const path = screen.getByTestId("location").textContent;
    expect(path).toMatch(/^\/billing\/checkout\?intent=trial&sku=cloud_usd_yearly&flow=/);
    expect(readCloudAction(path, userId)).toMatchObject({ trial: true, sku: "cloud_usd_yearly", ownerId: userId });
    expect(readCloudAction(path, "other-account")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([undefined, [], [{ sku: "", currency: "USD", amount_cents: 3999, term_months: 12, billing_mode: "recurring" }]])(
    "returns to plans without creating an action if the current catalog has no valid price: %j", async (prices) => {
      publishCloudPromptBilling("catalog", { ...catalog, prices }, null, now);
      recordCloudPromptIntent(userId, "sync");
      show();
      await act(async () => { await userEvent.click(screen.getByRole("link", { name: "Try Cloud free" })); });
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
      expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
    },
  );
  it("rechecks catalog freshness on click rather than authorizing an old rendered trial offer", async () => {
    recordCloudPromptIntent(userId, "sync");
    show();
    Date.now.mockReturnValue(now + 11 * 60 * 1000);
    await act(async () => { await userEvent.click(screen.getByRole("link", { name: "Try Cloud free" })); });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
    expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
  });
  it("dismisses across panels and promotional scenes while keeping another account independent", async () => {
    recordCloudPromptIntent(userId, "sync");
    const view = show();
    await act(async () => { await userEvent.click(screen.getByRole("button", { name: "Dismiss Cloud reminder" })); });
    expect(screen.queryByRole("region", { name: "Cloud options" })).not.toBeInTheDocument();
    act(() => {
      recordCloudPromptIntent(userId, "view");
      recordCloudPromptFailure(userId, "cloud_membership_required", membership, "account-summary");
    });
    expect(screen.queryByRole("link", { name: "Try Cloud free" })).not.toBeInTheDocument();
    const next = `${userId}-other`;
    act(() => { publishCloudPromptBilling("account", { membership }, next, now); recordCloudPromptIntent(next, "sync"); });
    view.rerender(<MemoryRouter><CloudContextualPrompt userId={next} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Try Cloud free" })).toBeInTheDocument();
  });
  it("does not sell a trial in sandbox or after the account becomes paid", () => {
    recordCloudPromptIntent(userId, "sync");
    publishCloudPromptBilling("catalog", { ...catalog, environment: "sandbox" }, null, now);
    const view = show();
    expect(screen.queryByRole("link", { name: "Try Cloud free" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Learn about Cloud" })).toHaveAttribute("href", "/cloud");
    act(() => { publishCloudPromptBilling("account", { membership: { ...membership, status: "active", can_read_cloud: true, can_upload_cloud: true } }, userId, now); });
    view.rerender(<MemoryRouter><CloudContextualPrompt userId={userId} /></MemoryRouter>);
    expect(screen.queryByRole("region", { name: "Cloud options" })).not.toBeInTheDocument();
  });
  it("keeps a paid device-limit notification operational", () => {
    publishCloudPromptBilling("account", { membership: { ...membership, status: "active", can_read_cloud: true, can_upload_cloud: true } }, userId, now);
    recordCloudPromptIntent(userId, "view");
    recordCloudPromptFailure(userId, "cloud_machine_limit", null, "account-devices");
    show();
    expect(screen.getByText(/sync allowance is full/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage membership" })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("link", { name: "Try Cloud free" })).not.toBeInTheDocument();
  });
  it.each(["past_due", "active"])("shows billing recovery rather than trial or plans for an expired account with a %s renewal contract", (status) => {
    const request = vi.spyOn(globalThis, "fetch");
    publishCloudPromptBilling("account", { membership: { ...membership, status: "expired", expires_at: "2026-11-08T08:00:00Z" },
      subscriptions: [{ status, cancel_at_period_end: false }] }, userId, now);
    recordCloudPromptIntent(userId, "sync");
    show();
    expect(screen.getByText(/automatic-renewal subscription is still open/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View payment bills" })).toHaveAttribute("href", "/settings?section=cloud");
    expect(screen.queryByRole("link", { name: "Try Cloud free" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View Cloud plans" })).not.toBeInTheDocument();
    expect(screen.getByText(/leaderboard participation do not require membership/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it("shows the current paid-term date when renewal is past due without promising another charge", () => {
    render(<MemoryRouter><CloudDeadlinePrompt userId={userId}
      membership={{ ...membership, status: "active", expires_at: "2026-10-09T08:00:00Z" }}
      subscriptions={[{ status: "past_due", cancel_at_period_end: false }]} /></MemoryRouter>);
    expect(screen.getByText(/Cloud access remains available/)).toHaveTextContent(/Check account billing for renewal status/);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("shows a quiet canceled-term date without a sales button", () => {
    render(<MemoryRouter><CloudDeadlinePrompt userId={userId}
      membership={{ ...membership, status: "active", expires_at: "2026-10-09T08:00:00Z" }}
      subscriptions={[{ status: "active", cancel_at_period_end: true }]} /></MemoryRouter>);
    expect(screen.getByText(/Cloud access remains available/)).toHaveTextContent("2026");
    expect(screen.queryByRole("link", { name: "Try Cloud free" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View Cloud plans" })).not.toBeInTheDocument();
  });
});
