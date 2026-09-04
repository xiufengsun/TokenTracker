const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, describe, it } = require("node:test");

// Isolate ~/.tokentracker/skills + target skill dirs into a temp HOME. Must run
// before requiring the module so that every `os.homedir()` callback resolves
// within the sandbox.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-skills-mgr-"));
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.TOKENTRACKER_GROK_HOME = path.join(sandboxHome, ".grok");
delete process.env.GROK_HOME;
delete process.env.TOKENTRACKER_ANTIGRAVITY_HOME;

const skills = require("../src/lib/skills-manager");

function writeLocalSkill(targetDir, directory, body = "---\nname: Local Skill\ndescription: Test skill\n---\n") {
  const dir = path.join(sandboxHome, targetDir, directory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

function writeRegistry(registry) {
  const file = path.join(sandboxHome, ".tokentracker", "skills", "registry.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}

function writeManagedSkill(directory, body = "---\nname: Managed Skill\n---\n") {
  const dir = path.join(sandboxHome, ".tokentracker", "skills", "managed", directory);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  return dir;
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("skills-manager targetList", () => {
  it("includes AStudio and resolves its home override", () => {
    const previousHome = process.env.TOKENTRACKER_ACODE_HOME;
    try {
      process.env.TOKENTRACKER_ACODE_HOME = path.join(sandboxHome, ".astudio-custom");
      const target = skills.targetList().find((entry) => entry.id === "acode");
      assert.ok(target);
      assert.equal(target.label, "AStudio");
      assert.equal(target.path, path.join(sandboxHome, ".astudio-custom", "skills"));
      assert.equal(target.manageable, true);
    } finally {
      restoreEnv("TOKENTRACKER_ACODE_HOME", previousHome);
    }
  });

  it("includes Grok and resolves Grok home overrides", () => {
    const prevTokenTrackerGrokHome = process.env.TOKENTRACKER_GROK_HOME;
    const prevGrokHome = process.env.GROK_HOME;
    try {
      process.env.TOKENTRACKER_GROK_HOME = path.join(sandboxHome, ".grok-prefixed");
      process.env.GROK_HOME = path.join(sandboxHome, ".grok-legacy");
      let grok = skills.targetList().find((target) => target.id === "grok");
      assert.ok(grok);
      assert.equal(grok.label, "Grok");
      assert.equal(grok.path, path.join(sandboxHome, ".grok-prefixed", "skills"));

      delete process.env.TOKENTRACKER_GROK_HOME;
      grok = skills.targetList().find((target) => target.id === "grok");
      assert.equal(grok.path, path.join(sandboxHome, ".grok-legacy", "skills"));
    } finally {
      restoreEnv("TOKENTRACKER_GROK_HOME", prevTokenTrackerGrokHome);
      restoreEnv("GROK_HOME", prevGrokHome);
    }
  });
});

describe("skills-manager addRepo validation", () => {
  it("rejects path-traversal-like owner/name", () => {
    assert.throws(() => skills.addRepo({ owner: "..", name: "repo" }), /owner and name/);
    assert.throws(() => skills.addRepo({ owner: "foo/../bar", name: "repo" }), /owner and name/);
    assert.throws(() => skills.addRepo({ owner: "foo", name: "bar/baz" }), /owner and name/);
    assert.throws(() => skills.addRepo({ owner: "foo", name: "repo", branch: "../main" }), /branch/);
  });

  it("accepts well-formed owner/name", () => {
    const repo = skills.addRepo({ owner: "anthropics", name: "skills" });
    assert.equal(repo.owner, "anthropics");
    assert.equal(repo.name, "skills");
    assert.equal(repo.branch, "main");
    // clean up to avoid leaking into other tests
    skills.removeRepo("anthropics", "skills");
  });
});

describe("skills-manager importLocalSkill sanitization", () => {
  it("rejects invalid directory names", () => {
    assert.throws(() => skills.importLocalSkill("..", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("../foo", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("foo/../bar", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("/tmp/foo", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("C:/foo", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("C:\\foo", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("\\\\server\\share\\foo", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("foo:bar", []), /Invalid skill directory/);
    assert.throws(() => skills.importLocalSkill("", []), /Invalid skill directory/);
    assert.throws(() => skills.deleteLocalSkill("C:/foo", ["hermes"]), /Invalid skill directory/);
    assert.throws(() => skills.deleteLocalSkill("\\\\server\\share\\foo", ["hermes"]), /Invalid skill directory/);
  });

  it("throws when skill is not present in any target folder", () => {
    assert.throws(() => skills.importLocalSkill("not-there", ["claude"]), /Local skill not found/);
  });
});

describe("skills-manager nested local skill folders", () => {
  const nestedSkill = "apple/apple-notes";
  const archivedSkill = ".archive/old-skill";

  before(() => {
    writeLocalSkill(".hermes/skills", nestedSkill, "---\nname: Apple Notes\ndescription: Nested Hermes skill\n---\n");
    writeLocalSkill(".hermes/skills", archivedSkill, "---\nname: Archived Skill\ndescription: Should stay hidden\n---\n");
  });

  it("lists nested skills below target skill folders while skipping hidden groups", () => {
    const installed = skills.listInstalledSkills();
    const nested = installed.find((s) => s.directory === nestedSkill);
    assert.ok(nested, "nested Hermes skill should be discovered");
    assert.equal(nested.name, "Apple Notes");
    assert.deepEqual(nested.targets, ["hermes"]);
    assert.equal(nested.targetStates.hermes, "synced");
    assert.equal(installed.some((s) => s.directory === archivedSkill), false);
  });

  it("rejects direct local imports and deletes from hidden skill groups", () => {
    assert.throws(() => skills.importLocalSkill(archivedSkill, ["hermes"]), /Invalid skill directory/);
    assert.throws(() => skills.deleteLocalSkill(archivedSkill, ["hermes"]), /Invalid skill directory/);
  });

  it("can promote a nested unmanaged skill without flattening its target path", () => {
    const imported = skills.importLocalSkill(nestedSkill, ["hermes", "codex"]);
    assert.equal(imported.managed, true);
    assert.equal(imported.directory, nestedSkill);
    assert.deepEqual(new Set(imported.targets), new Set(["hermes", "codex"]));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".hermes/skills", nestedSkill, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".codex/skills", nestedSkill, "SKILL.md")));

    skills.uninstallSkill(imported.id);
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".hermes/skills", nestedSkill)));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".codex/skills", nestedSkill)));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".hermes/skills/apple")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".codex/skills/apple")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".tokentracker/skills/managed/apple")));
  });

  it("keeps non-empty parent folders when removing one nested managed skill", () => {
    writeLocalSkill(".hermes/skills", "shared-parent/remove-one", "---\nname: Remove One\n---\n");
    writeLocalSkill(".hermes/skills", "shared-parent/keep-one", "---\nname: Keep One\n---\n");
    const removed = skills.importLocalSkill("shared-parent/remove-one", ["hermes"]);
    const kept = skills.importLocalSkill("shared-parent/keep-one", ["hermes"]);

    skills.uninstallSkill(removed.id);

    assert.ok(!fs.existsSync(path.join(sandboxHome, ".tokentracker/skills/managed/shared-parent/remove-one")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".tokentracker/skills/managed/shared-parent/keep-one/SKILL.md")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".hermes/skills/shared-parent/keep-one/SKILL.md")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".tokentracker/skills/managed/shared-parent")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".hermes/skills/shared-parent")));

    skills.uninstallSkill(kept.id);
  });

  it("uses the leaf folder name as fallback display name for nested unmanaged skills", () => {
    writeLocalSkill(".hermes/skills", "fallback/no-name", "---\ndescription: Missing explicit name\n---\n");
    const entry = skills.listInstalledSkills().find((s) => s.directory === "fallback/no-name");
    assert.ok(entry);
    assert.equal(entry.name, "no-name");
  });

  it("does not scan arbitrarily deep local skill directory trees", () => {
    writeLocalSkill(".hermes/skills", "too/deep/for/scan/nested", "---\nname: Too Deep\n---\n");
    const installed = skills.listInstalledSkills();
    assert.equal(installed.some((s) => s.directory === "too/deep/for/scan/nested"), false);
  });

  it("does not delete through symlinked parent directories", (t) => {
    const root = path.join(sandboxHome, ".hermes/skills");
    const outside = path.join(sandboxHome, "outside-skill-delete");
    const victim = path.join(outside, "victim");
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, "keep.txt"), "important");
    fs.mkdirSync(root, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(root, "linked-delete"), "dir");
    } catch (_e) {
      t.skip("directory symlinks are not available on this platform");
      return;
    }

    skills.deleteLocalSkill("linked-delete/victim", ["hermes"]);

    assert.ok(fs.existsSync(path.join(victim, "keep.txt")));
  });

  it("does not import through symlinked parent directories", (t) => {
    const root = path.join(sandboxHome, ".hermes/skills");
    const outside = path.join(sandboxHome, "outside-skill-import");
    writeLocalSkill("outside-skill-import", "external-skill", "---\nname: External Skill\n---\n");
    fs.mkdirSync(root, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(root, "linked-import"), "dir");
    } catch (_e) {
      t.skip("directory symlinks are not available on this platform");
      return;
    }

    assert.throws(() => skills.importLocalSkill("linked-import/external-skill", ["hermes"]), /Local skill not found/);
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".tokentracker/skills/managed/linked-import/external-skill")));
  });

  it("keeps undo restore available for nested skills whose flattened names collide", () => {
    writeLocalSkill(".hermes/skills", "collision/a-b", "---\nname: Collision Nested\ndescription: Nested\n---\n");
    writeLocalSkill(".hermes/skills", "collision__a-b", "---\nname: Collision Flat\ndescription: Flat\n---\n");
    const nested = skills.importLocalSkill("collision/a-b", ["hermes"]);
    const flat = skills.importLocalSkill("collision__a-b", ["hermes"]);
    const originalNow = Date.now;
    Date.now = () => 1234567890;
    try {
      const nestedRemoved = skills.uninstallSkill(nested.id);
      const flatRemoved = skills.uninstallSkill(flat.id);
      assert.equal(nestedRemoved.trashed, true);
      assert.equal(flatRemoved.trashed, true);
      assert.notEqual(nestedRemoved.restoreId, flatRemoved.restoreId);
      skills.restoreSkill(nested.id);
      skills.restoreSkill(flat.id);
      assert.ok(fs.existsSync(path.join(sandboxHome, ".hermes/skills/collision/a-b/SKILL.md")));
      assert.ok(fs.existsSync(path.join(sandboxHome, ".hermes/skills/collision__a-b/SKILL.md")));
    } finally {
      Date.now = originalNow;
      for (const id of [nested.id, flat.id]) {
        try {
          skills.uninstallSkill(id);
        } catch (_e) {
          // already cleaned up
        }
      }
    }
  });
});

