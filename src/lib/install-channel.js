"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_NAME = "tokentracker-cli";
const BREW_FORMULA = "xiufengsun/tokentracker/tokentracker";
const RELEASES_URL = "https://github.com/xiufengsun/TokenTracker/releases/latest";

const UPDATE_ACTIONS = {
  npm: { bin: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`] },
  bun: { bin: "bun", args: ["install", "-g", `${PACKAGE_NAME}@latest`] },
  pnpm: { bin: "pnpm", args: ["add", "-g", `${PACKAGE_NAME}@latest`] },
  yarn: { bin: "yarn", args: ["global", "add", `${PACKAGE_NAME}@latest`] },
  brew: { bin: "brew", args: ["upgrade", BREW_FORMULA] },
};

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function resolveEntryPath(entryPath, realpathSync) {
  if (typeof entryPath !== "string" || !entryPath.trim()) return "";
  const resolved = path.resolve(entryPath.trim());
  try {
    return realpathSync(resolved);
  } catch (_err) {
    return resolved;
  }
}

function isDesktopPath(posixLower) {
  return /(^|\/)embeddedserver(\/|$)/.test(posixLower);
}

function isBrewFormulaPath(posixLower) {
  if (/\/cellar\/tokentracker\//.test(posixLower)) return true;
  const homebrewish =
    posixLower.includes("/homebrew/") ||
    posixLower.includes("/linuxbrew/") ||
    posixLower.startsWith("/usr/local/opt/tokentracker");
  return homebrewish && /\/opt\/tokentracker(\/|$)/.test(posixLower);
}

function isNpxPath(posixLower) {
  return /\/_npx\//.test(posixLower);
}

function isBunPath(posixLower) {
  return posixLower.includes("/.bun/install/global/") || posixLower.includes("/.bun/bin/");
}

function isPnpmPath(posixLower) {
  return posixLower.includes("/.pnpm/") || /\/pnpm\/global\//.test(posixLower);
}

function isYarnGlobalPath(posixLower) {
  return posixLower.includes("/yarn/global/");
}

function isNpmPackagePath(posixLower) {
  return posixLower.includes(`/node_modules/${PACKAGE_NAME}/`);
}

function findSourceTree(entryPath, existsSync, readFileSync) {
  if (!entryPath) return null;
  let dir = path.dirname(path.resolve(entryPath));
  const { root } = path.parse(dir);
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    const cliPath = path.join(dir, "src", "cli.js");
    if (existsSync(pkgPath) && existsSync(cliPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg && pkg.name === PACKAGE_NAME) {
          return {
            root: dir,
            git: existsSync(path.join(dir, ".git")),
          };
        }
      } catch (_err) {
        // Unreadable or invalid package.json — keep walking.
      }
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function formatCommandLine(action) {
  if (!action || typeof action.bin !== "string") return "";
  const args = Array.isArray(action.args) ? action.args : [];
  return [action.bin, ...args].join(" ");
}

function unmanagedReason({ method, entryPath, sourceRoot, git }) {
  if (method === "npx") {
    return (
      `This TokenTracker was launched via npx (${entryPath}). ` +
      `Re-run \`npx ${PACKAGE_NAME}@latest\`, or install a managed copy with \`npm i -g ${PACKAGE_NAME}\`.`
    );
  }
  if (method === "desktop") {
    return (
      `This TokenTracker is bundled inside the desktop app (${entryPath}). ` +
      `Use the app's built-in updater, or download a new build from ${RELEASES_URL}`
    );
  }
  if (sourceRoot && git) {
    return (
      `Could not detect a managed install (npm, bun, pnpm, yarn, or Homebrew) at ${entryPath}. ` +
      `This looks like a git checkout at ${sourceRoot}. ` +
      `Update it the same way you installed it (for example \`git -C ${sourceRoot} pull\`); ` +
      `TokenTracker will not switch install methods.`
    );
  }
  if (sourceRoot) {
    return (
      `Could not detect a managed install (npm, bun, pnpm, yarn, or Homebrew) at ${entryPath}. ` +
      `This looks like a source tree at ${sourceRoot}. ` +
      `Update it the same way you installed it; TokenTracker will not switch install methods.`
    );
  }
  return (
    `Could not detect a managed install (npm, bun, pnpm, yarn, or Homebrew) at ${entryPath || "(unknown path)"}. ` +
    `Update TokenTracker the same way you installed it. See https://github.com/xiufengsun/TokenTracker#quick-start`
  );
}

function detectInstallChannel({
  entryPath = process.argv[1],
  realpathSync,
  existsSync,
  readFileSync,
} = {}) {
  const resolveReal = typeof realpathSync === "function" ? realpathSync : fs.realpathSync;
  const exists = typeof existsSync === "function" ? existsSync : fs.existsSync;
  const readFile = typeof readFileSync === "function" ? readFileSync : fs.readFileSync;
  const resolved = resolveEntryPath(entryPath, resolveReal);
  const posixLower = toPosix(resolved).toLowerCase();

  let method = "other";
  if (isDesktopPath(posixLower)) method = "desktop";
  else if (isBrewFormulaPath(posixLower)) method = "brew";
  else if (isNpxPath(posixLower)) method = "npx";
  else if (isBunPath(posixLower)) method = "bun";
  else if (isPnpmPath(posixLower)) method = "pnpm";
  else if (isYarnGlobalPath(posixLower)) method = "yarn";
  else if (isNpmPackagePath(posixLower)) method = "npm";

  const source =
    method === "other" ? findSourceTree(resolved || entryPath, exists, readFile) : null;
  const action = UPDATE_ACTIONS[method] || null;

  return {
    method,
    entryPath: resolved || String(entryPath || ""),
    action,
    command: formatCommandLine(action),
    sourceRoot: source?.root || null,
    git: Boolean(source?.git),
    reason: action ? null : unmanagedReason({
      method,
      entryPath: resolved || String(entryPath || ""),
      sourceRoot: source?.root || null,
      git: Boolean(source?.git),
    }),
  };
}

module.exports = {
  PACKAGE_NAME,
  BREW_FORMULA,
  UPDATE_ACTIONS,
  detectInstallChannel,
  formatCommandLine,
};
