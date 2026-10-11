"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { createRAMAuthBroker, BACKEND, GATEWAY, REALM } = require("./native-qa-auth.cjs");

const LOCAL_READ = new Set(["tokentracker-user-status", "tokentracker-usage-summary", "tokentracker-usage-daily",
  "tokentracker-usage-hourly", "tokentracker-usage-monthly", "tokentracker-usage-heatmap",
  "tokentracker-usage-model-breakdown", "tokentracker-usage-category-breakdown"]);
const SAFE_API = new Set(["/api/local-auth", "/api/runtime-config.js"]);
const uuid = value => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw Error("native_qa_body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function response(res, value, isCurrent) {
  const bytes = Buffer.from(await value.arrayBuffer());
  if (isCurrent && !isCurrent(bytes)) return json(res, 403, { error: "native_qa_session_changed" });
  res.writeHead(value.status, { "Content-Type": value.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" });
  res.end(bytes);
}

function installFileAndProcessGuards({ packageRoot, runDirectory, counters }) {
  const roots = [packageRoot, runDirectory].map(value => fs.realpathSync(value));
  const realpath = fs.realpathSync;
  const inRoots = value => roots.some(root => value === root || value.startsWith(root + path.sep));
  const allowed = input => {
    const value = input instanceof URL && input.protocol === "file:" ? require("node:url").fileURLToPath(input)
      : typeof input === "string" || Buffer.isBuffer(input) ? path.resolve(String(input)) : null;
    if (!value || !inRoots(value)) return false;
    let ancestor = value;
    while (true) {
      try { return inRoots(realpath(ancestor)); }
      catch (error) {
        if (error.code !== "ENOENT" || ancestor === path.dirname(ancestor)) return false;
        ancestor = path.dirname(ancestor);
      }
    }
  };
  for (const name of ["readFileSync", "readFile", "writeFileSync", "writeFile", "appendFileSync", "appendFile",
    "readdirSync", "readdir", "openSync", "open", "mkdirSync", "mkdir", "unlinkSync", "unlink", "rmSync", "rm", "rmdirSync", "rmdir", "createReadStream", "createWriteStream"]) {
    const original = fs[name];
    fs[name] = function (file, ...args) {
      if (!allowed(file)) { counters.blockedFileAccess++; throw Error("native_qa_file_access_rejected"); }
      return original.call(this, file, ...args);
    };
  }
  for (const name of ["readFile", "writeFile", "appendFile", "readdir", "open", "mkdir", "unlink", "rm", "rmdir"]) {
    const original = fs.promises[name];
    fs.promises[name] = async function (file, ...args) {
      if (!allowed(file)) { counters.blockedFileAccess++; throw Error("native_qa_file_access_rejected"); }
      return original.call(this, file, ...args);
    };
  }
  const cp = require("node:child_process");
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    cp[name] = () => { counters.blockedProcessLaunch++; throw Error("native_qa_process_launch_rejected"); };
  }
  globalThis.fetch = () => { counters.blockedNetwork++; throw Error("native_qa_core_network_rejected"); };
  for (const api of [require("node:http"), require("node:https")]) {
    for (const name of ["get", "request"]) api[name] = () => { counters.blockedNetwork++; throw Error("native_qa_core_network_rejected"); };
  }
}

async function createNativeQAServer({ packageRoot, repoRoot, allowedUserIDs, ownedOrderIDs, publicProfile, fetchImpl = fetch }) {
  packageRoot = fs.realpathSync(packageRoot);
  if (!Array.isArray(ownedOrderIDs) || !ownedOrderIDs.length || ownedOrderIDs.length > 8 || ownedOrderIDs.some(id => !uuid(id))) {
    throw Error("native_qa_order_configuration_required");
  }
  const modulePath = path.join(repoRoot, "scripts/cloud-sandbox/native-client-transport.mjs");
  const { createNativeSandboxTransport, assertPublicProfile, classifyNativeSandboxFunction } = await import(pathToFileURL(modulePath).href);
  if (typeof classifyNativeSandboxFunction !== "function") throw Error("native_qa_transport_classifier_required");
  assertPublicProfile(publicProfile);
  const runID = crypto.randomUUID();
  const runDirectory = path.join(fs.realpathSync(os.tmpdir()), "tokentracker-native-qa-" + runID);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  const serverChallenge = crypto.randomBytes(32).toString("hex");
  const trackerDataDir = path.join(runDirectory, "data");
  fs.mkdirSync(trackerDataDir, { mode: 0o700 });
  const queuePath = path.join(trackerDataDir, "queue.jsonl");
  fs.writeFileSync(queuePath, "", { mode: 0o600 });
  fs.writeFileSync(path.join(trackerDataDir, "config.json"), JSON.stringify({ baseUrl: BACKEND }), { mode: 0o600 });
  const counters = { blockedFileAccess: 0, blockedProcessLaunch: 0, blockedNetwork: 0, rejectedRequests: 0 };
  let localAPI; let serveStatic; let origin; let bootstrapSHA256; let ready = false; let bootstrapUsed = false;
  const rawFetch = fetchImpl;
  const trustedFetch = (input, init = {}) => {
    const target = new URL(input);
    if (target.username || target.password || target.hash ||
        !(target.origin === origin || target.origin === BACKEND && target.pathname.startsWith("/api/auth/") ||
          target.origin === new URL(GATEWAY).origin && target.pathname === new URL(GATEWAY).pathname)) {
      counters.blockedNetwork++; throw Error("native_qa_network_rejected");
    }
    return rawFetch(input, { ...init, redirect: "error", credentials: "omit" });
  };
  const broker = createRAMAuthBroker({ allowedUserIDs, fetchImpl: trustedFetch });
  const identity = () => ({ runID, runDirectory, realm: REALM, environment: "sandbox", scansDisabled: true,
    challengeProof: digest(serverChallenge + "\n" + runID + "\n" + runDirectory), bootstrapSHA256 });
  const server = http.createServer(async (req, res) => {
    try {
      if (!ready) return json(res, 503, { error: "native_qa_initializing" });
      const url = new URL(req.url, origin);
      if (!req.url.startsWith("/") || url.origin !== origin) throw Error("native_qa_target_rejected");
      res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
      const challenged = req.headers["x-tokentracker-qa-challenge"] === serverChallenge;
      const expectedHost = new URL(origin).host;
      const foreignReferer = req.headers.referer && new URL(req.headers.referer).origin !== origin;
      if (req.headers.host !== expectedHost || req.headers.origin && req.headers.origin !== origin || foreignReferer ||
          Object.keys(req.headers).some(name => name === "forwarded" || name.startsWith("x-forwarded-") || ["x-real-ip", "x-original-url"].includes(name)) ||
          req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) {
        counters.rejectedRequests++; return json(res, 403, { error: "native_qa_origin_rejected" });
      }
      if (url.pathname.startsWith("/__native-qa/")) {
        if (!challenged) return json(res, 403, { error: "native_qa_challenge_required" });
        if (url.pathname === "/__native-qa/identity" && req.method === "GET") return json(res, 200, identity());
        if (url.pathname === "/__native-qa/access" && req.method === "GET") return json(res, 200, { accessToken: broker.accessToken() });
        if (url.pathname === "/__native-qa/validate-actor" && req.method === "POST") {
          const value = await body(req);
          if (Object.keys(value).length !== 3 || value.realm !== REALM || value.actor !== broker.actorID() ||
              value.actorEpoch !== broker.sessionEpoch() || !value.actor) throw Error("native_qa_session_changed");
          return json(res, 200, { ...identity(), allowed: true, actor: value.actor, actorEpoch: value.actorEpoch });
        }
        if (url.pathname === "/__native-qa/bootstrap-refresh" && req.method === "POST") {
          if (bootstrapUsed || req.headers.origin || Object.keys(req.headers).some(name =>
              name.startsWith("sec-fetch-") && !(name === "sec-fetch-mode" && req.headers[name] === "cors"))) throw Error("native_qa_server_seed_rejected");
          const value = await body(req);
          if (Object.keys(value).length !== 1 || typeof value.refreshToken !== "string") throw Error("native_qa_server_seed_rejected");
          bootstrapUsed = true;
          const seeded = await broker.bootstrapRealRefresh(value.refreshToken);
          if (seeded.status !== 200) throw Error("native_qa_server_seed_rejected");
          return json(res, 200, { ...identity(), authenticated: true, actor: broker.actorID(), actorEpoch: broker.sessionEpoch() });
        }
        if (url.pathname === "/__native-qa/validate-order" && req.method === "POST") {
          const value = await body(req);
          if (value.realm !== REALM || !ownedOrderIDs.includes(value.order) || Object.keys(value).length !== 2) throw Error("native_qa_order_rejected");
          const verified = await broker.ownedOrder(value.order);
          if (broker.sessionEpoch() !== verified.epoch || broker.actorID() !== verified.userID) throw Error("native_qa_session_changed");
          return json(res, 200, { ...identity(), allowed: true, order: value.order, actor: verified.userID, actorEpoch: verified.epoch });
        }
        if (url.pathname === "/__native-qa/validate-external" && req.method === "POST") {
          const value = await body(req);
          if (value.realm !== REALM || typeof value.url !== "string" || Object.keys(value).length !== 2) throw Error("native_qa_external_rejected");
          const target = new URL(value.url);
          if (target.origin !== "https://pancake.waffo.ai" || target.username || target.password || target.port || target.hash ||
              !/^\/store\/[0-9A-Za-z_-]+\/checkout\/cs_[0-9A-Za-z_-]+$/.test(target.pathname) ||
              target.searchParams.getAll("test").length !== 1 || target.searchParams.get("test") !== "true" ||
              target.searchParams.has("csId") || target.searchParams.has("cs_id")) throw Error("native_qa_external_rejected");
          const capturedEpoch = broker.sessionEpoch(); const actor = broker.actorID();
          let matched = false;
          for (const order of ownedOrderIDs) {
            const verified = await broker.ownedOrder(order);
            if (verified.order.checkout_url === value.url) { matched = true; break; }
          }
          if (!matched || broker.sessionEpoch() !== capturedEpoch || broker.actorID() !== actor) throw Error("native_qa_external_rejected");
          return json(res, 200, { ...identity(), allowed: true, urlSHA256: digest(value.url), actor, actorEpoch: capturedEpoch });
        }
        if (url.pathname === "/__native-qa/transport" && req.method === "POST") {
          const value = await body(req);
          if (typeof value.url !== "string" || typeof value.method !== "string" || !value.headers ||
              !["GET", "POST", "HEAD"].includes(value.method) || value.body !== null && typeof value.body !== "string") throw Error("native_qa_request_rejected");
          const target = new URL(value.url);
          const sourceHeaders = new Headers(value.headers);
          const auth = target.pathname.startsWith("/api/auth/");
          const businessFunction = classifyNativeSandboxFunction(target, origin);
          const business = !!businessFunction;
          const capturedEpoch = broker.sessionEpoch(); const capturedActor = broker.actorID();
          if (business) {
            const supplied = sourceHeaders.get("Authorization");
            if (supplied && (!supplied.startsWith("Bearer ") || !broker.acceptsAccessToken(supplied.slice(7)))) throw Error("native_qa_session_rejected");
            if (value.method === "POST") {
              const input = JSON.parse(value.body);
              const action = target.searchParams.get("action");
              const orderRead = action === "reconcile" && ownedOrderIDs.includes(input?.id);
              const giftClaim = action === "redeem-gift" && input && !Array.isArray(input) &&
                Object.keys(input).length === 2 && typeof input.code === "string" && input.code.length <= 256 &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request_id || "");
              if (businessFunction !== "tokentracker-billing" || !orderRead && !giftClaim) throw Error("native_qa_mutation_rejected");
            }
          }
          const localFetch = async (input, init) => {
            const localURL = new URL(input, origin);
            if (localURL.origin !== origin || init.method !== "GET") return Response.json({ error: "native_qa_local_write_rejected" }, { status: 503 });
            const headers = new Headers(init.headers); headers.set("X-TokenTracker-QA-Challenge", serverChallenge);
            return trustedFetch(localURL, { ...init, headers, redirect: "error" });
          };
          if (target.origin === origin && SAFE_API.has(target.pathname) && value.method === "GET") {
            return response(res, await localFetch(value.url, { method: "GET", headers: sourceHeaders }),
              () => broker.sessionEpoch() === capturedEpoch && broker.actorID() === capturedActor);
          }
          const transport = createNativeSandboxTransport({ profile: publicProfile, localOrigin: origin,
            fetchImpl: trustedFetch, getAccessToken: async () => broker.accessToken(),
            authBrokerFetch: (_, init) => broker.request(target.pathname, init),
            localFetch });
          const result = await transport(value.url, { method: value.method, headers: sourceHeaders, body: value.body ?? undefined });
          const boundEpoch = result.headers.get("X-Native-QA-Auth-Epoch");
          const replyEpoch = auth && boundEpoch !== null ? Number(boundEpoch) : capturedEpoch;
          const replyActor = auth && boundEpoch !== null ? result.headers.get("X-Native-QA-Actor") : capturedActor;
          return response(res, result, bytes => {
            if (broker.sessionEpoch() !== replyEpoch || broker.actorID() !== replyActor) return false;
            if (!auth) return true;
            let reply; try { reply = JSON.parse(bytes); } catch { return false; }
            return (!reply.user || reply.user.id === replyActor) &&
              (!reply.accessToken || broker.acceptsAccessToken(reply.accessToken));
          });
        }
        return json(res, 404, { error: "native_qa_route_rejected" });
      }
      if (req.method === "GET" && SAFE_API.has(url.pathname)) return localAPI(req, res, url);
      const fn = /^\/functions\/(tokentracker-[a-z-]+)$/.exec(url.pathname)?.[1];
      if (fn) {
        if (!challenged || req.method !== "GET" || !LOCAL_READ.has(fn)) return json(res, 503, { error: "native_qa_scan_or_mutation_rejected" });
        return localAPI(req, res, url);
      }
      if (!["GET", "HEAD"].includes(req.method) || /^\/(api|functions)(\/|$)/.test(url.pathname)) return json(res, 503, { error: "native_qa_route_rejected" });
      const entry = !path.extname(url.pathname) || url.pathname === "/index.html";
      if (entry && !challenged) return json(res, 403, { error: "native_qa_transport_required" });
      if (!await serveStatic(path.join(packageRoot, "dashboard/dist"), entry ? "/index.html" : url.pathname, res, { localRuntimeConfig: true })) {
        json(res, 404, { error: "native_qa_asset_not_found" });
      }
    } catch { counters.rejectedRequests++; if (!res.headersSent) json(res, 403, { error: "native_qa_request_rejected" }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  if ([7680, 7681].includes(server.address().port)) { server.close(); throw Error("native_qa_port_rejected"); }
  const esbuild = require(path.join(repoRoot, "dashboard/node_modules/esbuild"));
  const bootstrap = await esbuild.build({ write: false, bundle: true, platform: "browser", format: "iife", target: "es2020",
    stdin: { resolveDir: repoRoot, contents: `
const original = window.fetch.bind(window);
const origin = ${JSON.stringify(origin)};
const challenge = ${JSON.stringify(serverChallenge)};
window.fetch = async (input, init = {}) => {
  const existing = input instanceof Request ? input : null;
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
  const method = String(init.method || existing?.method || "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(init.headers || existing?.headers));
  const body = init.body !== undefined ? init.body : existing && !["GET", "HEAD"].includes(method) ? await existing.clone().text() : null;
  return original(origin + "/__native-qa/transport", { method: "POST", headers: {
    "Content-Type": "application/json", "X-TokenTracker-QA-Challenge": challenge },
    body: JSON.stringify({ url: url.href, method, headers, body }), credentials: "omit", redirect: "error" });
};
window.XMLHttpRequest = class { constructor() { throw new Error("Native QA XHR disabled"); } };
window.WebSocket = class { constructor() { throw new Error("Native QA realtime disabled"); } };
navigator.sendBeacon = () => false;
` } });
  const bootstrapBytes = Buffer.from(bootstrap.outputFiles[0].contents);
  bootstrapSHA256 = digest(bootstrapBytes);
  fs.writeFileSync(path.join(runDirectory, "bootstrap.js"), bootstrapBytes, { mode: 0o600 });
  const profile = { version: 1, runID, origin, runDirectory, serverChallenge, realm: REALM, ownedOrderIDs };
  fs.writeFileSync(path.join(runDirectory, "profile.json"), JSON.stringify(profile), { mode: 0o600 });
  installFileAndProcessGuards({ packageRoot, runDirectory, counters });
  delete process.env.TOKENTRACKER_DEVICE_TOKEN;
  delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  delete process.env.TOKENTRACKER_INSFORGE_ANON_KEY;
  const local = require(path.join(packageRoot, "src/lib/local-api.js"));
  localAPI = local.createLocalApiHandler({ queuePath, trackerDataDir });
  serveStatic = require(path.join(packageRoot, "src/lib/static-server.js")).serveStaticFile;
  ready = true;
  return { server, profilePath: path.join(runDirectory, "profile.json"), runID, runDirectory, origin, counters,
    close: async () => { broker.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

module.exports = { createNativeQAServer, installFileAndProcessGuards };
