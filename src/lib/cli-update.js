"use strict";

const path = require("node:path");

const NPM_PACKAGE = "tokentracker-cli";
const BREW_FORMULA = "xiufengsun/tokentracker/tokentracker";
const LATEST_URL = "https://registry.npmjs.org/tokentracker-cli/latest";

// Release versions this package publishes. A registry value that does not
// match is refused before it can reach a shell argument.
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(version) {
  const match = VERSION_RE.exec(String(version ?? "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] || null,
    raw: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
  };
}

// Negative when left is older. A prerelease is older than the same numbers
// without a prerelease. Returns null when either side is not a release version.
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  return a.pre < b.pre ? -1 : 1;
}

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function parentPosix(value) {
  const cut = value.lastIndexOf("/");
  if (cut <= 0) return null;
  return value.slice(0, cut);
}

function nativePath(posixValue, platform) {
  if (!posixValue) return null;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.normalize(posixValue);
}

// Documented CLI installs are npm global, Homebrew, and a one-shot npx run.
// npm's global layout is prefix/lib/node_modules on Unix and
// prefix/node_modules under the npm or nodejs directory on Windows.
// pnpm/yarn/bun global trees do not match. The layout alone is only a
// candidate: a project directory named lib, Volta's package images, and mise
// installs share it, so planUpdate also requires npm's own global prefix.
function npmGlobalPrefix(posixRoot, platform) {
  const marker = `/node_modules/${NPM_PACKAGE}`;
  if (!posixRoot.endsWith(marker)) return null;
  const modulesDir = posixRoot.slice(0, -`/${NPM_PACKAGE}`.length);
  if (!modulesDir.endsWith("/node_modules")) return null;
  const above = modulesDir.slice(0, -"/node_modules".length);
  const base = above.split("/").pop();
  if (base === "lib") return nativePath(parentPosix(above), platform);
  if (platform === "win32" && (base === "npm" || base === "nodejs")) {
    return nativePath(above, platform);
  }
  return null;
}

