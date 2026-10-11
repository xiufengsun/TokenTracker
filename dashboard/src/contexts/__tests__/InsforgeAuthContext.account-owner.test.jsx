import React from "react";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InsforgeAuthProvider, useInsforgeAuth } from "../InsforgeAuthContext.jsx";
import { CloudCheckoutPage } from "../../pages/CloudCheckoutPage.jsx";
import { readCloudPurchase } from "../../lib/cloud-checkout.js";
import { setCopyLocale } from "../../lib/copy";

// This integration test exercises auth ownership, not the plan's browser animation.
vi.mock("@lucasmarkes/hairline/react", () => ({ Hub: () => null }));

const state = vi.hoisted(() => ({ token: null, user: null }));
const client = vi.hoisted(() => ({
  tokenManager: {
    getAccessToken: vi.fn(() => state.token),
    getSession: vi.fn(() => null),
    clearSession: vi.fn(),
  },
  auth: {
    refreshSession: vi.fn(),
    signInWithPassword: vi.fn(async () => ({ data: { user: state.user }, error: null })),
    signOut: vi.fn(),
  },
}));

vi.mock("../../lib/insforge-config", () => ({
  getOrCreateInsforgeClient: () => client,
  isCloudInsforgeConfigured: () => true,
  getInsforgeConfigurationError: () => null,
  getInsforgeConnectionHost: () => "account.example",
  getInsforgeRemoteUrl: () => "https://account.example",
  getInsforgeInstanceFingerprint: () => "https://account.example",
  getInsforgeAnonKey: () => "public-anon",
  isOfficialInsforgeInstance: () => false,
  INSFORGE_INSTANCE_CHANGED_EVENT: "tt.insforgeInstanceChanged",
  isCurrentInsforgeClient: (value) => value === client,
  shouldRestoreInsforgeSession: () => true,
  allowInsforgeSessionRestore: vi.fn(),
}));
vi.mock("../../lib/insforge-session-recovery.mjs", () => ({
  restoreInsforgeUser: async () => ({ data: { user: state.user }, error: null }),
}));
vi.mock("../../lib/local-api-auth", () => ({
  clearLocalApiAuthToken: vi.fn(),
  getLocalApiAuthHeaders: async () => ({}),
}));
vi.mock("../../hooks/use-cloud-billing.js", () => ({
  useCloudCatalog: () => ({ catalog: {
    environment: "sandbox",
    policy: { phase: "active", launch_at: "2000-01-01" },
    providers: { waffo: true },
    prices: [{ sku: "cloud_usd_monthly", currency: "USD", amount_cents: 499, term_months: 1, billing_mode: "recurring" }],
    limits: { machines: 5, sync_minutes: 15, hourly_history_days: 90, daily_history_months: 24, trial_days: 7 },
  }, loading: false }),
  useCloudAccount: () => ({
    auth: useInsforgeAuth(),
    account: { membership: { status: "free", trial_available: true } },
    refresh: vi.fn(),
  }),
}));

function jwt(sub) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
}
function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}
function Provider({ children }) {
  return <InsforgeAuthProvider>{children}</InsforgeAuthProvider>;
}
async function signInB(auth) {
  state.user = { id: "account-b" };
  state.token = jwt("account-b");
  await act(async () => { await auth.signInWithPassword({ email: "b@example.test", password: "test-password" }); });
}

beforeEach(() => {
  state.user = { id: "account-a" };
  state.token = jwt("account-a");
  vi.clearAllMocks();
  localStorage.clear();
  setCopyLocale("en");
  vi.stubGlobal("crypto", webcrypto);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("known-account access token binding", () => {
  it("rejects B's deferred token from A's retained getter without clearing the shared B session", async () => {
    const { result } = renderHook(() => useInsforgeAuth(), { wrapper: Provider });
    await waitFor(() => expect(result.current.user?.id).toBe("account-a"));
    const getterA = result.current.getAccessToken;
    state.token = null;
    const refresh = deferred();
    client.auth.refreshSession.mockReturnValueOnce(refresh.promise);
    const tokenA = getterA();
    await signInB(result.current);
    refresh.resolve({ data: { accessToken: state.token } });

    await expect(tokenA).resolves.toBeNull();
    expect(result.current.client).toBe(client);
    expect(result.current.user.id).toBe("account-b");
    expect(result.current.getAccessToken).not.toBe(getterA);
    await expect(result.current.getAccessToken()).resolves.toBe(state.token);
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(client.tokenManager.clearSession).not.toHaveBeenCalled();
  });

  it("allows the initial OAuth token while the restored user is not yet known", async () => {
    state.user = null;
    state.token = jwt("oauth-owner");
    const { result } = renderHook(() => useInsforgeAuth(), { wrapper: Provider });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
    await expect(result.current.getAccessToken()).resolves.toBe(state.token);
  });

  it.each([undefined, "account-b"])("rejects a token with sub %s for a known A user", async (sub) => {
    const { result } = renderHook(() => useInsforgeAuth(), { wrapper: Provider });
    await waitFor(() => expect(result.current.user?.id).toBe("account-a"));
    state.token = jwt(sub);
    await expect(result.current.getAccessToken()).resolves.toBeNull();
    expect(client.tokenManager.clearSession).not.toHaveBeenCalled();
  });

  it("does not create or cache B's checkout after switching accounts during A's token refresh", async () => {
    let auth;
    function AuthCloudbe() {
      auth = useInsforgeAuth();
      const location = useLocation();
      return <output data-testid="account-checkout-location">{auth.user?.id}:{location.search}</output>;
    }
    const orderB = "22222222-2222-4222-8222-222222222222";
    const request = vi.fn(async () => new Response(JSON.stringify({
      order: { id: orderB, provider: "waffo", sku: "cloud_usd_monthly", checkout_url: "https://pancake.waffo.ai/checkout?owned=b" },
      membership: { status: "free" },
    })));
    vi.stubGlobal("fetch", request);
    render(<Provider><MemoryRouter initialEntries={["/billing/checkout?sku=cloud_usd_monthly"]}>
      <CloudCheckoutPage /><AuthCloudbe />
    </MemoryRouter></Provider>);
    await waitFor(() => expect(auth.user?.id).toBe("account-a"));
    state.token = null;
    const refresh = deferred();
    client.auth.refreshSession.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole("button", { name: /Continue to payment/ }));
    await waitFor(() => expect(client.auth.refreshSession).toHaveBeenCalledTimes(1));
    await signInB(auth);
    await act(async () => { refresh.resolve({ data: { accessToken: state.token } }); await refresh.promise; });
    await waitFor(() => expect(screen.getByRole("button", { name: /Continue to payment/ })).toBeEnabled());

    expect(request).not.toHaveBeenCalled();
    expect(readCloudPurchase("account-a")).toMatchObject({ userId: "account-a", sku: "cloud_usd_monthly" });
    expect(readCloudPurchase("account-a").order_id).toBeUndefined();
    expect(readCloudPurchase("account-b")).toBeNull();
    expect(screen.getByTestId("account-checkout-location")).toHaveTextContent("account-b:?sku=cloud_usd_monthly");
    expect(screen.getByTestId("account-checkout-location")).not.toHaveTextContent(orderB);
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(client.tokenManager.clearSession).not.toHaveBeenCalled();
  });
});
