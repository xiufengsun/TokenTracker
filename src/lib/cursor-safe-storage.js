const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "cursor-safe-storage:v1:";

function decodeBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")
    ? bytes : null;
}

function isJwt(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const payload = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload);
  } catch {
    return false;
  }
}

// Capture every stream: execFileSync otherwise forwards a failing child's stderr.
// Never include secrets in argv, errors, logs, or temporary files.
function runSecretCommand(command, args, deps, input) {
  return (deps.execFileSync || cp.execFileSync)(command, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  }).replace(/\r?\n$/, "");
}

function unprotectWindows(bytes, deps) {
  // A fixed script keeps the encrypted data out of process listings as well.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
    "$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($plain))",
  ].join("; ");
  return decodeBase64(runSecretCommand("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ], deps, bytes.toString("base64")));
}

function decryptWindows(bytes, appDir, deps) {
  const unprotect = deps.unprotectWindows || ((data) => unprotectWindows(data, deps));
  if (bytes.subarray(0, 3).toString() !== "v10") {
    // Older OSCrypt used DPAPI directly, with no version prefix.
    return unprotect(bytes)?.toString("utf8");
  }
  // Chromium v10: DPAPI-protected AES-256-GCM key in Cursor's Local State.
  if (!appDir || bytes.length < 3 + 12 + 16) return null;
  const localState = JSON.parse((deps.readFileSync || fs.readFileSync)(
    path.win32.join(appDir, "Local State"), "utf8",
  ));
  const wrappedKey = decodeBase64(localState?.os_crypt?.encrypted_key);
  if (!wrappedKey || wrappedKey.subarray(0, 5).toString() !== "DPAPI") return null;
  const key = unprotect(wrappedKey.subarray(5));
  if (!Buffer.isBuffer(key) || key.length !== 32) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(3, 15));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]).toString("utf8");
}

function decryptCbc(bytes, password, iterations) {
  const key = crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString("utf8");
}

/** Decode Cursor's base64 Electron safeStorage envelope, or retain a legacy JWT.
 * OS access is injectable. Unavailable/locked stores and unknown formats fail
 * closed, without exposing child-process errors (which can contain secrets).
 */
function decodeCursorAccessToken(value, { platform = process.platform, appDir, deps = {} } = {}) {
  if (isJwt(value)) return value;
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return null;
  const bytes = decodeBase64(value.slice(PREFIX.length));
  if (!bytes?.length) return null;
  try {
    let token;
    const version = bytes.subarray(0, 3).toString();
    if (platform === "win32") {
      token = decryptWindows(bytes, appDir, deps);
    } else if (platform === "darwin" || platform === "linux") {
      if (bytes.length <= 3 || (bytes.length - 3) % 16 !== 0) return null;
      let password;
      if (platform === "darwin") {
        if (version !== "v10") return null;
        password = runSecretCommand("/usr/bin/security", [
          "find-generic-password", "-s", "Cursor Safe Storage", "-w",
        ], deps);
        if (!password) return null;
      } else if (version === "v10") {
        password = "peanuts"; // Chromium's basic_text backend.
      } else if (version === "v11") {
        // Best effort for Secret Service stores. KWallet-only/locked stores
        // and hosts without secret-tool are intentionally unavailable.
        password = runSecretCommand("secret-tool", ["lookup", "application", "cursor"], deps);
        if (!password) return null;
      } else {
        return null;
      }
      token = decryptCbc(bytes, password, platform === "darwin" ? 1003 : 1);
    }
    return isJwt(token) ? token : null;
  } catch {
    return null;
  }
}

module.exports = { decodeCursorAccessToken };
