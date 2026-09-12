const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { accountPaths, readOptionalJson, invalidateAccount } = require("./subscription-accounts");
const { readAccountAuth, identityMatches } = require("./subscription-account-auth");
const { writeFileAtomic, openLock } = require("./fs");
const { computeRowCost } = require("./pricing");
const { listClaudeProjectFiles, listRolloutFilesDeep, parseClaudeIncremental, parseRolloutIncremental } = require("./rollout");
const { fetchClaudeUsageLimits, fetchCodexUsageLimits, normalizePlanLabel } = require("./usage-limits");

const flights = new Map();
function singleflight(key, action) {
  if (flights.has(key)) return flights.get(key);
  const promise = Promise.resolve().then(action).finally(() => flights.delete(key));
  flights.set(key, promise);
  return promise;
}

async function scanAccountUsage({ trackerDir, account }) {
  const { dir, runtimeHome } = accountPaths(trackerDir, account.id);
  return singleflight(`${dir}:usage`, async () => {
    if (!account.identity) return null;
    const transferLock = await openLock(path.join(dir, "usage-transfer.lock"), { quietIfLocked: true });
    if (!transferLock) {
      const cached = await readOptionalJson(path.join(dir, "usage.json"));
      return cached?.identity === account.identity.key ? cached.usage : null;
    }
    try {
    const files = account.provider === "claude"
      ? await listClaudeProjectFiles(path.join(runtimeHome, "projects"))
      : [...await listRolloutFilesDeep(path.join(runtimeHome, "sessions")),
        ...await listRolloutFilesDeep(path.join(runtimeHome, "archived_sessions"))];
    const canonicalHome = await fs.realpath(runtimeHome);
    // Do not follow imported/symlinked histories outside this account's home.
    const safeFiles = [];
    const signature = crypto.createHash("sha256");
    const inherited = await readOptionalJson(path.join(dir, "inherited-usage.json")) || {};
    signature.update(JSON.stringify(inherited));
    for (const file of files.sort()) {
      const real = await fs.realpath(file);
      if (!real.startsWith(canonicalHome + path.sep)) continue;
      const stat = await fs.stat(real);
      signature.update(JSON.stringify([real, stat.size, stat.mtimeMs, stat.ctimeMs]));
      safeFiles.push(real);
    }
    const digest = signature.digest("hex");
    const cacheFile = path.join(dir, "usage.json");
    const cached = await readOptionalJson(cacheFile);
    if (cached?.version === 1 && cached.signature === digest && cached.identity === account.identity.key) return cached.usage;
    // Rebuild an isolated derived view when the files change. Atomic publication
    // avoids a queue/cursor crash window and never mutates the user's global queue.
    const scratch = await fs.mkdtemp(path.join(dir, "scan-"));
    try {
      const queuePath = path.join(scratch, "queue.jsonl");
      const cursors = {};
      if (account.provider === "claude") {
        const projectFiles = [];
        for (const file of [...new Set(safeFiles)]) {
          const relative = path.relative(canonicalHome, file);
          if (!inherited[relative]?.length) { projectFiles.push(file); continue; }
          const filtered = path.join(scratch, crypto.createHash("sha256").update(file).digest("hex") + ".jsonl");
          await fs.writeFile(filtered, await require("./subscription-account-transcripts").ownedTranscript({ trackerDir, id: account.id, file: path.join(runtimeHome, relative), ledger: inherited }), { mode: 0o600 });
          projectFiles.push(filtered);
        }
        await parseClaudeIncremental({ projectFiles, cursors, queuePath });
      } else {
        await parseRolloutIncremental({ rolloutFiles: [...new Set(safeFiles)], cursors, queuePath });
      }
      let raw = "";
      try { raw = await fs.readFile(queuePath, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
      const buckets = new Map();
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        buckets.set(JSON.stringify([row.source, row.model, row.hour_start]), row);
      }
      const daily = new Map();
      for (const row of buckets.values()) {
        const date = row.hour_start.slice(0, 10);
        const day = daily.get(date) || { date, totalTokens: 0, estimatedCostUsd: 0 };
        day.totalTokens += row.total_tokens || 0;
        day.estimatedCostUsd += computeRowCost(row);
        daily.set(date, day);
      }
      const days = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date));
      const usage = { scope: "isolated_account_home", totalTokens: days.reduce((n, d) => n + d.totalTokens, 0),
        estimatedCostUsd: days.reduce((n, d) => n + d.estimatedCostUsd, 0), daily: days,
        scannedAt: new Date().toISOString(), fileCount: safeFiles.length };
      await writeFileAtomic(cacheFile, JSON.stringify({ version: 1, signature: digest, identity: account.identity.key, usage }), { mode: 0o600 });
      return usage;
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
    } finally { await transferLock.release(); }
  });
}

