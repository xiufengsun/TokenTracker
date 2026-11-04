// Local-only accounting provenance. Never infer historical routing from current config.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function backendFromUrl(value) {
  try {
    if (typeof value !== "string" || !value.trim()) return { backend: "unknown" };
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return { backend: "unknown" };
    const backend_origin = url.origin;
    return { backend: backend_origin === "https://api.anthropic.com" ? "anthropic" : "custom", backend_origin };
  } catch { return { backend: "unknown" }; }
}

// Hash only the enclosed bytes, in bounded chunks. Persist no transcript text.
function hashClaudeRange(filePath, start, end) {
  const fs = require("node:fs");
  const hash = require("node:crypto").createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (let offset = start; offset < end;) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (!read) return null;
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}

// Embedded verbatim in the dependency-free notify script. Read ONLY the endpoint
// env var; never credentials. Hash paths/session IDs and discard the hook body.
function captureClaudeBackend(trackerDir, payload, env = process.env) {
  const fs = require("node:fs");
  const path = require("node:path");
  const crypto = require("node:crypto");
  const event = payload?.hook_event_name;
  if (!["SessionStart", "Stop", "SessionEnd"].includes(event)) return;
  if (typeof payload.transcript_path !== "string" || typeof payload.session_id !== "string" || !payload.session_id) return;
  const identity = backendFromUrl(env.ANTHROPIC_BASE_URL);
  const dir = path.join(trackerDir, "claude-backends");
  const file = crypto.createHash("sha256").update(path.resolve(payload.transcript_path)).digest("hex");
  const session = crypto.createHash("sha256").update(String(payload.session_id)).digest("hex");
  let stat;
  try { stat = fs.statSync(payload.transcript_path); } catch {
    if (event !== "SessionStart") return;
  }
  const observation = { event, session, inode: stat?.ino || 0, offset: stat?.size || 0, ...identity };
  const anchorPath = path.join(dir, file + ".current.json");
  let previous;
  try { previous = JSON.parse(fs.readFileSync(anchorPath, "utf8")); } catch { /* first observation */ }
  if (event === "Stop" && previous?.session === session && previous.event !== "SessionEnd"
      && previous.backend_origin && previous.backend_origin === identity.backend_origin
      && previous.offset < observation.offset) {
    observation.range_hash = hashClaudeRange(payload.transcript_path, previous.offset, observation.offset);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, file + ".jsonl"), JSON.stringify(observation) + "\n", { mode: 0o600 });
  fs.writeFileSync(anchorPath, JSON.stringify(observation), { mode: 0o600 });
  fs.writeFileSync(path.join(trackerDir, "claude-backend-current.json"), JSON.stringify(identity), { mode: 0o600 });
}

function readLines(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }); } catch { return []; }
}

