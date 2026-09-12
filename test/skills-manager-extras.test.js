const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

// Sandbox HOME before requiring the module so every os.homedir() callback
// resolves inside the temp dir (mirrors skills-manager.test.js).
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skills-extras-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.TOKENTRACKER_GROK_HOME = path.join(sandboxHome, ".grok");
delete process.env.GROK_HOME;
delete process.env.TOKENTRACKER_ANTIGRAVITY_HOME;
delete process.env.CODEX_HOME;
delete process.env.ZCODE_HOME;
delete process.env.TOKENTRACKER_OPENCLAW_HOME;
delete process.env.TOKENTRACKER_OPENCLAW_WORKSPACE;

const skills = require("../src/lib/skills-manager");

const CLAUDE_SKILLS = path.join(sandboxHome, ".claude", "skills");

function writeSkillDir(dir, marker = "SKILL.md", body = "---\nname: Demo\ndescription: A demo skill\n---\n") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, marker), body);
  return dir;
}

// Match the host exactly. A substring test would also accept
// api.github.com.example.test, which CodeQL flags as incomplete URL
// sanitization, and these stubs decide a canned response from it.
function isGitHubApi(url) {
  return new URL(String(url)).hostname === "api.github.com";
}

function resetRegistry() {
  const file = path.join(sandboxHome, ".tokentracker", "skills", "registry.json");
  try {
    fs.rmSync(file, { force: true });
  } catch (_e) {
    /* ignore */
  }
}

describe("findSkillMarker (case-insensitive SKILL.md|skill.md)", () => {
  it("accepts both spellings and rejects non-markers", () => {
    const upper = writeSkillDir(path.join(sandboxHome, "m-upper"), "SKILL.md");
    const lower = writeSkillDir(path.join(sandboxHome, "m-lower"), "skill.md");
    const readme = path.join(sandboxHome, "m-readme");
    fs.mkdirSync(readme, { recursive: true });
    fs.writeFileSync(path.join(readme, "README.md"), "# not a skill");

    assert.ok(skills.findSkillMarker(upper));
    assert.ok(skills.findSkillMarker(lower), "lowercase skill.md must be detected");
    assert.equal(skills.findSkillMarker(readme), null, "README.md is never a marker");
  });
});

describe("listInstalledSkills lowercase skill.md regression", () => {
  it("surfaces a lowercase skill.md skill as unmanaged (was invisible before fix)", () => {
    resetRegistry();
    writeSkillDir(path.join(CLAUDE_SKILLS, "lowercase-skill"), "skill.md");
    const installed = skills.listInstalledSkills();
    const found = installed.find((s) => s.directory === "lowercase-skill");
    assert.ok(found, "lowercase skill.md skill should appear in installed list");
    assert.equal(found.managed, false);
    // targetStates is a complete map (single source of truth): synced where the
    // skill exists, "off" elsewhere.
    assert.equal(found.targetStates.claude, "synced");
    assert.equal(found.targetStates.codex, "off");
  });
});

