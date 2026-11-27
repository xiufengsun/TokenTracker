const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const ALLOWED_TARGETS = new Set([
  "claude",
  "codex",
  "grok",
  "antigravity",
  "gemini",
  "opencode",
  "openclaw",
  "hermes",
  "zcode",
  "agents",
]);
const ALLOWED_SCOPES = new Set(["managed", "local", "plugin"]);
const MAX_SKILLS = 2000;
const MAX_BODY_BYTES = 1_000_000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, max)
    : "";
}

function cleanRelativePath(value: unknown, max = 300): string {
  const raw = cleanText(value, max).replace(/\\/g, "/");
  // Test absoluteness before trimming. Otherwise `/home/name/...` would become
  // `home/name/...` and leak a local path disguised as a relative directory.
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return "";
  const parts = raw.replace(/\/+$/g, "").split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".."))
    return "";
  return parts.join("/");
}

function cleanStableKey(value: unknown): string {
  const key = cleanText(value, 400).replace(/\\/g, "/");
  if (
    !key ||
    key.startsWith("/") ||
    key.includes(":/") ||
    /[A-Za-z]:\//.test(key)
  )
    return "";
  return key;
}

interface SkillInput {
  key?: unknown;
  name?: unknown;
  directory?: unknown;
  targets?: unknown;
  managed?: unknown;
  readOnly?: unknown;
  scope?: unknown;
  sourceName?: unknown;
}

interface StoredSkill {
  key: string;
  name: string;
  directory: string;
  targets: string[];
  managed: boolean;
  readOnly: boolean;
  scope: string;
  sourceName?: string;
}

function sanitizeSkill(input: SkillInput): StoredSkill | null {
  const directory = cleanRelativePath(input?.directory);
  const key = cleanStableKey(input?.key);
  if (!directory || !key) return null;
  const targets = Array.isArray(input?.targets)
    ? [
        ...new Set(
          input.targets
            .map((target) => cleanText(target, 40))
            .filter((target) => ALLOWED_TARGETS.has(target)),
        ),
      ].slice(0, 16)
    : [];
  const scopeInput = cleanText(input?.scope, 24);
  if (scopeInput === "system") return null;
  const scope = ALLOWED_SCOPES.has(scopeInput)
    ? scopeInput
    : input?.managed === true
      ? "managed"
      : "local";
  const sourceName = cleanRelativePath(input?.sourceName, 180);
  return {
    key,
    name: cleanText(input?.name, 180) || directory.split("/").pop() || "Skill",
    directory,
    targets,
    managed: input?.managed === true,
    readOnly: input?.readOnly === true,
    scope,
    ...(sourceName ? { sourceName } : {}),
  };
}

interface DeviceRow {
  id: string;
  device_name: string | null;
  platform: string | null;
  created_at: string | null;
}

export async function skillsReport(
  req: Request,
  db: D1Database,
  userId: string,
) {
  if (req.method === "POST") {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES)
      return json({ error: "Inventory too large" }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const deviceId = cleanText(body.device_id, 80);
    if (
      !deviceId ||
      !Array.isArray(body.skills) ||
      body.skills.length > MAX_SKILLS
    ) {
      return json({ error: "Invalid inventory" }, 400);
    }

    const skills = (body.skills as SkillInput[])
      .map(sanitizeSkill)
      .filter((item): item is StoredSkill => Boolean(item));
    const now = new Date().toISOString();
    const write = await db
      .prepare(
        `INSERT INTO tokentracker_device_skill_inventories(user_id,device_id,skills,scanned_at,updated_at)
      SELECT user_id,id,?,?,? FROM tokentracker_devices WHERE user_id=? AND id=? AND revoked_at IS NULL
      ON CONFLICT(user_id,device_id) DO UPDATE SET skills=excluded.skills,scanned_at=excluded.scanned_at,updated_at=excluded.updated_at`,
      )
      .bind(JSON.stringify(skills), now, now, userId, deviceId)
      .run();
    if (!write.meta.changes) return json({ error: "Device not found" }, 404);
    return json({
      ok: true,
      device_id: deviceId,
      count: skills.length,
      scanned_at: now,
    });
  }
  const rs = await db
    .prepare(
      `SELECT d.id,d.device_name,d.platform,d.created_at,i.skills,i.scanned_at FROM tokentracker_devices d
    LEFT JOIN tokentracker_device_skill_inventories i ON i.user_id=d.user_id AND i.device_id=d.id
    WHERE d.user_id=? AND d.revoked_at IS NULL`,
    )
    .bind(userId)
    .all<DeviceRow & { skills: string | null; scanned_at: string | null }>();
  return json({
    devices: rs.results
      .map((d) => ({
        ...d,
        skills: d.skills
          ? (JSON.parse(d.skills) as StoredSkill[]).filter(
              (s) => s.scope !== "system",
            )
          : [],
      }))
      .sort((a, b) =>
        String(a.device_name || "").localeCompare(String(b.device_name || "")),
      ),
  });
}
