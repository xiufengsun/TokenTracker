const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");
const { filterRowsByProfile } = require("../src/lib/profile-source");

// ?profile=<source> narrows the local usage endpoints to rows filed under that
// exact source: "claude@work" for a split profile, "claude" for the native
// ~/.claude. No value keeps every row, and the older ?source= parameter that
// some clients already send must stay a no-op.

const HOUR = "2026-04-20T10:00:00.000Z";

function row(source, total, model = "claude-sonnet-4-6") {
  return {
    source,
    model,
    hour_start: HOUR,
    input_tokens: total,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: total,
    conversation_count: 1,
  };
}

const ROWS = [
  row("claude", 100),
  row("claude@work", 300),
  row("claude@personal", 50),
  row("codex", 7, "gpt-5"),
];
const ALL = 100 + 300 + 50 + 7;

async function withQueue(rows, fn) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tt-profile-filter-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    await fs.promises.writeFile(queuePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return await fn(queuePath);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

async function call(queuePath, endpoint) {
  const handler = createLocalApiHandler({ queuePath });
  const url = new URL(`http://localhost${endpoint}`);
  const req = { method: "GET", url: url.pathname + url.search, headers: { host: "localhost" } };
  const chunks = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead() {},
    write(chunk) { chunks.push(chunk); },
    end(body) { if (body) chunks.push(body); },
  };
  assert.ok(await handler(req, res, url), `endpoint must be handled: ${endpoint}`);
  return JSON.parse(chunks.join(""));
}

const RANGE = "from=2026-04-20&to=2026-04-20&tz=UTC";
const summaryTotal = async (q, extra = "") =>
  (await call(q, `/functions/tokentracker-usage-summary?${RANGE}${extra}`)).totals.total_tokens;

test("summary: profile selects one source exactly, none keeps everything", async () => {
  await withQueue(ROWS, async (q) => {
    assert.equal(await summaryTotal(q), ALL);
    assert.equal(await summaryTotal(q, "&profile=claude@work"), 300);
    assert.equal(await summaryTotal(q, "&profile=claude@personal"), 50);
    assert.equal(await summaryTotal(q, "&profile=claude"), 100, "the native profile is its own source");
    assert.equal(await summaryTotal(q, "&profile=codex"), 7);
  });
});

test("summary: an unknown profile is empty, not everything", async () => {
  await withQueue(ROWS, async (q) => {
    assert.equal(await summaryTotal(q, "&profile=claude@nope"), 0);
  });
});

test("summary: profile matching ignores case and surrounding spaces", async () => {
  await withQueue(ROWS, async (q) => {
    assert.equal(await summaryTotal(q, "&profile=%20CLAUDE@Work%20"), 300);
  });
});

test("summary: an empty profile value keeps every row", async () => {
  await withQueue(ROWS, async (q) => {
    assert.equal(await summaryTotal(q, "&profile="), ALL);
  });
});

test("summary: ?source= alone is still ignored, as before profiles existed", async () => {
  await withQueue(ROWS, async (q) => {
    assert.equal(await summaryTotal(q, "&source=claude"), ALL);
    assert.equal(await summaryTotal(q, "&source=claude@work"), ALL);
  });
});

test("daily: only the selected profile's day total", async () => {
  await withQueue(ROWS, async (q) => {
    const work = await call(q, `/functions/tokentracker-usage-daily?${RANGE}&profile=claude@work`);
    assert.deepEqual(work.data.map((d) => [d.day, d.total_tokens]), [["2026-04-20", 300]]);
    const all = await call(q, `/functions/tokentracker-usage-daily?${RANGE}`);
    assert.deepEqual(all.data.map((d) => [d.day, d.total_tokens]), [["2026-04-20", ALL]]);
  });
});

test("hourly: only the selected profile's hour", async () => {
  await withQueue(ROWS, async (q) => {
    const personal = await call(q, "/functions/tokentracker-usage-hourly?day=2026-04-20&tz=UTC&profile=claude@personal");
    const total = personal.data.reduce((sum, h) => sum + (h.total_tokens || 0), 0);
    assert.equal(total, 50);
  });
});

test("monthly: only the selected profile's month", async () => {
  await withQueue(ROWS, async (q) => {
    const month = await call(q, "/functions/tokentracker-usage-monthly?from=2026-04-01&to=2026-04-30&tz=UTC&profile=claude");
    assert.deepEqual(month.data.map((m) => [m.month, m.total_tokens]), [["2026-04", 100]]);
  });
});

test("model-breakdown: only the selected profile's source", async () => {
  await withQueue(ROWS, async (q) => {
    const work = await call(q, `/functions/tokentracker-usage-model-breakdown?${RANGE}&profile=claude@work`);
    assert.deepEqual(work.sources.map((s) => s.source), ["claude@work"]);
    assert.equal(work.sources[0].totals.total_tokens, 300);
    const all = await call(q, `/functions/tokentracker-usage-model-breakdown?${RANGE}`);
    assert.deepEqual(all.sources.map((s) => s.source).sort(), ["claude", "claude@personal", "claude@work", "codex"]);
  });
});

test("heatmap: the day's cell carries only the selected profile's tokens", async () => {
  await withQueue(ROWS, async (q) => {
    const cellFor = async (extra) => {
      // The grid always ends today, so ask for a year to reach the test day.
      const heatmap = await call(q, `/functions/tokentracker-usage-heatmap?weeks=52&tz=UTC${extra}`);
      const cells = heatmap.weeks.flat().filter(Boolean);
      return cells.find((c) => c.day === "2026-04-20");
    };
    const work = await cellFor("&profile=claude@work");
    const everyone = await cellFor("");
    assert.equal(work.total_tokens, 300);
    assert.equal(everyone.total_tokens, ALL);
  });
});

test("filterRowsByProfile: exact match, empty keeps all, non-arrays are empty", () => {
  const rows = [{ source: "claude" }, { source: "claude@work" }, { source: "Claude@Work" }, {}];
  assert.deepEqual(filterRowsByProfile(rows, "claude@work").map((r) => r.source), ["claude@work", "Claude@Work"]);
  assert.deepEqual(filterRowsByProfile(rows, "claude").map((r) => r.source), ["claude"]);
  assert.equal(filterRowsByProfile(rows, "").length, 4);
  assert.equal(filterRowsByProfile(rows, undefined).length, 4);
  assert.equal(filterRowsByProfile(rows, "   ").length, 4);
  assert.deepEqual(filterRowsByProfile(null, "claude"), []);
  assert.deepEqual(filterRowsByProfile(undefined, ""), []);
});