describe("skills-manager setSkillTargets", () => {
  it("throws when skill id is unknown", () => {
    assert.throws(() => skills.setSkillTargets("missing", ["claude"]), /Managed skill not found/);
  });
});

describe("skills-manager importLocalSkill re-sync", () => {
  before(() => {
    writeLocalSkill(".claude/skills", "sample-skill");
  });

  it("re-applies targets when called again with new target set", () => {
    const first = skills.importLocalSkill("sample-skill", ["claude"]);
    assert.equal(first.managed, true);
    assert.deepEqual(first.targets, ["claude"]);
    assert.ok(fs.existsSync(path.join(sandboxHome, ".claude/skills/sample-skill/SKILL.md")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".grok/skills/sample-skill")));

    const second = skills.importLocalSkill("sample-skill", ["claude", "codex", "grok"]);
    assert.equal(second.managed, true);
    assert.deepEqual(new Set(second.targets), new Set(["claude", "codex", "grok"]));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill/SKILL.md")));
    assert.ok(fs.existsSync(path.join(sandboxHome, ".grok/skills/sample-skill/SKILL.md")));

    const third = skills.importLocalSkill("sample-skill", ["claude"]);
    assert.deepEqual(third.targets, ["claude"]);
    assert.ok(fs.existsSync(path.join(sandboxHome, ".claude/skills/sample-skill/SKILL.md")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".codex/skills/sample-skill")));
    assert.ok(!fs.existsSync(path.join(sandboxHome, ".grok/skills/sample-skill")));

    // cleanup: uninstall managed skill
    skills.uninstallSkill(third.id);
  });
});

