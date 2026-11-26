import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { PGlite } from "@electric-sql/pglite";

const require = createRequire(import.meta.url);
const { drainQueueToCloud } = require("../../../src/commands/sync.js");
const { CLOUDFLARE_API_URL, DEFAULT_BASE_URL } = require("../../../src/lib/runtime-config.js");
const { functionUrlFor } = require("../../../src/lib/function-url.js");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "tt-parallel-backends-"));
const queue = join(scratch, "queue.jsonl");
const checkpoint = join(scratch, "queue.state.json");
const source = new PGlite();
const mirrorUrl = "https://legacy.test/functions/tokentracker-cloudflare-usage-mirror";
const legacyAuth = "https://legacy.test";
const account = randomUUID();
const secondAccount = randomUUID();
const device = randomUUID();
const secondDevice = randomUUID();
const token = "test-device-" + randomUUID();
const tokenHash = createHash("sha256").update(token).digest("hex");
const legacyAccess = "test.legacy.signature";
const secondAccess = "test.second.signature";
const legacyRefresh = "legacy-refresh";
const today = new Date().toISOString().slice(0, 10);
const bucket = today + "T00:30:00.000000Z";
const older = today + "T00:00:00.000000Z";
const newer = today + "T01:00:00.000000Z";
const trace = [];
let worker;
let failMirror = false;
let failAck = false;
let lastBatch;
let replay;
let loggedIn = true;
let refreshRequests = 0;
const secret = randomBytes(32).toString("hex");
const read = (path) => readFile(join(root, path), "utf8");

async function sourceFetch(req) {
  const url = new URL(req.url);
  if (req.url === mirrorUrl) {
    assert.equal(req.headers.get("x-tokentracker-mirror-secret"), secret);
    if (failMirror) return new Response(null, { status: 503 });
    const data = await req.json();
    if (data.action === "pending") {
      if (replay) return Response.json({ authorized: true, events: replay });
      let machines = [];
      if (data.include_machine_state) {
        const { rows: [{ payload }] } = await source.query(
          "SELECT tokentracker_cloudflare_machine_pending($1,$2) payload",
          [data.device_token_hash, 50],
        );
        if (!payload.authorized) return Response.json(payload);
        machines = payload.events;
      }
      const { rows: [{ payload }] } = await source.query(
        "SELECT tokentracker_cloudflare_usage_pending($1,$2) payload",
        [data.device_token_hash, 100 - machines.length],
      );
      if (payload.authorized) payload.events.push(...machines);
      lastBatch = payload.events;
      return Response.json(payload);
    }
    assert.equal(data.action, "ack");
    if (failAck) return new Response(null, { status: 503 });
    await source.query("SELECT tokentracker_cloudflare_usage_ack($1::bigint[])", [data.revisions]);
    await source.query("SELECT tokentracker_cloudflare_machine_ack($1::bigint[])", [data.machine_revisions ?? []]);
    return new Response(null, { status: 204 });
  }
  if (url.origin === legacyAuth && url.pathname === "/api/auth/sessions/current") {
    const bearer = req.headers.get("authorization");
    if (bearer === "Bearer " + legacyAccess && loggedIn) return Response.json({ user: { id: account } });
    if (bearer === "Bearer " + secondAccess) return Response.json({ user: { id: secondAccount } });
    return new Response(null, { status: 401 });
  }
  if (url.origin === legacyAuth && url.pathname === "/api/auth/refresh") {
    refreshRequests++;
    const body = await req.json();
    return loggedIn && body.refresh_token === legacyRefresh
      ? Response.json({ accessToken: legacyAccess, user: { id: account } })
      : new Response(null, { status: 401 });
  }
  throw new Error("Unexpected request to " + url.origin + url.pathname);
}

async function putUsage(hour, count, owner = account, machine = device) {
  await source.query(
    "INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,total_tokens,created_at,updated_at) " +
    "VALUES($1,$2,'codex','gpt-5',$3,$4,$4,$3,$3) " +
    "ON CONFLICT(user_id,device_id,source,model,hour_start) DO UPDATE SET input_tokens=excluded.input_tokens,total_tokens=excluded.total_tokens",
    [owner, machine, hour, count],
  );
}

