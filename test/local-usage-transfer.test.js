const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createLocalUsageTransfer } = require("../src/lib/local-usage-transfer");
const { computeRowCost, computeKnownRowCost } = require("../src/lib/pricing");

function row(total, extra = {}) {
  return { source: "codex", model: "gpt-5.5", hour_start: "2026-10-18T10:00:00.000Z",
    input_tokens: total - 10, output_tokens: 10, total_tokens: total, billable_total_tokens: total,
    cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0,
    conversation_count: 1, ...extra };
}
async function machine(t, id, rows, name = id) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tt-transfer-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const queuePath = path.join(home, "queue.jsonl");
  const write = (values) => fs.writeFile(queuePath, values.map(JSON.stringify).join("\n") + "\n");
  await write(rows);
  const service = createLocalUsageTransfer({ queuePath, normalizeRow: (r) => r,
    identity: () => ({ id, name, platform: "win32" }) });
  return { service, queuePath, write, home };
}
const total = (rows) => rows.reduce((n, r) => n + r.total_tokens, 0);
async function apply(service, snapshot) {
  const preview = await service.preview(snapshot);
  return service.importSnapshot(snapshot, preview.token);
}

test("last cumulative row wins per machine; imports are idempotent, replaceable and separately selectable", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(50), row(100)], "Laptop");
  const b = await machine(t, "machine-bbbb", [row(200)], "Laptop");
  const original = await fs.readFile(b.queuePath);
  const first = await a.service.exportSnapshot();
  assert.equal(total(first.rows), 100);
  const preview = await b.service.preview(first);
  assert.equal(preview.before, 200);
  assert.equal(preview.after, 300);
  assert.equal(total(await b.service.view([row(200)])), 200);
  await apply(b.service, first);
  await apply(b.service, first);
  assert.equal(total(await b.service.view([row(200)])), 300);
  const devices = await b.service.devices([row(200)], () => true);
  assert.equal(new Set(devices.devices.map((device) => device.device_name)).size, 2);
  assert.equal(total(await b.service.view([row(200)], "local:machine-aaaa")), 100);
  assert.equal(total(await b.service.view([row(200)], "local:machine-bbbb")), 200);
  assert.equal(total(await b.service.view([row(250)])), 350);
  await a.write([row(90)]);
  const corrected = await a.service.exportSnapshot();
  await apply(b.service, corrected);
  assert.equal(total(await b.service.view([row(200)])), 290);
  await apply(b.service, first);
  assert.equal(total(await b.service.view([row(200)])), 290);
  await a.write([]);
  await apply(b.service, await a.service.exportSnapshot());
  assert.equal(total(await b.service.view([row(200)])), 200);
  assert.deepEqual(await fs.readFile(b.queuePath), original);
});

test("exports contain only own device usage; round trips and account sources never accumulate", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(100), row(800, { source: "cursor" })]);
  const b = await machine(t, "machine-bbbb", [row(200)]);
  await apply(b.service, await a.service.exportSnapshot());
  const snapshot = await b.service.exportSnapshot();
  assert.equal(total(snapshot.rows), 200);
  await apply(a.service, snapshot);
  assert.equal(total(await a.service.view([row(100), row(800, { source: "cursor" })])), 1100);
  assert.equal(total(await a.service.view([row(100), row(800, { source: "cursor" })], "local:machine-aaaa")), 100);
  await assert.rejects(apply(a.service, await a.service.exportSnapshot()), { code: "self_import" });
});

test("previews follow the dashboard's aggregate billable fallback without rewriting raw usage", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(200, { billable_total_tokens: 180 })]);
  const b = await machine(t, "machine-bbbb", [row(200, { billable_total_tokens: 60 })]);
  const snapshot = await a.service.exportSnapshot();
  const preview = await b.service.preview(snapshot);
  assert.equal(preview.before, 60);
  assert.equal(preview.after, 240);
  await b.service.importSnapshot(snapshot, preview.token);
  const devices = await b.service.devices([row(200, { billable_total_tokens: 60 })], () => true);
  assert.deepEqual(devices.devices.map((device) => [device.total_tokens, device.billable_total_tokens]), [[200, 60], [200, 180]]);
  assert.equal(total(await b.service.view([row(200, { billable_total_tokens: 60 })])), 400);
  await a.write([row(200, { billable_total_tokens: 0 })]);
  const zero = await a.service.exportSnapshot();
  assert.equal((await b.service.preview(zero)).after, 60);
  const c = await machine(t, "machine-cccc", [row(100, { billable_total_tokens: 0 })]);
  assert.equal((await c.service.preview(zero)).after, 300);
});

