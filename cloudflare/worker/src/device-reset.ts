import { rollupInsertSql } from "./report-refresh";
import { getAccountId, type AuthEnv } from "./auth";
import type { BillingEnvironment } from "./billing-membership";
import {
  atomic,
  DeviceFailure,
  DeviceWrite,
  digest,
  machines,
} from "./device-store";

type Operation = {
  operation_id: string;
  user_id: string;
  environment: string;
  device_id: string;
  machine_id: string;
  status: "reset" | "complete";
  removed_rows: number;
  reset_at: string;
  affected_days: string;
};
const operationFields =
  "operation_id user_id environment device_id machine_id status removed_rows reset_at affected_days".split(
    " ",
  );
const uuid = (s: unknown): string => {
  if (
    typeof s !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s)
  ) {
    throw new DeviceFailure(400, "cloud_usage_reset_invalid_request");
  }
  return s.toLowerCase();
};
async function current(tx: DeviceWrite, id: string) {
  const [op] = await tx.rows<Operation>(
    operationFields,
    "SELECT * FROM tokentracker_cloud_usage_resets WHERE operation_id=?",
    id,
  );
  return op;
}
function result(op: Operation) {
  return {
    ok: true,
    operation_id: op.operation_id,
    device_id: op.device_id,
    machine_id: op.machine_id,
    status: op.status,
    removed_rows: op.removed_rows,
  };
}
async function supported(tx: DeviceWrite) {
  const schema = await tx.rows<{ name: string }>(
    ["name"],
    `SELECT name FROM sqlite_schema WHERE name IN
  ('tokentracker_usage_archive_manifest','tokentracker_usage_archive_generations','tokentracker_leaderboard_rollup_daily_v2',
  'report_dirty_days','tokentracker_leaderboard_rollup_total_v2','tokentracker_account_usage_cache','tt_device_reset_guard_insert','tt_device_reset_guard_update')
  ORDER BY name`,
  );
  const names = schema.map((s) => s.name);
  if (names.some((n) => n.startsWith("tokentracker_usage_archive")))
    throw new DeviceFailure(409, "cloud_usage_reset_archive_unsupported");
  if (
    names.length !== 4 ||
    !names.includes("tokentracker_leaderboard_rollup_daily_v2") ||
    !names.includes("report_dirty_days") ||
    !names.includes("tt_device_reset_guard_insert") ||
    !names.includes("tt_device_reset_guard_update")
  ) {
    throw new DeviceFailure(503, "cloud_usage_reset_rollup_unavailable");
  }
}
function rebuild(tx: DeviceWrite, uid: string, days: string[]) {
  if (days.length) {
    const ordered = Array.from(new Set(days)).sort();
    const encoded = JSON.stringify(ordered);
    tx.write(
      "DELETE FROM tokentracker_leaderboard_rollup_daily_v2 WHERE user_id=? AND day IN (SELECT value FROM json_each(?))",
      uid,
      encoded,
    );
    const from = ordered[0] + "T00:00:00.000000Z";
    const end = new Date(
      Date.parse(ordered[ordered.length - 1] + "T00:00:00Z") + 86400000,
    )
      .toISOString()
      .replace(".000Z", ".000000Z");
    tx.write(
      rollupInsertSql("?1", "?2", "?3", "SELECT value FROM json_each(?4)"),
      from,
      end,
      uid,
      encoded,
    );
  }
  tx.write(
    "DELETE FROM tokentracker_leaderboard_snapshots WHERE user_id=?",
    uid,
  );
}

async function scope(
  tx: DeviceWrite,
  uid: string,
  environment: BillingEnvironment,
  did: string,
) {
  const group = await machines(tx, uid, environment);
  if (!group.devices.some((d) => d.id === did))
    throw new DeviceFailure(404, "cloud_device_not_found");
  const slot = group.slots.find(
    (s) =>
      s.id === group.slotByAlias.get("device:" + did) && s.status === "active",
  );
  if (!slot) throw new DeviceFailure(403, "cloud_machine_paused");
  const ids = Array.from(group.slotByAlias)
    .filter(([key, id]) => id === slot.id && key.startsWith("device:"))
    .map(([k]) => k.slice(7))
    .sort();
  const encoded = JSON.stringify(ids);
  const [other] = await tx.rows<{ id: string }>(
    ["id"],
    `SELECT id FROM tokentracker_device_tokens WHERE user_id=? AND
    device_id IN (SELECT value FROM json_each(?)) AND cloud_environment<>? LIMIT 1`,
    uid,
    encoded,
    environment,
  );
  if (other)
    throw new DeviceFailure(409, "cloud_usage_reset_environment_conflict");
  return { slot, encoded };
}

