#!/usr/bin/env node
/* eslint-disable no-console */

const { run } = require('../src/cli');
const { stripDebugFlag } = require('../src/lib/debug-flags');
const {
  relaunchWithProxyEnvIfNeeded,
  applyUndiciProxyIfNeeded,
  readPersistedProxyConfig,
} = require('../src/lib/proxy-env');

const { argv, debug } = stripDebugFlag(process.argv.slice(2));
if (debug) process.env.TOKENTRACKER_DEBUG = '1';

const persistedProxy = readPersistedProxyConfig();
const relaunch = relaunchWithProxyEnvIfNeeded({
  argv,
  originalArgv: process.argv.slice(1),
  proxyConfig: persistedProxy,
});
if (relaunch) {
  if (typeof relaunch.status === 'number') process.exit(relaunch.status);
  if (relaunch.error) {
    console.error(relaunch.error?.stack || String(relaunch.error));
    process.exit(1);
  }
  process.exit(0);
}

// NODE_USE_ENV_PROXY only works on Node 22.21+/24.5+. For older runtimes
// (including community users on stale Node, and the embedded Node shipped
// with older macOS app builds), set an undici ProxyAgent so fetch() actually
// honors HTTPS_PROXY. Safe to run on modern Node too — explicit dispatcher
// takes precedence over the env-var-driven default.
const applyResult = applyUndiciProxyIfNeeded({ proxyConfig: persistedProxy });
if (applyResult && applyResult.unprotected === true) {
  console.error('[proxy] Manual proxy could not be applied and outbound traffic could not be blocked; aborting.');
  console.error('[proxy] 手动代理无法生效且无法阻断出站流量，已中止。');
  process.exit(1);
}

run(argv).catch((err) => {
  if (!debug && isUsageError(err)) {
    console.error(err.message);
  } else {
    console.error(err?.stack || String(err));
  }
  if (debug) {
    if (typeof err?.status === 'number') {
      console.error(`Status: ${err.status}`);
    }
    if (typeof err?.code === 'string' && err.code.trim()) {
      console.error(`Code: ${err.code.trim()}`);
    }
    const original = err?.originalMessage;
    if (original && original !== err?.message) {
      console.error(`Original error: ${original}`);
    }
    if (typeof err?.nextActions === 'string' && err.nextActions.trim()) {
      console.error(`Next actions: ${err.nextActions.trim()}`);
    }
  }
  process.exitCode = 1;
});

function isUsageError(err) {
  const message = typeof err?.message === "string" ? err.message : "";
  return message.startsWith("Unknown command:") || message.startsWith("Unknown option:");
}
