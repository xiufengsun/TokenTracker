const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const wsl = require("./wsl-probe");

// `union` (opt-in): return BOTH qualifying installs instead of a single pick.
// The mode knob then means priority, not exclusivity — `wsl-first` orders the
// roots, it does not delete the native install's usage (#27: a populated WSL
// ~/.codex silently evicted the Windows install from collection, so the session
// browser listed sessions whose tokens never reached the dashboard). The
// *-only modes stay exclusive for free: their excluded side is already null'd
// by the shouldProbe* guards below, so union returns exactly one root there.
//
// Only providers whose parser dedups by a path-independent identity may opt in
// — the same session reachable under two path spellings (a WSL $HOME mounted
// on the Windows profile) must collapse, not double-count. Codex qualifies via
// its sessionUUID:eventTimestamp event dedup; Claude does the same union by
// hand in sync.js with file-hash + message-hash dedup behind it.
function resolveInstallPaths({ nativeValue, wslDir, wslValue, requireAnyChild, union } = {}, env = process.env, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== "win32") {
    return { native: nativeValue ?? null, wsl: null };
  }

  // requireAnyChild (opt-in): a candidate install must hold at least one of
  // the named children (e.g. "sessions"/"archived_sessions") to qualify — an
  // empty shell dir must not shadow a populated install. For wslDir discovery
  // the check is folded into the existsSync probe so discoverWslHome skips an
  // empty-shell distro and continues to the next one.
  const populated = (p) => !requireAnyChild || hasAnyChild(p, requireAnyChild, deps.existsSync);
  const wslExists = requireAnyChild
    ? (p) => Boolean(pathExists(p, deps.existsSync)) && hasAnyChild(p, requireAnyChild, deps.existsSync)
    : deps.existsSync;
  const wslCandidate = wslValue !== undefined
    ? (wsl.shouldProbeWsl(env) && pathExists(wslValue, deps.existsSync) && populated(wslValue) ? wslValue : null)
    : (wslDir && wsl.shouldProbeWsl(env) ? wsl.discoverWslHome(wslDir, { ...deps, env, existsSync: wslExists }) : null);
  const nativeCandidate = wsl.shouldProbeNative(env) && nativeValue && populated(nativeValue)
    ? pathExists(nativeValue, deps.existsSync) : null;

  // Native first: the cross-root dedup keeps whichever copy is parsed first,
  // so the native install stays primary (matching the Claude union).
  if (union) return { native: nativeCandidate, wsl: wslCandidate };

  return wsl.resolveAllWin32Paths({ nativeValue: nativeCandidate, wslValue: wslCandidate, env, platform });
}

function pathExists(p, existsSync) {
  if (typeof p !== "string" || !p) return null;
  try { return (existsSync || fssync.existsSync)(p) ? p : null; } catch (_e) { return null; }
}

