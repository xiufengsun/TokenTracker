export function sessionOwnTokens(session) {
  return finiteValue(session?.own_total_tokens ?? session?.total_tokens);
}

export function scopeSessionsToRange(sessions, startMs = 0, endMs = Infinity) {
  if (!startMs && endMs === Infinity) return sessions;
  const rows = sessions.map((session) => {
    if (!Array.isArray(session.usage_buckets)) return { ...session };
    const buckets = session.usage_buckets.filter((bucket) => {
      const ms = Date.parse(bucket.timestamp);
      return ms >= startMs && ms <= endMs;
    });
    const models = new Map();
    const totals = Object.fromEntries([...USAGE_FIELDS, ...PRICING_FIELDS].map((key) => [key, 0]));
    let tokens = 0;
    let cost = 0;
    for (const bucket of buckets) {
      tokens += finiteValue(bucket.total_tokens);
      cost += finiteValue(bucket.cost_usd);
      const row = models.get(bucket.model) || {
        ...(session.model_usage || []).find((model) => model.model === bucket.model),
        model: bucket.model, ...Object.fromEntries([...USAGE_FIELDS, ...PRICING_FIELDS].map((key) => [key, 0])), cost_usd: 0,
        selected_models: [], reroute_reasons: [], model_attribution: "selected",
      };
      for (const key of [...USAGE_FIELDS, ...PRICING_FIELDS]) {
        const value = finiteValue(bucket[key]);
        totals[key] += value;
        row[key] += value;
      }
      row.cost_usd += finiteValue(bucket.cost_usd);
      for (const field of ["selected_models", "reroute_reasons"]) {
        if (Array.isArray(bucket[field])) row[field] = [...new Set([...row[field], ...bucket[field]])];
      }
      if (bucket.model_attribution === "effective") row.model_attribution = "effective";
      models.set(bucket.model, row);
    }
    return { ...session, ...totals, total_tokens: tokens, own_total_tokens: tokens,
      cost_usd: cost, own_cost_usd: cost, model_usage: [...models.values()] };
  }).filter((row) => !Array.isArray(row.usage_buckets) || sessionOwnTokens(row) > 0);
  const children = new Map();
  for (const row of rows) {
    if (!row.parent_session_hash) continue;
    const group = children.get(row.parent_session_hash) || [];
    group.push(row);
    children.set(row.parent_session_hash, group);
  }
  const sum = (row, seen = new Set()) => {
    if (seen.has(row.session_hash)) return { tokens: 0, cost: 0 };
    const next = new Set(seen).add(row.session_hash);
    let tokens = sessionOwnTokens(row), cost = sessionOwnCost(row);
    for (const child of children.get(row.session_hash) || []) {
      const nested = sum(child, next);
      tokens += nested.tokens;
      cost += nested.cost;
    }
    return { tokens, cost };
  };
  for (const row of rows) {
    const total = sum(row);
    row.combined_total_tokens = total.tokens;
    row.combined_cost_usd = total.cost;
    row.subagent_total_tokens = total.tokens - sessionOwnTokens(row);
    row.subagent_cost_usd = total.cost - sessionOwnCost(row);
  }
  return rows;
}

export function sessionOwnCost(session) {
  return finiteValue(session?.own_cost_usd ?? session?.cost_usd);
}

function finiteValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

const USAGE_FIELDS = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "reasoning_output_tokens", "total_tokens"];
const PRICING_FIELDS = ["long_context_", "priority_", "priority_long_context_"].flatMap((prefix) => USAGE_FIELDS.filter((field) => field !== "total_tokens").map((field) => prefix + field));

export function sessionModels(session) {
  const observed = Array.isArray(session?.model_usage)
    ? session.model_usage.filter((row) => row && typeof row.model === "string" && row.model)
    : [];
  if (observed.length) return observed;
  return [{
    model: session?.model || "",
    total_tokens: sessionOwnTokens(session),
    cost_usd: sessionOwnCost(session),
    performance: session?.performance,
  }];
}

