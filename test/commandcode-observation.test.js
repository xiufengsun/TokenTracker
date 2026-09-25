"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src") + path.sep;
const T0 = "2026-05-01T12:00:00.000Z";
const TOTALS = {
  input_tokens: 1000, cached_input_tokens: 0, cache_creation_input_tokens: 0,
  output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100,
  billable_total_tokens: 1100, total_cost_usd: 0.42, conversation_count: 1,
};
const ROW = { source: "command-code", model: "deepseek-v4.1-flash", hour_start: T0, ...TOTALS };
const PROJECT_KEY = "acme/synthetic-observation";
const PROJECT_ROW = {
  project_key: PROJECT_KEY, project_ref: `https://github.com/${PROJECT_KEY}`,
  source: "command-code", hour_start: T0, ...TOTALS,
};
const DOUBLE_TOTALS = {
  ...TOTALS, input_tokens: 2000, output_tokens: 200, total_tokens: 2200,
  billable_total_tokens: 2200, total_cost_usd: 0.84, conversation_count: 2,
};
const ZERO_TOTALS = Object.fromEntries(Object.keys(TOTALS).map((key) => [key, 0]));

function message(id) {
  return JSON.stringify({
    type: "message", id, timestamp: T0, model: "deepseek/deepseek-v4.1-flash", message: null,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.42 },
  });
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function readRows(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "commandcode-observation-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, "synthetic-project");
  const config = path.join(repo, ".git", "config");
  const file = path.join(home, ".commandcode", "projects", "fixture", "session.jsonl");
  write(config, `[remote "origin"]\n\turl = ${PROJECT_ROW.project_ref}.git\n`);
  write(file, `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: repo })}\n${message("m1")}\n`);
  return { home, repo, config, file };
}

// Each test gets private CommonJS module instances and private built-in
// dependency facades. No global fs method, require cache or WSL cache is patched.
function scopedModules({ home, env = {}, redirect = (file) => file, ioFailure, runWsl, onHandle, onOpen } = {}) {
  const cache = new Map();
  const localEnv = {
    PATH: process.env.PATH || "", SystemRoot: process.env.SystemRoot || "C:\\Windows",
    HOME: home, USERPROFILE: home, TEMP: home, TMP: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    TOKENTRACKER_WSL_MODE: "native-only", TOKENTRACKER_NO_TELEMETRY: "1", DO_NOT_TRACK: "1",
    ...env,
  };
  const localProcess = Object.create(process);
  Object.defineProperties(localProcess, { env: { value: localEnv }, platform: { value: "win32" } });
  const localPromises = { ...fsp };
  for (const method of ["open", "stat", "readFile", "readdir"]) {
    localPromises[method] = async (file, ...args) => {
      const resolved = redirect(file);
      const error = ioFailure?.(method, resolved);
      if (error) throw error;
      if (method === "open") onOpen?.(resolved, args);
      const value = await fsp[method](resolved, ...args);
      if (method !== "open") return value;
      onHandle?.(value, resolved);
      for (const operation of ["stat", "readFile", "close"]) {
        const invoke = value[operation].bind(value);
        value[operation] = async (...handleArgs) => {
          const failure = ioFailure?.(operation, resolved, value);
          // Simulated close failures still release this real fixture handle.
          if (operation === "close") {
            const result = await invoke(...handleArgs);
            if (failure) throw failure;
            return result;
          }
          if (failure) throw failure;
          return invoke(...handleArgs);
        };
      }
      return value;
    };
  }
  const localFs = { ...fs, promises: localPromises };
  for (const method of ["statSync", "existsSync"]) {
    localFs[method] = (file, ...args) => fs[method](redirect(file), ...args);
  }
  const childProcess = {
    ...require("node:child_process"),
    execFileSync(command, args, options) {
      assert.equal(command, "wsl.exe", "only synthetic WSL commands are expected");
      assert.equal(typeof runWsl, "function", "no real WSL invocation is allowed");
      return runWsl(args, options);
    },
  };
  const builtins = {
    fs: localFs, "fs/promises": localPromises,
    os: { ...os, homedir: () => home, tmpdir: () => home },
    child_process: childProcess, process: localProcess,
  };
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const localRequire = createRequire(filename);
    const module = { exports: {}, filename };
    cache.set(filename, module);
    function scopedRequire(specifier) {
      const builtin = specifier.replace(/^node:/, "");
      if (Object.hasOwn(builtins, builtin)) return builtins[builtin];
      const resolved = localRequire.resolve(specifier);
      return resolved.startsWith(SRC) && resolved.endsWith(".js") ? load(resolved) : localRequire(specifier);
    }
    scopedRequire.resolve = localRequire.resolve;
    let source = fs.readFileSync(filename, "utf8");
    if (filename === path.join(ROOT, "src", "lib", "rollout.js")) {
      source += "\nmodule.exports.projectObservationTest = { resolveGitConfigPath, readGitRemoteUrl, resolveProjectContextForPath };";
    }
    const evaluate = new Function("exports", "require", "module", "__filename", "__dirname", "process", source);
    evaluate(module.exports, scopedRequire, module, filename, path.dirname(filename), localProcess);
    return module.exports;
  }
  return { load: (file) => load(path.join(ROOT, file)), env: localEnv };
}

