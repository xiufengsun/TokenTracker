const fssync = require("node:fs");
const path = require("node:path");

const DEFAULT_EXEC_OPTS = { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] };

let _cachedDistros = null;
let _cachedDistrosError = null;
const _cachedWslUsers = new Map();
const _cachedWslUserErrors = new Map();

function resetWslProbeCache() {
  _cachedDistros = null;
  _cachedDistrosError = null;
  _cachedWslUsers.clear();
  _cachedWslUserErrors.clear();
}

const WSL_MODES = new Set([
  "wsl-first",
  "native-first",
  "wsl-only",
  "native-only",
  "both",
]);

function defaultRunWsl(args, { utf16 = false } = {}) {
  const { execFileSync } = require("node:child_process");
  const buf = execFileSync("wsl.exe", args, DEFAULT_EXEC_OPTS);
  return utf16 ? buf.toString("utf16le") : buf.toString("utf8");
}

function cleanWslOutput(raw) {
  return raw.replace(/\0/g, "").replace(/\uFEFF/g, "").trim();
}

function parseWslListVerbose(raw) {
  if (typeof raw !== "string") return [];
  const distros = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = cleanWslOutput(line);
    if (!clean) continue;
    const cells = clean.split(/\s+/);
    let isDefault = false;
    let idx = 0;
    if (cells[0] === "*") {
      isDefault = true;
      idx = 1;
    }
    const name = cells[idx];
    if (!name || name === "NAME") continue;
    const version = parseInt(cells[cells.length - 1], 10);
    distros.push({ name, version: Number.isFinite(version) ? version : null, isDefault });
  }
  return distros;
}

function probeWslDistros(deps = {}) {
  const strict = deps.strict === true;
  const hasDeps = Object.keys(deps).some((key) => key !== "strict");
  // Legacy callers retain their fail-safe cache. Strict observers may reuse
  // successful empty results, but must retry a failure cached by any caller.
  if (!hasDeps && _cachedDistros && (!strict || !_cachedDistrosError)) return _cachedDistros;
  const runWsl = deps.runWsl || defaultRunWsl;
  let raw;
  try {
    raw = runWsl(["-l", "-v"], { utf16: true });
  } catch (error) {
    let confirmedEmpty = false;
    if (
      strict && Number.isInteger(error?.status) && error.status !== 0 &&
      error.signal == null && (error.code == null || error.code === error.status)
    ) {
      // Some WSL builds exit nonzero for an empty verbose list. Confirm that
      // case with a successful empty quiet list, not localized diagnostic text.
      // Transport/permission/signal failures must never reach this fallback.
      try {
        const quiet = runWsl(["-l", "-q"], { utf16: true });
        confirmedEmpty = typeof quiet === "string" && cleanWslOutput(quiet) === "";
      } catch (_quietError) { }
    }
    if (!hasDeps) {
      _cachedDistros = [];
      _cachedDistrosError = confirmedEmpty ? null : error;
    }
    // ENOENT confirms wsl.exe is not installed. A failed invocation of an
    // existing executable is not evidence of an empty distro list.
    if (strict && error?.code !== "ENOENT" && !confirmedEmpty) throw error;
    return [];
  }
  const distros = parseWslListVerbose(raw);
  const sorted = distros.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
  if (!hasDeps) {
    _cachedDistros = sorted;
    _cachedDistrosError = null;
  }
  return sorted;
}

function normalizeWslMode(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
}

function getWslMode(env = process.env) {
  const raw = normalizeWslMode(env.TOKENTRACKER_WSL_MODE);
  return WSL_MODES.has(raw) ? raw : "wsl-first";
}

function isInvalidWslMode(env = process.env) {
  const value = env.TOKENTRACKER_WSL_MODE;
  if (value == null || String(value).trim() === "") return false;
  return !WSL_MODES.has(normalizeWslMode(value));
}

function shouldProbeWsl(env = process.env) {
  return getWslMode(env) !== "native-only";
}

function shouldProbeNative(env = process.env) {
  return getWslMode(env) !== "wsl-only";
}

function pickWin32Path({
  wslValue,
  nativeValue,
  env = process.env,
  platform = process.platform,
}) {
  if (platform !== "win32") return null;

  const mode = getWslMode(env);

  if (mode === "both") return wslValue ?? nativeValue ?? null;
  if (mode === "wsl-only") return wslValue ?? null;
  if (mode === "native-only") return nativeValue ?? null;
  if (mode === "native-first") return nativeValue ?? wslValue ?? null;

  return wslValue ?? nativeValue ?? null;
}

function resolveAllWin32Paths({
  nativeValue,
  wslValue,
  env = process.env,
  platform = process.platform,
}) {
  if (platform !== "win32") return { native: null, wsl: null };

  const mode = getWslMode(env);

  if (mode === "both") {
    return { native: nativeValue ?? null, wsl: wslValue ?? null };
  }

  const single = pickWin32Path({ wslValue, nativeValue, env, platform });
  return { native: single, wsl: null };
}

