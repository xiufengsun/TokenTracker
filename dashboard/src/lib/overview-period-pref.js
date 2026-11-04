export const OVERVIEW_PERIOD_STORAGE_KEY = "tt.overviewPeriod";
export const DEFAULT_OVERVIEW_PERIOD = "month";
export const OVERVIEW_PERIODS = Object.freeze(["day", "week", "month", "total"]);

export function normalizeOverviewPeriod(value) {
  return OVERVIEW_PERIODS.includes(value) ? value : DEFAULT_OVERVIEW_PERIOD;
}

export function readOverviewPeriod() {
  if (typeof window === "undefined") return DEFAULT_OVERVIEW_PERIOD;
  try {
    return normalizeOverviewPeriod(window.localStorage?.getItem(OVERVIEW_PERIOD_STORAGE_KEY));
  } catch (_error) {
    return DEFAULT_OVERVIEW_PERIOD;
  }
}

export function persistOverviewPeriod(value) {
  if (!OVERVIEW_PERIODS.includes(value)) return readOverviewPeriod();
  if (typeof window === "undefined") return value;
  try {
    window.localStorage?.setItem(OVERVIEW_PERIOD_STORAGE_KEY, value);
  } catch (_error) {
    // localStorage can be unavailable in private/locked-down browser contexts.
  }
  return value;
}