for (const operation of ["list", "whoami"]) {
  for (const code of ["ETIMEDOUT", "EIO", "EACCES", "EPERM"]) {
    test(`strict WSL ${operation} ${code} rejects and recovers from a default-provider negative cache`, (t) => {
      const { home } = fixture(t);
      const injected = Object.assign(new Error(`synthetic ${operation}`), { code });
      let fail = true;
      let calls = 0;
      const runtime = scopedModules({ home, runWsl(args) {
        const list = args[0] === "-l";
        if ((operation === "list") === list) {
          calls += 1;
          if (fail) throw injected;
        }
        return Buffer.from(list ? "  NAME STATE VERSION\n* Synthetic Running 2\n" : "fixture\n", list ? "utf16le" : "utf8");
      } });
      const wsl = runtime.load("src/lib/wsl-probe.js");
      const options = { existsSync: () => true, env: { TOKENTRACKER_WSL_MODE: "wsl-only" } };
      assert.equal(wsl.discoverWslHome(".commandcode", options), null, "default providers retain fail-safe behavior");
      assert.equal(wsl.discoverWslHome(".commandcode", options), null);
      assert.equal(calls, 1, "default negative-cache behavior is unchanged");
      assert.throws(() => wsl.discoverWslHome(".commandcode", { ...options, strict: true }), (error) => error === injected);
      fail = false;
      assert.equal(wsl.discoverWslHome(".commandcode", { ...options, strict: true }), "\\\\wsl$\\Synthetic\\home\\fixture\\.commandcode");
      assert.equal(calls, 3, "strict recovery retries, without resetting unrelated caches");
    });
  }
}

for (const missing of ["executable", "distros"]) {
  test(`strict WSL treats confirmed missing ${missing} as a normal empty result`, (t) => {
    const { home } = fixture(t);
    const runtime = scopedModules({ home, runWsl(args) {
      assert.equal(args[0], "-l");
      if (missing === "executable") throw Object.assign(new Error("synthetic missing wsl.exe"), { code: "ENOENT" });
      return Buffer.from("  NAME STATE VERSION\n", "utf16le");
    } });
    const wsl = runtime.load("src/lib/wsl-probe.js");
    assert.deepEqual(wsl.probeWslDistros({ strict: true }), []);
    assert.equal(wsl.discoverWslHome(".commandcode", { strict: true, env: { TOKENTRACKER_WSL_MODE: "wsl-only" } }), null);
  });
}

test("strict WSL never probes in native-only mode and does not accept an empty identity", (t) => {
  const { home } = fixture(t);
  let calls = 0;
  const runtime = scopedModules({ home, runWsl(args) {
    calls += 1;
    return Buffer.from(args[0] === "-l" ? "  NAME STATE VERSION\n* Synthetic Running 2\n" : "\n", args[0] === "-l" ? "utf16le" : "utf8");
  } });
  const wsl = runtime.load("src/lib/wsl-probe.js");
  assert.equal(wsl.discoverWslHome(".commandcode", { strict: true, env: { TOKENTRACKER_WSL_MODE: "native-only" } }), null);
  assert.equal(calls, 0);
  assert.throws(() => wsl.discoverWslHome(".commandcode", {
    strict: true, env: { TOKENTRACKER_WSL_MODE: "wsl-only" },
  }), { code: "EWSLIDENTITY" });
});

for (const [method, target, code, failAt] of [
  ["readFile", "config", "EIO", 1],
  ["stat", "config", "EACCES", 1],
  ["stat", "config", "EPERM", 2],
  ["stat", "git", "EIO", 1],
]) {
  test(`Command Code rejects project ${target} ${method} ${code} before queue/cursor publication`, async (t) => {
    const { home, config, file } = fixture(t);
    const injected = Object.assign(new Error("synthetic project observation failure"), { code });
    let fail = false;
    let calls = 0;
    const runtime = scopedModules({ home, ioFailure(operation, filename) {
      if (fail && operation === method && filename === (target === "git" ? path.dirname(config) : config)) {
        calls += 1;
        if (calls === failAt) return injected;
      }
      return null;
    } });
    const rollout = runtime.load("src/lib/rollout.js");
    const options = {
      sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
      projectQueuePath: path.join(home, "project.queue.jsonl"),
    };
    await rollout.parseCommandCodeIncremental(options);
    assert.deepEqual(readRows(options.queuePath), [ROW]);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW]);
    const beforeCursor = JSON.stringify(options.cursors);
    const beforeHourly = fs.readFileSync(options.queuePath);
    const beforeProject = fs.readFileSync(options.projectQueuePath);
    const transcriptStat = fs.statSync(file);
    fail = true;
    await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
    assert.equal(JSON.stringify(options.cursors), beforeCursor);
    assert.deepEqual(fs.readFileSync(options.queuePath), beforeHourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), beforeProject);
    assert.equal(options.cursors.projectHourly.projects[PROJECT_KEY].purge_pending, false);
    assert.equal(fs.statSync(file).size, transcriptStat.size);
    assert.equal(fs.statSync(file).mtimeMs, transcriptStat.mtimeMs);
    fail = false;
    const recovered = await rollout.parseCommandCodeIncremental(options);
    assert.equal(recovered.recordsProcessed, 0);
    assert.equal(recovered.eventsAggregated, 0);
    assert.deepEqual(fs.readFileSync(options.queuePath), beforeHourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), beforeProject);
    assert.equal(options.cursors.commandCode.messages["command-code:session|m1"].projectKey, PROJECT_KEY);
  });
}

