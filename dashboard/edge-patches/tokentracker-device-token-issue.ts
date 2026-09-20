/**
 * InsForge Edge：为当前登录用户签发 device token（写入 tokentracker_devices / tokentracker_device_tokens）。
 * 与文档中 historical 名称 tokentracker-device-token-issue 不同：本项目云端 slug 为 tokentracker-device-token-issue。
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isLeaderboardBlockedUser(userId: string): boolean {
  return (Deno.env.get("LEADERBOARD_BLOCKED_USER_IDS") ?? "")
    .split(",")
    .some((candidate) => candidate.trim() === userId);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const raw = atob(b64 + "=".repeat(pad));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Verify a HS256 JWT signature locally with JWT_SECRET and return its `sub`.
 *
 * Previously this function only decoded the payload without verifying the
 * signature, which let any caller forge `{"sub":"<victim>"}` and obtain a
 * service-role-signed device token bound to that victim's account. The
 * companion endpoint `tokentracker-leaderboard-profile.ts` already verifies
 * signatures here for the same reason — InsForge does NOT validate JWTs at
 * the gateway, so edge functions must do it themselves.
 *
 * Returns null on any failure (bad shape, bad signature, expired); the
 * caller surfaces that as 401.
 */
async function verifiedUserIdFromJwt(token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as Record<string, unknown>;
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    let ok = false;
    if (header.alg === "HS256") {
      const secret = Deno.env.get("JWT_SECRET");
      if (!secret) return null;
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("HMAC", key, sig, data);
    } else if (header.alg === "RS256") {
      const publicKeyPem = Deno.env.get("JWT_PUBLIC_KEY");
      if (!publicKeyPem) return null;
      const publicKeyDer = Uint8Array.from(atob(publicKeyPem.replace(/-----[^-]+-----|\s/g, "")), (char) => char.charCodeAt(0));
      const key = await crypto.subtle.importKey("spki", publicKeyDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
    } else return null;
    if (!ok) return null;
    const payloadStr = new TextDecoder().decode(b64urlToBytes(parts[1]));
    const payload = JSON.parse(payloadStr) as Record<string, unknown>;
    if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
    const sub = payload.sub;
    if (typeof sub === "string" && sub.length > 0) return sub;
    const uid = payload.user_id;
    if (typeof uid === "string" && uid.length > 0) return uid;
  } catch {
    /* ignore */
  }
  return null;
}