test("partial accounting survives export, preview, import and device view", async (t) => {
  const partial = row(120, { input_tokens: 50, unclassified_input_tokens: 60, output_tokens: 10,
    total_cost_usd: null, known_cost_usd: 0.0042, cost_status: "partial" });
  const a = await machine(t, "machine-aaaa", [partial]);
  const b = await machine(t, "machine-bbbb", [row(200)]);
  const snapshot = await a.service.exportSnapshot();
  assert.equal(snapshot.rows[0].unclassified_input_tokens, 60);
  assert.equal(snapshot.rows[0].total_cost_usd, null);
  assert.equal(snapshot.rows[0].known_cost_usd, undefined);
  const preview = await b.service.preview(snapshot);
  assert.equal(preview.after, 320);
  await b.service.importSnapshot(snapshot, preview.token);
  const imported = await b.service.view([row(200)], "local:machine-aaaa");
  assert.equal(imported[0].unclassified_input_tokens, 60);
  assert.equal(imported[0].total_cost_usd, null);
  assert.equal(imported[0].input_tokens, 50);
  assert.equal(imported[0].total_tokens, 120);
  assert.equal(computeRowCost(imported[0]), null);
  assert.equal(computeKnownRowCost(imported[0]), computeKnownRowCost(partial));
});

test("invalid, conflicting and stale previews cannot change the committed ledger", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(100)]);
  const b = await machine(t, "machine-bbbb", [row(200)]);
  const snapshot = await a.service.exportSnapshot();
  const preview = await b.service.preview(snapshot);
  await b.write([row(210)]);
  await assert.rejects(b.service.importSnapshot(snapshot, preview.token), { code: "preview_changed" });
  await apply(b.service, snapshot);
  const changed = structuredClone(snapshot);
  changed.rows[0].total_tokens = 900;
  await assert.rejects(b.service.preview(changed), { code: "snapshot_conflict" });
  for (const invalid of [NaN, -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = structuredClone(snapshot);
    bad.rows[0].input_tokens = invalid;
    await assert.rejects(b.service.preview(bad), { code: "invalid_snapshot" });
  }
  for (const invalid of [-1, 1.5, "4", "-2"]) {
    const bad = structuredClone(snapshot);
    bad.rows[0].unclassified_input_tokens = invalid;
    await assert.rejects(b.service.preview(bad), { code: "invalid_snapshot" });
  }
  const nullCostComplete = structuredClone(snapshot);
  nullCostComplete.rows[0].total_cost_usd = null;
  await assert.rejects(b.service.preview(nullCostComplete), { code: "invalid_snapshot" });
  await assert.rejects(b.service.view([row(210)], "local:unknown"), { code: "unknown_device" });
  assert.equal(total(await b.service.view([row(210)])), 310);
});

test("removing an import preserves own data; re-opening the service retains imports", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(100)]);
  const b = await machine(t, "machine-bbbb", [row(200)]);
  await apply(b.service, await a.service.exportSnapshot());
  const reopened = createLocalUsageTransfer({ queuePath: b.queuePath, normalizeRow: (r) => r,
    identity: () => ({ id: "machine-bbbb", name: "B", platform: "win32" }) });
  assert.equal(total(await reopened.view([row(200)])), 300);
  await reopened.remove("machine-aaaa");
  assert.equal(total(await reopened.view([row(200)])), 200);
});

test("preview rejects snapshots that only exceed MAX_BYTES after cleanRow normalization", async (t) => {
  const { MAX_BYTES } = require("../src/lib/local-usage-transfer");
  const b = await machine(t, "machine-bbbb", [row(200)]);
  const beforeView = total(await b.service.view([row(200)]));
  const makeRow = (i) => ({
    source: "codex",
    model: "m",
    hour_start: new Date(Date.UTC(2026, 0, 1) + i * 1_800_000).toISOString(),
    input_tokens: 1,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 1,
    conversation_count: 1,
  });
  const base = {
    schema: "tokentracker.local-usage.v1",
    scope: "device-history",
    machine: { id: "machine-aaaa", name: "A", platform: "darwin" },
    sequence: 1,
    exported_at: "2026-10-18T12:00:00.000Z",
  };
  const growthPerRow = Buffer.byteLength(JSON.stringify({ billable_total_tokens: 1 })) - 2; // rough ,"billable_total_tokens":1
  // Build just under the raw limit, then confirm normalization would exceed it.
  let lo = 1;
  let hi = 80_000;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    const raw = Buffer.byteLength(JSON.stringify({
      ...base,
      rows: Array.from({ length: mid }, (_, i) => makeRow(i)),
    }));
    if (raw <= MAX_BYTES) lo = mid;
    else hi = mid;
  }
  const rows = Array.from({ length: lo }, (_, i) => makeRow(i));
  const snapshot = { ...base, rows };
  const raw = Buffer.byteLength(JSON.stringify(snapshot));
  assert.ok(raw <= MAX_BYTES);
  assert.ok(raw + lo * 20 > MAX_BYTES, "fixture must rely on post-clean growth to exceed the limit");
  await assert.rejects(b.service.preview(snapshot), { code: "invalid_snapshot" });
  assert.equal(total(await b.service.view([row(200)])), beforeView);
});

