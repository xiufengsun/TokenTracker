// WorkBuddy subscription-plan quota.
//
// The desktop app already reads this from its billing meter. China
// (WorkBuddy, ~/.workbuddy) and international (WorkBuddy AI, ~/.workbuddy-ai)
// share the path shape and differ by host:
//
//   POST {origin}/billing/meter/get-user-resource-summary
//   POST {origin}/billing/meter/get-user-resource-paid-packages
//   POST {origin}/billing/meter/get-user-resource-free-packages
//
// Prefer each edition's wbipc/endpoint.json -> wb.request/http.fetch proxy.
// WorkBuddy adds its own credentials, including encrypted desktop sessions.
// Legacy plaintext credentials remain a fallback when no local IPC exists.
//
// Only the subscription plan package is returned — the row the app calls
// 套餐基础积分, with that package's cycle end as the reset. Reward grants
// (活动 / 成长计划 / bonus / extra / gift) are dropped. Display names are
// English regardless of the backend's localized package names.

const fs = require("node:fs");
const path = require("node:path");
const { resolveWorkbuddyHome } = require("./rollout");
const { UNAVAILABLE, readWorkbuddyIpcDiscovery, openWorkbuddyIpc } = require("./workbuddy-ipc");

const PLAN_PRIORITY = Object.freeze({
  TCACA_code_027_0FCGVA6vSa: 4, // flagship
  TCACA_code_026_BaESVICNoi: 3, // advanced
  TCACA_code_002_AkiJS3ZHF5: 2, // pro monthly
  TCACA_code_005_maRGyrHhw1: 2, // pro monthly plus
  TCACA_code_003_FAnt7lcmRT: 2, // pro yearly
  TCACA_code_023_4xbGhMrE6q: 1, // youth
  TCACA_code_035_ArVxJcGDsm: 0, // international monthly
  TCACA_code_039_KRcQj7wUat: 0, // trial monthly
  TCACA_code_040_mi9rCYg46x: 0, // trial yearly
  TCACA_code_008_cfWoLwvjU4: 0, // China monthly trial
});

// Verbatim English edition labels from WorkBuddy Desktop 5.8.3's
// renderer/assets/edition-config-BLwrE-d8.js (getEditionConfigMap), with the
// package -> edition mapping in common-DRZ6FwkK.js (resolveEditionFromResources).
// These are official UI fallbacks, not English names supplied by the CN API.
const PLAN_LABELS = Object.freeze({
  TCACA_code_027_0FCGVA6vSa: "Ultimate",
  TCACA_code_026_BaESVICNoi: "Advanced",
  TCACA_code_002_AkiJS3ZHF5: "STANDARD",
  TCACA_code_005_maRGyrHhw1: "STANDARD",
  TCACA_code_003_FAnt7lcmRT: "STANDARD",
  TCACA_code_023_4xbGhMrE6q: "Youth",
  TCACA_code_035_ArVxJcGDsm: "Free",
  TCACA_code_039_KRcQj7wUat: "STANDARD TRIAL",
  TCACA_code_040_mi9rCYg46x: "STANDARD TRIAL",
  TCACA_code_008_cfWoLwvjU4: "Free",
});

// Platform reward credits. Never selected, even when the summary names one
// as a subscription package.
const REWARD_CODES = new Set([
  "TCACA_code_001_PqouKr6QWV", // free, not the plan
  "TCACA_code_006_DbXS0lrypC", // gift
  "TCACA_code_007_nzdH5h4Nl0", // activity / 官方活动
  "TCACA_code_009_0XmEQc2xOf", // extra credit package
  "TCACA_code_028_NtpWi0jzXs", // bonus
  "TCACA_code_029_6wCGEWquYy",
  "TCACA_code_030_BjSt89qTvr",
  "TCACA_code_036_lupO5WgNdG", // international extra
  "TCACA_code_037_WxOD3MpI2o", // international bonus
  "TCACA_code_038_OhvqZtiPKr", // extra
]);