describe("skills-manager antigravity target", () => {
  const mainSkillsDir = path.join(sandboxHome, ".gemini", "antigravity", "skills");
  const ideSkillsDir = path.join(sandboxHome, ".gemini", "antigravity-ide", "skills");
  const skillName = "ag-skill";

  before(() => {
    // Create both Antigravity main-app and IDE parent dirs so dirs() returns both
    fs.mkdirSync(path.join(sandboxHome, ".gemini", "antigravity"), { recursive: true });
    fs.mkdirSync(path.join(sandboxHome, ".gemini", "antigravity-ide"), { recursive: true });
    // Seed source skill under the main-app dir so findLocalSkillSource picks it up
    writeLocalSkill(".gemini/antigravity/skills", skillName);
  });

  it("targetList includes antigravity with the main-app dir as primary path", () => {
    const target = skills.targetList().find((t) => t.id === "antigravity");
    assert.ok(target);
    assert.equal(target.label, "Antigravity");
    assert.equal(target.path, mainSkillsDir);
  });

  it("writes to both main-app and IDE dirs in parallel on install + removes both on uninstall", () => {
    const installed = skills.importLocalSkill(skillName, ["antigravity"]);
    assert.equal(installed.managed, true);
    assert.deepEqual(installed.targets, ["antigravity"]);
    // Both directories should be populated (re-sync writes through dirs() array)
    assert.ok(fs.existsSync(path.join(mainSkillsDir, skillName, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(ideSkillsDir, skillName, "SKILL.md")));

    // Drop antigravity from target set — both dirs should be cleaned
    const cleared = skills.setSkillTargets(installed.id, []);
    assert.deepEqual(cleared.targets, []);
    assert.ok(!fs.existsSync(path.join(mainSkillsDir, skillName)));
    assert.ok(!fs.existsSync(path.join(ideSkillsDir, skillName)));

    skills.uninstallSkill(installed.id);
  });

  it("TOKENTRACKER_ANTIGRAVITY_HOME forces a single override path", () => {
    const overrideHome = path.join(sandboxHome, "custom-ag");
    const overrideSkill = "ag-skill-override";
    const prev = process.env.TOKENTRACKER_ANTIGRAVITY_HOME;
    process.env.TOKENTRACKER_ANTIGRAVITY_HOME = overrideHome;
    try {
      // targetList sees the override
      const target = skills.targetList().find((t) => t.id === "antigravity");
      assert.equal(target.path, path.join(overrideHome, "skills"));

      // Seed source under the override path so findLocalSkillSource locates it
      const seedDir = path.join(overrideHome, "skills", overrideSkill);
      fs.mkdirSync(seedDir, { recursive: true });
      fs.writeFileSync(
        path.join(seedDir, "SKILL.md"),
        "---\nname: Override Skill\ndescription: forced override\n---\n",
      );

      const installed = skills.importLocalSkill(overrideSkill, ["antigravity"]);
      assert.deepEqual(installed.targets, ["antigravity"]);
      // override path written
      assert.ok(fs.existsSync(path.join(overrideHome, "skills", overrideSkill, "SKILL.md")));
      // default-discovery paths must NOT receive a copy when override is set
      assert.ok(!fs.existsSync(path.join(mainSkillsDir, overrideSkill)));
      assert.ok(!fs.existsSync(path.join(ideSkillsDir, overrideSkill)));
      skills.uninstallSkill(installed.id);
    } finally {
      if (prev === undefined) delete process.env.TOKENTRACKER_ANTIGRAVITY_HOME;
      else process.env.TOKENTRACKER_ANTIGRAVITY_HOME = prev;
    }
  });
});

describe("skills-manager path hardening", () => {
  it("deletes through a symlinked target root", (t) => {
    const targetParent = path.join(sandboxHome, ".agents");
    const targetRoot = path.join(targetParent, "skills");
    const outside = path.join(sandboxHome, "outside-target-root");
    const victim = path.join(outside, "root-linked-victim");
    fs.mkdirSync(targetParent, { recursive: true });
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, "keep.txt"), "important");
    try {
      fs.symlinkSync(outside, targetRoot, "dir");
    } catch (_e) {
      t.skip("directory symlinks are not available on this platform");
      return;
    }

    skills.deleteLocalSkill("root-linked-victim", ["agents"]);

    assert.ok(!fs.existsSync(path.join(victim, "keep.txt")));
  });

  it("does not import through a symlinked SSOT parent", (t) => {
    const sourceDir = "ssot-linked/imported-skill";
    const managedRoot = path.join(sandboxHome, ".tokentracker", "skills", "managed");
    const outside = path.join(sandboxHome, "outside-ssot-import");
    writeLocalSkill(".config/opencode/skills", sourceDir, "---\nname: Imported Skill\n---\n");
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(managedRoot, "ssot-linked"), "dir");
    } catch (_e) {
      t.skip("directory symlinks are not available on this platform");
      return;
    }

    assert.throws(() => skills.importLocalSkill(sourceDir, []), /Invalid skill directory/);
    assert.ok(!fs.existsSync(path.join(outside, "imported-skill")));
  });

  it("does not uninstall through a symlinked SSOT parent", (t) => {
    const directory = "ssot-uninstall/victim";
    const managedRoot = path.join(sandboxHome, ".tokentracker", "skills", "managed");
    const outside = path.join(sandboxHome, "outside-ssot-uninstall");
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.mkdirSync(path.join(outside, "victim"), { recursive: true });
    fs.writeFileSync(path.join(outside, "victim", "keep.txt"), "important");
    try {
      fs.symlinkSync(outside, path.join(managedRoot, "ssot-uninstall"), "dir");
    } catch (_e) {
      t.skip("directory symlinks are not available on this platform");
      return;
    }
    writeRegistry({
      repos: [],
      skills: [{ id: `local:${directory}`, key: `local:${directory}`, name: "Victim", directory, targets: [] }],
    });

    assert.throws(() => skills.uninstallSkill(`local:${directory}`), /Invalid skill directory/);
    assert.ok(fs.existsSync(path.join(outside, "victim", "keep.txt")));
  });

  it("does not restore through a symlinked SSOT parent", (t) => {
    const directory = "ssot-restore/victim";
    const managedRoot = path.join(sandboxHome, ".tokentracker", "skills", "managed");
    const outside = path.join(sandboxHome, "outside-ssot-restore");
    const trashName = "restore-copy";
    const trashSkill = path.join(sandboxHome, ".tokentracker", "skills", ".trash", trashName);
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(trashSkill, { recursive: true });
    fs.writeFileSync(path.join(trashSkill, "SKILL.md"), "---\nname: Restore Copy\n---\n");
    try {
      fs.symlinkSync(outside, path.join(managedRoot, "ssot-restore"), "dir");
    } catch (_e) {
      t.skip("directory symlinks are not available on this platform");
      return;
    }
    writeRegistry({
      repos: [],
      skills: [
        {
          id: `local:${directory}`,
          key: `local:${directory}`,
          name: "Victim",
          directory,
          targets: [],
          trashedAt: Date.now(),
          trashedDirectory: trashName,
          previousTargets: [],
        },
      ],
    });

    assert.throws(() => skills.restoreSkill(`local:${directory}`), /Invalid skill directory/);
    assert.ok(!fs.existsSync(path.join(outside, "victim")));
    assert.ok(fs.existsSync(path.join(trashSkill, "SKILL.md")));
  });

  it("does not alias a local import to an existing GitHub-managed skill", () => {
    const directory = "github-local-conflict";
    const localDir = writeLocalSkill(".codex/skills", directory, "---\nname: Local Conflict\n---\n");
    writeManagedSkill(directory, "---\nname: GitHub Conflict\n---\n");
    writeRegistry({
      repos: [],
      skills: [
        {
          id: `owner/repo:skills/${directory}`,
          key: `owner/repo:skills/${directory}`,
          name: "GitHub Conflict",
          directory,
          sourceDirectory: `skills/${directory}`,
          repoOwner: "owner",
          repoName: "repo",
          repoBranch: "main",
          targets: [],
        },
      ],
    });

    assert.throws(() => skills.importLocalSkill(directory, ["codex"]), /already managed by another installed skill/);
    assert.match(fs.readFileSync(path.join(localDir, "SKILL.md"), "utf8"), /Local Conflict/);
  });
});