describe("read-only plugin skill inventory", () => {
  it("excludes Codex built-in skills from the inventory", () => {
    resetRegistry();
    writeSkillDir(
      path.join(sandboxHome, ".codex", "skills", ".system", "skill-creator"),
      "SKILL.md",
      "---\nname: Skill Creator\ndescription: Built in\n---\n",
    );

    const entry = skills.listInstalledSkills().find((s) => s.name === "Skill Creator");
    assert.equal(entry, undefined, "built-in skills should not clutter the user inventory");
  });

  it("counts Codex, Claude, and ZCode plugin-cache skills without exposing them as manageable", () => {
    resetRegistry();
    const fixtures = [
      [".codex/plugins/cache/openai-bundled/browser/1.2.3/skills/browser-control", "Codex Browser"],
      [".claude/plugins/cache/acme/tools/2.0.0/skills/reviewer", "Claude Reviewer"],
      [".zcode/cli/plugins/cache/zcode-official/guide/0.1.0/skills/diagnostics", "ZCode Diagnostics"],
      [".claude/plugins/cache/acme/first/skills/shared", "Claude First Plugin"],
      [".claude/plugins/cache/acme/second/skills/shared", "Claude Second Plugin"],
    ];
    for (const [relative, name] of fixtures) {
      writeSkillDir(path.join(sandboxHome, relative), "SKILL.md", `---\nname: ${name}\n---\n`);
    }

    const installed = skills.listInstalledSkills();
    for (const [name, target] of [
      ["Codex Browser", "codex"],
      ["Claude Reviewer", "claude"],
      ["ZCode Diagnostics", "zcode"],
    ]) {
      const entry = installed.find((s) => s.name === name);
      assert.ok(entry, `${name} should be counted`);
      assert.equal(entry.readOnly, true);
      assert.equal(entry.scope, "plugin");
      assert.deepEqual(entry.targets, [target]);
    }

    const zcode = skills.targetList().find((target) => target.id === "zcode");
    assert.ok(zcode, "ZCode should be available as an inventory filter");
    assert.equal(zcode.manageable, false);
    assert.equal(zcode.path, null);

    const sharedPlugins = installed.filter((entry) => entry.directory === "shared");
    assert.equal(sharedPlugins.length, 2, "versionless plugins with the same skill must keep distinct identities");
    assert.deepEqual(
      sharedPlugins.map((entry) => entry.sourceName).sort(),
      ["acme/first", "acme/second"],
    );
  });

  it("scans only the active OpenClaw workspace skills directory", () => {
    resetRegistry();
    const openclawHome = path.join(sandboxHome, ".openclaw");
    const activeWorkspace = path.join(openclawHome, "active-workspace");
    fs.mkdirSync(openclawHome, { recursive: true });
    fs.writeFileSync(
      path.join(openclawHome, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: activeWorkspace } } }),
    );
    writeSkillDir(path.join(activeWorkspace, "skills", "active-skill"), "SKILL.md", "---\nname: Active Skill\n---\n");
    writeSkillDir(
      path.join(openclawHome, "workspace", "backup", "Other-Mac", "skills", "remote-snapshot"),
      "SKILL.md",
      "---\nname: Remote Snapshot\n---\n",
    );

    const installed = skills.listInstalledSkills();
    const active = installed.find((s) => s.name === "Active Skill");
    assert.ok(active);
    assert.deepEqual(active.targets, ["openclaw"]);
    assert.equal(installed.some((s) => s.name === "Remote Snapshot"), false);
  });
});

describe("readSkillMetadata YAML block scalars", () => {
  it("parses `description: |` / `>` block scalars instead of showing the bare indicator", () => {
    resetRegistry();
    const body = "---\nname: Block Skill\ndescription: |\n  First line of the description.\n  Second line continues here.\n---\n# Body\n";
    writeSkillDir(path.join(CLAUDE_SKILLS, "block-desc"), "SKILL.md", body);
    const entry = skills.listInstalledSkills().find((s) => s.directory === "block-desc");
    assert.ok(entry, "block-scalar skill should be listed");
    assert.equal(entry.name, "Block Skill");
    assert.equal(
      entry.description,
      "First line of the description. Second line continues here.",
      "block scalar body must be joined, not rendered as '|'",
    );
  });
});

describe("hashDirectory", () => {
  it("is deterministic, content-sensitive, and ignores OS/VCS noise", () => {
    const a = path.join(sandboxHome, "hash-a");
    writeSkillDir(a, "SKILL.md", "hello");
    const h1 = skills.hashDirectory(a);
    const h2 = skills.hashDirectory(a);
    assert.equal(h1, h2, "same content → same hash");

    // OS noise must not change the hash.
    fs.writeFileSync(path.join(a, ".DS_Store"), "junk");
    assert.equal(skills.hashDirectory(a), h1, ".DS_Store is ignored");

    // Real content change must change the hash.
    fs.writeFileSync(path.join(a, "SKILL.md"), "hello world");
    assert.notEqual(skills.hashDirectory(a), h1, "content change → new hash");
  });
});

describe("assertNotNested path guard", () => {
  it("throws when dest is inside source (or vice versa) and allows siblings", () => {
    const src = path.join(sandboxHome, "guard-src");
    fs.mkdirSync(src, { recursive: true });
    const nested = path.join(src, "child");
    assert.throws(() => skills.assertNotNested(src, nested), /own directory tree/);
    assert.throws(() => skills.assertNotNested(nested, src), /own directory tree/);
    assert.doesNotThrow(() => skills.assertNotNested(src, path.join(sandboxHome, "guard-dst")));
  });
});

