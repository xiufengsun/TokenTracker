import type { BillingEnvironment } from "./billing-membership";
import {
  atomic,
  DeviceFailure,
  digest,
  limited,
  machines,
  membership,
} from "./device-store";

import {uploadCostCoverage} from "./report-cost-provenance";

type Item = Record<string, unknown>;
const tokenColumns = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;
const bucketCounters = [
  ...tokenColumns,
  "billable_total_tokens",
  "conversations",
] as const;

function timestamp(value: unknown): string {
  const str = String(value ?? "");
  const time = Date.parse(str);
  if (!Number.isFinite(time))
    throw new DeviceFailure(400, "invalid_upload_timestamp");
  // Persist in the migration's fixed-width UTC format, including sub-millisecond precision.
  const micros = str.match(/\.\d{3}(\d{1,3})/)?.[1]?.padEnd(3, "0") || "000";
  return new Date(time).toISOString().replace("Z", micros + "Z");
}
function natural(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new DeviceFailure(400, "invalid_token_count");
  return n;
}
function item(value: unknown): Item {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeviceFailure(400, "invalid_usage_row");
  return value as Item;
}
function buckets(input: unknown[], coverageV1: boolean) {
  const rows = new Map<
    string,
    Item & { total_tokens: number; conversations: number }
  >();
  for (const value of input) {
    const b = item(value);
    const hour_start = timestamp(b.hour_start),
      model = b.model || "unknown",
      source = b.source || "unknown";
    if (typeof source !== "string" || typeof model !== "string")
      throw new DeviceFailure(400, "invalid_usage_row");
    const counters = Object.fromEntries(
      tokenColumns.map((k) => [k, natural(b[k] ?? 0)]),
    );
    const cost = Number(b.total_cost_usd ?? 0);
    if (!Number.isFinite(cost) || cost < 0)
      throw new DeviceFailure(400, "invalid_usage_cost");
    let coverage:Record<string,unknown>|null=null;
    if (b.cost_coverage != null) {
      if (!coverageV1) throw new DeviceFailure(400,"Cost coverage v1 acknowledgement required");
      try { coverage=uploadCostCoverage(b.cost_coverage,{...b,source,model,total_cost_usd:cost}); }
      catch { throw new DeviceFailure(400,"Invalid cost coverage"); }
    }
    const row = {
      hour_start,
      source,
      model,
      ...counters,
      total_tokens: counters.total_tokens,
      billable_total_tokens: natural(b.billable_total_tokens ?? 0),
      conversations: natural(b.conversation_count ?? b.conversations ?? 0),
      total_cost_usd: String(cost),
      cost_coverage: coverage,
    };
    const key = JSON.stringify([hour_start, source, model]);
    const prev = rows.get(key);
    if (
      !prev ||
      row.total_tokens > prev.total_tokens ||
      (row.total_tokens === prev.total_tokens &&
        row.conversations >= prev.conversations)
    )
      rows.set(key, row);
  }
  return Array.from(rows.values());
}
function sessionStates(input: unknown[]) {
  const states = new Map<string, Item>();
  for (const value of input) {
    const b = item(value);
    const source = String(b.source ?? "")
        .trim()
        .toLowerCase(),
      model = String(b.model ?? "").trim();
    const session_id = String(b.session_id ?? "").trim();
    if (
      source !== "trae-cn" ||
      typeof b.model !== "string" ||
      typeof b.session_id !== "string" ||
      !model ||
      model.length > 200 ||
      !session_id ||
      session_id.length > 256
    )
      throw new DeviceFailure(400, "Invalid account session state");
    const counters = Object.fromEntries(
      tokenColumns.map((k) => [k, natural(b[k])]),
    );
    if (
      counters.total_tokens !==
      counters.input_tokens +
        counters.cached_input_tokens +
        counters.cache_creation_input_tokens +
        counters.output_tokens
    ) {
      throw new DeviceFailure(400, "Invalid account session state");
    }
    states.set(session_id, {
      source,
      model,
      session_id,
      ...counters,
      bucket_start: timestamp(b.bucket_start),
      snapshot_verified_at: timestamp(b.snapshot_verified_at),
    });
  }
  return Array.from(states.values());
}

