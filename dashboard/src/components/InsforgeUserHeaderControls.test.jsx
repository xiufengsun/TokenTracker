import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsforgeUserHeaderControls, isCurrentProAccount } from "./InsforgeUserHeaderControls.jsx";

const mocks = vi.hoisted(() => ({
  auth: {}, request: vi.fn(), navigate: vi.fn(), login: vi.fn(), backend: "hosted-instance", official: true,
}));
vi.mock("../contexts/InsforgeAuthContext.jsx", () => ({ useInsforgeAuth: () => mocks.auth }));
vi.mock("../contexts/LoginModalContext.jsx", () => ({ useLoginModal: () => ({ openLoginModal: mocks.login }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../hooks/useLocale.js", () => ({ useLocale: () => {} }));
vi.mock("../lib/native-bridge.js", () => ({ isNativeApp: () => false }));
vi.mock("../lib/cloud-billing", () => ({ cloudBillingRequest: mocks.request }));
vi.mock("../lib/insforge-config", () => ({
  getInsforgeInstanceFingerprint: () => mocks.backend,
  isOfficialInsforgeInstance: () => mocks.official,
  INSFORGE_INSTANCE_CHANGED_EVENT: "tt.insforgeInstanceChanged",
}));

const now = Date.parse("2026-10-10T12:00:00Z");
const end = "2026-10-11T12:00:00Z";
const pro = (source = "payment") => ({ environment: "live", membership: {
  environment: "live", phase: "active", hosting_mode: "hosted", status: "active", access_source: source, expires_at: end,
}, payments: [], gifts: [] });

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  mocks.auth = { enabled: true, loading: false, signedIn: true, user: { id: "fixture-owner", user_metadata: { avatar_url: "https://avatar.example/photo.png" } }, displayName: "Ada Lovelace", getAccessToken: vi.fn() };
  mocks.official = true;
  mocks.backend = "hosted-instance";
  mocks.request.mockReset().mockResolvedValue(pro());
  mocks.navigate.mockReset(); mocks.login.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("current server Cloud identity", () => {
  it.each(["payment", "gift", "mixed"])("accepts authoritative current %s access even without capped history", (source) => {
    expect(isCurrentProAccount(pro(source), now)).toBe(true);
  });
  it("keeps Cloud when the visible capped history contains only future periods", () => {
    const paid = pro(); paid.payments = Array.from({ length: 20 }, () => ({ starts_at: end, ends_at: "2027-01-01T00:00:00Z" }));
    expect(isCurrentProAccount(paid, now)).toBe(true);
    const gifted = pro("gift"); gifted.gifts = Array.from({ length: 100 }, () => ({ state: "pending", starts_at: end, ends_at: "2027-01-01T00:00:00Z" }));
    expect(isCurrentProAccount(gifted, now)).toBe(true);
  });
  it("keeps legitimate partially refunded access when the server still grants payment access", () => {
    const value = pro(); value.payments = [{ amount_cents: 499, refunded_cents: 100 }];
    expect(isCurrentProAccount(value, now)).toBe(true);
  });
  it("supports the existing hosted response without an optional hosting_mode field", () => {
    const value = pro(); delete value.membership.hosting_mode;
    expect(isCurrentProAccount(value, now)).toBe(true);
  });
  it.each(["legacy_free", "trial", "transition", "expired", "free", "self_hosted", undefined])("rejects %s membership", (status) => {
    const value = pro(); value.membership.status = status;
    expect(isCurrentProAccount(value, now)).toBe(false);
  });
  it.each([
    { environment: "sandbox" }, { environment: undefined }, { phase: "preview" }, { phase: undefined },
    { hosting_mode: "self_hosted" }, { hosting_mode: "unknown" }, { access_source: "none" }, { access_source: undefined },
    { expires_at: null }, { expires_at: 2049 }, { expires_at: "invalid" }, { expires_at: "2026-10-10T12:00:00Z" },
  ])("rejects unavailable authoritative field %j", (change) => {
    const value = pro(); Object.assign(value.membership, change);
    expect(isCurrentProAccount(value, now)).toBe(false);
  });
  it("rejects missing, future-only and fully refunded server entitlement", () => {
    expect(isCurrentProAccount(null, now)).toBe(false);
    const future = pro("none"); future.membership.status = "free";
    future.gifts = [{ state: "pending", starts_at: end, ends_at: "2027-01-01T00:00:00Z" }];
    expect(isCurrentProAccount(future, now)).toBe(false);
    const refunded = pro("none"); refunded.membership.status = "expired";
    refunded.payments = [{ amount_cents: 499, refunded_cents: 499 }];
    expect(isCurrentProAccount(refunded, now)).toBe(false);
    expect(isCurrentProAccount({ ...pro(), environment: "sandbox" }, now)).toBe(false);
  });
});

describe("sidebar Cloud avatar", () => {
  it.each([false, true])("has a purple frame and accessible Cloud badge when collapsed=%s", async (collapsed) => {
    const action = vi.fn();
    const view = render(<InsforgeUserHeaderControls variant="sidebar" collapsed={collapsed} onAfterAction={action} />);
    const button = await screen.findByRole("button", { name: /TokenTracker Cloud subscriber/ });
    expect(view.container.querySelector(".leaderboard-pro-avatar")).not.toBeNull();
    expect(screen.getByText("Cloud")).toHaveClass("leaderboard-pro-badge");
    expect(button).toHaveClass("focus-visible:ring-2");
    expect(button).toHaveClass("tt-sidebar-account-control");
    if (collapsed) expect(screen.getByText("Cloud")).toHaveClass("absolute");
    await userEvent.tab(); expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(mocks.navigate).toHaveBeenCalledWith("/settings");
    expect(action).toHaveBeenCalledTimes(1);
  });
  it("retains frame and badge after an avatar image fails", async () => {
    const view = render(<InsforgeUserHeaderControls variant="sidebar" />);
    await screen.findByText("Cloud");
    fireEvent.error(view.container.querySelector("img"));
    expect(screen.getByText("AL")).toBeInTheDocument();
    expect(screen.getByText("AL")).toHaveClass("tt-sidebar-pro-fallback");
    expect(screen.getByText("AL")).not.toHaveClass("bg-oai-brand-600");
    expect(view.container.querySelector(".leaderboard-pro-avatar")).not.toBeNull();
    expect(screen.getByText("Cloud")).toBeInTheDocument();
  });
  it("shows gifted Cloud with no avatar or display name", async () => {
    mocks.auth.user = { id: "fixture-owner" }; mocks.auth.displayName = "";
    mocks.request.mockResolvedValue(pro("gift"));
    const view = render(<InsforgeUserHeaderControls variant="sidebar" collapsed />);
    await screen.findByRole("button", { name: /TokenTracker Cloud subscriber/ });
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".leaderboard-pro-avatar svg")).not.toBeNull();
    expect(view.container.querySelector(".leaderboard-pro-avatar svg").parentElement).toHaveClass("tt-sidebar-pro-fallback");
    expect(screen.getByText("Cloud")).toBeInTheDocument();
  });
  it("has no initial unknown badge, retains verified Cloud during same-scope refresh and removes it on failure", async () => {
    let initial, rejectRefresh;
    mocks.request.mockImplementationOnce(() => new Promise((resolve) => { initial = resolve; }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRefresh = reject; }));
    const view = render(<InsforgeUserHeaderControls variant="sidebar" />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Cloud")).toBeNull();
    expect(view.container.querySelector(".leaderboard-pro-avatar")).toBeNull();
    await act(async () => { initial(pro()); });
    expect(screen.getByText("Cloud")).toBeInTheDocument();
    await act(async () => { fireEvent.focus(window); });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Cloud")).toBeInTheDocument();
    expect(view.container.querySelector(".leaderboard-pro-avatar")).not.toBeNull();
    await act(async () => { rejectRefresh(new Error("billing_network_error")); });
    expect(screen.queryByText("Cloud")).toBeNull();
    expect(view.container.querySelector(".leaderboard-pro-avatar")).toBeNull();
  });
  it("preserves the free user's existing fallback color", async () => {
    mocks.auth.user = { id: "fixture-owner" };
    mocks.request.mockResolvedValue({ environment: "live", membership: { status: "free" } });
    render(<InsforgeUserHeaderControls variant="sidebar" />);
    await act(async () => {});
    expect(screen.getByText("AL")).toHaveClass("bg-oai-brand-600");
    expect(screen.getByText("AL")).not.toHaveClass("tt-sidebar-pro-fallback");
  });
  it("does not trust metadata Cloud flags or Cloud upload permission", async () => {
    mocks.auth.user.user_metadata.pro_active = true;
    mocks.request.mockResolvedValue({ environment: "live", membership: { environment: "live", phase: "active", status: "trial", can_upload_cloud: true, expires_at: end } });
    const view = render(<InsforgeUserHeaderControls variant="sidebar" />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(view.container.querySelector(".leaderboard-pro-avatar")).toBeNull();
    expect(screen.queryByText("Cloud")).toBeNull();
  });
  it.each(["guest", "loading", "disabled", "selfhost", "header"])("adds no billing request for %s", async (mode) => {
    if (mode === "guest") { mocks.auth.signedIn = false; mocks.auth.user = null; }
    if (mode === "loading") mocks.auth.loading = true;
    if (mode === "disabled") mocks.auth.enabled = false;
    if (mode === "selfhost") mocks.official = false;
    const view = render(<InsforgeUserHeaderControls variant={mode === "header" ? "header" : "sidebar"} />);
    await act(async () => {});
    expect(mocks.request).not.toHaveBeenCalled();
    expect(view.container.querySelector(".leaderboard-pro-avatar")).toBeNull();
    expect(screen.queryByText("Cloud")).toBeNull();
    if (mode === "guest" || mode === "header") expect(view.container.querySelector(".tt-sidebar-account-control")).toBeNull();
  });
  it("immediately drops the previous account frame and ignores its late billing response", async () => {
    let previous;
    mocks.request.mockImplementationOnce(() => new Promise((done) => { previous = done; }))
      .mockResolvedValue({ environment: "live", membership: { status: "free" } });
    const view = render(<InsforgeUserHeaderControls variant="sidebar" />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    mocks.auth.user = { id: "fixture-peer" };
    view.rerender(<InsforgeUserHeaderControls variant="sidebar" />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    await act(async () => { previous(pro()); });
    expect(screen.queryByText("Cloud")).toBeNull();
    expect(view.container.querySelector(".leaderboard-pro-avatar")).toBeNull();
  });
  it("removes a known frame immediately when the selected instance changes", async () => {
    const control = () => <InsforgeUserHeaderControls variant="sidebar" />;
    const view = render(control());
    await screen.findByText("Cloud");
    mocks.backend = "private-instance"; mocks.official = false;
    view.rerender(control());
    expect(screen.queryByText("Cloud")).toBeNull();
    expect(view.container.querySelector(".leaderboard-pro-avatar")).toBeNull();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
});
