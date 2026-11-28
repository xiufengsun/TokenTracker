"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomicSync } = require("./atomic-json");
const { normalizeApiKey, resolveProviderKeyDir } = require("./provider-api-key-store");

const PERIODS = [
  { window: "today", slot: "primary_window", cap: "dailyCreditLimit" },
  { window: "week", slot: "secondary_window", cap: "weeklyCreditLimit" },
  { window: "month", slot: "tertiary_window", cap: "monthlyCreditLimit" },
];

class ConfigError extends Error {}

function gatewayUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ConfigError("Invalid gateway URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) {
    throw new ConfigError("Use an HTTPS gateway URL (or loopback HTTP) without credentials, a query, or a fragment.");
  }
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function validateConfig(input, previous = null) {
  const gatewayBaseUrl = gatewayUrl(input?.gatewayBaseUrl);
  const supplied = input.apiKey != null && input.apiKey !== "";
  const retainedKey = previous?.gatewayBaseUrl === gatewayBaseUrl ? previous.apiKey : "";
  const apiKey = normalizeApiKey(supplied ? input.apiKey : retainedKey);
  if (!apiKey) throw new ConfigError("A valid API key is required for this gateway.");

  const displayName = String(input.displayName ?? "").trim();
  if (displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    throw new ConfigError("Invalid service name.");
  }
  const config = { gatewayBaseUrl, apiKey, displayName };
  for (const { cap } of PERIODS) {
    const raw = input[cap];
    if (raw == null || raw === "") {
      config[cap] = null;
    } else {
      const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new ConfigError("Credit limits must be positive numbers.");
      }
      config[cap] = value;
    }
  }
  if (!PERIODS.some(({ cap }) => config[cap] !== null)) throw new ConfigError("Enter at least one credit limit.");
  return config;
}

function configPath(options) {
  return path.join(resolveProviderKeyDir(options), "custom-credits.json");
}

