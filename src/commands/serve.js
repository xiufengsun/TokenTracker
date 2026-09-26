const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fssync = require("node:fs");
const cp = require("node:child_process");

const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { createLocalApiHandler, resolveQueuePath } = require("../lib/local-api");
const { ensurePricingLoaded } = require("../lib/pricing");
const { serveStaticFile } = require("../lib/static-server");
const { openInBrowser } = require("../lib/browser-auth");
const { maybeShowStarCta } = require("../lib/star-cta");

const DEFAULT_PORT = 7680;
// Windows Delivery Optimization (DoSvc) listens on 0.0.0.0:7680 on virtually
// every Windows host. Under WSL2 NAT networking the in-WSL bind succeeds (the
// conflict lives on the Windows side of the loopback), but the Windows
// browser reaches DoSvc instead of the dashboard, which accepts the TCP
// connection and drops the HTTP request (#267). The in-WSL "port busy → try
// next" fallback can't see this, so WSL starts one port up by default.
const WSL_DEFAULT_PORT = 7681;
const DEFAULT_MAX_PORT_ATTEMPTS = 20;
const NPM_PACKAGE_NAME = "tokentracker-cli";
const LOCAL_BIND_HOST = "127.0.0.1";
const NATIVE_BACKGROUND_SYNC_INTERVAL_MS = 60_000;
const STATIC_ASSET_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".mjs",
  ".png",
  ".svg",
  ".ttf",
  ".txt",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
  ".xml",
]);

function buildPortInUseHint(port) {
  return `Port ${port} is still in use after cleanup. Try: npx ${NPM_PACKAGE_NAME} serve --port ${port + 1}\n`;
}

function isPortUnavailableError(error) {
  return error?.code === "EADDRINUSE" || error?.code === "EACCES" || error?.code === "EPERM";
}

function getLocalServerUrl(port) {
  return `http://${LOCAL_BIND_HOST}:${port}`;
}

