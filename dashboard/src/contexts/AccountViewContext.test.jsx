import React from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountViewProvider, useAccountView } from "./AccountViewContext.jsx";

vi.mock("./InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => ({ enabled: true, signedIn: !prefState.loading, loading: prefState.loading }),
}));

const prefState = vi.hoisted(() => ({ ready: false, localHost: true, nativeMac: false, loading: false }));
vi.mock("../lib/native-bridge", () => ({ isNativeEmbed: () => prefState.nativeMac }));

vi.mock("../lib/cloud-sync-prefs", () => ({
  CLOUD_USAGE_SYNCED_EVENT: "tt.cloudUsageSynced",
  getCloudSyncEnabled: () => true,
  getCloudUsageReady: () => prefState.ready,
  isLocalDashboardHost: () => prefState.localHost,
  syncCloudSyncPrefToLocalServer: vi.fn(),
}));

describe("AccountViewProvider", () => {
  beforeEach(() => {
    prefState.ready = false;
    prefState.localHost = true;
    prefState.nativeMac = false;
    prefState.loading = false;
    localStorage.clear();
  });

  it("opens the Mac dashboard on local usage without waiting for sign-in or an upload", () => {
    Object.assign(prefState, { nativeMac: true, ready: true, loading: true });
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result, rerender } = renderHook(() => useAccountView(), { wrapper });
    expect(result.current).toMatchObject({ accountView: false, resolving: false });
    prefState.loading = false;
    rerender();
    act(() => window.dispatchEvent(new Event("tt.cloudUsageSynced")));
    expect(result.current).toMatchObject({ accountView: false, scopeSwitchable: true });
  });

  it("restores both explicit Mac scope choices after reopening", () => {
    Object.assign(prefState, { nativeMac: true, ready: true });
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const open = () => renderHook(() => useAccountView(), { wrapper });
    let page = open();
    expect(page.result.current.accountView).toBe(false);
    act(() => page.result.current.setScopeOverride(null));
    page.unmount();
    prefState.loading = true;
    page = open();
    expect(page.result.current.resolving).toBe(true);
    prefState.loading = false;
    page.rerender();
    expect(page.result.current.accountView).toBe(true);
    act(() => page.result.current.setScopeOverride("local"));
    page.unmount();
    page = open();
    expect(page.result.current.accountView).toBe(false);
  });

  it("keeps the local view until the first cloud upload completes", () => {
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    expect(result.current).toMatchObject({ accountView: false, revision: 0 });
    act(() => window.dispatchEvent(new Event("tt.cloudUsageSynced")));
    expect(result.current.accountView).toBe(true);
  });

  it("uses cloud immediately when a previous upload is ready", () => {
    prefState.ready = true;
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    expect(result.current.accountView).toBe(true);
  });

  it("keeps public-host account reads on cloud", () => {
    prefState.localHost = false;
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    expect(result.current.accountView).toBe(true);
    expect(result.current.scopeSwitchable).toBe(false);
  });

  it("flips the rendered scope without touching the sync preference", () => {
    prefState.ready = true;
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    expect(result.current.scopeSwitchable).toBe(true);
    expect(result.current.scopeOverride).toBeNull();

    const revisionBefore = result.current.revision;
    act(() => result.current.setScopeOverride("local"));
    expect(result.current.scopeOverride).toBe("local");
    expect(result.current.accountView).toBe(false);
    expect(result.current.revision).toBeGreaterThan(revisionBefore);

    const revisionAfterFlip = result.current.revision;
    act(() => result.current.setScopeOverride("local"));
    expect(result.current.revision).toBe(revisionAfterFlip);

    act(() => result.current.setScopeOverride(null));
    expect(result.current.scopeOverride).toBeNull();
    expect(result.current.accountView).toBe(true);
  });

  it("stays local when sync is not ready despite a local override", () => {
    prefState.ready = false;
    const wrapper = ({ children }) => <AccountViewProvider>{children}</AccountViewProvider>;
    const { result } = renderHook(() => useAccountView(), { wrapper });

    act(() => result.current.setScopeOverride("local"));
    expect(result.current.scopeSwitchable).toBe(false);
    expect(result.current.accountView).toBe(false);
  });
});
