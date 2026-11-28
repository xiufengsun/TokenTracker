export type DashboardPreloadTarget = "limits" | "leaderboard";

export type DashboardPreloadStatus =
  | "idle"
  | "pending"
  | "fulfilled"
  | "rejected"
  | "skipped";

export type DashboardPreloadStateSource =
  | "dashboard-existing"
  | "silent-preload"
  | "page-load"
  | "manual-refresh";

export interface DashboardPreloadCacheEntry<TData = unknown> {
  targetKey: DashboardPreloadTarget;
  status: DashboardPreloadStatus;
  data: TData | null;
  error: string | null;
  source: DashboardPreloadStateSource;
  generatedAt: number;
  updatedAt: number;
  contextKey: string;
}

export interface DashboardPreloadSnapshot {
  sessionId: string;
  createdAt: number;
  completedAt: number | null;
  startedAfterMainContentVisible: boolean;
  cache: {
    limits: DashboardPreloadCacheEntry | null;
    leaderboard: {
      maxEntries: number;
      size: number;
      keys: string[];
    };
  };
  targets: Record<
    DashboardPreloadTarget,
    {
      key: DashboardPreloadTarget;
      route: string;
      resourceStatus: DashboardPreloadStatus;
      stateStatus: DashboardPreloadStatus;
      error: string | null;
    }
  >;
}

export interface DashboardPreloadContext {
  [key: string]: string | number | boolean | null | undefined;
}

export interface DashboardPreloadStateOptions {
  activeContextKey?: string;
  context?: DashboardPreloadContext;
  contextKey?: string;
  error?: unknown;
  generatedAt?: number;
  source?: DashboardPreloadStateSource;
  status?: DashboardPreloadStatus;
}

export interface LeaderboardPreloadOptions {
  accessMode?: string;
  authLoading?: boolean;
  baseUrl?: string;
  cloudUser?: { id?: string | null } | null;
  mockEnabled?: boolean;
  offset?: number;
  pageSize?: number;
  period?: string;
  signedIn?: boolean;
  userId?: string | null;
}

export const DASHBOARD_PRELOAD_TARGETS: readonly DashboardPreloadTarget[];
export const DASHBOARD_PRELOAD_STATUSES: readonly DashboardPreloadStatus[];

export function resetDashboardPreload(options?: { leaderboardMaxEntries?: number }): void;
export function markDashboardMainContentVisible(): void;
export function getDashboardPreloadSnapshot(): DashboardPreloadSnapshot;
export function buildDashboardPreloadContextKey(
  targetKey: DashboardPreloadTarget,
  context?: DashboardPreloadContext,
): string;
export function preloadDashboardPageResource(
  targetKey: DashboardPreloadTarget,
  options?: { loader?: () => Promise<unknown> },
): Promise<unknown | null>;
export function preloadDashboardPageResources(options?: {
  loaders?: Partial<Record<DashboardPreloadTarget, () => Promise<unknown>>>;
}): Promise<Array<unknown | null>>;
export function publishReusablePageState<TData = unknown>(
  targetKey: DashboardPreloadTarget,
  state?: DashboardPreloadStateOptions & { data?: TData | null },
): DashboardPreloadCacheEntry<TData>;
export function readReusablePageState<TData = unknown>(
  targetKey: DashboardPreloadTarget,
  contextKey?: string,
): DashboardPreloadCacheEntry<TData> | null;
export function publishUsageLimitsPreloadState<TData = unknown>(
  data: TData | null,
  options?: DashboardPreloadStateOptions,
): DashboardPreloadCacheEntry<TData>;
export function getUsageLimitsPreloadContextKey(context?: DashboardPreloadContext): string;
export function readUsageLimitsPreloadState<TData = unknown>(
  contextKey?: string,
): DashboardPreloadCacheEntry<TData> | null;
export function publishLeaderboardPreloadState<TData = unknown>(
  data: TData | null,
  options?: DashboardPreloadStateOptions,
): DashboardPreloadCacheEntry<TData>;
export function readLeaderboardPreloadState<TData = unknown>(
  contextKey: string,
): DashboardPreloadCacheEntry<TData> | null;
export function getLeaderboardPreloadPageSize(): number;
export function getLeaderboardPreloadContextKey(options?: LeaderboardPreloadOptions): string;
export function preloadLeaderboardDefaultState<TData = unknown>(
  options?: LeaderboardPreloadOptions,
): Promise<DashboardPreloadCacheEntry<TData> | null>;