describe("sourceSignatureFromTree", () => {
  it("hashes only blobs under sourceDir and tracks blob sha changes", () => {
    const tree = [
      { type: "blob", path: "foo/SKILL.md", sha: "aaa" },
      { type: "blob", path: "foo/scripts/run.sh", sha: "bbb" },
      { type: "blob", path: "other/SKILL.md", sha: "zzz" },
    ];
    const sig = skills.sourceSignatureFromTree(tree, "foo");
    assert.ok(sig);
    assert.equal(skills.sourceSignatureFromTree(tree, "foo"), sig, "stable");
    assert.equal(skills.sourceSignatureFromTree(tree, "missing"), null);

    const changed = tree.map((e) => (e.path === "foo/SKILL.md" ? { ...e, sha: "ccc" } : e));
    assert.notEqual(skills.sourceSignatureFromTree(changed, "foo"), sig, "blob sha change → new signature");
  });
});

describe("activity log", () => {
  it("records mutations and returns them newest-first", () => {
    resetRegistry();
    writeSkillDir(path.join(CLAUDE_SKILLS, "act-skill"), "SKILL.md");
    skills.importLocalSkill("act-skill", ["claude"]);
    skills.setSkillTargets("local:act-skill", ["claude", "codex"]);

    const activity = skills.readActivity(10);
    assert.ok(activity.length >= 2);
    assert.equal(activity[0].action, "set_targets", "newest first");
    assert.equal(activity[activity.length - 1].action, "import");
    // Privacy: only verbs/names/targets — no bodies.
    for (const event of activity) {
      assert.ok(!("content" in event) && !("body" in event));
    }
  });
});

describe("orphan target detection", () => {
  it("flags a managed skill whose synced agent dir was deleted", () => {
    resetRegistry();
    writeSkillDir(path.join(CLAUDE_SKILLS, "orphan-skill"), "SKILL.md");
    skills.importLocalSkill("orphan-skill", ["claude"]);

    let entry = skills.listInstalledSkills().find((s) => s.directory === "orphan-skill");
    assert.equal(entry.targetStates.claude, "synced");

    // Simulate the user manually deleting the synced copy.
    fs.rmSync(path.join(CLAUDE_SKILLS, "orphan-skill"), { recursive: true, force: true });
    entry = skills.listInstalledSkills().find((s) => s.directory === "orphan-skill");
    assert.equal(entry.targetStates.claude, "orphan", "intended-but-missing → orphan");
  });
});

describe("checkUpdates", () => {
  it("returns false when signature matches and true when upstream drifts", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    const tree = [{ type: "blob", path: "foo/SKILL.md", sha: "v1" }];
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ tree }) });
    try {
      const currentSig = skills.sourceSignatureFromTree(tree, "foo");
      const registryDir = path.join(sandboxHome, ".tokentracker", "skills");
      fs.mkdirSync(registryDir, { recursive: true });
      const writeRegistry = (sig) =>
        fs.writeFileSync(
          path.join(registryDir, "registry.json"),
          JSON.stringify({
            repos: [],
            skills: [
              {
                id: "o/r:foo",
                key: "o/r:foo",
                directory: "foo",
                sourceDirectory: "foo",
                repoOwner: "o",
                repoName: "r",
                repoBranch: "main",
                sourceSignature: sig,
                installedAt: 1,
                targets: [],
              },
            ],
          }),
        );

      writeRegistry(currentSig);
      let res = await skills.checkUpdates({ force: true });
      assert.equal(res.updates["o/r:foo"], false, "matching signature → no update");

      writeRegistry("STALE_SIGNATURE");
      res = await skills.checkUpdates({ force: true });
      assert.equal(res.updates["o/r:foo"], true, "drifted signature → update available");
    } finally {
      global.fetch = realFetch;
      resetRegistry();
    }
  });
});

describe("fetchPopularSkillsSh", () => {
  it("dedupes by key and sorts by installs desc", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        query: "x",
        count: 2,
        skills: [
          { id: "o/r:low", name: "Low", skillId: "low", source: "o/r", installs: 5 },
          { id: "o/r:high", name: "High", skillId: "high", source: "o/r", installs: 999 },
        ],
      }),
    });
    try {
      const res = await skills.fetchPopularSkillsSh({ force: true, limit: 10 });
      assert.equal(res.skills.length, 2, "deduped across seed queries");
      assert.equal(res.skills[0].name, "High", "highest installs first");
      assert.equal(res.skills[1].name, "Low");
    } finally {
      global.fetch = realFetch;
    }
  });
});