for (const removed of ["config", "remote"]) {
  test(`Command Code reconciles a successfully observed missing Git ${removed}`, async (t) => {
    const { home, config, file } = fixture(t);
    const rollout = scopedModules({ home }).load("src/lib/rollout.js");
    const options = {
      sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
      projectQueuePath: path.join(home, "project.queue.jsonl"),
    };
    await rollout.parseCommandCodeIncremental(options);
    if (removed === "config") fs.unlinkSync(config);
    else fs.writeFileSync(config, "[core]\n\trepositoryformatversion = 0\n");
    const change = await rollout.parseCommandCodeIncremental(options);
    assert.equal(change.recordsProcessed, 0);
    assert.equal(change.projectBucketsQueued, 1);
    assert.deepEqual(readRows(options.queuePath), [ROW]);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...ZERO_TOTALS }]);
    const again = await rollout.parseCommandCodeIncremental(options);
    assert.equal(again.projectBucketsQueued, 0);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...ZERO_TOTALS }]);
  });
}

test("Git helper strict I/O is opt-in and keeps default-provider fallback behavior", async (t) => {
  const { home, repo, config } = fixture(t);
  const injected = Object.assign(new Error("synthetic helper EIO"), { code: "EIO" });
  let method = "readFile";
  const runtime = scopedModules({ home, ioFailure(operation, file) {
    return operation === method && file === config ? injected : null;
  } });
  const helpers = runtime.load("src/lib/rollout.js").projectObservationTest;
  assert.equal(await helpers.readGitRemoteUrl(config), null);
  await assert.rejects(helpers.readGitRemoteUrl(config, { strictIo: true }), (error) => error === injected);
  method = "stat";
  assert.equal(await helpers.resolveGitConfigPath(repo), null);
  await assert.rejects(helpers.resolveGitConfigPath(repo, { strictIo: true }), (error) => error === injected);
});

test("Command Code aborts mixed new/old usage on project failure instead of inheriting an old public ref", async (t) => {
  const { home, config, file } = fixture(t);
  let fail = false;
  const injected = Object.assign(new Error("synthetic unverified project"), { code: "EIO" });
  const runtime = scopedModules({ home, ioFailure(method, filename) {
    return fail && method === "readFile" && filename === config ? injected : null;
  } });
  const rollout = runtime.load("src/lib/rollout.js");
  const options = {
    sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
    projectQueuePath: path.join(home, "project.queue.jsonl"),
  };
  await rollout.parseCommandCodeIncremental(options);
  const before = JSON.stringify(options.cursors);
  const hourly = fs.readFileSync(options.queuePath);
  const project = fs.readFileSync(options.projectQueuePath);
  fs.appendFileSync(file, message("m2") + "\n");
  fs.writeFileSync(config, '[remote "origin"]\n\turl = file:///synthetic-private-repository\n');
  fail = true;
  await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
  assert.equal(JSON.stringify(options.cursors), before);
  assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
  assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
  fail = false;
  await rollout.parseCommandCodeIncremental(options);
  assert.deepEqual(readRows(options.queuePath), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
  assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...ZERO_TOTALS }]);
  assert.equal(options.cursors.commandCode.messages["command-code:session|m2"].projectKey, null);
  assert.notEqual(options.cursors.commandCode.messages["command-code:session|m2"].projectRef, PROJECT_ROW.project_ref);
});

