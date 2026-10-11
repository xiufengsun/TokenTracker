import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ signedIn: true }));
const client = vi.hoisted(() => ({ auth: {
  signOut: vi.fn(async () => { state.signedIn = false; }),
  signInWithPassword: vi.fn(async () => { state.signedIn = true; return { data: { user: { id: "fixture-user" } } }; }),
  refreshSession: vi.fn(async () => ({ data: {} })),
  getCurrentUser: vi.fn(async () => ({ data: { user: state.signedIn ? { id: "fixture-user" } : null } })),
} }));
vi.mock("../../lib/insforge-config", () => ({
  getOrCreateInsforgeClient: () => client,
  isCloudInsforgeConfigured: () => true,
  getInsforgeConfigurationError: () => null,
  getInsforgeConnectionHost: () => null,
  getInsforgeRemoteUrl: () => "https://cloud.example",
  isOfficialInsforgeInstance: () => true,
  isCurrentInsforgeClient: (value) => value === client,
  shouldRestoreInsforgeSession: () => true,
  allowInsforgeSessionRestore: vi.fn(),
  INSFORGE_INSTANCE_CHANGED_EVENT: "tt.insforgeInstanceChanged",
}));
vi.mock("../../lib/insforge-session-recovery.mjs", () => ({
  restoreInsforgeUser: () => client.auth.getCurrentUser(),
}));
vi.mock("../../lib/api", () => ({
  invalidateAccountResponseCache: vi.fn(),
  getPublicVisibility: async () => ({}),
}));
vi.mock("../../lib/local-api-auth", () => ({
  clearLocalApiAuthToken: vi.fn(),
  getLocalApiAuthHeaders: async () => ({}),
}));

import { InsforgeAuthProvider, useInsforgeAuth } from "../InsforgeAuthContext.jsx";
import { AccountViewProvider, useAccountView } from "../AccountViewContext.jsx";
import { getCloudSyncEnabled, getCloudUsageReady, getStoredDeviceSession,
  setStoredDeviceSession, setCloudUsageReady, emitCloudUsageSynced } from "../../lib/cloud-sync-prefs";

describe("sign-out sync preference", () => {
  beforeEach(() => {
    localStorage.clear();
    state.signedIn = true;
    vi.clearAllMocks();
  });

  for (const preference of ["1", "0", null]) it(`preserves saved preference ${preference} through sign-out and re-login`, async () => {
    if (preference !== null) localStorage.setItem("tokentracker_cloud_sync_enabled", preference);
    localStorage.setItem("tokentracker_cloud_sync_changed_at_ms", "123");
    setCloudUsageReady(true);
    setStoredDeviceSession({ token: "fixture-device-token", deviceId: "device", issuedAt: "fixture" });
    const wrapper = ({ children }) => <InsforgeAuthProvider>{children}</InsforgeAuthProvider>;
    const { result } = renderHook(() => useInsforgeAuth(), { wrapper });
    await waitFor(() => expect(result.current.signedIn).toBe(true));
    await act(async () => result.current.signOut());
    expect(result.current.signedIn).toBe(false);
    expect(localStorage.getItem("tokentracker_cloud_sync_enabled")).toBe(preference);
    expect(localStorage.getItem("tokentracker_cloud_sync_changed_at_ms")).toBe("123");
    expect(getCloudUsageReady()).toBe(false);
    expect(getStoredDeviceSession()).toBeNull();
    await act(async () => result.current.signInWithPassword({ email: "fixture@example.invalid", password: "fixture" }));
    expect(result.current.signedIn).toBe(true);
    expect(getCloudSyncEnabled()).toBe(preference === "1");
    expect(getCloudUsageReady()).toBe(false);
  });

  it("keeps signed-out localhost in the local view with sync preference enabled", async () => {
    localStorage.setItem("tokentracker_cloud_sync_enabled", "1");
    setCloudUsageReady(true);
    const wrapper = ({ children }) => <InsforgeAuthProvider><AccountViewProvider>{children}</AccountViewProvider></InsforgeAuthProvider>;
    const { result } = renderHook(() => ({ auth: useInsforgeAuth(), view: useAccountView() }), { wrapper });
    await waitFor(() => expect(result.current.auth.signedIn).toBe(true));
    await act(async () => result.current.auth.signOut());
    expect(result.current.view.accountView).toBe(false);
    expect(result.current.view.resolving).toBe(false);
    expect(getCloudSyncEnabled()).toBe(true);
    await act(async () => result.current.auth.signInWithPassword({ email: "fixture@example.invalid", password: "fixture" }));
    expect(result.current.view.accountView).toBe(false);
    act(() => emitCloudUsageSynced());
    expect(result.current.view.accountView).toBe(true);
  });
});
