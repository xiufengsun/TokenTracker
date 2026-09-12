const { listAccounts, accountPaths } = require("./subscription-accounts");
const { readAccountAuth, identityMatches } = require("./subscription-account-auth");
const { getAccountLimits } = require("./subscription-account-usage");
const { inspectLock } = require("./fs");
const path = require("node:path");

function quotaAvailability(provider, limits, now = Date.now()) {
  if (limits?.status !== "ok" || limits.stale) return { state: "unknown", resetAt: null };
  const windows = provider === "claude" ? [limits.five_hour, limits.seven_day]
    : [limits.primary_window, limits.secondary_window];
  const usable = windows.filter(Boolean);
  if (!usable.length) return { state: "unknown", resetAt: null };
  const exhausted = [];
  for (const window of usable) {
    const used = provider === "claude" ? window.utilization : window.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used)) return { state: "unknown", resetAt: null };
    const raw = window.resets_at ?? window.reset_at;
    const reset = typeof raw === "number" ? raw * 1000 : Date.parse(raw);
    // A pre-reset snapshot cannot establish capacity after rollover.
    if (Number.isFinite(reset) && reset <= now) return { state: "unknown", resetAt: null };
    if (used >= 100) exhausted.push(Number.isFinite(reset) ? reset : null);
  }
  if (!exhausted.length) return { state: "available", resetAt: null };
  // Every exhausted window must recover; the latest reset is authoritative.
  return { state: "exhausted", resetAt: exhausted.every(Number.isFinite) ? Math.max(...exhausted) : null };
}

async function probeAccount({ trackerDir, account, forceRefresh = true }) {
  if (await require("./subscription-account-global").usesDefaultLogin({ trackerDir, account })) return { state: "busy", resetAt: null, reason: "default_account" };
  const lock = await inspectLock(path.join(accountPaths(trackerDir, account.id).dir, "runtime.lock"));
  if (lock.exists && lock.alive) return { state: "busy", resetAt: null };
  const auth = await readAccountAuth({ trackerDir, account });
  if (!identityMatches(account, auth)) return { state: "unknown", resetAt: null, reason: "identity_mismatch" };
  const limits = await getAccountLimits({ trackerDir, account, auth, forceRefresh });
  const availability = quotaAvailability(account.provider, limits);
  return availability.state === "unknown" ? { ...availability, reason: limits.status === "ok" ? "quota_unknown" : limits.status } : availability;
}

async function runAccountPool({ trackerDir, provider, args = [], nextLaunchOnly = false,
  probe = probeAccount, launch, report = (message) => process.stderr.write(message + "\n") }) {
  if (!["claude", "codex"].includes(provider)) throw new Error("Choose Claude or Codex");
  const { launchAccount, validateRunArgs } = require("../commands/accounts");
  validateRunArgs(args, provider);
  const execute = launch || launchAccount;
  const accounts = (await listAccounts({ trackerDir })).filter((a) => a.provider === provider && a.identity && !a.archived);
  if (!accounts.length) throw new Error("No signed-in accounts in this provider's pool");
  const resets = [];
  let lastStatus = 1;
  // Each account is attempted at most once, in the user's account-list order.
  // General errors, Ctrl-C and successful completion never trigger rotation.
  for (const account of accounts) {
    let availability;
    try { availability = await probe({ trackerDir, account }); }
    catch { availability = { state: "unknown" }; }
    if (availability.state !== "available") {
      if (availability.resetAt) resets.push(availability.resetAt);
      report(`Skipping ${account.label}: ${availability.state}`);
      continue;
    }
    report(`Using ${provider} account: ${account.label}`);
    lastStatus = await execute({ trackerDir, id: account.id, args });
    if (lastStatus === 0 || lastStatus === 130 || lastStatus === 143 || nextLaunchOnly) return lastStatus;
    let after;
    try { after = await probe({ trackerDir, account }); } catch { return lastStatus; }
    if (after.state !== "exhausted") return lastStatus;
    if (after.resetAt) resets.push(after.resetAt);
    report(`${account.label} has exhausted its quota. Starting the next account as a new session; previous context is not transferred.`);
  }
  const soonest = resets.length ? new Date(Math.min(...resets)).toLocaleString() : null;
  report(soonest ? `No eligible accounts. Earliest known quota reset: ${soonest}` : "No eligible accounts. Check account logins and quota availability.");
  return lastStatus || 1;
}

module.exports = { quotaAvailability, probeAccount, runAccountPool };
