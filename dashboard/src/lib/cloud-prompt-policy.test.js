import { beforeEach, describe, expect, it, vi } from "vitest";

let policy;
let sequence = 0;
const now = Date.parse("2026-10-08T08:00:00Z");
const day = 86_400_000;
const catalog = { environment: "live", policy: { phase: "active", launch_at: "2026-10-01T00:00:00Z" },
  providers: { waffo: true }, checkout_verified: true };
const free = { status: "free", environment: "live", phase: "active", trial_available: true,
  can_read_cloud: false, can_upload_cloud: false };
function storage() {
  const values = new Map();
  return { getItem: vi.fn((key) => values.get(key) || null),
    setItem: vi.fn((key, value) => values.set(key, value)), removeItem: vi.fn((key) => values.delete(key)) };
}
function input(extra = {}) {
  return { userId: `policy-account-${++sequence}`, intentional: true, scene: "sync", membership: free,
    catalog, catalogObservedAt: now, now, storage: storage(), ...extra };
}
beforeEach(async () => {
  vi.resetModules();
  policy = await import("./cloud-prompt-policy.js");
});

describe("Cloud reminder eligibility", () => {
  it("never sells on startup, local use, public ranking, or an unknown account", () => {
    for (const extra of [{ intentional: false }, { scene: "leaderboard" }, { scene: "local" }, { userId: null }])
      expect(policy.cloudContextualPromptDecision(input(extra))).toBeNull();
  });
  it("offers the no-card trial only after a deliberate sync action and confirmed live availability", () => {
    expect(policy.cloudContextualPromptDecision(input())).toMatchObject({
      kind: "promotion", scene: "sync", href: "/billing/checkout?intent=trial",
    });
    expect(policy.cloudContextualPromptDecision(input({ membership: { ...free, trial_available: false } })))
      .toMatchObject({ kind: "promotion", href: "/cloud", ctaKey: "cloud.action.view_plans" });
  });
  it.each([
    { environment: "sandbox" }, { policy: { phase: "preview", launch_at: "2026-10-01" } },
    { policy: { phase: "active", launch_at: "2026-10-09" } }, { providers: { waffo: false } },
    { checkout_verified: false }, { checkout_verified: undefined },
  ])("does not promise a purchase or trial from unavailable configuration %j", (change) => {
    expect(policy.cloudContextualPromptDecision(input({ catalog: { ...catalog, ...change } })))
      .toMatchObject({ kind: "explanation", href: "/cloud", ctaKey: "cloud.prompt.learn" });
  });
  it("does not reuse a stale, future-dated, or different-environment availability snapshot", () => {
    for (const extra of [{ catalogObservedAt: now - 10 * 60_000 - 1 }, { catalogObservedAt: now + 1 },
      { membership: { ...free, environment: "sandbox" } }])
      expect(policy.cloudContextualPromptDecision(input(extra)).kind).toBe("explanation");
  });
  it("waits for an actual cloud limit when a user explores history or devices", () => {
    expect(policy.cloudContextualPromptDecision(input({ scene: "history" }))).toBeNull();
    expect(policy.cloudContextualPromptDecision(input({ scene: "view", failure: { code: "cloud_membership_required" } })))
      .toMatchObject({ kind: "promotion", scene: "view" });
  });
  it("never sells to an active paid user or an account with a payment conflict", () => {
    expect(policy.cloudContextualPromptDecision(input({ membership: { ...free, status: "active" } }))).toBeNull();
    expect(policy.cloudContextualPromptDecision(input({ paymentConflict: true }))).toBeNull();
  });
  it.each(["active", "trialing", "past_due", "paused"])("routes unavailable personal Cloud with a %s renewal contract to billing instead of a new purchase", (status) => {
    const value = input({ membership: { ...free, status: "expired", expires_at: new Date(now + 30 * day).toISOString() },
      subscriptions: [{ status, cancel_at_period_end: false }] });
    expect(policy.cloudContextualPromptDecision(value)).toMatchObject({ kind: "operation",
      bodyKey: "cloud.prompt.billing_recovery", ctaKey: "cloud.action.view_bills", href: "/settings?section=cloud" });
    expect(policy.cloudContextualPromptDecision({ ...value, scene: "view", failure: { code: "cloud_membership_required" } }))
      .toMatchObject({ kind: "operation", href: "/settings?section=cloud" });
  });
  it.each([{ status: "canceled" }, { status: "expired" }, { status: "active", cancel_at_period_end: true }])("keeps plan discovery available after the renewal contract ends or is canceled %j", (subscription) => {
    expect(policy.cloudContextualPromptDecision(input({ membership: { ...free, status: "expired", trial_available: false },
      subscriptions: [subscription] }))).toMatchObject({ kind: "promotion", ctaKey: "cloud.action.view_plans", href: "/cloud" });
  });
  it("never shows a paid-service reminder on an explicitly free self-hosted instance", () => {
    expect(policy.cloudContextualPromptDecision(input({ membership: { ...free, status: "self_hosted" }, failure: { code: "cloud_machine_limit" } }))).toBeNull();
    expect(policy.cloudContextualPromptDecision(input({ catalog: { ...catalog, policy: { ...catalog.policy, hosting_mode: "self_hosted" } } }))).toBeNull();
  });
  it.each(["active", "trial", "transition"])("offers device/history management instead of an upgrade while %s access is available", (status) => {
    const membership = { ...free, status, can_read_cloud: true, can_upload_cloud: true };
    expect(policy.cloudContextualPromptDecision(input({ membership, scene: "view", failure: { code: "cloud_machine_limit" } })))
      .toMatchObject({ kind: "operation", scene: "devices", href: "/settings?section=cloud" });
    expect(policy.cloudContextualPromptDecision(input({ membership, scene: "history", failure: { code: "cloud_history_window_exceeded" } })))
      .toMatchObject({ kind: "operation", bodyKey: "cloud.prompt.history_window" });
  });
});

