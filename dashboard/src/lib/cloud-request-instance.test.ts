import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudBillingRequest } from "./cloud-billing";
import { fetchCloudUsageDaily, invalidateAccountResponseCache } from "./api";
import { publishCloudPromptBilling, readCloudPromptState } from "./cloud-prompt-policy.js";
const target = vi.hoisted(() => ({ url: "https://instance-a.example", key: "anon-a" }));
vi.mock("./insforge-config", () => ({ getInsforgeRemoteUrl: () => target.url, getInsforgeAnonKey: () => target.key }));
const token = `${btoa('{"alg":"HS256"}').replace(/=+$/, "")}.${btoa('{"sub":"request-owner"}').replace(/=+$/, "")}.signature`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => { target.url = "https://instance-a.example"; target.key = "anon-a"; invalidateAccountResponseCache(); });
afterEach(() => vi.unstubAllGlobals());

for (const kind of ["billing", "account"] as const) {
  const invoke = (auth: string | (() => Promise<string>)) => kind === "billing"
    ? cloudBillingRequest("account", { auth })
    : fetchCloudUsageDaily({ accessToken: auth, from: "2026-10-01", to: "2026-10-08" });
  describe(`${kind} instance binding`, () => {
    it.each(["url", "key"] as const)("does not fetch after deferred authentication changes the %s", async (change) => {
      const auth = deferred<string>();
      const request = vi.fn(); vi.stubGlobal("fetch", request);
      const result = invoke(() => auth.promise);
      const rejection = expect(result).rejects.toMatchObject({ code: "instance_changed", status: 409 });
      if (change === "url") target.url = "https://instance-b.example";
      else target.key = "anon-b";
      auth.resolve(token);
      await rejection;
      expect(request).not.toHaveBeenCalled();
    });
    it("rejects a late response rather than returning or publishing it into a new instance", async () => {
      const response = deferred<Response>();
      const request = vi.fn().mockReturnValue(response.promise); vi.stubGlobal("fetch", request);
      const result = invoke(token);
      const rejection = expect(result).rejects.toMatchObject({ code: "instance_changed" });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(request.mock.calls[0][0]).toContain("instance-a.example");
      target.url = "https://instance-b.example"; target.key = "anon-b";
      response.resolve(new Response(JSON.stringify({ membership: { status: "active" }, data: [] })));
      await rejection;
      expect(readCloudPromptState("request-owner").membership).toBeUndefined();
    });
  });
}

describe("late catalog isolation", () => {
  it.each(["response", "network_error"])("does not clear or replace B's catalog after a late A %s", async (completion) => {
    const response = deferred<Response>();
    const request = vi.fn().mockReturnValue(response.promise); vi.stubGlobal("fetch", request);
    const result = cloudBillingRequest("catalog");
    const rejection = expect(result).rejects.toMatchObject({ code: "instance_changed" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    target.url = "https://instance-b.example"; target.key = "anon-b";
    const catalogB = { environment: "live", policy: { phase: "active", hosting_mode: "self_hosted" }, prices: [] };
    publishCloudPromptBilling("catalog", catalogB, null);
    if (completion === "response") response.resolve(new Response(JSON.stringify({ environment: "live", policy: { phase: "active" }, prices: [{ amount_cents: 499 }] })));
    else response.reject(new Error("late upstream failure"));
    await rejection;
    expect(readCloudPromptState("request-owner").catalog).toBe(catalogB);
  });
});
