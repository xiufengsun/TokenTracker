import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDashboardPreloadContextKey,
  getUsageLimitsPreloadContextKey,
  getDashboardPreloadSnapshot,
  preloadDashboardPageResource,
  publishLeaderboardPreloadState,
  publishReusablePageState,
  publishUsageLimitsPreloadState,
  readLeaderboardPreloadState,
  readReusablePageState,
  readUsageLimitsPreloadState,
  resetDashboardPreload,
} from "./dashboard-preload.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("dashboard preload state", () => {
  beforeEach(() => {
    resetDashboardPreload();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("initializes fixed targets with idle resource and window-session cache status", () => {
    expect(getDashboardPreloadSnapshot()).toMatchObject({
      cache: {
        limits: null,
        leaderboard: {
          maxEntries: 20,
          size: 0,
        },
      },
      targets: {
        limits: { resourceStatus: "idle", stateStatus: "idle", error: null },
        leaderboard: { resourceStatus: "idle", stateStatus: "idle", error: null },
      },
    });
  });

  it("publishes reusable state only for a matching context key", () => {
    const contextKey = buildDashboardPreloadContextKey("limits", {
      baseUrl: "http://localhost:7680",
      mode: "local",
    });
    const data = { usage: { daily: 10 } };

    publishUsageLimitsPreloadState(data, { contextKey, source: "dashboard-existing" });

    expect(readUsageLimitsPreloadState(contextKey)).toMatchObject({
      targetKey: "limits",
      status: "fulfilled",
      data,
      error: null,
      source: "dashboard-existing",
      contextKey,
    });
    expect(readUsageLimitsPreloadState(`${contextKey}|stale`)).toBeNull();
  });

  it("reuses other providers without retaining the private gateway name or history", () => {
    const data = {
      codex: { configured: true },
      customCredits: { configured: true, plan_label: "Private", daily_history: [{ date: "2024-02-01", used_credits: 30 }] },
    };
    publishUsageLimitsPreloadState(data);
    expect(readUsageLimitsPreloadState().data).toEqual({ codex: data.codex, customCredits: { configured: false } });
    expect(data.customCredits.daily_history).toHaveLength(1);
  });

  it("reads fulfilled usage limits cache repeatedly without consuming it", () => {
    const data = { usage: { daily: 10 } };

    publishUsageLimitsPreloadState(data, { source: "dashboard-existing" });

    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
      source: "dashboard-existing",
    });
    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
      source: "dashboard-existing",
    });
  });

  it("uses the default limits context when publishing and reading usage limits state", () => {
    const data = { usage: { daily: 12 } };

    publishUsageLimitsPreloadState(data);

    expect(getUsageLimitsPreloadContextKey()).toBe(
      buildDashboardPreloadContextKey("limits", { state: "current" }),
    );
    expect(readUsageLimitsPreloadState()).toMatchObject({
      targetKey: "limits",
      status: "fulfilled",
      data,
      source: "dashboard-existing",
      contextKey: getUsageLimitsPreloadContextKey(),
    });
  });

  it("keeps fulfilled window-session cache readable without a freshness TTL", () => {
    const data = { usage: { daily: 12 } };

    publishUsageLimitsPreloadState(data, {
      generatedAt: Date.now() - 24 * 60 * 60 * 1000,
    });

    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
    });
  });

  it("supports all window-session cache write sources for fulfilled state", () => {
    for (const source of ["dashboard-existing", "silent-preload", "page-load", "manual-refresh"]) {
      const data = { source };

      publishUsageLimitsPreloadState(data, { source });

      expect(readUsageLimitsPreloadState()).toMatchObject({
        status: "fulfilled",
        data,
        source,
      });
    }
  });

  it("does not let rejected usage limits results overwrite an existing fulfilled cache", () => {
    const data = { usage: { daily: 12 } };

    publishUsageLimitsPreloadState(data, { source: "page-load" });
    publishUsageLimitsPreloadState(null, {
      status: "rejected",
      source: "manual-refresh",
      error: "network down",
    });

    expect(getDashboardPreloadSnapshot().targets.limits).toMatchObject({
      stateStatus: "rejected",
      error: "network down",
    });
    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
      source: "page-load",
    });
  });

  it("clears window-session cache on reset", () => {
    const firstSessionId = getDashboardPreloadSnapshot().sessionId;
    publishUsageLimitsPreloadState({ usage: { daily: 12 } });

    resetDashboardPreload();

    expect(getDashboardPreloadSnapshot().sessionId).not.toBe(firstSessionId);
    expect(readUsageLimitsPreloadState()).toBeNull();
  });

  it("keeps preloaded leaderboard state readable inside the same window session", () => {
    const data = { rows: [{ user_id: "user-1", total_tokens: 100 }] };
    const contextKey = buildDashboardPreloadContextKey("leaderboard", {
      offset: 0,
      pageSize: 20,
      period: "total",
      userId: "user-1",
    });

    publishLeaderboardPreloadState(data, {
      contextKey,
      generatedAt: Date.now() - 30_000,
    });

    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({
      status: "fulfilled",
      data,
    });
  });

  it("keeps leaderboard state scoped by context key", () => {
    const contextKey = buildDashboardPreloadContextKey("leaderboard", {
      offset: 0,
      pageSize: 50,
      period: "week",
      userId: "user-1",
    });
    const data = { rows: [{ user_id: "user-1", total_tokens: 100 }] };

    publishLeaderboardPreloadState(data, { contextKey, source: "silent-preload" });

    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({
      targetKey: "leaderboard",
      status: "fulfilled",
      data,
      source: "silent-preload",
      contextKey,
    });
    expect(
      readLeaderboardPreloadState(
        buildDashboardPreloadContextKey("leaderboard", {
          offset: 50,
          pageSize: 50,
          period: "week",
          userId: "user-1",
        }),
      ),
    ).toBeNull();
  });

  it("uses state.context when publishing generic reusable page state", () => {
    const context = {
      offset: 0,
      pageSize: 50,
      period: "week",
      userId: "user-1",
    };
    const contextKey = buildDashboardPreloadContextKey("leaderboard", context);
    const data = { rows: [{ user_id: "user-1", total_tokens: 100 }] };

    publishReusablePageState("leaderboard", { data, context });

    expect(readReusablePageState("leaderboard", contextKey)).toMatchObject({
      status: "fulfilled",
      data,
      contextKey,
    });
    expect(readReusablePageState("leaderboard", buildDashboardPreloadContextKey("leaderboard"))).toBeNull();
  });

  it("reuses pending and fulfilled resource preloads for duplicate calls", async () => {
    const pending = deferred();
    const loader = vi.fn(() => pending.promise);

    const first = preloadDashboardPageResource("limits", { loader });
    const second = preloadDashboardPageResource("limits", { loader });

    expect(first).toBe(second);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getDashboardPreloadSnapshot().targets.limits.resourceStatus).toBe("pending");

    pending.resolve({ LimitsPage: () => null });
    await expect(first).resolves.toEqual({ LimitsPage: expect.any(Function) });

    const fulfilled = preloadDashboardPageResource("limits", { loader });
    await expect(fulfilled).resolves.toEqual({ LimitsPage: expect.any(Function) });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(getDashboardPreloadSnapshot().targets.limits.resourceStatus).toBe("fulfilled");
  });

  it("records resource failures internally without throwing to callers", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("chunk unavailable")));

    await expect(preloadDashboardPageResource("leaderboard", { loader })).resolves.toBeNull();

    expect(getDashboardPreloadSnapshot().targets.leaderboard).toMatchObject({
      resourceStatus: "rejected",
      error: "chunk unavailable",
    });
  });

  it("does not let skipped state overwrite existing fulfilled page data cache", () => {
    const contextKey = buildDashboardPreloadContextKey("leaderboard", {
      offset: 0,
      pageSize: 20,
      period: "total",
    });
    const data = { rows: [{ user_id: "user-1", total_tokens: 100 }] };

    publishLeaderboardPreloadState(data, { contextKey });
    publishLeaderboardPreloadState(null, {
      contextKey,
      status: "skipped",
      error: "auth-loading",
    });

    expect(getDashboardPreloadSnapshot().targets.leaderboard).toMatchObject({
      stateStatus: "skipped",
      error: "auth-loading",
    });
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({
      status: "fulfilled",
      data,
    });
  });

  it("keeps page data cache separate when resource preload fails", async () => {
    const data = { usage: { daily: 12 } };
    const loader = vi.fn(() => Promise.reject(new Error("chunk unavailable")));

    publishUsageLimitsPreloadState(data);
    await expect(preloadDashboardPageResource("limits", { loader })).resolves.toBeNull();

    expect(getDashboardPreloadSnapshot().targets.limits).toMatchObject({
      resourceStatus: "rejected",
      stateStatus: "fulfilled",
      error: "chunk unavailable",
    });
    expect(readUsageLimitsPreloadState()).toMatchObject({
      status: "fulfilled",
      data,
    });
  });

  it("clears stale target errors when window-session cache becomes fulfilled", () => {
    const contextKey = buildDashboardPreloadContextKey("leaderboard", {
      offset: 0,
      pageSize: 50,
      period: "week",
    });

    publishLeaderboardPreloadState(null, {
      contextKey,
      status: "rejected",
      error: "network down",
    });
    expect(getDashboardPreloadSnapshot().targets.leaderboard.error).toBe("network down");

    publishLeaderboardPreloadState({ rows: [] }, { contextKey });

    expect(getDashboardPreloadSnapshot().targets.leaderboard).toMatchObject({
      stateStatus: "fulfilled",
      error: null,
    });
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({
      status: "fulfilled",
      data: { rows: [] },
      error: null,
    });
  });

  it("does not persist page data cache to browser storage, IndexedDB, or a server", () => {
    const localStorageSetItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchSpy = vi.fn();
    const indexedDB = {
      open: vi.fn(),
      deleteDatabase: vi.fn(),
    };
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("indexedDB", indexedDB);

    publishUsageLimitsPreloadState({ usage: { daily: 12 } });
    publishLeaderboardPreloadState(
      { rows: [{ user_id: "user-1", total_tokens: 100 }] },
      {
        contextKey: buildDashboardPreloadContextKey("leaderboard", {
          offset: 0,
          pageSize: 20,
          period: "total",
        }),
      },
    );

    expect(readUsageLimitsPreloadState()).toMatchObject({ status: "fulfilled" });
    expect(localStorageSetItem).not.toHaveBeenCalled();
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(indexedDB.deleteDatabase).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("dashboard preload route boundary", () => {
  it("keeps NativeAuthCallbackPage eager-imported while target pages stay lazy-loaded", () => {
    const appSource = readFileSync(join(process.cwd(), "src/App.jsx"), "utf8");

    expect(appSource).toContain('import { NativeAuthCallbackPage } from "./pages/NativeAuthCallbackPage.jsx";');
    expect(appSource).not.toMatch(/const\s+NativeAuthCallbackPage\s*=\s*lazy\(/);
    expect(appSource).toContain('import("./pages/LimitsPage.jsx")');
    expect(appSource).toContain('import("./pages/LeaderboardPage.jsx")');
  });
});
