"use strict";

function powershellLiteral(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function quotePosix(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_\-./:@]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

// Paths that can be POSIX-quoted and executed in bash, cmd, and PowerShell.
// `$`, `%`, and other shell metacharacters still use the PowerShell literal form
// so official Windows hooks keep working for those paths (#1161).
function isCrossShellPortablePath(value) {
  const text = String(value || "").replace(/\\/g, "/");
  if (!text) return false;
  if (/[\u0000-\u001f$`"%!^&|<>;()]/.test(text)) return false;
  return /^(?:[A-Za-z]:)?[A-Za-z0-9_./ @'+~-]*$/.test(text);
}

// PowerShell only needs `&` when the executable is quoted. Keep the portable
// command unquoted so it also runs in bash and cmd.
function isUnquotedSafePath(value) {
  const text = String(value || "").replace(/\\/g, "/");
  return /^(?:[A-Za-z]:)?[A-Za-z0-9_./+~-]+$/.test(text);
}

function toForwardSlashPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function tokenizeCommand(command) {
  return command.match(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s]+/g) || [];
}

function decodeCommandToken(token) {
  return token.startsWith("'")
    ? token.slice(1, -1).replace(/''/g, "'")
    : token.startsWith('"') ? token.slice(1, -1).replace(/\\([\\"$`])/g, "$1") : token;
}

function buildNotifyCommand(notifyPath, source, { platform = process.platform, execPath = process.execPath } = {}) {
  if (!/^[a-z0-9-]+$/i.test(source)) throw new Error("Invalid notify source");
  if (platform === "win32") {
    if (isCrossShellPortablePath(notifyPath) && isCrossShellPortablePath(execPath)) {
      const script = quotePosix(toForwardSlashPath(notifyPath));
      if (isUnquotedSafePath(execPath)) {
        return `${toForwardSlashPath(execPath)} ${script} --source=${source}`;
      }
      // Bundled Node often lives under a user or Program Files path with spaces
      // and is not on PATH. Wrap the real executable in powershell.exe (unquoted,
      // on Windows PATH) so PowerShell, cmd, and bash can all launch it without `&`.
      const inner = `& ${powershellLiteral(toForwardSlashPath(execPath))} ${powershellLiteral(toForwardSlashPath(notifyPath))} --source=${source}`;
      return `powershell.exe -NoProfile -Command "${inner}"`;
    }
    return `& ${powershellLiteral(execPath)} ${powershellLiteral(notifyPath)} --source=${source}`;
  }
  return `/usr/bin/env node ${quotePosix(notifyPath)} --source=${source}`;
}

// Recognize only our complete notify invocation, never a user command merely
// containing notify.cjs or additional shell actions. Used to repair old hooks.
function notifyIdentity(command) {
  if (typeof command !== "string") return null;
  const args = tokenizeCommand(command).map(decodeCommandToken);
  if (args[0] === "&") args.shift();
  if (args[0] === "/usr/bin/env" && args[1] === "node") args.shift();
  if (/(?:^|[\\/])powershell(?:\.exe)?$/i.test(args[0] || "")) {
    const commandIdx = args.findIndex((arg, index) => index > 0 && /^-[Cc]ommand$/.test(arg));
    if (commandIdx < 0 || commandIdx + 1 >= args.length) return null;
    // Anything after -Command is an extra user action; do not treat this as our hook.
    if (commandIdx + 2 !== args.length) return null;
    return notifyIdentity(args[commandIdx + 1]);
  }
  if (args.length !== 3 || !/(?:^|[\\/])node(?:\.exe)?$/i.test(args[0])) return null;
  if (!/(?:^|[\\/])notify\.cjs$/i.test(args[1]) || !/^--source=[a-z0-9-]+$/i.test(args[2])) return null;
  const file = args[1].replace(/\\/g, "/");
  return `${/^[a-z]:\//i.test(file) ? file.toLowerCase() : file}\u0000${args[2]}`;
}

module.exports = { buildNotifyCommand, notifyIdentity, isCrossShellPortablePath, isUnquotedSafePath };