test("ledger reads enforce the byte limit even if an earlier size observation is stale", async (t) => {
  const machineB = await machine(t, "machine-bbbb", [row(200)]);
  const ledgerPath = path.join(machineB.home, "local-usage.json");
  await fs.writeFile(ledgerPath, JSON.stringify({ version: 1, revision: 0, sequence: 0, imports: {} }));
  const padding = " ".repeat(1024 * 1024);
  for (let i = 0; i < 64; i++) await fs.appendFile(ledgerPath, padding);
  const stat = fs.stat;
  // Model metadata obtained before a concurrent grow. The read itself must
  // still be bounded, even though the padded file remains valid JSON.
  t.mock.method(fs, "stat", async (file, ...args) => {
    const value = await stat(file, ...args);
    if (file === ledgerPath) value.size = 1;
    return value;
  });
  await assert.rejects(machineB.service.view([row(200)]), { code: "invalid_state", status: 503 });
});

test("exports strip private fields and refuse malformed or previously synthesized queues", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(100, { prompt: "private", cwd: "private", secret: "private" })]);
  assert.equal(JSON.stringify(await a.service.exportSnapshot()).includes("private"), false);
  await a.write([row(100, { _ttsync: true })]);
  await assert.rejects(a.service.exportSnapshot(), { code: "legacy_imports" });
  await fs.writeFile(a.queuePath, "invalid json\n");
  await assert.rejects(a.service.exportSnapshot(), { code: "invalid_queue" });
});

test("a failed atomic write leaves the previously committed source snapshot visible", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(100)]);
  const b = await machine(t, "machine-bbbb", [row(200)]);
  await apply(b.service, await a.service.exportSnapshot());
  await a.write([row(150)]);
  const updated = await a.service.exportSnapshot();
  const preview = await b.service.preview(updated);
  const rename = fs.rename;
  const failure = t.mock.method(fs, "rename", async (from, to) => {
    if (to === path.join(b.home, "local-usage.json")) throw Object.assign(new Error("synthetic write failure"), { code: "EIO" });
    return rename(from, to);
  });
  await assert.rejects(b.service.importSnapshot(updated, preview.token), { code: "EIO" });
  failure.mock.restore();
  assert.equal(total(await b.service.view([row(200)])), 300);
  await apply(b.service, updated);
  assert.equal(total(await b.service.view([row(200)])), 350);
});

test("concurrent imports never lose another source; source versions are independent", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(100)]);
  const b = await machine(t, "machine-bbbb", [row(200)]);
  const c = await machine(t, "machine-cccc", [row(300)]);
  const snapshots = await Promise.all([a.service.exportSnapshot(), b.service.exportSnapshot()]);
  const results = await Promise.allSettled(snapshots.map((s) => apply(c.service, s)));
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") await apply(c.service, snapshots[i]);
  }
  assert.equal(total(await c.service.view([row(300)])), 600);
});

