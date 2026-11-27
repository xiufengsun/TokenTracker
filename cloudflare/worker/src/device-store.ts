import {
  membershipQuery,
  type BillingEnvironment,
  type Membership,
} from "./billing-membership";

export class DeviceFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

type Bind = string | number | null;
type Read = { sql: string; args: Bind[]; value: string };

// D1 offers atomic batches but not an interactive transaction. Match the exact
// authorization/identity reads again inside the write batch before applying it.
export class DeviceWrite {
  private reads: Read[] = [];
  private writes: D1PreparedStatement[] = [];

  constructor(public db: D1Database) {}

  async rows<T>(
    fields: string[],
    source: string,
    ...args: Bind[]
  ): Promise<T[]> {
    const pairs = fields.map((field) => `'${field}',r.${field}`).join(",");
    const sql = `SELECT json_group_array(json_object(${pairs})) AS snapshot FROM (${source}) r`;
    const value = await this.db
      .prepare(sql)
      .bind(...args)
      .first<string>("snapshot");
    if (typeof value !== "string") throw new Error("missing D1 snapshot");
    this.reads.push({ sql, args, value });
    return JSON.parse(value) as T[];
  }

  write(sql: string, ...args: Bind[]) {
    this.writes.push(this.db.prepare(sql).bind(...args));
  }

  async commit() {
    if (!this.writes.length) return;
    const checks = this.reads.map((r) => `((${r.sql}) IS ?)`).join(" AND ");
    const args = this.reads.flatMap((r) => [...r.args, r.value]);
    const guard = this.db
      .prepare(`INSERT INTO device_write_guard(id,valid) VALUES(1,${checks})`)
      .bind(...args);
    await this.db.batch([
      guard,
      ...this.writes,
      this.db.prepare("DELETE FROM device_write_guard WHERE id=1"),
    ]);
  }
}

export async function atomic<T>(
  db: D1Database,
  operation: (tx: DeviceWrite) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = new DeviceWrite(db);
    const result = await operation(tx);
    try {
      await tx.commit();
      return result;
    } catch (error) {
      if (!String(error).includes("device_snapshot_changed")) throw error;
    }
  }
  throw new DeviceFailure(503, "cloud_access_unavailable");
}

export async function membership(
  tx: DeviceWrite,
  uid: string,
  environment: BillingEnvironment,
): Promise<Membership> {
  const fields = (
    "environment phase status expires_at trial_ends_at transition_ends_at read_only_until " +
    "gift_expires_at access_source has_gift trial_available can_read_cloud can_upload_cloud machine_limit " +
    "sync_interval_seconds hourly_history_days daily_history_months"
  ).split(" ");
  const [row] = await tx.rows<Membership>(
    fields,
    membershipQuery("?", "?"),
    uid,
    environment,
  );
  if (!row) throw new DeviceFailure(503, "cloud_access_unavailable");
  return {
    ...row,
    has_gift: Boolean(row.has_gift),
    trial_available: Boolean(row.trial_available),
    can_read_cloud: Boolean(row.can_read_cloud),
    can_upload_cloud: Boolean(row.can_upload_cloud),
  };
}

