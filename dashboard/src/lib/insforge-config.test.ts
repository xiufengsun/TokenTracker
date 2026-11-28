import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@insforge/sdk", () => ({ createClient: sdk.create }));
const anon = (name: string) => `${btoa('{"alg":"HS256"}').replace(/=+$/, "")}.${btoa(JSON.stringify({ role: "anon", sub: name })).replace(/=+$/, "")}.signature`;
function hostedBackend(baseUrl: string) {
  vi.stubGlobal("window", Object.create(window, {
    location: { value: new URL("https://www.tokentracker.cc/dashboard") },
    __TOKENTRACKER_RUNTIME_CONFIG__: { value: { baseUrl, anonKey: anon("cloudflare"), sessionMigration: true } },
  }));
}
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
  it("keeps the old session restore path during the migration window", async () => {
    const config = await import("./insforge-config");
    const original: any = config.getOrCreateInsforgeClient();
    window.__TOKENTRACKER_RUNTIME_CONFIG__ = {
      baseUrl: "https://api.tokentracker.cc",
      anonKey: anon("cloudflare"),
      sessionMigration: true,
    };
    const replacement = config.getOrCreateInsforgeClient();
    expect(replacement).not.toBe(original);
    expect(original.tokenManager.clearSession).not.toHaveBeenCalled();
    expect(config.shouldRestoreInsforgeSession()).toBe(true);
    expect(sdk.create.mock.calls.at(-1)?.[0].auth.detectOAuthCallback).toBe(true);
  });
  it("exchanges an official hosted browser session once and retries a failed exchange without clearing it", async () => {
    const { CLOUDFLARE_API_URL, OFFICIAL_INSFORGE_URL } = await import("./insforge-deployment-config.mjs");
    hostedBackend(CLOUDFLARE_API_URL);
    localStorage.setItem("tt.insforge.instance", OFFICIAL_INSFORGE_URL);
    const legacyRefresh = vi.fn().mockResolvedValue({ data: { accessToken: "legacy.fixture.bearer" }, error: null });
    sdk.create.mockImplementation((clientConfig) => ({
      config: clientConfig,
      auth: { refreshSession: legacyRefresh },
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ user: { id: "same-user" }, accessToken: "cloud.fixture.bearer" }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = await import("./insforge-config");
    config.getOrCreateInsforgeClient();
    const transport: typeof fetch = sdk.create.mock.calls[0][0].fetch;
    const refresh = () => transport(CLOUDFLARE_API_URL + "/api/auth/refresh", { method: "POST", credentials: "include" });
    expect((await refresh()).status).toBe(401);
    expect(localStorage.getItem("tt.insforge.instance")).toBe(OFFICIAL_INSFORGE_URL);
    expect((await (await refresh()).json()).user.id).toBe("same-user");
    expect(localStorage.getItem("tt.insforge.instance")).toBe(CLOUDFLARE_API_URL);
    expect((await refresh()).status).toBe(401);
    expect(legacyRefresh).toHaveBeenCalledTimes(2);
    expect(sdk.create.mock.calls[1][0]).toMatchObject({ baseUrl: OFFICIAL_INSFORGE_URL, auth: { detectOAuthCallback: false } });
    expect(fetchMock.mock.calls[3]).toMatchObject([
      CLOUDFLARE_API_URL + "/api/auth/session-migrate",
      { method: "POST", credentials: "include", redirect: "error", body: "{}", headers: { Authorization: "Bearer legacy.fixture.bearer" } },
    ]);
  });
  it("keeps an explicit logout from restoring an old hosted browser session", async () => {
    const { CLOUDFLARE_API_URL, OFFICIAL_INSFORGE_URL } = await import("./insforge-deployment-config.mjs");
    hostedBackend(CLOUDFLARE_API_URL);
    localStorage.setItem("tt.insforge.instance", OFFICIAL_INSFORGE_URL);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = await import("./insforge-config");
    config.getOrCreateInsforgeClient();
    const transport: typeof fetch = sdk.create.mock.calls[0][0].fetch;
    await transport(CLOUDFLARE_API_URL + "/api/auth/logout", { method: "POST" });
    expect((await transport(CLOUDFLARE_API_URL + "/api/auth/refresh", { method: "POST" })).status).toBe(401);
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tt.insforge.instance")).toBe(CLOUDFLARE_API_URL);
  });
  it("restores the original hosted account through the SDK's normal getCurrentUser entry point", async () => {
    const { CLOUDFLARE_API_URL, OFFICIAL_INSFORGE_URL } = await import("./insforge-deployment-config.mjs");
    const realSdk = await vi.importActual<typeof import("@insforge/sdk")>("@insforge/sdk");
    sdk.create.mockImplementation(realSdk.createClient);
    hostedBackend(CLOUDFLARE_API_URL);
    localStorage.setItem("tt.insforge.instance", OFFICIAL_INSFORGE_URL);
    const user = { id: "existing-account", email: "existing@example.test" };
    const visited: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      visited.push(url);
      expect(init?.credentials).toBe("include");
      if (url === CLOUDFLARE_API_URL + "/api/auth/refresh") return Response.json({ message: "No Cloudflare cookie yet" }, { status: 401 });
      if (url === OFFICIAL_INSFORGE_URL + "/api/auth/refresh") return Response.json({ user, accessToken: "legacy.fixture.bearer" });
      if (url === CLOUDFLARE_API_URL + "/api/auth/session-migrate") {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer legacy.fixture.bearer");
        return Response.json({ user, accessToken: "cloud.fixture.bearer" });
      }
      throw new Error("Unexpected auth origin");
    }));
    const client = (await import("./insforge-config")).getOrCreateInsforgeClient()!;
    expect(await client.auth.getCurrentUser()).toEqual({ data: { user }, error: null });
    expect(await client.auth.getCurrentUser()).toEqual({ data: { user }, error: null });
    expect(visited).toEqual([
      CLOUDFLARE_API_URL + "/api/auth/refresh",
      OFFICIAL_INSFORGE_URL + "/api/auth/refresh",
      CLOUDFLARE_API_URL + "/api/auth/session-migrate",
    ]);
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

it("recognizes only the exact second official API, with separate browser sessions", async () => {
  const config = await import("./insforge-config");
  const { CLOUDFLARE_API_URL } = await import("./insforge-deployment-config.mjs");
  const old = config.getOrCreateInsforgeClient();
  const oldBase = config.getInsforgeRemoteUrl();
  const anonKey = config.getInsforgeAnonKey();
  window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: CLOUDFLARE_API_URL, anonKey };
  expect(config.isOfficialInsforgeInstance()).toBe(true);
  expect(config.getInsforgeConnectionHost()).toBeNull();
  expect(config.getInsforgeRemoteUrl()).not.toBe(oldBase);
  expect(config.getOrCreateInsforgeClient()).not.toBe(old);
  expect(config.shouldRestoreInsforgeSession()).toBe(false);
  for (const baseUrl of [CLOUDFLARE_API_URL + ".example.org", CLOUDFLARE_API_URL + "/custom"]) {
    window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl, anonKey };
    expect(config.isOfficialInsforgeInstance()).toBe(false);
    expect(config.getInsforgeConfigurationError()).toBe("missing_backend_anon_key");
  }
});
