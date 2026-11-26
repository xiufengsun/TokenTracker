import { DeviceFailure, DeviceWrite, type Device } from "./device-store";

export async function mergeLegacyUsage(
  tx: DeviceWrite,
  uid: string,
  canonical: Device,
  legacy: Device,
  now: string,
) {
  const archives = await tx.rows<{ name: string }>(
    ["name"],
    `SELECT name FROM sqlite_schema WHERE name IN
    ('tokentracker_usage_archive_manifest','tokentracker_usage_archive_generations') ORDER BY name`,
  );
  if (archives.length)
    throw new DeviceFailure(503, "cloud_device_merge_archive_unsupported");
  const usage = (
    "input_tokens cached_input_tokens cache_creation_input_tokens output_tokens reasoning_output_tokens " +
    "total_tokens billable_total_tokens conversations created_at updated_at total_cost_usd cost_coverage"
  ).split(" ");
  tx.write(
    `INSERT INTO tokentracker_hourly(user_id,device_id,source,model,hour_start,${usage})
    SELECT user_id,?,source,model,hour_start,${usage} FROM tokentracker_hourly WHERE user_id=? AND device_id=?
    ON CONFLICT(user_id,device_id,source,model,hour_start) DO UPDATE SET ${usage.map((c) => c + "=excluded." + c)}
    WHERE excluded.total_tokens > tokentracker_hourly.total_tokens OR
      (excluded.total_tokens=tokentracker_hourly.total_tokens AND excluded.updated_at>tokentracker_hourly.updated_at)`,
    canonical.id,
    uid,
    legacy.id,
  );
  tx.write(
    "DELETE FROM tokentracker_hourly WHERE user_id=? AND device_id=?",
    uid,
    legacy.id,
  );
  tx.write(
    "UPDATE tokentracker_device_tokens SET device_id=? WHERE user_id=? AND device_id=?",
    canonical.id,
    uid,
    legacy.id,
  );
  tx.write(
    "DELETE FROM tokentracker_device_machine WHERE device_id=?",
    legacy.id,
  );
  tx.write(
    "UPDATE tokentracker_devices SET revoked_at=? WHERE user_id=? AND id=?",
    now,
    uid,
    legacy.id,
  );
}
