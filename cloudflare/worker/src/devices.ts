import { getAccountId, type AuthEnv } from "./auth";
import type { BillingEnvironment } from "./billing-membership";
import { mergeLegacyUsage } from "./device-merge";
import { deviceReset } from "./device-reset";
import { ingest } from "./device-ingest";
import {
  atomic,
  DeviceFailure,
  DeviceWrite,
  digest,
  limited,
  machines,
  mergeSlots,
  membership,
} from "./device-store";

type DeviceEnv = AuthEnv & {
  TOKENTRACKER_BILLING_ENVIRONMENT?: string;
  LEADERBOARD_BLOCKED_USER_IDS?: string;
};
type Body = Record<string, unknown>;
type Code = {
  device_code: string;
  user_code: string;
  status: string;
  user_id: string | null;
  machine_id: string | null;
  client_info: string | null;
  expires_at: string;
  valid_now: number;
};
const allowed = new Set([
  "device-flow-authorize",
  "device-flow-grant",
  "device-flow-poll",
  "device-token-issue",
  "device-rename",
  "device-usage-reset",
  "ingest",
]);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
  "Cache-Control": "no-store",
};

function hex(size: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
function machineAlias(raw: unknown) {
  return typeof raw === "string" && raw.trim().length >= 8
    ? raw.trim().slice(0, 64)
    : null;
}
function fail(status: number, code: string, detail?: Body): never {
  throw new DeviceFailure(status, code, detail);
}
async function jsonBody(req: Request): Promise<Body> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Body)
      : {};
  } catch {
    return {};
  }
}
async function authorize(
  db: D1Database,
  environment: BillingEnvironment,
  body: Body,
) {
  const client =
    typeof body.client_info === "string"
      ? body.client_info.slice(0, 200)
      : null;
  const now = Date.now();
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const verification_uri = "https://www.tokentracker.cc/device";
  for (let attempt = 0; attempt < 5; attempt++) {
    const device_code = hex(32);
    const userChars = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (n) => alphabet[n % alphabet.length],
    ).join("");
    const user_code = userChars.slice(0, 4) + "-" + userChars.slice(4);
    const result = await db
      .prepare(
        `INSERT INTO tokentracker_device_codes(device_code,user_code,client_info,machine_id,expires_at,created_at,cloud_environment)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      )
      .bind(
        device_code,
        user_code,
        client,
        machineAlias(body.machine_id),
        new Date(now + 900_000).toISOString(),
        new Date(now).toISOString(),
        environment,
      )
      .run();
    if (result.meta.changes)
      return {
        device_code,
        user_code,
        verification_uri,
        verification_uri_complete: verification_uri + "?user_code=" + user_code,
        expires_in: 900,
        interval: 5,
      };
  }
  fail(503, "could not allocate device code");
}
function findCode(
  tx: DeviceWrite,
  environment: BillingEnvironment,
  key: "device_code" | "user_code",
  value: string,
) {
  return tx.rows<Code>(
    "device_code user_code status user_id machine_id client_info expires_at valid_now".split(
      " ",
    ),
    `SELECT *,julianday(expires_at)>julianday('now') AS valid_now FROM tokentracker_device_codes WHERE ${key}=? AND cloud_environment=?`,
    value,
    environment,
  );
}
async function grant(
  db: D1Database,
  environment: BillingEnvironment,
  userId: string,
  body: Body,
) {
  const code =
    typeof body.user_code === "string"
      ? body.user_code.trim().toUpperCase()
      : "";
  if (!/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code))
    fail(400, "invalid user_code format");
  return atomic(db, async (tx) => {
    const [row] = await findCode(tx, environment, "user_code", code);
    if (!row) fail(404, "cloud_device_code_unknown");
    if (row.status === "expired" || row.status === "used" || !row.valid_now)
      fail(410, "cloud_device_code_expired");
    if (row.status === "approved" && row.user_id !== userId)
      fail(409, "cloud_device_code_claimed");
    const [group, member] = await Promise.all([
      machines(tx, userId, environment),
      membership(tx, userId, environment),
    ]);
    const slot = group.slots.find(
      (s) => s.id === group.slotByAlias.get("machine:" + row.machine_id),
    );
    if (slot?.status === "paused")
      fail(403, "cloud_machine_paused", {
        machine_id: slot.id,
        recovery_url: "https://www.tokentracker.cc/cloud",
      });
    tx.write(
      "UPDATE tokentracker_device_codes SET status='approved',user_id=?,approved_at=coalesce(approved_at,?) WHERE device_code=?",
      userId,
      new Date().toISOString(),
      row.device_code,
    );
    return {
      ok: true,
      status: row.status === "approved" ? "already_approved" : "approved",
      client_info: row.client_info,
      membership: member,
    };
  });
}

type Identity = {
  deviceName: string;
  platform: string;
  machineId: string | null;
  legacy: string[];
};
async function issue(
  tx: DeviceWrite,
  environment: BillingEnvironment,
  uid: string,
  identity: Identity,
  rotate: boolean,
) {
  const { deviceName, platform, machineId, legacy } = identity;
  const [group, member] = await Promise.all([
    machines(tx, uid, environment),
    membership(tx, uid, environment),
  ]);
  let device = machineId
    ? group.devices.find((d) => d.machine_id === machineId)
    : undefined;
  const matching = group.devices.filter(
    (d) =>
      d.platform === platform &&
      (!machineId || !d.machine_id) &&
      (legacy.includes(d.device_name) ||
        (d.default_device_name !== null &&
          legacy.includes(d.default_device_name))),
  );
  const canonicalId = device?.id;
  const legacyDevice =
    device &&
    group.devices.find(
      (d) =>
        d.id !== canonicalId &&
        !d.machine_id &&
        d.platform === platform &&
        (d.device_name === deviceName || d.default_device_name === deviceName),
    );
  if (!device)
    device = matching.find((d) => d.device_name === deviceName) || matching[0];
  const ids = [
    machineId && group.slotByAlias.get("machine:" + machineId),
    device && group.slotByAlias.get("device:" + device.id),
    legacyDevice && group.slotByAlias.get("device:" + legacyDevice.id),
  ].filter(Boolean);
  const matched = group.slots.filter((s) => ids.includes(s.id));
  const slot =
    matched.length > 1
      ? mergeSlots(tx, uid, environment, matched, group.slotByAlias)
      : matched[0];
  const count = group.slots.filter((s) => s.status === "active").length;
  if (slot && slot.status !== "active")
    fail(403, "cloud_machine_paused", {
      membership: member,
      machine_id: slot.id,
      recovery_url: "https://www.tokentracker.cc/cloud",
    });
  limited(member, count, !slot);
  const slotId = slot?.id ?? crypto.randomUUID(),
    did = device?.id ?? crypto.randomUUID();
  const token = hex(32),
    tokenId = crypto.randomUUID(),
    now = new Date().toISOString();
  if (device && legacyDevice) {
    await mergeLegacyUsage(tx, uid, device, legacyDevice, now);
    if (!device.name_customized && legacyDevice.name_customized) {
      device.name_customized = 1;
      device.device_name = legacyDevice.device_name;
      tx.write(
        "UPDATE tokentracker_devices SET name_customized=1,default_device_name=? WHERE id=?",
        legacyDevice.default_device_name || deviceName,
        did,
      );
    }
  }
  if (!device) {
    const conflict = group.devices.some(
      (d) => d.platform === platform && d.device_name === deviceName,
    );
    const name = conflict
      ? deviceName.slice(0, 116) + " #" + (machineId || tokenId).slice(0, 8)
      : deviceName;
    if (
      group.devices.some(
        (d) => d.platform === platform && d.device_name === name,
      )
    ) {
      fail(409, "cloud_device_identity_conflict", {
        membership: member,
        recovery_url: "https://www.tokentracker.cc/cloud",
      });
    }
    tx.write(
      "INSERT INTO tokentracker_devices(id,user_id,device_name,platform,machine_id,created_at) VALUES(?,?,?,?,?,?)",
      did,
      uid,
      name,
      platform,
      machineId,
      now,
    );
  } else if (machineId) {
    const conflict = group.devices.some(
      (d) =>
        d.id !== did &&
        d.id !== legacyDevice?.id &&
        d.platform === platform &&
        d.device_name === deviceName,
    );
    tx.write(
      "UPDATE tokentracker_devices SET machine_id=?,device_name=?,platform=? WHERE id=? AND user_id=?",
      machineId,
      device.name_customized || conflict ? device.device_name : deviceName,
      conflict ? device.platform : platform,
      did,
      uid,
    );
  }
  if (!slot)
    tx.write(
      "INSERT INTO tokentracker_cloud_machines(id,user_id,environment,created_at) VALUES(?,?,?,?)",
      slotId,
      uid,
      environment,
      now,
    );
  const aliases = [
    ["device", did],
    ...(machineId ? [["machine", machineId]] : []),
  ];
  for (const [kind, alias] of aliases)
    if (!group.slotByAlias.has(kind + ":" + alias)) {
      tx.write(
        "INSERT INTO tokentracker_cloud_machine_aliases(user_id,environment,kind,alias,machine_id) VALUES(?,?,?,?,?)",
        uid,
        environment,
        kind,
        alias,
        slotId,
      );
    }
  if (rotate)
    tx.write(
      "UPDATE tokentracker_device_tokens SET revoked_at=? WHERE device_id=? AND cloud_environment=? AND revoked_at IS NULL",
      now,
      did,
      environment,
    );
  tx.write(
    "INSERT INTO tokentracker_device_tokens(id,user_id,device_id,token_hash,created_at,cloud_environment) VALUES(?,?,?,?,?,?)",
    tokenId,
    uid,
    did,
    await digest(token),
    now,
    environment,
  );
  return {
    token,
    device_id: did,
    created_at: now,
    machine_id: slotId,
    membership: member,
  };
}

async function poll(
  db: D1Database,
  environment: BillingEnvironment,
  blocked: Set<string>,
  body: Body,
) {
  const code =
    typeof body.device_code === "string" ? body.device_code.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(code)) fail(404, "unknown", { status: "unknown" });
  return atomic(db, async (tx) => {
    const [row] = await findCode(tx, environment, "device_code", code);
    if (!row) fail(404, "unknown", { status: "unknown" });
    if (row.status === "expired" || !row.valid_now)
      fail(410, "expired", { status: "expired" });
    if (row.status !== "approved" || !row.user_id) return { status: "pending" };
    if (blocked.has(row.user_id)) fail(403, "Account blocked");
    const bare =
      `TokenTracker CLI${row.client_info ? ` (${row.client_info})` : ""}`.slice(
        0,
        128,
      );
    const suffix = (
      bare + (row.machine_id ? " #" + row.machine_id.slice(0, 8) : "")
    ).slice(0, 128);
    const name = (
      row.client_info?.match(/^\S+\s+(.+)$/)?.[1]?.trim() || suffix
    ).slice(0, 128);
    const result = await issue(
      tx,
      environment,
      row.user_id,
      {
        deviceName: name,
        platform: "cli-device-flow",
        machineId: row.machine_id,
        legacy: [name, suffix, bare],
      },
      true,
    );
    return {
      status: "approved",
      user_id: row.user_id,
      device_token: result.token,
      device_id: result.device_id,
      machine_id: result.machine_id,
      membership: result.membership,
    };
  });
}

async function rename(db: D1Database, userId: string, body: Body) {
  const did = String(body.device_id || "").trim(),
    name = String(body.device_name || "")
      .trim()
      .slice(0, 60);
  if (!did || !name || typeof body.device_name !== "string")
    fail(400, !did ? "device_id is required" : "device_name is required");
  try {
    const row = await db
      .prepare(
        `UPDATE tokentracker_devices SET
      default_device_name=CASE WHEN name_customized=0 THEN device_name ELSE default_device_name END,
      device_name=?, name_customized=1 WHERE id=? AND user_id=? AND revoked_at IS NULL RETURNING id,device_name,platform`,
      )
      .bind(name, did, userId)
      .first();
    if (!row) fail(404, "not_found");
    return { ok: true, device: row };
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) fail(409, "name_taken");
    throw e;
  }
}

export async function dispatchDevice(
  req: Request,
  env: DeviceEnv,
): Promise<Response | null> {
  const route = new URL(req.url).pathname.match(
    /^\/(?:functions\/)?tokentracker-([a-z-]+)$/,
  )?.[1];
  if (!route || !allowed.has(route)) return null;
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: cors },
    );
  const environment = env.TOKENTRACKER_BILLING_ENVIRONMENT;
  try {
    if (environment !== "live" && environment !== "sandbox")
      fail(503, "cloud_access_unavailable");
    if (typeof env.LEADERBOARD_BLOCKED_USER_IDS !== "string")
      fail(503, "cloud_access_unavailable");
    const blocked = new Set(
      env.LEADERBOARD_BLOCKED_USER_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    let result;
    if (route === "ingest")
      result = await ingest(req, env.DB, environment, blocked);
    else {
      const body = await jsonBody(req);
      if (route === "device-usage-reset")
        result = await deviceReset(req, env, environment, body);
      else if (route === "device-flow-authorize")
        result = await authorize(env.DB, environment, body);
      else if (route === "device-flow-poll")
        result = await poll(env.DB, environment, blocked, body);
      else {
        const userId = await getAccountId(req, env);
        if (!userId) fail(401, "Unauthorized");
        if (route === "device-rename")
          result = await rename(env.DB, userId, body);
        else if (route === "device-flow-grant")
          result = await grant(env.DB, environment, userId, body);
        else {
          if (blocked.has(userId)) fail(403, "Account blocked");
          const data =
            body.data && typeof body.data === "object"
              ? (body.data as Body)
              : {};
          const deviceName = String(
            body.device_name ?? data.device_name ?? "Token Tracker",
          ).slice(0, 128);
          const platform = String(
            body.platform ?? data.platform ?? "web",
          ).slice(0, 32);
          const machineId = machineAlias(body.machine_id ?? data.machine_id);
          const legacy = [
            deviceName,
            ...(machineId
              ? ["Token Tracker (dashboard) #" + machineId.slice(0, 8)]
              : []),
            "Token Tracker (dashboard)",
            "Token Tracker",
          ];
          result = await atomic(env.DB, (tx) =>
            issue(
              tx,
              environment,
              userId,
              { deviceName, platform, machineId, legacy },
              false,
            ),
          );
        }
      }
    }
    return Response.json(result, { headers: cors });
  } catch (e) {
    if (e instanceof DeviceFailure) {
      const retry = e.detail.retry_after_seconds;
      return Response.json(
        {
          ok: false,
          error: e.code,
          code: e.code,
          status: e.status,
          ...e.detail,
        },
        {
          status: e.status,
          headers: {
            ...cors,
            ...(typeof retry === "number"
              ? { "Retry-After": String(retry) }
              : {}),
          },
        },
      );
    }
    return Response.json(
      {
        ok: false,
        code: "cloud_access_unavailable",
        error: "Cloud access unavailable",
      },
      { status: 503, headers: cors },
    );
  }
}

export async function dispatchBillingDevices(
  db: D1Database,
  uid: string,
  environment: BillingEnvironment,
  action: string,
  input: Body,
): Promise<Response> {
  try {
    const data = await atomic(db, async (tx) => {
      const [group, member, labels] = await Promise.all([
        machines(tx, uid, environment, action === "devices"),
        membership(tx, uid, environment),
        tx.rows<{ id: string; device_name: string; platform: string | null }>(
          ["id", "device_name", "platform"],
          "SELECT * FROM tokentracker_devices WHERE user_id=? ORDER BY name_customized DESC, revoked_at IS NOT NULL, created_at,id",
          uid,
        ),
      ]);
      if (action !== "devices") {
        if (action !== "remove-device" && action !== "resume-device")
          fail(404, "not_found");
        const requested = input.machine_id;
        if (
          typeof requested !== "string" ||
          !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requested)
        )
          fail(400, "invalid_machine_id");
        let slot = group.slots.find((s) => s.id === requested.toLowerCase());
        if (slot?.status === "merged")
          slot = group.slots.find((s) => s.id === slot!.merged_into);
        if (!slot) fail(404, "cloud_machine_not_found");
        const newStatus = action === "remove-device" ? "paused" : "active";
        if (newStatus === "active" && slot.status !== "active")
          limited(
            member,
            group.slots.filter((s) => s.status === "active").length,
            true,
          );
        slot.status = newStatus;
        tx.write(
          "UPDATE tokentracker_cloud_machines SET status=?,upload_window_until=NULL,upload_id=NULL,upload_token_id=NULL WHERE user_id=? AND environment=? AND id=?",
          newStatus,
          uid,
          environment,
          slot.id,
        );
        if (newStatus === "paused")
          tx.write(
            `UPDATE tokentracker_device_tokens SET revoked_at=?
          WHERE user_id=? AND cloud_environment=? AND revoked_at IS NULL AND device_id IN (
            SELECT alias FROM tokentracker_cloud_machine_aliases WHERE user_id=? AND environment=? AND machine_id=? AND kind='device')`,
            new Date().toISOString(),
            uid,
            environment,
            uid,
            environment,
            slot.id,
          );
      }
      const current =
        typeof input.current_machine_id === "string"
          ? input.current_machine_id
          : null;
      const records = group.slots
        .filter((s) => s.status !== "merged")
        .map((s) => {
          const label = labels.find(
            (d) => group.slotByAlias.get("device:" + d.id) === s.id,
          );
          return {
            machine_id: s.id,
            name: label?.device_name || "Token Tracker",
            platform: label?.platform ?? null,
            last_seen_at: s.last_seen_at ?? null,
            is_current:
              current !== null &&
              (current === s.id ||
                group.slotByAlias.get("machine:" + current) === s.id),
            status: s.status,
          };
        });
      const count = records.filter((r) => r.status === "active").length;
      return {
        ...(action === "devices" ? {} : { ok: true }),
        machines: records,
        machine_count: count,
        machine_limit: member.machine_limit,
        membership: member,
        over_machine_limit:
          member.machine_limit === null ? null : count > member.machine_limit,
      };
    });
    return Response.json(data, { headers: cors });
  } catch (e) {
    if (e instanceof DeviceFailure)
      return Response.json(
        { error: e.code, ...e.detail },
        { status: e.status, headers: cors },
      );
    return Response.json(
      { error: "cloud_access_unavailable" },
      { status: 503, headers: cors },
    );
  }
}