// Windows and the default macOS volume compare paths case-insensitively.
function samePath(left, right, platform) {
  const a = toPosix(left);
  const b = toPosix(right);
  if (!a || !b) return false;
  if (platform === "win32" || platform === "darwin") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// The cask installs TokenTracker.app into /Applications, so its bundled CLI
// is classified as "app"; only the formula lives under the Cellar.
function classifyInstall({ packageRoot, platform = "linux" } = {}) {
  const root = toPosix(packageRoot);
  if (root.includes("/Cellar/tokentracker/")) return { channel: "brew", prefix: null };
  if (root.includes("/_npx/")) return { channel: "npx", prefix: null };
  const prefix = npmGlobalPrefix(root, platform);
  if (prefix) return { channel: "npm", prefix };
  if (root.includes("/EmbeddedServer/") || root.endsWith("/EmbeddedServer")) {
    return { channel: "app", prefix: null };
  }
  return { channel: "source", prefix: null };
}

function officialCommands(version) {
  const pin = parseVersion(version) ? `@${parseVersion(version).raw}` : "@latest";
  return [
    `npm install -g ${NPM_PACKAGE}${pin}`,
    `brew upgrade ${BREW_FORMULA}`,
    `npx ${NPM_PACKAGE}${pin}`,
  ];
}

// Display only: exec is spawned without a shell. Quote for the shell the user
// pastes into. Nothing expands inside POSIX single quotes, so only a quote
// itself needs splicing. A Windows path cannot contain a double quote.
function quoteArg(arg, platform) {
  const value = String(arg);
  const plain = platform === "win32" ? /^[\w@%+=:,./\\-]+$/ : /^[\w@%+=:,./-]+$/;
  if (plain.test(value)) return value;
  if (platform === "win32") return `"${value}"`;
  return `'${value.split("'").join("'\\''")}'`;
}

function formatCommand(argv, platform = "linux") {
  return argv.map((arg) => quoteArg(arg, platform)).join(" ");
}

function appUpdateLines() {
  return [
    "Update the app:",
    `macOS: the menu bar app checks for updates, or run brew upgrade --cask ${BREW_FORMULA}`,
    "Windows: choose Check for Updates in the tray menu.",
    "Linux: download the latest AppImage, .deb, or .rpm from GitHub Releases.",
  ];
}

// Cellar/tokentracker/<version>/... is replaced by the upgrade; opt/tokentracker
// is the link Homebrew moves to the keg it installed.
function brewLinkedPackageRoot(packageRoot) {
  const root = toPosix(packageRoot);
  const marker = "/Cellar/tokentracker/";
  const at = root.indexOf(marker);
  if (at < 0) return null;
  const rest = root.indexOf("/", at + marker.length);
  if (rest < 0) return null;
  return `${root.slice(0, at)}/opt/tokentracker${root.slice(rest)}`;
}

// The command a user would type. cmdUpdate runs it through the Node runtime's
// npm-cli.js (see npmCliCandidates) rather than a PATH lookup.
function npmCommand(prefix, version) {
  const parsed = parseVersion(version);
  if (!prefix || !parsed) return null;
  return ["npm", "install", "--global", "--prefix", prefix, `${NPM_PACKAGE}@${parsed.raw}`];
}

// Where the running Node keeps npm, then where npm lives under the install
// prefix. On Unix, bin/npm links to npm-cli.js in the official, nvm and
// Homebrew layouts (Homebrew keeps the package outside the node keg). On
// Windows the PATH entry is npm.cmd, which only runs under cmd.exe, and
// cmd.exe resolves a bare name from the current directory before PATH.
// Running npm-cli.js with node needs no shell and no lookup.
function npmCliCandidates({ prefix, platform = "linux", execPath }) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const tail = ["node_modules", "npm", "bin", "npm-cli.js"];
  if (platform === "win32") {
    return [...new Set([execPath && pathApi.dirname(execPath), prefix]
      .filter(Boolean)
      .map((root) => pathApi.join(root, ...tail)))];
  }
  const bin = execPath ? pathApi.dirname(execPath) : null;
  return [...new Set([
    bin && pathApi.join(bin, "npm"),
    bin && pathApi.join(pathApi.dirname(bin), "lib", ...tail),
    prefix && pathApi.join(prefix, "lib", ...tail),
  ].filter(Boolean))];
}

function versionLine(current, latest, label) {
  if (!latest) return `TokenTracker ${current} (${label})`;
  if (compareVersions(current, latest) === 0) return `TokenTracker ${current} is already the latest release.`;
  if (compareVersions(current, latest) > 0) {
    return `TokenTracker ${current} is newer than the latest npm release ${latest}.`;
  }
  return `TokenTracker ${current} → ${latest} (${label})`;
}

