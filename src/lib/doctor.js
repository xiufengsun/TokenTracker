const fs = require("node:fs/promises");
const { constants } = require("node:fs");

const { readJsonStrict } = require("./fs");

async function buildDoctorReport({
  runtime = {},
  diagnostics = null,
  fetch = globalThis.fetch,
  now = () => new Date(),
  paths = {},
} = {}) {
  const checks = [];

  checks.push(...buildRuntimeChecks(runtime));

  if (paths.trackerDir) {
    checks.push(await checkTrackerDir(paths.trackerDir));
  }
  if (paths.configPath) {
    checks.push(await checkConfigJson(paths.configPath));
  }
  if (paths.cliPath) {
    checks.push(await checkCliEntrypoint(paths.cliPath));
  }

  checks.push(await checkNetwork({ baseUrl: runtime?.baseUrl || null, fetch }));

  if (diagnostics) {
    checks.push(...buildDiagnosticsChecks(diagnostics));
  }

  const summary = summarizeChecks(checks);

  return {
    version: 1,
    generated_at: now().toISOString(),
    ok: summary.critical === 0,
    summary,
    checks,
    diagnostics,
  };
}

function buildRuntimeChecks(runtime = {}) {
  const checks = [];
  const baseUrl =
    typeof runtime.baseUrl === "string" && runtime.baseUrl.trim() ? runtime.baseUrl.trim() : null;
  const deviceToken =
    typeof runtime.deviceToken === "string" && runtime.deviceToken.trim() ? "set" : "unset";
  const dashboardUrl =
    typeof runtime.dashboardUrl === "string" && runtime.dashboardUrl.trim()
      ? runtime.dashboardUrl.trim()
      : null;
  const httpTimeoutMs = Number.isFinite(Number(runtime.httpTimeoutMs))
    ? Number(runtime.httpTimeoutMs)
    : null;
  const debug = Boolean(runtime.debug);
  const autoRetryNoSpawn = Boolean(runtime.autoRetryNoSpawn);

  checks.push({
    id: "runtime.base_url",
    status: baseUrl ? "ok" : "fail",
    detail: baseUrl ? "base_url set" : "base_url missing",
    critical: false,
    meta: {
      base_url: baseUrl,
      source: runtime?.sources?.baseUrl || null,
    },
  });

  checks.push({
    id: "runtime.device_token",
    status: deviceToken === "set" ? "ok" : "warn",
    detail: deviceToken === "set" ? "device token set" : "device token missing",
    critical: false,
    meta: {
      device_token: deviceToken,
      source: runtime?.sources?.deviceToken || null,
    },
  });

  checks.push({
    id: "runtime.dashboard_url",
    status: "ok",
    detail: dashboardUrl ? "dashboard_url set" : "dashboard_url unset",
    critical: false,
    meta: {
      dashboard_url: dashboardUrl,
      source: runtime?.sources?.dashboardUrl || null,
    },
  });

  checks.push({
    id: "runtime.http_timeout_ms",
    status: "ok",
    detail: "http timeout resolved",
    critical: false,
    meta: {
      http_timeout_ms: httpTimeoutMs,
      source: runtime?.sources?.httpTimeoutMs || null,
    },
  });

  checks.push({
    id: "runtime.debug",
    status: "ok",
    detail: debug ? "debug enabled" : "debug disabled",
    critical: false,
    meta: {
      debug,
      source: runtime?.sources?.debug || null,
    },
  });

  checks.push({
    id: "runtime.auto_retry_no_spawn",
    status: "ok",
    detail: autoRetryNoSpawn ? "auto retry spawn disabled" : "auto retry spawn enabled",
    critical: false,
    meta: {
      auto_retry_no_spawn: autoRetryNoSpawn,
      source: runtime?.sources?.autoRetryNoSpawn || null,
    },
  });

  return checks;
}

async function checkTrackerDir(trackerDir) {
  try {
    const st = await fs.stat(trackerDir);
    if (!st.isDirectory()) {
      return {
        id: "fs.tracker_dir",
        status: "fail",
        detail: "tracker dir is not a directory",
        critical: true,
        meta: { path: trackerDir },
      };
    }
    await fs.access(trackerDir, constants.R_OK);
    return {
      id: "fs.tracker_dir",
      status: "ok",
      detail: "tracker dir readable",
      critical: false,
      meta: { path: trackerDir },
    };
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      return {
        id: "fs.tracker_dir",
        status: "warn",
        detail: "tracker dir missing",
        critical: false,
        meta: { path: trackerDir },
      };
    }
    if (err && (err.code === "EACCES" || err.code === "EPERM")) {
      return {
        id: "fs.tracker_dir",
        status: "fail",
        detail: "tracker dir permission denied",
        critical: true,
        meta: { path: trackerDir, code: err.code },
      };
    }
    return {
      id: "fs.tracker_dir",
      status: "fail",
      detail: "tracker dir error",
      critical: true,
      meta: { path: trackerDir, code: err?.code || "error" },
    };
  }
}

async function checkConfigJson(configPath) {
  const res = await readJsonStrict(configPath);
  if (res.status === "ok") {
    return {
      id: "fs.config_json",
      status: "ok",
      detail: "config.json readable",
      critical: false,
      meta: { path: configPath },
    };
  }
  if (res.status === "missing") {
    return {
      id: "fs.config_json",
      status: "warn",
      detail: "config.json missing",
      critical: false,
      meta: { path: configPath },
    };
  }
  if (res.status === "invalid") {
    return {
      id: "fs.config_json",
      status: "fail",
      detail: "config.json invalid",
      critical: true,
      meta: { path: configPath },
    };
  }
  return {
    id: "fs.config_json",
    status: "fail",
    detail: "config.json read error",
    critical: true,
    meta: { path: configPath },
  };
}

