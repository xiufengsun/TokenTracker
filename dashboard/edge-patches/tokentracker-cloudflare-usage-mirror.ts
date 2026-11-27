import { createClient } from "npm:@insforge/sdk";
import { timingSafeEqual } from "node:crypto";

export default async function (req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  const secret = Deno.env.get("TOKENTRACKER_CLOUDFLARE_MIRROR_SECRET");
  const supplied = req.headers.get("x-tokentracker-mirror-secret");
  const encoder = new TextEncoder();
  const expectedBytes = encoder.encode(secret ?? "");
  const suppliedBytes = encoder.encode(supplied ?? "");
  if (!secret || expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes))
    return new Response(null, { status: 401 });
  const serviceRole = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  if (!serviceRole) return new Response(null, { status: 503 });

  let body: { action?: unknown; device_token_hash?: unknown; revisions?: unknown; include_machine_state?: unknown; machine_revisions?: unknown };
  try {
    if (Number(req.headers.get("content-length")) > 4096)
      return new Response(null, { status: 413 });
    const text = await req.text();
    if (text.length > 4096) return new Response(null, { status: 413 });
    body = JSON.parse(text);
    if (!body || typeof body !== "object") throw new Error();
  } catch {
    return new Response(null, { status: 400 });
  }
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") ?? Deno.env.get("ANON_KEY") ?? req.headers.get("apikey");
  const client = createClient({
    baseUrl: Deno.env.get("INSFORGE_BASE_URL")!,
    edgeFunctionToken: serviceRole,
    ...(anonKey ? { anonKey, headers: { apikey: anonKey } } : {}),
  });
  const hash = body.device_token_hash;
  if (body.action === "pending" && (hash == null || typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) {
    let machines: unknown[] = [];
    if (body.include_machine_state === true) {
      const { data, error } = await client.database.rpc("tokentracker_cloudflare_machine_pending", {
        p_device_token_hash: hash ?? null,
        p_limit: 50,
      });
      if (error) return new Response(null, { status: 503 });
      const pending = data as { authorized?: boolean; events?: unknown[] } | null;
      if (pending?.authorized === false) return Response.json(pending);
      if (pending?.authorized !== true || !Array.isArray(pending.events) || pending.events.length > 50)
        return new Response(null, { status: 503 });
      machines = pending.events;
    }
    const { data, error } = await client.database.rpc("tokentracker_cloudflare_usage_pending", {
      p_device_token_hash: hash ?? null,
      p_limit: 100 - machines.length,
    });
    if (error) return new Response(null, { status: 503 });
    if (!machines.length) return Response.json(data);
    const usage = data as { authorized?: boolean; events?: unknown[] } | null;
    if (usage?.authorized === false) return Response.json(usage);
    if (usage?.authorized !== true || !Array.isArray(usage.events)) return new Response(null, { status: 503 });
    return Response.json({ authorized: true, events: [...usage.events, ...machines] });
  }
  const revisions = body.revisions;
  const machineRevisions = body.machine_revisions ?? [];
  if (body.action === "ack" && Array.isArray(revisions) && Array.isArray(machineRevisions) &&
    revisions.length + machineRevisions.length <= 100 &&
    [...revisions, ...machineRevisions].every((value) => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value))) {
    for (const [name, keys] of [["tokentracker_cloudflare_usage_ack", revisions],
      ["tokentracker_cloudflare_machine_ack", machineRevisions]] as const) {
      if (!keys.length) continue;
      const { error } = await client.database.rpc(name, { p_revisions: keys });
      if (error) return new Response(null, { status: 503 });
    }
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 400 });
}