export function aggregateSessionPerformance(sessions) {
  const total = {
    estimated_output_tokens: 0,
    estimated_duration_ms: 0,
    estimated_request_count: 0,
    estimated_tokens_per_second: null,
    first_response_total_ms: 0,
    first_response_sample_count: 0,
    first_response_ms: null,
  };
  for (const session of sessions) {
    const performance = session?.performance;
    if (!performance) continue;
    const duration = finiteValue(performance.estimated_duration_ms);
    const output = finiteValue(performance.estimated_output_tokens);
    const count = finiteValue(performance.estimated_request_count);
    if (duration > 0 && output > 0 && count > 0) {
      total.estimated_output_tokens += output;
      total.estimated_duration_ms += duration;
      total.estimated_request_count += count;
    }
    const firstCount = finiteValue(performance.first_response_sample_count);
    const firstTotal = finiteValue(performance.first_response_total_ms);
    if (firstCount > 0 && firstTotal > 0) {
      total.first_response_total_ms += firstTotal;
      total.first_response_sample_count += firstCount;
    }
  }
  if (total.estimated_duration_ms > 0) {
    total.estimated_tokens_per_second = total.estimated_output_tokens * 1000 / total.estimated_duration_ms;
  }
  if (total.first_response_sample_count > 0) {
    total.first_response_ms = total.first_response_total_ms / total.first_response_sample_count;
  }
  return total;
}

export function summarizeSessions(sessions) {
  const seen = new Set();
  const distinct = sessions.filter((session) => {
    if (seen.has(session.session_hash)) return false;
    seen.add(session.session_hash);
    return true;
  });
  return {
    count: distinct.length,
    tokens: distinct.reduce((sum, session) => sum + sessionOwnTokens(session), 0),
    cost: distinct.reduce((sum, session) => sum + sessionOwnCost(session), 0),
    costIsPartial: distinct.some((session) => session.cost_is_partial),
    performance: aggregateSessionPerformance(distinct),
  };
}

export function sessionDateMs(session) {
  const date = Date.parse(session?.ended_at || session?.started_at || "");
  return Number.isFinite(date) ? date : 0;
}

export function sortSessions(sessions, sort) {
  return [...sessions].sort((a, b) => {
    const difference = sort === "cost"
      ? sessionOwnCost(b) - sessionOwnCost(a)
      : sort === "tokens"
        ? sessionOwnTokens(b) - sessionOwnTokens(a)
        : 0;
    return difference || sessionDateMs(b) - sessionDateMs(a);
  });
}

export function sessionDayKey(session) {
  const time = sessionDateMs(session);
  if (!time) return "";
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function groupSessions(sessions, mode) {
  const groups = new Map();
  for (const session of sessions) {
    const key = mode === "project" ? session.project_key || "" : sessionDayKey(session);
    const group = groups.get(key) || { key, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function parseSessionFilters(search) {
  const params = new URLSearchParams(search);
  const source = params.get("source");
  const dateValue = (key) => {
    const value = params.get(key) || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const date = new Date(`${value}T00:00:00`);
    return Number.isFinite(date.getTime()) && sessionDayKey({ ended_at: date.toISOString() }) === value ? value : "";
  };
  const from = dateValue("from");
  const to = dateValue("to");
  return {
    source: ["claude", "codex", "grok"].includes(source) ? source : "all",
    model: params.get("model") || "all",
    from,
    to,
  };
}

export function overlapsSessionDates(session, from, to) {
  let startMs = from ? new Date(`${from}T00:00:00`).getTime() : 0;
  let endMs = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
  if (startMs > endMs) {
    startMs = new Date(`${to}T00:00:00`).getTime();
    endMs = new Date(`${from}T23:59:59.999`).getTime();
  }
  const ended = Date.parse(session.ended_at || session.started_at || "");
  const started = Date.parse(session.started_at || session.ended_at || "");
  return (!Number.isFinite(ended) || ended >= startMs)
    && (!Number.isFinite(started) || started <= endMs);
}
