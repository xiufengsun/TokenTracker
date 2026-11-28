// Run against an isolated Worker preview with a dedicated account and no pre-existing devices.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = new URL(process.env.TT_QA_BASE_URL);
assert.equal(base.protocol, "https:");
assert.match(
  base.hostname,
  /(?:^|-)tokentracker-migration-staging\.[a-z0-9-]+\.workers\.dev$/,
);
const runId = randomUUID();
async function post(path, body, bearer, status = 200) {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
    },
    body: JSON.stringify(body),
  });
  if (response.status !== status) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      `${path}: expected ${status}, got ${response.status} (${result.code || "no code"})`,
    );
  }
  return response.json();
}
const route = (slug) => "/functions/tokentracker-" + slug;
let account = process.env.TT_QA_ACCESS_TOKEN;
if (!account) {
  assert.ok(
    process.env.TT_QA_EMAIL && process.env.TT_QA_PASSWORD,
    "Set the dedicated QA account credentials",
  );
  const login = await post("/api/auth/sessions?client_type=mobile", {
    email: process.env.TT_QA_EMAIL,
    password: process.env.TT_QA_PASSWORD,
  });
  account = login.accessToken;
}
assert.ok(account);
const info = {
  client_info: "cli preview-validation",
  machine_id: "tt-preview-" + runId,
};
const pair = await post(route("device-flow-authorize"), info);
const poll = () =>
  post(route("device-flow-poll"), { device_code: pair.device_code });
assert.equal((await poll()).status, "pending");
await post(
  route("device-flow-grant"),
  { user_code: pair.user_code },
  undefined,
  401,
);
assert.equal(
  (
    await post(
      route("device-flow-grant"),
      { user_code: pair.user_code },
      account,
    )
  ).ok,
  true,
);
const first = await poll();
assert.equal(first.status, "approved");
const issued = await poll();
assert.equal(issued.device_id, first.device_id);
assert.notEqual(issued.device_token, first.device_token);
assert.equal(
  (
    await post(
      route("device-rename"),
      { device_id: issued.device_id, device_name: "e2e " + runId },
      account,
    )
  ).ok,
  true,
);
const hour = new Date(
  Math.floor(Date.now() / 1_800_000) * 1_800_000,
).toISOString();
const upload = {
  upload_id: runId,
  buckets: [
    {
      hour_start: hour,
      source: "codex",
      model: "gpt-5.4",
      total_tokens: 1337,
      input_tokens: 1337,
      conversation_count: 2,
    },
  ],
};
await post(route("ingest"), upload, first.device_token, 401);
assert.equal(
  (await post(route("ingest"), upload, issued.device_token)).inserted,
  1,
);
assert.equal(
  (await post(route("ingest"), upload, issued.device_token)).inserted,
  1,
);
const operation_id = randomUUID();
const reset = { action: "reset", operation_id, device_id: issued.device_id };
const before = await post(route("device-usage-reset"), reset, account);
assert.equal(before.status, "reset");
assert.equal(before.removed_rows, 1);
assert.deepEqual(
  await post(route("device-usage-reset"), reset, account),
  before,
);
await post(route("ingest"), upload, issued.device_token, 401);
const replacement = await poll();
assert.equal(replacement.device_id, issued.device_id);
assert.equal(
  (await post(route("ingest"), upload, replacement.device_token)).inserted,
  1,
);
const after = await post(
  route("device-usage-reset"),
  { action: "refresh", operation_id },
  replacement.device_token,
);
assert.equal(after.status, "complete");
console.log(
  JSON.stringify({
    matched: true,
    device_id: issued.device_id,
    checks: [
      "authorize",
      "grant",
      "poll",
      "rotate",
      "rename",
      "ingest",
      "replay",
      "reset",
      "refresh",
    ],
  }),
);
