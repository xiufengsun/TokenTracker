import { getLeaderboard } from "./api";

export const DASHBOARD_PRELOAD_TARGETS = Object.freeze(["limits", "leaderboard"]);

export const DASHBOARD_PRELOAD_STATUSES = Object.freeze([
  "idle",
  "pending",
  "fulfilled",
  "rejected",
  "skipped",
]);

const TARGET_ROUTES = Object.freeze({
  limits: "/limits",
  leaderboard: "/leaderboard",
});

const DEFAULT_RESOURCE_LOADERS = Object.freeze({
  limits: () => import("../pages/LimitsPage.jsx"),
  leaderboard: () => import("../pages/LeaderboardPage.jsx"),
});

const LEADERBOARD_DEFAULT_PERIOD = "total";
const LEADERBOARD_DEFAULT_OFFSET = 0;
const LEADERBOARD_DEFAULT_PAGE_SIZE = 20;
const LEADERBOARD_PAGE_SIZE_OPTIONS = Object.freeze([10, 20, 50, 100]);
const LEADERBOARD_PAGE_SIZE_STORAGE_KEY = "tokentracker:leaderboard:pageSize";
const LEADERBOARD_DEFAULT_MAX_ENTRIES = 20;
const PAGE_STATE_SOURCES = Object.freeze([
  "dashboard-existing",
  "silent-preload",
  "page-load",
  "manual-refresh",
]);
let sessionCounter = 0;
let session;

class WindowSessionCache {
  constructor(options = {}) {
    this.limits = null;
    this.leaderboard = new Map();
    this.leaderboardMaxEntries = normalizeLeaderboardMaxEntries(options.leaderboardMaxEntries);
  }

  read(targetKey, contextKey) {
    assertTargetKey(targetKey);
    if (targetKey === "limits") {
      if (!this.limits || this.limits.contextKey !== contextKey) return null;
      return cloneCacheEntry(this.limits);
    }
    if (!contextKey) return null;
    return cloneCacheEntry(this.leaderboard.get(contextKey));
  }

  write(entry, options = {}) {
    if (entry.targetKey === "limits") {
      this.limits = entry;
      return;
    }
    if (this.leaderboard.has(entry.contextKey)) {
      this.leaderboard.delete(entry.contextKey);
    }
    this.leaderboard.set(entry.contextKey, entry);
    this.evictLeaderboardEntries(options.activeContextKey || entry.contextKey);
  }

  evictLeaderboardEntries(activeContextKey = null) {
    while (this.leaderboard.size > this.leaderboardMaxEntries) {
      const evictionKey =
        Array.from(this.leaderboard.keys()).find((key) => key !== activeContextKey) ||
        this.leaderboard.keys().next().value;
      this.leaderboard.delete(evictionKey);
    }
  }

  snapshot() {
    return {
      limits: cloneCacheEntry(this.limits),
      leaderboard: {
        maxEntries: this.leaderboardMaxEntries,
        size: this.leaderboard.size,
        keys: Array.from(this.leaderboard.keys()),
      },
    };
  }
}

class DashboardWindowSession {
  constructor(options = {}) {
    sessionCounter += 1;
    this.sessionId = `dashboard-preload-${sessionCounter}`;
    this.createdAt = Date.now();
    this.completedAt = null;
    this.startedAfterMainContentVisible = false;
    this.cache = new WindowSessionCache(options);
    this.targets = {
      limits: createTarget("limits"),
      leaderboard: createTarget("leaderboard"),
    };
  }
}

function createTarget(key) {
  return {
    key,
    route: TARGET_ROUTES[key],
    resourceStatus: "idle",
    stateStatus: "idle",
    error: null,
    resourcePromise: null,
    resourceModule: null,
    resourceRequestId: 0,
    statePromise: null,
    stateRequestId: 0,
    pendingStateContextKey: null,
  };
}

function createSession(options = {}) {
  return new DashboardWindowSession(options);
}

function normalizeLeaderboardMaxEntries(value) {
  const maxEntries = Number(value);
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    return LEADERBOARD_DEFAULT_MAX_ENTRIES;
  }
  return maxEntries;
}

session = createSession();

function assertTargetKey(targetKey) {
  if (!DASHBOARD_PRELOAD_TARGETS.includes(targetKey)) {
    throw new Error(`Unknown dashboard preload target: ${targetKey}`);
  }
}

function normalizeError(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  return error.message || String(error);
}

function normalizePageStateSource(source, fallback) {
  if (PAGE_STATE_SOURCES.includes(source)) return source;
  return fallback;
}

function normalizeGeneratedAt(value) {
  const generatedAt = Number(value);
  if (Number.isFinite(generatedAt)) return generatedAt;
  return Date.now();
}

function cloneCacheEntry(entry) {
  if (!entry) return null;
  return { ...entry };
}

function targetSnapshot(target) {
  return {
    key: target.key,
    route: target.route,
    resourceStatus: target.resourceStatus,
    stateStatus: target.stateStatus,
    error: target.error,
  };
}

