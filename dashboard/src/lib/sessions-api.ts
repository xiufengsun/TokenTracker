// Local-only session browser client. The backing endpoint retains the raw
// session id and local project path so the dashboard can offer one-click
// resume; it is never served from the cloud account view.
import { copy } from "./copy";

const SLUG = "tokentracker-sessions";

export type SessionSource = "claude" | "codex" | "grok";

// Every field here is always present: the server densifies model_usage rows at
// the response boundary (modelUsageForAggregation in src/lib/session-analytics.js),
// so the sparse on-disk sidecar shape never reaches this client. Adding a field
// here means adding it to MODEL_USAGE_SUM_FIELDS there; test/session-analytics
// .test.js asserts the emitted key set matches for both producer paths.
export interface SessionModelUsage {
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  long_context_input_tokens: number;
  long_context_cached_input_tokens: number;
  long_context_cache_creation_input_tokens: number;
  long_context_output_tokens: number;
  long_context_reasoning_output_tokens: number;
  priority_input_tokens: number;
  priority_cached_input_tokens: number;
  priority_cache_creation_input_tokens: number;
  priority_output_tokens: number;
  priority_reasoning_output_tokens: number;
  priority_long_context_input_tokens: number;
  priority_long_context_cached_input_tokens: number;
  priority_long_context_cache_creation_input_tokens: number;
  priority_long_context_output_tokens: number;
  priority_long_context_reasoning_output_tokens: number;
  usage_events: number;
  rerouted_usage_events: number;
  long_context_usage_events: number;
  priority_usage_events: number;
  edit_turns: number;
  selected_models: string[];
  reroute_reasons: string[];
  model_attribution: "selected" | "effective";
  cost_usd: number;
}

export interface SessionRow {
  session_hash: string;
  session_id: string | null;
  parent_session_id: string | null;
  parent_session_hash: string | null;
  root_session_hash: string;
  thread_kind: "root" | "subagent";
  agent_nickname: string | null;
  agent_role: string | null;
  orphaned_subagent: boolean;
  parent_link_conflict: boolean;
  title: string | null;
  source: SessionSource;
  project_key: string;
  project_ref: string | null;
  model: string;
  // Optional for version skew only: a desktop app whose bundled EmbeddedServer
  // predates model_usage omits the field entirely (same skew the 404 branch in
  // fetchSessions handles). A current server always sends a dense array.
  model_usage?: SessionModelUsage[];
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
  turns: number;
  edit_turns: number;
  retry_turns: number;
  subagent_calls: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  direct_subagent_count: number;
  descendant_subagent_count: number;
  own_total_tokens: number;
  subagent_total_tokens: number;
  combined_total_tokens: number;
  total_tokens: number;
  own_cost_usd: number;
  subagent_cost_usd: number;
  combined_cost_usd: number;
  cost_usd: number;
  cost_source: "provider_reported" | "model_pricing" | "mixed" | null;
  usage_precision: "reported" | "reported_incomplete" | "mixed" | "unavailable" | null;
  usage_is_incomplete: boolean;
  cost_is_partial: boolean;
  usage_events: number;
  model_calls: number;
  api_duration_ms: number;
  context_tokens_used: number;
  context_window_tokens: number;
  context_usage_percent: number;
  tool_calls: number;
  tool_failures: number;
  error_count: number;
  compaction_count: number;
  productive: boolean;
  first_pass: boolean;
  resume_command: string | null;
}

export interface SessionsResponse {
  from: string;
  to: string;
  available: boolean;
  session_count: number;
  returned_count: number;
  sessions: SessionRow[];
  provenance?: Record<string, unknown>;
  error?: string;
}

interface FetchOptions {
  from?: string;
  to?: string;
  limit?: number;
  refresh?: boolean;
}

export async function getSessions(options: FetchOptions = {}): Promise<SessionsResponse> {
  const url = new URL(`/functions/${SLUG}`, window.location.origin);
  if (options.from) url.searchParams.set("from", options.from);
  if (options.to) url.searchParams.set("to", options.to);
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (options.refresh) url.searchParams.set("refresh", "1");
  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    // A 404 here means the local server predates this endpoint — i.e. a desktop
    // app whose bundled EmbeddedServer is older than the dashboard it hosts.
    // "HTTP 404" tells the user nothing actionable; "update the app" does.
    const fallback =
      response.status === 404
        ? copy("sessions.error.outdated_app")
        : `Request failed with HTTP ${response.status}`;
    const err = new Error(payload?.error || fallback) as Error & {
      status?: number;
    };
    err.status = response.status;
    throw err;
  }
  return payload as SessionsResponse;
}
