const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { privateDirectory, readOptionalJson, getAccount } = require("./subscription-accounts");
const { writeFileAtomic, openLock } = require("./fs");

function sessionPaths(trackerDir, id) {
  if (!/^[a-f0-9]{32}$/.test(id || "")) throw new Error("Invalid session ID");
  const dir = path.join(trackerDir, "subscription-accounts", "sessions", id);
  return { dir, status: path.join(dir, "status.json"), request: path.join(dir, "request.json") };
}
async function writeSession(trackerDir, session) {
  await writeFileAtomic(sessionPaths(trackerDir, session.id).status, JSON.stringify(session), { mode: 0o600 });
}
async function createSession({ trackerDir, accountId, provider, cwd, auto }) {
  const session = { id: crypto.randomBytes(16).toString("hex"), conversationId: crypto.randomUUID(), provider,
    accountId, cwd, auto, state: "starting", createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  await privateDirectory(sessionPaths(trackerDir, session.id).dir);
  await writeSession(trackerDir, session);
  return session;
}
async function readSession({ trackerDir, sessionId }) {
  const session = await readOptionalJson(sessionPaths(trackerDir, sessionId).status);
  if (!session || session.id !== sessionId) throw new Error("Session not found");
  if (["starting", "running", "switching"].includes(session.state)) {
    if (Date.now() - Date.parse(session.heartbeatAt) > (session.state === "starting" ? 60000 : 15000)) session.state = "disconnected";
    if (session.pid) try { process.kill(session.pid, 0); } catch { session.state = "disconnected"; }
  }
  return session;
}
async function listSessions({ trackerDir }) {
  const root = path.join(trackerDir, "subscription-accounts", "sessions");
  let entries;
  try { entries = await fs.readdir(root); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const sessions = [];
  for (const id of entries.filter((v) => /^[a-f0-9]{32}$/.test(v))) {
    try { sessions.push(await readSession({ trackerDir, sessionId: id })); } catch { /* damaged receipt */ }
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
}
async function requestSwitch({ trackerDir, sessionId, accountId, auto }) {
  const paths = sessionPaths(trackerDir, sessionId);
  const lock = await openLock(path.join(paths.dir, "request.lock"), { quietIfLocked: true });
  if (!lock) throw new Error("Session is already switching");
  try {
    const session = await readSession({ trackerDir, sessionId });
    if (session.provider !== "claude" || session.state !== "running") throw new Error("Choose a running managed Claude session");
    if (auto !== undefined) {
      if (typeof auto !== "boolean" || accountId !== undefined) throw new Error("Invalid rotation setting");
    } else {
      const account = await getAccount({ trackerDir, id: accountId });
      if (account.provider !== session.provider || !account.identity || account.archived || account.invalidatedAt || account.id === session.accountId) throw new Error("Choose another signed-in account");
    }
    const pending = await readOptionalJson(paths.request);
    if (pending && Date.now() - pending.createdAt < 30000) throw new Error("Session is already switching");
    const request = { id: crypto.randomBytes(16).toString("hex"), ...(auto === undefined ? { accountId } : { auto }), createdAt: Date.now() };
    await writeFileAtomic(paths.request, JSON.stringify(request), { mode: 0o600 });
    return { status: "requested", requestId: request.id };
  } finally { await lock.release(); }
}
module.exports = { sessionPaths, createSession, writeSession, readSession, listSessions, requestSwitch };