describe("updateSkills", () => {
  // Registry ids are always `${owner}/${name}:${sourceDirectory}` — installSkill
  // derives the id it writes from the repo path, so fixtures must agree or an
  // "update" silently appends a second entry instead of replacing one.
  const TREE = [
    { type: "blob", path: "a/SKILL.md", sha: "v1" },
    { type: "blob", path: "b/SKILL.md", sha: "v1" },
    { type: "blob", path: "c/SKILL.md", sha: "v1" },
  ];

  function entry(id, sourceSignature) {
    const [repo, dir] = id.split(":");
    const [repoOwner, repoName] = repo.split("/");
    return {
      id,
      key: id,
      name: dir,
      directory: dir,
      sourceDirectory: dir,
      repoOwner,
      repoName,
      repoBranch: "main",
      sourceSignature,
      installedAt: 1,
      targets: [],
    };
  }

  function writeUpdateRegistry(entries) {
    const registryDir = path.join(sandboxHome, ".tokentracker", "skills");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "registry.json"),
      JSON.stringify({ repos: [], skills: entries }),
    );
  }

  function stubGitHub({ onTree } = {}) {
    const calls = { tree: 0, raw: 0 };
    global.fetch = async (url) => {
      if (isGitHubApi(url)) {
        calls.tree += 1;
        const override = onTree ? onTree(calls.tree) : null;
        if (override) return override;
        return { ok: true, status: 200, json: async () => ({ tree: TREE }) };
      }
      calls.raw += 1;
      return { ok: true, status: 200, text: async () => "---\nname: Foo\ndescription: d\n---\n" };
    };
    return calls;
  }

  const sigFor = (dir) => skills.sourceSignatureFromTree(TREE, dir);

  it("skips current skills and spends one tree call per repo", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    const calls = stubGitHub();
    try {
      writeUpdateRegistry([
        entry("o/r:a", sigFor("a")),
        entry("o/r:b", sigFor("b")),
        entry("o/r2:c", sigFor("c")),
      ]);

      const res = await skills.updateSkills(["o/r:a", "o/r:b", "o/r2:c"]);

      assert.equal(res.skipped, 3, "already-current skills are skipped");
      assert.equal(res.updated, 0);
      assert.equal(res.failed, 0);
      assert.equal(calls.tree, 2, "two repos → two tree calls, not one per skill");
      assert.equal(calls.raw, 0, "skipped skills download nothing");
    } finally {
      global.fetch = realFetch;
      resetRegistry();
    }
  });

  it("re-installs a drifted skill and stores the fresh signature", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    stubGitHub();
    try {
      writeUpdateRegistry([entry("o/r:a", "STALE_SIGNATURE")]);

      const res = await skills.updateSkills(["o/r:a"]);

      assert.equal(res.updated, 1, "drifted skill is re-installed");
      assert.equal(res.failed, 0);
      const stored = skills.listInstalledSkills().filter((s) => s.id === "o/r:a");
      assert.equal(stored.length, 1, "updated in place, not duplicated");
      assert.equal(
        stored[0].sourceSignature,
        sigFor("a"),
        "signature refreshed, so the next check reports no update",
      );
    } finally {
      global.fetch = realFetch;
      resetRegistry();
    }
  });

  it("honours the id filter", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    stubGitHub();
    try {
      writeUpdateRegistry([entry("o/r:a", sigFor("a")), entry("o/r2:c", sigFor("c"))]);

      const res = await skills.updateSkills(["o/r:a"]);

      assert.equal(res.results.length, 1, "only the requested id is touched");
      assert.equal(res.results[0].id, "o/r:a");
    } finally {
      global.fetch = realFetch;
      resetRegistry();
    }
  });

  it("stops at a rate limit and reports partial progress", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    stubGitHub({ onTree: (n) => (n === 1 ? null : { ok: false, status: 403, json: async () => ({}) }) });
    try {
      writeUpdateRegistry([entry("o/r:a", "STALE_SIGNATURE"), entry("o/r2:c", "STALE_SIGNATURE")]);

      const res = await skills.updateSkills(["o/r:a", "o/r2:c"]);

      assert.equal(res.updated, 1, "work done before the limit is kept");
      assert.match(res.rateLimited || "", /rate-limited/i, "rate limit is surfaced, not swallowed");
      assert.equal(res.results.length, 2, "the skill the limit landed on is still reported");
      assert.equal(res.failed, 1, "an id we never got to is a failure to update, not a silent drop");
    } finally {
      global.fetch = realFetch;
      resetRegistry();
    }
  });
});