async function installD1(db) {
  for (const name of [
    "0002_hourly.sql", "0003_account_auth.sql", "0010_devices.sql", "0011_device_resets.sql",
    "0020_billing.sql", "0030_public_reports.sql", "0032_report_rollup.sql",
    "0042_device_activity.sql", "0043_usage_cost_coverage.sql", "0044_insforge_usage_mirror.sql",
  ]) {
    const sql = (await read("cloudflare/migrations/" + name)).replace(/^--.*$/gm, "");
    const match = name === "0032_report_rollup.sql"
      ? /;\s*(?=CREATE |INSERT INTO report_dirty_days |$)/
      : /;/;
    for (const stmt of sql.split(match).filter((value) => value.trim())) {
      await db.prepare(stmt).run();
    }
  }
  await db.prepare(
    "INSERT INTO tokentracker_cloud_policy(environment,phase,hosting_mode) VALUES('sandbox','preview','hosted')",
  ).run();
  for (const [i, id, dev] of [[1, account, device], [2, secondAccount, secondDevice]]) {
    await db.prepare("INSERT INTO tt_auth_accounts(id,email,email_verified,created_at) VALUES(?,?,1,?)")
      .bind(id, "parallel-" + i + "@example.test", older).run();
    await db.prepare("INSERT INTO tokentracker_devices(id,user_id,device_name,created_at) VALUES(?,?,?,?)")
      .bind(dev, id, "QA " + i, older).run();
  }
}