function createBackendResolver(filePath, trackerDir) {
  const key = crypto.createHash("sha256").update(path.resolve(filePath)).digest("hex");
  const dir = path.join(trackerDir, "claude-backends");
  const ledger = path.join(dir, key + ".usage.jsonl");
  const decisions = new Map();
  let decisionOffset = 0;
  function refreshDecisions() {
    let fd;
    try {
      fd = fs.openSync(ledger, "r");
      const size = fs.fstatSync(fd).size;
      if (size <= decisionOffset) return;
      const bytes = Buffer.alloc(size - decisionOffset);
      fs.readSync(fd, bytes, 0, bytes.length, decisionOffset);
      // Only consume complete append records, including another scanner's.
      const boundary = bytes.lastIndexOf(10) + 1;
      for (const line of bytes.subarray(0, boundary).toString("utf8").split("\n")) {
        try {
          const row = JSON.parse(line);
          if (!decisions.has(row.id)) decisions.set(row.id, row);
        } catch { /* incomplete/corrupt record */ }
      }
      decisionOffset += boundary;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  refreshDecisions();
  const observations = readLines(path.join(dir, key + ".jsonl"));
  const fileStat = fs.statSync(filePath);
  const inode = fileStat.ino;
  const intervals = [];
  let previous = null;
  for (const current of observations) {
    if (current.event === "Stop" && previous && previous.event !== "SessionEnd"
      && current.session === previous.session && current.inode === inode
      && (previous.inode === inode || (previous.event === "SessionStart" && previous.offset === 0))
      && current.offset > previous.offset && current.offset <= fileStat.size) {
      const a = backendFromUrl(previous.backend_origin);
      const b = backendFromUrl(current.backend_origin);
      if (a.backend_origin && a.backend_origin === b.backend_origin) {
        intervals.push({ start: previous.offset, end: current.offset, session: current.session, hash: current.range_hash, ...a });
      }
    }
    previous = current;
  }
  // A missed Stop must not bridge multiple turns. Only inspect ranges actually
  // bracketed by observations; no prompts or message bodies leave this function.
  function validInterval(interval) {
    if (interval.valid !== undefined) return interval.valid;
    interval.valid = false;
    const fd = fs.openSync(filePath, "r");
    try {
      const bytes = Buffer.alloc(interval.end - interval.start);
      fs.readSync(fd, bytes, 0, bytes.length, interval.start);
      if (!interval.hash || crypto.createHash("sha256").update(bytes).digest("hex") !== interval.hash) return false;
      let turns = 0;
      for (const line of bytes.toString("utf8").split("\n")) {
        try {
          const row = JSON.parse(line);
          const content = row.message?.content;
          if (row.type === "user" && (typeof content === "string" || content?.some?.((b) => b.type === "text"))) turns++;
        } catch { /* partial boundary / non-JSON */ }
      }
      interval.valid = turns === 1;
      return interval.valid;
    } finally { fs.closeSync(fd); }
  }
  return (obj, start, end) => {
    const id = crypto.createHash("sha256").update(JSON.stringify([
      obj.sessionId, obj.uuid, obj.requestId, obj.message?.id, obj.timestamp, start, end,
    ])).digest("hex");
    const saved = decisions.get(id);
    if (saved) return backendFromUrl(saved.backend_origin);
    const session = typeof obj.sessionId === "string"
      ? crypto.createHash("sha256").update(obj.sessionId).digest("hex") : null;
    const matches = intervals.filter((i) => i.session === session && start >= i.start && end <= i.end && validInterval(i));
    const identity = matches.length === 1 ? backendFromUrl(matches[0].backend_origin) : { backend: "unknown" };
    // First ingestion wins, including unknown. Late hooks cannot relabel usage.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(ledger, JSON.stringify({ id, ...identity }) + "\n", { mode: 0o600 });
    // Sync and session analytics can run concurrently. O_APPEND orders these
    // small records; read that order so the first durable decision always wins.
    refreshDecisions();
    return backendFromUrl(decisions.get(id)?.backend_origin);
  };
}

// Byte offsets, including CRLF and multibyte text, must agree with hook stat sizes.
async function* claudeLines(filePath, start = 0, end = undefined) {
  const input = fs.createReadStream(filePath, { start, ...(end > start ? { end: end - 1 } : {}) });
  let pending = Buffer.alloc(0);
  let offset = start;
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const next = offset + newline + 1;
      yield { line: pending.subarray(0, newline).toString("utf8"), start: offset, end: next };
      offset = next;
      pending = pending.subarray(newline + 1);
    }
  }
  // Preserve complete legacy files without a final newline; defer partial JSON.
  if (pending.length) {
    try { JSON.parse(pending.toString("utf8")); } catch { return; }
    yield { line: pending.toString("utf8"), start: offset, end: offset + pending.length };
  }
}

const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
function mergeBackendUsage(target, delta) {
  if (!Array.isArray(delta?.backend_usage)) return;
  target.backend_usage ||= [];
  for (const part of delta.backend_usage) {
    const identity = backendFromUrl(part.backend_origin);
    let row = target.backend_usage.find((r) => r.backend === identity.backend && r.backend_origin === identity.backend_origin);
    if (!row) { row = { ...identity }; target.backend_usage.push(row); }
    for (const field of TOKEN_FIELDS) row[field] = (row[field] || 0) + (Number(part[field]) || 0);
  }
}
function hasUnknownBackendCost(row) {
  return row?.source === "claude" && row.backend_usage?.some((p) => p.backend !== "anthropic" && p.total_tokens > 0);
}
function readCustomBackend({ home, env = process.env }) {
  // Current configuration is ONLY for the limits card, never usage attribution.
  let configured = env.ANTHROPIC_BASE_URL;
  if (!configured) {
    try { configured = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "settings.json"), "utf8"))?.env?.ANTHROPIC_BASE_URL; } catch { /* absent */ }
  }
  if (configured) return backendFromUrl(configured);
  try {
    const observed = JSON.parse(fs.readFileSync(path.join(home, ".tokentracker", "tracker", "claude-backend-current.json"), "utf8"));
    return backendFromUrl(observed.backend_origin);
  } catch { return { backend: "unknown" }; }
}

module.exports = { hashClaudeRange, claudeLines, backendFromUrl, captureClaudeBackend, createBackendResolver, mergeBackendUsage, hasUnknownBackendCost, readCustomBackend, TOKEN_FIELDS };
