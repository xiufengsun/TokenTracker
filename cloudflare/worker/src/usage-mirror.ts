import { digest } from "./device-store";

const route = "/functions/tokentracker-mirror-usage";
const machineTable = "tokentracker_cloud_machines";
const machineAliasTable = "tokentracker_cloud_machine_aliases";

const counters = [
  "input_tokens", "cached_input_tokens", "cache_creation_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens",
];
const usageSchema = {
  tokentracker_devices: {
    key: ["id"],
    values: ["user_id", "device_name", "platform", "machine_id", "revoked_at",
      "name_customized", "default_device_name", "created_at", "last_seen_at"],
  },
  tokentracker_device_machine: {
    key: ["device_id"],
    values: ["machine_cluster_id"],
  },
  tokentracker_device_tokens: {
    key: ["id"],
    values: ["user_id", "device_id", "token_hash", "revoked_at", "created_at",
      "cloud_environment", "last_used_at", "last_sync_at"],
  },
  tokentracker_cloud_machines: {
    key: ["id"],
    values: ["user_id", "environment", "status", "merged_into", "created_at",
      "last_seen_at", "last_upload_at", "upload_window_until", "upload_token_id",
      "upload_id", "upload_batch_count"],
  },
  tokentracker_cloud_machine_aliases: {
    key: ["user_id", "environment", "kind", "alias"],
    values: ["machine_id"],
  },
  tokentracker_hourly: {
    key: ["user_id", "device_id", "source", "model", "hour_start"],
    values: [
      ...counters, "billable_total_tokens", "conversations", "created_at",
      "updated_at", "total_cost_usd", "cost_coverage",
    ],
  },
  tokentracker_account_session_states: {
    key: ["user_id", "source", "session_id"],
    values: ["model", "bucket_start", ...counters, "snapshot_verified_at", "updated_at"],
  },
};

type MirrorEnv = {
  DB: D1Database;
  AUTH_LIMIT?: RateLimit;
  USAGE_MIRROR_SOURCE_URL?: string;
  USAGE_MIRROR_SECRET?: string;
  LEGACY_AUTH_ANON_KEY?: string;
};
type Relation = keyof typeof usageSchema;
type UsageEvent = {
  revision: string;
  relation: Relation;
  key: string[];
  row: Record<string, unknown> | null;
};

function isUsageEvent(value: unknown): value is UsageEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<UsageEvent>;
  return (
    typeof event.revision === "string" &&
    /^[1-9][0-9]{0,18}$/.test(event.revision) &&
    BigInt(event.revision) <= 9223372036854775807n &&
    typeof event.relation === "string" &&
    Object.hasOwn(usageSchema, event.relation) &&
    Array.isArray(event.key) &&
    event.key.length === usageSchema[event.relation].key.length &&
    event.key.every((part) => typeof part === "string") &&
    (event.row === null || !!event.row && typeof event.row === "object" &&
      event.key.every((part, i) => part === event.row?.[usageSchema[event.relation!].key[i]]))
  );
}

