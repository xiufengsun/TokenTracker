"use strict";

function powershellLiteral(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function quotePosix(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_\-./:@]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function buildNotifyCommand(notifyPath, source, { platform = process.platform, execPath = process.execPath } = {}) {
  if (!/^[a-z0-9-]+$/i.test(source)) throw new Error("Invalid notify source");
  if (platform === "win32") {
    return `& ${powershellLiteral(execPath)} ${powershellLiteral(notifyPath)} --source=${source}`;
  }
  return `/usr/bin/env node ${quotePosix(notifyPath)} --source=${source}`;
}

// Recognize only our complete notify invocation, never a user command merely
// containing notify.cjs or additional shell actions. Used to repair old hooks.
function notifyIdentity(command) {
  if (typeof command !== "string") return null;
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s]+/g) || [];
  const decode = (token) => token.startsWith("'")
    ? token.slice(1, -1).replace(/''/g, "'")
    : token.startsWith('"') ? token.slice(1, -1).replace(/\\([\\"$`])/g, "$1") : token;
  const args = tokens.map(decode);
  if (args[0] === "&") args.shift();
  if (args[0] === "/usr/bin/env" && args[1] === "node") args.shift();
  if (args.length !== 3 || !/(?:^|[\\/])node(?:\.exe)?$/i.test(args[0])) return null;
  if (!/(?:^|[\\/])notify\.cjs$/i.test(args[1]) || !/^--source=[a-z0-9-]+$/i.test(args[2])) return null;
  const file = args[1].replace(/\\/g, "/");
  return `${/^[a-z]:\//i.test(file) ? file.toLowerCase() : file}\u0000${args[2]}`;
}

module.exports = { buildNotifyCommand, notifyIdentity };