export async function ingest(
  req: Request,
  db: D1Database,
  environment: BillingEnvironment,
  blocked: Set<string>,
) {
  const match = /^Bearer\s+(\S+)$/i.exec(
    req.headers.get("Authorization") || "",
  );
  if (!match) throw new DeviceFailure(401, "Missing bearer token");
  if (Number(req.headers.get("Content-Length")) > 1_048_576)
    throw new DeviceFailure(413, "Upload too large");
  const text = await req.text();
  if (new TextEncoder().encode(text).length > 1_048_576)
    throw new DeviceFailure(413, "Upload too large");
  let body: Item;
  try {
    body = item(JSON.parse(text));
  } catch {
    throw new DeviceFailure(400, "Invalid JSON body");
  }
  const input = Array.isArray(body.buckets)
    ? body.buckets
    : Array.isArray(body.hourly)
      ? body.hourly
      : [];
  const stateInput = Array.isArray(body.account_session_states)
    ? body.account_session_states
    : [];
  const uploadId =
    typeof body.upload_id === "string" &&
    /^[0-9a-f-]{36}$/i.test(body.upload_id)
      ? body.upload_id
      : null;
  const hash = await digest(match[1]);
  return atomic(db, async (tx) => {
    const [token] = await tx.rows<{
      id: string;
      user_id: string;
      device_id: string;
      cloud_environment: string;
    }>(
      ["id", "user_id", "device_id", "cloud_environment"],
      "SELECT * FROM tokentracker_device_tokens WHERE token_hash=? AND revoked_at IS NULL",
      hash,
    );
    if (!token) throw new DeviceFailure(401, "Unauthorized");
    if (token.cloud_environment !== environment)
      throw new DeviceFailure(401, "cloud_environment_mismatch");
    const uid = token.user_id,
      did = token.device_id;
    if (blocked.has(uid)) throw new DeviceFailure(403, "Account blocked");
    if (body.kind==="cost_capabilities") {
      try {
        // Parsing the column names checks that both storage and aggregation migrations are installed.
        await db.prepare("SELECT cost_coverage FROM tokentracker_hourly LIMIT 0").all();
        await db.prepare("SELECT cost_provenance FROM tokentracker_leaderboard_rollup_daily_v2 LIMIT 0").all();
      } catch { throw new DeviceFailure(503,"cloud_cost_coverage_unavailable"); }
      return {cost_coverage_versions:[1]};
    }
    if (body.cost_coverage_version!==undefined && body.cost_coverage_version!==1) throw new DeviceFailure(400,"Unsupported cost coverage version");
    if (input.length > 500 || stateInput.length > 500)
      throw new DeviceFailure(400, "Too many usage records (max 500 per type)");
    if (!input.length && !stateInput.length)
      throw new DeviceFailure(400, "No usage buckets provided");
    const rows = buckets(input, body.cost_coverage_version===1),
      states = sessionStates(stateInput);
    const [group, member] = await Promise.all([
      machines(tx, uid, environment),
      membership(tx, uid, environment),
    ]);
    const device = group.devices.find((d) => d.id === did);
    if (!device) throw new DeviceFailure(403, "cloud_device_revoked");
    const slot = group.slots.find(
      (s) => s.id === group.slotByAlias.get("device:" + did),
    );
    if (!slot || slot.status !== "active")
      throw new DeviceFailure(403, "cloud_machine_paused", {
        membership: member,
      });
    limited(
      member,
      group.slots.filter((s) => s.status === "active").length,
      false,
    );
    // Concurrent continuations share the same admission decision up to the cap. Validate
    // eligibility again inside the D1 write batch and increment the counter atomically.
    const [stored] = await tx.rows<{last_upload_at: string | null; continuation: number}>(
      ["last_upload_at", "continuation"],
      `SELECT last_upload_at, COALESCE(julianday(upload_window_until) > julianday('now')
         AND upload_token_id=? AND upload_id IS ? AND upload_batch_count < ?, 0) AS continuation
       FROM tokentracker_cloud_machines WHERE user_id=? AND environment=? AND id=?`,
      token.id, uploadId, member.can_upload_cloud ? 100 : 10, uid, environment, slot.id,
    );
    const now = Date.now(),
      utc = timestamp(new Date(now).toISOString());
    const next = (at: number) =>
      member.can_upload_cloud
        ? at + member.sync_interval_seconds * 1000
        : (Math.floor(at / 86_400_000) + 1) * 86_400_000;
    const last = stored?.last_upload_at ? Date.parse(stored.last_upload_at) : 0;
    const continuation = Boolean(stored?.continuation);
    if (member.phase === "active" && last && next(last) > now && !continuation)
      throw new DeviceFailure(429, "cloud_sync_throttled", {
        membership: member,
        next_allowed_at: new Date(next(last)).toISOString(),
        retry_after_seconds: Math.ceil((next(last) - now) / 1000),
        recovery_url: "https://www.tokentracker.cc/cloud",
      });
    if (rows.length) {
      const columns = [
        "hour_start",
        "source",
        "model",
        ...bucketCounters,
        "total_cost_usd",
        "cost_coverage",
      ];
      tx.write(
        `INSERT INTO tokentracker_hourly(user_id,device_id,${columns},created_at,updated_at)
        SELECT ?,?,${columns.map((c) => `json_extract(value,'$.${c}')`)},?,? FROM json_each(?) WHERE 1
        ON CONFLICT(user_id,device_id,source,model,hour_start) DO UPDATE SET
        ${[...bucketCounters, "total_cost_usd", "cost_coverage", "updated_at"].map((c) => c + "=excluded." + c)}`,
        uid,
        did,
        utc,
        utc,
        JSON.stringify(rows),
      );
    }
    if (states.length) {
      const columns = [
        "source",
        "session_id",
        "model",
        "bucket_start",
        "snapshot_verified_at",
        ...tokenColumns,
      ];
      tx.write(
        `INSERT INTO tokentracker_account_session_states(user_id,${columns},updated_at)
        SELECT ?,${columns.map((c) => `json_extract(value,'$.${c}')`)},? FROM json_each(?) WHERE 1
        ON CONFLICT(user_id,source,session_id) DO UPDATE SET
        ${columns.slice(2).map((c) => c + "=excluded." + c)},updated_at=excluded.updated_at
        WHERE excluded.snapshot_verified_at>tokentracker_account_session_states.snapshot_verified_at`,
        uid,
        utc,
        JSON.stringify(states),
      );
    }
    if (continuation) {
      tx.write(
        "UPDATE tokentracker_cloud_machines SET last_seen_at=max(coalesce(last_seen_at,''),?), upload_batch_count=upload_batch_count+1 WHERE id=?",
        utc,
        slot.id,
      );
    } else {
      tx.write(
        "UPDATE tokentracker_cloud_machines SET last_seen_at=?, last_upload_at=?, upload_window_until=?, upload_token_id=?, upload_id=?, upload_batch_count=1 WHERE id=?",
        utc,
        utc,
        new Date(now + 120_000).toISOString(),
        token.id,
        uploadId,
        slot.id,
      );
    }
    return {
      ok: true,
      inserted: rows.length,
      ...(body.cost_coverage_version===1?{cost_coverage_version:1}:{}),
      skipped: 0,
      membership: member,
      upload_scope: member.can_upload_cloud ? "cloud" : "community",
      next_allowed_at:
        member.phase === "active"
          ? new Date(next(continuation ? last : now)).toISOString()
          : null,
      sync_interval_seconds:
        member.phase === "active" ? member.sync_interval_seconds : null,
    };
  });
}
