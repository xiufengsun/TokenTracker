import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AUTH_URL = "https://auth.example/authorize";
const client = {
  auth: {
    signInWithOAuth: vi.fn(async () => ({ data: { url: AUTH_URL }, error: null })),
  },
};

vi.mock("../../lib/insforge-config", () => ({
  getOrCreateInsforgeClient: () => client,
  isCloudInsforgeConfigured: () => true,
}));
vi.mock("../../lib/insforge-session-recovery.mjs", () => ({
  restoreInsforgeUser: async () => ({ data: { user: null }, error: null }),
}));
vi.mock("../../lib/local-api-auth", () => ({
  clearLocalApiAuthToken: vi.fn(),
  getLocalApiAuthHeaders: async () => ({ "x-tokentracker-local-auth": "t" }),
}));

import { InsforgeAuthProvider, useInsforgeAuth } from "../InsforgeAuthContext.jsx";

async function renderAuth() {
  const wrapper = ({ children }) => <InsforgeAuthProvider>{children}</InsforgeAuthProvider>;
  const { result } = renderHook(() => useInsforgeAuth(), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  return result;
}

async function signIn(result) {
  let outcome;
  await act(async () => {
    outcome = await result.current.signInWithOAuth("github");
  });
  return outcome;
}

describe("native OAuth sign-in", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete window.webkit;
    delete window.__TAURI_INTERNALS__;
  });

  it("opens the system browser on Linux once the app's marker is stored", async () => {
    const invoke = vi.fn(async () => undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    const result = await renderAuth();

    const outcome = await signIn(result);

    expect(outcome.error).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth-bridge/verifier", expect.objectContaining({ method: "PUT" }));
    expect(invoke).toHaveBeenCalledWith("open_oauth", { url: AUTH_URL });
  });

  it("does not open the browser on Linux when the marker is rejected", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    const invoke = vi.fn(async () => undefined);
    window.__TAURI_INTERNALS__ = { invoke };
    const result = await renderAuth();

    const outcome = await signIn(result);

    expect(outcome.error).toBeInstanceOf(Error);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports a system browser that could not be opened", async () => {
    window.__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => {
        throw "failed to open the system browser: xdg-open not found";
      }),
    };
    const result = await renderAuth();

    const outcome = await signIn(result);

    expect(outcome.error.message).toMatch(/failed to open the system browser/);
  });

  it("keeps macOS/Windows best effort when the marker is rejected", async () => {
    fetchMock.mockResolvedValue({ ok: false });
    const postMessage = vi.fn();
    window.webkit = { messageHandlers: { nativeOAuth: { postMessage } } };
    const result = await renderAuth();

    const outcome = await signIn(result);

    expect(outcome.error).toBeFalsy();
    expect(postMessage).toHaveBeenCalledWith(AUTH_URL);
  });
});
