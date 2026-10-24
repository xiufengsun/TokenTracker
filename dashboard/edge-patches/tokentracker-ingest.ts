/**
 * InsForge Edge：接收本地 CLI 上传的用量数据，写入 tokentracker_hourly。
 * 用 device token（SHA-256 hash）验证身份，用 service role key 写 DB。
 */
import { createClient } from "npm:@insforge/sdk";
import { cloudRpc, cloudFailure } from "./cloud/access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, apikey, x-tokentracker-device-token-hash",
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
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function createIngestClient(req: Request) {
  const baseUrl = Deno.env.get("INSFORGE_BASE_URL")!;
  const serviceRoleKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const incomingApiKey = req.headers.get("apikey") ?? req.headers.get("Apikey") ?? req.headers.get("x-api-key") ?? undefined;
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? incomingApiKey;
  return serviceRoleKey ? createClient({ baseUrl, edgeFunctionToken: serviceRoleKey, anonKey,
    ...(anonKey ? { headers: { apikey: anonKey } } : {}) }) : null;
}

async function accountingCapabilities(client: ReturnType<typeof createClient> | null) {
  // Schema readiness is not rollout readiness: account readers may still be
  // on the old contract while this edge is being deployed. The maintainer
  // enables admission only after every consumer passes staging acceptance.
  if (Deno.env.get("TOKENTRACKER_ACCOUNTING_V3_READY") !== "1") {
    return { accounting_version: 2, unclassified_input_tokens: false };
  }
  try {
    if (client) {
      const { data, error } = await client.database.rpc("tokentracker_accounting_capabilities", {});
      if (!error && Number(data?.accounting_version) >= 3 && data?.unclassified_input_tokens === true) {
        return { accounting_version: 3, unclassified_input_tokens: true };
      }
    }
  } catch { /* An old/unavailable database must not silently drop new columns. */ }
  return { accounting_version: 2, unclassified_input_tokens: false };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: corsHeaders });
  const requestUrl = new URL(req.url);
  if (requestUrl.searchParams.get("capabilities") === "1") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return json(await accountingCapabilities(createIngestClient(req)));
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  const deviceToken = authHeader?.replace(/^Bearer\s+/i, "");
  if (!deviceToken) return json({ error: "Missing bearer token" }, 401);

  // Bound bytes before parsing; clients retain their queue offset on rejection.
  if (Number(req.headers.get("Content-Length") || 0) > 1_048_576) return json({ error: "Upload too large" }, 413);
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 1_048_576) return json({ error: "Upload too large" }, 413);
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(rawBody); } catch { /* malformed request */ }
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const client = createIngestClient(req);
  if (!client) return json({ error: "server misconfigured" }, 500);

  const tokenHash = await sha256Hex(deviceToken);

  const { data: tokenRow, error: tokenErr } = await client.database
    .from("tokentracker_device_tokens")
    .select("user_id, device_id")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (tokenErr) return json({ error: tokenErr.message }, 500);
  if (!tokenRow) return json({ error: "Unauthorized" }, 401);

  const userId = (tokenRow as { user_id: string }).user_id;
  const deviceId = (tokenRow as { device_id: string }).device_id;

  // Revoking known tokens is not sufficient when another issuance request is
  // already in flight. The blocklist is the final write-path authorization.
  // Only an explicit ban stops the write path. An `auto_excluded` anomaly flag
  // deliberately does not: the detector is heuristic, and
  // tokentracker-leaderboard-refresh already excludes flagged accounts from the
  // public snapshot on its own. Blocking ingest as well meant a false positive
  // could not upload the corrected numbers that would clear it -- the account
  // was stuck until someone opened an issue (#639).
  if (isLeaderboardBlockedUser(userId)) {
    return json({ error: "Account blocked" }, 403);
  }

  const buckets = Array.isArray(body.buckets)
    ? body.buckets
    : Array.isArray(body.hourly)
      ? body.hourly
      : [];

  // Account session states (kind: "account_session_state" queue records)
  // are canonical observations of one provider-side session (trae-cn):
  // identity is (user, source, session_id) - device_id is NOT identity, so
  // every device of the account converges onto the same row via the LWW
  // upsert rpc. Downward / model / bucket corrections are one whole-row
  // replace; absence never deletes (contract NOT PROVEN). A states-only
  // batch is a meaningful upload and must not fall into the no-buckets
  // reject.
  const rawStates = Array.isArray(body.account_session_states) ? body.account_session_states : [];
  if (rawStates.length > 500) {
    return json({ error: "Too many account session states (max 500)" }, 400);
  }
  const TOKEN_KEYS = [
    "input_tokens",
    "output_tokens",
    "unclassified_input_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ] as const;
  const states: Record<string, unknown>[] = [];
  for (const r of rawStates) {
    const source = typeof r?.source === "string" ? r.source.trim().toLowerCase() : "";
    const sessionId = typeof r?.session_id === "string" ? r.session_id.trim() : "";
    const model = typeof r?.model === "string" ? r.model.trim() : "";
    const bucketStart = Date.parse(String(r?.bucket_start ?? ""));
    const verifiedAt = Date.parse(String(r?.snapshot_verified_at ?? ""));
    const tokens: Record<string, number> = {};
    let tokensOk = true;
    for (const k of TOKEN_KEYS) {
      const v = Number(k === "unclassified_input_tokens" ? (r?.[k] ?? 0) : r?.[k]);
      if (!Number.isSafeInteger(v) || v < 0) tokensOk = false;
      else tokens[k] = v;
    }
    // Fail closed on a malformed state record: a bogus canonical session row
    // would corrupt the account's cross-device truth. The parser guarantees
    // total = input + cached + cacheCreation + output; enforce it here too.
    if (
      source !== "trae-cn" ||
      !sessionId ||
      sessionId.length > 256 ||
      !model ||
      model.length > 200 ||
      !Number.isFinite(bucketStart) ||
      !Number.isFinite(verifiedAt) ||
      !tokensOk ||
      tokens.total_tokens !==
        tokens.unclassified_input_tokens + tokens.input_tokens + tokens.cached_input_tokens + tokens.cache_creation_input_tokens + tokens.output_tokens
    ) {
      return json({ error: "Invalid account session state" }, 400);
    }
    states.push({
      source,
      session_id: sessionId,
      model,
      bucket_start: new Date(bucketStart).toISOString(),
      snapshot_verified_at: new Date(verifiedAt).toISOString(),
      ...tokens,
    });
  }
  // Same-session collisions inside one batch would make the LWW upsert's
  // ON CONFLICT affect a row twice (Postgres error). Keep the LAST record:
  // the append-only CLI queue writes later records with newer stamps.
  const stateMap = new Map<string, Record<string, unknown>>();
  for (const r of states) stateMap.set(r.source + "|" + r.session_id, r);
  const stateRows = Array.from(stateMap.values());

  if ((!Array.isArray(buckets) || buckets.length === 0) && stateRows.length === 0) {
    return json({ error: "No usage buckets provided" }, 400);
  }
  if (buckets.length > 500) {
    return json({ error: "Too many buckets (max 500)" }, 400);
  }

  if (buckets.some((b: Record<string, unknown>) => {
    const value = b.unclassified_input_tokens ?? 0;
    return typeof value !== "number" || !Number.isSafeInteger(value) || value < 0;
  })) return json({ error: "Invalid unclassified_input_tokens" }, 400);

  const mappedRows = buckets.map((b: Record<string, unknown>) => ({
    user_id: userId,
    device_id: deviceId,
    hour_start: b.hour_start,
    source: b.source || "unknown",
    model: b.model || "unknown",
    input_tokens: b.input_tokens || 0,
    unclassified_input_tokens: b.unclassified_input_tokens ?? 0,
    cached_input_tokens: b.cached_input_tokens || 0,
    cache_creation_input_tokens: b.cache_creation_input_tokens || 0,
    output_tokens: b.output_tokens || 0,
    reasoning_output_tokens: b.reasoning_output_tokens || 0,
    total_tokens: b.total_tokens || 0,
    billable_total_tokens: b.billable_total_tokens || 0,
    total_cost_usd: Number(b.unclassified_input_tokens) > 0 ? null : Number(b.total_cost_usd) || 0,
    // The CLI queue rows name this field `conversation_count`; older upload
    // paths sent `conversations`. Reading only `conversations` zeroed the
    // column for every CLI upload since 2026-04-18 — accept both.
    conversations: b.conversation_count ?? b.conversations ?? 0,
  }));

  // Dedupe within the batch by (hour_start, source, model), keeping the row
  // with the largest total_tokens. The CLI's queue.jsonl is append-only and
  // re-emits the same logical bucket multiple times as a session fills out
  // (each emission carries the cumulative running total, so MAX wins). Two
  // rows sharing the conflict key in one upsert make Postgres throw
  // "ON CONFLICT DO UPDATE command cannot affect row a second time" and
  // reject the entire batch — which stalled all clients until this dedupe.
  const dedupedMap = new Map<string, typeof mappedRows[number]>();
  for (const r of mappedRows) {
    const key = `${r.hour_start}|${r.source}|${r.model}`;
    const prev = dedupedMap.get(key);
    if (!prev || (Number(r.total_tokens) || 0) > (Number(prev.total_tokens) || 0)) {
      dedupedMap.set(key, r);
    }
  }
  const rows = Array.from(dedupedMap.values());

  if ([...rows, ...stateRows].some(row => Number(row.unclassified_input_tokens) > 0)
    && (await accountingCapabilities(client)).accounting_version < 3) {
    return json({ error: "Cloud accounting rollout is not ready; retain usage locally", code: "cloud_accounting_not_ready" }, 503);
  }

  try {
    const result = await cloudRpc(client, "cloud_ingest_usage", {
      p_token_hash: tokenHash, p_rows: rows, p_states: stateRows,
      p_upload_id: typeof body.upload_id === "string" && /^[0-9a-f-]{36}$/i.test(body.upload_id)
        ? body.upload_id : null,
    });
    if (!result.ok) return cloudFailure(result, corsHeaders);
    return json(result);
  } catch (error) {
    console.error("cloud ingest transaction failed", (error as Error).message);
    return json({ error: "Cloud access unavailable", code: "cloud_access_unavailable" }, 503);
  }
}