async function getAccountLimits({ trackerDir, account, auth, forceRefresh = false, fetchImpl = fetch, now = Date.now() }) {
  if (!auth?.accessToken) return { configured: false, status: "credentials_unavailable" };
  if (!identityMatches(account, auth)) return { configured: false, status: "identity_mismatch" };
  const { dir } = accountPaths(trackerDir, account.id);
  return singleflight(`${dir}:limits:${auth.fingerprint}`, async () => {
    const cacheFile = path.join(dir, "limits.json");
    const stored = await readOptionalJson(cacheFile);
    const cached = stored?.fingerprint === auth.fingerprint ? stored : null;
    const base = { configured: true, plan_label: normalizePlanLabel(auth.identity.plan, account.provider), fetched_at: cached?.fetchedAt || null };
    if (auth.expiresAt && auth.expiresAt <= now + 60000) return { ...base, status: "auth_expired" };
    if (cached?.retryAt > now) return { ...base, ...cached.data, status: cached.status || "cooldown", stale: Boolean(cached.data), retry_at: cached.retryAt };
    if (!forceRefresh && cached?.expiresAt > now) return { ...base, ...cached.data, status: "ok" };
    const boundedFetch = (url, options) => fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(12000) });
    try {
      const data = account.provider === "claude"
        ? await fetchClaudeUsageLimits(auth.accessToken, { fetchImpl: boundedFetch, maxAttempts: 1 })
        : await fetchCodexUsageLimits(auth.accessToken, { fetchImpl: boundedFetch, accountId: auth.accountId, providerTimeoutMs: 14000 });
      if ([401, 403, 404].includes(data.upstream_status)) return { ...base, status: "auth_unavailable" };
      const ttl = account.provider === "claude" ? 600000 : 120000;
      const resets = Object.values(data).flatMap((v) => {
        const value = v?.resets_at ?? v?.reset_at;
        const time = typeof value === "number" ? value * 1000 : Date.parse(value);
        return time > now ? [time] : [];
      });
      const fetchedAt = new Date(now).toISOString();
      await writeFileAtomic(cacheFile, JSON.stringify({ fingerprint: auth.fingerprint, data, fetchedAt,
        expiresAt: Math.max(now + 5000, Math.min(now + ttl, ...resets)), retryAt: 0 }), { mode: 0o600 });
      return { ...base, ...data, fetched_at: fetchedAt, status: "ok" };
    } catch (error) {
      const status = error.code === "AUTH_EXPIRED" ? "auth_expired" : error.code === "RATE_LIMITED" ? "cooldown" : "unavailable";
      const retryAt = now + (status === "cooldown" ? Math.min(3600, Math.max(60, error.retryAfterSec || 300)) * 1000 : 60000);
      const data = status !== "auth_expired" && cached?.data && now - Date.parse(cached.fetchedAt) < 86400000 ? cached.data : null;
      await writeFileAtomic(cacheFile, JSON.stringify({ fingerprint: auth.fingerprint, data, fetchedAt: data ? cached.fetchedAt : null,
        expiresAt: 0, retryAt, status }), { mode: 0o600 });
      return { ...base, ...data, status, stale: Boolean(data), retry_at: retryAt };
    }
  });
}

async function accountDetails(options) {
  const { account } = options;
  if (account.invalidatedAt) return { usage: null, limits: null, status: "identity_mismatch" };
  const auth = await readAccountAuth(options);
  if (!account.identity) return { usage: null, limits: null, status: "login_required" };
  if (!identityMatches(account, auth)) {
    if (auth?.identity?.key) await invalidateAccount({ ...options, id: account.id });
    return { usage: null, limits: null, status: "identity_mismatch" };
  }
  const usage = await scanAccountUsage(options);
  const limits = await getAccountLimits({ ...options, auth });
  // Detect a login changed while scanning or fetching, too.
  const after = await readAccountAuth(options);
  if (!identityMatches(account, after)) {
    if (after?.identity?.key) await invalidateAccount({ ...options, id: account.id });
    return { usage: null, limits: null, status: "identity_mismatch" };
  }
  return { usage, limits, status: "ready" };
}

async function drainAccountWork(dir) {
  await Promise.allSettled([...flights.entries()].filter(([key]) => key.startsWith(dir + ":")).map(([, work]) => work));
}
module.exports = { scanAccountUsage, getAccountLimits, accountDetails, drainAccountWork };
