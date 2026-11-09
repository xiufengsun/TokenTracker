import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInstanceSettings } from "./use-instance-settings.js";

const authMock = vi.hoisted(() => ({
  headers: { "x-tokentracker-local-auth": "token-one" },
  cleared: 0,
}));

vi.mock("../lib/local-api-auth", () => ({
  getLocalApiAuthHeaders: vi.fn(async () => {
    // After a clear, the next fetch returns a fresh token — mirroring the
    // module-level cache in local-api-auth.ts.
    if (authMock.cleared > 0) return { "x-tokentracker-local-auth": "token-two" };
    return authMock.headers;
  }),
  clearLocalApiAuthToken: vi.fn(() => {
    authMock.cleared += 1;
  }),
}));

function setHostname(hostname) {
  Object.defineProperty(window, "location", {
    value: { ...window.location, hostname },
    writable: true,
    configurable: true,
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const OFFICIAL = "https://srctyff5.us-east.insforge.app";
const SELF_HOSTED = "https://insforge.self.example.com";
const GET_BODY = {
  baseUrl: OFFICIAL,
  officialUrl: OFFICIAL,
  custom: false,
  dashboardUrl: "",
  anonKeySet: true,
  configurationError: null,
};

describe("useInstanceSettings", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    authMock.cleared = 0;
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    vi.unstubAllGlobals();
  });

  it("stays unavailable off a local dashboard host", () => {
    setHostname("www.tokentracker.cc");
    const { result } = renderHook(() => useInstanceSettings());
    expect(result.current.available).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it("loads the instance state on a local host", async () => {
    setHostname("localhost");
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === "POST") return jsonResponse(200, { ok: true });
      return jsonResponse(200, GET_BODY);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useInstanceSettings());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.config.baseUrl).toBe(OFFICIAL);
    expect(result.current.config.custom).toBe(false);
  });

  it("retries once with a fresh token when the cached one is rejected", async () => {
    setHostname("localhost");
    const calls = [];
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === "POST") {
        calls.push(init.headers["x-tokentracker-local-auth"]);
        if (calls.length === 1) return jsonResponse(401, { ok: false, error: "Unauthorized" });
        return jsonResponse(200, { ok: true, ...GET_BODY, custom: true, baseUrl: SELF_HOSTED });
      }
      return jsonResponse(200, GET_BODY);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useInstanceSettings());
    await waitFor(() => expect(result.current.available).toBe(true));

    let saved;
    await act(async () => {
      saved = await result.current.save({ baseUrl: SELF_HOSTED, anonKey: "anon_key" });
    });

    expect(calls).toEqual(["token-one", "token-two"]);
    expect(authMock.cleared).toBe(1);
    expect(saved.custom).toBe(true);
    expect(result.current.config.custom).toBe(true);
  });

  it("keeps the card available when the persisted URL is invalid", async () => {
    setHostname("localhost");
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        baseUrl: "",
        officialUrl: OFFICIAL,
        custom: false,
        dashboardUrl: "",
        anonKeySet: false,
        configurationError: "invalid_insforge_base_url",
      }),
    );
  it("probes a candidate address through the server-side test endpoint", async () => {
    setHostname("localhost");
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === "POST" && String(url).includes("instance-test")) {
        return jsonResponse(200, { ok: true, reachable: true, status: 404, error: null });
      }
      return jsonResponse(200, GET_BODY);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useInstanceSettings());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.config.baseUrl).toBe("");
    expect(result.current.config.configurationError).toBe("invalid_insforge_base_url");
    let outcome;
    await act(async () => {
      outcome = await result.current.test(SELF_HOSTED);
    });
    expect(outcome).toEqual({ reachable: true, status: 404, error: null });
  });

  it("surfaces server rejections after the retry", async () => {
    setHostname("localhost");
    const fetchMock = vi.fn(async (url, init) => {
      if (init?.method === "POST") return jsonResponse(400, { ok: false, error: "invalid_instance_url" });
      return jsonResponse(200, GET_BODY);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useInstanceSettings());
    await waitFor(() => expect(result.current.available).toBe(true));

    let caught = null;
    await act(async () => {
      try {
        await result.current.save({ baseUrl: "not-a-url" });
      } catch (error) {
        caught = error;
      }
    });
    expect(caught?.message).toBe("invalid_instance_url");
  });
});
