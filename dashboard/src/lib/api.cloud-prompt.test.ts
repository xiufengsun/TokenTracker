import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchCloudUsageDaily, invalidateAccountResponseCache } from "./api";
import { cloudPromptOwnerFromToken, readCloudPromptState, recordCloudPromptIntent } from "./cloud-prompt-policy.js";

vi.mock("./insforge-config", () => ({ getInsforgeRemoteUrl: () => "https://backend.test", getInsforgeAnonKey: () => "anon" }));
let counter = 0;
beforeEach(() => invalidateAccountResponseCache());
afterEach(() => vi.unstubAllGlobals());
it("reuses the existing denied response for an owned contextual reason without another request", async () => {
  const owner = `api-prompt-${++counter}`;
  const token = `${btoa(JSON.stringify({ alg: "HS256" })).replace(/=+$/, "")}.${btoa(JSON.stringify({ sub: owner })).replace(/=+$/, "")}.signature`;
  const membership = { status: "free", environment: "live", phase: "active", can_read_cloud: false };
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, code: "cloud_membership_required", membership }), { status: 402 }));
  vi.stubGlobal("fetch", request);
  recordCloudPromptIntent(owner, "history");
  await expect(fetchCloudUsageDaily({ accessToken: token, from: "2026-09-01", to: "2026-09-30" }))
    .rejects.toMatchObject({ code: "cloud_membership_required", status: 402 });
  expect(request).toHaveBeenCalledTimes(1);
  expect(readCloudPromptState(owner).failure?.code).toBe("cloud_membership_required");
  expect(readCloudPromptState("another-owner").membership).toBeUndefined();
  expect(cloudPromptOwnerFromToken(token)).toBe(owner);
});