// npmPrefix is npm's own global prefix (`npm prefix --global`), and npm is the
// argv that runs npm (node plus npm-cli.js); either is null when cmdUpdate
// could not find it. command is what the user would type; exec is what
// cmdUpdate spawns when apply is true.
function planUpdate({
  packageRoot,
  platform = "linux",
  current,
  latest = null,
  writable = true,
  npmPrefix = null,
  npm = null,
} = {}) {
  const install = classifyInstall({ packageRoot, platform });
  const parsedLatest = parseVersion(latest);
  const latestRaw = parsedLatest ? parsedLatest.raw : null;
  const cmp = latestRaw ? compareVersions(current, latestRaw) : null;
  const updateAvailable = Boolean(latestRaw && (cmp === null || cmp < 0));
  const lines = [];
  let command = null;
  let exec = null;
  let apply = false;

  if (install.channel === "npm") {
    lines.push(versionLine(current, latestRaw, "npm"));
    if (updateAvailable && !npm) {
      command = npmCommand(install.prefix, latestRaw);
      lines.push("Could not find npm next to this Node runtime. If this is your npm global install, run:");
      lines.push(formatCommand(command, platform));
    } else if (updateAvailable && !samePath(install.prefix, npmPrefix, platform)) {
      lines.push(npmPrefix
        ? `This copy is in ${install.prefix}, but npm's global prefix is ${npmPrefix}.`
        : `Could not confirm that ${install.prefix} is npm's global prefix.`);
      lines.push("It may be a project dependency or managed by another tool such as Volta or mise. Update it the way it was installed.");
    } else if (updateAvailable) {
      command = npmCommand(install.prefix, latestRaw);
      if (!writable) {
        lines.push(`The npm prefix is not writable: ${install.prefix}`);
        lines.push("Run this as a user who can write there:");
        lines.push(formatCommand(command, platform));
      } else {
        apply = true;
        exec = [...npm, ...command.slice(1)];
        lines.push(formatCommand(command, platform));
      }
    }
  } else if (install.channel === "brew") {
    lines.push(versionLine(current, latestRaw, "Homebrew"));
    if (updateAvailable) {
      command = ["brew", "upgrade", BREW_FORMULA];
      exec = command;
      apply = true;
      lines.push(formatCommand(command, platform));
    }
  } else if (install.channel === "npx") {
    if (updateAvailable) {
      lines.push(`This is an npx run of ${NPM_PACKAGE} ${current}. The latest release is ${latestRaw}.`);
      lines.push("npx does not stay installed. The next launch picks up the new package:");
      lines.push(`npx ${NPM_PACKAGE}@${latestRaw}`);
    } else if (latestRaw) {
      lines.push(`This npx run is already ${NPM_PACKAGE} ${current}.`);
    }
  } else if (install.channel === "app") {
    if (updateAvailable) {
      lines.push(`This copy is bundled inside the TokenTracker app (${current}). The latest release is ${latestRaw}.`);
      lines.push(...appUpdateLines());
    } else if (latestRaw && cmp > 0) {
      lines.push(`This copy is bundled inside the TokenTracker app. ${current} is newer than the latest npm release ${latestRaw}.`);
    } else if (latestRaw) {
      lines.push(`This copy is bundled inside the TokenTracker app. ${current} matches the latest release.`);
    } else {
      lines.push(`This copy is bundled inside the TokenTracker app (${current}).`);
      lines.push(...appUpdateLines());
    }
  } else if (!latestRaw) {
    lines.push(`This copy was not installed with npm or Homebrew (${current}).`);
    lines.push("Update a supported CLI install with:");
    lines.push(...officialCommands(null));
  } else if (updateAvailable) {
    lines.push(`This copy was not installed with npm or Homebrew (${current}). The latest release is ${latestRaw}.`);
    lines.push("Update a supported CLI install with:");
    lines.push(...officialCommands(latestRaw));
  } else if (cmp > 0) {
    lines.push(`This copy was not installed with npm or Homebrew. ${current} is newer than the latest npm release ${latestRaw}.`);
  } else {
    lines.push(`This copy was not installed with npm or Homebrew. ${current} matches the latest release.`);
  }

  return {
    channel: install.channel,
    prefix: install.prefix,
    current,
    latest: latestRaw,
    updateAvailable,
    apply,
    command,
    exec,
    lines,
  };
}

async function fetchLatestNpmVersion(fetchImpl, { url = LATEST_URL, signal } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("npm registry is unavailable");
  }
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: signal || AbortSignal.timeout(20000),
  });
  if (!response || !response.ok || typeof response.json !== "function") {
    const status = response && response.status ? response.status : "no response";
    throw new Error(`npm registry returned ${status}`);
  }
  const body = await response.json();
  const parsed = parseVersion(body && body.version);
  if (!parsed) throw new Error("npm registry returned an unusable version");
  return parsed.raw;
}

module.exports = {
  NPM_PACKAGE,
  BREW_FORMULA,
  LATEST_URL,
  parseVersion,
  compareVersions,
  classifyInstall,
  brewLinkedPackageRoot,
  npmCliCandidates,
  officialCommands,
  planUpdate,
  fetchLatestNpmVersion,
  formatCommand,
};