describe("updateSkills cache priming", () => {
  const TREE = [
    { type: "blob", path: "a/SKILL.md", sha: "v1" },
    { type: "blob", path: "c/SKILL.md", sha: "v1" },
  ];
  const sigFor = (dir) => skills.sourceSignatureFromTree(TREE, dir);
  const skillsDir = () => path.join(sandboxHome, ".tokentracker", "skills");
  const cachePath = () => path.join(skillsDir(), "updates-cache.json");

  function entry(id, sourceSignature) {
    const [repo, dir] = id.split(":");
    const [repoOwner, repoName] = repo.split("/");
    return {
      id,
      key: id,
      name: dir,
      directory: dir,
      sourceDirectory: dir,
      repoOwner,
      repoName,
      repoBranch: "main",
      sourceSignature,
      installedAt: 1,
      targets: [],
    };
  }

  function seed(entries, cachedUpdates) {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(path.join(skillsDir(), "registry.json"), JSON.stringify({ repos: [], skills: entries }));
    if (cachedUpdates) {
      const fingerprint = entries
        .filter((e) => e.sourceSignature)
        .map((e) => `${e.id}@${e.sourceSignature}`)
        .sort()
        .join("|");
      fs.writeFileSync(
        cachePath(),
        JSON.stringify({ fingerprint, checkedAt: Date.now(), updates: cachedUpdates }),
      );
    } else {
      fs.rmSync(cachePath(), { force: true });
    }
  }

  function clean() {
    resetRegistry();
    fs.rmSync(cachePath(), { force: true });
    fs.rmSync(path.join(skillsDir(), "ssot"), { recursive: true, force: true });
  }

  function stub({ onTree } = {}) {
    const calls = { tree: 0 };
    global.fetch = async (url) => {
      if (isGitHubApi(url)) {
        calls.tree += 1;
        const override = onTree ? onTree(calls.tree) : null;
        if (override) return override;
        return { ok: true, status: 200, json: async () => ({ tree: TREE }) };
      }
      return { ok: true, status: 200, text: async () => "---\nname: Foo\ndescription: d\n---\n" };
    };
    return calls;
  }

  it("clears a cached stale verdict after a run that only skipped", async () => {
    clean();
    const realFetch = global.fetch;
    const calls = stub();
    try {
      // A check from up to an hour ago said "stale"; upstream has since matched
      // what we hold, so the update has nothing to do.
      seed([entry("o/r:a", sigFor("a"))], { "o/r:a": true });
      assert.equal((await skills.checkUpdates()).updates["o/r:a"], true, "precondition: badge is up");

      const res = await skills.updateSkills(["o/r:a"]);
      assert.equal(res.skipped, 1);
      assert.equal(res.updated, 0);

      const before = calls.tree;
      const after = await skills.checkUpdates();
      assert.equal(after.updates["o/r:a"], false, "a skip-only run must still clear the badge");
      assert.equal(calls.tree - before, 0, "the follow-up check is served from the primed cache");
    } finally {
      global.fetch = realFetch;
      clean();
    }
  });

  it("primes the cache after a successful update so the refresh costs no tree call", async () => {
    clean();
    const realFetch = global.fetch;
    const calls = stub();
    try {
      seed([entry("o/r:a", "STALE_SIGNATURE"), entry("o/r:c", "STALE_SIGNATURE")]);

      const res = await skills.updateSkills(["o/r:a", "o/r:c"]);
      assert.equal(res.updated, 2);
      const spentUpdating = calls.tree;
      assert.equal(spentUpdating, 1, "one repo, one tree call");

      const after = await skills.checkUpdates();
      assert.equal(calls.tree - spentUpdating, 0, "no second round of tree calls");
      assert.deepEqual(after.updates, { "o/r:a": false, "o/r:c": false });
      assert.equal(after.cached, true);
    } finally {
      global.fetch = realFetch;
      clean();
    }
  });

  it("keeps the badge of a skill whose repo could not be reached", async () => {
    clean();
    const realFetch = global.fetch;
    // Second repo's tree 500s on both branch attempts; first repo succeeds.
    stub({ onTree: (n) => (n === 1 ? null : { ok: false, status: 500, json: async () => ({}) }) });
    try {
      seed([entry("o/r:a", "STALE_SIGNATURE"), entry("o/r2:c", "STALE_SIGNATURE")], {
        "o/r:a": true,
        "o/r2:c": true,
      });

      const res = await skills.updateSkills(["o/r:a", "o/r2:c"]);
      assert.equal(res.updated, 1, "the reachable repo still updates");

      const after = await skills.checkUpdates();
      assert.equal(after.updates["o/r:a"], false, "updated skill's badge clears");
      assert.equal(after.updates["o/r2:c"], true, "unreachable skill keeps its badge — retry stays possible");
    } finally {
      global.fetch = realFetch;
      clean();
    }
  });

  it("reports a row for every requested id so the counts reconcile", async () => {
    clean();
    const realFetch = global.fetch;
    stub();
    try {
      seed([entry("o/r:a", "STALE_SIGNATURE")]);

      const res = await skills.updateSkills(["o/r:a", "o/r:ghost"]);

      assert.equal(res.results.length, 2, "an id that is no longer installed still gets a row");
      assert.equal(res.updated + res.skipped + res.failed, res.results.length, "counts add up");
      assert.equal(res.failed, 1);
      assert.ok(
        res.results.some((r) => r.id === "o/r:ghost" && !r.ok),
        "the missing id is the failure, and it is named",
      );
    } finally {
      global.fetch = realFetch;
      clean();
    }
  });

  it("does not resurrect a skill uninstalled while the update is downloading", async () => {
    clean();
    const realFetch = global.fetch;
    let dropped = false;
    global.fetch = async (url) => {
      if (isGitHubApi(url)) {
        return { ok: true, status: 200, json: async () => ({ tree: TREE }) };
      }
      if (!dropped) {
        // A concurrent uninstall lands mid-download — another tab, the menu bar
        // app, anything that shares the registry.
        dropped = true;
        const file = path.join(skillsDir(), "registry.json");
        const reg = JSON.parse(fs.readFileSync(file, "utf8"));
        reg.skills = reg.skills.filter((s) => s.id !== "o/r:c");
        fs.writeFileSync(file, JSON.stringify(reg));
      }
      return { ok: true, status: 200, text: async () => "---\nname: Foo\ndescription: d\n---\n" };
    };
    try {
      seed([entry("o/r:a", "STALE_SIGNATURE"), entry("o/r:c", "STALE_SIGNATURE")]);

      await skills.updateSkills(["o/r:a", "o/r:c"]);

      const ids = JSON.parse(fs.readFileSync(path.join(skillsDir(), "registry.json"), "utf8")).skills.map(
        (s) => s.id,
      );
      assert.ok(!ids.includes("o/r:c"), "the uninstalled skill must stay uninstalled");
      assert.ok(ids.includes("o/r:a"), "the other skill still updates");
    } finally {
      global.fetch = realFetch;
      clean();
    }
  });
});

