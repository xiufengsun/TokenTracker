import React from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../../lib/copy";
import { clearCloudPromptBackendState, publishCloudPromptBilling, readCloudPromptState } from "../../lib/cloud-prompt-policy.js";
import { CLOUD_USAGE_SYNCED_EVENT } from "../../lib/cloud-sync-prefs";
import { CloudSection } from "./CloudSection.jsx";
import { useAccountProfileSettings } from "./useAccountProfileSettings.js";

const state = vi.hoisted(() => ({ ownerId: "sync-owner", preference: false, sync: vi.fn(), setPreference: vi.fn(), getAccessToken: vi.fn() }));
vi.mock("../../contexts/InsforgeAuthContext.jsx", () => ({ useInsforgeAuth: () => ({
  enabled: true, signedIn: true, user: { id: state.ownerId }, getAccessToken: state.getAccessToken,
}) }));
vi.mock("../../lib/insforge-config", () => ({ getInsforgeRemoteUrl: () => "https://private.example", isOfficialInsforgeInstance: () => false }));
vi.mock("../../lib/api", () => ({ getPublicVisibility: vi.fn(), setPublicVisibility: vi.fn() }));
vi.mock("../../lib/cloud-sync", () => ({ runCloudUsageSyncNow: state.sync }));
vi.mock("../../lib/cloud-sync-prefs", () => ({
  CLOUD_USAGE_SYNCED_EVENT: "tt.cloudUsageSynced",
  getCloudSyncEnabled: () => state.preference,
  isLocalDashboardHost: () => true,
  setCloudSyncEnabled: (value) => {
    state.preference = value;
    state.setPreference(value);
    window.dispatchEvent(new Event("tt.cloudSyncChanged"));
  },
}));
vi.mock("../cloud/CloudMembershipCard.jsx", () => ({ CloudMembershipCard: ({ syncControl }) => syncControl }));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  cleanup();
  setCopyLocale("en");
  localStorage.clear();
  clearCloudPromptBackendState();
  state.ownerId = "sync-owner";
  state.preference = false;
  state.sync.mockReset().mockResolvedValue(undefined);
  state.setPreference.mockReset();
  state.getAccessToken.mockReset().mockResolvedValue("signed-in-token");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("explicit Settings Cloud sync", () => {
  it("does not sync or enable the preference until the user opts in", async () => {
    const { result } = renderHook(useAccountProfileSettings);
    await act(async () => { await result.current.handleCloudSyncRetry(); });
    expect(state.sync).not.toHaveBeenCalled();
    expect(state.setPreference).not.toHaveBeenCalled();
    await act(async () => { await result.current.handleCloudSyncToggle(); });
    expect(state.setPreference.mock.calls).toEqual([[true]]);
    expect(state.sync).toHaveBeenCalledTimes(1);
    expect(result.current.cloudSyncOn).toBe(true);
    expect(result.current.cloudSyncPending).toBe(false);
    expect(result.current.cloudSyncError).toBeNull();
  });

  it("locks repeated toggle and retry actions before the pending render commits", async () => {
    const pending = deferred();
    state.sync.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useAccountProfileSettings);
    let first;
    act(() => {
      first = result.current.handleCloudSyncToggle();
      void result.current.handleCloudSyncToggle();
      void result.current.handleCloudSyncRetry();
    });
    expect(state.sync).toHaveBeenCalledTimes(1);
    expect(state.setPreference.mock.calls).toEqual([[true]]);
    expect(result.current.cloudSyncPending).toBe(true);
    await act(async () => { pending.resolve(); await first; });
    expect(result.current.cloudSyncPending).toBe(false);
  });

  it("keeps the explicit opt-in after a network failure and retries without toggling it", async () => {
    state.sync.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { result } = renderHook(useAccountProfileSettings);
    await act(async () => { await result.current.handleCloudSyncToggle(); });
    expect(result.current.cloudSyncError).toEqual({ code: "billing_network_error" });
    expect(result.current.cloudSyncOn).toBe(true);
    expect(result.current.cloudSyncPending).toBe(false);
    await act(async () => { await result.current.handleCloudSyncRetry(); });
    expect(state.sync).toHaveBeenCalledTimes(2);
    expect(state.setPreference.mock.calls).toEqual([[true]]);
    expect(result.current.cloudSyncError).toBeNull();
  });

  it("routes access failures to the existing contextual prompt without a second generic error", async () => {
    const membership = { status: "free", can_upload_cloud: false, can_read_cloud: false };
    state.sync.mockRejectedValueOnce({ code: "cloud_membership_required", membership });
    const { result } = renderHook(useAccountProfileSettings);
    await act(async () => { await result.current.handleCloudSyncToggle(); });
    expect(result.current.cloudSyncError).toBeNull();
    expect(readCloudPromptState(state.ownerId).failure).toEqual({ code: "cloud_membership_required", source: "cloud-sync" });
    // Resolving void may mean an empty drain or cooldown; it is not upload proof.
    await act(async () => { await result.current.handleCloudSyncRetry(); });
    expect(readCloudPromptState(state.ownerId).failure).toEqual({ code: "cloud_membership_required", source: "cloud-sync" });
  });

  it("clears an error after an actual background upload notification", async () => {
    state.sync.mockRejectedValueOnce({ code: "CLOUD_UPLOAD_FAILED" });
    const { result } = renderHook(useAccountProfileSettings);
    await act(async () => { await result.current.handleCloudSyncToggle(); });
    expect(result.current.cloudSyncError).toBeTruthy();
    act(() => { window.dispatchEvent(new Event(CLOUD_USAGE_SYNCED_EVENT)); });
    expect(result.current.cloudSyncError).toBeNull();
    expect(state.sync).toHaveBeenCalledTimes(1);
  });

  it("lets the user turn sync off after failure and prevents retry from opting in again", async () => {
    state.sync.mockRejectedValueOnce(new Error("Local server unavailable"));
    const { result } = renderHook(useAccountProfileSettings);
    await act(async () => { await result.current.handleCloudSyncToggle(); });
    await act(async () => { await result.current.handleCloudSyncToggle(); });
    await act(async () => { await result.current.handleCloudSyncRetry(); });
    expect(result.current.cloudSyncOn).toBe(false);
    expect(result.current.cloudSyncError).toBeNull();
    expect(state.sync).toHaveBeenCalledTimes(1);
    expect(state.setPreference.mock.calls).toEqual([[true], [false]]);
  });

  it("honors a Use local data opt-out while a manual attempt is pending", async () => {
    const pending = deferred();
    state.sync.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useAccountProfileSettings);
    let operation;
    act(() => { operation = result.current.handleCloudSyncToggle(); });
    act(() => { result.current.handleCloudSyncDisable(); });
    expect(result.current.cloudSyncOn).toBe(false);
    expect(state.setPreference.mock.calls).toEqual([[true], [false]]);
    await act(async () => { pending.reject({ code: "cloud_membership_required" }); await operation; });
    expect(state.sync).toHaveBeenCalledTimes(1);
    expect(result.current.cloudSyncPending).toBe(false);
    expect(result.current.cloudSyncError).toBeNull();
    expect(readCloudPromptState(state.ownerId).failure).toBeUndefined();
  });

  it("ignores an old account's failure and completion while the next account is syncing", async () => {
    const old = deferred();
    const next = deferred();
    state.sync.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const view = renderHook(useAccountProfileSettings);
    let first;
    act(() => { first = view.result.current.handleCloudSyncToggle(); });
    state.ownerId = "next-owner";
    view.rerender();
    expect(view.result.current.cloudSyncPending).toBe(false);
    expect(view.result.current.cloudSyncError).toBeUndefined();
    let second;
    act(() => { second = view.result.current.handleCloudSyncRetry(); });
    await act(async () => { old.reject({ code: "cloud_machine_paused" }); await first; });
    expect(view.result.current.cloudSyncPending).toBe(true);
    expect(view.result.current.cloudSyncError).toBeNull();
    expect(readCloudPromptState("sync-owner").failure).toBeUndefined();
    expect(readCloudPromptState("next-owner").failure).toBeUndefined();
    await act(async () => { next.resolve(); await second; });
    expect(view.result.current.cloudSyncPending).toBe(false);
  });

  it("does not publish a late failure after the Settings hook unmounts", async () => {
    const pending = deferred();
    state.sync.mockReturnValueOnce(pending.promise);
    const view = renderHook(useAccountProfileSettings);
    let operation;
    act(() => { operation = view.result.current.handleCloudSyncToggle(); });
    view.unmount();
    await act(async () => { pending.reject({ code: "cloud_machine_paused" }); await operation; });
    expect(readCloudPromptState(state.ownerId).failure).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("Settings sync feedback", () => {
  it("disables the pending toggle and offers an inline retry after failure without promising upload success", async () => {
    const pending = deferred();
    state.sync.mockReturnValueOnce(pending.promise);
    render(<MemoryRouter><CloudSection /></MemoryRouter>);
    const toggle = screen.getByRole("switch", { name: copy("settings.account.cloudSync") });
    await act(async () => { await userEvent.click(toggle); });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("status")).toHaveTextContent(copy("settings.account.cloudSyncPending"));
    await act(async () => { pending.reject(new TypeError("Failed to fetch")); });
    expect(toggle).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(copy("settings.account.cloudSyncError"));
    await act(async () => { await userEvent.click(screen.getByRole("button", { name: copy("cloud.action.retry") })); });
    expect(state.sync).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("shows the existing trial or device guidance instead of duplicate sync error text", async () => {
    const membership = { status: "free", environment: "live", phase: "active", trial_available: true, can_upload_cloud: false, can_read_cloud: false };
    publishCloudPromptBilling("catalog", { environment: "live", checkout_verified: true, policy: { phase: "active", launch_at: "2000-01-01" }, providers: { waffo: true } }, null);
    publishCloudPromptBilling("account", { membership }, state.ownerId);
    state.sync.mockRejectedValueOnce({ code: "cloud_membership_required", membership });
    render(<MemoryRouter><CloudSection /></MemoryRouter>);
    await act(async () => { await userEvent.click(screen.getByRole("switch", { name: copy("settings.account.cloudSync") })); });
    expect(screen.getByRole("link", { name: copy("cloud.prompt.try") })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy("cloud.action.retry") })).not.toBeInTheDocument();
  });
});
