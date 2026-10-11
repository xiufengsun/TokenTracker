import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCloudAccount } from "./use-cloud-billing.js";

const mocks = vi.hoisted(() => ({
  auth: { signedIn: true, user: { id: "account-1" }, getAccessToken: vi.fn() },
  backend: "hosted-instance",
  request: vi.fn(),
}));
vi.mock("../contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => mocks.auth,
}));
vi.mock("../lib/cloud-billing", () => ({ cloudBillingRequest: mocks.request }));
vi.mock("../lib/insforge-config", () => ({
  getInsforgeInstanceFingerprint: () => mocks.backend,
  INSFORGE_INSTANCE_CHANGED_EVENT: "tt.insforgeInstanceChanged",
}));

beforeEach(() => {
  mocks.auth.signedIn = true;
  mocks.auth.user = { id: "account-1" };
  mocks.auth.getAccessToken = vi.fn();
  mocks.backend = "hosted-instance";
  mocks.request.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Cloud account refresh", () => {
  it("keeps a confirmed same-owner snapshot through a temporary outage without reporting refresh success", async () => {
    const account = { environment: "live", membership: { status: "free" }, gifts: [] };
    const outage = Object.assign(new Error("offline"), { code: "billing_network_error" });
    mocks.request.mockResolvedValueOnce(account).mockRejectedValueOnce(outage)
      .mockResolvedValue({ ...account, gifts: [{ id: "server-confirmed-gift" }] });
    const view = renderHook(() => useCloudAccount());
    await waitFor(() => expect(view.result.current.account).toBe(account));
    let refreshed;
    await act(async () => { refreshed = await view.result.current.refresh(); });
    expect(refreshed).toBeNull();
    expect(view.result.current.account).toBe(account);
    expect(view.result.current.error).toBe(outage);
    await act(async () => { refreshed = await view.result.current.refresh(); });
    expect(refreshed.gifts).toEqual([{ id: "server-confirmed-gift" }]);
    expect(view.result.current.error).toBeNull();
  });

  it.each([401, 403])("clears a cached snapshot when authorization is denied (%s)", async status => {
    mocks.request.mockResolvedValueOnce({ membership: { status: "active" } })
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { status }));
    const view = renderHook(() => useCloudAccount());
    await waitFor(() => expect(view.result.current.account?.membership.status).toBe("active"));
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.account).toBeNull();
    expect(view.result.current.error.status).toBe(status);
  });

  it("rejects a delayed response from the previous account", async () => {
    let resolvePrevious;
    mocks.request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePrevious = resolve;
          }),
      )
      .mockResolvedValue({ membership: { status: "trial" } });
    const view = renderHook(() => useCloudAccount());
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    mocks.auth.user = { id: "account-2" };
    view.rerender();
    await waitFor(() =>
      expect(view.result.current.account?.membership.status).toBe("trial"),
    );
    await act(async () => {
      resolvePrevious({
        membership: { status: "active" },
        payments: [{ id: "private-payment" }],
      });
    });
    expect(view.result.current.account?.membership.status).toBe("trial");
    expect(view.result.current.account?.payments).toBeUndefined();
  });
  it("clears membership immediately when signed out and rechecks the server when the app regains focus", async () => {
    mocks.request.mockResolvedValue({ membership: { status: "active" } });
    const view = renderHook(() => useCloudAccount());
    await waitFor(() =>
      expect(view.result.current.account?.membership.status).toBe("active"),
    );
    const previousCalls = mocks.request.mock.calls.length;
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(mocks.request.mock.calls.length).toBe(previousCalls + 1);
    mocks.auth.signedIn = false;
    mocks.auth.user = null;
    view.rerender();
    expect(view.result.current.account).toBeNull();
  });

  it("shares one in-flight request, result and focus refresh across consumers", async () => {
    let resolve;
    mocks.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ membership: { status: "free" } });
    const view = renderHook(() => [useCloudAccount(), useCloudAccount()]);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    await act(async () => { resolve({ membership: { status: "active" } }); });
    expect(view.result.current.map((value) => value.account.membership.status)).toEqual(["active", "active"]);
    await act(async () => {
      fireEvent.focus(window);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(view.result.current.map((value) => value.account.membership.status)).toEqual(["free", "free"]);
  });

  it("broadcasts manual mutation refresh and rejects an older in-flight result", async () => {
    let previous;
    mocks.request.mockImplementationOnce(() => new Promise((done) => { previous = done; }))
      .mockResolvedValue({ membership: { status: "active", access_source: "gift" } });
    const view = renderHook(() => [useCloudAccount(), useCloudAccount()]);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    await act(async () => { await view.result.current[1].refresh(); });
    expect(view.result.current[0].account.membership.access_source).toBe("gift");
    await act(async () => { previous({ membership: { status: "free" } }); });
    expect(view.result.current[0].account.membership.access_source).toBe("gift");
    expect(view.result.current[1].account.membership.access_source).toBe("gift");
  });

  it("has no billing requests for guests or disabled subscribers", async () => {
    mocks.auth.signedIn = false;
    const view = renderHook(() => useCloudAccount());
    await act(async () => {});
    expect(view.result.current.account).toBeNull();
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.auth.signedIn = true;
    view.unmount();
    renderHook(() => useCloudAccount({ enabled: false }));
    await act(async () => {});
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("immediately hides the old backend and ignores its delayed result for the same user", async () => {
    let previous;
    mocks.request.mockImplementationOnce(() => new Promise((done) => { previous = done; }))
      .mockResolvedValue({ membership: { status: "self_hosted" } });
    const view = renderHook(() => useCloudAccount());
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    mocks.backend = "private-instance";
    view.rerender();
    expect(view.result.current.account).toBeNull();
    await waitFor(() => expect(view.result.current.account?.membership.status).toBe("self_hosted"));
    await act(async () => { previous({ membership: { status: "active" } }); });
    expect(view.result.current.account.membership.status).toBe("self_hosted");
  });

  it("binds cache reuse to the token getter even when the account and backend match", async () => {
    mocks.request.mockResolvedValueOnce({ membership: { status: "active" } })
      .mockResolvedValue({ membership: { status: "free" } });
    const view = renderHook(() => useCloudAccount());
    await waitFor(() => expect(view.result.current.account?.membership.status).toBe("active"));
    mocks.auth.getAccessToken = vi.fn();
    view.rerender();
    expect(view.result.current.account).toBeNull();
    await waitFor(() => expect(view.result.current.account?.membership.status).toBe("free"));
    expect(mocks.request.mock.calls[1][1].auth).toBe(mocks.auth.getAccessToken);
  });

  it("invalidates a same-backend configuration change and clears failed refreshes", async () => {
    mocks.request.mockResolvedValueOnce({ membership: { status: "active" } })
      .mockRejectedValue(new Error("billing_network_error"));
    const view = renderHook(() => useCloudAccount());
    await waitFor(() => expect(view.result.current.account?.membership.status).toBe("active"));
    act(() => { window.dispatchEvent(new Event("tt.insforgeInstanceChanged")); });
    expect(view.result.current.account).toBeNull();
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.account).toBeNull();
    expect(view.result.current.error.message).toBe("billing_network_error");
  });

  it("clears memory and listeners when the last consumer leaves", async () => {
    mocks.request.mockResolvedValueOnce({ membership: { status: "active" } })
      .mockResolvedValue({ membership: { status: "free" } });
    const first = renderHook(() => useCloudAccount());
    await waitFor(() => expect(first.result.current.account?.membership.status).toBe("active"));
    first.unmount();
    act(() => { fireEvent.focus(window); });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const next = renderHook(() => useCloudAccount());
    expect(next.result.current.account).toBeNull();
    await waitFor(() => expect(next.result.current.account?.membership.status).toBe("free"));
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("revalidates a stale shared result only when a new route consumer joins", async () => {
    vi.useFakeTimers();
    mocks.request.mockResolvedValueOnce({ membership: { status: "active" } })
      .mockResolvedValue({ membership: { status: "free" } });
    const sidebar = renderHook(() => useCloudAccount());
    await act(async () => {});
    const freshRoute = renderHook(() => useCloudAccount());
    await act(async () => {});
    expect(freshRoute.result.current.account.membership.status).toBe("active");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30001); });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    const nextRoute = renderHook(() => useCloudAccount());
    await act(async () => {});
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(nextRoute.result.current.account.membership.status).toBe("free");
    expect(sidebar.result.current.account.membership.status).toBe("free");
  });

  it("refreshes once at a known entitlement boundary without periodic polling", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mocks.request.mockResolvedValueOnce({ membership: { status: "active", expires_at: new Date(now + 100).toISOString() } })
      .mockResolvedValue({ membership: { status: "expired" } });
    const view = renderHook(() => [useCloudAccount(), useCloudAccount()]);
    await act(async () => {});
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(110); });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(view.result.current[0].account.membership.status).toBe("expired");
    expect(view.result.current[1].account.membership.status).toBe("expired");
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
});
