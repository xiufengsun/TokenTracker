/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://www.tokentracker.cc"} */
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Navigate, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InsforgeAuthProvider, useInsforgeAuth } from "../InsforgeAuthContext.jsx";

const state = vi.hoisted(() => ({ configured: true, callbackCaptured: null, resolve: null, pending: null }));
const client = { auth: {} };
vi.mock("../../lib/insforge-config", () => ({
  getOrCreateInsforgeClient: () => {
    state.callbackCaptured = new URLSearchParams(window.location.search).get("insforge_code");
    return client;
  },
  isCloudInsforgeConfigured: () => state.configured,
  getInsforgeConfigurationError: () => state.configured ? null : "missing_backend_anon_key",
  getInsforgeConnectionHost: () => null,
  isOfficialInsforgeInstance: () => true,
  INSFORGE_INSTANCE_CHANGED_EVENT: "tt.insforgeInstanceChanged",
  isCurrentInsforgeClient: () => true,
  shouldRestoreInsforgeSession: () => true,
  allowInsforgeSessionRestore: vi.fn(),
}));
vi.mock("../../lib/insforge-session-recovery.mjs", () => ({ restoreInsforgeUser: () => state.pending }));
vi.mock("../../lib/local-api-auth", () => ({ clearLocalApiAuthToken: vi.fn(), getLocalApiAuthHeaders: async () => ({}) }));

function ProtectedRoute() {
  const auth = useInsforgeAuth();
  const location = useLocation();
  return (
    <>
      {!auth.loading && !auth.signedIn && location.pathname !== "/login" && <Navigate to="/login" replace />}
      <p>{auth.loading ? "Restoring session" : location.pathname}</p>
    </>
  );
}
beforeEach(() => {
  state.configured = true; state.callbackCaptured = null;
  state.pending = new Promise(resolve => { state.resolve = resolve; });
  window.history.replaceState(null, "", "/dashboard?insforge_code=fixture-only-code");
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

it("keeps the callback URL until the configured SDK starts and restores the user", async () => {
  render(<BrowserRouter><InsforgeAuthProvider><ProtectedRoute /></InsforgeAuthProvider></BrowserRouter>);
  expect(await screen.findByText("Restoring session")).toBeInTheDocument();
  expect(state.callbackCaptured).toBe("fixture-only-code");
  expect(window.location.pathname).toBe("/dashboard");
  state.resolve({ data: { user: { id: "fixture-account" } }, error: null });
  await screen.findByText("/dashboard");
  expect(window.location.pathname).toBe("/dashboard");
});

it("still opens sign-in after a completed restore reports no user", async () => {
  render(<BrowserRouter><InsforgeAuthProvider><ProtectedRoute /></InsforgeAuthProvider></BrowserRouter>);
  state.resolve({ data: { user: null }, error: null });
  await waitFor(() => expect(window.location.pathname).toBe("/login"));
});

it("does not leave an invalid backend configuration waiting for an SDK", async () => {
  state.configured = false;
  render(<BrowserRouter><InsforgeAuthProvider><ProtectedRoute /></InsforgeAuthProvider></BrowserRouter>);
  await waitFor(() => expect(window.location.pathname).toBe("/login"));
  expect(state.callbackCaptured).toBeNull();
});
