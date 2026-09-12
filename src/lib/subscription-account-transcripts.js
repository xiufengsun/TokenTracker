const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { accountPaths, readOptionalJson, privateDirectory } = require("./subscription-accounts");
const { writeFileAtomic, openLock } = require("./fs");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");

async function safePath(home, relative, create = false) {
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) throw new Error("Invalid transcript path");
  let current = home;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
    if (!(await fs.lstat(current)).isDirectory()) throw new Error("Unsafe transcript directory");
  }
  const file = path.join(home, relative);
  try { if (!(await fs.lstat(file)).isFile()) throw new Error("Unsafe transcript file"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  return file;
}

async function transcriptFiles(home, sessionId) {
  if (!UUID.test(sessionId)) throw new Error("Invalid conversation ID");
  const root = path.join(home, "projects");
  let projects;
  try { if (!(await fs.lstat(root)).isDirectory()) throw new Error("Unsafe projects directory"); projects = await fs.readdir(root, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const files = [];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(home, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Linked conversation files are unsupported");
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(next);
      if (files.length > 1000) throw new Error("Conversation is too large to transfer");
    }
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const relative = path.join("projects", project.name, sessionId + ".jsonl");
    try { await fs.access(await safePath(home, relative)); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    files.push(relative);
    const related = path.join("projects", project.name, sessionId);
    try { if (!(await fs.lstat(path.join(home, related))).isDirectory()) throw new Error("Unsafe conversation directory"); await walk(related); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return files;
}

// Opaque local copies only: never expose conversation bodies through the API or
// telemetry. Exclusion ranges record only offsets and hashes, not message text.
async function transferClaudeSession({ trackerDir, from, to, sessionId }) {
  const source = accountPaths(trackerDir, from);
  const target = accountPaths(trackerDir, to);
  let lock;
  for (let attempt = 0; attempt < 50; attempt++) {
    lock = await openLock(path.join(target.dir, "usage-transfer.lock"), { quietIfLocked: true });
    if (lock) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!lock) throw new Error("Account usage is being updated; retry switching");
  try {
  const files = await transcriptFiles(source.runtimeHome, sessionId);
  const ledgerPath = path.join(target.dir, "inherited-usage.json");
  const ledger = await readOptionalJson(ledgerPath) || {};
  const transfers = [];
  for (const relative of files) {
    const sourceFile = await safePath(source.runtimeHome, relative);
    if ((await fs.stat(sourceFile)).size > 64 * 1024 * 1024) throw new Error("Conversation is too large to transfer");
    const content = await fs.readFile(sourceFile);
    // A graceful stop must have finished writing the last JSONL record.
    if (content.length && content.at(-1) !== 10) throw new Error("Conversation is still being saved");
    const targetFile = await safePath(target.runtimeHome, relative, true);
    let existing = Buffer.alloc(0);
    try { existing = await fs.readFile(targetFile); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!content.subarray(0, existing.length).equals(existing)) throw new Error("Conversation histories diverged; the original session is preserved");
    const ranges = ledger[relative] || [];
    if (content.length > existing.length) ranges.push({ start: existing.length, end: content.length, hash: hash(content.subarray(existing.length)) });
    ledger[relative] = ranges;
    transfers.push({ targetFile, content });
  }
  // Publish exclusions first. A crash can temporarily withhold usage, never
  // attribute another account's history or lose the source conversation.
  await writeFileAtomic(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
  for (const { targetFile, content } of transfers) {
    await privateDirectory(path.dirname(targetFile));
    await writeFileAtomic(targetFile, content, { mode: 0o600 });
  }
  return files.length > 0;
  } finally { await lock.release(); }
}

async function ownedTranscript({ trackerDir, id, file, ledger }) {
  const { dir, runtimeHome } = accountPaths(trackerDir, id);
  const relative = path.relative(runtimeHome, file);
  const content = await fs.readFile(await safePath(runtimeHome, relative));
  const ranges = (ledger || await readOptionalJson(path.join(dir, "inherited-usage.json")) || {})[relative] || [];
  const chunks = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start < offset || range.end > content.length || hash(content.subarray(range.start, range.end)) !== range.hash) throw new Error("Conversation attribution needs recovery");
    chunks.push(content.subarray(offset, range.start)); offset = range.end;
  }
  chunks.push(content.subarray(offset));
  return Buffer.concat(chunks);
}

module.exports = { transferClaudeSession, ownedTranscript, transcriptFiles };