test("real local API previews and commits imports, filters existing usage endpoints and rejects foreign writes", async (t) => {
  const a = await machine(t, "machine-aaaa", [row(100)]);
  const b = await machine(t, "machine-bbbb", [row(200)]);
  // Keep runtime config, identity seed and all incidental reads in the fixture.
  t.mock.method(os, "homedir", () => b.home);
  await fs.writeFile(path.join(b.home, "config.json"), JSON.stringify({ machineId: "machine-bbbb" }));
  const { createLocalApiHandler } = require("../src/lib/local-api");
  const handler = createLocalApiHandler({ queuePath: b.queuePath, trackerDataDir: b.home });
  const server = require("node:http").createServer(async (req, res) => {
    try {
      if (!await handler(req, res, new URL(req.url, "http://127.0.0.1"))) { res.writeHead(404); res.end(); }
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(origin + "/api/local-auth")).json();
  const snapshot = await a.service.exportSnapshot();
  const headers = { "Content-Type": "application/json", "x-tokentracker-local-auth": token };
  const post = (body, extra = {}) => fetch(origin + "/api/local-usage", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post({ action: "preview", snapshot }, { origin: "https://foreign.example" })).status, 401);
  assert.equal((await fetch(origin + "/api/local-usage")).status, 401);
  const previewResponse = await post({ action: "preview", snapshot });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.after, 300);
  assert.equal((await post({ action: "import", snapshot, token: preview.token })).status, 200);
  const range = "?from=2026-10-18&to=2026-10-18";
  const summary = (device = "") => fetch(origin + "/functions/tokentracker-usage-summary" + range + (device ? `&device_id=${device}` : "")).then((r) => r.json());
  assert.equal((await summary()).totals.total_tokens, 300);
  assert.equal((await summary("cloud-device-id")).totals.total_tokens, 300,
    "ordinary device IDs retain the existing local fallback instead of selecting an offline source");
  assert.equal((await summary("local:machine-aaaa")).totals.total_tokens, 100);
  assert.equal((await summary("local:machine-bbbb")).totals.total_tokens, 200);
  const devices = await (await fetch(origin + "/api/local-usage" + range, { headers })).json();
  assert.deepEqual(devices.devices.map((d) => d.total_tokens), [200, 100]);
  const daily = await (await fetch(origin + "/functions/tokentracker-usage-daily" + range + "&device_id=local:machine-aaaa")).json();
  assert.equal(daily.data[0].total_tokens, 100);
  for (const endpoint of ["hourly", "monthly", "model-breakdown", "heatmap"]) {
    const response = await fetch(origin + `/functions/tokentracker-usage-${endpoint}` + range + "&day=2026-10-18&device_id=local:machine-aaaa");
    assert.equal(response.status, 200, endpoint);
    const data = await response.json();
    const rows = endpoint === "heatmap" ? data.weeks.flat() : endpoint === "model-breakdown" ? data.sources.map((source) => source.totals) : data.data;
    assert.equal(total(rows), 100, endpoint);
  }
  assert.equal((await fetch(origin + "/functions/tokentracker-usage-summary" + range + "&device_id=local:unknown")).status, 404);
  const context = (device = "") => fetch(origin + "/functions/tokentracker-usage-category-breakdown" + range + "&source=codex" + (device ? `&device_id=${device}` : "")).then((r) => r.json());
  assert.equal((await context("local:machine-aaaa")).reason, "local_history_only");
  assert.equal((await context()).reason, "local_history_only");
  assert.equal((await context("local:machine-bbbb")).totals.total_tokens, 200);

  const partial = row(120, { model: "gpt-6.1-sol", input_tokens: 50, unclassified_input_tokens: 60,
    total_cost_usd: null, priority_input_tokens: 20, priority_output_tokens: 4,
    ultrafast_input_tokens: 30, ultrafast_output_tokens: 6 });
  await a.write([partial]);
  const partialSnapshot = await a.service.exportSnapshot();
  const partialPreview = await (await post({ action: "preview", snapshot: partialSnapshot })).json();
  assert.equal((await post({ action: "import", snapshot: partialSnapshot, token: partialPreview.token })).status, 200);
  const partialSummary = (await summary("local:machine-aaaa")).totals;
  assert.equal(partialSummary.total_tokens, 120);
  assert.equal(partialSummary.unclassified_input_tokens, 60);
  assert.equal(partialSummary.total_cost_usd, null);
  assert.equal(partialSummary.cost_status, "partial");
  assert.ok(Math.abs(Number(partialSummary.known_cost_usd) - computeKnownRowCost(partial)) < 1e-9);
  assert.equal((await summary()).totals.cost_status, "partial");

  await b.write([partial]);
  const exported = await (await post({ action: "export" })).json();
  assert.equal(exported.snapshot.rows[0].unclassified_input_tokens, 60);
  assert.equal(exported.snapshot.rows[0].total_cost_usd, null);
  assert.equal(exported.snapshot.rows[0].ultrafast_input_tokens, 30);
  assert.equal(Object.hasOwn(exported.snapshot.rows[0], "known_cost_usd"), false);
  assert.equal(Object.hasOwn(exported.snapshot.rows[0], "cost_status"), false);
  assert.equal((await a.service.preview(exported.snapshot)).action, "added",
    "the actual API export must still satisfy the strict snapshot import contract");
});
