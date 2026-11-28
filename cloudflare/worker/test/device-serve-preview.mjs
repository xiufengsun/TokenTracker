// Exercise a CLI distribution with its own runtime, using a private temporary home and a disposable preview account.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";

const [binary, cli] = process.argv.slice(2);
assert.ok(
  binary && cli,
  "Pass the Node executable and bin/tracker.js to verify",
);
const base = new URL(process.env.TT_QA_BASE_URL);
assert.equal(base.protocol, "https:");
assert.match(
  base.hostname,
  /(?:^|-)tokentracker-migration-staging\.[a-z0-9-]+\.workers\.dev$/,
);
assert.ok(
  process.env.TT_QA_EMAIL && process.env.TT_QA_PASSWORD && process.env.TT_QA_ID,
);
const directory = await mkdtemp(join(tmpdir(), "tt-cf-serve-"));
const tracker = join(directory, ".tokentracker", "tracker");
const anon = "anon_" + "0".repeat(40);
const dashboard = "https://www.tokentracker.cc";
const expectedOwner = process.env.TT_QA_ID;
await mkdir(tracker, { recursive: true });
const configFile = join(tracker, "config.json");
await writeFile(
  configFile,
  JSON.stringify({
    baseUrl: base.origin,
    anonKey: anon,
    dashboardUrl: dashboard,
    machineId:
      process.env.TT_QA_MACHINE_ID || "cloudflare-migration-cli-acceptance",
  }),
  { mode: 0o600 },
);
await writeFile(join(tracker, "cursors.json"), "{}");
await writeFile(join(tracker, "cloud-sync-pref.json"), '{"enabled":true}');
const isolatedEnv = {
  PATH: process.env.PATH,
  TMPDIR: tmpdir(),
  HOME: directory,
  USERPROFILE: directory,
  TOKENTRACKER_NO_TELEMETRY: "1",
  TOKENTRACKER_SKIP_FIRST_SYNC: "1",
  TOKENTRACKER_APP_SHELL: "macos",
  LANG: "C",
};
const portProbe = createServer();
portProbe.listen(0, "127.0.0.1");
await once(portProbe, "listening");
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const local = "http://127.0.0.1:" + port;
let server, deviceCli, syncCli;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function request(path, options, status = 200) {
  const response = await fetch(new URL(path, local), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (response.status !== status) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      `${path.split("?")[0]} expected ${status}, got ${response.status} (${body.code || "no code"})`,
    );
  }
  return response;
}
async function checkBrowser() {
  const { chromium } =
    await import("../../../dashboard/node_modules/playwright/index.mjs");
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const forbidden = [];
  const interactions = [];
  page.setDefaultTimeout(20000);
  await context.route(/\.insforge\.app\//, (route) => {
    forbidden.push(new URL(route.request().url()).hostname);
    return route.abort();
  });
  page.on("response", async (r) => {
    const url = new URL(r.url());
    if (
      url.pathname.startsWith("/api/auth/") ||
      url.pathname.endsWith("device-flow-grant")
    )
      interactions.push([url.pathname, r.status()]);
    if (
      r.request().method() === "POST" &&
      url.pathname === "/api/auth/sessions"
    ) {
      try {
        const value = await r.json();
        interactions.push([
          "login_response_fields",
          Object.keys(value).join(","),
        ]);
      } catch {
        interactions.push(["login_non_json", true]);
      }
    }
  });
  try {
    await page.goto(
      local + "/login?next=" + encodeURIComponent("/settings?section=account"),
      { waitUntil: "domcontentloaded" },
    );
    const email = page.locator("form input[type=email]");
    if (!(await email.isVisible()))
      await page.getByRole("button", { name: /continue with email/i }).click();
    await email.fill(process.env.TT_QA_EMAIL);
    await page
      .locator("form input[type=password]")
      .fill(process.env.TT_QA_PASSWORD);
    await page
      .getByRole("button", { name: "Sign in with email", exact: true })
      .click();
    await page.waitForURL((u) => u.pathname === "/settings", {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByText(expectedOwner, { exact: true })
      .first()
      .waitFor({ state: "visible" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByText(expectedOwner, { exact: true })
      .first()
      .waitFor({ state: "visible" });
    // Approve a QA device through the actual rendered DevicePage.
    const authorize = await fetch(
      new URL("/functions/tokentracker-device-flow-authorize", base),
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_info: "ui QA",
          machine_id:
            process.env.TT_QA_MACHINE_ID ||
            "cloudflare-migration-cli-acceptance",
        }),
      },
    );
    assert.equal(authorize.status, 200);
    const pair = await authorize.json();
    await page.goto(
      local + "/device?user_code=" + encodeURIComponent(pair.user_code),
      { waitUntil: "domcontentloaded" },
    );
    const form = page
      .locator("form")
      .filter({ has: page.getByPlaceholder("XXXX-XXXX") });
    assert.equal(
      await form.getByPlaceholder("XXXX-XXXX").inputValue(),
      pair.user_code,
    );
    const granted = page.waitForResponse(
      (r) =>
        r.url() === base.origin + "/functions/tokentracker-device-flow-grant" &&
        r.request().method() === "POST",
    );
    await form.locator("button[type=submit]").click();
    assert.equal((await granted).status(), 200);
    await page.getByText(/Approved for ui QA/i).waitFor({ state: "visible" });
    await page.goto(local + "/settings?section=account", {
      waitUntil: "domcontentloaded",
    });
    const logout = page.getByRole("button", { name: "Sign out", exact: true });
    await logout.click();
    await logout.waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByText(expectedOwner, { exact: true })
      .waitFor({ state: "hidden" });
    await page.goto(local + "/device", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("XXXX-XXXX").waitFor();
    assert.equal(
      await page.locator("form button[type=submit]").isDisabled(),
      true,
    );
    assert.equal(forbidden.length, 0);
    assert.ok(
      interactions.some(([p, s]) => p === "/api/auth/logout" && s === 200),
    );
    console.log(
      JSON.stringify({
        browser: await browser.version(),
        checks: [
          "password-sign-in-UI",
          "owner-visible",
          "reload-restore",
          "device-approved-in-UI",
          "sign-out-UI",
          "signed-out-after-reload",
        ],
        unexpectedInsforgeRequests: forbidden.length,
      }),
    );
  } catch (error) {
    console.error(
      "Browser UI path",
      new URL(page.url()).pathname,
      "auth HTTP statuses",
      JSON.stringify(interactions),
    );
    // Do not include action input values in Playwright diagnostic errors.
    throw new Error(
      "Browser UI verification failed at " +
        String(error)
          .split("\n")[0]
          .replaceAll(process.env.TT_QA_EMAIL, "[email]")
          .replaceAll(process.env.TT_QA_PASSWORD, "[password]"),
    );
  } finally {
    await browser.close();
  }
}
const start = (args) =>
  spawn(resolve(binary), [resolve(cli), ...args], {
    env: isolatedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  server = start(["serve", "--no-sync", "--no-open", "--port", String(port)]);
  // Do not log subprocess output: device-login prints its one-time challenge.
  server.stdout.resume();
  server.stderr.resume();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null)
      throw new Error("local server exited before ready: " + server.exitCode);
    try {
      if ((await fetch(local + "/api/runtime-config.js")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(100);
  }
  assert.ok(ready, "local server did not start");
  const runtimeText = await (await request("/api/runtime-config.js")).text();
  const descriptor = JSON.parse(
    runtimeText.match(
      /^window\.__TOKENTRACKER_RUNTIME_CONFIG__=(.*);$/s,
    )?.[1] || "null",
  );
  assert.equal(descriptor.baseUrl, base.origin);
  assert.equal(descriptor.anonKey, anon);
  assert.ok((await (await request("/")).text()).includes("runtime-config.js"));
  if (process.env.TT_QA_BROWSER_UI === "1") await checkBrowser();
  const headers = {
    Origin: local,
    "Content-Type": "application/json",
    "x-tokentracker-instance": base.origin,
    apikey: anon,
  };
  const login = await (
    await request("/api/auth/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: process.env.TT_QA_EMAIL,
        password: process.env.TT_QA_PASSWORD,
      }),
    })
  ).json();
  assert.equal(login.user.id, expectedOwner);
  const renewed = await (
    await request("/api/auth/refresh", { method: "POST", headers, body: "{}" })
  ).json();
  assert.ok(renewed.accessToken);
  const bearer = { ...headers, Authorization: "Bearer " + renewed.accessToken };
  const profile = await (
    await request("/api/auth/sessions/current", { headers: bearer })
  ).json();
  assert.equal(profile.user.id, expectedOwner);
  await request(
    "/api/auth/sessions/current",
    {
      headers: {
        ...bearer,
        "x-tokentracker-instance": "https://example.invalid",
      },
    },
    409,
  );
  const { token: localToken } = await (await request("/api/local-auth")).json();
  const pref = await (
    await request("/functions/tokentracker-cloud-sync-pref", {
      method: "POST",
      headers: { ...headers, "x-tokentracker-local-auth": localToken },
      body: JSON.stringify({ enabled: true, changedAtMs: Date.now() }),
    })
  ).json();
  assert.equal(pref.enabled, true);
  const localBinding = await (
    await request("/functions/tokentracker-cloud-session", {
      method: "POST",
      headers: { ...bearer, "x-tokentracker-local-auth": localToken },
      body: JSON.stringify({
        expectedOwnerId: expectedOwner,
        insforgeBaseUrl: base.origin,
      }),
    })
  ).json();
  assert.ok(localBinding.session_id && localBinding.device_id);
  deviceCli = start(["device-login"]);
  let output = "";
  deviceCli.stdout.on(
    "data",
    (chunk) => (output = (output + chunk.toString()).slice(-8192)),
  );
  deviceCli.stderr.resume();
  const done = once(deviceCli, "exit");
  let code;
  for (let i = 0; i < 150 && deviceCli.exitCode === null; i++) {
    code = output.match(/user_code=([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
    if (code) break;
    await sleep(100);
  }
  assert.ok(code, "actual CLI did not issue a user code");
  const grant = await fetch(
    new URL("/functions/tokentracker-device-flow-grant", base),
    {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: bearer.Authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_code: code }),
    },
  );
  if (!grant.ok) throw new Error("device grant failed: " + grant.status);
  const exit = await Promise.race([done, sleep(16000).then(() => null)]);
  assert.equal(exit?.[0], 0, "device-login did not finish");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.user_id, expectedOwner);
  assert.equal(config.deviceTokenBaseUrl, base.origin);
  assert.ok(config.deviceToken && config.deviceId);
  if (process.env.TT_QA_TEST_UPLOAD === "1") {
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const usage = {
      input_tokens: 7331,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 7331,
    };
    const rawDir = join(directory, ".codex", "sessions", ...day.split("-"));
    await mkdir(rawDir, { recursive: true });
    const ts = day + "T12:00:00.000Z";
    const events = [
      {
        type: "turn_context",
        timestamp: ts,
        payload: { model: "gpt-5.4", cwd: directory },
      },
      {
        type: "event_msg",
        timestamp: ts,
        payload: {
          type: "token_count",
          info: { last_token_usage: usage, total_token_usage: usage },
        },
      },
    ];
    await writeFile(
      join(
        rawDir,
        "rollout-" +
          day +
          "T12-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl",
      ),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { mode: 0o600 },
    );
    syncCli = start(["sync", "--drain"]);
    syncCli.stdout.resume();
    syncCli.stderr.resume();
    const [code] = await once(syncCli, "exit");
    assert.equal(code, 0, "CLI sync --drain failed");
    const queue = await readFile(join(tracker, "queue.jsonl"));
    assert.ok(
      queue
        .toString()
        .split("\n")
        .filter(Boolean)
        .some((line) => JSON.parse(line).total_tokens === 7331),
    );
    assert.equal(
      JSON.parse(await readFile(join(tracker, "queue.state.json"), "utf8"))
        .offset,
      queue.byteLength,
    );
    const report = await fetch(
      new URL(
        "/functions/tokentracker-account-summary?from=" +
          day +
          "&to=" +
          day +
          "&device_id=" +
          config.deviceId,
        base,
      ),
      { headers: { Authorization: bearer.Authorization }, redirect: "error" },
    );
    assert.equal(report.status, 200);
    const stats = await report.json();
    assert.equal(stats.totals.total_tokens, 7331);
    console.log(
      JSON.stringify({
        queue_acknowledged: true,
        cloud_device_summary_tokens: stats.totals.total_tokens,
      }),
    );
  }
  console.log(
    JSON.stringify({
      verified: true,
      deviceId: config.deviceId,
      checks: [
        "serve",
        "dashboard-assets",
        "runtime-descriptor",
        "login",
        "refresh",
        "current-user",
        "stale-origin-rejected",
        "local-cloud-session",
        "cli-device-login",
      ],
    }),
  );
} finally {
  for (const proc of [syncCli, deviceCli, server])
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const closed = once(proc, "exit").catch(() => {});
      proc.kill("SIGTERM");
      await Promise.race([closed, sleep(4000)]);
      if (proc.exitCode === null && proc.signalCode === null)
        proc.kill("SIGKILL");
    }
  await rm(directory, { recursive: true, force: true });
}
