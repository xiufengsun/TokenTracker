"use strict";

// User device renames must survive token issuance (issue: rename reverted to
// the default name on every 12h dashboard token rotation / CLI re-login).
// The `name_customized` flag is set by the rename endpoint; every edge write
// that refreshes device_name from a client-computed default must skip rows
// where the user customized the name.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const MIGRATION = "migrations/20260719145649_add-device-name-customized.sql";
const readMigrationBySuffix = (suffix) => {
  const file = fs.readdirSync(path.join(ROOT, "migrations"))
    .find((name) => name.endsWith(`_${suffix}.sql`));
  assert.ok(file, `missing migration ending in _${suffix}.sql`);
  return read(`migrations/${file}`);
};

async function loadIssuer(file, exported = "") {
  const access = read("dashboard/edge-patches/cloud/access.ts")
    .replace(/^import type .*;$/m, "").replaceAll("export ", "");
  const source = read(`dashboard/edge-patches/${file}.ts`)
    .replace('import { createClient } from "npm:@insforge/sdk";',
      "const createClient = () => globalThis.__edgeTestClient;")
    .replace('import { cloudRpc, cloudFailure } from "./cloud/access.ts";', access)
    .concat(exported);
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("migration adds the name_customized column and backfills renamed rows", () => {
  const source = read(MIGRATION);
  assert.match(
    source,
    /ADD COLUMN IF NOT EXISTS name_customized boolean NOT NULL DEFAULT false/u,
    "devices table must gain the name_customized flag",
  );
  assert.match(
    source,
    /ADD COLUMN IF NOT EXISTS default_device_name text/u,
    "devices table must gain default_device_name so renamed legacy rows stay adoptable",
  );
  assert.match(
    source,
    /SET name_customized = true\s*\nWHERE revoked_at IS NULL/u,
    "backfill must be scoped to active rows — revoked devices never receive keep-fresh writes",
  );
});

test("rename endpoint marks the device name as user-customized", () => {
  const source = read("dashboard/edge-patches/tokentracker-device-rename.ts");
  assert.match(
    source,
    /\{ device_name: name, name_customized: true, default_device_name: priorName \}/u,
    "rename must set name_customized and preserve the pre-rename client default",
  );
  assert.match(
    source,
    /: \{ device_name: name, name_customized: true \}/u,
    "repeated renames must not overwrite the captured default with a custom name",
  );
  assert.match(
    source,
    /\.select\("id, device_name, name_customized"\)/u,
    "rename must read the row's prior state to know whether to capture the default name",
  );
});

test("rename endpoint survives being deployed before the migration", () => {
  const source = read("dashboard/edge-patches/tokentracker-device-rename.ts");
  assert.match(
    source,
    /\/name_customized\|default_device_name\/i\.test\(error\.message/u,
    "rename must fall back to the legacy update when the columns are missing (deploy-order safety net)",
  );
});

test("both issuance edges delegate identity refresh and admission to the atomic quota RPC", () => {
  for (const file of ["tokentracker-device-token-issue", "tokentracker-device-flow-poll"]) {
    const source = read(`dashboard/edge-patches/${file}.ts`);
    assert.match(source, /cloudRpc\([\s\S]*?"cloud_issue_device_token"/u);
    assert.doesNotMatch(source, /\.from\("tokentracker_devices"\)/u);
  }
  const source = read("migrations/20261004120000_cloud-machine-access.sql");
  assert.match(source, /PERFORM public\.refresh_tokentracker_device_identity\(p_user_id,v_device\.id,p_device_name,p_platform\)/u);
  assert.match(source, /device_name=CASE WHEN name_customized THEN device_name ELSE p_device_name END/u);
});

test("device identity refresh merges a matching legacy row without losing usage or custom names", () => {
  const source = readMigrationBySuffix("harden-backend-concurrency");
  assert.match(source, /CREATE OR REPLACE FUNCTION public\.refresh_tokentracker_device_identity/u);
  assert.match(
    source,
    /SELECT d\.device_name, d\.name_customized[\s\S]{0,400}FOR UPDATE/u,
    "refresh must lock the machine-anchored row and read customization state",
  );
  assert.match(
    source,
    /legacy\.machine_id IS NULL[\s\S]{0,400}legacy\.device_name = p_device_name/u,
    "only the active machine-id-less row owning the client default may be merged",
  );
  assert.match(source, /INSERT INTO public\.tokentracker_hourly AS canonical/u);
  assert.match(
    source,
    /ORDER BY h\.total_tokens DESC, h\.updated_at DESC/u,
    "whole-row canonicalization must keep the most complete snapshot",
  );
  assert.match(source, /ON CONFLICT \(user_id, device_id, source, model, hour_start\) DO UPDATE/u);
  assert.match(
    source,
    /UPDATE public\.tokentracker_device_tokens[\s\S]{0,120}SET device_id = p_device_id/u,
    "existing legacy tokens must continue syncing into the canonical device",
  );
  assert.match(
    source,
    /UPDATE public\.tokentracker_devices[\s\S]{0,160}SET revoked_at = clock_timestamp\(\)/u,
    "the merged legacy row must leave the active aggregation set",
  );
  assert.match(
    source,
    /WHEN v_name_customized THEN v_current_name[\s\S]{0,120}WHEN COALESCE\(v_legacy_name_customized, false\) THEN v_legacy_name/u,
    "the canonical custom name wins, otherwise a custom legacy name is transferred",
  );
  assert.match(
    source,
    /EXCEPTION WHEN unique_violation THEN/u,
    "a concurrent legacy insert must be absorbed instead of escaping as a database error",
  );
  assert.match(
    source,
    /CREATE TABLE public\.tt_hourly_conflict_backup_20260719 AS/u,
    "the one-time production rewrite must keep a recoverable hourly snapshot",
  );
  assert.match(
    source,
    /RAISE EXCEPTION 'device identity convergence failed whole-row canonicalization'/u,
    "the migration must roll back instead of committing a lossy merge",
  );
  assert.match(source, /REVOKE ALL ON FUNCTION public\.refresh_tokentracker_device_identity/u);
});

test("shared SQL adoption retains renamed defaults and stable same-hostname suffixes", () => {
  const source = read("migrations/20261004120000_cloud-machine-access.sql");
  assert.match(source, /device_name=ANY\(p_legacy_names\) OR default_device_name=ANY\(p_legacy_names\)/u);
  assert.match(source, /left\(p_device_name,116\) \|\| ' #' \|\| left\(coalesce\(p_machine_id,p_token_id::text\),8\)/u);
  assert.match(source, /EXCEPTION WHEN unique_violation THEN[\s\S]*?SET machine_id=p_machine_id WHERE id=v_device\.id/u);
});

test("CLI flow forwards current hostname and every generated legacy name to the shared transaction", async () => {
  const { testIssueDeviceToken } = await loadIssuer("tokentracker-device-flow-poll", "\nexport { issueDeviceToken as testIssueDeviceToken };\n");
  const calls = [];
  const client = { database: { rpc: async (name,args) => {
    calls.push({name,args}); return {data:{ok:true,device_id:"device-1"},error:null};
  } } };
  const previousDeno=globalThis.Deno;
  globalThis.Deno={env:{get:()=>undefined}};
  try {
    await testIssueDeviceToken(client,"user-1","darwin-arm64 MacBook-Pro.local","a".repeat(64),"code-1");
    await testIssueDeviceToken(client,"user-1","darwin-arm64","c".repeat(64),"code-2");
  } finally { globalThis.Deno=previousDeno; }
  assert.equal(calls[0].name,"cloud_issue_device_token");
  assert.equal(calls[0].args.p_device_name,"MacBook-Pro.local");
  assert.deepEqual(calls[0].args.p_legacy_names,["MacBook-Pro.local","TokenTracker CLI (darwin-arm64 MacBook-Pro.local) #aaaaaaaa","TokenTracker CLI (darwin-arm64 MacBook-Pro.local)"]);
  assert.equal(calls[0].args.p_device_code,"code-1");
  assert.equal(calls[0].args.p_environment,"live");
  assert.equal(calls[1].args.p_device_name,"TokenTracker CLI (darwin-arm64) #cccccccc");
});

test("dashboard issuance forwards its legacy labels and preserves structured admission denials",async()=>{
  const {default:handler}=await loadIssuer("tokentracker-device-token-issue");
  let args;
  const previousDeno=globalThis.Deno,previousClient=globalThis.__edgeTestClient;
  globalThis.Deno={env:{get:name=>({INSFORGE_BASE_URL:"https://cloud.example",INSFORGE_SERVICE_ROLE_KEY:"admin",INSFORGE_ANON_KEY:"anon"})[name]}};
  globalThis.__edgeTestClient={database:{rpc:async(_,values)=>{
    args=values;return {data:{ok:false,code:"cloud_machine_paused",status:403,recovery_url:"https://www.tokentracker.cc/cloud"},error:null};
  }}};
  try {
    const response=await handler(new Request("https://cloud.example/functions/issue",{method:"POST",headers:{Authorization:"Bearer admin"},
      body:JSON.stringify({user_id:"user-1",device_name:"Office desktop",platform:"desktop",machine_id:"b".repeat(64)})}));
    assert.equal(response.status,403);assert.equal((await response.json()).code,"cloud_machine_paused");
    assert.deepEqual(args.p_legacy_names,["Office desktop","Token Tracker (dashboard) #bbbbbbbb","Token Tracker (dashboard)","Token Tracker"]);
  } finally {globalThis.Deno=previousDeno;globalThis.__edgeTestClient=previousClient;}
});

test("current-device labels react to the first completed cloud sync", () => {
  const dashboardPage = read("dashboard/src/pages/DashboardPage.jsx");
  assert.match(
    dashboardPage,
    /window\.addEventListener\(CLOUD_USAGE_SYNCED_EVENT, refreshCurrentDevice\)/u,
    "the current-device ID must refresh in the same tab after the first successful sync",
  );
  assert.match(
    dashboardPage,
    /setCurrentDeviceId\(getCurrentDeviceId\(\)\)/u,
    "the sync listener must re-read the newly issued device ID",
  );
});
