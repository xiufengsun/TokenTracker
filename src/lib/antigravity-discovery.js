"use strict";

// Bounded discovery of Antigravity (`agy`) session roots that live outside
// `~/.gemini`. TokenTracker already parses transcripts + SQLite metadata under
// an `antigravity-acp` layout; this module finds those roots automatically.
//
// Default T3 Code pattern (issue #1124):
//   ~/.t3/userdata/providers/antigravity/<profile-id>/antigravity-acp/brain
//
// TOKENTRACKER_T3_HOME relocates the T3 state directory (the `.t3` root).
// Extra search parents can be passed in for a WSL T3 home or a non-default
// host. Discovery never walks the rest of the filesystem.

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { shouldProbeNative } = require("./wsl-probe");

const T3_ANTIGRAVITY_REL = path.join("userdata", "providers", "antigravity");
const ACP_BRAIN_REL = path.join("antigravity-acp", "brain");

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function expandHome(value, home) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text === "~") return path.resolve(home);
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.resolve(home, text.slice(2));
  }
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(home, text);
}

function resolveT3Home({ home = os.homedir(), env = process.env } = {}) {
  const override = trimmed(env?.TOKENTRACKER_T3_HOME);
  if (override) return expandHome(override, home);
  return path.join(home, ".t3");
}

function resolveT3AntigravityParent(options = {}) {
  return path.join(resolveT3Home(options), T3_ANTIGRAVITY_REL);
}

function realpathOrSelf(target) {
  try {
    return fssync.realpathSync(target);
  } catch (_err) {
    return path.resolve(target);
  }
}

function pathWithin(filePath, root) {
  if (typeof filePath !== "string" || typeof root !== "string") return false;
  const relative = path.relative(root, filePath);
  return Boolean(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
  );
}

async function discoverT3AntigravityBrainDirs({
  home = os.homedir(),
  env = process.env,
  parents = null,
  platform = process.platform,
} = {}) {
  const searchParents = [];
  const seenParents = new Set();
  const addParent = (dir) => {
    if (!dir || typeof dir !== "string") return;
    const resolved = path.resolve(dir);
    const key = realpathOrSelf(resolved);
    if (seenParents.has(key)) return;
    seenParents.add(key);
    searchParents.push(resolved);
  };

  if (platform !== "win32" || shouldProbeNative(env)) {
    addParent(resolveT3AntigravityParent({ home, env }));
  }
  if (Array.isArray(parents)) {
    for (const parent of parents) addParent(parent);
  }

  const seenBrains = new Set();
  const brainDirs = [];
  const reports = [];

  for (const parent of searchParents) {
    let entries;
    try {
      entries = await fs.readdir(parent, { withFileTypes: true });
    } catch (err) {
      reports.push({
        path: parent,
        state: err?.code === "ENOENT" ? "absent" : "unreadable",
        error: err?.code || err?.message || "error",
        brainDirs: [],
      });
      continue;
    }

    const profileBrainDirs = [];
    for (const entry of entries) {
      const brainDir = path.join(parent, entry.name, ACP_BRAIN_REL);
      let st;
      try {
        st = await fs.stat(brainDir);
      } catch (err) {
        if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
          reports.push({ path: brainDir, state: "unreadable", error: err?.code || "error", brainDirs: [] });
        }
        continue;
      }
      if (!st.isDirectory()) continue;
      const key = realpathOrSelf(brainDir);
      if (seenBrains.has(key)) continue;
      seenBrains.add(key);
      profileBrainDirs.push(brainDir);
    }

    profileBrainDirs.sort((a, b) => a.localeCompare(b));
    brainDirs.push(...profileBrainDirs);
    reports.push({
      path: parent,
      state: profileBrainDirs.length > 0 ? "ok" : "empty",
      brainDirs: profileBrainDirs,
    });
  }

  brainDirs.sort((a, b) => a.localeCompare(b));
  return { brainDirs, reports };
}

function hostDiscoveryIncomplete(reports, knownFiles = null) {
  const known = knownFiles instanceof Set ? knownFiles : new Set(knownFiles || []);
  for (const report of reports || []) {
    if (report.state === "unreadable") return true;
    // A previously tracked profile can disappear even while its parent and
    // other profiles remain readable. Do not reconcile away its ledger.
    const tracked = Array.from(known).filter((filePath) => pathWithin(filePath, report.path));
    if (tracked.some((filePath) => !(report.brainDirs || []).some((root) => pathWithin(filePath, root)))) {
      return true;
    }
  }
  // WSL home discovery may fail before it can produce a parent report. A
  // previously tracked T3 root without any coverage is not a complete scan.
  for (const filePath of known) {
    if (!/[\\/]userdata[\\/]providers[\\/]antigravity[\\/]/.test(filePath)) continue;
    if (!(reports || []).some((report) => pathWithin(filePath, report.path))) return true;
  }
  return false;
}

// Compare the combined native/WSL/T3 inventory by physical path, retaining
// the existing cursor's spelling so adding an alias does not replay usage.
function mergeAntigravityInventories(inventories, knownFiles = null) {
  const knownByRealpath = new Map();
  for (const filePath of knownFiles || []) {
    const key = realpathOrSelf(filePath);
    if (!knownByRealpath.has(key)) knownByRealpath.set(key, filePath);
  }
  const files = new Map();
  for (const inventory of inventories || []) {
    for (const filePath of inventory.files || []) {
      const key = realpathOrSelf(filePath);
      if (!files.has(key)) files.set(key, knownByRealpath.get(key) || filePath);
    }
  }
  return Array.from(files.values());
}

function formatAntigravityHostStatus(reports) {
  const lines = [];
  for (const report of reports || []) {
    if (report.state === "absent") continue;
    if (report.state === "unreadable") {
      lines.push(`T3 parent unreadable (${report.path}: ${report.error || "error"})`);
      continue;
    }
    if (report.state === "empty") {
      lines.push(`T3 parent empty (${report.path})`);
      continue;
    }
    for (const brainDir of report.brainDirs || []) {
      // Report the antigravity-acp root (parent of brain/), which is the
      // profile root users recognize.
      lines.push(`T3: ${path.dirname(brainDir)}`);
    }
  }
  return lines;
}

module.exports = {
  ACP_BRAIN_REL,
  T3_ANTIGRAVITY_REL,
  discoverT3AntigravityBrainDirs,
  formatAntigravityHostStatus,
  hostDiscoveryIncomplete,
  mergeAntigravityInventories,
  pathWithin,
  resolveT3AntigravityParent,
  resolveT3Home,
};
