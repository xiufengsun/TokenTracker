"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const { readJson, updateJsonLocked } = require("../lib/fs");
const { resolveTrackerPaths } = require("../lib/tracker-paths");
const { resolveRuntimeConfig } = require("../lib/runtime-config");
const { functionUrlFor, fetchFunctionResponse } = require("../lib/function-url");

const POLL_INTERVAL_MS = 5_000;
const ABSOLUTE_TIMEOUT_MS = 16 * 60 * 1000; // matches the 15-min server window with a small buffer

function readBaseUrl(config) {
  return resolveRuntimeConfig({
    // Preserve device-login's explicit legacy override names and precedence,
    // while routing persisted config through the shared retired-host filter.
    cli: {
      baseUrl:
        process.env.TOKENTRACKER_BASE_URL ||
        process.env.TOKENTRACKER_API_URL,
    },
    config: config || {},
    env: {},
  }).baseUrl;
}

async function authorize({ baseUrl, clientInfo, machineId }) {
  const res = await fetchFunctionResponse(functionUrlFor(baseUrl, "tokentracker-device-flow-authorize"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_info: clientInfo,
      // Machine-stable identity: the server anchors the issued device to this
      // id instead of the hostname-derived display name, so hostname renames
      // don't mint duplicate devices and two machines sharing a default
      // hostname don't collapse into one (token ping-pong + row overwrite).
      ...(machineId ? { machine_id: machineId } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`authorize failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function pollOnce({ baseUrl, deviceCode }) {
  const res = await fetchFunctionResponse(functionUrlFor(baseUrl, "tokentracker-device-flow-poll"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  const data = await res.json().catch(() => ({}));
  // 404 = unknown, 410 = expired, 200 = {status, user_id?, device_token?}.
  // Anything else (502 from a misconfigured edge, 5xx during deploy, …) must
  // bubble up as a network-style error — masking it as "unknown" would tell
  // the user their device_code was evicted when it wasn't.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`poll HTTP ${res.status}: ${(data?.error ?? "").toString().slice(0, 200)}`);
  }
  return {
    status: data.status ?? "unknown",
    user_id: data.user_id ?? null,
    deviceToken: data.device_token ?? data.deviceToken ?? null,
    deviceId: data.device_id ?? data.deviceId ?? null,
    httpStatus: res.status,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdDeviceLogin(argv = [], options = {}) {
  const opts = parseArgs(argv);
  const home = options.home || os.homedir();
  const sleepFn = options.sleep || sleep;
  const { trackerDir } = await resolveTrackerPaths({ home });
  const configPath = path.join(trackerDir, "config.json");
  const config = (await readJson(configPath)) || {};
  const baseUrl = opts.baseUrl || readBaseUrl(config);

  const clientInfo = `${os.platform()}-${os.arch()} ${os.hostname()}`;
  // Same machineId the local API serves to the dashboard — both login paths
  // must resolve to the SAME cloud device row for this machine.
  const { getOrCreateMachineId } = require("../lib/local-api");
  const machineId = getOrCreateMachineId(path.join(trackerDir, "queue.jsonl"));
  process.stdout.write(`Requesting device code from ${baseUrl}...\n`);
  const authResp = await authorize({ baseUrl, clientInfo, machineId });

  if (opts.json) {
    process.stdout.write(JSON.stringify(authResp, null, 2) + "\n");
  } else {
    process.stdout.write(
      [
        "",
        "  Sign in from a browser:",
        `    ${authResp.verification_uri_complete || authResp.verification_uri}`,
        "",
        `  Or visit ${authResp.verification_uri} and enter the code:`,
        "",
        `      ${authResp.user_code}`,
        "",
        `  This code expires in ${Math.round(authResp.expires_in / 60)} minutes.`,
        "  Polling every 5 seconds until you approve…",
        "",
      ].join("\n"),
    );
  }

  const startedAt = Date.now();
  let consecutiveErrors = 0;
  const MAX_BACKOFF_MS = 30_000;
  while (Date.now() - startedAt < ABSOLUTE_TIMEOUT_MS) {
    // Exponential backoff on consecutive network failures (capped at 30s) so
    // a flaky network doesn't hammer the server at the full 5s cadence for
    // the entire 15-minute window. ±20% jitter on retries prevents
    // thundering-herd reconnects when many CLIs lose connectivity at once.
    let wait =
      consecutiveErrors === 0
        ? POLL_INTERVAL_MS
        : Math.min(POLL_INTERVAL_MS * Math.pow(2, consecutiveErrors - 1), MAX_BACKOFF_MS);
    if (consecutiveErrors > 0) {
      const jitter = wait * 0.2 * (Math.random() * 2 - 1);
      wait = Math.max(POLL_INTERVAL_MS, wait + jitter);
    }
    await sleepFn(wait);
    let result;
    try {
      result = await pollOnce({ baseUrl, deviceCode: authResp.device_code });
      consecutiveErrors = 0;
    } catch (e) {
      consecutiveErrors++;
      process.stderr.write(`poll error (retry ${consecutiveErrors}): ${e?.message || e}\n`);
      continue;
    }
    if (result.status === "approved" && result.user_id) {
      if (!result.deviceToken) {
        throw new Error("device login approved but server did not return a device token");
      }
      await updateJsonLocked(configPath, async (current) => ({
        ...current,
        ...(machineId ? { machineId } : {}),
        baseUrl,
        user_id: result.user_id,
        deviceToken: result.deviceToken,
        deviceId: result.deviceId || current.deviceId || config.deviceId,
        device_login_at: new Date().toISOString(),
      }));
      process.stdout.write(`\n✓ Approved. device token written to ${configPath}\n`);
      return;
    }
    if (result.status === "expired") {
      throw new Error("device_code expired — re-run `tracker device-login`");
    }
    if (result.status === "unknown") {
      throw new Error("device_code is unknown — server may have evicted it");
    }
    // status === "pending" → just keep polling silently
  }
  throw new Error("device-login timed out without approval");
}

function parseArgs(argv) {
  const out = { json: false, baseUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--base-url") {
      out.baseUrl = argv[++i] || null;
    } else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

module.exports = { cmdDeviceLogin, authorize, pollOnce };
