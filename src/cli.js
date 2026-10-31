const { cmdInit } = require("./commands/init");
const { cmdSync } = require("./commands/sync");
const { cmdStatus } = require("./commands/status");
const { cmdDiagnostics } = require("./commands/diagnostics");
const { cmdDoctor } = require("./commands/doctor");
const { cmdUninstall } = require("./commands/uninstall");
const { cmdServe } = require("./commands/serve");
const { cmdDeviceLogin } = require("./commands/device-login");
const { cmdWrapped } = require("./commands/wrapped");
const { cmdSessions } = require("./commands/sessions");
const { cmdUpdate } = require("./commands/update");

async function run(argv) {
  // Best-effort Sentry init (no-op without DSN / when telemetry opted out).
  try {
    const { initSentry } = require("./lib/sentry");
    const { resolveTrackerPaths } = require("./lib/tracker-paths");
    const { trackerDir } = await resolveTrackerPaths().catch(() => ({ trackerDir: null }));
    await initSentry({ trackerDir });
  } catch {
    /* never block CLI startup on telemetry */
  }

  const [command, ...rest] = argv;

  // No args → launch dashboard
  if (!command) {
    await cmdServe(argv);
    return;
  }

  if (command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "-v" || command === "--version") {
    const pkg = require("../package.json");
    console.log(`v${pkg.version}`);
    return;
  }

  switch (command) {
    case "serve":
      await cmdServe(rest);
      return;
    case "init":
      await cmdInit(rest);
      return;
    case "sync":
      await cmdSync(rest);
      return;
    case "status":
      await cmdStatus(rest);
      return;
    case "diagnostics":
      await cmdDiagnostics(rest);
      return;
    case "doctor":
      await cmdDoctor(rest);
      return;
    case "uninstall":
      await cmdUninstall(rest);
      return;
    case "device-login":
      await cmdDeviceLogin(rest);
      return;
    case "wrapped":
      await cmdWrapped(rest);
      return;
    case "sessions":
      await cmdSessions(rest);
      return;
    case "update":
      await cmdUpdate(rest);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printHelp(process.stderr);
      process.exitCode = 1;
      return;
  }
}

function printHelp(stream = process.stdout) {
  // Keep this short; npx users want quick guidance.
  stream.write(
    [
      "tokentracker",
      "",
      "Usage:",
      "  npx tokentracker                                         Open local dashboard",
      "  npx tokentracker -v, --version                           Show version info",
      "  npx tokentracker-cli [--debug] update [--check] [--json]",
      "  npx tokentracker [--debug] serve [--port 7680] [--no-open] [--no-sync]",
      "  npx tokentracker [--debug] init [--yes] [--dry-run] [--no-open] [--link-code <code>]",
      "  npx tokentracker [--debug] sync [--auto] [--drain] [--from-openclaw]",
      "  npx tokentracker [--debug] status [--probe-keychain] [--probe-keychain-details]",
      "  npx tokentracker [--debug] diagnostics [--out diagnostics.json]",
      "  npx tokentracker [--debug] doctor [--json] [--out doctor.json] [--base-url <url>]",
      "  npx tokentracker [--debug] uninstall [--purge]",
      "  npx tokentracker [--debug] device-login [--json] [--base-url <url>]",
      "  npx tokentracker [--debug] wrapped [--year 2026] [--json]",
      "  npx tokentracker sessions [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--format json|csv] [--out file] [--refresh] [--no-git]",
      "",
      "Notes:",
      "  - init: consent first, local setup next, browser sign-in last.",
      "  - --yes skips the consent menu (non-interactive safe).",
      "  - --dry-run previews changes without writing files.",
      "  - optional: --link-code <code> skips browser login when provided by Dashboard.",
      "  - Every Code notify installs when ~/.code/config.toml exists.",
      "  - OpenClaw session plugin auto-links when OpenClaw is installed (requires hooks.allowConversationAccess enabled + gateway restart).",
      "  - auto sync waits for a device token.",
      "  - optional: --dashboard-url for hosted landing.",
      "  - sync parses ~/.codex/sessions/**/rollout-*.jsonl and ~/.code/sessions/**/rollout-*.jsonl, then uploads token deltas.",
      "  - --from-openclaw marks sync runs triggered by the OpenClaw session plugin.",
      "  - --debug shows original backend errors.",
      "  - device-login pairs a headless CLI / SSH session with a browser sign-in (15-min code).",
      "  - sessions exports metadata-only Claude/Codex/Grok/ZCode efficiency analytics; no prompt or response text is retained.",
      "  - update upgrades an npm global install or a Homebrew install. An npx run prints the command for the next launch.",
      "  - update --check only reports, and exits 1 when a newer release exists. --json prints one JSON object.",
      "",
    ].join("\n"),
  );
}

module.exports = { run };