describe("seven-day reminder dismissal", () => {
  it("cools every promotional scene for seven days and isolates accounts", () => {
    const value = input();
    policy.dismissCloudPrompt(value.userId, "sync", now, value.storage);
    const otherScene = { ...value, scene: "view", failure: { code: "cloud_membership_required" } };
    expect(policy.cloudContextualPromptDecision({ ...otherScene, now: now + 7 * day - 1, catalogObservedAt: now + 7 * day - 1 })).toBeNull();
    expect(policy.cloudContextualPromptDecision({ ...otherScene, now: now + 7 * day, catalogObservedAt: now + 7 * day }).kind).toBe("promotion");
    expect(policy.cloudContextualPromptDecision({ ...value, userId: "another-account" }).kind).toBe("promotion");
  });
  it("restores a persisted dismissal after a page module reload", async () => {
    const value = input();
    policy.dismissCloudPrompt(value.userId, "sync", now, value.storage);
    vi.resetModules();
    policy = await import("./cloud-prompt-policy.js");
    expect(policy.cloudContextualPromptDecision(value)).toBeNull();
  });
  it.each(["getItem", "setItem"])("fails closed for sales when storage %s fails and remembers dismissal in memory", (method) => {
    const value = input();
    value.storage[method].mockImplementation(() => { throw new Error("storage disabled"); });
    expect(policy.cloudContextualPromptDecision(value).kind).toBe("explanation");
    policy.dismissCloudPrompt(value.userId, "sync", now, value.storage);
    expect(policy.cloudContextualPromptDecision(value)).toBeNull();
  });
  it("treats corrupt storage as unavailable rather than repeatedly offering a trial", () => {
    const value = input();
    value.storage.getItem.mockReturnValue("not-json");
    expect(policy.cloudContextualPromptDecision(value).kind).toBe("explanation");
  });
});

