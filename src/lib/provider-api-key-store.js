"use strict";

// Provider API keys saved from the dashboard's Limits panel.
//
// The launch environment is a shared, machine-wide namespace: a
// `launchctl setenv OPENCODE_GO_API_KEY` reaches every launchd app on the
// machine (that is how a global key silently unlocked another app's field in
// #837). Keys entered in the panel are therefore persisted here instead, in a
// 0600 JSON file under the tracker data dir next to cloud-device-token.json.
//
// The environment variable still wins when set, so headless installs and
// wrapper-launched apps keep working; the store is the durable default for
// users who never touch a terminal.

const fssync = require("node:fs");
const path = require("node:path");
const { ensureDir, writeFileAtomic, chmod600IfPossible } = require("./fs");

const PROVIDER_KEY_FILES = {
  "opencode-go": "opencode-go-api-key.json",
  "command-code": "command-code-api-key.json",
  "deepseek": "deepseek-api-key.json",
};

const PROVIDER_ENV_NAMES = {
  "opencode-go": "OPENCODE_GO_API_KEY",
  "command-code": "COMMAND_CODE_API_KEY",
  "deepseek": "DEEPSEEK_API_KEY",
};

const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 4096;

function isProviderId(provider) {
  return typeof provider === "string" && Object.prototype.hasOwnProperty.call(PROVIDER_KEY_FILES, provider);
}

function envNameForProvider(provider) {
  return isProviderId(provider) ? PROVIDER_ENV_NAMES[provider] : null;
}

function resolveProviderKeyDir({ trackerDir, home } = {}) {
  if (typeof trackerDir === "string" && trackerDir.trim()) return trackerDir.trim();
  if (typeof home === "string" && home.trim()) {
    return path.join(home.trim(), ".tokentracker", "tracker");
  }
  return null;
}

function resolveProviderKeyPath({ provider, trackerDir, home } = {}) {
  if (!isProviderId(provider)) return null;
  const dir = resolveProviderKeyDir({ trackerDir, home });
  if (!dir) return null;
  return path.join(dir, PROVIDER_KEY_FILES[provider]);
}

// Keys are opaque bearer tokens. Reject anything that cannot be pasted into an
// Authorization header verbatim (internal whitespace/control characters) and
// keep an upper bound so a mis-pasted blob cannot bloat the auth file.
function normalizeApiKey(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length < MIN_API_KEY_LENGTH || trimmed.length > MAX_API_KEY_LENGTH) return "";
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return "";
  return trimmed;
}

// Never throws: a missing, unreadable, or malformed store must degrade to
// "no stored key" so a limits fetch can still fall back to env/cookie/CLI.
function readStoredApiKey({ provider, trackerDir, home } = {}) {
  const filePath = resolveProviderKeyPath({ provider, trackerDir, home });
  if (!filePath) return "";
  let raw;
  try {
    raw = fssync.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  return normalizeApiKey(parsed?.apiKey);
}

async function writeStoredApiKey({ provider, trackerDir, home, apiKey } = {}) {
  const filePath = resolveProviderKeyPath({ provider, trackerDir, home });
  if (!filePath) throw new Error("No tracker data directory available for the API key.");
  const normalized = normalizeApiKey(apiKey);
  if (!normalized) throw new Error("Invalid API key.");
  await ensureDir(path.dirname(filePath));
  const contents = `${JSON.stringify({ apiKey: normalized, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  await writeFileAtomic(filePath, contents, { mode: 0o600 });
  // writeFileAtomic only applies `mode` to newly created files; an existing
  // store with looser permissions must still end up private.
  await chmod600IfPossible(filePath);
  return filePath;
}

module.exports = {
  PROVIDER_KEY_FILES,
  PROVIDER_ENV_NAMES,
  isProviderId,
  envNameForProvider,
  resolveProviderKeyDir,
  resolveProviderKeyPath,
  normalizeApiKey,
  readStoredApiKey,
  writeStoredApiKey,
};
