const wsl = require("./wsl-probe");
const { ensureNamespacedCursors, ensureFlatCursor } = require("./install-resolver");

function emptyResult() {
  return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0 };
}

async function multiInstallParse({ paths, parserFn, providerName, cursors, getParams, onProgress, detectInstall, ...shared }) {
  const installKeys = Object.keys(paths).filter(k => paths[k]);
  if (installKeys.length === 0) return emptyResult();
  const env = shared.env || process.env;

  if (installKeys.length === 1) {
    // Flatten toward the SURVIVING install's namespace, not the mode
    // preference: under wsl-first a vanished WSL install (deleted distro,
    // transient wsl.exe probe failure) must not donate its cursor to the
    // remaining native install. Non-both modes park the pick in the `native`
    // slot regardless of identity, so the slot name is unreliable — WSL
    // installs are always addressed via UNC paths, which identifies the
    // survivor directly.
    const survivorKey = wsl.isUncPath(paths[installKeys[0]]) ? "wsl" : "native";
    ensureFlatCursor(cursors, providerName, env, survivorKey);
    return await parserFn({
      ...getParams(paths[installKeys[0]], installKeys[0]),
      ...shared,
      cursors,
      onProgress,
    });
  }

  const activeKeys = resolveMigrationSeedKeys({ paths, installKeys, providerName, cursors, detectInstall });
  const ns = ensureNamespacedCursors(cursors, providerName, activeKeys);
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  let bucketsQueued = 0;

  for (let i = 0; i < installKeys.length; i++) {
    const key = installKeys[i];
    cursors[providerName] = ns[key];
    try {
      const result = await parserFn({
        ...getParams(paths[key], key), ...shared, cursors,
        onProgress: wrapProgress(onProgress, key),
      });
      ns[key] = cursors[providerName];
      recordsProcessed += result.recordsProcessed || 0;
      eventsAggregated += result.eventsAggregated || 0;
      bucketsQueued += result.bucketsQueued || 0;
    } catch (parseErr) {
      if (parseErr?.code !== "TOKENTRACKER_CURSOR_STORE_RETRY") {
        cursors[providerName] = ns;
      }
      throw parseErr;
    }
  }
  cursors[providerName] = ns;

  return { recordsProcessed, eventsAggregated, bucketsQueued };
}

// Decide which namespaces the one-time flat→namespaced cursor migration seeds
// with the flat state. `detectInstall(installPath, flatState, installKey)` is
// a provider-specific probe answering "does this install's DB contain the
// flat cursor's session ids?". Only when EXACTLY ONE install matches do we
// know who owned the flat cursor — the other namespace then starts empty so
// its full history backfills. No probe, no match, multiple matches, or a
// probe error all fall back to seeding every namespace: an install re-parsed
// without its dedup state would double-count its entire history, and a
// bounded backfill gap is the cheaper failure.
function resolveMigrationSeedKeys({ paths, installKeys, providerName, cursors, detectInstall }) {
  if (typeof detectInstall !== "function") return installKeys;
  const state = cursors[providerName] && typeof cursors[providerName] === "object" ? cursors[providerName] : {};
  const isFlat = state.native === undefined && state.wsl === undefined;
  if (!isFlat || Object.keys(state).length === 0) return installKeys;

  const hits = [];
  for (const key of installKeys) {
    let owns = false;
    try {
      owns = detectInstall(paths[key], state, key) === true;
    } catch (_e) { }
    if (owns) hits.push(key);
  }
  return hits.length === 1 ? hits : installKeys;
}

function wrapProgress(onProgress, installKey) {
  if (!onProgress) return undefined;
  return (p) => onProgress({ ...p, install: installKey });
}

function mergeBothFileSources({ resolveFiles, env }) {
  const isBoth = process.platform === "win32" && wsl.getWslMode(env) === "both";
  if (!isBoth) {
    const files = resolveFiles(env);
    return files;
  }

  const nativeEnv = { ...env, TOKENTRACKER_WSL_MODE: "native-only" };
  const wslEnv = { ...env, TOKENTRACKER_WSL_MODE: "wsl-only" };

  const nativeFiles = resolveFiles(nativeEnv);
  const wslFiles = resolveFiles(wslEnv);

  const seen = new Set();
  const merged = [];
  for (const f of [...nativeFiles, ...wslFiles]) {
    if (!seen.has(f)) { seen.add(f); merged.push(f); }
  }
  return merged;
}

module.exports = { multiInstallParse, emptyResult, mergeBothFileSources };
