import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/insforge-config", () => ({
  getOrCreateInsforgeClient: () => null,
  isCloudInsforgeConfigured: () => false,
  getInsforgeConfigurationError: () => null,
  getInsforgeConnectionHost: () => null,
  isOfficialInsforgeInstance: () => true,
  INSFORGE_INSTANCE_CHANGED_EVENT: "tt.insforgeInstanceChanged",
  isCurrentInsforgeClient: () => true,
  shouldRestoreInsforgeSession: () => true,
  allowInsforgeSessionRestore: vi.fn(),
}));

import { resolveInsforgeClientAccessToken } from "../InsforgeAuthContext.jsx";

function makeJwt(expSeconds) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=/g, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ exp: expSeconds })}.sig`;
}

describe("resolveInsforgeClientAccessToken", () => {
  it("refreshes the session when token manager is empty", async () => {
    const accessToken = "restored-token";
    const client = {
      tokenManager: {
        getAccessToken: vi.fn(() => null),
        getSession: vi.fn(() => null),
      },
      auth: {
        refreshSession: vi.fn(async () => ({ data: { accessToken } })),
      },
    };

    await expect(resolveInsforgeClientAccessToken(client)).resolves.toBe(accessToken);
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it("returns a fresh in-memory token without refreshing", async () => {
    const accessToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const client = {
      tokenManager: {
        getAccessToken: vi.fn(() => accessToken),
        getSession: vi.fn(() => ({ accessToken })),
      },
      auth: {
        refreshSession: vi.fn(async () => ({ data: { accessToken: "should-not-be-used" } })),
      },
    };

    await expect(resolveInsforgeClientAccessToken(client)).resolves.toBe(accessToken);
    expect(client.auth.refreshSession).not.toHaveBeenCalled();
  });

  it("refreshes an about-to-expire token", async () => {
    const expiredSoonToken = makeJwt(Math.floor(Date.now() / 1000) + 10);
    const refreshedToken = "fresh-token";
    const client = {
      tokenManager: {
        getAccessToken: vi
          .fn()
          .mockReturnValueOnce(expiredSoonToken)
          .mockReturnValueOnce(refreshedToken),
        getSession: vi.fn(() => null),
      },
      auth: {
        refreshSession: vi.fn(async () => ({ data: { accessToken: refreshedToken } })),
      },
    };

    await expect(resolveInsforgeClientAccessToken(client)).resolves.toBe(refreshedToken);
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it("uses the refreshed payload while the token manager still exposes the expired token", async () => {
    const expiredToken = makeJwt(Math.floor(Date.now() / 1000) - 60);
    const refreshedToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const client = {
      tokenManager: {
        getAccessToken: vi.fn(() => expiredToken),
        getSession: vi.fn(() => ({ accessToken: expiredToken })),
      },
      auth: {
        refreshSession: vi.fn(async () => ({ data: { accessToken: refreshedToken } })),
      },
    };

    await expect(resolveInsforgeClientAccessToken(client)).resolves.toBe(refreshedToken);
    expect(client.auth.refreshSession).toHaveBeenCalledTimes(1);
  });

  it("uses access_token from refresh payload when token manager stays empty", async () => {
    const accessToken = "snake-case-token";
    const client = {
      tokenManager: {
        getAccessToken: vi.fn(() => null),
        getSession: vi.fn(() => null),
      },
      auth: {
        refreshSession: vi.fn(async () => ({ data: { access_token: accessToken } })),
      },
    };

    await expect(resolveInsforgeClientAccessToken(client)).resolves.toBe(accessToken);
  });

  it("calls getCurrentUser when refresh does not repopulate token manager", async () => {
    const accessToken = "after-get-user";
    const getAccessToken = vi.fn().mockReturnValue(null);
    const client = {
      tokenManager: {
        getAccessToken,
        getSession: vi.fn(() => null),
      },
      auth: {
        refreshSession: vi.fn(async () => ({ data: {} })),
        getCurrentUser: vi.fn(async () => {
          getAccessToken.mockReturnValue(accessToken);
          return { data: { user: { id: "u1" } }, error: null };
        }),
      },
    };

    await expect(resolveInsforgeClientAccessToken(client)).resolves.toBe(accessToken);
    expect(client.auth.getCurrentUser).toHaveBeenCalledTimes(1);
  });
});
