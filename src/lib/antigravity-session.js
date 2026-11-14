"use strict";

// Antigravity Sessions uses the same parser as hourly Usage. Only scalar usage,
// event types/times, explicit workspace metadata and cascade ids leave this module.
const fs = require("node:fs");
const path = require("node:path");
const { parseAntigravityFile, resolveAntigravityDbPath, listAntigravityTranscriptsWithStatus } = require("./rollout");
const { readAntigravityNativeSession } = require("./antigravity-native");

const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const empty = () => Object.fromEntries(TOKEN_FIELDS.map((key) => [key, 0]));
function add(target, value) {
  for (const key of TOKEN_FIELDS) target[key] += Number(value[key]) || 0;
}

function identity(file) {
  const match = file.match(/[/\\]((?:antigravity)(?:-ide|-cli|-insiders)?)[/\\](?:brain[/\\]([^/\\]+)|conversations[/\\]([^/\\]+)\.db)/);
  if (!match) throw new Error("Unrecognized Antigravity session path");
  return { variant: match[1], id: match[2] || match[3] };
}

function antigravitySessionDependencies(files) {
  return [...new Set(files.flatMap((file) => {
    const db = resolveAntigravityDbPath(file);
    const root = db && path.dirname(path.dirname(db));
    return [file, db, db && `${db}-wal`, root && path.join(root, "settings.json"),
      root && path.basename(root) === "antigravity-cli" && path.join(root, "cache", "last_conversations.json")].filter(Boolean);
  }))];
}

async function discoverAntigravitySessions(roots, incomplete, knownFiles = null) {
  const known = knownFiles instanceof Set ? knownFiles : new Set(knownFiles || []);
  const found = [];
  for (const root of roots) {
    const inventory = await listAntigravityTranscriptsWithStatus(root, known);
    found.push(...inventory.files);
    if (!inventory.complete) incomplete.push({ path: root, error: "ANTIGRAVITY_INVENTORY_INCOMPLETE" });
  }
  return [...new Set(found)].sort();
}

async function readAntigravitySessions(files) {
  const rows = [];
  const seen = new Set();
  for (const file of [...new Set(files)]) {
    const { variant, id } = identity(file);
    const key = `${variant}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const db = resolveAntigravityDbPath(file);
    const native = db && fs.existsSync(db) ? await readAntigravityNativeSession(db) : null;
    const events = [];
    const transcript = file.endsWith(".db") ? null : await fs.promises.readFile(file);
    const result = await parseAntigravityFile({ filePath: file, rawBuffer: transcript,
      applyBuckets: false, source: "antigravity", onUsage: (event) => events.push(event) });
    // A database read failure must retain the previous complete sidecar, rather
    // than replacing reported usage with a text-length estimate.
    if (db && fs.existsSync(db) && !result.dbReadOk) throw new Error("Antigravity database is unavailable");
    let cwd = native?.cwd || null;
    if (!cwd && variant === "antigravity-cli") {
      const cliRoot = path.dirname(path.dirname(db));
      const cachePath = path.join(cliRoot, "cache", "last_conversations.json");
      try {
        const cache = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
        if (cache && typeof cache === "object" && !Array.isArray(cache)) {
          cwd = Object.keys(cache).find((directory) =>
            (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory)) && cache[directory] === id) || null;
        }
      } catch {
        // This optional index only supplies a display path. Its absence,
        // permissions or partial write do not invalidate native token counters.
      }
    }
    const times = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
    let turns = 0;
    if (transcript) {
      for (const line of transcript.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        let event;
        try { event = JSON.parse(line); } catch {
          // Match the Usage parser's readable prefix. An active writer may
          // finish this record later; a changed file will invalidate the cache.
          break;
        }
        const at = Date.parse(event.created_at);
        if (Number.isFinite(at)) times.push(at);
        if (event.type === "USER_INPUT") turns++;
      }
    }
    if (!times.length) times.push(Date.parse(native?.createdAt) || fs.statSync(file).mtimeMs);
    let startedAt = times[0], endedAt = times[0];
    for (const at of times) {
      startedAt = Math.min(startedAt, at);
      endedAt = Math.max(endedAt, at);
    }
    const tokens = empty(), models = new Map(), buckets = new Map();
    for (const event of events) {
      add(tokens, event);
      const model = models.get(event.model) || { model: event.model, ...empty(), usage_events: 0 };
      add(model, event); model.usage_events++;
      models.set(event.model, model);
      const at = new Date(Math.floor(Date.parse(event.timestamp) / 60_000) * 60_000).toISOString();
      const bucketKey = `${at}|${event.model}`;
      const bucket = buckets.get(bucketKey) || { timestamp: at, model: event.model, ...empty() };
      add(bucket, event); buckets.set(bucketKey, bucket);
    }
    const reported = events.length > 0 && events.every((event) => event.usage_precision === "reported");
    rows.push({
      identity: key, files: [...new Set([file, db, db && `${db}-wal`].filter(Boolean))],
      session_id: id, antigravity_variant: variant,
      title: null, project_ref: cwd, tokens, model_usage: [...models.values()],
      ...(events.length ? { usage_buckets: [...buckets.values()] } : {}),
      model: models.size > 1 ? "mixed" : [...models.keys()][0] || "unknown",
      started_at: new Date(startedAt).toISOString(), ended_at: new Date(endedAt).toISOString(),
      // Event timestamps establish a wall-clock span, not active work or API latency.
      active_ms: 0, turns, edit_turns: 0, retry_turns: 0, subagent_calls: 0,
      usage_events: events.length, model_calls: events.length,
      usage_precision: !events.length ? "unavailable" : reported ? "reported"
        : events.some((event) => event.usage_precision === "reported") ? "mixed" : "estimated",
      usage_is_incomplete: !reported, cost_source: "model_pricing",
      provenance: { source: "local-session-metadata", confidence: reported ? "observed" : "partial",
        content_retained: false, retry_confidence: "unavailable", timing: native?.timestampEstimated ? "estimated" : "observed" },
    });
  }
  return rows;
}

module.exports = { discoverAntigravitySessions, antigravitySessionDependencies, readAntigravitySessions };
