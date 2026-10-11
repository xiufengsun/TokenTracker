import type { createClient } from "npm:@insforge/sdk";

type Client = ReturnType<typeof createClient>;
export type CloudAccess = Record<string, unknown> & {
  ok: boolean; code?: string; status?: number; available_from?: string | null;
};

export function cloudEnvironment(): "live" | "sandbox" {
  const value = Deno.env.get("TOKENTRACKER_BILLING_ENVIRONMENT") || "live";
  if (value !== "live" && value !== "sandbox") throw new Error("Invalid Cloud environment");
  return value;
}

export async function cloudRpc(client: Client, name: string, args: Record<string, unknown>): Promise<CloudAccess> {
  const { data, error } = await client.database.rpc(name, { ...args, p_environment: cloudEnvironment() });
  if (error) throw new Error(error.message || "Cloud access unavailable");
  if (!data || typeof data !== "object" || typeof (data as CloudAccess).ok !== "boolean") {
    throw new Error("Invalid Cloud access response");
  }
  return data as CloudAccess;
}

export function cloudFailure(result: CloudAccess, cors: Record<string, string>): Response {
  const retryAfter = Number(result.retry_after_seconds);
  return Response.json({ ...result, error: result.code || "cloud_access_denied" }, {
    status: result.status || 403,
    headers: { ...cors, "Cache-Control": "no-store",
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { "Retry-After": String(Math.ceil(retryAfter)) } : {}) },
  });
}

// Called after JWT verification, before the endpoint's caches or usage RPCs.
export async function cloudReadAccess(client: Client, userId: string, kind: string): Promise<CloudAccess> {
  return await cloudRpc(client, "cloud_account_access", { p_user_id: userId, p_kind: kind });
}

export function cloudHistoryFailure(access: CloudAccess, to: string): CloudAccess | null {
  return access.available_from && to < access.available_from
    ? { ...access, ok: false, code: "cloud_history_window_exceeded", status: 400,
      recovery_url: "https://www.tokentracker.cc/cloud" } : null;
}
