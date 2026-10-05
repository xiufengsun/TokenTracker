"use strict";

/**
 * Anonymous daily heartbeat for counting active installs.
 *
 * Privacy contract (documented in README "Privacy" section — keep in sync):
 * the payload carries exactly four fields — a one-way sha256 hash of the
 * machine id, the app version, `process.platform`, and the app shell
 * (cli / macos / windows / linux). No token counts, no model names, no usernames,
 * no paths. Opt out with TOKENTRACKER_NO_TELEMETRY=1, the DO_NOT_TRACK
 * standard, or `"telemetry": false` in config.json.
 */

const path = require("node:path");
const crypto = require("node:crypto");

const pkg = require("../../package.json");
const { readJson, writeJson } = require("./fs");
const { getOrCreateMachineId } = require("./machine-id");
const { resolveRuntimeConfig } = require("./runtime-config");
const { functionUrlFor, fetchFunctionResponse } = require("./function-url");
const {
  decideAutoUpload,
  recordUploadSuccess,
  recordUploadFailure,
} = require("./upload-throttle");

const HEARTBEAT_FUNCTION_SLUG = "tokentracker-telemetry";
const HEARTBEAT_STATE_FILE = "telemetry.heartbeat.json";
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The hash namespace is versioned so the anonymous id can be rotated fleet-wide
// by bumping the string. sha256(namespace + machineId) cannot be joined back to
// the cloud device rows (those store the machineId itself).
const MACHINE_HASH_NAMESPACE = "tokentracker-telemetry-v1:";
// Generous because some networks need 3-4s just for the TLS handshake to the
// cloud host; sync awaits this at most once per day so the worst-case stall
// is bounded and rare.
const DEFAULT_TIMEOUT_MS = 10_000;
const VALID_SHELLS = new Set(["cli", "macos", "windows", "linux"]);

const THROTTLE_CONFIG = {
  intervalMs: HEARTBEAT_INTERVAL_MS,
  jitterMsMax: 60_000,
  backoffInitialMs: 60 * 60_000, // failures retry hourly at most
  backoffMaxMs: HEARTBEAT_INTERVAL_MS,
};

function isTelemetryDisabled({ env = process.env, config = {} } = {}) {
  if (isTruthyFlag(env?.TOKENTRACKER_NO_TELEMETRY)) return true;
  if (isTruthyFlag(env?.DO_NOT_TRACK)) return true;
  if (config && config.telemetry === false) return true;
  return false;
}

function isTruthyFlag(value) {
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true";
}

function hashMachineId(machineId) {
  return crypto
    .createHash("sha256")
    .update(`${MACHINE_HASH_NAMESPACE}${machineId}`)
    .digest("hex");
}

function resolveShell(env = process.env) {
  const raw = typeof env?.TOKENTRACKER_APP_SHELL === "string"
    ? env.TOKENTRACKER_APP_SHELL.trim().toLowerCase()
    : "";
  return VALID_SHELLS.has(raw) ? raw : "cli";
}

function buildHeartbeatPayload({ machineId, version = pkg.version, platform = process.platform, env = process.env }) {
  return {
    machine_hash: hashMachineId(machineId),
    app_version: String(version || "").slice(0, 32),
    platform: String(platform || "unknown").slice(0, 16),
    shell: resolveShell(env),
  };
}

/**
 * Send the daily heartbeat if allowed. Never throws; every failure path is a
 * silent no-op so serve/sync flow is never affected. Returns a small status
 * object for tests and debug logging.
 */
async function maybeSendHeartbeat({
  trackerDir,
  fetchImpl = fetch,
  nowMs = Date.now(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  version,
} = {}) {
  try {
    if (!trackerDir) return { sent: false, reason: "no-tracker-dir" };

    // Never phone home from the node test runner: many tests drive cmdSync /
    // cmdServe directly from sandboxed temp homes, and their fresh throttle
    // state would let a real POST through to production on every run. Tests
    // that exercise this module inject their own env without this marker.
    if (env?.NODE_TEST_CONTEXT !== undefined) {
      return { sent: false, reason: "test-env" };
    }

    const configPath = path.join(trackerDir, "config.json");
    const config = (await readJson(configPath)) || {};
    if (isTelemetryDisabled({ env, config })) {
      return { sent: false, reason: "opt-out" };
    }

    const statePath = path.join(trackerDir, HEARTBEAT_STATE_FILE);
    const state = await readJson(statePath);
    const decision = decideAutoUpload({
      nowMs,
      pendingBytes: 1, // heartbeats always have "one ping pending"
      state,
      config: THROTTLE_CONFIG,
    });
    if (!decision.allowed) {
      return { sent: false, reason: "throttled", blockedUntilMs: decision.blockedUntilMs };
    }

    const machineId = getOrCreateMachineId(path.join(trackerDir, "queue.jsonl"));
    if (!machineId) return { sent: false, reason: "no-machine-id" };

    const runtime = resolveRuntimeConfig({ config, env });
    const payload = buildHeartbeatPayload({ machineId, version, env });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFunctionResponse(functionUrlFor(runtime.baseUrl, HEARTBEAT_FUNCTION_SLUG), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: runtime.anonKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, fetchImpl);
    } finally {
      clearTimeout(timer);
    }

    if (!response || !response.ok) {
      const failedState = recordUploadFailure({
        nowMs,
        state,
        error: { message: `heartbeat http ${response?.status || "error"}`, status: response?.status },
        config: THROTTLE_CONFIG,
      });
      await writeJson(statePath, failedState);
      return { sent: false, reason: "http-error", status: response?.status };
    }

    const nextState = recordUploadSuccess({ nowMs, state, config: THROTTLE_CONFIG });
    await writeJson(statePath, nextState);
    return { sent: true, reason: "sent" };
  } catch (e) {
    // Includes abort/network errors: record backoff if we can, stay silent.
    try {
      const statePath = path.join(trackerDir, HEARTBEAT_STATE_FILE);
      const state = await readJson(statePath);
      await writeJson(
        statePath,
        recordUploadFailure({
          nowMs,
          state,
          error: { message: String(e?.message || e) },
          config: THROTTLE_CONFIG,
        }),
      );
    } catch {
      // Even state persistence failed — nothing else to do.
    }
    return { sent: false, reason: "error" };
  }
}

module.exports = {
  HEARTBEAT_FUNCTION_SLUG,
  HEARTBEAT_STATE_FILE,
  HEARTBEAT_INTERVAL_MS,
  isTelemetryDisabled,
  hashMachineId,
  resolveShell,
  buildHeartbeatPayload,
  maybeSendHeartbeat,
};
