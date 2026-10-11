const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanCodexSession, listSessionsForBrowser, summarizeSessions } = require("../src/lib/session-analytics");

test("Codex session ranges count each day's appended usage once rather than its lifetime (#592)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-session-day-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "rollout.jsonl");
  const usage = (input, output) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
  const count = (timestamp, last, total) => ({ timestamp, type: "event_msg", payload: {
    type: "token_count", info: { last_token_usage: last, total_token_usage: total },
  } });
  fs.writeFileSync(file, [
    { timestamp: "2026-10-09T23:40:00Z", type: "session_meta", payload: { id: "session-days", cwd: dir } },
    { timestamp: "2026-10-09T23:40:01Z", type: "turn_context", payload: { model: "gpt-5.4" } },
    count("2026-10-09T23:45:00Z", usage(100, 20), usage(100, 20)),
    count("2026-10-10T00:15:00Z", usage(50, 10), usage(150, 30)),
    count("2026-10-10T00:15:00Z", usage(50, 10), usage(150, 30)),
  ].map(JSON.stringify).join("\n") + "\n");
  const row = await scanCodexSession(file);
  assert.equal(row.total_tokens, 180);
  assert.equal(row.usage_buckets.length, 2);
  const first = listSessionsForBrowser([row], { from: "2026-10-09", to: "2026-10-09" });
  const second = listSessionsForBrowser([row], { from: "2026-10-10", to: "2026-10-10" });
  assert.equal(first.sessions[0].total_tokens, 120);
  assert.equal(second.sessions[0].total_tokens, 60);
  assert.ok(Math.abs(first.sessions[0].cost_usd + second.sessions[0].cost_usd - row.cost_usd) < 1e-12);
  assert.equal(summarizeSessions([row], { from: "2026-10-10", to: "2026-10-10" }).summary.total_tokens, 180,
    "efficiency keeps lifetime tokens and edit counts in the same population");
  assert.equal(listSessionsForBrowser([row]).sessions[0].total_tokens, 180);
  assert.equal(listSessionsForBrowser([row], { from: "2026-10-10", to: "2026-10-10", timeZone: "Asia/Shanghai" }).sessions[0].total_tokens, 180);
  const browser = listSessionsForBrowser([row]).sessions[0];
  assert.equal(browser.session_store_bytes, process.platform === "win32" ? fs.statSync(file).size : fs.statSync(file).blocks * 512);
  assert.equal(browser.bytes_per_1k_tokens, browser.session_store_bytes * 1000 / 180);
});