function readConfig(options) {
  try {
    return validateConfig(JSON.parse(fs.readFileSync(configPath(options), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function publicConfig(config) {
  return {
    gatewayBaseUrl: config?.gatewayBaseUrl || "",
    displayName: config?.displayName || "",
    dailyCreditLimit: config?.dailyCreditLimit ?? null,
    weeklyCreditLimit: config?.weeklyCreditLimit ?? null,
    monthlyCreditLimit: config?.monthlyCreditLimit ?? null,
    hasApiKey: Boolean(config?.apiKey),
  };
}

function saveConfig(options, input) {
  // Only retain an existing key when editing the same normalized endpoint.
  // A supplied replacement also lets users recover an unreadable old config.
  const config = validateConfig(input, input?.apiKey ? null : readConfig(options));
  writeJsonAtomicSync(configPath(options), config);
  return publicConfig(config);
}

function clearConfig(options) {
  fs.rmSync(configPath(options), { force: true });
  return publicConfig(null);
}

const DAY_MS = 86_400_000;
const OFFSET_MS = 8 * 3_600_000;

// These gateway windows are calendar periods in UTC+8, starting Monday for
// weeks. Use UTC helpers on a shifted timestamp so the host's zone is irrelevant.
function billingPeriod(window, nowMs) {
  const day = new Date(nowMs + OFFSET_MS);
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth();
  const today = Date.UTC(year, month, day.getUTCDate());
  let start = today;
  let end = today + DAY_MS;
  if (window === "week") {
    start = today - ((day.getUTCDay() + 6) % 7) * DAY_MS;
    end = start + 7 * DAY_MS;
  } else if (window === "month") {
    start = Date.UTC(year, month, 1);
    end = Date.UTC(year, month + 1, 1);
  }
  return {
    days: (end - start) / DAY_MS,
    firstDate: new Date(start).toISOString().slice(0, 10),
    today: day.toISOString().slice(0, 10),
    resetAt: new Date(end - OFFSET_MS).toISOString(),
  };
}

function nonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function hasUnpricedTraffic(row, day) {
  const active = day?.total_tokens > 0 || day?.req_tokens > 0 || day?.rsp_tokens > 0;
  return active && (day.credit === null || (day.credit === undefined && row.credit === null));
}

// The gateway reports a window total for each model, or null if it lacks a
// price for that model. Preserve zero only when the model consumed no tokens.
function windowCredits(rows) {
  let used = 0;
  for (const row of rows) {
    if (row?.credit === null && row.total_tokens === 0) continue;
    if (!nonnegative(row?.credit)) return null;
    if (Array.isArray(row.daily) && row.daily.some((day) => hasUnpricedTraffic(row, day))) return null;
    used += row.credit;
  }
  return Number.isFinite(used) ? used : null;
}

function tokenCategories(day) {
  if (![day.req_tokens, day.cached_tokens, day.rsp_tokens].every(nonnegative)) return null;
  if (day.cached_tokens > day.req_tokens) return null;
  return [day.req_tokens - day.cached_tokens, day.cached_tokens, day.rsp_tokens];
}

function dailyModelCredits(model, calendar) {
  const byDate = new Map();
  if (!Array.isArray(model?.daily)) return byDate;
  const totals = [0, 0, 0];
  let canEstimate = true;
  for (const day of model.daily) {
    if (!validDate(day?.date) || day.date < calendar.firstDate ||
        day.date > calendar.today || byDate.has(day.date)) return new Map();
    const credits = nonnegative(day.credit) ? day.credit : null;
    const tokens = tokenCategories(day);
    // Explicit null from a gateway with daily billing means unknown price.
    const estimate = !Object.hasOwn(day, "credit");
    byDate.set(day.date, { credits, source: "reported", estimate, tokens });
    if (!tokens) canEstimate = false;
    else tokens.forEach((value, i) => { totals[i] += value; });
  }
  // Older gateways only report the window's input/cache/output credits.
  // Allocate each category against its own token counts. A missing category
  // or day could inflate every estimate, so keep only directly billed days.
  const breakdown = model.credit_breakdown;
  const costs = [breakdown?.input, breakdown?.cached, breakdown?.output];
  const elapsedDays = (Date.parse(calendar.today) - Date.parse(calendar.firstDate)) / DAY_MS + 1;
  if (!canEstimate || byDate.size !== elapsedDays ||
      !costs.every((cost, i) => nonnegative(cost) && (cost === 0 || totals[i] > 0))) return byDate;
  for (const point of byDate.values()) {
    if (!point.estimate) continue;
    point.credits = costs.reduce((sum, cost, i) =>
      sum + (totals[i] ? cost * (point.tokens[i] / totals[i]) : 0), 0);
    point.source = "estimated";
  }
  return byDate;
}

function dailyHistory(rows, calendar) {
  // Only publish dates covered by every model. Missing dates and a model's
  // unpriced traffic must not silently reduce the user's historical total.
  const models = rows.map((row) => dailyModelCredits(row, calendar));
  const history = [];
  for (const date of models[0]?.keys() || []) {
    const points = models.map((model) => model.get(date));
    if (!points.every((point) => nonnegative(point?.credits))) continue;
    const credits = points.reduce((sum, point) => sum + point.credits, 0);
    if (!Number.isFinite(credits)) continue;
    history.push({
      date,
      used_credits: credits,
      source: points.some((point) => point.source === "estimated") ? "estimated" : "reported",
    });
  }
  return history;
}

async function fetchGatewayList(config, requestPath, fetchImpl) {
  const response = await fetchImpl(config.gatewayBaseUrl + requestPath, {
    headers: { Authorization: "Bearer " + config.apiKey, Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error("Gateway returned HTTP " + response.status + ".");
  const body = await response.json();
  if (!Array.isArray(body?.data) || body.mock === true) throw new Error("Invalid gateway credit response.");
  return body;
}

async function fetchWindow(config, period, fetchImpl, nowMs) {
  const calendar = billingPeriod(period.window, nowMs);
  const limit = config[period.cap] ?? config.dailyCreditLimit * calendar.days;
  if (!limit) return { usage: null, history: [], partialDates: [] };
  const body = await fetchGatewayList(config, "/v1/usage/by-model?window=" + period.window, fetchImpl);
  if (body.window !== period.window) throw new Error("Wrong gateway credit window.");
  const partialDates = [];
  for (const row of body.data) {
    if (period.window === "today" && row?.credit === null && row.total_tokens > 0) partialDates.push(calendar.today);
    if (!Array.isArray(row?.daily)) continue;
    for (const day of row.daily) {
      if (hasUnpricedTraffic(row, day)) partialDates.push(day.date);
    }
  }
  const used = windowCredits(body.data);
  const history = period.window === "today" && used !== null
    ? [{ date: calendar.today, used_credits: used, source: "reported" }]
    : dailyHistory(body.data, calendar);
  const usage = used === null ? null : creditWindow(used, limit, calendar, config[period.cap] === null);
  return { usage, history, partialDates };
}

function creditWindow(used, limit, calendar, derived) {
  return {
    used_percent: Math.min(100, used / limit * 100),
    used_credits: used,
    limit_credits: limit,
    remaining_credits: Math.max(0, limit - used),
    derived_limit: derived,
    reset_at: calendar.resetAt,
    limit_window_seconds: calendar.days * DAY_MS / 1000,
    unit: "credits",
  };
}

// This endpoint prices each (model, provider) group independently and can
// include days before the start of this month. A null is explicitly unknown.
async function fetchBilledDays(config, fetchImpl, nowMs) {
  const body = await fetchGatewayList(config, "/v1/usage/daily-credit?days=31", fetchImpl);
  const last = new Date(nowMs + OFFSET_MS).toISOString().slice(0, 10);
  const first = new Date(nowMs + OFFSET_MS - 30 * DAY_MS).toISOString().slice(0, 10);
  const days = new Map();
  for (const row of body.data) {
    if (!validDate(row?.date) || row.date < first || row.date > last || days.has(row.date) ||
        (row.credit !== null && !nonnegative(row.credit))) throw new Error("Invalid billed day.");
    days.set(row.date, row.credit);
  }
  return days;
}

function readCreditLimitsConfig(options) {
  if (!resolveProviderKeyDir(options)) return null;
  try { return readConfig(options); } catch {
    return { error: "Invalid custom credit configuration." };
  }
}

async function fetchCustomCreditLimits({
  home, trackerDir, fetchImpl = fetch, nowMs = Date.now(), config = readCreditLimitsConfig({ home, trackerDir }),
} = {}) {
  if (!config) return { configured: false };
  if (config.error) return { configured: true, error: config.error };
  const [results, billedDays] = await Promise.all([
    Promise.allSettled(PERIODS.map((period) => fetchWindow(config, period, fetchImpl, nowMs))),
    fetchBilledDays(config, fetchImpl, nowMs).catch(() => null),
  ]);
  const limits = { configured: true, plan_label: config.displayName || null, error: null };
  const history = new Map();
  const partialDates = new Set();
  // Shorter windows win within a source; reported billing always beats an estimate.
  for (const [index, result] of results.entries()) {
    limits[PERIODS[index].slot] = result.status === "fulfilled" ? result.value.usage : null;
    if (result.status !== "fulfilled") continue;
    for (const date of result.value.partialDates) partialDates.add(date);
    for (const point of result.value.history) {
      const previous = history.get(point.date);
      if (!previous || (previous.source === "estimated" && point.source === "reported")) {
        history.set(point.date, point);
      }
    }
  }
  // A failed today endpoint need not hide the daily bar when every model
  // in a longer window reported a price for today. Never build a quota
  // from a token-weighted estimate or a partial billed-days aggregate.
  const day = billingPeriod("today", nowMs);
  const measured = history.get(day.today);
  if (!limits.primary_window && config.dailyCreditLimit && measured?.source === "reported" &&
      !partialDates.has(day.today) && (billedDays?.get(day.today) !== null || measured.used_credits === 0)) {
    limits.primary_window = creditWindow(measured.used_credits, config.dailyCreditLimit, day, false);
  }
  for (const [date, credits] of billedDays || []) {
    if (credits === null) history.delete(date);
    else history.set(date, {
      date, used_credits: credits, source: "reported",
      ...(partialDates.has(date) ? { partial: true } : {}),
    });
  }
  limits.daily_history = [...history.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!PERIODS.some(({ slot }) => limits[slot])) {
    limits.error = "Gateway credit usage is unavailable. Check the connection, key, and model credit data.";
  }
  return limits;
}

module.exports = { ConfigError, readConfig, publicConfig, saveConfig, clearConfig, readCreditLimitsConfig, fetchCustomCreditLimits };