function resolveUserIdForUserMode(bearer: string): Promise<string | null> {
  return verifiedUserIdFromJwt(bearer);
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function disambiguateDeviceName(deviceName: string, machineId: string): string {
  const suffix = ` #${machineId.slice(0, 8)}`;
  if (deviceName.endsWith(suffix)) return deviceName;
  const baseName = deviceName.slice(0, 128 - suffix.length).trimEnd() || "Token Tracker";
  return `${baseName}${suffix}`;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const incomingApiKey =
    req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey =
    Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey ?? undefined;

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!bearer) return json({ error: "Missing bearer token" }, 401);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return json({ error: "server misconfigured" }, 500);
  const adminMode = Boolean(serviceRoleKey && bearer === serviceRoleKey);

  let userId: string | null = null;
  let dbClient: ReturnType<typeof createClient>;

  if (adminMode) {
    const fromBody = typeof body.user_id === "string" ? body.user_id : null;
    const dataObj = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null;
    const fromData = dataObj && typeof dataObj.user_id === "string" ? dataObj.user_id : null;
    userId = fromBody || fromData;
    if (!userId) return json({ error: "user_id is required (admin mode)" }, 400);
    dbClient = createClient({
      baseUrl,
      edgeFunctionToken: serviceRoleKey!,
      anonKey,
      ...(anonKey ? { headers: { apikey: anonKey } } : {}),
    });
  } else {
    userId = await resolveUserIdForUserMode(bearer);
    if (!userId) return json({ error: "Unauthorized" }, 401);
    // 用 service role key 操作 DB：用户身份已通过 JWT 签名验证（HS256 + JWT_SECRET），
    // 不再依赖用户的短期 access token（15 min 过期）做 DB 写入。
    dbClient = createClient({
      baseUrl,
      edgeFunctionToken: serviceRoleKey,
      anonKey,
      ...(anonKey ? { headers: { apikey: anonKey } } : {}),
    });
  }

  // A leaderboard ban must stop new uploads, not merely hide the account from
  // the public snapshot. Check before touching devices or minting credentials.
  // Only an explicit ban stops the write path. An `auto_excluded` anomaly flag
  // deliberately does not: the detector is heuristic, and
  // tokentracker-leaderboard-refresh already excludes flagged accounts from the
  // public snapshot on its own. Blocking ingest as well meant a false positive
  // could not upload the corrected numbers that would clear it -- the account
  // was stuck until someone opened an issue (#639).
  if (isLeaderboardBlockedUser(userId)) {
    return json({ error: "Account blocked" }, 403);
  }

  const dataObj2 = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : undefined;
  const deviceName = String(body.device_name ?? dataObj2?.device_name ?? "Token Tracker")
    .slice(0, 128);
  const platform = String(body.platform ?? dataObj2?.platform ?? "web").slice(
    0,
    32,
  );
  const machineIdRaw = body.machine_id ?? dataObj2?.machine_id;
  const machineId =
    typeof machineIdRaw === "string" && machineIdRaw.trim().length >= 8
      ? machineIdRaw.trim().slice(0, 64)
      : null;

  // Device identity resolution (machine-anchored since 2026-06):
  //
  //   1. machine_id match — the SAME physical machine always resolves to one
  //      device row, no matter how its display name drifted (hostname rename,
  //      suffix-derivation changes, browser storage resets). This is what
  //      actually prevents cross-device SUM double-counting: the v0.42 scheme
  //      keyed identity off the device NAME (with a best-effort machineId
  //      suffix), so a clientId fallback or a regenerated config.json minted
  //      a brand-new "device" and re-uploaded history under it (28.4B mirrored
  //      tokens across 18 users until the 2026-06 cleanup).
  //   2. Legacy adoption — an active machine_id-less row (matching the current
  //      suffixed name OR the pre-suffix base name "Token Tracker (dashboard)")
  //      is claimed by backfilling machine_id, migrating old installs in-place
  //      on their next token issue and converging old/new-version clients of one
  //      machine onto ONE device_id (issue #187: the exact-suffixed-only match
  //      missed the no-suffix orphan, so the first machine_id login minted a
  //      SECOND device and the account view SUMmed both).
  //   3. Insert — new machine. A unique-violation race (concurrent first
  //      login from two contexts) falls back to re-selecting the winner.
  //
  // Without machine_id (legacy clients) the old name-keyed path is preserved.
  let deviceId: string | null = null;

  if (machineId) {
    const { data: byMachine } = await dbClient.database
      .from("tokentracker_devices")
      .select("id")
      .eq("user_id", userId)
      .eq("machine_id", machineId)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle();
    if (byMachine && (byMachine as { id: string }).id) {
      const row = byMachine as { id: string };
      deviceId = row.id;
      // Refresh the client default and converge a matching machine_id-less
      // legacy row in one database transaction. The RPC preserves custom
      // names, canonicalizes duplicate hourly snapshots, moves old tokens,
      // and absorbs a concurrent unique-name race without logging a 23505.
      const { error: refreshErr } = await dbClient.database.rpc(
        "refresh_tokentracker_device_identity",
        {
          p_user_id: userId,
          p_device_id: deviceId,
          p_device_name: deviceName,
          p_platform: platform,
        },
      );
      if (refreshErr) {
        // Identity is already anchored by machine_id, so a transient refresh
        // failure must not prevent token rotation. Surface it in function logs
        // while leaving the canonical device untouched.
        console.error("device identity refresh failed", refreshErr.message);
      }
    }

    if (!deviceId) {
      // Adopt an orphan under the current system name or one of the generated
      // names used before hostname labels were introduced. A machine first
      // seen under an older name must be adopted in place; otherwise the next
      // upload would split its history into a second device.
      const legacyNames = Array.from(new Set([
        deviceName,
        `Token Tracker (dashboard) #${machineId.slice(0, 8)}`,
        "Token Tracker (dashboard)",
        "Token Tracker",
      ]));
      let legacyId: string | null = null;
      let legacyNameCustomized = false;
      const { data: legacy } = await dbClient.database
        .from("tokentracker_devices")
        .select("id, name_customized")
        .eq("user_id", userId)
        .eq("platform", platform)
        .in("device_name", legacyNames)
        .is("revoked_at", null)
        .is("machine_id", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (legacy && (legacy as { id: string }).id) {
        legacyId = (legacy as { id: string }).id;
        legacyNameCustomized = Boolean((legacy as { name_customized?: boolean }).name_customized);
      }
      if (!legacyId) {
        // A renamed legacy row matches no client default by device_name; the
        // rename endpoint preserved its pre-rename default in
        // default_device_name — match that as a fallback, with the exact same
        // (user, platform, active, machine_id IS NULL) scope, so a rename
        // doesn't leave the row un-adoptable and split off a fresh device.
        const { data: renamed } = await dbClient.database
          .from("tokentracker_devices")
          .select("id, name_customized")
          .eq("user_id", userId)
          .eq("platform", platform)
          .in("default_device_name", legacyNames)
          .is("revoked_at", null)
          .is("machine_id", null)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (renamed && (renamed as { id: string }).id) {
          legacyId = (renamed as { id: string }).id;
          legacyNameCustomized = Boolean((renamed as { name_customized?: boolean }).name_customized);
        }
      }
      if (legacyId) {
        const { error: adoptErr } = await dbClient.database
          .from("tokentracker_devices")
          .update(legacyNameCustomized
            ? { machine_id: machineId }
            : { machine_id: machineId, device_name: deviceName })
          .eq("id", legacyId)
          .is("machine_id", null);
        if (!adoptErr) {
          deviceId = legacyId;
        } else if (!legacyNameCustomized) {
          // The rename to the readable hostname can collide with the
          // active-name unique index when another machine already owns it.
          // Adopt under the old label so the historical row is not orphaned;
          // the identity RPC can converge the name on a later cycle.
          const { error: retryErr } = await dbClient.database
            .from("tokentracker_devices")
            .update({ machine_id: machineId })
            .eq("id", legacyId)
            .is("machine_id", null);
          if (!retryErr) deviceId = legacyId;
          // retryErr → lost a race against another adopter; fall through.
        }
        // adoptErr on a customized row → lost a race against another
        // adopter/inserter; fall through.
      }
    }

    if (!deviceId) {
      const newDeviceId = crypto.randomUUID();
      const { data: inserted, error: insErr } = await dbClient.database
        .from("tokentracker_devices")
        .upsert(
          [{ id: newDeviceId, user_id: userId, device_name: deviceName, platform, machine_id: machineId }],
          { ignoreDuplicates: true },
        )
        .select("id");
      if (!insErr && Array.isArray(inserted) && inserted.length > 0) {
        deviceId = (inserted[0] as { id: string }).id;
      } else {
        // Unique violation on (user_id, machine_id) — a concurrent call won.
        const { data: winner } = await dbClient.database
          .from("tokentracker_devices")
          .select("id")
          .eq("user_id", userId)
          .eq("machine_id", machineId)
          .is("revoked_at", null)
          .limit(1)
          .maybeSingle();
        if (winner && (winner as { id: string }).id) {
          deviceId = (winner as { id: string }).id;
        } else {
          // The active-name unique index also covers machine-anchored rows.
          // Retry with a stable suffix when another machine owns this hostname.
          const fallbackDeviceName = disambiguateDeviceName(deviceName, machineId);
          const fallbackDeviceId = crypto.randomUUID();
          const { data: fallbackInserted, error: fallbackErr } = await dbClient.database
            .from("tokentracker_devices")
            .upsert(
              [{
                id: fallbackDeviceId,
                user_id: userId,
                device_name: fallbackDeviceName,
                platform,
                machine_id: machineId,
              }],
              { ignoreDuplicates: true },
            )
            .select("id");
          if (!fallbackErr && Array.isArray(fallbackInserted) && fallbackInserted.length > 0) {
            deviceId = (fallbackInserted[0] as { id: string }).id;
          } else {
            // A concurrent request for this same machine may have won the
            // fallback insert, so resolve its canonical row before failing.
            const { data: fallbackWinner } = await dbClient.database
              .from("tokentracker_devices")
              .select("id")
              .eq("user_id", userId)
              .eq("machine_id", machineId)
              .is("revoked_at", null)
              .limit(1)
              .maybeSingle();
            if (fallbackWinner && (fallbackWinner as { id: string }).id) {
              deviceId = (fallbackWinner as { id: string }).id;
            } else {
              return json(
                {
                  error: "Failed to issue device token",
                  detail: fallbackErr?.message || insErr?.message || "device resolution failed",
                },
                500,
              );
            }
          }
        }
      }
    }
  } else {
    // Legacy name-keyed path. The partial unique index
    // `tokentracker_devices_active_unique` on (user_id, platform, device_name)
    // WHERE revoked_at IS NULL guarantees one active row per name; INSERT with
    // ON CONFLICT DO NOTHING, then SELECT the winner on a lost race.
    const newDeviceId = crypto.randomUUID();
    const { data: insertedDevice } = await dbClient.database
      .from("tokentracker_devices")
      .upsert([{ id: newDeviceId, user_id: userId, device_name: deviceName, platform }], {
        ignoreDuplicates: true,
      })
      .select("id");

    if (Array.isArray(insertedDevice) && insertedDevice.length > 0) {
      deviceId = (insertedDevice[0] as { id: string }).id;
    } else {
      const { data: winner, error: lookupErr } = await dbClient.database
        .from("tokentracker_devices")
        .select("id")
        .eq("user_id", userId)
        .eq("platform", platform)
        .eq("device_name", deviceName)
        .is("revoked_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (lookupErr || !winner) {
        return json(
          { error: "Failed to issue device token", detail: lookupErr?.message || "device lookup failed" },
          500,
        );
      }
      deviceId = (winner as { id: string }).id;
    }
  }

  const tokenId = crypto.randomUUID();
  const token =
    crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const tokenHash = await sha256Hex(token);
  const createdAt = new Date().toISOString();

  // NOTE: previous revision revoked all alive tokens on this device before
  // inserting the new one ("rotate-on-issue"). That coupled with the dashboard
  // re-minting on every WKWebView reload / module re-eval, killing the CLI's
  // long-lived token on roughly every dashboard launch and stalling uploads
  // for ~65% of recently-active users. Explicit rotation belongs in a
  // separate "sign out devices" endpoint, not in the implicit issue path.
  const { error: tokenErr } = await dbClient.database.from("tokentracker_device_tokens").insert([
    {
      id: tokenId,
      device_id: deviceId,
      user_id: userId,
      token_hash: tokenHash,
    },
  ]);

  if (tokenErr) {
    return json({ error: "Failed to issue device token", detail: tokenErr.message }, 500);
  }

  return json({ token, device_id: deviceId, created_at: createdAt });
}