describe("updateSkills id scope", () => {
  it("treats an empty or malformed id list as nothing to do, never as everything", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    let reached = 0;
    global.fetch = async () => {
      reached += 1;
      throw new Error("updateSkills must not touch the network for an empty request");
    };
    try {
      const registryDir = path.join(sandboxHome, ".tokentracker", "skills");
      fs.mkdirSync(registryDir, { recursive: true });
      fs.writeFileSync(
        path.join(registryDir, "registry.json"),
        JSON.stringify({
          repos: [],
          skills: [
            {
              id: "o/r:a",
              key: "o/r:a",
              name: "a",
              directory: "a",
              sourceDirectory: "a",
              repoOwner: "o",
              repoName: "r",
              repoBranch: "main",
              sourceSignature: "STALE_SIGNATURE",
              installedAt: 1,
              targets: [],
            },
          ],
        }),
      );

      for (const bad of [[], undefined, null, "o/r:a", { id: "o/r:a" }, [""], [null]]) {
        const res = await skills.updateSkills(bad);
        assert.deepEqual(
          { updated: res.updated, skipped: res.skipped, failed: res.failed, rows: res.results.length },
          { updated: 0, skipped: 0, failed: 0, rows: 0 },
          `${JSON.stringify(bad)} must be a no-op, not a full sweep`,
        );
      }
      assert.equal(reached, 0, "no GitHub call is made for a request with no usable ids");
    } finally {
      global.fetch = realFetch;
      resetRegistry();
    }
  });
});