const VARIANTS = Object.freeze({
  workbuddy: {
    id: "workbuddy",
    source: "workbuddy",
    envToken: "WORKBUDDY_ACCESS_TOKEN",
    defaultOrigin: "https://www.workbuddy.cn",
    allowedHostSuffixes: ["workbuddy.cn", "copilot.tencent.com", "wb.tencentbuddy.com"],
    authFileNames: ["workbuddy-desktop.info"],
    brand: "WorkBuddy",
  },
  workbuddyAi: {
    id: "workbuddyAi",
    source: "workbuddy-ai",
    envToken: "WORKBUDDY_AI_ACCESS_TOKEN",
    defaultOrigin: "https://www.workbuddy.ai",
    allowedHostSuffixes: ["workbuddy.ai"],
    authFileNames: ["workbuddy-ai.info", "workbuddy-desktop.info"],
    brand: "WorkBuddy AI",
  },
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hostOf(value) {
  if (!isNonEmptyString(value)) return "";
  const trimmed = value.trim();
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostAllowed(hostname, suffixes) {
  if (!hostname) return false;
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

function originAllowed(origin, variant) {
  return hostAllowed(hostOf(origin), variant.allowedHostSuffixes);
}

function toCount(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const n = Number(value);
    return n >= 0 ? n : null;
  }
  return null;
}

function firstCount(row, keys) {
  for (const key of keys) {
    const n = toCount(row?.[key]);
    if (n !== null) return n;
  }
  return null;
}

function firstString(row, keys) {
  for (const key of keys) {
    if (isNonEmptyString(row?.[key])) return row[key].trim();
  }
  return "";
}

function normalizeResetAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  // "2026-10-31 23:59:59" is the cycle boundary the app shows. Without a
  // zone, Date parses the T form as local time, matching the desktop app.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? text.replace(" ", "T")
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return value;
}

function normalizePackageRow(row) {
  if (!row || typeof row !== "object") return null;
  const code = firstString(row, ["PackageCode", "packageCode", "package_code"]);
  if (!code) return null;
  const total = firstCount(row, [
    "CycleTotalCapacity",
    "cycleTotal",
    "CycleCapacitySizePrecise",
    "total",
  ]);
  const remain = firstCount(row, [
    "CycleRemainCapacity",
    "cycleRemain",
    "CycleCapacityRemainPrecise",
    "left",
  ]);
  const used = firstCount(row, ["CycleUsedCapacity", "cycleUsed", "used"]);
  return {
    code,
    name: firstString(row, ["PackageName", "packageName", "name"]),
    total,
    remain,
    used,
    cycleEnd: firstString(row, ["CycleEndTime", "cycleEnd", "cycle_end"])
      || firstString(row, ["DeductionEndTime", "expireAt"]),
  };
}

function unwrapBillingBody(payload) {
  if (!payload || typeof payload !== "object") return null;
  const code = payload.code ?? payload.Code;
  if (code !== undefined && code !== 0 && code !== "0") return null;
  const data = payload.data ?? payload.Data;
  if (data && typeof data === "object") return data;
  return payload;
}

function collectPackageRows(payload) {
  const data = unwrapBillingBody(payload);
  if (!data) return [];
  const lists = [];
  for (const key of ["Packages", "packages", "Accounts", "accounts", "Resources", "resources"]) {
    if (Array.isArray(data[key])) lists.push(data[key]);
  }
  if (Array.isArray(data)) lists.push(data);
  const rows = [];
  for (const list of lists) {
    for (const item of list) {
      const row = normalizePackageRow(item);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function readSubscriptionIdentity(payload) {
  const data = unwrapBillingBody(payload);
  if (!data) return { code: "", name: "" };
  return {
    code: firstString(data, ["SubscriptionPackageCode", "subscriptionPackageCode"]),
    name: firstString(data, ["SubscriptionPackageName", "subscriptionPackageName"]),
  };
}

function mergePackageRows(rows) {
  const byCode = new Map();
  for (const row of rows) {
    const prev = byCode.get(row.code);
    if (!prev) {
      byCode.set(row.code, { ...row });
      continue;
    }
    byCode.set(row.code, {
      code: row.code,
      name: row.name || prev.name,
      total: row.total ?? prev.total,
      remain: row.remain ?? prev.remain,
      used: row.used ?? prev.used,
      cycleEnd: row.cycleEnd || prev.cycleEnd,
    });
  }
  return [...byCode.values()];
}

function isRewardCode(code) {
  return REWARD_CODES.has(code);
}

function isSelectablePlan(row, subscriptionPackageCode) {
  if (!row || isRewardCode(row.code)) return false;
  if (Object.prototype.hasOwnProperty.call(PLAN_PRIORITY, row.code)) return true;
  return Boolean(subscriptionPackageCode) && row.code === subscriptionPackageCode;
}

function planScore(row) {
  const priority = PLAN_PRIORITY[row.code] ?? 0;
  const live = row.total > 0 && row.remain > 0 ? 1 : 0;
  const total = Number.isFinite(row.total) ? row.total : 0;
  return priority * 1_000_000_000 + live * 1_000_000 + total;
}

function planWindow(row) {
  const total = row.total;
  const remain = row.remain;
  const used = row.used ?? (total !== null && remain !== null ? Math.max(0, total - remain) : null);
  if (total === null || total <= 0 || used === null) return null;
  const usedPercent = clampPercent((used / total) * 100);
  if (usedPercent === null) return null;
  return {
    used_percent: usedPercent,
    reset_at: normalizeResetAt(row.cycleEnd),
    used_credits: used,
    limit_credits: total,
    remaining_credits: remain ?? Math.max(0, total - used),
  };
}

// One product row, one account's balance. Prefer a usable quota; when both
// editions are connected China wins deterministically. Never add their pools.
function selectWorkbuddyLimits(china, international) {
  const editions = [china, international].filter(Boolean);
  const usable = (value) => value.configured === true && !value.error;
  return editions.find((value) => usable(value) && value.primary_window)
    || editions.find(usable)
    || editions.find((value) => value.configured === true)
    || { configured: false };
}

// Pick the one subscription-plan package. Reward rows are ignored. When
// several plan packages exist, the highest tier that still has credit wins,
// matching the desktop app's pickActivePlanBase.
function selectWorkbuddyPlanQuota(rows, identity = {}, variantId = "workbuddy") {
  const merged = mergePackageRows(rows.filter(Boolean));
  const subscriptionPackageCode = identity.code || "";
  const candidates = merged.filter((row) => isSelectablePlan(row, subscriptionPackageCode));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => planScore(b) - planScore(a));
  const chosen = candidates[0];
  const window = planWindow(chosen);
  if (!window) return null;
  const planLabel = englishPlanLabel(chosen, identity, variantId);
  return {
    plan_label: planLabel || null,
    primary_window: window,
    package_code: chosen.code,
  };
}

function englishPlanLabel(row, identity, variantId) {
  // An actual English subscription/package name takes precedence over the
  // client's edition fallback. Unknown localized tiers stay unnamed.
  for (const name of [identity.name, row.name]) {
    if (typeof name === "string" && /^[\x20-\x7e]+$/.test(name.trim())
      && /[a-z]/i.test(name) && !/^TCACA_code_/i.test(name.trim())) return name.trim();
  }
  const known = PLAN_LABELS[row.code];
  if (variantId === "workbuddyAi") {
    if (known === "STANDARD") return "Pro";
    if (known === "STANDARD TRIAL") return "Pro-Trial";
  }
  return known || null;
}

function variantById(id) {
  return VARIANTS[id] || null;
}

function directoryExists(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function authSearchDirs(env, workbuddyHome) {
  const home = isNonEmptyString(env?.HOME) ? env.HOME.trim() : "";
  const dirs = [];
  if (home && process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"));
  } else if (process.platform === "win32") {
    const appData = isNonEmptyString(env?.APPDATA) ? env.APPDATA.trim() : (home ? path.join(home, "AppData", "Roaming") : "");
    if (appData) dirs.push(path.join(appData, "CodeBuddyExtension", "Data", "Public", "auth"));
  } else if (home) {
    dirs.push(path.join(home, ".config", "CodeBuddyExtension", "Data", "Public", "auth"));
  }
  if (workbuddyHome) dirs.push(path.join(workbuddyHome, "auth"));
  return dirs;
}

function readAuthFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  const auth = parsed?.auth;
  if (!auth || typeof auth !== "object") return null;
  const domain = isNonEmptyString(auth.domain) ? auth.domain.trim() : "";
  const token = auth.accessToken;
  if (isNonEmptyString(token)) return { token: token.trim(), domain, encrypted: false };
  if (token && typeof token === "object" && token.$wbEncrypted === 1) {
    return { token: null, domain, encrypted: true };
  }
  return { token: null, domain, encrypted: false };
}

function resolveSession(variant, { env, authFiles, workbuddyHome }) {
  const files = Array.isArray(authFiles)
    ? authFiles
    : authSearchDirs(env, workbuddyHome).flatMap((dir) => variant.authFileNames.map((name) => path.join(dir, name)));
  let encryptedForVariant = false;
  for (const filePath of files) {
    if (!filePath) continue;
    const session = readAuthFile(filePath);
    if (!session) continue;
    if (!hostAllowed(hostOf(session.domain), variant.allowedHostSuffixes)) continue;
    if (session.token) return { token: session.token, encrypted: false, matched: true };
    if (session.encrypted) encryptedForVariant = true;
  }
  return { token: null, encrypted: encryptedForVariant, matched: encryptedForVariant };
}

function readProductEndpoint(workbuddyHome) {
  if (!workbuddyHome) return "";
  const storage = path.join(workbuddyHome, "storage");
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5 || found.length > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length > 4) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === "wb-product-config.json") found.push(full);
    }
  };
  walk(storage, 0);
  for (const filePath of found) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const data = parsed?.["product-config-snapshot"]?.data;
      if (isNonEmptyString(data?.endpoint)) return data.endpoint.trim();
    } catch {
      // The next snapshot may still be readable.
    }
  }
  return "";
}