async function checkCliEntrypoint(cliPath) {
  try {
    const st = await fs.stat(cliPath);
    if (!st.isFile()) {
      return {
        id: "cli.entrypoint",
        status: "fail",
        detail: "cli entrypoint is not a file",
        critical: false,
        meta: { path: cliPath },
      };
    }
    await fs.access(cliPath, constants.R_OK);
    if (process.platform !== "win32") {
      await fs.access(cliPath, constants.X_OK);
    }
    return {
      id: "cli.entrypoint",
      status: "ok",
      detail: "cli entrypoint readable",
      critical: false,
      meta: { path: cliPath },
    };
  } catch (err) {
    return {
      id: "cli.entrypoint",
      status: "fail",
      detail: "cli entrypoint not accessible",
      critical: false,
      meta: { path: cliPath, code: err?.code || "error" },
    };
  }
}

async function checkNetwork({ baseUrl, fetch }) {
  if (!baseUrl) {
    return {
      id: "network.base_url",
      status: "warn",
      detail: "base_url missing (skipped)",
      critical: false,
      meta: { base_url: null },
    };
  }

  const start = Date.now();
  try {
    if (typeof fetch !== "function") throw new Error("Missing fetch");
    const res = await fetch(baseUrl, { method: "GET" });
    const latency = Date.now() - start;
    return {
      id: "network.base_url",
      status: "ok",
      detail: `HTTP ${res.status} (reachable)`,
      critical: false,
      meta: {
        status_code: res.status,
        latency_ms: latency,
        base_url: baseUrl,
      },
    };
  } catch (err) {
    const latency = Date.now() - start;
    return {
      id: "network.base_url",
      status: "fail",
      detail: "Network error",
      critical: false,
      meta: {
        error: err?.message || String(err),
        latency_ms: latency,
        base_url: baseUrl,
      },
    };
  }
}

function buildDiagnosticsChecks(diagnostics) {
  const checks = [];
  const notify = diagnostics?.notify || {};
  const notifyConfigured = Boolean(
    notify.codex_notify_configured ||
    notify.every_code_notify_configured ||
    notify.claude_hook_configured ||
    notify.gemini_hook_configured ||
    notify.opencode_plugin_configured ||
    notify.openclaw_hook_configured,
  );

  checks.push({
    id: "notify.configured",
    status: notifyConfigured ? "ok" : "warn",
    detail: notifyConfigured ? "notify configured" : "notify not configured",
    critical: false,
    meta: { configured: notifyConfigured },
  });

  const uploadError = diagnostics?.upload?.last_error || null;
  checks.push({
    id: "upload.last_error",
    status: uploadError ? "warn" : "ok",
    detail: uploadError ? "last upload error present" : "no upload errors",
    critical: false,
    meta: { last_error: uploadError ? uploadError.message || null : null },
  });

  // Dual-install visibility (#306): surface resolved Kiro installs in the
  // human-readable doctor output, not just the embedded diagnostics JSON.
  const kiro = diagnostics?.kiro;
  if (kiro && typeof kiro.wsl_mode === "string") {
    const fmt = (present) => (present ? "yes" : "no");
    const wslPart = kiro.wsl_installs
      ? `wsl ide=${fmt(kiro.wsl_installs.ide_present)} cli=${fmt(kiro.wsl_installs.cli_present)}`
      : "wsl not detected";
    checks.push({
      id: "kiro.installs",
      status: "ok",
      detail: `native ide=${fmt(kiro.ide_present)} cli=${fmt(kiro.cli_present)}; ${wslPart} (mode ${kiro.wsl_mode})`,
      critical: false,
      meta: { wsl_mode: kiro.wsl_mode, wsl_installs: kiro.wsl_installs || null },
    });
  }

  // Extra scan roots (#657): surface CODEX_HOME / CLAUDE_CONFIG_DIR / config
  // roots in the human-readable report and warn when a configured root is not
  // on disk — a silently missing root is the difference between "no usage"
  // and "not scanned". Installs without extras get no additional line.
  const scanRoots = diagnostics?.scan_roots;
  if (scanRoots && typeof scanRoots === "object") {
    const extras = [];
    for (const provider of ["codex", "claude"]) {
      for (const entry of Array.isArray(scanRoots[provider]) ? scanRoots[provider] : []) {
        if (!entry || entry.origin === "native") continue;
        extras.push({ provider, ...entry });
      }
    }
    if (extras.length > 0) {
      const missing = extras.filter((entry) => !entry.exists);
      const describe = (list) => list
        .map((entry) => `${entry.provider} ${entry.path}${entry.error ? ` (unreadable: ${entry.error})` : ""}`)
        .join(", ");
      checks.push({
        id: "scan_roots.extra",
        status: missing.length > 0 ? "warn" : "ok",
        detail: missing.length > 0
          ? `${missing.length} of ${extras.length} extra scan root(s) unavailable: ${describe(missing)}`
          : `${extras.length} extra scan root(s) present: ${describe(extras)}`,
        critical: false,
        meta: { roots: extras },
      });
    }
  }

  return checks;
}

function summarizeChecks(checks = []) {
  const summary = { ok: 0, warn: 0, fail: 0, critical: 0 };
  for (const check of checks) {
    if (!check || typeof check.status !== "string") continue;
    if (check.status === "ok") summary.ok += 1;
    else if (check.status === "warn") summary.warn += 1;
    else if (check.status === "fail") summary.fail += 1;
    if (check.status === "fail" && check.critical) summary.critical += 1;
  }
  return summary;
}

module.exports = { buildDoctorReport };