async function applyUsageChanges(db: D1Database, events: UsageEvent[]) {
  const commands: D1PreparedStatement[] = [];
  for (const relation of Object.keys(usageSchema) as Relation[]) {
    const changes = events.filter((event) => event.relation === relation);
    if (!changes.length) continue;
    const schema = usageSchema[relation];
    const columns = [...schema.key, ...schema.values];
    const json = JSON.stringify(changes);
    const eligible = `NOT EXISTS (
      SELECT 1 FROM migration_usage_revisions r
      WHERE r.relation=? AND r.row_key=json_extract(event.value,'$.key')
        AND r.revision>=CAST(json_extract(event.value,'$.revision') AS INTEGER)
    )`;
    const eventKey = schema.key.map((_, i) => `json_extract(event.value,'$.key[${i}]')`);
    // D1 can have independent aliases and resets. Hold the source tombstone
    // until the slot can be removed without cascading into those records.
    const protectMachine = relation === machineTable ? `
      AND NOT EXISTS (SELECT 1 FROM ${machineTable} child WHERE
        child.user_id=${machineTable}.user_id AND child.environment=${machineTable}.environment AND child.merged_into=${machineTable}.id)
      AND NOT EXISTS (SELECT 1 FROM tokentracker_cloud_machine_aliases a WHERE
        a.user_id=${machineTable}.user_id AND a.environment=${machineTable}.environment AND a.machine_id=${machineTable}.id)
      AND NOT EXISTS (SELECT 1 FROM tokentracker_cloud_usage_resets r WHERE
        r.user_id=${machineTable}.user_id AND r.environment=${machineTable}.environment AND r.machine_id=${machineTable}.id)` : "";

    commands.push(db.prepare(
      `DELETE FROM ${relation} WHERE (${schema.key.join(",")}) IN (
         SELECT ${eventKey.join(",")} FROM json_each(?) event
         WHERE json_type(event.value,'$.row')='null' AND ${eligible}
       )${protectMachine}`,
    ).bind(json, relation));
    commands.push(db.prepare(
      `INSERT INTO ${relation}(${columns.join(",")})
       SELECT ${columns.map((col) => `json_extract(event.value,'$.row.${col}')`).join(",")}
       FROM json_each(?) event WHERE json_type(event.value,'$.row')='object' AND ${eligible}
       ON CONFLICT(${schema.key.join(",")}) DO UPDATE SET
         ${schema.values.map((col) => `${col}=excluded.${col}`).join(",")}`,
    ).bind(json, relation));
  }

  const revisions = JSON.stringify(events.map(({ relation, key, revision, row }) => ({
    relation, key, revision, machineDelete: relation === machineTable && row === null,
  })));
  commands.push(db.prepare(
    `INSERT INTO migration_usage_revisions(relation,row_key,revision)
     SELECT json_extract(value,'$.relation'), json_extract(value,'$.key'),
       CAST(json_extract(value,'$.revision') AS INTEGER)
     FROM json_each(?) WHERE json_extract(value,'$.machineDelete')=0 OR NOT EXISTS (
       SELECT 1 FROM ${machineTable} m WHERE m.id=json_extract(value,'$.key[0]')
     )
     ON CONFLICT(relation,row_key) DO UPDATE SET revision=excluded.revision
       WHERE excluded.revision>migration_usage_revisions.revision`,
  ).bind(revisions));
  commands.push(db.prepare(
    `SELECT json_extract(value,'$.revision') AS revision, r.relation FROM json_each(?) event
     JOIN migration_usage_revisions r ON r.relation=json_extract(event.value,'$.relation')
       AND r.row_key=json_extract(event.value,'$.key')
       AND r.revision>=CAST(json_extract(event.value,'$.revision') AS INTEGER)`,
  ).bind(revisions));
  const result = await db.batch<{ revision: string; relation: Relation }>(commands);
  return result.at(-1)!.results;
}

async function sourceRequest(env: MirrorEnv, body: Record<string, unknown>) {
  if (!env.USAGE_MIRROR_SOURCE_URL || !env.USAGE_MIRROR_SECRET)
    throw new Error("Usage mirror is disabled");
  const response = await fetch(env.USAGE_MIRROR_SOURCE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tokentracker-mirror-secret": env.USAGE_MIRROR_SECRET,
      ...(env.LEGACY_AUTH_ANON_KEY ? { apikey: env.LEGACY_AUTH_ANON_KEY } : {}),
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Usage mirror source unavailable");
  return response;
}

// The source retains revisions until this D1 database commits them. Concurrent
// scheduled and client drains are safe, even when they complete out of order.
export async function mirrorUsage(env: MirrorEnv, deviceTokenHash: string | null) {
  const response = await sourceRequest(env, {
    action: "pending", device_token_hash: deviceTokenHash, include_machine_state: true,
  });
  const data = await response.json<{ authorized?: boolean; events?: unknown[] }>();
  if (data.authorized === false) return null;
  if (data.authorized !== true || !Array.isArray(data.events) ||
    data.events.length > 100 || !data.events.every(isUsageEvent))
    throw new Error("Malformed usage mirror batch");
  if (data.events.length > 0) {
    const applied = await applyUsageChanges(env.DB, data.events);
    if (applied.length) {
      const revisions: string[] = [], machineRevisions: string[] = [];
      for (const { relation, revision } of applied)
        (relation === machineTable || relation === machineAliasTable ? machineRevisions : revisions).push(revision);
      await sourceRequest(env, { action: "ack", revisions, machine_revisions: machineRevisions });
    }
    return applied.length;
  }
  return 0;
}

export async function dispatchUsageMirror(req: Request, env: MirrorEnv) {
  if (new URL(req.url).pathname !== route) return null;
  const headers = { "Cache-Control": "no-store" };
  if (req.method !== "POST") return new Response(null, { status: 405, headers });
  if (!env.USAGE_MIRROR_SOURCE_URL) return new Response(null, { status: 404, headers });
  const token = req.headers.get("Authorization")?.match(/^Bearer ([^\s]{1,512})$/i)?.[1];
  if (!token) return new Response(null, { status: 401, headers });
  if (!env.AUTH_LIMIT) return new Response(null, { status: 503, headers });
  if (!(await env.AUTH_LIMIT.limit({ key: req.headers.get("CF-Connecting-IP") || "local" })).success)
    return new Response(null, { status: 429, headers });
  try {
    const mirrored = await mirrorUsage(env, await digest(token));
    return mirrored === null
      ? new Response(null, { status: 401, headers })
      : Response.json({ mirrored }, { headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