export type Device = {
  id: string;
  device_name: string;
  platform: string | null;
  machine_id: string | null;
  name_customized: number;
  default_device_name: string | null;
  revoked_at: string | null;
};
export type Slot = {
  id: string;
  status: string;
  last_seen_at?: string | null;
  merged_into?: string | null;
  last_upload_at: string | null;
  upload_window_until: string | null;
  upload_token_id: string | null;
  upload_id: string | null;
  upload_batch_count: number;
};
type Alias = { kind: string; alias: string; machine_id: string };
export async function machines(
  tx: DeviceWrite,
  uid: string,
  environment: BillingEnvironment,
  includeLastSeen = false,
) {
  const [devices, slots, aliases, clusters] = await Promise.all([
    tx.rows<Device>(
      "id device_name platform machine_id name_customized default_device_name revoked_at".split(
        " ",
      ),
      "SELECT * FROM tokentracker_devices WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at,id",
      uid,
    ),
    tx.rows<Slot>(
      includeLastSeen ? ["id", "status", "last_seen_at", "merged_into"] : ["id", "status", "merged_into"],
      "SELECT * FROM tokentracker_cloud_machines WHERE user_id=? AND environment=? ORDER BY created_at,id",
      uid,
      environment,
    ),
    tx.rows<Alias>(
      ["kind", "alias", "machine_id"],
      "SELECT * FROM tokentracker_cloud_machine_aliases WHERE user_id=? AND environment=? ORDER BY kind,alias",
      uid,
      environment,
    ),
    tx.rows<{ device_id: string; machine_cluster_id: string }>(
      ["device_id", "machine_cluster_id"],
      "SELECT m.* FROM tokentracker_device_machine m JOIN tokentracker_devices d ON d.id=m.device_id WHERE d.user_id=? AND d.revoked_at IS NULL ORDER BY d.id",
      uid,
    ),
  ]);

  const slotByAlias = new Map(
    aliases.map((a) => [a.kind + ":" + a.alias, a.machine_id]),
  );
  const clusterByDevice = new Map(
    clusters.map((c) => [c.device_id, c.machine_cluster_id]),
  );
  for (const d of devices) {
    const cluster = clusterByDevice.get(d.id);
    const keys = [
      ["device", d.id],
      ...(d.machine_id ? [["machine", d.machine_id]] : []),
      ...(cluster ? [["cluster", cluster]] : []),
    ];
    const matched = slots.filter((s) =>
      keys.some(([kind, a]) => slotByAlias.get(kind + ":" + a) === s.id),
    );
    if (matched.some((s) => s.status === "merged"))
      throw new DeviceFailure(503, "cloud_machine_reconciliation_required");
    let slot = matched[0];
    if (!slot) {
      slot = {
        id: crypto.randomUUID(),
        status: "active",
        last_upload_at: null,
        upload_window_until: null,
        upload_token_id: null,
        upload_id: null,
        upload_batch_count: 0,
      };
      slots.push(slot);
      tx.write(
        "INSERT INTO tokentracker_cloud_machines(id,user_id,environment,created_at) VALUES(?,?,?,?)",
        slot.id,
        uid,
        environment,
        new Date().toISOString(),
      );
    }
    const keeper = slot.id;
    if (matched.length > 1)
      mergeSlots(tx, uid, environment, matched, slotByAlias);
    for (const [kind, a] of keys) {
      if (slotByAlias.get(kind + ":" + a) === keeper) continue;
      tx.write(
        "INSERT INTO tokentracker_cloud_machine_aliases(user_id,environment,kind,alias,machine_id) VALUES(?,?,?,?,?) ON CONFLICT(user_id,environment,kind,alias) DO UPDATE SET machine_id=excluded.machine_id",
        uid,
        environment,
        kind,
        a,
        keeper,
      );
      slotByAlias.set(kind + ":" + a, keeper);
    }
  }
  return { devices, slots, slotByAlias };
}

export function mergeSlots(
  tx: DeviceWrite,
  uid: string,
  environment: BillingEnvironment,
  matched: Slot[],
  slotByAlias: Map<string, string>,
) {
  const slot = matched[0],
    keeper = slot.id;
  slot.status = matched.some((s) => s.status === "paused")
    ? "paused"
    : "active";
  const ids = JSON.stringify(matched.map((s) => s.id));
  tx.write(
    `UPDATE tokentracker_cloud_machines SET status=?,
        last_seen_at=(SELECT max(last_seen_at) FROM tokentracker_cloud_machines WHERE id IN (SELECT value FROM json_each(?))),
        last_upload_at=(SELECT max(last_upload_at) FROM tokentracker_cloud_machines WHERE id IN (SELECT value FROM json_each(?))),
        upload_window_until=NULL, upload_token_id=NULL, upload_id=NULL WHERE id=?`,
    slot.status,
    ids,
    ids,
    keeper,
  );
  for (const other of matched.slice(1)) {
    other.status = "merged";
    other.merged_into = keeper;
    tx.write(
      "UPDATE tokentracker_cloud_machine_aliases SET machine_id=? WHERE user_id=? AND environment=? AND machine_id=?",
      keeper,
      uid,
      environment,
      other.id,
    );
    tx.write(
      `UPDATE tokentracker_cloud_machines SET status='merged',merged_into=?,upload_window_until=NULL,upload_token_id=NULL,upload_id=NULL
          WHERE user_id=? AND environment=? AND (id=? OR merged_into=?)`,
      keeper,
      uid,
      environment,
      other.id,
      other.id,
    );
    for (const [key, id] of slotByAlias)
      if (id === other.id) slotByAlias.set(key, keeper);
  }
  return slot;
}

export function limited(member: Membership, count: number, adding: boolean) {
  const limit = member.machine_limit;
  if (limit === null || (adding ? count < limit : count <= limit)) return;
  if (
    !adding &&
    member.transition_ends_at &&
    Date.parse(member.transition_ends_at) > Date.now()
  )
    return;
  throw new DeviceFailure(409, "cloud_machine_limit", {
    membership: member,
    machine_count: count,
    recovery_url: "https://www.tokentracker.cc/cloud",
  });
}

export async function digest(token: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
