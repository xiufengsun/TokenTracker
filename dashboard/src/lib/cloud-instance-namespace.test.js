import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readCloudPurchase, saveCloudPurchase } from "./cloud-checkout.js";
import { cloudContextualPromptDecision, dismissCloudPrompt, publishCloudPromptBilling, readCloudPromptState } from "./cloud-prompt-policy.js";
const key = `${btoa('{"alg":"HS256"}').replace(/=+$/, "")}.${btoa('{"role":"anon"}').replace(/=+$/, "")}.signature`;
const owner = "same-owner";
const now = Date.parse("2026-10-08T08:00:00Z");
const membership = { status: "free", environment: "live", phase: "active", can_read_cloud: false, can_upload_cloud: false };
const catalog = { environment: "live", policy: { phase: "active", launch_at: "2020-01-01" }, providers: { waffo: true }, checkout_verified: true };
beforeEach(() => { localStorage.clear(); window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://instance-a.example", anonKey: key }; });
afterEach(() => { delete window.__TOKENTRACKER_RUNTIME_CONFIG__; vi.restoreAllMocks(); });
it("keeps unresolved purchases separate even when both instances use the same account id", () => {
  saveCloudPurchase(owner, { order_id: "order-a", request_id: "request-a" });
  window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://instance-b.example", anonKey: key };
  expect(readCloudPurchase(owner)).toBeNull();
  saveCloudPurchase(owner, { order_id: "order-b", request_id: "request-b" });
  window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://instance-a.example", anonKey: key };
  expect(readCloudPurchase(owner).order_id).toBe("order-a");
});
it("does not borrow membership, catalog or dismissed promotion from another instance", () => {
  publishCloudPromptBilling("catalog", catalog, null, now);
  publishCloudPromptBilling("account", { membership }, owner, now);
  dismissCloudPrompt(owner, "sync", now);
  window.__TOKENTRACKER_RUNTIME_CONFIG__ = { baseUrl: "https://instance-b.example", anonKey: key };
  expect(readCloudPromptState(owner).membership).toBeUndefined();
  expect(readCloudPromptState(owner).catalog).toBeUndefined();
  expect(cloudContextualPromptDecision({ userId: owner, scene: "sync", intentional: true, membership, catalog,
    catalogObservedAt: now, now }).kind).toBe("promotion");
});
