// Real macOS QA app, real system browser, isolated WebKit session, auth endpoints only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve, extname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";

process.umask(0o077);
const [provider, bundle, inputFile] = process.argv.slice(2);
assert.ok(provider === "google" || provider === "github");
const { TT_QA_ID: owner } = JSON.parse(await fs.readFile(inputFile, "utf8"));
assert.match(owner, /^[0-9a-f-]{36}$/);
const app = resolve(bundle),
  executable = join(app, "Contents/MacOS/TokenTrackerQA");
const appID = execFileSync(
  "/usr/libexec/PlistBuddy",
  ["-c", "Print CFBundleIdentifier", join(app, "Contents/Info.plist")],
  { encoding: "utf8" },
).trim();
assert.equal(appID, "com.tokentracker.bar.qa");
const pkg = join(app, "Contents/Resources/EmbeddedServer/tokentracker");
const load = createRequire(join(pkg, "package.json"));
const runID = crypto.randomUUID(),
  challenge = crypto.randomBytes(32).toString("hex");
const parent = await fs.realpath(
  execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
    encoding: "utf8",
  }).trim(),
);
const dir = join(parent, "tokentracker-native-qa-" + runID);
await fs.mkdir(dir, { mode: 0o700 });
const home = join(dir, "home"),
  data = join(home, ".tokentracker/tracker");
await fs.mkdir(data, { recursive: true, mode: 0o700 });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TOKENTRACKER_NO_TELEMETRY = "1";
const upstream =
  "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev";
const config = {
  baseUrl: upstream,
  anonKey: "anon_" + "0".repeat(40),
  dashboardUrl: "https://www.tokentracker.cc",
  machineId: runID,
};
await fs.writeFile(join(data, "config.json"), JSON.stringify(config));
await fs.writeFile(join(data, "cursors.json"), "{}");
await fs.writeFile(join(data, "cloud-sync-pref.json"), '{"enabled":false}');
const api = load("./src/lib/local-api").createLocalApiHandler({
  queuePath: join(data, "queue.jsonl"),
  trackerDataDir: data,
});
const { serveStaticFile } = load("./src/lib/static-server");
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const realm = "tokentracker-native-oauth-qa-v1";
const proof = sha(challenge + "\n" + runID + "\n" + dir);
let origin,
  bootstrapDigest,
  child,
  phase = "start",
  result;