function resolveOrigin(variant, { origin, workbuddyHome }) {
  if (isNonEmptyString(origin) && originAllowed(origin, variant)) {
    return origin.trim().replace(/\/+$/, "");
  }
  const configured = readProductEndpoint(workbuddyHome);
  if (configured && originAllowed(configured, variant)) return configured.replace(/\/+$/, "");
  return variant.defaultOrigin;
}

function resolveToken(variant, env) {
  const fromEnv = env && typeof env === "object" ? env[variant.envToken] : null;
  return isNonEmptyString(fromEnv) ? fromEnv.trim() : "";
}

async function postBilling(fetchImpl, url, token, body = {}, signal) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`${VARIANTS.workbuddy.brand} sign-in expired.`);
    error.code = "AUTH_EXPIRED";
    throw error;
  }
  if (!response.ok) {
    throw new Error(`WorkBuddy quota request failed (${response.status}).`);
  }
  return response.json();
}

async function fetchPlanQuota(post, variantId) {
  const prefix = "/billing/meter/";
  const summary = await post(`${prefix}get-user-resource-summary`, {});
  if (!unwrapBillingBody(summary)) throw new Error("WorkBuddy quota request was rejected.");
  const identity = readSubscriptionIdentity(summary);
  const planCodes = [...new Set([...Object.keys(PLAN_PRIORITY),
    ...(identity.code && !isRewardCode(identity.code) ? [identity.code] : [])])];
  const packageRows = await Promise.all(["paid", "free"].map(async (kind) => {
    const rows = [];
    for (let page = 1; page <= 10; page++) {
      const payload = await post(`${prefix}get-user-resource-${kind}-packages`, {
        PageNumber: page, PageSize: 100, PackageCodes: planCodes,
        Status: [0, 3], ...(kind === "paid" ? { NeedRenewInfo: true } : {}),
      });
      const data = unwrapBillingBody(payload);
      if (!data) throw new Error("WorkBuddy quota request was rejected.");
      rows.push(...collectPackageRows(payload));
      const count = Array.isArray(data.Accounts) ? data.Accounts.length : 0;
      if (count < 100 || (Number(data.TotalCount) > 0 && page * 100 >= Number(data.TotalCount))) return rows;
    }
    throw new Error("WorkBuddy quota package list was incomplete.");
  }));
  const quota = selectWorkbuddyPlanQuota([
    ...collectPackageRows(summary), ...packageRows.flat(),
  ], identity, variantId);
  return {
    configured: true, error: null,
    plan_label: quota?.plan_label || englishPlanLabel({ code: identity.code }, identity, variantId),
    primary_window: quota?.primary_window || null,
  };
}

