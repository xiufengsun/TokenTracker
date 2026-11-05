const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function cursorSessionPath({ home = os.homedir(), trackerDir } = {}) {
  return path.join(trackerDir || path.join(home, ".tokentracker", "tracker"), "cursor-session.json");
}

function normalizeCursorSubject(subject) {
  if (typeof subject !== "string") return null;
  const native = subject.match(/\|(user_[A-Za-z0-9_]+)$/);
  if (native) return native[1];
  return /^(google-oauth2|github|oidc|auth0)\|[^|\s;]+$/.test(subject) ? subject : null;
}

function cursorAuthFromToken(accessToken, nowMs = Date.now()) {
  if (typeof accessToken !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken)) return null;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    const userId = normalizeCursorSubject(payload.sub);
    if (!userId || !Number.isFinite(payload.exp) || payload.exp * 1000 <= nowMs + 60_000) return null;
    return {
      accessToken,
      userId,
      cookie: `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      source: "browser",
    };
  } catch {
    return null;
  }
}

function readCursorConnection(options = {}) {
  let raw;
  try {
    raw = fs.readFileSync(cursorSessionPath(options), "utf8");
  } catch (error) {
    return { status: error.code === "ENOENT" ? "disconnected" : "expired" };
  }
  try {
    const auth = cursorAuthFromToken(JSON.parse(raw).accessToken);
    return auth ? { status: "connected", auth } : { status: "expired" };
  } catch {
    return { status: "expired" };
  }
}

// Only TokenTracker's explicitly authorized access token is stored. The short
// synchronous commit keeps a cancelled/replaced login from writing afterwards.
function writeCursorSession(options, accessToken) {
  const target = cursorSessionPath(options);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ accessToken }) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function createCursorLogin({ trackerDir, home, fetchImpl = fetch, now = Date.now, validateSession } = {}) {
  const options = { trackerDir, home };
  let pending = null;

  function start() {
    const attemptId = crypto.randomUUID();
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const url = new URL("https://cursor.com/loginDeepControl");
    for (const [key, value] of Object.entries({ challenge, uuid: attemptId, mode: "login", redirectTarget: "cli", supportsSelectedTeamLogin: "true" })) {
      url.searchParams.set(key, value);
    }
    pending = { attemptId, verifier, expiresAt: now() + LOGIN_TIMEOUT_MS, promise: null };
    return { status: "pending", attemptId, authUrl: url.toString(), expiresAt: pending.expiresAt };
  }

  async function finishPoll(attempt) {
    const expired = () => pending !== attempt || now() >= attempt.expiresAt;
    try {
      const url = new URL("https://api2.cursor.sh/auth/poll");
      url.searchParams.set("uuid", attempt.attemptId);
      url.searchParams.set("verifier", attempt.verifier);
      const response = await fetchImpl(url.toString(), {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json" },
      });
      if (expired()) return { status: "expired" };
      if (response.status === 404) return { status: "pending" };
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) return { status: "pending" };
        pending = null;
        return { status: "failed" };
      }
      const body = await response.json();
      if (expired()) return { status: "expired" };
      const auth = cursorAuthFromToken(body?.accessToken, now());
      if (!auth) {
        pending = null;
        return { status: "failed" };
      }
      // A decoded JWT alone is not proof of a usable Cursor session.
      try {
        if (validateSession) await validateSession(auth);
        else await require("./cursor-config").fetchCursorUsageSummary({ cookie: auth.cookie, fetchImpl });
      } catch {
        if (pending === attempt) pending = null;
        return { status: "failed" };
      }
      if (expired()) return { status: "expired" };
      try { writeCursorSession(options, auth.accessToken); } catch {
        pending = null;
        return { status: "failed" };
      }
      pending = null;
      return { status: "connected", expiresAt: auth.expiresAt };
    } catch {
      return { status: expired() ? "expired" : "pending" };
    }
  }

  function poll(attemptId) {
    if (!pending || pending.attemptId !== attemptId || now() >= pending.expiresAt) {
      return Promise.resolve({ status: "expired" });
    }
    const attempt = pending;
    if (!attempt.promise) {
      attempt.promise = finishPoll(attempt).finally(() => { attempt.promise = null; });
    }
    return attempt.promise;
  }

  function cancel(attemptId) {
    if (pending?.attemptId === attemptId) pending = null;
    return { status: "cancelled" };
  }

  function disconnect() {
    pending = null;
    try { fs.unlinkSync(cursorSessionPath(options)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { status: "disconnected" };
  }

  function status() {
    const connection = readCursorConnection(options);
    return { status: connection.status, ...(connection.auth ? { expiresAt: connection.auth.expiresAt } : {}) };
  }

  return { start, poll, cancel, disconnect, status };
}

module.exports = { createCursorLogin, cursorSessionPath, readCursorConnection, normalizeCursorSubject };
