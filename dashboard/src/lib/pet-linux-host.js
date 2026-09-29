/**
 * Linux host for the floating pet page (`pet.html`).
 *
 * On Windows and macOS the native app polls usage and pushes it into the pet
 * page through `window.__ttPet*` globals + `pet:*` events. The Linux pet window
 * loads `pet.html` from the same loopback server as the dashboard, so it reads
 * the local API itself, mirroring TokenTrackerWin/UsagePoller.cs so the Linux
 * pet shows the same numbers as the other desktop hosts.
 *
 * The pet runs in its own process with its own WebKit storage, so the
 * dashboard's currency / locale / theme arrive from the Rust side
 * (TokenTrackerLinux/src-tauri/src/pet.rs) as `window.__ttPetStorage`, raw
 * localStorage values parsed here with the dashboard's own helpers. Rust also
 * owns the window: size, character, bot colour, drag and the input region.
 */

import {
  CURRENCY_STORAGE_KEY,
  EXCHANGE_RATES_STORAGE_KEY,
  getCurrencySymbol,
  getRateFor,
  normalizeCurrency,
} from "./currency";
import { LOCALE_STORAGE_KEY } from "./locale";

const POLL_INTERVAL_MS = 60_000;
// Streak / active days are day-grained but ride in the largest response
// (~40 KB), so hold them for five minutes like the Windows poller does.
const HEATMAP_TTL_MS = 5 * 60_000;
const THEME_STORAGE_KEY = "tokentracker-theme";
const ACCOUNT_QUERY = "account=1";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Same policy as the dashboard: positive billable total, then positive raw total. */
export function resolveDisplayTokens(totals) {
  const billable = toNumber(totals?.billable_total_tokens);
  const total = toNumber(totals?.total_tokens);
  if (billable != null && billable > 0) return billable;
  if (total != null && total > 0) return total;
  return billable ?? total ?? 0;
}

/**
 * Top five models over the breakdown window: dedupe by lowercased name, keep the
 * provider of the heaviest row, percent of all tokens to one decimal.
 */
