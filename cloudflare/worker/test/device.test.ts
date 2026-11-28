import costSchema from "../../migrations/0043_usage_cost_coverage.sql?raw";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import hourly from "../../migrations/0002_hourly.sql?raw";
import auth from "../../migrations/0003_account_auth.sql?raw";
import schema from "../../migrations/0010_devices.sql?raw";
import resets from "../../migrations/0011_device_resets.sql?raw";
import rollups from "../../migrations/0032_report_rollup.sql?raw";
import reports from "../../migrations/0030_public_reports.sql?raw";
import guards from "../../migrations/0040_device_reset_snapshot_guards.sql?raw";
import billing from "../../migrations/0020_billing.sql?raw";
import { dispatchDevice, dispatchBillingDevices } from "../src/devices";
import { issueSession } from "../src/auth";

const ctx = {
  ...env,
  DB: env.DB,
  TOKENTRACKER_BILLING_ENVIRONMENT: "sandbox",
  LEADERBOARD_BLOCKED_USER_IDS: "",
  AUTH_SECRET: "an-isolated-worker-test-key-not-for-deployment",
  AUTH_ORIGIN: "https://test.local",
};
const at = "2026-11-22T01:00:00Z";
async function start(uid: string) {
  const user = {
    id: uid,
    email: uid + "@example.test",
    email_verified: 1,
    profile: "{}",
    created_at: at,
  };
  await env.DB.prepare(
    "INSERT INTO tt_auth_accounts(id,email,email_verified,created_at) VALUES(?,?,1,?)",
  )
    .bind(uid, user.email, at)
    .run();
  const response = await issueSession(
    new Request("https://test.local"),
    ctx,
    user,
  );
  return (await response.json<{ accessToken: string }>()).accessToken;
}
async function post(
  route: string,
  body: unknown,
  bearer?: string,
  override?: Partial<typeof ctx>,
) {
  const req = new Request(
    "https://test.local/functions/tokentracker-" + route,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: bearer ? { Authorization: "Bearer " + bearer } : {},
    },
  );
  const res = await dispatchDevice(req, { ...ctx, ...override });
  if (!res) throw new Error("Missing route " + route);
  return res;
}
function bucket(total: number, conversations = 1) {
  return {
    hour_start: at,
    source: "codex",
    model: "gpt",
    input_tokens: total,
    total_tokens: total,
    conversation_count: conversations,
    user_id: "untrusted-client-id",
    device_id: "untrusted-device",
  };
}
describe("Worker device flow and ingest", () => {
  beforeAll(async () => {
    for (const sql of [hourly, auth, schema, resets, billing, reports]) {
      for (const statement of sql
        .replace(/^--.*$/gm, "")
        .split(";")
        .filter((s) => s.trim()))
        await env.DB.prepare(statement).run();
    }
    // The migration contains SQLite trigger bodies; keep each BEGIN ... END intact.
    const rollupStatements = rollups
      .trim()
      .split(
        /;\s*(?=CREATE |INSERT OR IGNORE INTO report_dirty_days SELECT DISTINCT substr\(hour_start,1,10\) FROM tokentracker_hourly;|$)/,
      );
    for (const statement of rollupStatements.filter((s) => s.trim()))
      await env.DB.prepare(statement).run();
  for(const ddl of costSchema.replace(/^--.*$/gm,"").split(";").filter(v=>v.trim())) await env.DB.prepare(ddl).run();
    for (const trigger of guards
      .slice(guards.indexOf("CREATE TRIGGER"))
      .trim()
      .split(/(?=CREATE TRIGGER)/)) {
      await env.DB.prepare(trigger).run();
    }
    await env.DB.prepare(
      "INSERT INTO tokentracker_cloud_policy VALUES ('sandbox','active','2020-01-01T00:00:00Z','hosted')",
    ).run();
  });
  it("binds a CLI grant to its signed-in owner, applies quotas, and uploads with the issued token", async () => {
    const owner = await start("owner"),
      other = await start("other");
    const response = await post("device-flow-authorize", {
      client_info: "darwin my-mac",
      machine_id: "persistent-id",
    });
    const pair = await response.json<{
      user_code: string;
      device_code: string;
    }>();
    expect(pair.device_code).toHaveLength(64);
    expect(await (await post("device-flow-poll", pair)).json()).toMatchObject({
      status: "pending",
    });
    expect((await post("device-flow-grant", pair)).status).toBe(401);
    expect(
      await (await post("device-flow-grant", pair, owner)).json(),
    ).toMatchObject({ ok: true, status: "approved" });
    expect((await post("device-flow-grant", pair, other)).status).toBe(409);
    const approved = await (
      await post("device-flow-poll", pair)
    ).json<{
      status: string;
      user_id: string;
      device_token: string;
      device_id: string;
    }>();
    expect(approved).toMatchObject({ status: "approved", user_id: "owner" });
    expect(
      (
        await post(
          "device-rename",
          { device_id: approved.device_id, device_name: "private" },
          other,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          "device-rename",
          { device_id: approved.device_id, device_name: "my name" },
          owner,
        )
      ).status,
    ).toBe(200);
    const repeated = await (
      await post("device-flow-poll", pair)
    ).json<{ device_token: string; device_id: string }>();
    expect(repeated.device_id).toBe(approved.device_id);
    expect(repeated.device_token).not.toBe(approved.device_token);
    const data = {
      buckets: [bucket(45), bucket(90, 2), bucket(90, 3)],
      upload_id: crypto.randomUUID(),
    };
    expect((await post("ingest", data, approved.device_token)).status).toBe(
      401,
    );
    const first = await (
      await post("ingest", data, repeated.device_token)
    ).json();
    expect(first).toMatchObject({
      ok: true,
      inserted: 1,
      upload_scope: "community",
      membership: { status: "free", machine_limit: 1 },
    });
    const latest = () =>
      env.DB.prepare(
        "SELECT user_id,device_id,total_tokens,conversations FROM tokentracker_hourly",
      ).all();
    expect((await latest()).results).toEqual([
      {
        user_id: "owner",
        device_id: approved.device_id,
        total_tokens: 90,
        conversations: 3,
      },
    ]);
    expect((await post("ingest", data, repeated.device_token)).status).toBe(
      200,
    );
    expect(
      (
        await post(
          "ingest",
          { ...data, buckets: [bucket(60)] },
          repeated.device_token,
        )
      ).status,
    ).toBe(200);
    expect((await latest()).results[0].total_tokens).toBe(60);
    const throttle = await post(
      "ingest",
      { ...data, upload_id: crypto.randomUUID() },
      repeated.device_token,
    );
    expect(throttle.status).toBe(429);
    expect(Number(throttle.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(
      (
        await post(
          "device-token-issue",
          { machine_id: "other-machine", device_name: "another" },
          owner,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post("ingest", data, repeated.device_token, {
          LEADERBOARD_BLOCKED_USER_IDS: "owner",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post("ingest", data, repeated.device_token, {
          TOKENTRACKER_BILLING_ENVIRONMENT: "live",
        })
      ).status,
    ).toBe(401);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM device_write_guard",
      ).first("n"),
    ).toBe(0);
  });
  it("atomically handles concurrent admissions and newer/older account session replays", async () => {
    const owner = await start("concurrent");
    const responses = await Promise.all(
      ["machine-a", "machine-b"].map((machine_id) =>
        post(
          "device-token-issue",
          { machine_id, device_name: machine_id },
          owner,
        ),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const { token } = await responses
      .find((r) => r.ok)!
      .json<{ token: string }>();
    const snapshot = {
      source: "trae-cn",
      session_id: "one",
      model: "model-a",
      bucket_start: at,
      snapshot_verified_at: at,
      input_tokens: 90,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 0,
      output_tokens: 0,
      total_tokens: 90,
    };
    const upload_id = crypto.randomUUID();
    const write = (state: typeof snapshot) =>
      post("ingest", { upload_id, account_session_states: [state] }, token);
    expect((await write(snapshot)).status).toBe(200);
    const changed = {
      ...snapshot,
      model: "model-b",
      input_tokens: 50,
      total_tokens: 50,
      snapshot_verified_at: "2026-11-22T02:00:00Z",
    };
    expect((await write(changed)).status).toBe(200);
    expect((await write(snapshot)).status).toBe(200);
    expect(
      (
        await env.DB.prepare(
          "SELECT model,total_tokens FROM tokentracker_account_session_states",
        ).all()
      ).results,
    ).toEqual([{ model: "model-b", total_tokens: 50 }]);
    expect((await write({ ...snapshot, input_tokens: 45 })).status).toBe(400);
    await env.DB.prepare(
      "UPDATE tokentracker_cloud_machines SET status='paused'",
    ).run();
    expect((await write(snapshot)).status).toBe(403);
  });
  it("resets only the owning slot, revokes prior tokens, and protects snapshots during rebuild", async () => {
    const owner = await start("reset-owner"),
      other = await start("reset-other");
    const issue = async (key: string) =>
      (
        await post(
          "device-token-issue",
          { machine_id: "reset-host-1", device_name: "reset" },
          key,
        )
      ).json<{ token: string; device_id: string }>();
    const a = await issue(owner),
      b = await issue(other);
    const upload = { upload_id: crypto.randomUUID(), buckets: [bucket(15)] };
    expect((await post("ingest", upload, a.token)).status).toBe(200);
    expect((await post("ingest", upload, b.token)).status).toBe(200);
    const writeRank = () =>
      env.DB.prepare(
        `INSERT INTO tokentracker_leaderboard_snapshots(user_id,period,from_day,to_day,rank,generated_at)
      VALUES ('reset-owner','total','2026-01-01','2026-11-22',1,'2026-11-01T00:00:00Z')`,
      ).run();
    await writeRank();
    const operation_id = crypto.randomUUID();
    const reset = { action: "reset", device_id: a.device_id, operation_id };
    const owned = await (await post("device-usage-reset", reset, owner)).json();
    expect(owned).toMatchObject({ ok: true, status: "reset", removed_rows: 1 });
    expect(
      await (await post("device-usage-reset", reset, owner)).json(),
    ).toEqual(owned);
    expect(
      (
        await post(
          "device-usage-reset",
          { ...reset, operation_id: crypto.randomUUID() },
          owner,
        )
      ).status,
    ).toBe(409);
    expect((await post("device-usage-reset", reset, other)).status).toBe(409);
    expect((await post("ingest", upload, a.token)).status).toBe(401);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM tokentracker_hourly WHERE user_id='reset-other'",
      ).first("n"),
    ).toBe(1);
    expect((await writeRank()).meta.changes).toBe(0);
    const refresh = { action: "refresh", operation_id };
    expect((await post("device-usage-reset", refresh, b.token)).status).toBe(
      404,
    );
    const again = await issue(owner);
    expect((await post("ingest", upload, again.token)).status).toBe(200);
    const done = await (
      await post("device-usage-reset", refresh, again.token)
    ).json();
    expect(done).toMatchObject({
      ok: true,
      status: "complete",
      removed_rows: 1,
    });
    expect(
      await (await post("device-usage-reset", refresh, again.token)).json(),
    ).toEqual(done);
    expect((await writeRank()).meta.changes).toBe(0);
  });

  it("lists, pauses, resumes, and reissues credentials only for the owning account", async () => {
    const uid = "slot-owner",
      account = await start(uid);
    const identify = {
      machine_id: "slot-native-id",
      device_name: "test",
      platform: "mac",
    };
    const first = await (
      await post("device-token-issue", identify, account)
    ).json<{ token: string; machine_id: string; device_id: string }>();
    const manage = (
      id: string,
      action: string,
      body: Record<string, unknown>,
    ) => dispatchBillingDevices(env.DB, id, "sandbox", action, body);
    expect(
      await (
        await manage(uid, "devices", {
          current_machine_id: identify.machine_id,
        })
      ).json(),
    ).toMatchObject({
      machines: [
        { is_current: true, machine_id: first.machine_id, status: "active" },
      ],
      machine_count: 1,
    });
    expect(
      (
        await manage("slot-stranger", "remove-device", {
          machine_id: first.machine_id,
        })
      ).status,
    ).toBe(404);
    const paused = await (
      await manage(uid, "remove-device", { machine_id: first.machine_id })
    ).json();
    expect(paused).toMatchObject({ ok: true, machine_count: 0 });
    expect(
      (await post("ingest", { buckets: [bucket(2)] }, first.token)).status,
    ).toBe(401);
    expect((await post("device-token-issue", identify, account)).status).toBe(
      403,
    );
    expect(
      await (
        await manage(uid, "resume-device", { machine_id: first.machine_id })
      ).json(),
    ).toMatchObject({ ok: true, machine_count: 1 });
    expect(
      await (await post("device-token-issue", identify, account)).json(),
    ).toMatchObject({
      device_id: first.device_id,
      machine_id: first.machine_id,
    });
  });

  it("merges an imported legacy device, preserving larger historical versions and moving its tokens", async () => {
    const uid = "legacy-adoption",
      account = await start(uid);
    const canonical = await (
      await post(
        "device-token-issue",
        {
          machine_id: "stable-machine",
          device_name: "current",
          platform: "cli",
        },
        account,
      )
    ).json<{ device_id: string; token: string }>();
    const legacy = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO tokentracker_devices(id,user_id,device_name,platform,created_at) VALUES(?,?,?,'cli',?)",
    )
      .bind(legacy, uid, "old-host", at)
      .run();
    await env.DB.prepare(
      "INSERT INTO tokentracker_device_tokens(id,user_id,device_id,token_hash,created_at,cloud_environment) VALUES(?,?,?,'oldhash',?,'sandbox')",
    )
      .bind(crypto.randomUUID(), uid, legacy, at)
      .run();
    const datum={version:1,reported_usd:0.25,reported_events:1,missing_events:0,allocated_events:0,origins:["grok_usd"],unreported_tokens:{
      input_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0,reasoning_output_tokens:0}};
    for (const [device, total] of [[canonical.device_id,41],[legacy,60]] as const) {
      await env.DB.prepare("INSERT INTO tokentracker_hourly(user_id,device_id,hour_start,source,model,total_tokens,created_at,updated_at,total_cost_usd,cost_coverage) VALUES(?,?,?,'grok','grok-4.7',?,?,?,?,?)")
        .bind(uid,device,at,total,at,at,device===legacy?"0.25":"0",device===legacy?JSON.stringify(datum):null).run();
    }
    const issued = await (
      await post(
        "device-token-issue",
        {
          machine_id: "stable-machine",
          device_name: "old-host",
          platform: "cli",
        },
        account,
      )
    ).json();
    expect(issued).toMatchObject({ device_id: canonical.device_id });
    const usage = await env.DB.prepare(
      "SELECT device_id,total_tokens,cost_coverage FROM tokentracker_hourly WHERE user_id=?",
    )
      .bind(uid)
      .all();
    expect(usage.results).toEqual([
      { device_id: canonical.device_id, total_tokens: 60, cost_coverage:JSON.stringify(datum) },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT device_id FROM tokentracker_device_tokens WHERE token_hash='oldhash'",
      ).first("device_id"),
    ).toBe(canonical.device_id);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM tokentracker_cloud_machines WHERE user_id=? AND status='active'",
      )
        .bind(uid)
        .first("n"),
    ).toBe(1);
  });

  it("admits parallel continuation writes exactly up to the device upload cap",async()=>{
    const uid="continuation-burst", owner=await start(uid), upload_id=crypto.randomUUID();
    const issued=await (await post("device-token-issue",{machine_id:"continuation-test"},owner)).json<{token:string}>();
    const upload=(i:number)=>post("ingest",{upload_id,buckets:[{...bucket(2),model:"burst-"+i}]},issued.token);
    expect((await upload(0)).status).toBe(200);
    const results=await Promise.all(Array.from({length:12},(_,i)=>upload(i+1)));
    const accepted=results.filter(r=>r.status===200);
    expect(accepted.length).toBe(9); // One initial batch plus nine continuations on the free product plan.
    expect(results.filter(r=>r.status===429)).toHaveLength(3);
    const row=await env.DB.prepare("SELECT upload_batch_count FROM tokentracker_cloud_machines WHERE user_id=?").bind(uid).first();
    expect(row?.upload_batch_count).toBe(10);
    expect(await env.DB.prepare("SELECT count(*) n FROM tokentracker_hourly WHERE user_id=?").bind(uid).first("n")).toBe(10);
  });

  it("accepts a full 500 bucket batch and rejects the 501st without mutating that account", async () => {
    const uid = "batch-500",
      owner = await start(uid);
    const { token } = await (
      await post("device-token-issue", { machine_id: "batch-machine" }, owner)
    ).json<{ token: string }>();
    const records = Array.from({ length: 500 }, (_, i) => ({
      ...bucket(5),
      model: "Batch-" + i,
    }));
    const upload_id = crypto.randomUUID();
    expect(
      await (
        await post("ingest", { buckets: records, upload_id }, token)
      ).json(),
    ).toMatchObject({ ok: true, inserted: 500 });
    expect(
      (
        await post(
          "ingest",
          { buckets: [...records, bucket(23)], upload_id },
          token,
        )
      ).status,
    ).toBe(400);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM tokentracker_hourly WHERE user_id=?",
      )
        .bind(uid)
        .first("n"),
    ).toBe(500);
  });
  it("negotiates cost coverage before upload, validates it atomically and acknowledges writes only after commit",async()=>{
    const uid="costs-in-device-flow", owner=await start(uid);
    const pair=await (await post("device-flow-authorize",{machine_id:"cost-fixture"})).json<{user_code:string;device_code:string}>();
    await post("device-flow-grant",pair,owner);
    const {device_token:token}=await (await post("device-flow-poll",pair)).json<{device_token:string}>();
    expect((await post("ingest",{kind:"cost_capabilities"},"invalid")).status).toBe(401);
    expect(await (await post("ingest",{kind:"cost_capabilities"},token)).json()).toEqual({cost_coverage_versions:[1]});
    const unc={input_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0,reasoning_output_tokens:0};
    const proof={version:1,reported_usd:0,reported_events:1,missing_events:0,allocated_events:0,origins:["cursor_csv_cost"],unreported_tokens:unc};
    const row={...bucket(24),source:"cursor",model:"grok-bot-new",total_cost_usd:0,cost_coverage:proof};
    const upload_id=crypto.randomUUID();
    expect((await post("ingest",{hourly:[row],upload_id},token)).status).toBe(400);
    expect((await post("ingest",{cost_coverage_version:2,hourly:[row],upload_id},token)).status).toBe(400);
    const malformed={...row,cost_coverage:{...proof,prompt:"drop"}};
    expect((await post("ingest",{cost_coverage_version:1,hourly:[row,malformed],upload_id},token)).status).toBe(400);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tokentracker_hourly WHERE user_id=?").bind(uid).first("n")).toBe(0);
    const prev={...row,total_cost_usd:1,cost_coverage:{...proof,reported_usd:1}};
    const data=await (await post("ingest",{hourly:[prev,row],cost_coverage_version:1,upload_id},token)).json();
    expect(data).toMatchObject({ok:true,inserted:1,cost_coverage_version:1});
    const read=()=>env.DB.prepare("SELECT cost_coverage FROM tokentracker_hourly WHERE user_id=?").bind(uid).first<string>("cost_coverage");
    expect(JSON.parse((await read())!)).toEqual(proof);
    const {cost_coverage,...legacy}=row;
    const rewritten=await (await post("ingest",{hourly:[legacy],upload_id},token)).json();
    expect(rewritten).toMatchObject({inserted:1});expect(rewritten).not.toHaveProperty("cost_coverage_version");
    expect(await read()).toBeNull();
  });
  it("returns an identity conflict when distinct machines also share the fallback display suffix", async () => {
    const uid = "suffix-collision";
    const owner = await start(uid);
    await env.DB.prepare(
      "INSERT INTO tokentracker_cloud_accounts (user_id,environment,trial_started_at,trial_ends_at) VALUES (?,'sandbox',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'))",
    )
      .bind(uid)
      .run();
    const args = { device_name: "duplicate", platform: "mac" };
    for (const machine_id of ["abcdefgh-01", "abcdefgh-02"]) {
      expect(
        (await post("device-token-issue", { ...args, machine_id }, owner))
          .status,
      ).toBe(200);
    }
    const rejected = await post(
      "device-token-issue",
      { ...args, machine_id: "abcdefgh-03" },
      owner,
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      code: "cloud_device_identity_conflict",
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM tokentracker_devices WHERE user_id=?",
      )
        .bind(uid)
        .first("n"),
    ).toBe(2);
  });
});
