const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, describe, it } = require("node:test");

// Sandbox HOME so the handler's local-auth + skills registry stay under tmp.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-localapi-skills-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.TOKENTRACKER_GROK_HOME = path.join(sandboxHome, ".grok");
delete process.env.GROK_HOME;
delete process.env.TOKENTRACKER_ANTIGRAVITY_HOME;

const { createLocalApiHandler } = require("../src/lib/local-api");

const queuePath = path.join(sandboxHome, "queue.jsonl");
fs.writeFileSync(queuePath, "");
const handler = createLocalApiHandler({ queuePath });

function writeLocalSkill(targetDir, directory, body = "---\nname: Local Skill\ndescription: Test skill\n---\n") {
  const dir = path.join(sandboxHome, targetDir, directory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

function writeSkillUsageTranscript(skillName) {
  const projDir = path.join(sandboxHome, ".claude", "projects", "proj");
  fs.mkdirSync(projDir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-01T00:00:00.000Z",
    message: {
      id: `msg-${skillName}`,
      model: "claude-opus-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [
        {
          type: "tool_use",
          id: `block-${skillName}`,
          name: "Skill",
          input: { skill: skillName },
        },
      ],
    },
  });
  fs.writeFileSync(path.join(projDir, `${skillName}.jsonl`), `${line}\n`);
}

