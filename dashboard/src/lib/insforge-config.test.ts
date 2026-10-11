import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@insforge/sdk", () => ({ createClient: sdk.create }));
const anon = (name: string) => `${btoa('{"alg":"HS256"}').replace(/=+$/, "")}.${btoa(JSON.stringify({ role: "anon", sub: name })).replace(/=+$/, "")}.signature`;
beforeEach(() => {
  vi.resetModules();
  sdk.create.mockReset().mockImplementation((config) => ({ config, tokenManager: { clearSession: vi.fn() } }));
  localStorage.clear(); sessionStorage.clear();
  delete window.__TOKENTRACKER_RUNTIME_CONFIG__;
  for (const key of ["VITE_INSFORGE_BASE_URL", "VITE_INSFORGE_ANON_KEY", "VITE_TOKENTRACKER_BACKEND_BASE_URL", "VITE_TOKENTRACKER_BACKEND_ANON_KEY"]) vi.stubEnv(key, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); delete window.__TOKENTRACKER_RUNTIME_CONFIG__; });

describe("instance-bound frontend SDK", () => {
  it("keeps the official singleton and OAuth callback behavior without runtime overrides", async () => {
    const config = await import("./insforge-config");
    const client = config.getOrCreateInsforgeClient();
    expect(config.getOrCreateInsforgeClient()).toBe(client);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.create.mock.calls[0][0].auth.detectOAuthCallback).toBe(true);
  });
  it("uses the synchronous runtime descriptor over build values and fails closed on its error", async () => {
    vi.stubEnv("VITE_INSFORGE_BASE_URL", "https://build.example");
    vi.stubEnv("VITE_INSFORGE_ANON_KEY", anon("build"));
    window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://runtime.example", anonKey: anon("runtime") };
    const config = await import("./insforge-config");
    expect(config.getInsforgeRemoteUrl()).toBe("https://runtime.example");
    expect(config.getInsforgeConnectionHost()).toBe("runtime.example");
    window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://runtime.example", configurationError: "missing anon" };
    expect(config.getInsforgeRemoteUrl()).toBe("");
    expect(config.getInsforgeAnonKey()).toBe("");
    expect(config.isCloudInsforgeConfigured()).toBe(false);
    expect(config.getInsforgeConnectionHost()).toBeNull();
    expect(config.getOrCreateInsforgeClient()).toBeNull();
  });
  it("does not expose the official key when custom VITE deployment forgot its key", async () => {
    vi.stubEnv("VITE_INSFORGE_BASE_URL", "https://custom.example");
    const config = await import("./insforge-config");
    expect(config.getInsforgeConfigurationError()).toBe("missing_backend_anon_key");
    expect(config.getInsforgeAnonKey()).toBe("");
    expect(config.getOrCreateInsforgeClient()).toBeNull();
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it("clears only SDK auth/PKCE when the instance changes and refuses stale clients", async () => {
    const config = await import("./insforge-config");
    const original: any = config.getOrCreateInsforgeClient();
    sessionStorage.setItem("insforge_pkce_verifier", "old-pkce");
    localStorage.setItem("insforge_auth", "old-auth");
    localStorage.setItem("tt.providerPrefs", "keep");
    localStorage.setItem("tt.local.history", "keep");
    window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://other.example", anonKey: anon("other") };
    const replacement = config.getOrCreateInsforgeClient();
    expect(replacement).not.toBe(original);
    expect(original.tokenManager.clearSession).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("insforge_pkce_verifier")).toBeNull();
    expect(localStorage.getItem("insforge_auth")).toBeNull();
    expect(localStorage.getItem("tt.providerPrefs")).toBe("keep");
    expect(localStorage.getItem("tt.local.history")).toBe("keep");
    expect(config.isCurrentInsforgeClient(original)).toBe(false);
    expect(config.isCurrentInsforgeClient(replacement)).toBe(true);
    expect(config.shouldRestoreInsforgeSession()).toBe(false);
  });
  it("marks only same-origin runtime proxies and never adds that header to direct remote calls", async () => {
    window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://private.example", anonKey: anon("private") };
    const config = await import("./insforge-config");
    config.getOrCreateInsforgeClient();
    const transport = sdk.create.mock.calls[0][0].fetch;
    const request = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", request);
    await transport(`${window.location.origin}/api/auth/refresh`, { headers: { Accept: "application/json" } });
    expect(new Headers(request.mock.calls[0][1].headers).get("x-tokentracker-instance")).toBe("https://private.example");
    await transport("https://private.example/functions/example", { headers: { Accept: "application/json" } });
    expect(new Headers(request.mock.calls[1][1].headers).has("x-tokentracker-instance")).toBe(false);
  });
});
