const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const MACHINE_HASH_RE = /^[0-9a-f]{64}$/;
const APP_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const PLATFORM_RE = /^[a-z0-9]{1,16}$/;
const SHELLS = new Set(["cli", "macos", "windows", "linux"]);

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function telemetry(
  req: Request,
  db: D1Database,
): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const machineHash =
    typeof body.machine_hash === "string" ? body.machine_hash : "";
  if (!MACHINE_HASH_RE.test(machineHash))
    return json({ error: "invalid machine_hash" }, 400);
  const appVersion =
    typeof body.app_version === "string" ? body.app_version : "";
  if (!APP_VERSION_RE.test(appVersion))
    return json({ error: "invalid app_version" }, 400);
  const platform = typeof body.platform === "string" ? body.platform : "";
  if (!PLATFORM_RE.test(platform))
    return json({ error: "invalid platform" }, 400);
  const shell = typeof body.shell === "string" ? body.shell : "";
  if (!SHELLS.has(shell)) return json({ error: "invalid shell" }, 400);

  const day = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO tokentracker_telemetry_daily(machine_hash,day,app_version,platform,shell,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(machine_hash,day) DO UPDATE SET
    app_version=excluded.app_version,platform=excluded.platform,
    shell=CASE WHEN excluded.shell='cli' THEN tokentracker_telemetry_daily.shell ELSE excluded.shell END,
    last_seen_at=excluded.last_seen_at`,
    )
    .bind(machineHash, day, appVersion, platform, shell, nowIso, nowIso)
    .run();
  return new Response(null, { status: 204, headers: corsHeaders });
}