const events = [];
function record(event) {
  if (events.at(-1) === event) return;
  events.push(event);
  console.log(JSON.stringify({ provider, event }));
}
const json = (res, v, status = 200) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(v));
};
const allowed = new Set([
  "/api/auth/public-config",
  "/api/auth/oauth/" + provider,
  "/api/auth/oauth/exchange",
  "/api/auth/sessions/current",
  "/api/auth/logout",
  "/api/auth/refresh",
]);
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host) return json(res, {}, 403);
    const u = new URL(req.url, origin);
    if (u.origin !== origin) return json(res, {}, 403);
    const challenged = req.headers["x-tokentracker-qa-challenge"] === challenge;
    if (u.pathname === "/__native-qa/identity" && challenged)
      return json(res, {
        runID,
        runDirectory: dir,
        challengeProof: proof,
        realm,
        environment: "sandbox",
        scansDisabled: true,
        bootstrapSHA256: bootstrapDigest,
      });
    if (u.pathname === "/__native-qa/flow" && challenged)
      return json(res, { phase });
    if (
      u.pathname === "/__native-qa/event" &&
      challenged &&
      req.method === "POST"
    ) {
      const step = u.searchParams.get("step");
      if (step === "wrong-owner") {
        result = false;
        record("unexpected-account");
        return json(res, {});
      }
      if (step === "owner-visible" && phase === "exchanged") {
        phase = "signout";
        record(step);
      }
      if (step === "signed-out" && phase === "logged-out") {
        phase = "complete";
        result = true;
        record(step);
      }
      return json(res, { phase });
    }
    if (u.pathname === "/api/runtime-config.js" && req.method === "GET")
      return api(req, res, u);
    if (allowed.has(u.pathname) && challenged) {
      if (u.pathname === "/api/auth/oauth/" + provider) {
        assert.equal(req.method, "GET");
        assert.equal(
          u.searchParams.get("redirect_uri"),
          "tokentracker://auth/callback",
        );
        u.searchParams.set("redirect_uri", "tokentracker-qa://auth/callback");
        req.url = u.pathname + "?" + u.searchParams;
        phase = "opening";
        record("authorize");
        res.once("finish", () => {
          if (res.statusCode === 200) {
            phase = "external";
            record("provider-authorization-requested");
          }
        });
      }
      if (u.pathname === "/api/auth/oauth/exchange")
        res.once("finish", () => {
          record("native-exchange-" + res.statusCode);
          if (res.statusCode === 200) phase = "exchanged";
          else result = false;
        });
      if (u.pathname === "/api/auth/logout")
        res.once("finish", () => {
          record("logout-" + res.statusCode);
          if (res.statusCode === 200) phase = "logged-out";
          else result = false;
        });
      return await api(req, res, u);
    }
    if (
      u.pathname.startsWith("/api/") ||
      u.pathname.startsWith("/functions/") ||
      req.method !== "GET"
    )
      return json(res, { error: "QA route outside auth" }, 404);
    // Allow assets under the app only; with this policy the dashboard cannot make cross-origin business requests.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'none'",
    );
    const page = !extname(u.pathname);
    if (u.pathname === "/auth/callback") {
      assert.ok(challenged);
      assert.match(
        u.searchParams.get("insforge_code") ?? "",
        /^[a-zA-Z0-9_-]{43}$/,
      );
      record("native-url-handler-returned");
    }
    if (
      !(await serveStaticFile(
        join(pkg, "dashboard/dist"),
        page ? "/index.html" : u.pathname,
        res,
        { localRuntimeConfig: true },
      ))
    )
      json(res, {}, 404);
  } catch {
    if (!res.headersSent) json(res, {}, 500);
    else res.end();
    record("harness-error");
    result = false;
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
assert.ok(![7680, 7681].includes(port));
origin = "http://127.0.0.1:" + port;
const bootstrap = `(()=>{
 const origin=${JSON.stringify(origin)},expected=${JSON.stringify(owner)},provider=${JSON.stringify(provider)};
 const challenge=${JSON.stringify(challenge)},original=window.fetch.bind(window);
 window.fetch=(input,init={})=>{
  const url=new URL(input instanceof Request?input.url:input,origin); if(url.origin!==origin) return Promise.reject(new Error("QA local auth only"));
  const headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
  headers.set("x-tokentracker-qa-challenge",challenge); return original(input,{...init,headers});
 };
 let busy=false,loginClicked=false,signoutClicked=false;
 setInterval(async()=>{
  if(busy || document.readyState==="loading")return;busy=true;
  try{
   const {phase}=await(await fetch("/__native-qa/flow")).json(), path=location.pathname;
   const go=p=>location.replace(origin+p);
   const buttons=Array.from(document.querySelectorAll("button")).filter(b=>b.offsetWidth);
   const event=s=>fetch("/__native-qa/event?step="+s,{method:"POST"});
   if(phase==="start"){
    if(path!=="/login")return go("/login?app=1");
    const b=buttons.find(b=>b.textContent.toLowerCase().includes(provider));if(b && !loginClicked){loginClicked=true;b.click();}
   } else if(phase==="exchanged"){
    if(path==="/auth/callback")return;
    if(path!=="/settings")return go("/settings?section=account&app=1");
    const ids=Array.from(document.querySelectorAll("span.font-mono")).filter(n=>n.offsetWidth).map(n=>n.textContent.trim()).filter(v=>/^[a-f0-9-]{36}$/.test(v));
    if(ids.length)await event(ids.includes(expected)?"owner-visible":"wrong-owner");
   } else if(phase==="signout"){
    const b=buttons.find(b=>/^(sign out|退出登录|登出)$/i.test(b.textContent.trim()));if(b && !signoutClicked){signoutClicked=true;b.click();}
   } else if(phase==="logged-out"){
    if(path!=="/device")return go("/device?app=1");
    const button=document.querySelector("form button[type=submit]");
    if(button?.disabled && /sign in|登录/i.test(document.body.innerText))await event("signed-out");
   }
  }finally{busy=false;}
 },650);
})();`;
bootstrapDigest = sha(bootstrap);
await fs.writeFile(join(dir, "bootstrap.js"), bootstrap, { mode: 0o600 });
await fs.writeFile(
  join(dir, "profile.json"),
  JSON.stringify({
    version: 1,
    runID,
    origin,
    runDirectory: dir,
    serverChallenge: challenge,
    realm,
    ownedOrderIDs: [],
  }),
  { mode: 0o600 },
);
try {
  const ls =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  execFileSync(ls, ["-f", app], { stdio: "ignore" });
  const handler = execFileSync("/usr/bin/swift", ["-e",
    'import AppKit; print(NSWorkspace.shared.urlForApplication(toOpen: URL(string:"tokentracker-qa://auth/callback")!)?.path ?? "")',
  ], {encoding:"utf8"}).trim();
  assert.ok(handler && await fs.realpath(handler) === await fs.realpath(app),
    "Register this ad-hoc signed QA bundle outside the OS temporary folder before starting provider approval");
  child = spawn(executable, [], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      CFFIXED_USER_HOME: home,
      LANG: "en_US.UTF-8",
      TMPDIR: process.env.TMPDIR,
      TOKENTRACKER_NATIVE_QA_PROFILE: join(dir, "profile.json"),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 12 * 60 * 1000;
  while (
    result === undefined &&
    Date.now() < deadline &&
    child.exitCode === null &&
    !child.signalCode
  )
    await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    result,
    true,
    "QA native OAuth did not finish; last phase: " +
      phase +
      "; native exit: " +
      (child.exitCode ?? child.signalCode),
  );
  assert.ok(
    events.includes("native-url-handler-returned") &&
      events.includes("native-exchange-200") &&
      events.includes("owner-visible") &&
      events.includes("logout-200"),
  );
  console.log(
    JSON.stringify({
      provider,
      callback: "tokentracker-qa://auth/callback",
      owner_matches: true,
      logout: true,
      events,
    }),
  );
} finally {
  if (child && child.exitCode === null && !child.signalCode)
    child.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.rm(dir, { recursive: true, force: true });
}
