const fs = require("node:fs/promises");
const path = require("node:path");

const { ensureDir, readJson, writeJson } = require("./fs");

// Build the notify command Codex/Every Code exec on turn end. `/usr/bin/env` is
// not executable on native Windows, so the wrapper never launches notify.cjs
// (issue #361). On Windows, invoke the running Node executable directly.
function buildCodexNotifyCmd(
  notifyPath,
  { platform = process.platform, execPath = process.execPath } = {},
) {
  return platform === "win32"
    ? [execPath, notifyPath]
    : ["/usr/bin/env", "node", notifyPath];
}

function buildEveryCodeNotifyCmd(notifyPath, options) {
  return [...buildCodexNotifyCmd(notifyPath, options), "--source=every-code"];
}

function buildAcodeNotifyCmd(notifyPath, options) {
  return [...buildCodexNotifyCmd(notifyPath, options), "--source=acode"];
}

// Is this notify command one we wrote? Strict array equality is not a safe
// test, because the command is not a stable constant across invocations:
//   - argv[0] on Windows is an absolute `process.execPath` (#361). The desktop
//     app runs the bundled EmbeddedServer\node.exe, `tokentracker` in a
//     terminal runs the system / nvm Node, and an nvm version switch moves it
//     again. All three write a different argv[0] on the same machine.
//   - the notify.cjs path itself varies with binDir (npm global vs embedded).
// Under strict equality our own command reads as a stranger's: `status` reports
// the integration as not configured (pushing the user to re-run setup), and
// `uninstall` skips it as `current-not-managed`, leaving a dead notify entry
// that points at a deleted app directory and fails on every Codex turn.
// Match on the notify.cjs tail instead — the path must live under
// ~/.tokentracker/, and the args after it must match so the Codex command is
// never confused with the Every Code one (`--source=every-code`).
function isManagedNotifyCmd(cmd, expectedNotify) {
  if (!Array.isArray(cmd)) return false;
  if (arraysEqual(cmd, expectedNotify)) return true;

  const notifyIndexOf = (parts) =>
    parts.findIndex(
      (part) =>
        typeof part === "string" && part.replace(/\\/g, "/").endsWith("notify.cjs"),
    );

  const index = notifyIndexOf(cmd);
  if (index === -1) return false;
  if (!cmd[index].replace(/\\/g, "/").includes("/.tokentracker/")) return false;

  if (!Array.isArray(expectedNotify)) return true;
  const expectedIndex = notifyIndexOf(expectedNotify);
  if (expectedIndex === -1) return true;
  return arraysEqual(cmd.slice(index + 1), expectedNotify.slice(expectedIndex + 1));
}

async function upsertNotify({
  configPath,
  notifyCmd,
  notifyOriginalPath,
  configLabel,
  captureOriginal = true,
  replaceOriginal = false,
}) {
  const originalText = await fs.readFile(configPath, "utf8").catch(() => null);
  if (originalText == null) {
    const label =
      typeof configLabel === "string" && configLabel.length > 0 ? configLabel : "Config";
    throw new Error(`${label} not found: ${configPath}`);
  }

  const existingNotify = extractNotify(originalText);
  const already = arraysEqual(existingNotify, notifyCmd);

  if (!already) {
    // Persist original notify once (for uninstall + chaining). When a caller
    // asks to replace the stored original and the config has no notify, record
    // that absence so uninstall does not resurrect a stale backup.
    // A command of ours that merely went stale (different argv[0] / binDir —
    // see isManagedNotifyCmd) is NOT the user's original: recording it would
    // make uninstall "restore" our own dead command forever. Treat it as an
    // absence instead. Reachable when the backup file is gone but the config
    // entry is not, e.g. after the user deletes ~/.tokentracker.
    const hasForeignNotify =
      Array.isArray(existingNotify) && !isManagedNotifyCmd(existingNotify, notifyCmd);
    if (captureOriginal && (hasForeignNotify || replaceOriginal)) {
      await ensureDir(path.dirname(notifyOriginalPath));
      const existing = await readJson(notifyOriginalPath);
      if (replaceOriginal || !existing) {
        await writeJson(notifyOriginalPath, {
          notify: hasForeignNotify ? existingNotify : null,
          capturedAt: new Date().toISOString(),
        });
      }
    }

    const updated = setNotify(originalText, notifyCmd);
    const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(configPath, backupPath);
    await fs.writeFile(configPath, updated, "utf8");
    return { changed: true, backupPath };
  }

  return { changed: false, backupPath: null };
}