export function buildTopModels(breakdown) {
  const sources = Array.isArray(breakdown?.sources) ? breakdown.sources : [];
  const byKey = new Map();
  let totalAll = 0;
  for (const src of sources) {
    const models = Array.isArray(src?.models) ? src.models : [];
    for (const m of models) {
      const tokens = resolveDisplayTokens(m?.totals);
      if (tokens <= 0) continue;
      const name = (typeof m?.model === "string" && m.model) || "—";
      const key = name.trim().toLowerCase();
      if (!key) continue;
      totalAll += tokens;
      const entry = byKey.get(key) || { tokens: 0, weight: 0, name, source: "" };
      entry.tokens += tokens;
      if (tokens >= entry.weight) {
        entry.weight = tokens;
        entry.name = name;
        entry.source = typeof src?.source === "string" ? src.source : "";
      }
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 5)
    .map((e) => ({
      name: e.name,
      percent: totalAll > 0 ? ((e.tokens / totalAll) * 100).toFixed(1) : "0.0",
      source: e.source,
    }));
}

export function buildStats(summary, heatmap, topModels) {
  const totals = summary?.totals || {};
  const rolling = summary?.rolling || {};
  return {
    todayTokens: resolveDisplayTokens(totals),
    todayCostUsd: toNumber(totals.total_cost_usd) ?? 0,
    conversations: toNumber(totals.conversation_count) ?? 0,
    last7dTokens: resolveDisplayTokens(rolling.last_7d?.totals),
    last7dActiveDays: toNumber(rolling.last_7d?.active_days) ?? 0,
    last30dTokens: resolveDisplayTokens(rolling.last_30d?.totals),
    last30dAvgPerDay: toNumber(rolling.last_30d?.avg_per_active_day) ?? 0,
    streakDays: heatmap?.streak ?? 0,
    activeDaysAllTime: heatmap?.activeDays ?? 0,
    topModels: topModels || [],
  };
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function tzQuery(date) {
  let tz = "";
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* ignore */ }
  const offset = -date.getTimezoneOffset();
  return `${tz ? `&tz=${encodeURIComponent(tz)}` : ""}&tz_offset_minutes=${offset}`;
}

function readStorage(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

/** Currency the dashboard is set to, so the bubble shows the same unit. */
export function readCurrency(storage) {
  const code = normalizeCurrency(readStorage(storage, CURRENCY_STORAGE_KEY));
  let rates = null;
  try { rates = JSON.parse(readStorage(storage, EXCHANGE_RATES_STORAGE_KEY) || "null"); } catch { /* defaults */ }
  return { symbol: getCurrencySymbol(code), rate: getRateFor(rates, code) };
}

// Keys as the dashboard stores them → fields Rust relays in __ttPetStorage.
const RELAYED_KEYS = {
  [CURRENCY_STORAGE_KEY]: "currency",
  [EXCHANGE_RATES_STORAGE_KEY]: "exchangeRates",
  [LOCALE_STORAGE_KEY]: "locale",
  [THEME_STORAGE_KEY]: "theme",
};

/** The dashboard's preferences as relayed by the host, or this page's own storage. */
export function relayedStorage(win) {
  const relayed = win.__ttPetStorage;
  if (!relayed || typeof relayed !== "object") return win.localStorage;
  return {
    getItem: (key) => {
      const value = relayed[RELAYED_KEYS[key]];
      return typeof value === "string" ? value : null;
    },
  };
}

export function readDark(storage, win) {
  const theme = readStorage(storage, THEME_STORAGE_KEY);
  if (theme === "dark") return true;
  if (theme === "light") return false;
  try { return Boolean(win.matchMedia?.("(prefers-color-scheme: dark)").matches); } catch { return false; }
}

export function startLinuxPetHost({
  win = window,
  fetchImpl = (...args) => window.fetch(...args),
  now = () => new Date(),
} = {}) {
  const emit = (name, detail) => {
    win.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));
  };

  let heatmapCache = null; // { key, at, value }
  let showingAccount = false;
  let lastStats = null;
  let timer = null;
  let stopped = false;

  const getJson = async (path) => {
    const resp = await fetchImpl(path, { cache: "no-store" });
    if (!resp.ok) return { ok: false };
    const view = resp.headers?.get?.("X-TokenTracker-Account-View") === "1";
    const fallback = resp.headers?.get?.("X-TokenTracker-Account-Fallback") || "";
    return { ok: true, account: view, transient: !view && fallback.startsWith("transient"), body: await resp.json() };
  };

  const pushContext = () => {
    const storage = relayedStorage(win);
    win.__ttPetCurrency = readCurrency(storage);
    win.__ttPetLocale = readStorage(storage, LOCALE_STORAGE_KEY) || "system";
    win.__ttPetDark = readDark(storage, win);
    emit("pet:currency");
    emit("pet:locale");
    emit("pet:dark");
  };

  const fetchHeatmap = async (tz, retainAccount) => {
    const key = `${tz}|${retainAccount}`;
    if (heatmapCache && heatmapCache.key === key && Date.now() - heatmapCache.at < HEATMAP_TTL_MS) {
      return heatmapCache.value;
    }
    try {
      const r = await getJson(`/functions/tokentracker-usage-heatmap?weeks=52${tz}&${ACCOUNT_QUERY}`);
      if (!r.ok) return { streak: 0, activeDays: 0 };
      if (r.transient && retainAccount) return null;
      const value = {
        streak: toNumber(r.body?.streak_days) ?? 0,
        activeDays: toNumber(r.body?.active_days) ?? 0,
      };
      heatmapCache = { key, at: Date.now(), value };
      return value;
    } catch {
      return { streak: 0, activeDays: 0 };
    }
  };

  const fetchTopModels = async (from, to, tz, retainAccount) => {
    try {
      const r = await getJson(
        `/functions/tokentracker-usage-model-breakdown?from=${from}&to=${to}${tz}&${ACCOUNT_QUERY}`,
      );
      if (!r.ok) return [];
      if (r.transient && retainAccount) return null;
      return buildTopModels(r.body);
    } catch {
      return [];
    }
  };

  const refreshLimits = async () => {
    try {
      const r = await getJson("/functions/tokentracker-usage-limits");
      if (!r.ok) return;
      win.__ttPetLimits = r.body;
      emit("pet:limits");
    } catch { /* keep the last good snapshot */ }
  };

  const refreshUsage = async () => {
    const date = now();
    const today = localDate(date);
    const from = localDate(new Date(date.getTime() - 29 * 86_400_000));
    const tz = tzQuery(date);
    let summary;
    try {
      summary = await getJson(`/functions/tokentracker-usage-summary?from=${today}&to=${today}${tz}&${ACCOUNT_QUERY}`);
    } catch {
      summary = { ok: false };
    }
    win.__ttPetConnected = summary.ok;
    emit("pet:connected");
    if (!summary.ok || !summary.body?.totals) return;
    // A transient cloud failure must not replace a visible cross-device snapshot.
    if (summary.transient && showingAccount) return;

    const retainAccount = summary.account || showingAccount;
    const [heatmap, topModels] = await Promise.all([
      fetchHeatmap(tz, retainAccount),
      fetchTopModels(from, today, tz, retainAccount),
    ]);
    if (heatmap == null || topModels == null) return;
    showingAccount = summary.account;

    const stats = buildStats(summary.body, heatmap, topModels);
    if (lastStats && lastStats.todayTokens > 0 && stats.todayTokens > lastStats.todayTokens) {
      // No per-model attribution here; the page labels it with its localized "New usage".
      emit("pet:model-status", {
        tokensDelta: stats.todayTokens - lastStats.todayTokens,
        costDelta: stats.todayCostUsd - lastStats.todayCostUsd,
      });
    }
    lastStats = stats;
    win.__ttPetTokens = stats.todayTokens;
    win.__ttPetCostUsd = stats.todayCostUsd;
    win.__ttPetStats = stats;
    emit("pet:usage");
  };

  const tick = async () => {
    if (stopped) return;
    await Promise.all([refreshUsage(), refreshLimits()]);
    if (!stopped) timer = win.setTimeout(tick, POLL_INTERVAL_MS);
  };

  // Hover: the Rust side limits the window's input region to the sprite, so any
  // pointer inside this document is over the pet.
  const setHover = (value) => {
    if (win.__ttPetHover === value) return;
    win.__ttPetHover = value;
    emit("pet:hover");
  };
  const onMove = () => setHover(true);
  const onLeave = () => setHover(false);
  // The host re-pushes __ttPetStorage whenever the dashboard's preferences change.
  const onStorage = () => pushContext();

  win.document.addEventListener("mousemove", onMove);
  win.document.documentElement.addEventListener("mouseleave", onLeave);
  win.addEventListener("pet:storage", onStorage);

  pushContext();
  tick();

  return () => {
    stopped = true;
    if (timer != null) win.clearTimeout(timer);
    win.document.removeEventListener("mousemove", onMove);
    win.document.documentElement.removeEventListener("mouseleave", onLeave);
    win.removeEventListener("pet:storage", onStorage);
  };
}