function scopedEnv(env, home) {
  const next = { ...(env || {}) };
  // An explicit home is the whole lookup root. Tests pass a temp directory
  // while process.env.HOME still points at the developer, and a China
  // session must not leak into that lookup.
  if (isNonEmptyString(home)) {
    next.HOME = home.trim();
    if (next.USERPROFILE) next.USERPROFILE = home.trim();
  }
  return next;
}

async function fetchVariant(variantId, opts = {}) {
  const variant = variantById(variantId);
  if (!variant) return { configured: false };
  const env = scopedEnv(opts.env || process.env, opts.home);
  const workbuddyHome = opts.workbuddyHome || resolveWorkbuddyHome(env, variant.source);
  const installed = directoryExists(workbuddyHome);
  const discovery = readWorkbuddyIpcDiscovery(workbuddyHome);
  if (discovery) {
    // Discovery is edition-local. Never fall back to the other edition's
    // socket or allow an explicitly redirected product to be mislabelled.
    const productEndpoint = readProductEndpoint(workbuddyHome);
    if (productEndpoint && !originAllowed(productEndpoint, variant)) {
      throw new Error("WorkBuddy quota host does not match this edition.");
    }
    const client = await openWorkbuddyIpc({
      discovery, signal: opts.signal, timeoutMs: opts.timeoutMs, connectImpl: opts.connectImpl,
    });
    try {
      return { ...await fetchPlanQuota((apiPath, body) => client.postBilling(apiPath, body), variantId), source: "ipc" };
    } finally {
      client.close();
    }
  }
  const explicitToken = resolveToken(variant, env);
  const session = explicitToken
    ? { token: explicitToken, encrypted: false, matched: true }
    : resolveSession(variant, { env, authFiles: opts.authFiles, workbuddyHome });
  if (!session.token) {
    if (session.encrypted || installed) return { configured: true, error: UNAVAILABLE };
    if (!installed) return { configured: false };
    return { configured: false };
  }

  const fetchImpl = opts.fetchImpl || fetch;
  // An explicit origin is the caller's host. Otherwise use this edition's
  // own product-config endpoint, and never the other edition's default.
  const origin = resolveOrigin(variant, {
    origin: opts.origin,
    workbuddyHome: opts.origin ? null : workbuddyHome,
  });
  if (!originAllowed(origin, variant)) {
    throw new Error("WorkBuddy quota host does not match this edition.");
  }
  return { ...await fetchPlanQuota((apiPath, body) => postBilling(fetchImpl,
    `${origin}${apiPath}`, session.token, body, opts.signal), variantId), source: "api" };
}

function fetchWorkbuddyLimits(opts) {
  return fetchVariant("workbuddy", opts);
}

function fetchWorkbuddyAiLimits(opts) {
  return fetchVariant("workbuddyAi", opts);
}

module.exports = {
  PLAN_PRIORITY,
  REWARD_CODES,
  VARIANTS,
  selectWorkbuddyPlanQuota,
  selectWorkbuddyLimits,
  collectPackageRows,
  readSubscriptionIdentity,
  originAllowed,
  hostAllowed,
  fetchWorkbuddyLimits,
  fetchWorkbuddyAiLimits,
};
