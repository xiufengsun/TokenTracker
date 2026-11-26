import costSchema from "../../migrations/0043_usage_cost_coverage.sql?raw";
import { env } from "cloudflare:workers";
import snapshots from "../../migrations/0001_community_snapshot.sql?raw";
import social from "../../migrations/0031_social_telemetry.sql?raw";
import rollup from "../../migrations/0032_report_rollup.sql?raw";
import catalog from "../../migrations/0033_badge_catalog.sql?raw";
import { refreshCommunity } from "../src/report-community";
import { refreshAchievements } from "../src/report-achievements";
import { refreshRanking } from "../src/report-refresh";
import moderation from "../../migrations/0034_report_moderation.sql?raw";
import {detectAnomalies,pruneSnapshots,quarantineAudit,reconcileQueue} from "../src/report-moderation";
import { beforeAll, expect, it } from "vitest";
import hourly from "../../migrations/0002_hourly.sql?raw";
import devices from "../../migrations/0010_devices.sql?raw";
import auth from "../../migrations/0003_account_auth.sql?raw";
import publics from "../../migrations/0030_public_reports.sql?raw";
import { accountReport } from "../src/report-account";
import { accountUsage, reportClock } from "../src/report-usage";
import { dispatchReports } from "../src/reports";
import { profileReport } from "../src/report-profile";
import {publicRowCost} from "../src/report-public-pricing";
import { computeRowCost } from "../src/report-pricing";
import legacyPricing from "../../../dashboard/edge-patches/tokentracker-account-daily.ts?raw";
import workerPricing from "../src/report-pricing.ts?raw";

const user = "e42d4c42-4760-418b-ba5f-57f02c80cb74";
const other = "00cbaa31-af42-477b-8357-d82c31dc6008";
const t = "2026-11-01T05:30:00.000000Z",
  t2 = "2026-11-01T06:30:00.000000Z";
const d1 = "74e83859-e839-4c26-942e-840df46c1211",
  d2 = "fbdde808-21dd-4180-a598-c22657fdb828";