function updateCompletedAt() {
  const settled = DASHBOARD_PRELOAD_TARGETS.every((key) => {
    const target = session.targets[key];
    return (
      target.resourceStatus === "fulfilled" ||
      target.resourceStatus === "rejected"
    );
  });
  session.completedAt = settled ? Date.now() : null;
}

export function resetDashboardPreload(options = {}) {
  session = createSession(options);
}

export function markDashboardMainContentVisible() {
  session.startedAfterMainContentVisible = true;
}

export function getDashboardPreloadSnapshot() {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    completedAt: session.completedAt,
    startedAfterMainContentVisible: session.startedAfterMainContentVisible,
    cache: session.cache.snapshot(),
    targets: {
      limits: targetSnapshot(session.targets.limits),
      leaderboard: targetSnapshot(session.targets.leaderboard),
    },
  };
}

export function buildDashboardPreloadContextKey(targetKey, context = {}) {
  assertTargetKey(targetKey);
  const entries = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value === null ? "null" : String(value)}`);
  return `${targetKey}:${entries.join("|")}`;
}

export function preloadDashboardPageResource(targetKey, options = {}) {
  assertTargetKey(targetKey);
  const target = session.targets[targetKey];
  if (target.resourceStatus === "fulfilled") {
    return Promise.resolve(target.resourceModule);
  }
  if (target.resourceStatus === "pending" && target.resourcePromise) {
    return target.resourcePromise;
  }

  const loader = options.loader || DEFAULT_RESOURCE_LOADERS[targetKey];
  const requestId = target.resourceRequestId + 1;
  target.resourceRequestId = requestId;
  target.resourceStatus = "pending";
  target.error = null;
  const promise = Promise.resolve()
    .then(() => loader())
    .then((module) => {
      if (target.resourceRequestId !== requestId || target.resourcePromise !== promise) {
        return null;
      }
      target.resourceStatus = "fulfilled";
      target.resourceModule = module;
      target.error = null;
      updateCompletedAt();
      return module;
    })
    .catch((error) => {
      if (target.resourceRequestId !== requestId || target.resourcePromise !== promise) {
        return null;
      }
      target.resourceStatus = "rejected";
      target.error = normalizeError(error);
      updateCompletedAt();
      return null;
    });

  target.resourcePromise = promise;
  return promise;
}

export function preloadDashboardPageResources(options = {}) {
  const loaders = options.loaders || {};
  return Promise.all(
    DASHBOARD_PRELOAD_TARGETS.map((targetKey) =>
      preloadDashboardPageResource(targetKey, { loader: loaders[targetKey] }),
    ),
  );
}

export function publishReusablePageState(targetKey, state) {
  assertTargetKey(targetKey);
  const target = session.targets[targetKey];
  const status = state?.status || "fulfilled";
  const cacheEntry = {
    targetKey,
    status,
    data: state?.data ?? null,
    error: normalizeError(state?.error),
    source: normalizePageStateSource(state?.source, "silent-preload"),
    generatedAt: normalizeGeneratedAt(state?.generatedAt),
    updatedAt: Date.now(),
    contextKey: state?.contextKey || buildDashboardPreloadContextKey(targetKey, state?.context || {}),
  };

  target.stateStatus = status;
  if (status === "rejected") {
    target.error = cacheEntry.error;
  } else if (status === "skipped") {
    target.error = cacheEntry.error;
  } else if (status === "fulfilled") {
    target.error = null;
    session.cache.write(cacheEntry, { activeContextKey: state?.activeContextKey });
  }
  return cloneCacheEntry(cacheEntry);
}

export function readReusablePageState(targetKey, contextKey) {
  assertTargetKey(targetKey);
  return session.cache.read(targetKey, contextKey);
}

export function publishUsageLimitsPreloadState(data, options = {}) {
  // The active gateway account can change in another CLI or desktop process.
  // Reuse other rows immediately; the local limits read refreshes this row.
  const reusable = data?.customCredits ? { ...data, customCredits: { configured: false } } : data;
  return publishReusablePageState("limits", {
    data: reusable,
    source: options.source || "dashboard-existing",
    contextKey: options.contextKey || getUsageLimitsPreloadContextKey(options.context || {}),
    generatedAt: options.generatedAt,
    status: options.status || "fulfilled",
    error: options.error,
  });
}

export function getUsageLimitsPreloadContextKey(context = {}) {
  return buildDashboardPreloadContextKey("limits", { state: "current", ...context });
}

export function readUsageLimitsPreloadState(contextKey = getUsageLimitsPreloadContextKey()) {
  return readReusablePageState("limits", contextKey);
}

export function publishLeaderboardPreloadState(data, options = {}) {
  return publishReusablePageState("leaderboard", {
    activeContextKey: options.activeContextKey,
    data,
    source: options.source || "silent-preload",
    contextKey: options.contextKey || getLeaderboardPreloadContextKey(options.context || {}),
    generatedAt: options.generatedAt,
    status: options.status || "fulfilled",
    error: options.error,
  });
}

export function readLeaderboardPreloadState(contextKey) {
  return readReusablePageState("leaderboard", contextKey);
}

export function getLeaderboardPreloadPageSize() {
  if (typeof window === "undefined") return LEADERBOARD_DEFAULT_PAGE_SIZE;
  try {
    const raw = window.localStorage.getItem(LEADERBOARD_PAGE_SIZE_STORAGE_KEY);
    const pageSize = Number(raw);
    if (LEADERBOARD_PAGE_SIZE_OPTIONS.includes(pageSize)) return pageSize;
  } catch {
    // Ignore storage errors and keep the page's default page size.
  }
  return LEADERBOARD_DEFAULT_PAGE_SIZE;
}

function getLeaderboardPreloadUserId(options = {}) {
  const explicitUserId = options.userId;
  if (explicitUserId !== undefined) return explicitUserId || null;
  return options.cloudUser?.id || null;
}

function getLeaderboardPreloadAccessMode(options = {}) {
  if (typeof options.accessMode === "string" && options.accessMode.trim()) {
    return options.accessMode.trim();
  }
  if (options.mockEnabled) return "mock";
  if (options.baseUrl) return "cloud";
  return "unavailable";
}

export function getLeaderboardPreloadContextKey(options = {}) {
  const mockEnabled = Boolean(options.mockEnabled);
  const baseUrl = options.baseUrl ?? "";
  return buildDashboardPreloadContextKey("leaderboard", {
    accessMode: getLeaderboardPreloadAccessMode({ ...options, baseUrl, mockEnabled }),
    baseUrl,
    mockEnabled,
    offset: options.offset ?? LEADERBOARD_DEFAULT_OFFSET,
    pageSize: options.pageSize ?? getLeaderboardPreloadPageSize(),
    period: options.period || LEADERBOARD_DEFAULT_PERIOD,
    userId: getLeaderboardPreloadUserId(options),
  });
}

function publishSkippedLeaderboardState(reason, contextKey) {
  const target = session.targets.leaderboard;
  target.stateRequestId += 1;
  target.statePromise = null;
  target.pendingStateContextKey = null;
  return publishLeaderboardPreloadState(null, {
    contextKey,
    status: "skipped",
    error: reason,
  });
}

export function preloadLeaderboardDefaultState(options = {}) {
  const sessionAtStart = session;
  const mockEnabled = Boolean(options.mockEnabled);
  const baseUrl = options.baseUrl ?? "";
  const accessMode = getLeaderboardPreloadAccessMode({ ...options, baseUrl, mockEnabled });
  const period = options.period || LEADERBOARD_DEFAULT_PERIOD;
  const pageSize = options.pageSize ?? getLeaderboardPreloadPageSize();
  const offset = options.offset ?? LEADERBOARD_DEFAULT_OFFSET;
  const userId = getLeaderboardPreloadUserId(options);
  const contextKey = getLeaderboardPreloadContextKey({
    accessMode,
    baseUrl,
    mockEnabled,
    offset,
    pageSize,
    period,
    userId,
  });

  if (!mockEnabled && options.authLoading) {
    return Promise.resolve(publishSkippedLeaderboardState("auth-loading", contextKey));
  }
  if (!mockEnabled && !options.signedIn && accessMode !== "public") {
    return Promise.resolve(publishSkippedLeaderboardState("not-signed-in", contextKey));
  }
  if (!mockEnabled && !baseUrl) {
    return Promise.resolve(publishSkippedLeaderboardState("missing-base-url", contextKey));
  }
  if (!mockEnabled && accessMode === "unavailable") {
    return Promise.resolve(publishSkippedLeaderboardState("access-unavailable", contextKey));
  }

  const target = sessionAtStart.targets.leaderboard;
  const existing = readLeaderboardPreloadState(contextKey);
  if (existing) return Promise.resolve(existing);
  if (
    target.stateStatus === "pending" &&
    target.statePromise &&
    target.pendingStateContextKey === contextKey
  ) {
    return target.statePromise;
  }

  const requestId = target.stateRequestId + 1;
  target.stateRequestId = requestId;
  target.stateStatus = "pending";
  target.pendingStateContextKey = contextKey;
  target.error = null;

  const promise = Promise.resolve()
    .then(() =>
      getLeaderboard({
        baseUrl,
        userId,
        period,
        limit: pageSize,
        offset,
      }),
    )
    .then((data) => {
      if (
        session !== sessionAtStart ||
        target.stateRequestId !== requestId ||
        target.statePromise !== promise
      ) {
        return null;
      }
      target.pendingStateContextKey = null;
      return publishLeaderboardPreloadState(data, { contextKey });
    })
    .catch((error) => {
      if (
        session !== sessionAtStart ||
        target.stateRequestId !== requestId ||
        target.statePromise !== promise
      ) {
        return null;
      }
      target.pendingStateContextKey = null;
      publishLeaderboardPreloadState(null, {
        contextKey,
        status: "rejected",
        error,
      });
      return null;
    });

  target.statePromise = promise;
  return promise;
}
