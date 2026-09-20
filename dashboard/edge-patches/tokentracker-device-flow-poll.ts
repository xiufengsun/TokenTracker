/**
 * InsForge Edge: OAuth-style device flow — poll step.
 *
 * Called by the CLI at the cadence indicated by the authorize response
 * (default 5s). Returns:
 *   - 200 { status: "pending" }            – still waiting on the user
 *   - 200 { status: "approved", user_id, device_token, device_id }
 *                                         – user granted the code
 *   - 410 { status: "expired" }            – the 15-minute window lapsed
 *   - 404 { status: "unknown" }            – device_code is bogus
 *
 * Public endpoint — the device_code itself is the bearer credential.
 */
import { createClient } from "npm:@insforge/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
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

// deno-lint-ignore no-explicit-any
async function issueDeviceToken(client: any, userId: string, clientInfo: string | null, machineId: string | null) {
  const platform = "cli-device-flow";
  // New CLIs send `<platform>-<arch> <hostname>` as client_info. Identity is
  // anchored by machine_id, so the human-facing name can be the actual system
  // hostname instead of an opaque generated label.
  const hostnameMatch = clientInfo?.match(/^\S+\s+(.+)$/);
  const hostname = hostnameMatch?.[1]?.trim() || null;
  const generatedLegacyName = `TokenTracker CLI${clientInfo ? ` (${clientInfo})` : ""}${machineId ? ` #${machineId.slice(0, 8)}` : ""}`.slice(0, 128);
  const generatedLegacyBareName = `TokenTracker CLI${clientInfo ? ` (${clientInfo})` : ""}`.slice(0, 128);
  const deviceName = (hostname || generatedLegacyName).slice(0, 128);

  // Device identity resolution — same machine-anchored scheme as
  // tokentracker-device-token-issue.ts: (1) reuse by (user, machine_id),
  // (2) adopt a legacy same-name row by backfilling machine_id, (3) insert,
  // falling back to re-select on a unique-violation race. Legacy CLIs that
  // send no machine_id keep the old name-keyed path.
  let deviceId: string | null = null;

  if (machineId) {
    const { data: byMachine } = await client.database
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
      const { error: refreshErr } = await client.database.rpc(
        "refresh_tokentracker_device_identity",
        {
          p_user_id: userId,
          p_device_id: deviceId,
          p_device_name: deviceName,
          p_platform: platform,
        },
      );
      if (refreshErr) {
        // The machine_id match remains authoritative; keep login available and
        // leave a structured runtime signal for a transient database failure.
        console.error("device identity refresh failed", refreshErr.message);
      }
    }

    if (!deviceId) {
      // Adoption tries the hostname first, then both generated names used by
      // older CLIs. This keeps an upgrade from orphaning the historical row;
      // machine_id remains the authoritative identity after adoption.
      const legacyNames = Array.from(new Set([
        deviceName,
        generatedLegacyName,
        generatedLegacyBareName,
      ]));
      const { data: legacyRows } = await client.database
        .from("tokentracker_devices")
        .select("id, device_name, name_customized")
        .eq("user_id", userId)
        .eq("platform", platform)
        .in("device_name", legacyNames)
        .is("revoked_at", null)
        .is("machine_id", null)
        .order("created_at", { ascending: true });
      let candidates = Array.isArray(legacyRows)
        ? (legacyRows as Array<{ id: string; device_name: string; name_customized?: boolean }>)
        : [];
      if (candidates.length === 0) {
        // A renamed legacy row matches no client default by device_name; the
        // rename endpoint preserved its pre-rename default in
        // default_device_name — match that as a fallback, with the exact same
        // (user, platform, active, machine_id IS NULL) scope, so a rename
        // doesn't leave the row un-adoptable and split off a fresh device.
        const { data: renamedRows } = await client.database
          .from("tokentracker_devices")
          .select("id, device_name, name_customized")
          .eq("user_id", userId)
          .eq("platform", platform)
          .in("default_device_name", legacyNames)
          .is("revoked_at", null)
          .is("machine_id", null)
          .order("created_at", { ascending: true });
        candidates = Array.isArray(renamedRows)
          ? (renamedRows as Array<{ id: string; device_name: string; name_customized?: boolean }>)
          : [];
      }
      // Prefer an exact new-name match, then the bare legacy name.
      const ordered = [
        ...candidates.filter((r) => r.device_name === deviceName),
        ...candidates.filter((r) => r.device_name !== deviceName),
      ];
      for (const candidate of ordered) {
        const { error: adoptErr } = await client.database
          .from("tokentracker_devices")
          .update(candidate.name_customized
            ? { machine_id: machineId }
            : { machine_id: machineId, device_name: deviceName })
          .eq("id", candidate.id)
          .is("machine_id", null);
        if (!adoptErr) {
          deviceId = candidate.id;
          break;
        }
        if (!candidate.name_customized) {
          // The rename to the readable hostname can collide with the
          // active-name unique index when another machine already owns it.
          // Adopt under the old label so the historical row is not orphaned;
          // the identity RPC can converge the name on a later cycle.
          const { error: retryErr } = await client.database
            .from("tokentracker_devices")
            .update({ machine_id: machineId })
            .eq("id", candidate.id)
            .is("machine_id", null);
          if (!retryErr) {
            deviceId = candidate.id;
            break;
          }
        }
      }
    }

    if (!deviceId) {
      const newDeviceId = crypto.randomUUID();
      const { data: inserted, error: insErr } = await client.database
        .from("tokentracker_devices")
        .upsert(
          [{ id: newDeviceId, user_id: userId, device_name: deviceName, platform, machine_id: machineId }],
          { ignoreDuplicates: true },
        )
        .select("id");
      if (!insErr && Array.isArray(inserted) && inserted.length > 0) {
        deviceId = (inserted[0] as { id: string }).id;
      } else {
        const { data: winner } = await client.database
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
          // A different machine may already own the readable hostname under
          // the active-name unique index. Keep this machine registerable with
          // the stable suffix previously used by CLI device names.
          const fallbackDeviceName = disambiguateDeviceName(deviceName, machineId);
          const fallbackDeviceId = crypto.randomUUID();
          const { data: fallbackInserted, error: fallbackErr } = await client.database
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
            const { data: fallbackWinner } = await client.database
              .from("tokentracker_devices")
              .select("id")
              .eq("user_id", userId)
              .eq("machine_id", machineId)
              .is("revoked_at", null)
              .limit(1)
              .maybeSingle();
            if (!fallbackWinner || !(fallbackWinner as { id: string }).id) {
              throw new Error(fallbackErr?.message || insErr?.message || "device resolution failed");
            }
            deviceId = (fallbackWinner as { id: string }).id;
          }
        }
      }
    }
  } else {
    const newDeviceId = crypto.randomUUID();
    const { data: insertedDevice } = await client.database
      .from("tokentracker_devices")
      .upsert([{ id: newDeviceId, user_id: userId, device_name: deviceName, platform }], {
        ignoreDuplicates: true,
      })
      .select("id");

    if (Array.isArray(insertedDevice) && insertedDevice.length > 0) {
      deviceId = (insertedDevice[0] as { id: string }).id;
    } else {
      const { data: winner, error: lookupErr } = await client.database
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
        throw new Error(lookupErr?.message || "device lookup failed");
      }
      deviceId = (winner as { id: string }).id;
    }
  }

  const createdAt = new Date().toISOString();
  const { error: revokeErr } = await client.database
    .from("tokentracker_device_tokens")
    .update({ revoked_at: createdAt })
    .eq("device_id", deviceId)
    .is("revoked_at", null);
  if (revokeErr) throw new Error(revokeErr.message);

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { error: tokenErr } = await client.database.from("tokentracker_device_tokens").insert([
    {
      id: crypto.randomUUID(),
      device_id: deviceId,
      user_id: userId,
      token_hash: await sha256Hex(token),
    },
  ]);
  if (tokenErr) throw new Error(tokenErr.message);

  return { token, deviceId };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { device_code?: string } = {};
  try { body = await req.json(); } catch (_e) { /* */ }
  const deviceCode = typeof body.device_code === "string" ? body.device_code.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(deviceCode)) return json({ status: "unknown" }, 404);

  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY");
  if (!baseUrl) return json({ error: "misconfigured" }, 500);
  if (!serviceRoleKey) return json({ error: "misconfigured" }, 500);

  const client = createClient({
    baseUrl,
    edgeFunctionToken: serviceRoleKey,
    anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}),
  });

  const { data, error } = await client.database
    .from("tokentracker_device_codes")
    .select("device_code, user_id, status, expires_at, approved_at, client_info, machine_id")
    .eq("device_code", deviceCode)
    .maybeSingle();

  if (error) {
    // Log internals server-side only — this is a public endpoint and error
    // messages can leak schema/infrastructure details.
    console.error("[device-flow-poll] db error:", String(error?.message ?? error));
    return json({ error: "db error" }, 502);
  }
  if (!data) return json({ status: "unknown" }, 404);

  const row = data as { user_id: string | null; status: string; expires_at: string; client_info: string | null; machine_id: string | null };
  const expiresAt = new Date(row.expires_at).getTime();
  if (Date.now() > expiresAt) {
    // Best-effort cleanup. Scope the UPDATE to status='pending' so two
    // concurrent CLI polls racing past the same expiry don't both write —
    // PostgREST has no transactional read-modify-write here, but the
    // predicate makes the second update a no-op.
    await client.database
      .from("tokentracker_device_codes")
      .update({ status: "expired" })
      .eq("device_code", deviceCode)
      .eq("status", "pending");
    return json({ status: "expired" }, 410);
  }

  if (row.status === "approved" && row.user_id) {
    // Do not let an already-approved device code bypass an account ban by
    // polling after its existing devices and tokens were revoked. Heuristic
    // anomaly flags are not a ban; see tokentracker-ingest for why.
    if (isLeaderboardBlockedUser(row.user_id)) {
      return json({ error: "Account blocked" }, 403);
    }
    try {
      const issued = await issueDeviceToken(client, row.user_id, row.client_info, row.machine_id);
      return json({
        status: "approved",
        user_id: row.user_id,
        device_token: issued.token,
        device_id: issued.deviceId,
      });
    } catch (e) {
      console.error("[device-flow-poll] issue failed:", String((e as Error)?.message ?? e));
      return json({ error: "Failed to issue device token" }, 500);
    }
  }
  return json({ status: "pending" });
}