const db = env.DB;
const allowed = { status: "active", phase: "preview", can_read_cloud: true };
beforeAll(async () => {
  for (const sql of [
    snapshots,
    hourly,
    devices,
    auth,
    publics,
    social,
    catalog,
  ]) {
    const statements = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .filter((s) => s.trim());
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  const split = rollup
    .trim()
    .replace(/^--.*$/gm, "")
    .split(
      /;\s*(?=CREATE (?:TABLE|TRIGGER|INDEX)|INSERT INTO report_dirty_days SELECT DISTINCT substr\((?:hour_start|bucket_start),1,10\) FROM tokentracker_(?:hourly|account_session_states) WHERE true ON CONFLICT|$)/,
    );
  for (const stmt of split.filter((s) => s.trim()))
    await db.prepare(stmt).run();
  for(const ddl of costSchema.replace(/^--.*$/gm,"").split(";").filter(v=>v.trim())) await env.DB.prepare(ddl).run();
  for (const stmt of moderation.trim().split(/;\s*(?=CREATE |INSERT INTO tokentracker_anticheat|$)/).filter(s=>s.trim())) {
    await db.prepare(stmt).run();
  }
  for (const d of [d1, d2, "revoked", "otherdev"]) {
    await db
      .prepare(
        "INSERT INTO tokentracker_devices(id,user_id,device_name,revoked_at,created_at) VALUES (?,?,?,?,?)",
      )
      .bind(
        d,
        d === "otherdev" ? other : user,
        d,
        d === "revoked" ? t : null,
        t,
      )
      .run();
    await db
      .prepare("INSERT INTO tokentracker_device_machine VALUES (?,?)")
      .bind(d, "cluster")
      .run();
  }
  for (const [d, src, n, at] of [
    [d1, "codex", 10, t],
    [d2, "codex", 20, t],
    [d1, "codex", 6, t2],
    [d1, "cursor", 8, t],
    [d2, "cursor", 7, t],
    ["revoked", "cursor", 11, t],
    ["revoked", "codex", 200, t],
    ["otherdev", "codex", 99, t],
    [d1, "trae-cn", 500, t],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,total_tokens,input_tokens,conversations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(d === "otherdev" ? other : user, d, src, "gpt-5", at, n, n, 2, t, t)
      .run();
  }
  await db
    .prepare(
      "INSERT INTO tokentracker_account_session_states VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(user, "trae-cn", "session", "gpt-5", t, 3, 0, 0, 0, 0, 3, t, t)
    .run();
});

it("groups account observations once across devices, filters revocations and folds the repeated DST hour", async () => {
  const rows = await accountUsage(
    db,
    user,
    null,
    "2026-11-01",
    "2026-11-01",
    "hour",
    reportClock("America/New_York", null),
  );
  expect(rows.map((r) => [r.bucket, r.source, r.total_tokens])).toEqual([
    ["2026-11-01T01:00:00", "codex", 26],
    ["2026-11-01T01:00:00", "cursor", 11],
    ["2026-11-01T01:00:00", "trae-cn", 3],
  ]);
  const selected = await accountUsage(
    db,
    user,
    d1,
    "2026-11-01",
    "2026-11-01",
    "day",
    reportClock(null, null),
  );
  expect(selected.map((r) => r.total_tokens)).toEqual([16, 11, 3]);
});

it("keeps the source pricing table and matching rules in parity", () => {
  const marker = (s: string) =>
    s
      .slice(
        s.indexOf("const MODEL_PRICING:"),
        s.indexOf("interface HourlyRow") > 0
          ? s.indexOf("interface HourlyRow")
          : s.indexOf("export function computeRowCost"),
      )
      .trim();
  expect(marker(workerPricing)).toBe(marker(legacyPricing));
  const fable={bucket:"",source:"codex",model:"claude-fable-5-2",input_tokens:1_000_000,pricing_tier:"peak"} as Parameters<typeof computeRowCost>[0];
  expect(computeRowCost(fable)).toBe(8);
  expect(publicRowCost(fable)).toBe(10);
  expect(
    computeRowCost({
      source: "lmstudio",
      model: "gpt-5",
      input_tokens: 1000,
    } as Parameters<typeof computeRowCost>[0]),
  ).toBe(0);
});

it("serves all account usage representations and enforces older history and membership", async () => {
  const p =
    "?from=2026-11-01&to=2026-11-01&day=2026-11-01&weeks=1&tz=America%2FNew_York";
  for (const kind of [
    "hourly",
    "daily",
    "monthly",
    "summary",
    "model-breakdown",
    "heatmap",
    "devices",
  ]) {
    const res = await accountReport(
      new Request("https://x/" + p),
      db,
      user,
      kind,
      allowed,
    );
    expect(res.status, kind).toBe(200);
    const b = (await res.json()) as any;
    if (["hourly", "daily", "monthly"].includes(kind))
      expect(b.data[0].total_tokens).toBe(40);
    if (kind === "summary") expect(b.totals.total_tokens).toBe(40);
    if (kind === "model-breakdown")
      expect(b.sources.map((s: any) => s.totals.total_tokens)).toEqual([
        26, 11, 3,
      ]);
    if (kind === "heatmap") expect(b.active_days).toBe(1);
    if (kind === "devices")
      expect(b.account_sources).toEqual([
        { source: "cursor", total_tokens: 11 },
        { source: "trae-cn", total_tokens: 3 },
      ]);
  }
  const bad = await accountReport(
    new Request("https://x/?day=2020-01-01"),
    db,
    user,
    "hourly",
    { ...allowed, phase: "active" },
  );
  expect(bad.status).toBe(400);
  expect(
    (
      await accountReport(new Request("https://x/"), db, user, "daily", {
        ...allowed,
        can_read_cloud: false,
      })
    ).status,
  ).toBe(402);
});

it("rejects anonymous private report access, enforces the profile's separate owner-only badge view, and fails closed without the public blocklist", async () => {
  for (const kind of ["account-summary", "account-skills"])
    expect(
      (
        await dispatchReports(
          new Request("https://x/tokentracker-" + kind),
          env,
        )
      )?.status,
    ).toBe(401);
  expect(
    (
      await dispatchReports(
        new Request("https://x/tokentracker-leaderboard"),
        env,
      )
    )?.status,
  ).toBe(503);
  expect(
    (
      await profileReport(
        new Request("https://x/?user_id=" + user + "&view=badges"),
        db,
        null,
        new Set(),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await profileReport(
        new Request("https://x/?user_id=" + user),
        db,
        null,
        new Set(),
      )
    ).status,
  ).toBe(404);
});

it("materializes D1-backed ranking, community and achievements with complete UTC day series", async () => {
  const settings = { DB: db, LEADERBOARD_BLOCKED_USER_IDS: "" };
  const result = await refreshRanking(settings, "total", true);
  expect(result.upserted).toBe(2);
  const res = await dispatchReports(
    new Request(
      "https://x/tokentracker-leaderboard?period=total&user_id=" + user,
    ),
    settings,
  );
  const rank = (await res!.json()) as any;
  expect(rank.entries.map((r: any) => r.total_tokens)).toEqual([99, 40]);
  expect(rank.me.total_tokens).toBe(40);
  await refreshAchievements(db);
  const profile = await profileReport(
    new Request("https://x/?view=badges&user_id=" + user),
    db,
    user,
    new Set(),
  );
  const badges = (await profile.json()) as any;
  expect(badges.badges.find((b: any) => b.id === "podium")).toMatchObject({
    tier: 4,
    metric_value: 2,
    serials: { diamond: 2 },
  });
  const full = await profileReport(
    new Request("https://x/?period=total&user_id=" + user),
    db,
    null,
    new Set(),
  );
  expect(full.status).toBe(200);
  expect(((await full.json()) as any).totals.total_tokens).toBe(40);
  await refreshCommunity(db);
  const snapshot = JSON.parse(
    (await db
      .prepare("SELECT payload FROM community_snapshot")
      .first<string>("payload"))!,
  );
  expect(snapshot.total_tokens).toBe(139);
  expect(snapshot.daily_growth.length).toBe(30);
  expect(snapshot.top_models[0]).toMatchObject({
    name: "gpt-5",
    tokens: 139,
    share: 100,
  });
});


it("runs bounded moderation, preserves reviewed flags and rejects stale reconciliation",async()=>{
  const stamp=new Date().toISOString().replace(/Z$/, "000Z");
  await db.prepare("INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,total_tokens,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(user,d1,"codex","qa-model",stamp,13000000000,stamp,stamp).run();
  const scan=await detectAnomalies(db);
  expect(scan.inserted_excluded).toBe(1);
  expect(scan.breaker_tripped).toBe(false);
  expect(await reconcileQueue(db,"2000-01-01T00:00:00Z")).toBeNull();
  const ts=await db.prepare("SELECT last_queue_changed_at AS ts FROM tokentracker_anticheat_run_state WHERE id=1").first<string>("ts");
  expect((await reconcileQueue(db,ts!))?.ok).toBe(true);
  await db.prepare("UPDATE tokentracker_leaderboard_anomaly_flags SET status='cleared' WHERE user_id=?").bind(user).run();
  expect((await detectAnomalies(db)).inserted_excluded).toBe(0);
  const review=await quarantineAudit(db,new Set([user,other]));
  expect(review).toMatchObject({ok:true,blocked_total:2,blocked_without_flags:1});
  for(let day=1;day<=4;day++) {
    const key="2020-01-0"+day;
    await db.prepare("INSERT INTO tokentracker_leaderboard_snapshots(user_id,period,from_day,to_day,rank,generated_at) VALUES (?,'month','2019-01-01',?,1,?)")
      .bind(user,key,stamp).run();
  }
  expect((await pruneSnapshots(db)).meta.changes).toBe(1);
});

it("matches recorded, partial, explicit zero, allocated and legacy costs across all five consumers",async()=>{
  const who="cost-reader", dev="cost-reader-laptop";
  await db.prepare("INSERT INTO tokentracker_devices(id,user_id,device_name,created_at) VALUES(?,?,?,?)").bind(dev,who,"cost",t).run();
  const zeros={input_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0,reasoning_output_tokens:0};
  const proof=(n:number,missing:number,allocated=false)=>({version:1,reported_usd:n,reported_events:1,missing_events:missing>0?1:0,
    allocated_events:allocated?1:0,origins:[allocated?"grok_allocated":"grok_usd"],unreported_tokens:{...zeros,input_tokens:missing}});
  const rows=[
    ["grok","grok-4.7",1_000_000,1.25,proof(1.25,500_000),"mixed",2.25],
    ["grok","grok-4.7:batch",1_000_000,0.12,proof(0.12,300_000),"mixed",0.12],
    ["grok","grok-4.7-flex",100,0.15,proof(0.15,0,true),"allocated",0.15],
    ["grok","legacy",15,0.03,null,"provider_reported",0.03],
    ["grok","grok-build-free",15,99.95,proof(99.95,0),"model_pricing",0],
    ["cursor","grok-bot-reported",20,0.4,{...proof(0.4,0),origins:["cursor_csv_cost"]},"provider_reported",0.4],
    ["cursor","grok-bot-zero",20,0,{...proof(0,0),origins:["cursor_total_cents"]},"provider_reported",0],
    ["cursor","grok-bot-opaque",20,1.15,null,"unpriced",0]
  ] as const;
  const day=new Date().toISOString().slice(0,10),hour=day+"T02:00:00.000000Z";
  for(const [src,model,input,usd,cov] of rows) await db.prepare(
    "INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,total_tokens,input_tokens,total_cost_usd,cost_coverage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(who,dev,src,model,hour,input,input,String(usd),cov?JSON.stringify(cov):null,t,t).run();
  const r=(k:string)=>accountReport(new Request("https://x/?from="+day+"&to="+day),db,who,k,allowed);
  const breakdown=await (await r("model-breakdown")).json() as any;
  for(const [source,model,,,,label,cost] of rows) {
    const m=breakdown.sources.find((v:any)=>v.source===source).models.find((v:any)=>v.model===model);
    expect(m.cost_source,model).toBe(label);expect(Number(m.totals.total_cost_usd),model).toBeCloseTo(cost,8);
    if(label==="allocated")expect(m.has_allocated_cost).toBe(true);
  }
  const expected=rows.reduce((sum,x)=>sum+x[6],0);
  expect(Number(((await (await r("daily")).json()) as any).data[0].total_cost_usd)).toBeCloseTo(expected);
  expect(Number(((await (await r("summary")).json()) as any).totals.total_cost_usd)).toBeCloseTo(expected);
  const e={DB:db,LEADERBOARD_BLOCKED_USER_IDS:""};
  await refreshRanking(e,"total",true);
  const snapshot=()=>db.prepare("SELECT estimated_cost_usd FROM tokentracker_leaderboard_snapshots WHERE user_id=? AND period='total' ORDER BY generated_at DESC LIMIT 1").bind(who).first<string>("estimated_cost_usd");
  expect(Number(await snapshot())).toBeCloseTo(expected,2);
  const profile=await profileReport(new Request("https://x/?period=week&user_id="+who),db,null,new Set());
  expect(Number((await profile.json() as any).totals.estimated_cost_usd)).toBeCloseTo(expected,8);
  // A restored pre-migration rollup can acquire evidence only from the matching token basis.
  await db.prepare("UPDATE tokentracker_leaderboard_rollup_daily_v2 SET cost_provenance=NULL WHERE user_id=?").bind(who).run();
  await refreshRanking(e,"total",true);
  expect(Number(await snapshot())).toBeCloseTo(expected,2);
  await db.prepare("UPDATE tokentracker_leaderboard_rollup_daily_v2 SET cost_provenance=NULL,input_tokens=input_tokens+1 WHERE user_id=? AND model='grok-4.7'").bind(who).run();
  await expect(refreshRanking(e,"total",true)).rejects.toThrow("cost basis unavailable");
  expect(Number(await snapshot())).toBeCloseTo(expected,2);
});

it("rejects equal-ranked conflicting recorded costs for an account-level source and preserves the published ranking",async()=>{
  const u="tie-cursor-user",day=new Date().toISOString().slice(0,10),hour=day+"T00:00:00.000000Z";
  const unreported_tokens={input_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0,reasoning_output_tokens:0};
  for (const [device,usd] of [["tie-laptop-a",0.2],["tie-laptop-b",0.3]] as const){
    await db.prepare("INSERT INTO tokentracker_devices(id,user_id,device_name,created_at) VALUES(?,?,?,?)").bind(device,u,device,t).run();
    const cov={version:1,reported_usd:usd,reported_events:1,missing_events:0,allocated_events:0,origins:["cursor_csv_cost"],unreported_tokens};
    await db.prepare("INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,total_tokens,input_tokens,total_cost_usd,cost_coverage,created_at,updated_at) VALUES(?,?,'cursor','grok-bot-x',?,5,5,?,?,?,?)")
      .bind(u,device,hour,String(usd),JSON.stringify(cov),t,t).run();
  }
  const req=new Request("https://x/?from="+day+"&to="+day);
  await expect(accountReport(req,db,u,"daily",allowed)).rejects.toThrow("Cost provenance inventory unavailable");
  const count=()=>db.prepare("SELECT count(*) AS n FROM tokentracker_leaderboard_snapshots").first<number>("n");
  const baseline=await count();
  await expect(refreshRanking({DB:db,LEADERBOARD_BLOCKED_USER_IDS:""},"week",true)).rejects.toThrow();
  expect(await count()).toBe(baseline);
  const noCost=await accountReport(req,db,u,"monthly",allowed);
  expect(noCost.status).toBe(200);
});

it("folds source flags across days within a pricing tier before assigning the model label",async()=>{
  const u="cost-days-user",d="cost-days-device";
  await db.prepare("INSERT INTO tokentracker_devices(id,user_id,device_name,created_at) VALUES(?,?,?,?)").bind(d,u,d,t).run();
  for (const [day,allocated] of [["2026-11-01",false],["2026-11-02",true]] as const){
    const cov={version:1,reported_usd:0.12,reported_events:1,missing_events:0,allocated_events:allocated?1:0,
      origins:[allocated?"grok_allocated":"grok_usd"],unreported_tokens:{input_tokens:0,cached_input_tokens:0,cache_creation_input_tokens:0,output_tokens:0,reasoning_output_tokens:0}};
    await db.prepare("INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,total_tokens,input_tokens,total_cost_usd,cost_coverage,created_at,updated_at) VALUES(?,?,'grok','grok-4.7',?,10,10,'0.12',?,?,?)")
       .bind(u,d,day+"T01:00:00.000000Z",JSON.stringify(cov),t,t).run();
  }
  const res=await accountReport(new Request("https://x/?from=2026-11-01&to=2026-11-02"),db,u,"model-breakdown",allowed);
  const obj=await res.json() as any;
  expect(obj.sources[0].models[0]).toMatchObject({cost_source:"allocated",has_allocated_cost:true,totals:{total_cost_usd:"0.240000"}});
});