async function cmdServe(argv) {
  const opts = parseArgs(argv);

  // 0. First-time setup: if tracker dir doesn't exist, run init first
  const { trackerDir, binDir } = await resolveTrackerPaths();
  if (!fssync.existsSync(path.join(trackerDir, "cursors.json"))) {
    process.stdout.write("First time? Setting up Token Tracker...\n\n");
    try {
      const { cmdInit } = require("./init");
      await cmdInit(["--yes"]);
    } catch (e) {
      process.stdout.write(`Init warning: ${e?.message || e}\n`);
    }
  }

  try {
    const { installLocalTrackerApp, repairRuntimeIntegrations } = require("./init");
    await installLocalTrackerApp({ appDir: path.join(trackerDir, "app") });
    const repairResult = await repairRuntimeIntegrations({ trackerDir, binDir, safeMode: true });
    for (const warning of repairResult?.warnings || []) {
      process.stdout.write(
        `Runtime integration repair warning (${warning.integration}): ${warning.error}\n`,
      );
    }
  } catch (e) {
    process.stdout.write(`Runtime refresh warning: ${e?.message || e}\n`);
  }

  // 1. Optional sync
  if (opts.sync) {
    process.stdout.write("Syncing local data...\n");
    try {
      const { cmdSync } = require("./sync");
      await cmdSync(["--auto"]);
      process.stdout.write("Sync done.\n");
    } catch (e) {
      process.stdout.write(`Sync warning: ${e?.message || e}\n`);
    }
  }

  // 2. Resolve paths
  const queuePath = resolveQueuePath();
  const dashboardDir = resolveDashboardDir();

  // 2.1 Refresh LiteLLM pricing data in the background. The seed snapshot is
  //     already loaded synchronously at require-time, so cost calculation is
  //     functional right now; ensurePricingLoaded() only upgrades to fresh
  //     disk cache or upstream data. Awaiting it here would block startup
  //     for the full 10s fetch timeout when offline / behind a firewall.
  const { cacheDir } = await resolveTrackerPaths();
  ensurePricingLoaded({ cachePath: path.join(cacheDir, "pricing.json") }).catch(
    (e) => process.stdout.write(`Pricing refresh warning: ${e?.message || e}\n`),
  );

  if (!dashboardDir) {
    process.stderr.write(
      [
        "Dashboard not found.",
        "",
        "If you cloned the repo, run:",
        "  cd dashboard && npm run build",
        "",
        "If you installed via npm, the package may be missing dashboard/dist/.",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  // 3. Create handler
  const handleApi = createLocalApiHandler({ queuePath });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }

      // API routes
      if (
        url.pathname.startsWith("/functions/")
        || url.pathname.startsWith("/api/")
        || url.pathname.startsWith("/proxy/")
      ) {
        const handled = await handleApi(req, res, url);
        if (handled) return;
      }

      // The system browser's OAuth return for a sign-in the Linux app started.
      // Send the code to the running app before the SPA loads.
      const oauthHandoff = requestWantsLinuxOAuthHandoff(req, url, handleApi.takeNativeAuthPending);
      if (oauthHandoff) {
        sendHtmlDocument(res, linuxOAuthHandoffHtml(oauthHandoff));
        return;
      }

      // Static files
      const served = await serveStaticFile(dashboardDir, url.pathname, res);
      if (served) return;

      // SPA fallback
      if (shouldServeSpaFallback(req, url)) {
        await serveStaticFile(dashboardDir, "/index.html", res);
        return;
      }

      sendNotFound(res);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  // 4. Listen. Default startup follows README behavior and picks the next
  // available port; an explicit --port/PORT remains strict.
  if (opts.wslDefaultPort) {
    process.stdout.write(
      `Running under WSL: using port ${opts.port} (7680 is held by the Windows Delivery Optimization service on the host — see issue #267). Pass --port to override.\n`,
    );
  }
  let port;
  try {
    port = await listenOnAvailablePort(server, opts.port, {
      allowFallback: !opts.portExplicit,
      ensurePortFreeFn: opts.portExplicit ? ensurePortFree : null,
      onRetry: (failedPort) => {
        process.stdout.write(`Port ${failedPort} unavailable, trying ${failedPort + 1}...\n`);
      },
    });
  } catch (e) {
    if (isPortUnavailableError(e)) {
      process.stderr.write(buildPortInUseHint(opts.port));
    } else {
      process.stderr.write(`Server error: ${e.message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  {
    const url = getLocalServerUrl(port);
    process.stdout.write(
      [
        "",
        `  tokentracker dashboard running at:`,
        "",
        `    ${url}`,
        "",
        `  Data: ${queuePath}`,
        `  Press Ctrl+C to stop.`,
        "",
      ].join("\n"),
    );

    if (opts.open) {
      openInBrowser(url);
    }
  }

  await maybeShowStarCta({ trackerDir });

  // The Windows desktop app keeps this server alive even when the dashboard
  // window is closed. Provider hooks are the fast path, but they can be removed
  // by a tool update or skipped by a provider. Scan every local source once a
  // minute as a bounded fallback so the queue cannot remain stale indefinitely.
  // `--no-sync` still skips the blocking startup sync; this periodic pass is
  // Windows-only and uses the lightweight local mode (no cloud upload, Cursor
  // network request, or deep Codex archive scan). The macOS app owns its own
  // wake-aware refresh loop; running both loops made sync.lock nearly
  // continuous and starved provider notify syncs.
  const nativeBackgroundSync = startNativeBackgroundSync({
    onError: (e) =>
      process.stdout.write(`Background local sync warning: ${e?.message || e}\n`),
  });

  // Anonymous daily heartbeat (see src/lib/telemetry.js for the privacy
  // contract). Fire-and-forget at startup, then re-checked every 6 hours so
  // long-lived embedded-app servers still count on later days; the shared
  // 24h throttle state guarantees at most one send per day.
  {
    const { maybeSendHeartbeat } = require("../lib/telemetry");
    const { trackerDir: heartbeatTrackerDir } = await resolveTrackerPaths();
    const sendHeartbeat = () =>
      maybeSendHeartbeat({ trackerDir: heartbeatTrackerDir }).catch(() => {});
    sendHeartbeat();
    setInterval(sendHeartbeat, 6 * 60 * 60 * 1000).unref();
  }

  server.on("error", (e) => {
    process.stderr.write(`Server error: ${e.message}\n`);
    process.exitCode = 1;
  });

  // 5. Graceful shutdown
  const shutdown = () => {
    process.stdout.write("\nShutting down...\n");
    nativeBackgroundSync?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

function startNativeBackgroundSync({
  appShell = process.env.TOKENTRACKER_APP_SHELL,
  nativeSyncOwner = process.env.TOKENTRACKER_NATIVE_SYNC_OWNER,
  intervalMs = NATIVE_BACKGROUND_SYNC_INTERVAL_MS,
  runSync,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = () => {},
} = {}) {
  const normalizedShell = String(appShell || "").trim().toLowerCase();
  if (normalizedShell !== "windows") return null;
  // The Windows tray host owns its five-minute background sync timer and
  // receives completion events for the UI. Running this server-side fallback
  // as well creates two independent sync producers that contend on sync.lock,
  // leaving refreshes stale and needlessly expensive.
  if (String(nativeSyncOwner || "").trim().toLowerCase() === "windows-host") return null;

  // Run the periodic fallback sync in a child process, not in-process:
  // several provider parsers read SQLite databases via execFileSync, which
  // would otherwise freeze this server's event loop (and every dashboard
  // endpoint) once a minute. sync.lock is file-based, so the child contends
  // with hook-fired syncs exactly like an in-process run did.
  const sync = runSync || ((args, { env } = {}) => new Promise((resolve, reject) => {
    const child = cp.spawn(
      process.execPath,
      [path.join(__dirname, "..", "..", "bin", "tracker.js"), "sync", ...args],
      { stdio: "ignore", windowsHide: true, env },
    );
    child.unref();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`background sync exited with ${code ?? `signal ${signal}`}`));
      }
    });
  }));
  let inFlight = null;
  const run = () => {
    if (inFlight) return inFlight;
    // WSL UNC metadata probes can wake WSLg and create an invisible msrdc
    // RemoteApp window that steals focus. This one-minute fallback owns native
    // local freshness only; explicit/manual syncs and provider hooks retain the
    // user's configured WSL mode.
    const backgroundEnv = {
      ...process.env,
      TOKENTRACKER_WSL_MODE: "native-only",
    };
    const pending = Promise.resolve()
      .then(() => sync(["--auto", "--background", "--all-local-sources"], { env: backgroundEnv }))
      .catch((error) => {
        try { onError(error); } catch (_e) {}
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };

  const timer = setIntervalFn(() => {
    void run();
  }, intervalMs);
  timer?.unref?.();

  return {
    run,
    stop() {
      clearIntervalFn(timer);
    },
  };
}

// `-sTCP:LISTEN` matters: `lsof -i tcp:<port>` matches any socket with that
// port as its LOCAL *or* REMOTE endpoint, so without it a browser merely
// connected to the dashboard is reported alongside the server that owns it.
function findPidOnPort(port) {
  try {
    const out = cp.execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const pids = out.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return pids;
  } catch (_e) {
    return [];
  }
}

function readProcessCommand(pid) {
  try {
    return cp
      .execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 5000,
      })
      .trim();
  } catch (_e) {
    return "";
  }
}

// A TokenTracker server is always `node <somewhere>/bin/<entry> serve`: either
// the real script (npm global, embedded desktop runtime, repo checkout) or one
// of the published npm bin shims, which `ps` reports by the shim path rather
// than the resolved script. Requiring the `bin/` component keeps an unrelated
// `node /srv/other/tracker.js serve` from looking like ours.
const TRACKER_ENTRY_RE = new RegExp(
  String.raw`(?:^|[\\/])\.?bin[\\/](?:tracker\.js|tokentracker-cli|tokentracker-tracker|tokentracker|tracker)$`,
  "i",
);
const NODE_EXECUTABLE_RE = /(?:^|[\\/])node(?:\.exe)?$/i;
// Every `serve` token that could be the subcommand rather than part of a path.
const SERVE_BOUNDARY_RE = /\s+serve(?=\s|$)/g;

// The tracker entry path a `node ... serve` command would run, or null.
//
// `ps -o command=` joins argv with spaces and drops all quoting, so the script
// path is only delimited by the `serve` argument after it -- splitting on
// whitespace would reject an install under `~/Token Tracker/`. But `serve` can
// occur inside the install path too, so every boundary is tried and the one
// whose prefix is actually a tracker entry wins; taking the first would parse
// `~/my serve dir/bin/tracker.js` as `~/my`.
function parseServeScriptPath(command) {
  const value = String(command || "").replaceAll("\0", " ").trim();
  if (!value) return null;

  const executable = /^\S+(?=\s)/.exec(value);
  if (!executable || !NODE_EXECUTABLE_RE.test(executable[0])) return null;
  const rest = value.slice(executable[0].length);

  SERVE_BOUNDARY_RE.lastIndex = 0;
  for (let match = SERVE_BOUNDARY_RE.exec(rest); match; match = SERVE_BOUNDARY_RE.exec(rest)) {
    const candidate = rest
      .slice(0, match.index)
      .trim()
      .replace(/^["']/, "")
      .replace(/["']$/, "");
    if (TRACKER_ENTRY_RE.test(candidate)) return candidate;
  }
  return null;
}

// How far above the entry script a package.json may sit. `bin/tracker.js` puts
// it one level up; the npm bin shims resolve into
// `node_modules/<pkg>/bin/tracker.js`, which is the same shape.
const TRACKER_PACKAGE_SEARCH_DEPTH = 3;

function isTrackerPackageRoot(dir) {
  try {
    const manifest = JSON.parse(fssync.readFileSync(path.join(dir, "package.json"), "utf8"));
    return manifest?.name === NPM_PACKAGE_NAME;
  } catch (_e) {
    return false;
  }
}

// The path shape alone is not identifying: plenty of unrelated projects ship a
// `bin/tracker.js`, and matching on that would signal one of them. Resolve the
// script and require a real `${NPM_PACKAGE_NAME}` package around it.
//
// Fails closed. A server whose script cannot be resolved -- deleted, or in a
// mount namespace this process cannot read -- is left alone, so the worst case
// is a failed bind rather than a killed stranger.
function isTokenTrackerServeCommand(command) {
  const script = parseServeScriptPath(command);
  if (!script) return false;

  let resolved;
  try {
    resolved = fssync.realpathSync(script);
  } catch (_e) {
    return false;
  }

  let dir = path.dirname(path.dirname(resolved));
  for (let depth = 0; depth < TRACKER_PACKAGE_SEARCH_DEPTH; depth++) {
    if (isTrackerPackageRoot(dir)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

async function ensurePortFree(port) {
  const pids = findPidOnPort(port);
  if (pids.length === 0) return;

  // Only stop a verified TokenTracker server. `--port` may name a port owned by
  // an unrelated application, and failing to bind is far safer than terminating
  // a process merely because it happens to hold that port.
  const self = process.pid;
  const targets = pids.filter(
    (pid) => pid !== self && isTokenTrackerServeCommand(readProcessCommand(pid)),
  );
  if (targets.length === 0) return;

  process.stdout.write(`Stopping previous server on port ${port} (pid ${targets.join(", ")})...\n`);
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_e) {}
  }

  // Wait briefly for port to free up
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (findPidOnPort(port).length === 0) return;
  }

  // Re-check identity before escalating: the pid may have exited during the
  // wait above and been recycled by an unrelated process.
  for (const pid of targets) {
    if (!isTokenTrackerServeCommand(readProcessCommand(pid))) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch (_e) {}
  }
  await new Promise((r) => setTimeout(r, 500));
}

function isApiPath(pathname) {
  return (
    pathname.startsWith("/api/")
    || pathname.startsWith("/functions/")
    || pathname.startsWith("/proxy/")
  );
}

function isStaticAssetPath(pathname) {
  if (pathname.startsWith("/assets/")) return true;
  return STATIC_ASSET_EXTENSIONS.has(path.posix.extname(pathname).toLowerCase());
}

function shouldServeSpaFallback(req, url) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;

  const pathname = url.pathname || "/";
  if (isApiPath(pathname) || isStaticAssetPath(pathname)) return false;

  const accept = String(req.headers?.accept || "");
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

// InsForge authorization codes observed in the wild are 64 hex chars. Bound
// the length so a document navigation cannot become an open redirect.
const OAUTH_CODE_RE = /^[a-f0-9]{32,128}$/i;

function isLinuxAppShell(env = process.env) {
  return String(env?.TOKENTRACKER_APP_SHELL || "").trim().toLowerCase() === "linux";
}

/**
 * Linux desktop sign-in opens the system browser, which must return the
 * InsForge code to the already-running app via tokentracker://. The app pins
 * that return to /auth/callback; hand it back to the app, except the in-app
 * exchange page (`app=1`).
 */
function linuxOAuthHandoffTarget(url, env = process.env) {
  if (!isLinuxAppShell(env)) return null;
  if (url.pathname !== "/auth/callback") return null;
  if (url.searchParams.get("app") === "1") return null;
  const codes = url.searchParams
    .getAll("insforge_code")
    .map((code) => String(code || "").trim())
    .filter(Boolean);
  if (codes.length !== 1 || !OAUTH_CODE_RE.test(codes[0])) return null;
  return `tokentracker://auth/callback?insforge_code=${encodeURIComponent(codes[0])}`;
}

/**
 * Only a sign-in the app itself started is handed off: the app marks it via
 * /api/auth-bridge/verifier before opening the browser. Without that mark a
 * sign-in made in a normal browser tab would be pulled into the app.
 */
function requestWantsLinuxOAuthHandoff(req, url, takeNativeAuthPending, env = process.env) {
  // A HEAD would spend the one-time mark without delivering the page.
  if (String(req.method || "GET").toUpperCase() !== "GET") return null;
  if (!shouldServeSpaFallback(req, url)) return null;
  const target = linuxOAuthHandoffTarget(url, env);
  if (!target || !takeNativeAuthPending()) return null;
  return target;
}

function linuxOAuthHandoffHtml(target) {
  const href = JSON.stringify(target);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Returning to Token Tracker</title></head><body><p>Returning to Token Tracker… <a href=${href}>Open Token Tracker</a></p><script>location.replace(${href});</script></body></html>`;
}

function sendHtmlDocument(res, html) {
  const body = Buffer.from(html);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendNotFound(res) {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Not Found");
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onListening = () => finish(resolve);
    const onError = (error) => finish(reject, error);

    server.once("listening", onListening);
    server.once("error", onError);
    try {
      server.listen(port, host);
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function listenOnAvailablePort(
  server,
  startPort,
  {
    host = LOCAL_BIND_HOST,
    allowFallback = false,
    maxAttempts = DEFAULT_MAX_PORT_ATTEMPTS,
    ensurePortFreeFn = null,
    onRetry = null,
  } = {},
) {
  const attempts = allowFallback ? Math.max(1, maxAttempts) : 1;
  let port = startPort;
  let lastError = null;

  for (let i = 0; i < attempts && port < 65536; i++, port++) {
    if (ensurePortFreeFn) {
      await ensurePortFreeFn(port);
    }

    try {
      await listenOnce(server, port, host);
      return port;
    } catch (error) {
      lastError = error;
      if (!allowFallback || !isPortUnavailableError(error) || port >= 65535) {
        throw error;
      }
      if (typeof onRetry === "function") {
        onRetry(port, error);
      }
    }
  }

  throw lastError || new Error(`No available port found from ${startPort}`);
}

function resolveDashboardDir() {
  const candidates = [
    path.resolve(__dirname, "../../dashboard/dist"),
    path.resolve(__dirname, "../dashboard/dist"),
  ];
  for (const dir of candidates) {
    if (fssync.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

function parsePort(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
}

function isRunningUnderWsl(env = process.env, readFileFn = fssync.readFileSync) {
  if (process.platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(String(readFileFn("/proc/version", "utf8")));
  } catch (_e) {
    return false;
  }
}

function resolveDefaultPort(env = process.env, readFileFn) {
  return isRunningUnderWsl(env, readFileFn) ? WSL_DEFAULT_PORT : DEFAULT_PORT;
}

function parseArgs(argv, env = process.env) {
  const envPort = parsePort(env.PORT);
  const defaultPort = resolveDefaultPort(env);
  const opts = {
    port: envPort || defaultPort,
    portExplicit: Boolean(envPort),
    wslDefaultPort: !envPort && defaultPort === WSL_DEFAULT_PORT,
    open: true,
    sync: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && i + 1 < argv.length) {
      const n = parsePort(argv[++i]);
      if (n) {
        opts.port = n;
        opts.portExplicit = true;
        opts.wslDefaultPort = false;
      }
    } else if (arg === "--no-open") {
      opts.open = false;
    } else if (arg === "--no-sync") {
      opts.sync = false;
    }
  }
  return opts;
}

module.exports = {
  cmdServe,
  buildPortInUseHint,
  NPM_PACKAGE_NAME,
  LOCAL_BIND_HOST,
  isPortUnavailableError,
  listenOnAvailablePort,
  getLocalServerUrl,
  parseArgs,
  ensurePortFree,
  isRunningUnderWsl,
  isTokenTrackerServeCommand,
  parseServeScriptPath,
  resolveDefaultPort,
  shouldServeSpaFallback,
  linuxOAuthHandoffTarget,
  requestWantsLinuxOAuthHandoff,
  linuxOAuthHandoffHtml,
  startNativeBackgroundSync,
  NATIVE_BACKGROUND_SYNC_INTERVAL_MS,
};