async function restoreNotify({ configPath, notifyOriginalPath, expectedNotify }) {
  const text = await fs.readFile(configPath, "utf8").catch(() => null);
  if (text == null) return { restored: false, skippedReason: "config-missing" };

  const original = await readJson(notifyOriginalPath);
  const originalNotify = Array.isArray(original?.notify) ? original.notify : null;
  const currentNotify = extractNotify(text);

  if (!originalNotify && expectedNotify && currentNotify == null) {
    return { restored: false, skippedReason: "no-backup-not-installed" };
  }

  if (expectedNotify && !isManagedNotifyCmd(currentNotify, expectedNotify)) {
    return { restored: false, skippedReason: "current-not-managed" };
  }

  const updated = originalNotify ? setNotify(text, originalNotify) : removeNotify(text);
  if (updated === text) return { restored: false, skippedReason: "no-change" };

  const backupPath = `${configPath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(configPath, backupPath).catch(() => {});
  await fs.writeFile(configPath, updated, "utf8");
  return { restored: true, skippedReason: null };
}

async function loadNotifyOriginal(notifyOriginalPath) {
  const original = await readJson(notifyOriginalPath);
  return Array.isArray(original?.notify) ? original.notify : null;
}

async function readNotify(configPath) {
  const text = await fs.readFile(configPath, "utf8").catch(() => null);
  if (text == null) return null;
  return extractNotify(text);
}

async function upsertCodexNotify({
  codexConfigPath,
  notifyCmd,
  notifyOriginalPath,
  captureOriginal = true,
  replaceOriginal = false,
}) {
  return upsertNotify({
    configPath: codexConfigPath,
    notifyCmd,
    notifyOriginalPath,
    configLabel: "Codex config",
    captureOriginal,
    replaceOriginal,
  });
}

async function restoreCodexNotify({ codexConfigPath, notifyOriginalPath, notifyCmd }) {
  return restoreNotify({
    configPath: codexConfigPath,
    notifyOriginalPath,
    expectedNotify: notifyCmd,
  });
}

async function loadCodexNotifyOriginal(notifyOriginalPath) {
  return loadNotifyOriginal(notifyOriginalPath);
}

async function readCodexNotify(codexConfigPath) {
  return readNotify(codexConfigPath);
}

async function upsertAcodeNotify({
  acodeConfigPath,
  notifyCmd,
  notifyOriginalPath,
  captureOriginal = true,
  replaceOriginal = false,
}) {
  return upsertNotify({
    configPath: acodeConfigPath,
    notifyCmd,
    notifyOriginalPath,
    configLabel: "AStudio config",
    captureOriginal,
    replaceOriginal,
  });
}

async function restoreAcodeNotify({ acodeConfigPath, notifyOriginalPath, notifyCmd }) {
  return restoreNotify({
    configPath: acodeConfigPath,
    notifyOriginalPath,
    expectedNotify: notifyCmd,
  });
}

async function loadAcodeNotifyOriginal(notifyOriginalPath) {
  return loadNotifyOriginal(notifyOriginalPath);
}

async function readAcodeNotify(acodeConfigPath) {
  return readNotify(acodeConfigPath);
}

async function upsertEveryCodeNotify({
  codeConfigPath,
  notifyCmd,
  notifyOriginalPath,
  captureOriginal = true,
  replaceOriginal = false,
}) {
  return upsertNotify({
    configPath: codeConfigPath,
    notifyCmd,
    notifyOriginalPath,
    configLabel: "Every Code config",
    captureOriginal,
    replaceOriginal,
  });
}

async function restoreEveryCodeNotify({ codeConfigPath, notifyOriginalPath, notifyCmd }) {
  return restoreNotify({
    configPath: codeConfigPath,
    notifyOriginalPath,
    expectedNotify: notifyCmd,
  });
}

async function loadEveryCodeNotifyOriginal(notifyOriginalPath) {
  return loadNotifyOriginal(notifyOriginalPath);
}

async function readEveryCodeNotify(codeConfigPath) {
  return readNotify(codeConfigPath);
}

function extractNotify(text) {
  // Heuristic parse: find a line that starts with "notify =".
  // Supports single-line arrays:
  // - notify = ["a", "b"]
  // And multi-line arrays:
  // - notify = [
  //     "a",
  //     "b"
  //   ]
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTomlTableHeader(line)) break;
    const m = line.match(/^\s*notify\s*=\s*(.*)\s*$/);
    if (!m) continue;

    const rhs = (m[1] || "").trim();
    const literal = readTomlArrayLiteral(lines, i, rhs);
    if (!literal) return null;

    const parsed = parseTomlStringArray(literal);
    return parsed;
  }
  return null;
}

function setNotify(text, notifyCmd) {
  const lines = text.split(/\r?\n/);
  const notifyLine = `notify = ${formatTomlStringArray(notifyCmd)}`;

  const out = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTomlTableHeader(line)) {
      if (!replaced) {
        out.push(notifyLine);
        replaced = true;
      }
      out.push(...lines.slice(i));
      break;
    }
    const m = line.match(/^\s*notify\s*=\s*(.*)\s*$/);
    if (m) {
      if (!replaced) {
        out.push(notifyLine);
        replaced = true;
      }

      const rhs = (m[1] || "").trim();
      i = findNotifyBlockEnd(lines, i, rhs);
      continue;
    }
    out.push(line);
  }

  if (!replaced) {
    // Insert at top-level, before the first table header.
    const firstTableIdx = out.findIndex((l) => /^\s*\[/.test(l));
    const headerIdx = firstTableIdx === -1 ? out.length : firstTableIdx;
    out.splice(headerIdx, 0, notifyLine);
  }

  return out.join("\n").replace(/\n+$/, "\n");
}

function removeNotify(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTomlTableHeader(line)) {
      out.push(...lines.slice(i));
      break;
    }
    const m = line.match(/^\s*notify\s*=\s*(.*)\s*$/);
    if (m) {
      const rhs = (m[1] || "").trim();
      i = findNotifyBlockEnd(lines, i, rhs);
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n+$/, "\n");
}

function parseTomlStringArray(rhs) {
  // Minimal parser for TOML basic/literal string arrays.
  if (!rhs.startsWith("[") || !rhs.endsWith("]")) return null;

  const parts = [];
  let i = 1;
  let expectValue = true;

  function skipSpaceAndComments() {
    while (i < rhs.length) {
      const ch = rhs[i];
      if (/\s/.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === "#") {
        while (i < rhs.length && rhs[i] !== "\n") i += 1;
        continue;
      }
      break;
    }
  }

  function parseString() {
    const quote = rhs[i];
    if (quote !== '"' && quote !== "'") return null;
    i += 1;
    let value = "";
    while (i < rhs.length) {
      const ch = rhs[i];
      if (ch === quote) {
        i += 1;
        return value;
      }
      if (ch === "\n" || ch === "\r") return null;
      if (quote === '"' && ch === "\\") {
        if (i + 1 >= rhs.length) return null;
        const next = rhs[i + 1];
        if (next === "b") value += "\b";
        else if (next === "t") value += "\t";
        else if (next === "n") value += "\n";
        else if (next === "f") value += "\f";
        else if (next === "r") value += "\r";
        else if (next === '"' || next === "\\" || next === "/") value += next;
        else return null;
        i += 2;
        continue;
      }
      value += ch;
      i += 1;
    }
    return null;
  }

  while (i < rhs.length) {
    skipSpaceAndComments();
    if (rhs[i] === "]") {
      i += 1;
      skipSpaceAndComments();
      return i === rhs.length ? parts : null;
    }
    if (!expectValue) {
      if (rhs[i] !== ",") return null;
      i += 1;
      expectValue = true;
      continue;
    }

    const value = parseString();
    if (value == null) return null;
    parts.push(value);
    expectValue = false;
  }

  return null;
}

function formatTomlStringArray(arr) {
  return `[${arr.map((s) => JSON.stringify(String(s))).join(", ")}]`;
}

function readTomlArrayLiteral(lines, startIndex, rhs) {
  const first = rhs.trim();
  if (!first.startsWith("[")) return null;

  let inString = false;
  let quote = null;
  let depth = 0;
  let sawOpen = false;
  let invalid = false;

  function scanChunk(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (!inString) {
        if (ch === '"' || ch === "'") {
          inString = true;
          quote = ch;
          continue;
        }
        if (ch === "[") {
          depth += 1;
          sawOpen = true;
          continue;
        }
        if (ch === "]") {
          depth -= 1;
          if (sawOpen && depth === 0) {
            if (!isTomlArrayTrailer(chunk.slice(i + 1))) invalid = true;
            return i;
          }
        }
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        if (i + 1 >= chunk.length) {
          invalid = true;
          return -1;
        }
        i += 1;
      }
    }
    return -1;
  }

  const parts = [first];
  let endPos = scanChunk(first);
  if (invalid) return null;
  if (endPos !== -1) return first.slice(0, endPos + 1).trim();

  for (let j = startIndex + 1; j < lines.length; j++) {
    const line = lines[j];
    endPos = scanChunk(line);
    if (invalid) return null;
    if (endPos !== -1) {
      parts.push(line.slice(0, endPos + 1));
      return parts.join("\n").trim();
    }
    parts.push(line);
  }

  return null;
}

function findTomlArrayBlockEnd(lines, startIndex, rhs) {
  const first = rhs.trim();
  if (!first.startsWith("[")) return startIndex;

  let inString = false;
  let quote = null;
  let depth = 0;
  let sawOpen = false;
  let invalid = false;

  function scanChunk(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (!inString) {
        if (ch === '"' || ch === "'") {
          inString = true;
          quote = ch;
          continue;
        }
        if (ch === "[") {
          depth += 1;
          sawOpen = true;
          continue;
        }
        if (ch === "]") {
          depth -= 1;
          if (sawOpen && depth === 0) {
            if (!isTomlArrayTrailer(chunk.slice(i + 1))) invalid = true;
            return true;
          }
        }
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        if (i + 1 >= chunk.length) {
          invalid = true;
          return false;
        }
        i += 1;
      }
    }
    return false;
  }

  if (scanChunk(first)) return startIndex;
  if (invalid) return startIndex;
  for (let j = startIndex + 1; j < lines.length; j++) {
    if (scanChunk(lines[j])) return j;
    if (invalid) return startIndex;
  }
  return startIndex;
}

function findNotifyBlockEnd(lines, startIndex, rhs) {
  const endIndex = findTomlArrayBlockEnd(lines, startIndex, rhs);
  const literal = readTomlArrayLiteral(lines, startIndex, rhs);
  if (
    endIndex !== startIndex ||
    !rhs.trim().startsWith("[") ||
    (literal && parseTomlStringArray(literal))
  ) {
    return endIndex;
  }

  for (let j = startIndex + 1; j < lines.length; j++) {
    if (isTopLevelTomlBoundary(lines[j])) return j - 1;
  }
  return lines.length - 1;
}

function isTomlTableHeader(line) {
  return /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line);
}

function isTopLevelTomlBoundary(line) {
  return /^\s*(?:\[\[?[^\]]+\]\]?|(?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]+"|'[^']+'))*\s*=)/.test(line);
}

function isTomlArrayTrailer(text) {
  return /^\s*(?:#.*)?$/.test(text);
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

module.exports = {
  buildCodexNotifyCmd,
  buildAcodeNotifyCmd,
  buildEveryCodeNotifyCmd,
  isManagedNotifyCmd,
  upsertNotify,
  restoreNotify,
  loadNotifyOriginal,
  readNotify,
  upsertCodexNotify,
  restoreCodexNotify,
  loadCodexNotifyOriginal,
  readCodexNotify,
  upsertAcodeNotify,
  restoreAcodeNotify,
  loadAcodeNotifyOriginal,
  readAcodeNotify,
  upsertEveryCodeNotify,
  restoreEveryCodeNotify,
  loadEveryCodeNotifyOriginal,
  readEveryCodeNotify,
};
