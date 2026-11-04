const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { buildDoctorReport } = require("../src/lib/doctor");
const { cmdDoctor } = require("../src/commands/doctor");
const { withHome } = require("./helpers/with-home");

test("doctor treats any HTTP response as reachable", async () => {
  const report = await buildDoctorReport({
    runtime: { baseUrl: "https://example" },
    fetch: async () => ({ status: 401 }),
  });
  const check = report.checks.find((c) => c.id === "network.base_url");

  assert.equal(check.status, "ok");
  assert.equal(check.meta.status_code, 401);
});

test("doctor warns when base_url is missing", async () => {
  const report = await buildDoctorReport({
    runtime: {},
    fetch: async () => ({ status: 200 }),
  });
  const check = report.checks.find((c) => c.id === "network.base_url");

  assert.equal(check.status, "warn");
  assert.equal(report.summary.warn, 2);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.ok, true);
});

test("doctor marks network errors as fail", async () => {
  const report = await buildDoctorReport({
    runtime: { baseUrl: "https://example" },
    fetch: async () => {
      throw new Error("nope");
    },
  });
  const check = report.checks.find((c) => c.id === "network.base_url");

  assert.equal(check.status, "fail");
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.warn, 1);
  assert.equal(report.ok, true);
});

test("doctor reports runtime config status", async () => {
  const report = await buildDoctorReport({
    runtime: { baseUrl: "https://example", deviceToken: "token" },
    fetch: async () => ({ status: 200 }),
  });
  const baseCheck = report.checks.find((c) => c.id === "runtime.base_url");
  const tokenCheck = report.checks.find((c) => c.id === "runtime.device_token");

  assert.equal(baseCheck.status, "ok");
  assert.equal(tokenCheck.status, "ok");
});

test("doctor marks invalid config.json as critical", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  const trackerDir = path.join(tmp, ".tokentracker", "tracker");
  await fs.mkdir(trackerDir, { recursive: true });
  const configPath = path.join(trackerDir, "config.json");
  await fs.writeFile(configPath, "{bad", "utf8");

  const report = await buildDoctorReport({
    runtime: { baseUrl: "https://example" },
    fetch: async () => ({ status: 200 }),
    paths: { trackerDir, configPath },
  });
  const configCheck = report.checks.find((c) => c.id === "fs.config_json");

  assert.equal(configCheck.status, "fail");
  assert.equal(configCheck.critical, true);
});

test("doctor --out writes json to file and stdout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  let restoreHome = () => {};
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;

  try {
    restoreHome = withHome(tmp);
    process.chdir(tmp);
    globalThis.fetch = async () => ({ status: 204 });
    const outCapture = createWriteCapture();
    const errCapture = createWriteCapture();
    process.stdout.write = outCapture.write;
    process.stderr.write = errCapture.write;
    process.exitCode = undefined;

    await cmdDoctor(["--out", "doctor.json"]);

    const out = outCapture.read();
    assert.ok(out.trim().startsWith("{"));
    const payload = JSON.parse(out);
    assert.equal(payload.version, 1);

    const filePayload = JSON.parse(await fs.readFile(path.join(tmp, "doctor.json"), "utf8"));
    assert.equal(filePayload.version, 1);
  } finally {
    process.stdout.write = prevWrite;
    process.stderr.write = prevErr;
    restoreHome();
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
    process.exitCode = prevExit;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("doctor sets exitCode on critical failures", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  let restoreHome = () => {};
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;

  try {
    restoreHome = withHome(tmp);
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(path.join(trackerDir, "config.json"), "{bad", "utf8");
    globalThis.fetch = async () => ({ status: 200 });
    const outCapture = createWriteCapture();
    const errCapture = createWriteCapture();
    process.stdout.write = outCapture.write;
    process.stderr.write = errCapture.write;
    process.exitCode = 0;

    await cmdDoctor(["--json"]);

    assert.equal(process.exitCode, 1);
  } finally {
    process.stdout.write = prevWrite;
    process.stderr.write = prevErr;
    restoreHome();
    globalThis.fetch = prevFetch;
    process.exitCode = prevExit;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("doctor supports CLI base-url override", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  let restoreHome = () => {};
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;

  try {
    restoreHome = withHome(tmp);
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(
      path.join(trackerDir, "config.json"),
      JSON.stringify({ baseUrl: "https://config.example", deviceToken: "t" }),
      "utf8",
    );
    globalThis.fetch = async () => ({ status: 200 });
    const outCapture = createWriteCapture();
    const errCapture = createWriteCapture();
    process.stdout.write = outCapture.write;
    process.stderr.write = errCapture.write;
    process.exitCode = 0;

    await cmdDoctor(["--json", "--base-url", "https://override.example"]);

    const payload = JSON.parse(outCapture.read());
    const baseCheck = payload.checks.find((c) => c.id === "runtime.base_url");
    assert.equal(baseCheck.meta.base_url, "https://override.example");
  } finally {
    process.stdout.write = prevWrite;
    process.stderr.write = prevErr;
    restoreHome();
    globalThis.fetch = prevFetch;
    process.exitCode = prevExit;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("doctor tolerates null config.json payload", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-doctor-"));
  let restoreHome = () => {};
  const prevFetch = globalThis.fetch;
  const prevWrite = process.stdout.write;
  const prevErr = process.stderr.write;
  const prevExit = process.exitCode;

  try {
    restoreHome = withHome(tmp);
    const trackerDir = path.join(tmp, ".tokentracker", "tracker");
    await fs.mkdir(trackerDir, { recursive: true });
    await fs.writeFile(path.join(trackerDir, "config.json"), "null", "utf8");
    globalThis.fetch = async () => ({ status: 200 });
    const outCapture = createWriteCapture();
    const errCapture = createWriteCapture();
    process.stdout.write = outCapture.write;
    process.stderr.write = errCapture.write;
    process.exitCode = 0;

    await cmdDoctor(["--json"]);

    const payload = JSON.parse(outCapture.read());
    assert.equal(payload.version, 1);
  } finally {
    process.stdout.write = prevWrite;
    process.stderr.write = prevErr;
    restoreHome();
    globalThis.fetch = prevFetch;
    process.exitCode = prevExit;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

function createWriteCapture() {
  let out = "";
  return {
    write(chunk, enc, cb) {
      out += typeof chunk === "string" ? chunk : chunk.toString(enc || "utf8");
      if (typeof cb === "function") cb();
      return true;
    },
    read() {
      return out;
    },
  };
}

test("doctor separates local TRAE CN auth readability from API authorization", async () => {
  for (const auth of ["readable", "malformed", "unreadable", "not-signed-in"]) {
    const report = await buildDoctorReport({
      diagnostics: { trae_cn: { usage_opt_in: true, auth, storage_path: "~/Trae CN/User/globalStorage/storage.json" } },
      fetch: async () => assert.fail("doctor must not probe the TRAE API"),
    });
    const check = report.checks.find((c) => c.id === "trae_cn.auth");
    assert.equal(check.status, auth === "readable" ? "ok" : "warn");
    assert.match(check.detail, /API access not checked/);
    assert.match(check.detail, /Sign in again/);
    assert.match(check.detail, /TOKENTRACKER_TRAE_CN_HOME/);
  }
  const report = await buildDoctorReport({ diagnostics: { trae_cn: { usage_opt_in: false, auth: "unchecked" } } });
  assert.match(report.checks.find((c) => c.id === "trae_cn.auth").detail, /auth not read/);
});
