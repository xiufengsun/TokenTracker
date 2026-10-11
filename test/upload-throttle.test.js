const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  DEFAULTS,
  normalizeState,
  decideAutoUpload,
  recordUploadSuccess,
  recordUploadFailure,
  parseRetryAfterMs,
} = require("../src/lib/upload-throttle");

test("normalizeState tolerates null/invalid values", () => {
  const s = normalizeState({
    lastSuccessMs: "nope",
    nextAllowedAtMs: -1,
    backoffUntilMs: 0,
    backoffStep: "2",
  });
  assert.equal(s.version, 1);
  assert.equal(s.lastSuccessMs, 0);
  assert.equal(s.nextAllowedAtMs, 0);
  assert.equal(s.backoffUntilMs, 0);
  assert.equal(s.backoffStep, 2);
});

test("decideAutoUpload blocks when no pending bytes", () => {
  const d = decideAutoUpload({ nowMs: 1000, pendingBytes: 0, state: {}, config: null });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "no-pending");
});

test("decideAutoUpload blocks until nextAllowedAtMs", () => {
  const nowMs = 1_000_000;
  const d = decideAutoUpload({
    nowMs,
    pendingBytes: 123,
    state: { nextAllowedAtMs: nowMs + 10_000 },
    config: null,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "throttled");
  assert.equal(d.blockedUntilMs, nowMs + 10_000);
});

test("decideAutoUpload chooses large drain when backlogBytes reached", () => {
  const nowMs = 1_000_000;
  const d = decideAutoUpload({
    nowMs,
    pendingBytes: DEFAULTS.backlogBytes,
    state: { nextAllowedAtMs: 0 },
    config: null,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.maxBatches, DEFAULTS.maxBatchesLarge);
  assert.equal(d.batchSize, DEFAULTS.batchSize);
});

test("recordUploadSuccess sets nextAllowedAtMs and resets backoff", () => {
  const nowMs = 10_000;
  const s = recordUploadSuccess({
    nowMs,
    state: { backoffStep: 3, backoffUntilMs: nowMs + 999_999 },
    randInt: () => 0,
  });
  assert.equal(s.lastSuccessMs, nowMs);
  assert.equal(s.backoffStep, 0);
  assert.equal(s.backoffUntilMs, 0);
  assert.equal(s.nextAllowedAtMs, nowMs + DEFAULTS.intervalMs);
});

test("recordUploadFailure uses Retry-After for 429", () => {
  const nowMs = 10_000;
  const s = recordUploadFailure({
    nowMs,
    state: { backoffStep: 0, nextAllowedAtMs: 0 },
    error: { status: 429, retryAfterMs: 120_000, message: "too many requests" },
  });
  assert.equal(s.backoffUntilMs, nowMs + 120_000);
  assert.equal(s.nextAllowedAtMs, nowMs + 120_000);
  assert.equal(s.backoffStep, 1);
  assert.ok(typeof s.lastErrorAt === "string" && s.lastErrorAt.length > 0);
  assert.ok(typeof s.lastError === "string" && s.lastError.includes("too many requests"));
});

test("recordUploadFailure exponential backoff on non-429", () => {
  const nowMs = 10_000;
  const s1 = recordUploadFailure({
    nowMs,
    state: { backoffStep: 0, nextAllowedAtMs: 0 },
    error: { status: 500, message: "server error" },
  });
  const s2 = recordUploadFailure({
    nowMs,
    state: s1,
    error: { status: 500, message: "server error" },
  });
  assert.equal(s1.backoffUntilMs, nowMs + DEFAULTS.backoffInitialMs);
  assert.equal(s2.backoffUntilMs, nowMs + DEFAULTS.backoffInitialMs * 2);
});

test("parseRetryAfterMs parses seconds and HTTP-date", () => {
  assert.equal(parseRetryAfterMs("2", 1000), 2000);
  const d = new Date(10_000).toUTCString();
  assert.equal(parseRetryAfterMs(d, 0), 10_000);
  assert.equal(parseRetryAfterMs("invalid"), null);
});


test("server Cloud intervals persist across restarts and daily retry deadlines are not shortened", () => {
  const nowMs=Date.now();
  const daily=recordUploadSuccess({nowMs,state:{},randInt:()=>0,
    cloudAccess:{next_allowed_at:new Date(nowMs+86400_000).toISOString(),sync_interval_seconds:86400}});
  assert.equal(normalizeState(daily).serverNextAllowedAtMs,nowMs+86400_000);
  assert.equal(daily.nextAllowedAtMs,nowMs+86400_000);
  const denied=recordUploadFailure({nowMs,state:{},error:{status:429,code:"cloud_sync_throttled",retryAfterMs:20*3600_000}});
  assert.equal(denied.backoffUntilMs,nowMs+20*3600_000);
  assert.equal(denied.serverNextAllowedAtMs,denied.backoffUntilMs);
  const transient=recordUploadFailure({nowMs,state:{},error:{status:503,retryAfterMs:20*3600_000}});
  assert.equal(transient.backoffUntilMs,nowMs+20*3600_000);
});


test("any explicit Retry-After outlives the ordinary exponential-backoff cap", () => {
  const nowMs = Date.now();
  const state = recordUploadFailure({ nowMs, state: {}, error: { status: 429, retryAfterMs: 7200_000 } });
  assert.equal(state.backoffUntilMs, nowMs + 7200_000);
  assert.equal(decideAutoUpload({ nowMs: nowMs + 3600_000, pendingBytes: 1, state }).allowed, false);
});


test("a changed Cloud server deadline replaces an old community success deadline while transport errors preserve it", () => {
  const nowMs=Date.now(); const state={nextAllowedAtMs:nowMs+86400_000,serverNextAllowedAtMs:nowMs+86400_000};
  const changed=recordUploadFailure({nowMs,state,error:{status:429,code:'cloud_sync_throttled',retryAfterMs:900_000}});
  assert.equal(changed.nextAllowedAtMs,nowMs+900_000);assert.equal(changed.serverNextAllowedAtMs,changed.nextAllowedAtMs);
  const network=recordUploadFailure({nowMs,state,error:{status:503,retryAfterMs:60_000}});
  assert.equal(network.nextAllowedAtMs,state.nextAllowedAtMs);assert.equal(network.serverNextAllowedAtMs,state.serverNextAllowedAtMs);
  for(const error of [{status:403,code:'cloud_sync_throttled',retryAfterMs:60_000},{status:429,code:'cloud_sync_throttled'}]) {
    const unconfirmed=recordUploadFailure({nowMs,state,error});
    assert.equal(unconfirmed.nextAllowedAtMs,state.nextAllowedAtMs);assert.equal(unconfirmed.serverNextAllowedAtMs,state.serverNextAllowedAtMs);
  }
});

test("self-hosted zero server interval preserves jitter and unchanged real queues never upload again", () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tt-selfhost-throttle-"));
  try {
    const queue = path.join(directory, "queue.jsonl");
    fs.writeFileSync(queue, '{"total_tokens":123}\n');
    const offset = fs.statSync(queue).size; const nowMs = Date.now();
    const state = recordUploadSuccess({ nowMs, state: {}, randInt: () => 400,
      cloudAccess: { sync_interval_seconds: 0, next_allowed_at: new Date(nowMs).toISOString() } });
    assert.equal(state.nextAllowedAtMs, nowMs + 400);
    assert.equal(decideAutoUpload({ nowMs: nowMs + 401, pendingBytes: fs.statSync(queue).size - offset, state }).reason, "no-pending");
    fs.appendFileSync(queue, '{"total_tokens":456}\n');
    assert.equal(decideAutoUpload({ nowMs: nowMs + 399, pendingBytes: fs.statSync(queue).size - offset, state }).allowed, false);
    assert.equal(decideAutoUpload({ nowMs: nowMs + 401, pendingBytes: fs.statSync(queue).size - offset, state }).allowed, true);
    for (const value of [undefined, null, false, true, "", "bad", NaN, -1]) {
      const fallback = recordUploadSuccess({ nowMs, state: {}, randInt: () => 0, cloudAccess: { sync_interval_seconds: value } });
      assert.equal(fallback.nextAllowedAtMs, nowMs + DEFAULTS.intervalMs);
    }
    const daily = recordUploadSuccess({ nowMs, state: {}, randInt: () => 0, cloudAccess: { sync_interval_seconds: 86400 } });
    assert.equal(daily.nextAllowedAtMs, nowMs + 86400_000);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