const originalFetch = globalThis.fetch;
try {
  await source.exec(
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE project_admin;" +
    "CREATE TABLE tokentracker_devices(id uuid PRIMARY KEY,user_id uuid,device_name text,platform text,machine_id text,revoked_at timestamptz,name_customized bool DEFAULT false,default_device_name text,created_at timestamptz,last_seen_at timestamptz);" +
    "CREATE TABLE tokentracker_device_machine(device_id uuid PRIMARY KEY,machine_cluster_id text);" +
    "CREATE TABLE tokentracker_device_tokens(id uuid PRIMARY KEY,user_id uuid, device_id uuid, token_hash text UNIQUE, revoked_at timestamptz,created_at timestamptz,cloud_environment text,last_used_at timestamptz,last_sync_at timestamptz);" +
    "CREATE TABLE tokentracker_cloud_machines(id uuid PRIMARY KEY,user_id uuid NOT NULL,environment text NOT NULL,status text DEFAULT 'active',merged_into uuid REFERENCES tokentracker_cloud_machines(id),created_at timestamptz NOT NULL,last_seen_at timestamptz,last_upload_at timestamptz,upload_window_until timestamptz,upload_token_id uuid,upload_id text,upload_batch_count integer DEFAULT 0);" +
    "CREATE TABLE tokentracker_cloud_machine_aliases(user_id uuid,environment text,kind text,alias text,machine_id uuid REFERENCES tokentracker_cloud_machines(id),PRIMARY KEY(user_id,environment,kind,alias));" +
    "CREATE TABLE tokentracker_hourly(" +
    "user_id uuid,device_id uuid,source text,model text,hour_start timestamptz," +
    "input_tokens bigint DEFAULT 0,cached_input_tokens bigint DEFAULT 0,cache_creation_input_tokens bigint DEFAULT 0," +
    "output_tokens bigint DEFAULT 0,reasoning_output_tokens bigint DEFAULT 0,total_tokens bigint DEFAULT 0," +
    "billable_total_tokens bigint,conversations int DEFAULT 0,created_at timestamptz,updated_at timestamptz," +
    "total_cost_usd numeric(12,4) DEFAULT 0,cost_coverage jsonb,PRIMARY KEY(user_id,device_id,source,model,hour_start));" +
    "CREATE TABLE tokentracker_account_session_states(" +
    "user_id uuid,source text,session_id text,model text,bucket_start timestamptz," +
    "input_tokens bigint DEFAULT 0,output_tokens bigint DEFAULT 0,cached_input_tokens bigint DEFAULT 0," +
    "cache_creation_input_tokens bigint DEFAULT 0,reasoning_output_tokens bigint DEFAULT 0,total_tokens bigint DEFAULT 0," +
    "snapshot_verified_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,source,session_id));"
  );
  await source.query("INSERT INTO tokentracker_device_tokens(id,user_id,device_id,token_hash) VALUES($1,$2,$3,$4)", [randomUUID(), account, device, tokenHash]);
  await putUsage(older, 10);
  await source.exec(await read("migrations/20261126151000_cloudflare_usage_mirror.sql"));
  await source.exec(await read("migrations/20261126190500_cloudflare-machine-state-mirror.sql"));
  await assert.rejects(source.transaction(async (tx) => {
    await tx.query("UPDATE tokentracker_hourly SET total_tokens=900 WHERE user_id=$1", [account]);
    throw new Error("rollback");
  }), /rollback/);
  const outboxCount = async () => (await source.query(
    `SELECT (SELECT count(*) FROM tokentracker_private.cloudflare_usage_outbox)::int +
      (SELECT count(*) FROM tokentracker_private.cloudflare_machine_outbox)::int AS count`
  )).rows[0].count;
  assert.equal(await outboxCount(), 0);
  await assert.rejects(source.transaction(async (tx) => {
    await tx.exec("SET ROLE authenticated");
    await tx.query("SELECT tokentracker_cloudflare_usage_pending(NULL,100)");
  }), /permission denied/);
  await source.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE project_admin");
    const { rows } = await tx.query("SELECT tokentracker_cloudflare_usage_pending(NULL,100) AS payload");
    assert.deepEqual(rows[0].payload, { authorized: true, events: [] });
  });

  worker = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: join(root, "cloudflare/worker/.cloudflare/output/v1/workers/default/bundle/index.js"),
    compatibilityDate: "2026-11-19",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    ratelimits: { AUTH_LIMIT: { namespace_id: "7401", simple: { limit: 60, period: 60 } } },
    bindings: {
      AUTH_SECRET: randomBytes(32).toString("hex"),
      AUTH_MIGRATION_KEY: randomBytes(32).toString("hex"),
      AUTH_ORIGIN: CLOUDFLARE_API_URL,
      AUTH_WEB_ORIGIN: "https://www.tokentracker.cc",
      LEGACY_AUTH_ENABLED: "1",
      LEGACY_AUTH_MODE: "parallel",
      LEGACY_AUTH_ORIGIN: legacyAuth,
      LEGACY_AUTH_ANON_KEY: "fixture-public-key",
      LEGACY_AUTH_EXPIRES_AT: String(Math.floor(Date.now() / 1000) + 3600),
      TOKENTRACKER_BILLING_ENVIRONMENT: "sandbox",
      USAGE_MIRROR_SOURCE_URL: mirrorUrl,
      USAGE_MIRROR_SECRET: secret,
    },
    outboundService: async (request) => {
      try {
        return await sourceFetch(request);
      } catch (error) {
        console.error("Fixture request failed", new URL(request.url).pathname, error);
        throw error;
      }
    },
  }));
  const db = await worker.getD1Database("DB");
  await installD1(db);
  // Emulate a finished historical backfill. All later changes travel through
  // the transactional PostgreSQL outbox and the production Worker bundle.
  const historical = await source.query("SELECT input_tokens,total_tokens FROM tokentracker_hourly");
  await db.prepare(
    "INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,input_tokens,total_tokens,created_at,updated_at)" +
    " VALUES(?,?,'codex','gpt-5',?,?,?,?,?)"
  ).bind(account, device, older, Number(historical.rows[0].input_tokens), Number(historical.rows[0].total_tokens), older, older).run();

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === functionUrlFor(DEFAULT_BASE_URL, "tokentracker-ingest")) {
      trace.push("insforge");
      assert.equal(init.headers.Authorization, "Bearer " + token);
      const data = JSON.parse(init.body);
      for (const row of data.hourly) await putUsage(row.hour_start, row.total_tokens);
      return Response.json({ inserted: data.hourly.length, skipped: 0 });
    }
    if (url === CLOUDFLARE_API_URL + "/functions/tokentracker-mirror-usage") {
      trace.push("cloudflare");
      return worker.dispatchFetch(url, init);
    }
    throw new Error("QA attempted a non-fixture network request");
  };

  const cliOptions = {
    baseUrl: DEFAULT_BASE_URL, deviceToken: token, queuePath: queue,
    queueStatePath: checkpoint, mirrorUsageToCloudflare: true,
  };
  const cachedUsage = async (hour) => db.prepare(
    "SELECT CAST(total_tokens AS TEXT) FROM tokentracker_hourly WHERE user_id=? AND hour_start=?"
  ).bind(account, hour).first("CAST(total_tokens AS TEXT)");
  const requestCloud = (path, access, init) => worker.dispatchFetch(CLOUDFLARE_API_URL + path, {
    ...init,
    headers: { Authorization: "Bearer " + access, ...init?.headers },
  });
  const scheduled = async () => (await worker.getWorker()).scheduled({ cron: "* * * * *" });

  const report = "/functions/tokentracker-account-summary?from=" + today + "&to=" + today;
  const current = await requestCloud("/api/auth/sessions/current", legacyAccess);
  assert.equal(current.status, 200);
  assert.equal((await current.json()).user.id, account);
  assert.equal(current.headers.has("set-cookie"), false);

  const row = (hour, n) => JSON.stringify({
    hour_start: hour, source: "codex", model: "gpt-5", input_tokens: n, total_tokens: n,
    conversation_count: 1,
  }) + "\n";
  await writeFile(queue, row(bucket, 22));
  assert.equal((await drainQueueToCloud(cliOptions)).inserted, 1);
  assert.deepEqual(trace, ["insforge", "cloudflare"]);
  assert.equal(await cachedUsage(bucket), "22");
  assert.equal(await outboxCount(), 0);

  // A Cloudflare outage leaves primary sync successful and source rows pending.
  failMirror = true;
  await writeFile(queue, row(newer, 33), { flag: "a" });
  assert.equal((await drainQueueToCloud(cliOptions)).inserted, 1);
  assert.equal(JSON.parse(await readFile(checkpoint, "utf8")).offset, (await readFile(queue)).length);
  assert.equal(await cachedUsage(newer), null);
  assert.equal(await outboxCount(), 1);
  failMirror = false;

  // Older clients only write to Postgres. A scheduled run also catches that
  // write and applies a deletion to an already backfilled historical bucket.
  await putUsage(bucket, 18);
  await putUsage(bucket, 60, secondAccount, secondDevice);
  await source.query("DELETE FROM tokentracker_hourly WHERE user_id=$1 AND hour_start=$2", [account, older]);
  assert.equal((await requestCloud("/functions/tokentracker-mirror-usage", "wrong", { method: "POST" })).status, 401);
  assert.equal((await scheduled()).outcome, "ok");
  assert.equal(await outboxCount(), 0);
  assert.equal(await cachedUsage(older), null);
  assert.equal(await cachedUsage(bucket), "18");
  assert.equal(await cachedUsage(newer), "33");

  for (const [access, expected] of [[legacyAccess, 51], [secondAccess, 60]]) {
    const result = await requestCloud(report, access);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await result.json()).totals.total_tokens, expected);
  }
  for (const kind of ["daily", "hourly", "heatmap", "monthly", "model-breakdown", "devices"]) {
    const result = await requestCloud("/functions/tokentracker-account-" + kind +
      "?from=" + today + "&to=" + today + "&day=" + today, legacyAccess);
    assert.equal(result.status, 200, kind + " " + await result.clone().text());
  }

  // Ack loss and a delayed retry cannot overwrite a newer correction.
  await putUsage(newer, "9007199254740993");
  failAck = true;
  assert.equal((await requestCloud("/functions/tokentracker-mirror-usage", token, { method: "POST" })).status, 503);
  assert.equal(await cachedUsage(newer), "9007199254740993");
  assert.equal(await outboxCount(), 1);
  const delayed = lastBatch;
  await putUsage(newer, 3);
  failAck = false;
  assert.equal((await scheduled()).outcome, "ok");
  replay = delayed;
  assert.equal((await requestCloud("/functions/tokentracker-mirror-usage", token, { method: "POST" })).status, 200);
  replay = undefined;
  assert.equal(await cachedUsage(newer), "3");
  assert.equal(await outboxCount(), 0);

  const addedDevice = randomUUID();
  const addedToken = randomUUID();
  await source.query("INSERT INTO tokentracker_devices(id,user_id,device_name,name_customized,created_at) VALUES($1,$2,$3,true,$4)", [addedDevice, account, "Mirrored Device", newer]);
  await source.query("INSERT INTO tokentracker_device_machine VALUES($1,$2)", [addedDevice, "qa-cluster"]);
  await source.query("INSERT INTO tokentracker_device_tokens(id,user_id,device_id,token_hash,created_at,cloud_environment) VALUES($1,$2,$3,$4,$5,$6)", [addedToken, account, addedDevice, "1".repeat(64), newer, "sandbox"]);
  assert.equal((await scheduled()).outcome, "ok");
  assert.equal(await db.prepare("SELECT name_customized FROM tokentracker_devices WHERE id=?").bind(addedDevice).first("name_customized"), 1);
  assert.equal(await db.prepare("SELECT machine_cluster_id FROM tokentracker_device_machine WHERE device_id=?").bind(addedDevice).first("machine_cluster_id"), "qa-cluster");
  await source.query("UPDATE tokentracker_device_tokens SET revoked_at=$2 WHERE id=$1", [addedToken, newer]);
  assert.equal((await scheduled()).outcome, "ok");
  assert.equal(await db.prepare("SELECT revoked_at FROM tokentracker_device_tokens WHERE id=?").bind(addedToken).first("revoked_at"), newer);

  const parent = randomUUID(), merged = randomUUID(), otherSlot = randomUUID();
  const lease = "2026-11-28T12:15:33.123456Z";
  await source.query("INSERT INTO tokentracker_cloud_machines(id,user_id,environment,created_at,upload_window_until,upload_batch_count) VALUES($1,$2,'sandbox',$3,$4,3)", [parent, account, older, lease]);
  await source.query("INSERT INTO tokentracker_cloud_machines(id,user_id,environment,status,created_at,merged_into) VALUES($1,$2,'sandbox','merged',$3,$4)", [merged, account, newer, parent]);
  await source.query("INSERT INTO tokentracker_cloud_machine_aliases VALUES($1,'sandbox','cluster','source-alias',$2)", [account, merged]);
  await source.query("INSERT INTO tokentracker_cloud_machines(id,user_id,environment,created_at) VALUES($1,$2,'sandbox',$3)", [otherSlot, secondAccount, older]);
  const { rows: [{ payload: oldPending }] } = await source.query("SELECT tokentracker_cloudflare_usage_pending(NULL,100) AS payload");
  assert.deepEqual(oldPending.events, []);
  const flush = async () => {
    const response = await requestCloud("/functions/tokentracker-mirror-usage", token, { method: "POST" });
    assert.equal(response.status, 200);
    return (await response.json()).mirrored;
  };
  assert.equal(await flush(), 1);
  assert.equal(await db.prepare("SELECT id FROM tokentracker_cloud_machines WHERE id=?").bind(otherSlot).first("id"), null);
  assert.equal(await flush(), 1);
  assert.equal(await flush(), 1);
  assert.deepEqual(await db.prepare("SELECT upload_window_until,upload_batch_count FROM tokentracker_cloud_machines WHERE id=?")
    .bind(parent).first(), { upload_window_until: lease, upload_batch_count: 3 });
  assert.equal(await db.prepare("SELECT machine_id FROM tokentracker_cloud_machine_aliases WHERE alias='source-alias'").first("machine_id"), merged);

  await db.prepare("INSERT INTO tokentracker_cloud_machine_aliases VALUES(?,'sandbox','cluster','native-alias',?)").bind(account, parent).run();
  await source.query("DELETE FROM tokentracker_cloud_machine_aliases WHERE alias='source-alias'");
  await source.query("DELETE FROM tokentracker_cloud_machines WHERE id IN ($1,$2)", [parent, merged]);
  assert.equal(await flush(), 1);
  assert.equal(await flush(), 1);
  assert.equal(await flush(), 0);
  assert.equal(await outboxCount(), 2);
  assert.equal(await db.prepare("SELECT id FROM tokentracker_cloud_machines WHERE id=?").bind(parent).first("id"), parent);
  assert.equal(await db.prepare("SELECT machine_id FROM tokentracker_cloud_machine_aliases WHERE alias='native-alias'").first("machine_id"), parent);
  await db.prepare("DELETE FROM tokentracker_cloud_machine_aliases WHERE alias='native-alias'").run();
  assert.equal(await flush(), 1);
  assert.equal((await scheduled()).outcome, "ok");
  assert.equal(await db.prepare("SELECT id FROM tokentracker_cloud_machines WHERE id=?").bind(otherSlot).first("id"), otherSlot);
  assert.equal(await outboxCount(), 0);

  // The parallel Worker leaves legacy refresh and logout entirely at the original service.
  const mobile = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: legacyRefresh }) };
  for (const [path, status] of [["refresh", 401], ["session-migrate", 409], ["logout", 401]]) {
    assert.equal((await requestCloud("/api/auth/" + path + "?client_type=mobile", legacyAccess, mobile)).status, status);
  }
  assert.equal(refreshRequests, 0);
  const legacyStillWorks = await sourceFetch(new Request(legacyAuth + "/api/auth/refresh", mobile));
  assert.equal(legacyStillWorks.status, 200);
  loggedIn = false;
  assert.equal((await requestCloud("/api/auth/sessions/current", legacyAccess)).status, 401);
  assert.equal((await requestCloud(report, legacyAccess)).status, 401);
  assert.equal((await requestCloud("/api/auth/sessions/current", secondAccess)).status, 200);
  console.log("PASS: legacy + new uploads, reports, sessions, machine leases, alias dependencies, replay and guarded deletions");
} finally {
  globalThis.fetch = originalFetch;
  await Promise.allSettled([worker?.dispose(), source.close()]);
  await rm(scratch, { recursive: true, force: true });
}
