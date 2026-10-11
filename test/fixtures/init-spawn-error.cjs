"use strict";

const assert = require("node:assert/strict");
const events = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-init-spawn-"));
  const prevHome = process.env.HOME;
  // os.homedir() reads USERPROFILE on Windows and ignores HOME, so isolating via
  // HOME alone leaks cmdInit's config write into the developer's real
  // ~/.tokentracker on Windows (corrupting config.baseUrl to example.invalid and
  // breaking cloud upload). Redirect USERPROFILE too.
  const prevUserProfile = process.env.USERPROFILE;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevToken = process.env.TOKENTRACKER_DEVICE_TOKEN;
  const prevWrite = process.stdout.write;
  const originalSpawn = cp.spawn;

  let errorListenerAttached = false;

  try {
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    process.env.CODEX_HOME = path.join(tmp, ".codex");
    delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME, "config.toml"), "# empty\n", "utf8");

    cp.spawn = (...args) => {
      const emitter = new events.EventEmitter();
      const originalOn = emitter.on.bind(emitter);
      emitter.on = (event, listener) => {
        if (event === "error") errorListenerAttached = true;
        return originalOn(event, listener);
      };
      emitter.unref = () => {};
      process.nextTick(() => emitter.emit("error", new Error("spawn fail")));
      return emitter;
    };

    delete require.cache[require.resolve("../../src/commands/init")];
    const { cmdInit } = require("../../src/commands/init");

    process.stdout.write = () => true;
    const publicAnon = [Buffer.from('{"alg":"HS256"}').toString("base64url"),
      Buffer.from('{"role":"anon"}').toString("base64url"), "test-signature"].join(".");
    await cmdInit(["--yes", "--no-auth", "--no-open", "--base-url", "https://example.invalid", "--anon-key", publicAnon]);

    assert.ok(errorListenerAttached, "expected spawn error handler");
  } finally {
    cp.spawn = originalSpawn;
    process.stdout.write = prevWrite;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevToken === undefined) delete process.env.TOKENTRACKER_DEVICE_TOKEN;
    else process.env.TOKENTRACKER_DEVICE_TOKEN = prevToken;
    await fs.rm(tmp, { recursive: true, force: true });
  }
})().catch((err) => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exit(1);
});
