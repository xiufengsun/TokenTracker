import React from "react";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCopyLocale } from "../../lib/copy";
import { RedeemProCode } from "./RedeemProCode.jsx";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../lib/cloud-billing", async () => ({
  ...(await vi.importActual("../../lib/cloud-billing")), cloudBillingRequest: request,
}));
const gift = { id: "gift-1", duration_days: 30, redeemed_at: "2026-10-09", starts_at: "2026-10-09",
  ends_at: "2026-11-08", revoked_at: null, state: "active" };
let props;
const click = async (target) => act(async () => { await userEvent.click(target); });
const type = async (target, value) => act(async () => { await userEvent.type(target, value); });
const code = "TTPRO-0123456789ABCDEF0123456789ABCDEF";
function show() { return render(<RedeemProCode {...props} />); }
async function fill() {
  await click(screen.getByRole("button", { name: "Redeem Cloud code" }));
  await type(screen.getByRole("textbox", { name: "Cloud gift code" }), code);
}
beforeEach(() => {
  setCopyLocale("en");
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  request.mockReset();
  request.mockResolvedValue({ gift, membership: { status: "active" }, already_redeemed: false });
  props = { account: { environment: "sandbox", gift_redemption_available: true, redemption_restriction: null,
    gifts: [], membership: { status: "free" } }, auth: { signedIn: true, user: { id: "actor-a" }, getAccessToken: vi.fn() },
    refresh: vi.fn().mockResolvedValue({ gifts: [gift], membership: { status: "active", access_source: "gift" } }) };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Cloud gift redemption", () => {
  it("keeps gift history inside its settings row without allowing unsupported redemption", async () => {
    props.layout = "settings-row";
    props.account.gift_redemption_available = false;
    props.account.gifts = [gift];
    show();
    expect(screen.queryByText("30 days of Cloud")).not.toBeInTheDocument();
    const row = screen.getByRole("button", { name: "Cloud gifts" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("30 days of Cloud")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Redeem code" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it("blocks dismissal while redeeming and preserves the verified receipt after closing and reopening", async () => {
    props.layout = "settings-row";
    let resolve;
    request.mockReturnValue(new Promise((done) => { resolve = done; }));
    show(); await fill();
    const trigger = screen.getByRole("button", { name: "Redeem Cloud code", hidden: true });
    await click(screen.getByRole("button", { name: "Redeem code" }));
    await act(async () => { await userEvent.keyboard("{Escape}"); });
    expect(screen.getByRole("dialog", { name: "Redeem Cloud code" })).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Close dialog" })).toBeDisabled();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ gift }); });
    expect(screen.getByText(/Your gift is recorded/)).toBeVisible();
    await act(async () => { await userEvent.keyboard("{Escape}"); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    await click(trigger);
    expect(screen.getByText(/Your gift is recorded/)).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("preserves an ambiguous redemption request when an idle dialog is closed and reopened", async () => {
    props.layout = "settings-row";
    request.mockRejectedValueOnce({ code: "billing_network_error" });
    show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    const requestId = request.mock.calls[0][1].body.request_id;
    await act(async () => { await userEvent.keyboard("{Escape}"); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await click(screen.getByRole("button", { name: "Redeem Cloud code" }));
    expect(screen.getByRole("textbox")).toHaveValue(code);
    await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(request.mock.calls[1][1].body.request_id).toBe(requestId);
  });
  it.each([
    { gift_redemption_available: undefined }, { gift_redemption_available: false },
    { membership: { status: "self_hosted" } }, { membership: { status: "active", hosting_mode: "self_hosted" } },
  ])("hides an unsupported or private-instance form %j", (change) => {
    props.account = { ...props.account, ...change };
    show();
    expect(screen.queryByRole("button", { name: "Redeem Cloud code" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
  it("does not request or retain a code until an intentional inline submit", async () => {
    show();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    await fill();
    expect(screen.getByText(/Any existing subscription is managed separately/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    await type(screen.getByRole("textbox"), "{enter}");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("redeem-gift", { auth: expect.any(Function),
      body: { code, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) } });
    expect(props.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Your gift is recorded/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it("synchronously locks repeated form submissions", async () => {
    let resolve;
    request.mockReturnValue(new Promise((done) => { resolve = done; }));
    show(); await fill();
    const form = screen.getByRole("textbox").closest("form");
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Redeeming…" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    await act(async () => { resolve({ gift }); });
    expect(screen.getByText(/Your gift is recorded/)).toBeInTheDocument();
  });
  it("reuses a request UUID after an ambiguous failure, including equivalent code formatting", async () => {
    request.mockRejectedValueOnce({ code: "billing_network_error" });
    show(); await fill();
    await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Retry the same code/);
    const requestId = request.mock.calls[0][1].body.request_id;
    await act(async () => { fireEvent.change(screen.getByRole("textbox"), { target: { value: code.toLowerCase().replaceAll("-", " ") } }); });
    await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(request.mock.calls[1][1].body.request_id).toBe(requestId);
    expect(screen.getByText(/Your gift is recorded/)).toBeInTheDocument();
  });
  it("starts a separate operation only when the code changes", async () => {
    request.mockRejectedValue({ code: "billing_network_error" });
    show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    const previous = request.mock.calls[0][1].body.request_id;
    await type(screen.getByRole("textbox"), "1");
    await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(request.mock.calls[1][1].body.request_id).not.toBe(previous);
  });
  it.each(["gift_requires_renewal_cancel", "gift_checkout_pending"])("explains %s only after an attempt without consuming a code or changing billing", async (restriction) => {
    props.layout = "settings-row";
    props.account.redemption_restriction = restriction;
    show(); await click(screen.getByRole("button", { name: "Redeem Cloud code" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    await type(screen.getByRole("textbox"), code);
    expect(screen.getByRole("button", { name: "Redeem code" })).toBeEnabled();
    await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(restriction === "gift_checkout_pending" ? /pending payment/i : /auto-renewal/i);
    expect(screen.getByRole("textbox")).toHaveValue(code);
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(request).not.toHaveBeenCalled();
    expect(props.refresh).not.toHaveBeenCalled();
  });
  it.each(["gift_code_unavailable", "gift_redemption_rate_limited", "gift_not_available", "authentication_required"])("maps %s to a safe inline error without revealing code ownership", async (error) => {
    request.mockRejectedValue({ code: error });
    show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(screen.getByRole("alert")).not.toHaveTextContent(error);
    expect(screen.queryByText(/Your gift is recorded/)).not.toBeInTheDocument();
    expect(props.refresh).not.toHaveBeenCalled();
  });
  it("keeps the server receipt when account refresh fails without claiming Cloud activation or re-redeeming", async () => {
    props.refresh.mockResolvedValueOnce(null);
    show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(screen.getByText(/membership could not be refreshed/)).toBeInTheDocument();
    expect(screen.queryByText(/Your gift is recorded/)).not.toBeInTheDocument();
    expect(screen.getByText(/30 days of Cloud/)).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Refresh membership" }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(props.refresh).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Your gift is recorded/)).toBeInTheDocument();
  });
  it("does not claim activation from a POST membership while the refreshed account lacks the gift", async () => {
    props.refresh.mockResolvedValue({ gifts: [], membership: { status: "free" } });
    show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(screen.getByText(/membership could not be refreshed/)).toBeInTheDocument();
    expect(screen.queryByText(/Your gift is recorded/)).not.toBeInTheDocument();
  });
  it("treats a success response with no gift identity as unconfirmed and preserves the retry operation", async () => {
    request.mockResolvedValue({ membership: { status: "active" } });
    show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Your gift is recorded|code was redeemed/)).not.toBeInTheDocument();
    expect(props.refresh).not.toHaveBeenCalled();
    await click(screen.getByRole("button", { name: "Redeem code" }));
    expect(request.mock.calls[1][1].body.request_id).toBe(request.mock.calls[0][1].body.request_id);
  });
  it.each(["account", "environment"])("discards a delayed redemption after an %s change", async (change) => {
    let resolve;
    request.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    props = change === "account" ? { ...props, auth: { ...props.auth, user: { id: "actor-b" } } }
      : { ...props, account: { ...props.account, environment: "live" } };
    view.rerender(<RedeemProCode {...props} />);
    await act(async () => { resolve({ gift, membership: { status: "active" } }); });
    expect(props.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/Your gift is recorded/)).not.toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Redeem Cloud code" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("discards an old account's delayed refresh after a successful redemption", async () => {
    let resolve;
    props.refresh.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    props = { ...props, auth: { ...props.auth, user: { id: "actor-b" } } };
    view.rerender(<RedeemProCode {...props} />);
    await act(async () => { resolve({ gifts: [gift], membership: { status: "active" } }); });
    expect(screen.queryByText(/Your gift is recorded/)).not.toBeInTheDocument();
  });
  it("stops a redemption before it sends with a token acquired after the account changed", async () => {
    let resolveToken;
    const submitted = vi.fn();
    props.auth.getAccessToken.mockReturnValue(new Promise((done) => { resolveToken = done; }));
    request.mockImplementation(async (_action, options) => {
      await options.auth();
      submitted();
      return { gift };
    });
    const view = show(); await fill(); await click(screen.getByRole("button", { name: "Redeem code" }));
    props = { ...props, auth: { ...props.auth, user: { id: "actor-b" } } };
    view.rerender(<RedeemProCode {...props} />);
    await act(async () => { resolveToken("header.payload.signature"); });
    expect(submitted).not.toHaveBeenCalled();
    expect(props.refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
