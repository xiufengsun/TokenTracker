import { describe, expect, it } from "vitest";
import { isPublicAnonKey, validateInsforgeBuildEnv, validateInsforgeDeployment, OFFICIAL_INSFORGE_URL } from "./insforge-deployment-config.mjs";
const token = (role) => `${btoa('{"alg":"HS256"}').replace(/=+$/, "")}.${btoa(JSON.stringify({ role })).replace(/=+$/, "")}.signature`;
const anon = token("anon");
const opaque = (length) => "anon_" + "746573742d616e6f6e2d66616b65".repeat(3).slice(0, length);
const malformedOpaque = ["anon_", ...[39, 41, 63, 65].map(length => "anon_" + "a".repeat(length)),
  "anon_" + opaque(40).slice(5).toUpperCase(), "anon_" + "g".repeat(40),
  "anon__" + "a".repeat(40), "an0n_" + "a".repeat(40), "ik_" + "a".repeat(40), "ik_" + anon, "a".repeat(64)];

describe("public backend configuration", () => {
  it("preserves the official default and accepts an explicit private public-key pair", () => {
    expect(validateInsforgeDeployment({ defaultAnonKey: anon })).toMatchObject({ baseUrl: OFFICIAL_INSFORGE_URL, anonKey: anon, errorCode: null });
    expect(validateInsforgeDeployment({ baseUrl: "https://private.example/", anonKey: anon })).toMatchObject({ baseUrl: "https://private.example", anonKey: anon, errorCode: null });
  });
  it("never borrows the official key for a custom URL, including an explicitly copied default", () => {
    expect(validateInsforgeDeployment({ baseUrl: "https://private.example", defaultAnonKey: anon }).errorCode).toBe("missing_backend_anon_key");
    expect(validateInsforgeDeployment({ baseUrl: "https://private.example", anonKey: anon, defaultAnonKey: anon }).errorCode).toBe("missing_backend_anon_key");
    expect(validateInsforgeDeployment({ strictPair: true }).errorCode).toBe("missing_backend_anon_key");
  });
  it.each(["service_role", "authenticated", "admin", "project_admin"])("rejects %s before a SDK or frontend build can use it", (role) => {
    expect(isPublicAnonKey(token(role))).toBe(false);
    expect(validateInsforgeBuildEnv({ VITE_INSFORGE_BASE_URL: "https://private.example", VITE_INSFORGE_ANON_KEY: token(role) }).errorCode).toBe("invalid_backend_anon_key");
  });
  it.each(["ik_admin_secret", "public-placeholder", "-----BEGIN PRIVATE KEY-----"])("rejects a non-anon credential without echoing it: %s", (value) => {
    const result = validateInsforgeBuildEnv({ VITE_INSFORGE_ANON_KEY: value });
    expect(result).toEqual({ baseUrl: "", anonKey: "", errorCode: "invalid_backend_anon_key" });
  });
  it.each(["https://user:password@private.example", "http://private.example", "javascript:alert(1)", "https://private.example?token=secret", "https://private.example#secret"])("rejects unsafe backend URL %s", (baseUrl) => {
    expect(validateInsforgeDeployment({ baseUrl, anonKey: anon }).errorCode).toBe("invalid_backend_url");
  });
  it("allows loopback development and validates either existing VITE naming pair", () => {
    expect(validateInsforgeBuildEnv({ VITE_TOKENTRACKER_BACKEND_BASE_URL: "http://127.0.0.1:7130", VITE_TOKENTRACKER_BACKEND_ANON_KEY: anon }).errorCode).toBeNull();
    expect(validateInsforgeBuildEnv({}).baseUrl).toBe(OFFICIAL_INSFORGE_URL);
  });
  it.each([40, 64])("accepts an explicit %s-character opaque public key through deployment and both build naming pairs", (length) => {
    const key = opaque(length);
    const baseUrl = "http://127.0.0.1:7130";
    expect(isPublicAnonKey(key)).toBe(true);
    expect(validateInsforgeDeployment({ baseUrl, anonKey: key, strictPair: true })).toEqual({ baseUrl, anonKey: key, errorCode: null });
    expect(validateInsforgeBuildEnv({ VITE_INSFORGE_BASE_URL: baseUrl, VITE_INSFORGE_ANON_KEY: key })).toEqual({ baseUrl, anonKey: key, errorCode: null });
    expect(validateInsforgeBuildEnv({ VITE_TOKENTRACKER_BACKEND_BASE_URL: baseUrl, VITE_TOKENTRACKER_BACKEND_ANON_KEY: key })).toEqual({ baseUrl, anonKey: key, errorCode: null });
  });
  it.each(malformedOpaque)("rejects malformed opaque formats without using the official fallback: %s", (key) => {
    expect(isPublicAnonKey(key)).toBe(false);
    expect(validateInsforgeDeployment({ baseUrl: "https://private.example", anonKey: key, defaultAnonKey: anon }))
      .toEqual({ baseUrl: "", anonKey: "", errorCode: "invalid_backend_anon_key" });
  });
  it.each([40, 64])("requires a complete runtime descriptor for an opaque %s-character key", async (length) => {
    const previous = window.__TOKENTRACKER_RUNTIME_CONFIG__;
    const configuration = await import("./insforge-config");
    try {
      const key = opaque(length);
      window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://private.example", anonKey: key };
      expect(configuration.getInsforgeRemoteUrl()).toBe("https://private.example");
      expect(configuration.getInsforgeAnonKey()).toBe(key);
      for (const descriptor of [{ baseUrl: "https://another.example" }, { baseUrl: "https://private.example", anonKey: key + "x" }, {}]) {
        window.__TOKENTRACKER_RUNTIME_CONFIG__ = descriptor;
        expect(configuration.getInsforgeRemoteUrl()).toBe("");
        expect(configuration.getInsforgeAnonKey()).toBe("");
      }
      expect(validateInsforgeDeployment({ baseUrl: "https://another.example", anonKey: key, defaultAnonKey: key }).errorCode)
        .toBe("missing_backend_anon_key");
    } finally {
      if (previous === undefined) delete window.__TOKENTRACKER_RUNTIME_CONFIG__;
      else window.__TOKENTRACKER_RUNTIME_CONFIG__ = previous;
    }
  });
});