export async function deviceReset(
  req: Request,
  env: AuthEnv,
  environment: BillingEnvironment,
  body: Record<string, unknown>,
) {
  const opId = uuid(body.operation_id);
  if (body.action === "reset") {
    const uid = await getAccountId(req, env);
    if (!uid) throw new DeviceFailure(401, "Unauthorized");
    const did = uuid(body.device_id);
    return atomic(env.DB, async (tx) => {
      const prior = await current(tx, opId);
      if (prior) {
        if (
          prior.user_id !== uid ||
          prior.environment !== environment ||
          prior.device_id !== did
        )
          throw new DeviceFailure(409, "cloud_usage_reset_operation_conflict");
        return result(prior);
      }
      await supported(tx);
      const { slot, encoded } = await scope(tx, uid, environment, did);
      const [busy] = await tx.rows<{ operation_id: string }>(
        ["operation_id"],
        "SELECT * FROM tokentracker_cloud_usage_resets WHERE user_id=? AND environment=? AND machine_id=? AND status='reset'",
        uid,
        environment,
        slot.id,
      );
      if (busy) throw new DeviceFailure(409, "cloud_usage_reset_in_progress");
      const owned =
        "user_id=? AND device_id IN (SELECT value FROM json_each(?))";
      const days = await tx.rows<{ day: string; total: number }>(
        ["day", "total"],
        "SELECT substr(hour_start,1,10) AS day,count(*) AS total FROM tokentracker_hourly WHERE " +
          owned +
          " GROUP BY day ORDER BY day",
        uid,
        encoded,
      );
      const removed = days.reduce((n, r) => n + r.total, 0),
        now = new Date().toISOString();
      tx.write(
        "UPDATE tokentracker_device_tokens SET revoked_at=? WHERE " +
          owned +
          " AND cloud_environment=? AND revoked_at IS NULL",
        now,
        uid,
        encoded,
        environment,
      );
      tx.write("DELETE FROM tokentracker_hourly WHERE " + owned, uid, encoded);
      tx.write(
        "UPDATE tokentracker_cloud_machines SET last_upload_at=NULL,upload_window_until=NULL,upload_token_id=NULL,upload_id=NULL,upload_batch_count=0 WHERE user_id=? AND environment=? AND id=?",
        uid,
        environment,
        slot.id,
      );
      tx.write(
        `INSERT INTO tokentracker_cloud_usage_resets(operation_id,user_id,environment,device_id,machine_id,device_ids,affected_days,removed_rows,status,reset_at)
        VALUES(?,?,?,?,?,?,?,?,'reset',?)`,
        opId,
        uid,
        environment,
        did,
        slot.id,
        encoded,
        JSON.stringify(days.map((r) => r.day)),
        removed,
        now,
      );
      rebuild(
        tx,
        uid,
        days.map((r) => r.day),
      );
      return {
        ok: true,
        operation_id: opId,
        device_id: did,
        machine_id: slot.id,
        status: "reset",
        removed_rows: removed,
      };
    });
  }
  if (body.action !== "refresh")
    throw new DeviceFailure(400, "cloud_usage_reset_invalid_request");
  const token = /^Bearer\s+([^\s.]{1,2048})$/i.exec(
    req.headers.get("Authorization") || "",
  )?.[1];
  if (!token) throw new DeviceFailure(401, "cloud_device_token_rejected");
  const hash = await digest(token);
  return atomic(env.DB, async (tx) => {
    const [issued] = await tx.rows<{
      user_id: string;
      device_id: string;
      created_at: string;
    }>(
      ["user_id", "device_id", "created_at"],
      "SELECT * FROM tokentracker_device_tokens WHERE token_hash=? AND cloud_environment=? AND revoked_at IS NULL",
      hash,
      environment,
    );
    if (!issued) throw new DeviceFailure(401, "cloud_device_token_rejected");
    const uid = issued.user_id;
    const op = await current(tx, opId);
    if (!op || op.user_id !== uid || op.environment !== environment)
      throw new DeviceFailure(404, "cloud_usage_reset_operation_not_found");
    const { slot, encoded } = await scope(
      tx,
      uid,
      environment,
      issued.device_id,
    );
    if (
      slot.id !== op.machine_id ||
      Date.parse(issued.created_at) < Date.parse(op.reset_at)
    )
      throw new DeviceFailure(403, "cloud_usage_reset_device_mismatch");
    if (op.status === "complete") return result(op);
    await supported(tx);
    const currentDays = await tx.rows<{ day: string }>(
      ["day"],
      `SELECT DISTINCT substr(hour_start,1,10) AS day FROM tokentracker_hourly
      WHERE user_id=? AND device_id IN (SELECT value FROM json_each(?)) ORDER BY day`,
      uid,
      encoded,
    );
    const days = Array.from(
      new Set<string>([
        ...JSON.parse(op.affected_days),
        ...currentDays.map((r) => r.day),
      ]),
    ).sort();
    tx.write(
      "UPDATE tokentracker_cloud_usage_resets SET completed_at=?,status='complete',affected_days=? WHERE operation_id=?",
      new Date().toISOString(),
      JSON.stringify(days),
      opId,
    );
    rebuild(tx, uid, days);
    return result({ ...op, status: "complete" });
  });
}