// ZCode stores its CLI DB under the user's home dir on every platform
// (~/.zcode/cli/db/db.sqlite), Windows included. The win32 APPDATA guess
// (introduced with the WSL dual-install work) silently missed the native
// install, so probe home first and keep APPDATA only as a fallback for
// installs that do live under Roaming. Falls back to the home path when
// neither exists so resolveInstallPaths can null it uniformly.
function resolveZcodeNativeDbPath({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  deps = {},
} = {}) {
  const existsSync = deps.existsSync || fssync.existsSync;
  const zcodeHomeOverride =
    typeof env.ZCODE_HOME === "string" ? env.ZCODE_HOME.trim() : "";
  const zcodeHome = zcodeHomeOverride
    ? path.resolve(zcodeHomeOverride)
    : path.join(home, ".zcode");
  // An explicit ZCODE_HOME pins the install: when its database is missing we
  // must not fall back to an APPDATA database, or sync could read a different
  // ZCode installation than the one the user pointed at.
  const candidates = [
    path.join(zcodeHome, "cli", "db", "db.sqlite"),
    ...(!zcodeHomeOverride &&
    platform === "win32" &&
    typeof env.APPDATA === "string" &&
    env.APPDATA.trim()
      ? [path.join(env.APPDATA.trim(), ".zcode", "cli", "db", "db.sqlite")]
      : []),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

// mimocode (the engine behind the Xiaomi MiMo desktop app and the mimocode CLI)
// is an OpenCode fork and keeps OpenCode's data-dir rule on every platform:
// XDG_DATA_HOME, else ~/.local/share — on Windows too, where that means
// %USERPROFILE%\.local\share\mimocode\mimocode.db (#629). The %APPDATA%
// location was our guess before a Windows install was seen; keep it as a
// fallback so an install that does live there is not lost.
function resolveMimoNativeDbPath({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  deps = {},
} = {}) {
  const existsSync = deps.existsSync || fssync.existsSync;
  const mimoHomeOverride = typeof env.MIMO_HOME === "string" ? env.MIMO_HOME.trim() : "";
  if (mimoHomeOverride) {
    // An explicit MIMO_HOME pins the install, same rule as ZCODE_HOME above.
    return path.join(path.resolve(mimoHomeOverride), "mimocode.db");
  }
  const xdgDataHome = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(home, ".local", "share");
  const candidates = [
    path.join(xdgDataHome, "mimocode", "mimocode.db"),
    ...(platform === "win32" && typeof env.APPDATA === "string" && env.APPDATA.trim()
      ? [path.join(env.APPDATA.trim(), "mimocode", "mimocode.db")]
      : []),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

function hasAnyChild(p, children, existsSync) {
  const ex = existsSync || fssync.existsSync;
  return children.some((c) => { try { return ex(path.join(p, c)); } catch (_e) { return false; } });
}

// Migrate a flat (single-install) cursor to { native, wsl } namespaces.
// `activeKeys` names the namespaces seeded with a copy of the flat state; the
// others start empty so their install's full history backfills on first parse.
// Leaving a namespace empty is only safe when its install was NEVER counted
// under the flat cursor — the flat state holds the per-session dedup maps, and
// an already-counted install re-parsed without them double-counts everything.
// Callers that cannot prove which install the flat cursor tracked must seed
// ALL namespaces (the default): bounded backfill loss, never a double count.
function ensureNamespacedCursors(cursors, providerName, activeKeys = ["native", "wsl"]) {
  const state = cursors[providerName] && typeof cursors[providerName] === "object" ? cursors[providerName] : {};

  if (state.native !== undefined || state.wsl !== undefined) {
    return state;
  }

  const keys = Array.isArray(activeKeys) ? activeKeys : [activeKeys];
  cursors[providerName] = { native: {}, wsl: {} };
  if (Object.keys(state).length > 0) {
    for (const key of keys) {
      cursors[providerName][key] = JSON.parse(JSON.stringify(state));
    }
  }
  return cursors[providerName];
}

// Collapse { native, wsl } namespaces back into a flat cursor when only one
// install remains. `preferredKey` names the SURVIVING install's namespace —
// its keys must win the merge, otherwise the vanished install's cursor
// (lastDbId watermarks, dedup maps) is donated to the survivor and its next
// parse double-counts everything past the foreign cursor. Callers that don't
// know the survivor fall back to the mode preference (legacy behavior).
function ensureFlatCursor(cursors, providerName, env, preferredKey) {
  const state = cursors[providerName];
  if (!state || typeof state !== "object") return;
  if (state.native === undefined && state.wsl === undefined) return;

  const mode = wsl.getWslMode(env || process.env);
  const preferWsl = preferredKey === "wsl" || preferredKey === "native"
    ? preferredKey === "wsl"
    : mode === "wsl-first" || mode === "wsl-only";
  const merged = preferWsl ? { ...state.native, ...state.wsl } : { ...state.wsl, ...state.native };
  cursors[providerName] = merged;
}

module.exports = {
  resolveInstallPaths,
  resolveZcodeNativeDbPath,
  resolveMimoNativeDbPath,
  ensureNamespacedCursors,
  ensureFlatCursor,
};