for (const operation of ["list", "whoami"]) {
  test(`actual cmdSync preserves v2 queues/cursors through WSL ${operation} timeout and retries without cache reset`, async (t) => {
    const { home, repo } = fixture(t);
    const wslData = path.join(home, "synthetic-wsl", ".commandcode");
    const file = path.join(wslData, "projects", "fixture", "session.jsonl");
    write(file, `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: repo })}\n${message("m1")}\n`);
    const aliases = [
      ["\\\\wsl$\\Synthetic\\home\\fixture\\.commandcode", wslData],
      ["\\\\wsl.localhost\\Synthetic\\home\\fixture\\.commandcode", wslData],
    ];
    // On POSIX test hosts, the real WSL mapper reanchors the synthetic cwd.
    // Redirect that project alias too, without changing production mapping.
    if (repo.startsWith("/")) {
      for (const root of ["\\\\wsl$\\Synthetic\\", "\\\\wsl.localhost\\Synthetic\\"]) {
        aliases.push([root + repo.slice(1).replaceAll("/", "\\"), repo]);
      }
    }
    const injected = Object.assign(new Error("synthetic WSL timeout"), { code: "ETIMEDOUT" });
    let fail = false;
    let injectedCalls = 0;
    const runtimeOptions = { home, env: { TOKENTRACKER_WSL_MODE: "wsl-only" },
      redirect(filename) {
        if (typeof filename !== "string") return filename;
        for (const [alias, target] of aliases) {
          if (filename === alias) return target;
          if (filename.startsWith(alias + path.sep)) return path.join(target, filename.slice(alias.length + 1));
        }
        if (filename.startsWith("\\\\wsl")) throw Object.assign(new Error("non-fixture WSL path"), { code: "ENOENT" });
        return filename;
      },
      runWsl(args) {
        const list = args[0] === "-l";
        if (fail && (operation === "list") === list) { injectedCalls += 1; throw injected; }
        return Buffer.from(list ? "  NAME STATE VERSION\n* Synthetic Running 2\n" : "fixture\n", list ? "utf16le" : "utf8");
      },
    };
    let runtime = scopedModules(runtimeOptions);
    const args = ["--auto", "--from-notify", "--source", "command-code", "--background", "--all-local-sources"];
    const sync = async () => {
      const diagnostics = {};
      await runtime.load("src/commands/sync.js").cmdSync(args, { diagnostics, cursorStoreOptions: { forceV2: true } });
      return diagnostics;
    };
    const tracker = path.join(home, ".tokentracker", "tracker");
    const queue = path.join(tracker, "queue.jsonl");
    const project = path.join(tracker, "project.queue.jsonl");
    const initial = await sync();
    assert.equal(initial.cursor_commits, 1);
    assert.deepEqual(readRows(queue), [ROW]);
    assert.deepEqual(readRows(project), [PROJECT_ROW]);
    const core = fs.readFileSync(initial.cursor_path);
    const hourly = fs.readFileSync(queue);
    const projectBytes = fs.readFileSync(project);
    // A fresh private module graph models process restart; recovery uses this
    // same graph, including negative caches populated by default providers.
    runtime = scopedModules(runtimeOptions);
    fail = true;
    const failed = await sync();
    assert.ok(injectedCalls > 0);
    assert.equal(failed.cursor_commits, 0);
    assert.deepEqual(fs.readFileSync(failed.cursor_path), core);
    assert.deepEqual(fs.readFileSync(queue), hourly);
    assert.deepEqual(fs.readFileSync(project), projectBytes);
    fail = false;
    fs.appendFileSync(file, message("m2") + "\n");
    const recovered = await sync();
    assert.equal(recovered.cursor_commits, 1);
    assert.deepEqual(readRows(queue), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
    assert.deepEqual(readRows(project), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
    const repeated = await sync();
    assert.equal(repeated.cursor_commits, 0);
    assert.deepEqual(readRows(queue), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
    assert.deepEqual(readRows(project), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
  });
}

for (const [method, target, code] of [
  ["readFile", "gitfile", "EACCES"],
  ["stat", "worktreeConfig", "EPERM"],
  ["readFile", "commondir", "EIO"],
  ["stat", "commonConfig", "EIO"],
  ["readFile", "commonConfig", "EPERM"],
]) {
  test(`strict project observation covers worktree ${target} ${method} ${code}`, async (t) => {
    const { home, file } = fixture(t);
    const worktree = path.join(home, "synthetic-worktree");
    const admin = path.join(home, "shared.git", "worktrees", "fixture");
    const files = {
      gitfile: path.join(worktree, ".git"),
      worktreeConfig: path.join(admin, "config"),
      commondir: path.join(admin, "commondir"),
      commonConfig: path.join(home, "shared.git", "config"),
    };
    write(files.gitfile, `gitdir: ${admin}\n`);
    write(files.commondir, "../..\n");
    write(files.commonConfig, `[remote "origin"]\n\turl = ${PROJECT_ROW.project_ref}.git\n`);
    write(file, `${JSON.stringify({ type: "session", version: 3, id: "session", cwd: worktree })}\n${message("m1")}\n`);
    const injected = Object.assign(new Error("synthetic worktree observation"), { code });
    let fail = false;
    const runtime = scopedModules({ home, ioFailure(operation, filename) {
      return fail && operation === method && filename === files[target] ? injected : null;
    } });
    const rollout = runtime.load("src/lib/rollout.js");
    const options = {
      sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
      projectQueuePath: path.join(home, "project.queue.jsonl"),
    };
    await rollout.parseCommandCodeIncremental(options);
    assert.deepEqual(readRows(options.queuePath), [ROW]);
    assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW]);
    const cursor = JSON.stringify(options.cursors);
    const hourly = fs.readFileSync(options.queuePath);
    const project = fs.readFileSync(options.projectQueuePath);
    fail = true;
    await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
    assert.equal(JSON.stringify(options.cursors), cursor);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
    fail = false;
    const recovered = await rollout.parseCommandCodeIncremental(options);
    assert.equal(recovered.recordsProcessed, 0);
    assert.equal(recovered.eventsAggregated, 0);
    assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
    assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
  });
}

test("a later project's observation error prevents publishing an earlier file's new usage", async (t) => {
  const { home, file } = fixture(t);
  const secondRepo = path.join(home, "unverified-repository");
  const secondConfig = path.join(secondRepo, ".git", "config");
  const secondFile = path.join(path.dirname(file), "second.jsonl");
  write(secondConfig, '[remote "origin"]\n\turl = file:///synthetic-private-repository\n');
  write(secondFile, `${JSON.stringify({ type: "session", version: 3, id: "second", cwd: secondRepo })}\n${message("n1")}\n`);
  const injected = Object.assign(new Error("synthetic later metadata failure"), { code: "EIO" });
  let fail = false;
  const runtime = scopedModules({ home, ioFailure(method, filename) {
    return fail && method === "readFile" && filename === secondConfig ? injected : null;
  } });
  const rollout = runtime.load("src/lib/rollout.js");
  const options = {
    sessionFiles: [file], cursors: {}, queuePath: path.join(home, "queue.jsonl"),
    projectQueuePath: path.join(home, "project.queue.jsonl"),
  };
  await rollout.parseCommandCodeIncremental(options);
  const cursor = JSON.stringify(options.cursors);
  const hourly = fs.readFileSync(options.queuePath);
  const project = fs.readFileSync(options.projectQueuePath);
  fs.appendFileSync(file, message("m2") + "\n");
  options.sessionFiles.push(secondFile);
  fail = true;
  await assert.rejects(rollout.parseCommandCodeIncremental(options), (error) => error === injected);
  assert.equal(JSON.stringify(options.cursors), cursor);
  assert.deepEqual(fs.readFileSync(options.queuePath), hourly);
  assert.deepEqual(fs.readFileSync(options.projectQueuePath), project);
  fail = false;
  await rollout.parseCommandCodeIncremental(options);
  const total = {
    ...TOTALS, input_tokens: 3000, output_tokens: 300, total_tokens: 3300,
    billable_total_tokens: 3300, total_cost_usd: 1.26, conversation_count: 3,
  };
  assert.deepEqual(readRows(options.queuePath), [ROW, { ...ROW, ...total }]);
  assert.deepEqual(readRows(options.projectQueuePath), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
  assert.equal(options.cursors.commandCode.messages["command-code:second|n1"].projectKey, null);
});

test("actual cmdSync preserves v2 core and both queues on Git config EIO, without publishing purge intent", async (t) => {
  const { home, config } = fixture(t);
  const injected = Object.assign(new Error("synthetic Git config EIO"), { code: "EIO" });
  let fail = false;
  const runtime = scopedModules({ home, ioFailure(method, filename) {
    return fail && method === "readFile" && filename === config ? injected : null;
  } });
  const sync = async () => {
    const diagnostics = {};
    await runtime.load("src/commands/sync.js").cmdSync([
      "--auto", "--from-notify", "--source", "command-code", "--background", "--all-local-sources",
    ], { diagnostics, cursorStoreOptions: { forceV2: true } });
    return diagnostics;
  };
  const queue = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
  const project = path.join(home, ".tokentracker", "tracker", "project.queue.jsonl");
  const initial = await sync();
  assert.deepEqual(readRows(queue), [ROW]);
  assert.deepEqual(readRows(project), [PROJECT_ROW]);
  const core = fs.readFileSync(initial.cursor_path);
  const hourly = fs.readFileSync(queue);
  const projectBytes = fs.readFileSync(project);
  fail = true;
  const failed = await sync();
  assert.equal(failed.cursor_commits, 0);
  assert.deepEqual(fs.readFileSync(failed.cursor_path), core);
  assert.deepEqual(fs.readFileSync(queue), hourly);
  assert.deepEqual(fs.readFileSync(project), projectBytes);
  assert.equal(JSON.parse(core).projectHourly.projects[PROJECT_KEY].purge_pending, false);
  fail = false;
  const recovered = await sync();
  assert.equal(recovered.cursor_commits, 0);
  assert.deepEqual(fs.readFileSync(recovered.cursor_path), core);
  assert.deepEqual(fs.readFileSync(queue), hourly);
  assert.deepEqual(fs.readFileSync(project), projectBytes);
});

function finishedVerboseListError(fields = {}) {
  return Object.assign(new Error("已完成的本地化 WSL 诊断，不应通过文本匹配判断含义"), {
    status: 4294967295, signal: null, ...fields,
  });
}

for (const [name, quiet] of [
  ["empty", ""], ["BOM", "\uFEFF"], ["NUL", "\u0000"],
  ["mixed whitespace", "\uFEFF\u0000 \t\r\n\u0000\uFEFF"],
]) {
  test(`R3 completed nonzero verbose + ${name} quiet confirms absence and discovers native Command Code`, async (t) => {
    const { home, file } = fixture(t);
    let verboseCalls = 0;
    let quietCalls = 0;
    const runtime = scopedModules({ home, env: { TOKENTRACKER_WSL_MODE: "" }, runWsl(args) {
      if (args[1] === "-v") { verboseCalls += 1; throw finishedVerboseListError(); }
      assert.deepEqual(args, ["-l", "-q"]);
      quietCalls += 1;
      return Buffer.from(quiet, "utf16le");
    } });
    const rollout = runtime.load("src/lib/rollout.js");
    assert.deepEqual(await rollout.resolveCommandCodeSessionFiles(), [file]);
    assert.deepEqual({ verboseCalls, quietCalls }, { verboseCalls: 1, quietCalls: 1 });
    assert.deepEqual(await rollout.resolveCommandCodeSessionFiles(), [file]);
    assert.deepEqual({ verboseCalls, quietCalls }, { verboseCalls: 1, quietCalls: 1 },
      "successful absence is cached, not retried as a failed negative result");
  });
}

test("R3 legacy callers do not issue quiet probes, while strict calls can confirm their failed cache", (t) => {
  const { home } = fixture(t);
  let verboseCalls = 0;
  let quietCalls = 0;
  const runtime = scopedModules({ home, runWsl(args) {
    if (args[1] === "-v") { verboseCalls += 1; throw finishedVerboseListError(); }
    assert.deepEqual(args, ["-l", "-q"]);
    quietCalls += 1;
    return Buffer.from("", "utf16le");
  } });
  const wsl = runtime.load("src/lib/wsl-probe.js");
  assert.deepEqual(wsl.probeWslDistros(), []);
  assert.deepEqual(wsl.probeWslDistros(), []);
  assert.deepEqual({ verboseCalls, quietCalls }, { verboseCalls: 1, quietCalls: 0 });
  assert.deepEqual(wsl.probeWslDistros({ strict: true }), []);
  assert.deepEqual({ verboseCalls, quietCalls }, { verboseCalls: 2, quietCalls: 1 });
  assert.deepEqual(wsl.probeWslDistros({ strict: true }), []);
  assert.deepEqual(wsl.probeWslDistros(), []);
  assert.deepEqual({ verboseCalls, quietCalls }, { verboseCalls: 2, quietCalls: 1 });
});

for (const scenario of ["nonempty", "failed"]) {
  test(`R3 ${scenario} quiet preserves the original failure and retries after recovery without cache reset`, (t) => {
    const { home } = fixture(t);
    const original = finishedVerboseListError();
    let recovered = false;
    let verboseCalls = 0;
    let quietCalls = 0;
    const runtime = scopedModules({ home, runWsl(args) {
      if (args[1] === "-v") {
        verboseCalls += 1;
        if (!recovered) throw original;
        return Buffer.from("  NAME STATE VERSION\n* Synthetic Running 2\n", "utf16le");
      }
      assert.deepEqual(args, ["-l", "-q"]);
      quietCalls += 1;
      if (scenario === "failed") throw Object.assign(new Error("synthetic quiet EIO"), { code: "EIO" });
      return Buffer.from("\uFEFF\u0000 Synthetic\r\n", "utf16le");
    } });
    const wsl = runtime.load("src/lib/wsl-probe.js");
    assert.throws(() => wsl.probeWslDistros({ strict: true }), (error) => error === original);
    assert.deepEqual({ verboseCalls, quietCalls }, { verboseCalls: 1, quietCalls: 1 });
    assert.deepEqual(wsl.probeWslDistros(), [], "legacy fallback still reuses its failed cache");
    recovered = true;
    const expected = [{ name: "Synthetic", version: 2, isDefault: true }];
    assert.deepEqual(wsl.probeWslDistros({ strict: true }), expected);
    assert.deepEqual(wsl.probeWslDistros({ strict: true }), expected);
    assert.deepEqual({ verboseCalls, quietCalls }, { verboseCalls: 2, quietCalls: 1 });
  });
}

test("R3 only a string-valued empty quiet result confirms absence", (t) => {
  const { home } = fixture(t);
  const wsl = scopedModules({ home }).load("src/lib/wsl-probe.js");
  for (const quiet of [undefined, null, 0, false, Buffer.alloc(0)]) {
    const original = finishedVerboseListError();
    let quietCalls = 0;
    assert.throws(() => wsl.probeWslDistros({ strict: true, runWsl(args) {
      if (args[1] === "-v") throw original;
      assert.deepEqual(args, ["-l", "-q"]);
      quietCalls += 1;
      return quiet;
    } }), (error) => error === original);
    assert.equal(quietCalls, 1);
  }
});

for (const [name, fields] of [
  ["timeout", { status: 1, code: "ETIMEDOUT", signal: null }],
  ["process I/O", { status: 1, code: "EIO", signal: null }],
  ["EACCES", { status: 1, code: "EACCES", signal: null }],
  ["EPERM", { status: 1, code: "EPERM", signal: null }],
  ["signal termination", { status: 1, signal: "SIGTERM" }],
  ["unfinished status", { status: null, signal: null }],
  ["zero status", { status: 0, signal: null }],
  ["string status", { status: "4294967295", signal: null }],
  ["NaN status", { status: NaN, signal: null }],
  ["infinite status", { status: Infinity, signal: null }],
]) {
  test(`R3 ${name} is not a completed nonzero exit and never falls back to empty quiet output`, (t) => {
    const { home } = fixture(t);
    const original = finishedVerboseListError(fields);
    let quietCalls = 0;
    const runtime = scopedModules({ home, runWsl(args) {
      if (args[1] === "-v") throw original;
      quietCalls += 1;
      return Buffer.from("", "utf16le");
    } });
    const wsl = runtime.load("src/lib/wsl-probe.js");
    assert.throws(() => wsl.probeWslDistros({ strict: true }), (error) => error === original);
    assert.equal(quietCalls, 0);
  });
}

test("R3 a numeric code equal to the finished exit status may confirm with quiet output", (t) => {
  const { home } = fixture(t);
  let quietCalls = 0;
  const runtime = scopedModules({ home, runWsl(args) {
    if (args[1] === "-v") throw finishedVerboseListError({ status: 1, code: 1 });
    assert.deepEqual(args, ["-l", "-q"]);
    quietCalls += 1;
    return Buffer.from("", "utf16le");
  } });
  assert.deepEqual(runtime.load("src/lib/wsl-probe.js").probeWslDistros({ strict: true }), []);
  assert.equal(quietCalls, 1);
});

for (const scenario of ["nonempty", "failed"]) {
  test(`R3 default-mode cmdSync uses native usage but preserves v2 bytes on ${scenario} quiet confirmation`, async (t) => {
    const { home, file } = fixture(t);
    let fail = false;
    const options = { home, env: { TOKENTRACKER_WSL_MODE: "" }, runWsl(args) {
      if (args[1] === "-v") throw finishedVerboseListError();
      assert.deepEqual(args, ["-l", "-q"]);
      if (fail && scenario === "failed") throw Object.assign(new Error("synthetic quiet timeout"), { code: "ETIMEDOUT" });
      return Buffer.from(fail ? "\uFEFF Synthetic\r\n" : "\uFEFF\u0000 \r\n", "utf16le");
    } };
    let runtime = scopedModules(options);
    const sync = async () => {
      const diagnostics = {};
      await runtime.load("src/commands/sync.js").cmdSync([
        "--auto", "--from-notify", "--source", "command-code", "--background", "--all-local-sources",
      ], { diagnostics, cursorStoreOptions: { forceV2: true } });
      return diagnostics;
    };
    const queue = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
    const project = path.join(home, ".tokentracker", "tracker", "project.queue.jsonl");
    const initial = await sync();
    assert.deepEqual(readRows(queue), [ROW]);
    assert.deepEqual(readRows(project), [PROJECT_ROW]);
    const core = fs.readFileSync(initial.cursor_path);
    const hourly = fs.readFileSync(queue);
    const projectBytes = fs.readFileSync(project);
    // A new private graph models restart, not a global cache reset. After the
    // failure, recovery below keeps this same graph and its failed cache.
    runtime = scopedModules(options);
    fail = true;
    const failed = await sync();
    assert.equal(failed.cursor_commits, 0);
    assert.deepEqual(fs.readFileSync(failed.cursor_path), core);
    assert.deepEqual(fs.readFileSync(queue), hourly);
    assert.deepEqual(fs.readFileSync(project), projectBytes);
    fail = false;
    fs.appendFileSync(file, message("m2") + "\n");
    const recovered = await sync();
    assert.equal(recovered.cursor_commits, 1);
    assert.deepEqual(readRows(queue), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
    assert.deepEqual(readRows(project), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
    const repeated = await sync();
    assert.equal(repeated.cursor_commits, 0);
    assert.deepEqual(readRows(queue), [ROW, { ...ROW, ...DOUBLE_TOTALS }]);
    assert.deepEqual(readRows(project), [PROJECT_ROW, { ...PROJECT_ROW, ...DOUBLE_TOTALS }]);
  });
}

for (const kind of ["gitfile", "commondir", "config"]) {
  test(`CodeQL Git metadata ${kind} content and metadata keep the identity checked before pathname replacement`, async (t) => {
    const { home } = fixture(t);
    const worktree = path.join(home, "codeql-worktree");
    const admin = path.join(home, "admin-original");
    const otherAdmin = path.join(home, "admin-replacement");
    const common = path.join(home, "common-original.git");
    const otherCommon = path.join(home, "common-replacement.git");
    const gitfile = path.join(worktree, ".git");
    const commondir = path.join(admin, "commondir");
    const config = path.join(common, "config");
    const otherRef = "https://github.com/acme/replacement-codeql";
    write(gitfile, "gitdir: ../admin-original\n");
    write(commondir, "../common-original.git\n");
    write(config, `[remote "origin"]\n\turl = ${PROJECT_ROW.project_ref}.git\n`);
    write(path.join(otherAdmin, "commondir"), "../common-replacement.git\n");
    write(path.join(otherCommon, "config"), `[remote "origin"]\n\turl = ${otherRef}.git\n`);
    const target = { gitfile, commondir, config }[kind];
    const replacement = `${target}.replacement`;
    const saved = `${target}.original`;
    const replacementText = {
      gitfile: "gitdir: ../admin-replacement\n",
      commondir: "../common-replacement.git\n",
      config: `[remote "origin"]\n\turl = ${otherRef}.git\n`,
    }[kind];
    write(replacement, replacementText);
    fs.utimesSync(replacement, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    const checkedConfig = fs.statSync(config);
    const opened = [];
    let replaced = false;
    let pathnameReads = 0;
    const runtime = scopedModules({ home,
      onHandle(handle, file) { opened.push({ handle, file }); },
      ioFailure(method, file, handle) {
        if (method === "readFile" && file === target) {
          if (!handle) pathnameReads += 1;
          if (!replaced) {
            for (const candidate of [target, replacement, saved]) {
              assert.ok(path.resolve(candidate).startsWith(home + path.sep), "replacement stays in the synthetic fixture");
            }
            fs.renameSync(target, saved);
            fs.renameSync(replacement, target);
            replaced = true;
          }
        }
        return null;
      },
    });
    const helpers = runtime.load("src/lib/rollout.js").projectObservationTest;
    const context = await helpers.resolveProjectContextForPath({ startDir: worktree, strictIo: true });
    assert.equal(replaced, true, "the filesystem swap must really occur before the content read");
    assert.equal(fs.readFileSync(target, "utf8"), replacementText);
    assert.deepEqual(context, {
      projectRef: PROJECT_ROW.project_ref, projectKey: PROJECT_KEY, status: "public_verified",
      configPath: config, configMtimeMs: checkedConfig.mtimeMs, configSize: checkedConfig.size,
    }, "the snapshot must not read replacement bytes or combine one file's stat with another's remote");
    assert.equal(pathnameReads, 0);
    assert.equal(opened.filter((entry) => entry.file === target).length, 1);
    for (const { handle } of opened) assert.equal(handle.fd, -1, "every opened metadata descriptor is closed");
  });
}

for (const strictIo of [false, true]) {
  for (const scenario of ["success", "missing", "directory", "non-file", "stat-error", "read-error", "close-error"]) {
    test(`CodeQL Git metadata ${scenario} closes handles with strictIo=${strictIo}`, async (t) => {
      const { home, config } = fixture(t);
      const target = scenario === "missing" ? path.join(home, "missing-config")
        : scenario === "directory" ? path.dirname(config) : config;
      const failure = Object.assign(new Error(`synthetic ${scenario}`), { code: scenario === "stat-error" ? "EACCES" : "EIO" });
      const opened = [];
      let openAttempts = 0;
      let readAttempts = 0;
      let pathnameReads = 0;
      const runtime = scopedModules({ home,
        onHandle(handle, file) {
          if (file !== target) return;
          opened.push(handle);
          if (scenario === "non-file") {
            const stat = handle.stat.bind(handle);
            handle.stat = async () => ({ ...await stat(), isFile: () => false, isDirectory: () => false });
          }
        },
        ioFailure(method, file, handle) {
          if (file !== target) return null;
          if (method === "open") openAttempts += 1;
          if (method === "readFile") { readAttempts += 1; if (!handle) pathnameReads += 1; }
          if ((scenario === "stat-error" && method === "stat") ||
              (scenario === "read-error" && method === "readFile") ||
              (scenario === "close-error" && method === "close")) return failure;
          return null;
        },
      });
      const helpers = runtime.load("src/lib/rollout.js").projectObservationTest;
      if (strictIo && scenario.endsWith("-error")) {
        await assert.rejects(helpers.readGitRemoteUrl(target, { strictIo }), (error) => error === failure);
      } else {
        assert.equal(await helpers.readGitRemoteUrl(target, { strictIo }),
          scenario === "success" ? `${PROJECT_ROW.project_ref}.git` : null);
      }
      assert.equal(openAttempts, 1);
      assert.equal(pathnameReads, 0, "metadata text must use descriptor reads only");
      if (["missing", "directory", "non-file", "stat-error"].includes(scenario)) assert.equal(readAttempts, 0);
      if (!["missing", "directory"].includes(scenario)) assert.equal(opened.length, 1);
      for (const handle of opened) assert.equal(handle.fd, -1);
    });
  }
}

test("CodeQL Git metadata closes after read and close failures while preserving the original strict error", async (t) => {
  const { home, config } = fixture(t);
  const readFailure = Object.assign(new Error("synthetic read EIO"), { code: "EIO" });
  const closeFailure = Object.assign(new Error("synthetic close EPERM"), { code: "EPERM" });
  const opened = [];
  const runtime = scopedModules({ home,
    onHandle(handle) { opened.push(handle); },
    ioFailure(method, file) {
      if (file !== config) return null;
      return method === "readFile" ? readFailure : method === "close" ? closeFailure : null;
    },
  });
  const helpers = runtime.load("src/lib/rollout.js").projectObservationTest;
  await assert.rejects(helpers.readGitRemoteUrl(config, { strictIo: true }), (error) => error === readFailure);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].fd, -1);
});

test("CodeQL Git metadata uses nonblocking open where supported before inspecting a possibly special file", async (t) => {
  const { home, config } = fixture(t);
  const flags = [];
  const runtime = scopedModules({ home, onOpen(file, args) {
    if (file === config) flags.push(args[0]);
  } });
  const helpers = runtime.load("src/lib/rollout.js").projectObservationTest;
  assert.equal(await helpers.readGitRemoteUrl(config, { strictIo: true }), `${PROJECT_ROW.project_ref}.git`);
  assert.deepEqual(flags, [fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)]);
});
