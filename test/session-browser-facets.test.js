const assert = require("node:assert/strict");
const { test } = require("node:test");

const { listSessionsForBrowser } = require("../src/lib/session-analytics");

const TOKEN_FIELDS = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
};

function bucket(timestamp, total) {
  return {
    timestamp,
    model: "model-a",
    ...TOKEN_FIELDS,
    input_tokens: total,
    total_tokens: total,
    cost_usd: total / 1000,
  };
}

function row(overrides = {}) {
  const total = overrides.total_tokens ?? 15;
  return {
    session_hash: "hash-a",
    session_id: "id-a",
    source: "claude",
    project_key: "project-a",
    project_ref: "/project-a",
    model: "model-a",
    started_at: "2026-07-18T01:00:00Z",
    ended_at: "2026-07-18T02:00:00Z",
    tokens: { ...TOKEN_FIELDS, input_tokens: total, total_tokens: total },
    model_usage: [{ model: "model-a", ...TOKEN_FIELDS, input_tokens: total, total_tokens: total, cost_usd: total / 1000 }],
    total_tokens: total,
    cost_usd: total / 1000,
    usage_buckets: [bucket("2026-07-18T01:10:00Z", 10), bucket("2026-07-19T01:10:00Z", 5)],
    ...overrides,
  };
}

test("session browser omits usage buckets on request and keeps lifetime facets", () => {
  const rows = [
    row(),
    row({
      session_hash: "hash-b",
      session_id: "id-b",
      project_key: "project-b",
      model: "model-b",
      started_at: "2026-06-01T01:00:00Z",
      ended_at: "2026-06-01T02:00:00Z",
      tokens: { ...TOKEN_FIELDS, input_tokens: 4, total_tokens: 4 },
      model_usage: [{ model: "model-b", ...TOKEN_FIELDS, input_tokens: 4, total_tokens: 4, cost_usd: 0.004 }],
      total_tokens: 4,
      cost_usd: 0.004,
      usage_buckets: [bucket("2026-06-01T01:10:00Z", 4)],
    }),
  ];

  const full = listSessionsForBrowser(rows);
  assert.equal(full.sessions.find((session) => session.session_hash === "hash-a").usage_buckets.length, 2);

  const summary = listSessionsForBrowser(rows, {
    from: "2026-07-18",
    to: "2026-07-18",
    includeBuckets: false,
  });
  assert.equal(summary.session_count, 1);
  assert.equal(summary.lifetime_session_count, 2);
  assert.equal(summary.sessions[0].total_tokens, 10);
  assert.equal(Object.hasOwn(summary.sessions[0], "usage_buckets"), false);
  assert.deepEqual(summary.facets, {
    projects: ["project-a", "project-b"],
    models: ["model-a", "model-b"],
  });
});

test("session browser keeps model performance while scoping", () => {
  const performance = {
    estimated_output_tokens: 100,
    estimated_duration_ms: 2000,
    estimated_request_count: 1,
    first_response_total_ms: 200,
    first_response_sample_count: 1,
  };
  const scoped = row({
    model_usage: [{ model: "model-a", ...TOKEN_FIELDS, total_tokens: 15, cost_usd: 0.015, performance }],
  });

  const result = listSessionsForBrowser([scoped], {
    from: "2026-07-18",
    to: "2026-07-18",
    includeBuckets: false,
  });

  assert.deepEqual(result.sessions[0].model_usage[0].performance, {
    ...performance,
    estimated_tokens_per_second: 50,
    first_response_ms: 200,
  });
});

test("session browser facets only offer models the returned rows carry", () => {
  const legacy = row({
    session_hash: "legacy-row",
    session_id: "legacy-id",
    model_usage: undefined,
    usage_buckets: [
      { ...bucket("2026-07-18T01:10:00Z", 10), model: "legacy-model" },
    ],
  });

  const result = listSessionsForBrowser([legacy], {
    from: "2026-07-18",
    to: "2026-07-18",
    includeBuckets: false,
  });

  assert.deepEqual(result.facets, { projects: ["project-a"], models: ["model-a"] });
  assert.deepEqual(result.sessions[0].model_usage.map((usage) => usage.model), ["model-a"]);
  assert.equal(Object.hasOwn(result.sessions[0], "usage_buckets"), false);
});
