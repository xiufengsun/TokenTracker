import { createClient as createActualClient } from "npm:@insforge/sdk@1.4.5";

export const QA_TABLE_NAMES = ["tokentracker_devices", "tokentracker_device_tokens", "tokentracker_device_codes"];
export const QA_RPC_NAMES = [
  "cloud_issue_device_token", "cloud_ingest_usage", "cloud_account_access", "cloud_list_machines",
  "cloud_remove_machine", "cloud_resume_machine", "cloud_grant_device_code", "cloud_membership",
  "account_summary_wire", "account_daily_wire", "account_heatmap_wire", "account_model_breakdown_wire",
  "account_usage_grouped_cached", "account_usage_grouped",
];
const TABLE_MAP = Object.fromEntries(QA_TABLE_NAMES.map(name => [name, "tt_cloud_qa_" + name]));
const RPC_MAP = Object.fromEntries(QA_RPC_NAMES.map(name => [name, "tt_cloud_qa_" + name]));
const FINANCIAL_READS = new Set(["tokentracker_cloud_orders", "tokentracker_cloud_payments", "tokentracker_cloud_subscriptions"]);
const GIFT_RPC_ARGS: Record<string, string[]> = {
  cloud_gift_account: ["p_environment", "p_user_id"],
  cloud_redeem_gift: ["p_code_hash", "p_environment", "p_request_id", "p_user_id"],
};
const RECORDS = new Set(Object.values(TABLE_MAP));
const RPCS = new Set(Object.values(RPC_MAP));

function transportUsers(): Set<string> {
  const raw = Deno.env.get("TOKENTRACKER_SANDBOX_ACCESS_USER_IDS") || "";
  const ids = raw.split(",").map(id => id.trim().toLowerCase());
  if (raw.length > 8192 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) {
    throw new Error("qa_transport_not_configured");
  }
  return new Set(ids);
}
function filteredUser(url: URL, users: Set<string>): boolean {
  const values = url.searchParams.getAll("user_id");
  return values.length === 1 && /^eq\./.test(values[0]) && users.has(values[0].slice(3).toLowerCase());
}

export function createClient(config: Parameters<typeof createActualClient>[0]) {
  const baseUrl = Deno.env.get("INSFORGE_BASE_URL");
  const serviceKey = Deno.env.get("INSFORGE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("INSFORGE_ANON_KEY") || Deno.env.get("ANON_KEY");
  if (!config || !baseUrl || !serviceKey || !anonKey || config.baseUrl !== baseUrl ||
    config.edgeFunctionToken !== serviceKey || config.anonKey !== anonKey || config.db?.schema || config.fetch) {
    throw new Error("qa_client_configuration_rejected");
  }
  for (const [key, value] of new Headers(config.headers)) {
    if (key !== "apikey" || value !== anonKey) throw new Error("qa_client_headers_rejected");
  }
  const users = transportUsers();
  const actualFetch = fetch;
  const client = createActualClient({ ...config, fetch: async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const options = init as { method?: string; headers?: HeadersInit; body?: unknown };
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers);
    if (url.origin !== new URL(baseUrl).origin || url.username || url.password || url.hash ||
      headers.get("Authorization") !== "Bearer " + serviceKey || headers.get("apikey") !== anonKey ||
      ["accept-profile", "content-profile"].some(name => headers.has(name) && headers.get(name) !== "public") ||
      Array.from(headers.keys()).some(name => !["authorization", "apikey", "accept", "accept-profile", "content-profile",
        "content-type", "prefer", "range", "range-unit"].includes(name))) throw new Error("qa_transport_not_allowed");
    const route = url.pathname.match(/^\/api\/database\/(records|rpc)\/([a-z_][a-z_0-9]*)$/);
    if (!route) throw new Error("qa_transport_not_allowed");
    const name = route[2];
    if (route[1] === "rpc") {
      const gift = Object.hasOwn(GIFT_RPC_ARGS, name);
      if ((!RPCS.has(name) && !gift) || method !== "POST" || typeof options.body !== "string") throw new Error("qa_transport_not_allowed");
      let args;
      try { args = JSON.parse(options.body); } catch { throw new Error("qa_transport_not_allowed"); }
      if (!args || Array.isArray(args) || typeof args !== "object" ||
        ((name.startsWith("tt_cloud_qa_cloud_") || gift) && args.p_environment !== "sandbox") ||
        (name !== RPC_MAP.cloud_ingest_usage && !users.has(String(args.p_user_id).toLowerCase()))) throw new Error("qa_transport_not_allowed");
      if (gift && (JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(GIFT_RPC_ARGS[name]) ||
          name === "cloud_redeem_gift" && (args.p_code_hash !== null && !/^[0-9a-f]{64}$/.test(args.p_code_hash || "") ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.p_request_id || "")))) {
        throw new Error("qa_gift_operation_rejected");
      }
    } else if (FINANCIAL_READS.has(name)) {
      if (method !== "GET" || options.body != null || !filteredUser(url, users) ||
        url.searchParams.getAll("environment").length !== 1 || url.searchParams.get("environment") !== "eq.sandbox") {
        throw new Error("qa_financial_read_only");
      }
    } else {
      if (!RECORDS.has(name)) throw new Error("qa_transport_not_allowed");
      if (name === TABLE_MAP.tokentracker_device_tokens &&
        (method !== "GET" || !/^eq\.[0-9a-f]{64}$/.test(url.searchParams.get("token_hash") || ""))) throw new Error("qa_transport_not_allowed");
      if (name === TABLE_MAP.tokentracker_devices &&
        (!["GET", "PATCH"].includes(method) || !filteredUser(url, users))) throw new Error("qa_transport_not_allowed");
      if (name === TABLE_MAP.tokentracker_device_codes && !["GET", "POST", "PATCH"].includes(method)) throw new Error("qa_transport_not_allowed");
      if (method === "GET" && options.body != null) throw new Error("qa_transport_not_allowed");
    }
    return await actualFetch(input, { ...init, redirect: "error" });
  } });
  const database = client.database;
  const qaDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "from") return (name: string) => {
        if (Object.hasOwn(TABLE_MAP, name)) return target.from(TABLE_MAP[name]);
        if (FINANCIAL_READS.has(name)) {
          // The original account action already scopes both user and sandbox.
          // Expose SELECT alone so no QA code can write financial evidence.
          return Object.freeze({ select: (columns?: string) => target.from(name).select(columns) });
        }
        throw new Error("qa_table_not_allowed");
      };
      if (property === "rpc") return (name: string, args?: Parameters<typeof target.rpc>[1], options?: Parameters<typeof target.rpc>[2]) => {
        if (Object.hasOwn(GIFT_RPC_ARGS, name)) return target.rpc(name, args, options);
        if (!Object.hasOwn(RPC_MAP, name)) throw new Error("qa_rpc_not_allowed");
        return target.rpc(RPC_MAP[name], args, options);
      };
      throw new Error("qa_database_operation_not_allowed");
    },
  });
  // Keep the actual SDK and its HTTP client private. Every delegated query
  // also passes the final transport checks after mutable PostgREST builders.
  return new Proxy(Object.freeze({ database: qaDatabase }), { get(target, property) {
    if (property === "database") return target.database;
    throw new Error("qa_client_operation_not_allowed");
  } });
}