function makeReq({ method = "GET", pathname = "/functions/tokentracker-skills", search = "", headers = {}, body }) {
  const url = new URL(`http://localhost${pathname}${search}`);
  let listeners = {};
  const req = {
    method,
    url: url.pathname + url.search,
    headers: { host: "localhost", ...headers },
    on(event, fn) { listeners[event] = fn; return req; },
  };
  if (body !== undefined) {
    // Simulate IncomingMessage event stream for readJsonBody.
    process.nextTick(() => {
      listeners.data?.(Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      listeners.end?.();
    });
  } else {
    process.nextTick(() => listeners.end?.());
  }
  return { req, url };
}

function makeRes() {
  const chunks = [];
  let statusCode = 200;
  return {
    chunks,
    get body() { return chunks.join(""); },
    get status() { return statusCode; },
    setHeader() {},
    writeHead(code) { statusCode = code; },
    write(chunk) { chunks.push(chunk); },
    end(chunk) { if (chunk) chunks.push(chunk); },
  };
}

async function call({ method, pathname, search = "", headers = {}, body } = {}) {
  const { req, url } = makeReq({ method, pathname, search, headers, body });
  const res = makeRes();
  const handled = await handler(req, res, url);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

describe("/functions/tokentracker-skills auth + input", () => {
  let token;

  before(async () => {
    const result = await call({ method: "GET", pathname: "/api/local-auth" });
    assert.ok(result.handled);
    token = result.body.token;
    assert.ok(token && typeof token === "string");
  });

  it("rejects POST without the local-auth header with 401", async () => {
    const { status, body } = await call({
      method: "POST",
      headers: { origin: "http://localhost:7680" },
      body: { action: "add_repo", repo: { owner: "anthropics", name: "skills" } },
    });
    assert.equal(status, 401);
    assert.equal(body.ok, false);
  });

  it("rejects POST with mismatched token with 401", async () => {
    const { status } = await call({
      method: "POST",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": "not-the-right-token",
      },
      body: { action: "add_repo", repo: { owner: "anthropics", name: "skills" } },
    });
    assert.equal(status, 401);
  });

  it("returns 400 for unknown action with valid auth", async () => {
    const { status, body } = await call({
      method: "POST",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": token,
      },
      body: { action: "not-a-real-action" },
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it("returns 400 for unknown GET mode", async () => {
    const { status, body } = await call({
      method: "GET",
      search: "?mode=nonsense",
    });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  it("returns 405 for PUT", async () => {
    const { status } = await call({
      method: "PUT",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": token,
      },
    });
    assert.equal(status, 405);
  });

  it("GET mode=installed returns {targets, skills} shape", async () => {
    const { status, body } = await call({ method: "GET", search: "?mode=installed" });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.targets));
    assert.ok(Array.isArray(body.skills));
    assert.ok(body.targets.some((target) => target.id === "grok" && target.label === "Grok"));
    assert.ok(
      body.targets.some((target) => target.id === "antigravity" && target.label === "Antigravity"),
      "Antigravity must appear in installed-skills targets",
    );
    assert.ok(
      body.targets.some((target) => target.id === "acode" && target.label === "AStudio"),
      "AStudio must appear in installed-skills targets",
    );
  });

  it("surfaces addRepo validation error via 500 with message", async () => {
    const { status, body } = await call({
      method: "POST",
      headers: {
        origin: "http://localhost:7680",
        "x-tokentracker-local-auth": token,
      },
      body: { action: "add_repo", repo: { owner: "..", name: "skills" } },
    });
    assert.equal(status, 500);
    assert.match(body.error, /owner and name/);
  });

  it("GET mode=activity returns {activity: []}", async () => {
    const { status, body } = await call({ method: "GET", search: "?mode=activity" });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.activity));
  });

  it("GET mode=updates returns {updates} with no managed skills (no network)", async () => {
    const { status, body } = await call({ method: "GET", search: "?mode=updates" });
    assert.equal(status, 200);
    assert.ok(body.updates && typeof body.updates === "object");
  });

  it("GET mode=skill_usage returns priced shape joined with installed", async () => {
    const { status, body } = await call({ method: "GET", search: "?mode=skill_usage" });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.skills));
    assert.ok(Array.isArray(body.unusedInstalled));
    assert.ok(Number.isFinite(body.totalInvocations));
  });

  it("GET mode=skill_usage joins nested installed skills by leaf name", async () => {
    writeLocalSkill(".hermes/skills", "apple/apple-notes", "---\nname: Apple Notes\ndescription: Nested\n---\n");
    writeSkillUsageTranscript("apple-notes");

    const { status, body } = await call({ method: "GET", search: "?mode=skill_usage&force=1" });

    assert.equal(status, 200);
    const usage = body.skills.find((entry) => entry.skill === "apple-notes");
    assert.ok(usage);
    assert.equal(usage.installed, true);
    assert.equal(usage.directory, "apple/apple-notes");
    assert.equal(body.unusedInstalled.some((entry) => entry.directory === "apple/apple-notes"), false);
  });

  it("GET mode=skill_usage does not join ambiguous nested leaf names", async () => {
    writeLocalSkill(".hermes/skills", "alpha/shared-note", "---\ndescription: first\n---\n");
    writeLocalSkill(".codex/skills", "beta/shared-note", "---\ndescription: second\n---\n");
    writeSkillUsageTranscript("shared-note");

    const { status, body } = await call({ method: "GET", search: "?mode=skill_usage&force=1" });

    assert.equal(status, 200);
    const usage = body.skills.find((entry) => entry.skill === "shared-note");
    assert.ok(usage);
    assert.equal(usage.installed, false);
    assert.equal(usage.directory, null);
    const unused = body.unusedInstalled
      .filter((entry) => entry.directory.endsWith("/shared-note"))
      .map((entry) => entry.directory)
      .sort();
    assert.deepEqual(unused, ["alpha/shared-note", "beta/shared-note"]);
  });

  it("GET mode=skill_usage still joins a unique skill name when leaf names are ambiguous", async () => {
    writeLocalSkill(".hermes/skills", "alpha/name-leaf-collision", "---\nname: name-leaf-collision\n---\n");
    writeLocalSkill(".codex/skills", "beta/name-leaf-collision", "---\nname: Different Name\n---\n");
    writeSkillUsageTranscript("name-leaf-collision");

    const { status, body } = await call({ method: "GET", search: "?mode=skill_usage&force=1" });

    assert.equal(status, 200);
    const usage = body.skills.find((entry) => entry.skill === "name-leaf-collision");
    assert.ok(usage);
    assert.equal(usage.installed, true);
    assert.equal(usage.directory, "alpha/name-leaf-collision");
    assert.equal(body.unusedInstalled.some((entry) => entry.directory === "alpha/name-leaf-collision"), false);
    assert.equal(body.unusedInstalled.some((entry) => entry.directory === "beta/name-leaf-collision"), true);
  });

  it("GET mode=popular returns install-sorted skills (stubbed fetch)", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        count: 2,
        skills: [
          { id: "o/r:low", name: "Low", skillId: "low", source: "o/r", installs: 3 },
          { id: "o/r:high", name: "High", skillId: "high", source: "o/r", installs: 900 },
        ],
      }),
    });
    try {
      const { status, body } = await call({ method: "GET", search: "?mode=popular&force=1" });
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.skills));
      assert.equal(body.skills[0].name, "High", "highest installs first");
    } finally {
      global.fetch = realFetch;
    }
  });
});
