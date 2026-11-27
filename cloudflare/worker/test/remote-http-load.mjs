// Bounded, open-loop HTTPS test against the synthetic sandbox only. Input owner is pre-provisioned.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const [ownerFile, receiptFile] = process.argv.slice(2);
const qa = JSON.parse(readFileSync(ownerFile, "utf8"));
const origin =
  "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev";
assert.equal(qa.TT_QA_BASE_URL, origin);
assert.match(qa.TT_QA_EMAIL, /^tt-cf-load-[a-f\d-]+@example\.invalid$/);
const run = randomUUID().slice(0, 8);
const day = new Date().toISOString().slice(0, 10);
const at = day + "T00:00:00.000Z";
const api = "/functions/tokentracker-";
const summaryPath = api + "account-summary?from=" + day + "&to=" + day;
let credential, refresh;
const output = {
  started_at: new Date().toISOString(),
  run,
  scope: "dedicated synthetic account, trial entitlement, QA Worker over HTTPS",
  reference_rps: 9000000 / (30 * 86400),
  mix: "45% authenticated summary, 35% public community, 20% authenticated ingest",
  scenarios: [],
};
const send = async (path, body, token) => {
  const start = performance.now();
  try {
    const res = await fetch(origin + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: "non_json" };
    }
    return {
      status: res.status,
      ms: performance.now() - start,
      data,
      ray: res.headers.get("cf-ray")?.split("-").pop() || "",
      bytes: Buffer.byteLength(raw),
    };
  } catch (e) {
    return {
      status: 0,
      ms: performance.now() - start,
      data: { error: e.name },
      ray: "",
      bytes: 0,
    };
  }
};
const need = async (path, b, t) => {
  const r = await send(path, b, t);
  if (r.status !== 200)
    throw Error(
      path.split("?")[0] +
        " returned " +
        r.status +
        " " +
        String(r.data.code || r.data.error || "").slice(0, 70),
    );
  return r.data;
};
function metrics(rows) {
  if (!rows.length) return { n: 0 };
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const q = (percent) =>
    Math.round(sorted[Math.max(0, Math.ceil(percent * rows.length) - 1)]);
  const statuses = {},
    errors = {};
  for (const r of rows) {
    statuses[r.status] = (statuses[r.status] || 0) + 1;
    if (!r.ok) {
      const code = String(
        r.data?.code || r.data?.error || "unexpected_response",
      ).slice(0, 70);
      errors[code] = (errors[code] || 0) + 1;
    }
  }
  return {
    n: rows.length,
    statuses,
    errors,
    p50_ms: q(0.5),
    p95_ms: q(0.95),
    p99_ms: q(0.99),
  };
}
try {
  const cat = await need(api + "billing?action=catalog");
  assert.equal(cat.environment, "sandbox");
  const auth = await need("/api/auth/sessions?client_type=mobile", {
    email: qa.TT_QA_EMAIL,
    password: qa.TT_QA_PASSWORD,
  });
  assert.equal(auth.user.id, qa.TT_QA_ID);
  credential = auth.accessToken;
  refresh = auth.refreshToken;
  const account = await need(api + "billing?action=account", null, credential);
  assert.equal(account.environment, "sandbox");
  assert.equal(account.payments.length, 0);
  const trial = await need(api + "billing?action=trial", {}, credential);
  assert.equal(trial.membership.status, "trial");
  const devices = [];
  for (let i = 0; i < 4; i++) {
    const d = await need(
      api + "device-token-issue",
      {
        machine_id: "tt-load-" + run + "-" + i,
        device_name: "HTTPS QA " + run + " " + i,
        platform: "synthetic",
      },
      credential,
    );
    assert.ok(d.device_id && d.token);
    devices.push({ id: d.device_id, token: d.token, upload: randomUUID() });
  }
  const baseline = (await need(summaryPath, null, credential)).totals;
  const writes = [];
  const accepted = new Map();
  let index = 0;
  async function call(kind, scenario, override) {
    let r, key, val;
    if (kind === "write") {
      const id = ++index;
      const device = override ?? devices[id % 4];
      key = "tt-load-" + run + "-" + id;
      val = 1000 + id;
      const body = {
        upload_id: device.upload,
        buckets: [
          {
            hour_start: at,
            source: "codex",
            model: key,
            input_tokens: val,
            total_tokens: val,
            billable_total_tokens: val,
            conversation_count: 1,
          },
        ],
      };
      r = await send(api + "ingest", body, device.token);
      r.ok =
        r.status === 200 &&
        r.data.inserted === 1 &&
        r.data.ok === true &&
        r.data.upload_scope === "cloud";
      if (r.ok) accepted.set(key, val);
      writes.push({ id, device, body, accepted: r.ok });
    } else if (kind === "summary") {
      r = await send(summaryPath, null, credential);
      r.ok =
        r.status === 200 &&
        r.data.from === day &&
        Number.isSafeInteger(r.data.totals?.total_tokens);
    } else {
      r = await send(api + "community-models", null, null);
      r.ok =
        r.status === 200 &&
        r.data.period === "total" &&
        Array.isArray(r.data.top_models);
    }
    return { ...r, kind, scenario };
  }
  async function mixed(name, count, rate) {
    const start = performance.now(),
      rows = [],
      inflight = new Set();
    let lag = 0,
      peak = 0;
    for (let i = 0; i < count; i++) {
      const due = start + (i * 1000) / rate;
      const wait = due - performance.now();
      if (wait > 0) await delay(wait);
      lag = Math.max(lag, performance.now() - due);
      const mod = (i * 7) % 20,
        kind = mod < 9 ? "summary" : mod < 16 ? "public" : "write";
      const task = call(kind, name).then((row) => rows.push(row));
      inflight.add(task);
      task.finally(() => inflight.delete(task));
      peak = Math.max(peak, inflight.size);
      if (inflight.size >= 48) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    const seconds = (performance.now() - start) / 1000;
    const result = {
      name,
      target_rps: rate,
      elapsed_s: +seconds.toFixed(2),
      achieved_rps: +(count / seconds).toFixed(2),
      max_inflight: peak,
      max_schedule_lag_ms: Math.round(lag),
      overall: metrics(rows),
      routes: Object.fromEntries(
        ["summary", "public", "write"].map((k) => [
          k,
          metrics(rows.filter((r) => r.kind === k)),
        ]),
      ),
      pops: [...new Set(rows.map((r) => r.ray).filter(Boolean))],
    };
    output.scenarios.push(result);
    console.log(JSON.stringify(result));
  }
  await mixed("reference mean", 105, 3.5);
  await mixed("4x reference", 280, 14);
  const burstAt = performance.now();
  const burst = await Promise.all(
    Array.from({ length: 10 }, () =>
      call("write", "same device burst", devices[0]),
    ),
  );
  const burstSecs = (performance.now() - burstAt) / 1000;
  const burstResult = {
    name: "same device burst",
    max_inflight: 10,
    elapsed_s: +burstSecs.toFixed(2),
    achieved_rps: +(10 / burstSecs).toFixed(2),
    overall: metrics(burst),
  };
  output.scenarios.push(burstResult);
  console.log(JSON.stringify(burstResult));
  const expected = (sum) => [...accepted.values()].reduce((a, b) => a + b, sum);
  const totals = (await need(summaryPath, null, credential)).totals;
  assert.equal(totals.total_tokens, expected(baseline.total_tokens));
  assert.equal(
    totals.billable_total_tokens,
    expected(baseline.billable_total_tokens),
  );
  assert.equal(totals.input_tokens, expected(baseline.input_tokens));
  assert.equal(
    totals.conversation_count,
    baseline.conversation_count + accepted.size,
  );
  const sample = writes.find((w) => w.accepted);
  assert.ok(sample);
  const replay = await need(api + "ingest", sample.body, sample.device.token);
  assert.equal(replay.inserted, 1);
  assert.deepEqual((await need(summaryPath, null, credential)).totals, totals);
  output.integrity = {
    attempted_unique_buckets: writes.length,
    accepted_unique_buckets: accepted.size,
    baseline_tokens: baseline.total_tokens,
    delta_tokens: totals.total_tokens - baseline.total_tokens,
    delta_conversations:
      totals.conversation_count - baseline.conversation_count,
    all_accepted_buckets_accounted_for: true,
    replay_unchanged: true,
  };
  const dbId = "607710e9-2229-460a-bb47-0256130c9e4b";
  const cli = fileURLToPath(
    new URL("../node_modules/.bin/cf", import.meta.url),
  );
  const target = JSON.parse(
    execFileSync(cli, ["d1", "get", dbId], {
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  assert.equal(target.name, "tokentracker-backend-qa");
  assert.match(qa.TT_QA_ID, /^[a-f0-9-]{36}$/);
  const sql = `SELECT model,total_tokens,input_tokens,billable_total_tokens,conversations,device_id FROM tokentracker_hourly
   WHERE user_id='${qa.TT_QA_ID}' AND model LIKE 'tt-load-${run}-%'`;
  const ledger = JSON.parse(
    execFileSync(cli, ["d1", "query", dbId, "--sql", sql], {
      stdio: ["ignore", "pipe", "ignore"],
    }),
  )[0];
  assert.ok(ledger.success);
  assert.equal(ledger.results.length, accepted.size);
  const devicesByKey = new Map(
    writes
      .filter((w) => w.accepted)
      .map((w) => [w.body.buckets[0].model, w.device.id]),
  );
  for (const row of ledger.results) {
    const amount = accepted.get(row.model);
    assert.ok(amount !== undefined);
    assert.equal(row.device_id, devicesByKey.get(row.model));
    assert.equal(row.total_tokens, amount);
    assert.equal(row.input_tokens, amount);
    assert.equal(row.billable_total_tokens, amount);
    assert.equal(row.conversations, 1);
  }
  output.integrity.direct_d1_row_values_and_ownership_matched =
    ledger.results.length;
  output.unexpected_responses = output.scenarios.reduce(
    (n, s) => n + Object.values(s.overall.errors).reduce((a, b) => a + b, 0),
    0,
  );
  if (output.unexpected_responses) process.exitCode = 1;
  output.finished_at = new Date().toISOString();
  console.log(JSON.stringify(output.integrity));
} finally {
  if (refresh)
    await send("/api/auth/logout?client_type=mobile", {
      refreshToken: refresh,
    });
  writeFileSync(receiptFile, JSON.stringify(output, null, 2) + "\n", {
    mode: 0o600,
  });
}