describe("checkUpdates when a repo cannot be reached", () => {
  it("keeps the previous verdict instead of reporting nothing is stale", async () => {
    resetRegistry();
    const realFetch = global.fetch;
    const skillsDir = path.join(sandboxHome, ".tokentracker", "skills");
    const cachePath = path.join(skillsDir, "updates-cache.json");
    // Every tree call fails the way an offline box or a 404'd repo does.
    global.fetch = async (url) => {
      if (isGitHubApi(url)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, text: async () => "" };
    };
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      const skill = {
        id: "o/r:a",
        key: "o/r:a",
        name: "a",
        directory: "a",
        sourceDirectory: "a",
        repoOwner: "o",
        repoName: "r",
        repoBranch: "main",
        sourceSignature: "SIG",
        installedAt: 1,
        targets: [],
      };
      const other = { ...skill, id: "o/r:b", key: "o/r:b", name: "b", directory: "b", sourceDirectory: "b" };
      fs.writeFileSync(
        path.join(skillsDir, "registry.json"),
        JSON.stringify({ repos: [], skills: [skill, other] }),
      );
      // A check from a few minutes ago found one update; its fingerprint no
      // longer matches because `other` has since been added, so this is a miss.
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ fingerprint: "o/r:a@SIG", checkedAt: Date.now(), updates: { "o/r:a": true } }),
      );

      const res = await skills.checkUpdates();

      assert.equal(res.cached, false, "precondition: the cache misses, so this is a real check");
      assert.equal(
        res.updates["o/r:a"],
        true,
        "an unreachable repo must not silently downgrade a known update to 'nothing stale'",
      );
    } finally {
      global.fetch = realFetch;
      fs.rmSync(cachePath, { force: true });
      resetRegistry();
    }
  });
});

// Grok recheck of e13fd37c: the earlier race test dropped a *sibling* while a
// different skill downloaded. The skill under its own await was still written
// back by installSkill()'s re-read + push.
describe("updateSkills race under the skill's own download", () => {
  const TREE = [{ type: "blob", path: "a/SKILL.md", sha: "v1" }];
  const skillsDir = () => path.join(sandboxHome, ".tokentracker", "skills");
  const registryFile = () => path.join(skillsDir(), "registry.json");

  const managed = (id, directory, sourceDirectory) => {
    const [repo] = id.split(":");
    const [repoOwner, repoName] = repo.split("/");
    return {
      id,
      key: id,
      name: directory,
      directory,
      sourceDirectory,
      repoOwner,
      repoName,
      repoBranch: "main",
      sourceSignature: "STALE_SIGNATURE",
      installedAt: 1,
      targets: [],
    };
  };

  function seed(entries) {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify({ repos: [], skills: entries }));
  }
  const readIds = () => JSON.parse(fs.readFileSync(registryFile(), "utf8")).skills.map((s) => s.id);
  function clean() {
    resetRegistry();
    fs.rmSync(path.join(skillsDir(), "updates-cache.json"), { force: true });
    fs.rmSync(path.join(skillsDir(), "ssot"), { recursive: true, force: true });
  }

  // Fires `onFirstDownload` during the raw GET, i.e. inside installSkill's await,
  // after updateSkills has already re-checked membership.
  function stubDroppingMidDownload(onFirstDownload) {
    let fired = false;
    global.fetch = async (url) => {
      if (isGitHubApi(url)) return { ok: true, status: 200, json: async () => ({ tree: TREE }) };
      if (!fired) {
        fired = true;
        onFirstDownload();
      }
      return { ok: true, status: 200, text: async () => "---\nname: Foo\ndescription: d\n---\n" };
    };
  }

  it("leaves a skill uninstalled when the uninstall lands under its own download", async () => {
    clean();
    const realFetch = global.fetch;
    try {
      seed([managed("o/r:a", "a", "a")]);
      stubDroppingMidDownload(() => {
        fs.writeFileSync(registryFile(), JSON.stringify({ repos: [], skills: [] }));
      });

      const res = await skills.updateSkills(["o/r:a"]);

      assert.equal(res.updated, 0, "a skill removed mid-download must not count as updated");
      assert.ok(!readIds().includes("o/r:a"), "and must not be written back into the registry");
    } finally {
      global.fetch = realFetch;
      clean();
    }
  });

  it("does not clobber a same-directory replacement that landed mid-download", async () => {
    clean();
    const realFetch = global.fetch;
    try {
      seed([managed("o/r:a", "a", "a")]);
      stubDroppingMidDownload(() => {
        // The user removed o/r:a and installed a different repo's skill into the
        // same install directory while we were downloading.
        fs.writeFileSync(
          registryFile(),
          JSON.stringify({ repos: [], skills: [managed("other/x:a", "a", "a")] }),
        );
      });

      await skills.updateSkills(["o/r:a"]);

      const ids = readIds();
      assert.ok(ids.includes("other/x:a"), "the replacement must survive");
      assert.ok(!ids.includes("o/r:a"), "the superseded skill must not be resurrected");
    } finally {
      global.fetch = realFetch;
      clean();
    }
  });
});

