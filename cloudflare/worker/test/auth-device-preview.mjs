// Side-effect-bounded QA flow for the isolated staging Worker.
// It creates one synthetic device and one synthetic usage bucket only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const origin = "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev";
assert.equal(process.env.TT_QA_BASE_URL, origin);
assert.match(process.env.TT_QA_ID || "", /^[a-f0-9-]{36}$/i);
assert.ok(process.env.TT_QA_EMAIL && process.env.TT_QA_PASSWORD);

async function call(path, {
  body,
  token,
  status = 200,
  statuses = null,
  returnStatus = false,
} = {}) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.ok(
    (statuses || [status]).includes(response.status),
    `${path.split("?")[0]} returned ${response.status}`,
  );
  return returnStatus ? { status: response.status, data } : data;
}

const route = (name) => "/functions/tokentracker-" + name;
const runId = randomUUID();
const login = await call("/api/auth/sessions?client_type=mobile", {
  body: {
    email: process.env.TT_QA_EMAIL,
    password: process.env.TT_QA_PASSWORD,
  },
});
assert.equal(login.user?.id, process.env.TT_QA_ID);
assert.ok(login.accessToken && login.refreshToken);

const refreshed = await call("/api/auth/refresh?client_type=mobile", {
  body: { refresh_token: login.refreshToken },
});
assert.equal(refreshed.user?.id, process.env.TT_QA_ID);
assert.ok(refreshed.accessToken && refreshed.refreshToken);

const pair = await call(route("device-flow-authorize"), {
  body: { client_info: "Linux QA auth-device preview", machine_id: "qa-" + runId },
});
await call(route("device-flow-grant"), {
  body: { user_code: pair.user_code },
  token: refreshed.accessToken,
});
const device = await call(route("device-flow-poll"), {
  body: { device_code: pair.device_code },
});
assert.equal(device.status, "approved");
assert.equal(device.user_id, process.env.TT_QA_ID);
assert.ok(device.device_id && device.device_token);

const hour = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000).toISOString();
const day = hour.slice(0, 10);
const model = "qa-auth-device-" + runId;
const total = 1371;
const upload = {
  upload_id: runId,
  buckets: [{
    hour_start: hour,
    source: "codex",
    model,
    input_tokens: total,
    total_tokens: total,
    conversation_count: 1,
  }],
};
await call(route("ingest"), { body: upload, token: device.device_token });
const query = new URLSearchParams({
  from: day,
  to: day,
  day,
  tz: "UTC",
  device_id: device.device_id,
});
const summary = await call(route("account-summary") + "?" + query, {
  token: refreshed.accessToken,
});
assert.ok(
  summary.totals?.total_tokens >= total,
  "the QA account must read its own synthetic upload",
);

const other = process.env.TT_QA_OTHER_ACCESS_TOKEN;
if (other) {
  const isolated = await call(route("account-summary") + "?" + query, {
    token: other,
    statuses: [200, 401, 403],
    returnStatus: true,
  });
  if (isolated.status === 200) {
    assert.ok(
      isolated.data &&
        isolated.data.totals &&
        Number.isFinite(Number(isolated.data.totals.total_tokens)),
      "a successful cross-account response must include a numeric totals object",
    );
    assert.equal(
      Number(isolated.data.totals.total_tokens || 0),
      0,
      "a second QA account must not read the first account's device",
    );
  }
}

await call("/api/auth/logout?client_type=mobile", {
  body: { refresh_token: refreshed.refreshToken },
});
await call("/api/auth/sessions/current", {
  token: refreshed.accessToken,
  status: 401,
});

console.log(JSON.stringify({
  endpoint: origin,
  user_id_verified: true,
  refresh: true,
  logout: true,
  device_upload: true,
  own_readback: true,
  cross_user_isolation: Boolean(other),
}));