function lookupWslUser(distroName, runWsl, useCache, strict = false) {
  if (useCache && _cachedWslUsers.has(distroName) && (!strict || !_cachedWslUserErrors.has(distroName))) {
    return _cachedWslUsers.get(distroName);
  }
  let user = "";
  let error = null;
  try {
    user = String(runWsl(["-d", distroName, "-e", "whoami"], { utf16: false }) || "").trim();
    if (!user) error = Object.assign(new Error("WSL identity probe returned no user"), { code: "EWSLIDENTITY" });
  } catch (cause) { error = cause; }
  if (useCache) {
    _cachedWslUsers.set(distroName, user);
    if (error) _cachedWslUserErrors.set(distroName, error);
    else _cachedWslUserErrors.delete(distroName);
  }
  if (strict && error) throw error;
  return user;
}

function discoverWslHome(providerDir, deps = {}) {
  if (!shouldProbeWsl(deps.env)) return null;

  const runWsl = deps.runWsl || defaultRunWsl;
  const existsSync = deps.existsSync || fssync.existsSync;
  const strict = deps.strict === true;
  const distros = deps.runWsl
    ? probeWslDistros({ runWsl: deps.runWsl, strict })
    : probeWslDistros(strict ? { strict } : undefined);
  const useCache = !deps.runWsl;
  for (const distro of distros) {
    const user = lookupWslUser(distro.name, runWsl, useCache, strict);
    if (!user) continue;
    const roots = distro.version === 1
      ? ["\\\\wsl.localhost\\", "\\\\wsl$\\"]
      : ["\\\\wsl$\\", "\\\\wsl.localhost\\"];
    for (const root of roots) {
      const candidate = `${root}${distro.name}\\home\\${user}\\${providerDir}`;
      try {
        if (existsSync(candidate)) return candidate;
      } catch (_e) { }
    }
  }
  return null;
}

function isUncPath(p) {
  return typeof p === "string" && (p.startsWith("\\\\") || p.startsWith("//"));
}

const WSL_UNC_ROOT_RE = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)[\\/]/i;
const WINDOWS_DRIVE_PREFIX_RE = /^\/[A-Za-z]:[\\/]/;

// `\\wsl$\Ubuntu-24.04\home\u\...` -> `\\wsl$\Ubuntu-24.04\`. Returns null for
// native and non-WSL UNC paths.
function wslUncRoot(p) {
  if (typeof p !== "string") return null;
  const match = WSL_UNC_ROOT_RE.exec(p);
  return match ? `\\\\${match[1]}\\${match[2]}\\` : null;
}

// A WSL session records its cwd as a POSIX path (`/home/u/dev/app`) while the
// transcript itself is read over the distro's UNC bridge. Probing that raw
// POSIX path from Windows resolves it against the current drive
// (`C:\home\u\dev\app`), which never exists — so project attribution finds no
// `.git`, and every WSL session ends up with a null projectKey (#374).
// Re-anchor the cwd onto the UNC prefix the transcript came from.
//
// The prefix is taken from the transcript path rather than re-probed, which
// also picks whichever of `\\wsl$` / `\\wsl.localhost` actually resolves on
// this machine — they are not interchangeable everywhere. Anything that isn't
// a POSIX cwd from a WSL-hosted file is returned untouched.
function mapWslCwdToUnc(cwd, transcriptPath) {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return cwd;
  // `new URL("file:///C:/dev/app").pathname` is "/C:/dev/app" — a leading
  // slash, but a Windows path rather than a POSIX one. Qoder feeds exactly
  // that shape in via `project_uri`; re-anchoring it would invent
  // `\\wsl$\Distro\C:\dev\app`.
  if (WINDOWS_DRIVE_PREFIX_RE.test(cwd)) return cwd;
  const root = wslUncRoot(transcriptPath);
  if (!root) return cwd;
  return root + cwd.slice(1).replaceAll("/", "\\");
}

function snapshotSqliteDb(dbPath) {
  const tmpRoot = fssync.mkdtempSync(
    path.join(require("node:os").tmpdir(), "tokentracker-wsl-snap-"),
  );
  const target = path.join(tmpRoot, path.basename(dbPath));
  fssync.copyFileSync(dbPath, target);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const src = dbPath + suffix;
    try {
      if (fssync.existsSync(src)) fssync.copyFileSync(src, target + suffix);
    } catch (_e) { }
  }
  return {
    path: target,
    cleanup() {
      try { fssync.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) { }
    },
  };
}

module.exports = {
  defaultRunWsl,
  parseWslListVerbose,
  probeWslDistros,
  resetWslProbeCache,
  discoverWslHome,
  isUncPath,
  wslUncRoot,
  mapWslCwdToUnc,
  snapshotSqliteDb,
  getWslMode,
  isInvalidWslMode,
  shouldProbeWsl,
  shouldProbeNative,
  pickWin32Path,
  resolveAllWin32Paths,
  normalizeWslMode,
};