describe("updateSkills rate-limit result rows", () => {
  const TREE = [
    { type: "blob", path: "a/SKILL.md", sha: "v1" },
    { type: "blob", path: "c/SKILL.md", sha: "v1" },
  ];
  const skillsDir = () => path.join(sandboxHome, ".tokentracker", "skills");

  function seed(entries) {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.writeFileSync(path.join(skillsDir(), "registry.json"), JSON.stringify({ repos: [], skills: entries }));
  }
  const managed = (id, dir) => {
    const [repo] = id.split(":");
    const [repoOwner, repoName] = repo.split("/");
    return {
      id,
      key: id,
      name: dir,
      directory: dir,
      sourceDirectory: dir,
      repoOwner,
      repoName,
      repoBranch: "main",
      sourceSignature: "STALE_SIGNATURE",
      installedAt: 1,
      targets: [],
    };
  };
  function clean() {
    resetRegistry();
    fs.rmSync(path.join(skillsDir(), "updates-cache.json"), { force: true });
    fs.rmSync(path.join(skillsDir(), "ssot"), { recursive: true, force: true });
  }
  const LIMITED = { ok: false, status: 403, json: async () => ({}), text: async () => "" };

  // Grok's three repros. In each, both requested ids must come back with a row.
  const CASES = [
    {
      name: "the very first tree call is rate-limited",
      fetch: () => async () => LIMITED,
      updated: 0,
    },
    {
      name: "the first raw download is rate-limited",
      fetch: () => async (url) =>
        isGitHubApi(url) ? { ok: true, status: 200, json: async () => ({ tree: TREE }) } : LIMITED,
      updated: 0,
    },
    {
      name: "the second repo is rate-limited after the first succeeded",
      fetch: () => {
        let trees = 0;
        return async (url) => {
          if (isGitHubApi(url)) {
            trees += 1;
            return trees === 1
              ? { ok: true, status: 200, json: async () => ({ tree: TREE }) }
              : LIMITED;
          }
          return { ok: true, status: 200, text: async () => "---\nname: Foo\ndescription: d\n---\n" };
        };
      },
      updated: 1,
    },
  ];

  for (const scenario of CASES) {
    it(`reports every requested id when ${scenario.name}`, async () => {
      clean();
      const realFetch = global.fetch;
      try {
        seed([managed("o/r:a", "a"), managed("o/r2:c", "c")]);
        global.fetch = scenario.fetch();

        const ids = ["o/r:a", "o/r2:c"];
        const res = await skills.updateSkills(ids);

        assert.ok(res.rateLimited, "precondition: the run stopped on a rate limit");
        assert.equal(res.updated, scenario.updated);
        assert.deepEqual(
          res.results.map((row) => row.id).sort(),
          [...ids].sort(),
          "no requested id may be dropped from the report",
        );
        assert.equal(
          res.updated + res.skipped + res.failed,
          res.results.length,
          "counts must reconcile with the rows",
        );
      } finally {
        global.fetch = realFetch;
        clean();
      }
    });
  }
});