describe("account date reminders", () => {
  it("uses a gift-specific reminder in the last seven days and honors its cooldown", () => {
    const value = input({ membership: { ...free, status: "active", access_source: "gift",
      expires_at: new Date(now + 7 * day).toISOString(), can_read_cloud: true, can_upload_cloud: true } });
    expect(policy.cloudDeadlinePromptDecision(value)).toMatchObject({ kind: "deadline", scene: "deadline_gift",
      bodyKey: "cloud.prompt.deadline_gift", date: value.membership.expires_at });
    expect(policy.cloudDeadlinePromptDecision({ ...value, now: now - 1 })).toBeNull();
    policy.dismissCloudPrompt(value.userId, "deadline_gift", now, value.storage);
    expect(policy.cloudDeadlinePromptDecision(value)).toBeNull();
    expect(policy.cloudDeadlinePromptDecision({ ...value, now: now + 7 * day })).toBeNull();
  });
  it("never promotes another payment to gifted Pro and leaves an ongoing recurring contract alone", () => {
    const value = input({ membership: { ...free, status: "active", access_source: "gift",
      expires_at: new Date(now + day).toISOString(), can_read_cloud: true, can_upload_cloud: true } });
    expect(policy.cloudContextualPromptDecision(value)).toBeNull();
    expect(policy.cloudDeadlinePromptDecision({ ...value, subscriptions: [{ status: "active", cancel_at_period_end: false }] })).toBeNull();
    expect(policy.cloudDeadlinePromptDecision({ ...value, membership: { ...value.membership, access_source: "mixed" } }))
      .toMatchObject({ bodyKey: "cloud.prompt.deadline_active" });
  });
  it.each([["trial", "trial_ends_at", 2], ["transition", "transition_ends_at", 7], ["active", "expires_at", 7]])("shows %s only inside its reminder window and never after expiry", (status, field, days) => {
      const value = input({ membership: { ...free, status, [field]: new Date(now + days * day).toISOString() } });
      expect(policy.cloudDeadlinePromptDecision(value)).toMatchObject({ kind: "deadline", scene: `deadline_${status}` });
      expect(policy.cloudDeadlinePromptDecision({ ...value, now: now - 1 })).toBeNull();
      expect(policy.cloudDeadlinePromptDecision({ ...value, now: now + days * day })).toBeNull();
    });
  it("leaves automatic renewals alone and preserves a canceled user's paid end date", () => {
    const value = input({ membership: { ...free, status: "active", expires_at: new Date(now + day).toISOString() },
      subscriptions: [{ status: "active", cancel_at_period_end: false }] });
    expect(policy.cloudDeadlinePromptDecision(value)).toBeNull();
    expect(policy.cloudDeadlinePromptDecision({ ...value, subscriptions: [{ status: "active", cancel_at_period_end: true }] }))
      .toMatchObject({ kind: "deadline", date: value.membership.expires_at });
  });
  it("keeps the verified paid-term date visible when renewal is past due", () => {
    const end = new Date(now + day).toISOString();
    const value = input({ membership: { ...free, status: "active", expires_at: end },
      subscriptions: [{ status: "past_due", cancel_at_period_end: false }] });
    expect(policy.cloudDeadlinePromptDecision(value)).toMatchObject({ kind: "deadline",
      bodyKey: "cloud.prompt.deadline_active", date: end });
  });
  it("does not invent an end date or show automatic date nudges with broken storage", () => {
    const value = input({ membership: { ...free, status: "trial", trial_ends_at: "invalid" } });
    expect(policy.cloudDeadlinePromptDecision(value)).toBeNull();
    value.membership.trial_ends_at = new Date(now + day).toISOString();
    value.storage.setItem.mockImplementation(() => { throw new Error("full"); });
    expect(policy.cloudDeadlinePromptDecision(value)).toBeNull();
  });
});

describe("passive response and intent reuse", () => {
  it("observes existing data without inventing user intent or mixing owners", () => {
    const listener = vi.fn();
    const unsubscribe = policy.subscribeCloudPrompts(listener);
    policy.publishCloudPromptBilling("catalog", catalog, null, now);
    policy.publishCloudPromptBilling("account", { membership: free }, "owner-one", now);
    expect(policy.readCloudPromptState("owner-one").intent).toBeUndefined();
    policy.recordCloudPromptIntent("owner-one", "history");
    policy.recordCloudPromptFailure("owner-one", "cloud_membership_required", free, "account-hourly");
    expect(policy.readCloudPromptState("owner-one").failure.code).toBe("cloud_membership_required");
    expect(policy.readCloudPromptState("owner-two").membership).toBeUndefined();
    policy.clearCloudPromptFailure("owner-one", "account-summary");
    expect(policy.readCloudPromptState("owner-one").failure).toBeTruthy();
    policy.clearCloudPromptFailure("owner-one", "account-hourly");
    expect(policy.readCloudPromptState("owner-one").failure).toBeNull();
    policy.recordCloudPromptIntent("owner-two", "leaderboard");
    expect(policy.readCloudPromptState("owner-two").intent).toBeUndefined();
    unsubscribe();
    expect(listener).toHaveBeenCalled();
  });
});
