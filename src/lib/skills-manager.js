const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveGrokHome } = require("./grok-hook");
const { resolveAntigravitySkillDirs } = require("./antigravity-paths");

const DEFAULT_REPOS = [
  { owner: "anthropics", name: "skills", branch: "main", enabled: true },
  { owner: "ComposioHQ", name: "awesome-claude-skills", branch: "master", enabled: true },
  { owner: "cexll", name: "myclaude", branch: "master", enabled: true },
  { owner: "JimLiu", name: "baoyu-skills", branch: "main", enabled: true },
];

const TARGETS = {
  claude: { id: "claude", label: "Claude", dir: () => path.join(os.homedir(), ".claude", "skills") },
  codex: { id: "codex", label: "Codex", dir: () => path.join(resolveCodexHome(), "skills") },
  acode: { id: "acode", label: "AStudio", dir: () => path.join(resolveAcodeHome(), "skills") },
  grok: { id: "grok", label: "Grok", dir: () => path.join(resolveGrokHome(process.env), "skills") },
  antigravity: { id: "antigravity", label: "Antigravity", dirs: () => resolveAntigravitySkillDirs(process.env) },
  gemini: { id: "gemini", label: "Gemini", dir: () => path.join(os.homedir(), ".gemini", "skills") },
  opencode: { id: "opencode", label: "OpenCode", dir: () => path.join(os.homedir(), ".config", "opencode", "skills") },
  openclaw: { id: "openclaw", label: "OpenClaw", dir: resolveOpenClawSkillsDir },
  hermes: { id: "hermes", label: "Hermes", dir: () => path.join(os.homedir(), ".hermes", "skills") },
  // ZCode currently exposes skills through its plugin cache rather than a
  // documented user-writable skills directory. Surface it in the inventory
  // and filters, but never offer sync/delete operations against the cache.
  zcode: { id: "zcode", label: "ZCode", manageable: false },
  agents: { id: "agents", label: "Agents", visible: false, dir: () => path.join(os.homedir(), ".agents", "skills") },
};

function resolveCodexHome() {
  return String(process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
}

function resolveAcodeHome() {
  return String(process.env.TOKENTRACKER_ACODE_HOME || "").trim() || path.join(os.homedir(), ".acode");
}

function resolveZcodeHome() {
  return String(process.env.ZCODE_HOME || "").trim() || path.join(os.homedir(), ".zcode");
}

function resolveOpenClawHome() {
  return String(process.env.TOKENTRACKER_OPENCLAW_HOME || "").trim() || path.join(os.homedir(), ".openclaw");
}

// OpenClaw can point at an arbitrary active workspace. Only scan that one
// explicit workspace; recursively scanning ~/.openclaw would incorrectly
// import backup/config snapshots belonging to other devices.
function resolveOpenClawSkillsDir() {
  const home = resolveOpenClawHome();
  const override = String(process.env.TOKENTRACKER_OPENCLAW_WORKSPACE || "").trim();
  let workspace = override;
  if (!workspace) {
    const config = readJson(path.join(home, "openclaw.json"), null);
    workspace = String(config?.agents?.defaults?.workspace || "").trim();
  }
  if (!workspace) workspace = path.join(home, "workspace");
  if (!path.isAbsolute(workspace)) workspace = path.resolve(home, workspace);
  return path.join(workspace, "skills");
}

// Dual contract: a target exposes either dir() → string (single path) or
// dirs() → string[] (parallel-write to multiple paths, e.g. Antigravity which
// has separate user-skills dirs for the main app and the IDE). Consumers must
// route through these helpers so the single-path targets stay zero-overhead.
function targetDirs(target) {
  if (!target || target.manageable === false) return [];
  if (typeof target.dirs === "function") return target.dirs();
  if (typeof target.dir === "function") return [target.dir()];
  return [];
}

// Used for surfacing one path in UI/local-api responses. For multi-dir targets
// this is the canonical "first" entry by convention (main app before IDE).
function targetPrimaryDir(target) {
  return targetDirs(target)[0] || null;
}

const FETCH_TIMEOUT_MS = 20_000;
const DISCOVER_CONCURRENCY = 4;
const DISCOVER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const OWNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
    this.code = "RATE_LIMITED";
    this.status = 429;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const pool = new Array(Math.min(limit, items.length)).fill(0).map(runNext);
  await Promise.all(pool);
  return results;
}

function dataDir() {
  return path.join(os.homedir(), ".tokentracker", "skills");
}

function registryPath() {
  return path.join(dataDir(), "registry.json");
}

function ssotDir() {
  return path.join(dataDir(), "managed");
}

function trashDir() {
  return path.join(dataDir(), ".trash");
}

const TRASH_TTL_MS = 5 * 60 * 1000; // 5 minutes

function discoverCachePath() {
  return path.join(dataDir(), "discover-cache.json");
}

function activityPath() {
  return path.join(dataDir(), "activity.jsonl");
}

const ACTIVITY_MAX = 500;

// Append-only skill activity log, mirroring the queue.jsonl culture: best-effort,
// auto-capped, latest-wins on read. Privacy: verbs + skill name + targets only —
// never prompts or file contents. Never throws (logging must not block a mutation).
function appendActivity(event) {
  try {
    ensureDir(dataDir());
    const record = JSON.stringify({ ts: Date.now(), ...event });
    fs.appendFileSync(activityPath(), `${record}\n`, { mode: 0o600 });
    const stat = fs.statSync(activityPath());
    if (stat.size > 256 * 1024) {
      const lines = fs.readFileSync(activityPath(), "utf8").split("\n").filter(Boolean).slice(-ACTIVITY_MAX);
      fs.writeFileSync(activityPath(), `${lines.join("\n")}\n`, { mode: 0o600 });
    }
  } catch (_e) {
    // best-effort
  }
}

function readActivity(limit = 100) {
  try {
    const raw = fs.readFileSync(activityPath(), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const want = Math.max(1, Math.min(ACTIVITY_MAX, Number(limit) || 100));
    return lines
      .slice(-want)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_e) {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch (_e) {
    return [];
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_e) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function readRegistry() {
  const registry = readJson(registryPath(), null);
  if (registry && typeof registry === "object") {
    return {
      repos: Array.isArray(registry.repos) ? registry.repos : DEFAULT_REPOS,
      skills: Array.isArray(registry.skills) ? registry.skills : [],
    };
  }
  return { repos: DEFAULT_REPOS, skills: [] };
}

function saveRegistry(registry) {
  writeJson(registryPath(), registry);
}

function sanitizePathSegment(value) {
  const segment = String(value || "").trim();
  if (!segment || segment === "." || segment === "..") return null;
  if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return null;
  return segment;
}

function sanitizeRelativePath(value) {
  const input = String(value || "").trim();
  const raw = input.replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return null;
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(input) || path.win32.isAbsolute(raw)) return null;
  const parts = raw.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes(":"))) return null;
  return parts.join("/");
}

function sanitizeLocalSkillPath(value) {
  const safe = sanitizeRelativePath(value);
  if (!safe) return null;
  if (safe.split("/").some((part) => part.startsWith("."))) return null;
  return safe;
}

function installNameFromDirectory(directory) {
  const safe = sanitizeRelativePath(directory);
  if (!safe) return null;
  return sanitizePathSegment(safe.split("/").pop());
}

function targetList() {
  return Object.values(TARGETS)
    .filter((target) => target.visible !== false)
    .map((target) => ({
      id: target.id,
      label: target.label,
      path: targetPrimaryDir(target),
      manageable: target.manageable !== false,
    }));
}

// Read a single scalar field from YAML frontmatter. Handles inline values
// (`key: value`, optionally quoted) AND block scalars (`key: >` / `key: |`, with
// optional chomping `+`/`-`), where the value lives on the following indented
// lines. Without block-scalar support, `description: >` skills surfaced their
// description as a bare ">" or "|" (the block indicator itself).
function readYamlField(yaml, key) {
  const lines = String(yaml).split("\n");
  const header = new RegExp(`^(\\s*)${key}:[ \\t]*(.*)$`);
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(header);
    if (!match) continue;
    const indent = match[1].length;
    const inline = match[2].trim();
    if (/^[>|][+-]?$/.test(inline)) {
      const collected = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === "") {
          collected.push("");
          continue;
        }
        const lineIndent = lines[j].match(/^(\s*)/)[1].length;
        if (lineIndent <= indent) break; // dedent ends the block
        collected.push(lines[j].trim());
      }
      return collected.join(" ");
    }
    return inline.replace(/^["']/, "").replace(/["']$/, "");
  }
  return "";
}

function readSkillMetadata(markdown, fallbackName) {
  const raw = String(markdown || "");
  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  const source = frontmatter ? frontmatter[1] : raw;
  const name = readYamlField(source, "name") || fallbackName || "Skill";
  const description = readYamlField(source, "description");
  return {
    name: name.trim(),
    description: description.replace(/\s+/g, " ").trim(),
  };
}

// Skills are marked by SKILL.md (canonical) or skill.md (legacy). Discovery uses
// a case-insensitive regex, so detection/adoption MUST accept both spellings —
// otherwise a lowercase skill.md installs but is invisible to the unmanaged scan
// and to local-skill adoption. Returns the marker's absolute path, or null.
function findSkillMarker(dir) {
  for (const name of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_e) {
      // not present under this spelling
    }
  }
  return null;
}

const MAX_LOCAL_SKILL_SCAN_DEPTH = 3;

function scanSkillDirectories(rootDir, { maxDepth = MAX_LOCAL_SKILL_SCAN_DEPTH } = {}) {
  const found = [];
  const walk = (dir, relDir = "", depth = 0) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!entry.name || entry.name.startsWith(".")) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (findSkillMarker(full)) {
        found.push(rel);
        continue;
      }
      // Direct symlinked skills are accepted above, but symlinked group folders
      // are not traversed so the scan stays within the target skills tree.
      if (entry.isDirectory() && depth + 1 < maxDepth) walk(full, rel, depth + 1);
    }
  };
  walk(rootDir);
  return found;
}

const INVENTORY_PLUGIN_SCAN_DEPTH = 6;

function completeTargetStates(activeTargetId) {
  return Object.fromEntries(
    Object.keys(TARGETS).map((id) => [id, id === activeTargetId ? "synced" : "off"]),
  );
}

function inventorySkillFromMarker({
  marker,
  directory,
  id,
  targetId,
  scope,
  sourceName = null,
}) {
  try {
    const metadata = readSkillMetadata(
      fs.readFileSync(marker, "utf8"),
      installNameFromDirectory(directory) || directory,
    );
    return {
      id,
      key: id,
      name: metadata.name,
      description: metadata.description,
      directory,
      readmeUrl: null,
      repoOwner: null,
      repoName: null,
      repoBranch: null,
      installedAt: null,
      managed: false,
      readOnly: true,
      inventoryOnly: true,
      scope,
      sourceName,
      targets: [targetId],
      targetStates: completeTargetStates(targetId),
    };
  } catch (_e) {
    return null;
  }
}

// Plugin caches use <publisher>/<plugin>/<version>/skills/<skill>/SKILL.md.
// Walk only far enough to find a directory literally named "skills", then use
// the bounded skill scanner below it. We never traverse node_modules, hidden
// metadata directories, or symlinked group directories.
function scanPluginInventoryRoot({ root, targetId }) {
  const found = [];
  const walk = (dir, depth = 0) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (!entry.name || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase() === "skills") {
        const container = path.relative(root, full).replace(/\\/g, "/");
        const beforeSkills = container.split("/").filter(Boolean).slice(0, -1);
        // Drop the cache version from the identity so installing a newer plugin
        // version updates one inventory row instead of creating a duplicate.
        const looksLikeVersion = (value) => /^v?\d+(?:\.\d+)*$/.test(String(value || ""));
        const packageParts =
          beforeSkills.length > 1 && looksLikeVersion(beforeSkills[beforeSkills.length - 1])
            ? beforeSkills.slice(0, -1)
            : beforeSkills;
        const sourceName = packageParts.join("/") || beforeSkills.join("/") || null;
        for (const directory of scanSkillDirectories(full, { maxDepth: 5 })) {
          const marker = findSkillMarker(path.join(full, directory));
          if (!marker) continue;
          const sourceKey = sourceName || "plugin";
          const id = `inventory:${targetId}:plugin:${sourceKey}:${directory}`;
          const skill = inventorySkillFromMarker({
            marker,
            directory,
            id,
            targetId,
            scope: "plugin",
            sourceName,
          });
          if (skill) found.push(skill);
        }
        continue;
      }
      if (depth + 1 < INVENTORY_PLUGIN_SCAN_DEPTH) walk(full, depth + 1);
    }
  };
  walk(root);
  return found;
}

function listInventorySkills() {
  const sources = [
    {
      root: path.join(resolveCodexHome(), "plugins", "cache"),
      targetId: "codex",
    },
    {
      root: path.join(os.homedir(), ".claude", "plugins", "cache"),
      targetId: "claude",
    },
    {
      root: path.join(resolveZcodeHome(), "cli", "plugins", "cache"),
      targetId: "zcode",
    },
  ];
  const byId = new Map();
  for (const source of sources) {
    const skills = scanPluginInventoryRoot(source);
    // Later (normally newer, lexically sorted cache version) copies replace an
    // older version with the same stable plugin+skill identity.
    for (const skill of skills) byId.set(skill.id.toLowerCase(), skill);
  }
  return Array.from(byId.values());
}

const HASH_IGNORE = new Set([".git", ".DS_Store", "Thumbs.db", ".gitignore"]);

// Stable content fingerprint of a skill directory: walk files in sorted order,
// hashing each relative path + exec bit + bytes. Normalization-tolerant
// (ignores VCS/OS noise) so it answers "did this skill change?" cheaply. Used to
// record what was installed so checkUpdates() can detect upstream drift.
function hashDirectory(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (relDir) => {
    const absDir = relDir ? path.join(dir, relDir) : dir;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (HASH_IGNORE.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isFile()) {
        const abs = path.join(dir, rel);
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch (_e) {
          continue;
        }
        const execBit = process.platform === "win32" ? 0 : stat.mode & 0o111 ? 1 : 0;
        hash.update(`${rel} ${execBit} `);
        try {
          hash.update(fs.readFileSync(abs));
        } catch (_e) {
          // unreadable file — fold its absence in deterministically
        }
        hash.update(" ");
      }
    }
  };
  walk("");
  return hash.digest("hex");
}

function pathStrictlyWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Guard against copying a directory into a DESCENDANT of itself, which makes
// cpSync recurse infinitely (dst/dst/dst…; issue #61 in the reference manager).
// Uses literal resolved paths, not realpath: a target that is a symlink pointing
// back at the SSOT source is a legitimate idempotent re-link (we removePath it
// before re-creating), not recursion — resolving symlinks here would wrongly
// reject every re-sync.
function assertNotNested(source, dest) {
  const a = path.resolve(source);
  const b = path.resolve(dest);
  if (a === b) return; // same literal path = idempotent overwrite, not nesting
  if (pathStrictlyWithin(a, b) || pathStrictlyWithin(b, a)) {
    throw new Error("Refusing to sync a skill into its own directory tree");
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tokentracker-skills",
      },
      signal: controller.signal,
    });
    if (response.status === 429 || response.status === 403) {
      throw new RateLimitError(`GitHub rate-limited this request (HTTP ${response.status}). Try again later.`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: "text/plain", "User-Agent": "tokentracker-skills" },
      signal: controller.signal,
    });
    if (response.status === 429 || response.status === 403) {
      throw new RateLimitError(`GitHub rate-limited this request (HTTP ${response.status}). Try again later.`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function githubRawUrl(owner, name, branch, filePath) {
  return `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function githubDocUrl(owner, name, branch, filePath) {
  return `https://github.com/${owner}/${name}/blob/${branch}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function getRepoTree(repo) {
  const branches = [];
  if (repo.branch && !String(repo.branch).match(/^head$/i)) branches.push(repo.branch);
  if (!branches.includes("main")) branches.push("main");
  if (!branches.includes("master")) branches.push("master");

  let lastError = null;
  for (const branch of branches) {
    try {
      const data = await fetchJson(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      );
      if (Array.isArray(data?.tree)) return { branch, tree: data.tree };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to read ${repo.owner}/${repo.name}`);
}

// Upstream signature for one skill subtree: hash the sorted "path:blobSha" pairs
// of every file under `sourceDir`. Git blob SHAs change iff content changes, so
// comparing a stored signature against a freshly fetched tree detects an
// "update available" using a SINGLE tree API call per repo — no per-file fetch.
function sourceSignatureFromTree(tree, sourceDir) {
  if (!Array.isArray(tree) || !sourceDir) return null;
  const prefix = `${sourceDir}/`;
  const rels = tree
    .filter(
      (entry) =>
        entry?.type === "blob" &&
        entry.sha &&
        (entry.path === sourceDir || String(entry.path || "").startsWith(prefix)),
    )
    .map((entry) => `${entry.path}:${entry.sha}`)
    .sort();
  if (!rels.length) return null;
  return crypto.createHash("sha256").update(rels.join("\n")).digest("hex");
}

function buildSkillKey(skill) {
  return `${skill.repoOwner}/${skill.repoName}:${skill.directory}`;
}

function normalizeRepo(repo) {
  return {
    owner: String(repo?.owner || "").trim(),
    name: String(repo?.name || "").trim(),
    branch: String(repo?.branch || "main").trim() || "main",
    enabled: repo?.enabled !== false,
  };
}

async function discoverRepoSkills(repoInput) {
  const repo = normalizeRepo(repoInput);
  if (!repo.owner || !repo.name || !repo.enabled) return [];
  const { branch, tree } = await getRepoTree(repo);
  const skillFiles = tree
    .filter((entry) => entry?.type === "blob" && /(^|\/)SKILL\.md$/i.test(entry.path || ""))
    .slice(0, 200);

  const skills = await mapWithConcurrency(skillFiles, DISCOVER_CONCURRENCY, async (entry) => {
    const docPath = entry.path.replace(/\\/g, "/");
    // Strip the marker case-insensitively (SKILL.md or legacy skill.md) so a
    // lowercase-marker repo derives the right directory instead of falling
    // through to repo.name — mirrors findSkillMarker() on the local side.
    const directory = docPath.replace(/(^|\/)(?:SKILL|skill)\.md$/i, "") || repo.name;
    const installName = installNameFromDirectory(directory || repo.name);
    if (!installName) return null;
    let metadata = { name: installName, description: "" };
    try {
      metadata = readSkillMetadata(await fetchText(githubRawUrl(repo.owner, repo.name, branch, docPath)), installName);
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      // Keep the skill discoverable even if metadata fetch fails.
    }
    return {
      key: `${repo.owner}/${repo.name}:${directory || repo.name}`,
      name: metadata.name,
      description: metadata.description,
      directory: directory || repo.name,
      readmeUrl: githubDocUrl(repo.owner, repo.name, branch, docPath),
      repoOwner: repo.owner,
      repoName: repo.name,
      repoBranch: branch,
    };
  });
  return skills.filter(Boolean);
}

function dedupeSkills(skills) {
  const byKey = new Map();
  for (const skill of skills) byKey.set(buildSkillKey(skill).toLowerCase(), skill);
  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function readDiscoverCache(fingerprint) {
  const data = readJson(discoverCachePath(), null);
  if (!data || typeof data !== "object" || !Array.isArray(data.skills)) return null;
  if (data.fingerprint !== fingerprint) return null;
  if (!Number.isFinite(data.generatedAt)) return null;
  if (Date.now() - data.generatedAt > DISCOVER_CACHE_TTL_MS) return null;
  return data;
}

function writeDiscoverCache(fingerprint, skills) {
  writeJson(discoverCachePath(), { fingerprint, generatedAt: Date.now(), skills });
}

function invalidateDiscoverCache() {
  try {
    fs.rmSync(discoverCachePath(), { force: true });
  } catch (_e) {
    // ignore
  }
}

async function discoverSkills({ force = false } = {}) {
  const registry = readRegistry();
  const enabled = registry.repos.map(normalizeRepo).filter((repo) => repo.enabled);
  if (!enabled.length) return { skills: [], cached: false, generatedAt: Date.now() };

  const fingerprint = enabled
    .map((repo) => `${repo.owner}/${repo.name}@${repo.branch}`)
    .sort()
    .join("|");

  if (!force) {
    const cached = readDiscoverCache(fingerprint);
    if (cached) return { skills: cached.skills, cached: true, generatedAt: cached.generatedAt };
  }

  const settled = await Promise.allSettled(enabled.map(discoverRepoSkills));
  const merged = dedupeSkills(settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
  if (!merged.length) {
    const rateLimited = settled.find(
      (result) => result.status === "rejected" && result.reason instanceof RateLimitError,
    );
    if (rateLimited) throw rateLimited.reason;
  }
  writeDiscoverCache(fingerprint, merged);
  return { skills: merged, cached: false, generatedAt: Date.now() };
}

function removePath(targetPath) {
  if (!fs.existsSync(targetPath) && !isSymlink(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function isSymlink(targetPath) {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch (_e) {
    return false;
  }
}

function targetSkillPath(baseDir, directory) {
  const safe = sanitizeRelativePath(directory);
  if (!safe) return null;
  const root = path.resolve(baseDir);
  const targetPath = path.resolve(root, safe);
  if (!pathStrictlyWithin(root, targetPath)) return null;
  try {
    const rootStat = fs.statSync(root);
    if (!rootStat.isDirectory()) return null;
  } catch (e) {
    if (e?.code !== "ENOENT") return null;
  }
  const parts = safe.split("/");
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }
  return targetPath;
}

function managedSkillPath(directory) {
  const skillPath = targetSkillPath(ssotDir(), directory);
  if (!skillPath) throw new Error(`Invalid skill directory: ${directory}`);
  return skillPath;
}

function copyDir(source, dest) {
  assertNotNested(source, dest);
  removePath(dest);
  fs.cpSync(source, dest, { recursive: true, force: true });
}

function removeEmptyAncestors(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (pathStrictlyWithin(stop, current)) {
    try {
      fs.rmdirSync(current);
    } catch (_e) {
      return;
    }
    current = path.dirname(current);
  }
}

function syncSkillToTarget(directory, targetId) {
  const target = TARGETS[targetId];
  if (!target || target.manageable === false) throw new Error(`Unsupported target: ${targetId}`);
  const source = managedSkillPath(directory);
  if (!fs.existsSync(source)) throw new Error(`Managed skill not found: ${directory}`);
  for (const baseDir of targetDirs(target)) {
    const dest = targetSkillPath(baseDir, directory);
    if (!dest) throw new Error(`Invalid skill directory: ${directory}`);
    assertNotNested(source, dest);
    ensureDir(path.dirname(dest));
    removePath(dest);
    try {
      fs.symlinkSync(source, dest, "dir");
    } catch (_e) {
      copyDir(source, dest);
    }
  }
}

function removeSkillFromTarget(directory, targetId) {
  const target = TARGETS[targetId];
  if (!target) return;
  for (const baseDir of targetDirs(target)) {
    const targetPath = targetSkillPath(baseDir, directory);
    if (!targetPath) continue;
    removePath(targetPath);
    removeEmptyAncestors(path.dirname(targetPath), baseDir);
  }
}

function scanTargetSkill(directory, targetId) {
  const target = TARGETS[targetId];
  if (!target) return false;
  for (const baseDir of targetDirs(target)) {
    const candidate = targetSkillPath(baseDir, directory);
    if (!candidate) continue;
    if (fs.existsSync(candidate) || isSymlink(candidate)) return true;
  }
  return false;
}

// Disk truth for one (skill, target): "synced" (present + resolvable),
// "orphan" (a dangling symlink whose SSOT source was deleted), or "off".
// Powers the tri-state agent dots so the UI never claims a skill is synced when
// its link is broken. For multi-dir targets, the healthiest state wins.
function classifyTargetSkill(directory, targetId) {
  const target = TARGETS[targetId];
  if (!target) return "off";
  let state = "off";
  for (const baseDir of targetDirs(target)) {
    const candidate = targetSkillPath(baseDir, directory);
    if (!candidate) continue;
    if (fs.existsSync(candidate)) return "synced";
    if (isSymlink(candidate)) state = "orphan";
  }
  return state;
}

function listInstalledSkills() {
  purgeExpiredTrash();
  const registry = readRegistry();
  const managed = registry.skills
    .filter((skill) => !skill.trashedAt)
    .map((skill) => {
      const intended = new Set(skill.targets || []);
      const targetStates = {};
      const targets = [];
      for (const id of Object.keys(TARGETS)) {
        let state = classifyTargetSkill(skill.directory, id);
        // Registry says it should be synced here, but disk lost it → orphan.
        if (state === "off" && intended.has(id)) state = "orphan";
        targetStates[id] = state;
        if (state === "synced") targets.push(id);
      }
      return { ...skill, managed: true, targets, targetStates };
    });

  const managedDirs = new Set(managed.map((skill) => skill.directory.toLowerCase()));
  const unmanaged = new Map();
  for (const target of Object.values(TARGETS)) {
    for (const dir of targetDirs(target)) {
      for (const directory of scanSkillDirectories(dir)) {
        if (!directory || managedDirs.has(directory.toLowerCase())) continue;
        const skillPath = findSkillMarker(path.join(dir, directory));
        if (!skillPath) continue;
        const metadata = readSkillMetadata(fs.readFileSync(skillPath, "utf8"), installNameFromDirectory(directory) || directory);
        const key = directory.toLowerCase();
        if (!unmanaged.has(key)) {
          unmanaged.set(key, {
            id: `local:${directory}`,
            key: `local:${directory}`,
            name: metadata.name,
            description: metadata.description,
            directory,
            readmeUrl: null,
            repoOwner: null,
            repoName: null,
            repoBranch: null,
            installedAt: null,
            managed: false,
            targets: [],
            // Complete map (all agents default "off") so the frontend can trust
            // targetStates as the single source of truth — same shape as managed.
            targetStates: Object.fromEntries(Object.keys(TARGETS).map((id) => [id, "off"])),
            targetPaths: {},
          });
        }
        const skill = unmanaged.get(key);
        if (!skill.targets.includes(target.id)) skill.targets.push(target.id);
        skill.targetStates[target.id] = "synced";
        if (!skill.targetPaths[target.id]) skill.targetPaths[target.id] = path.join(dir, directory);
      }
    }
  }

  return [...managed, ...unmanaged.values(), ...listInventorySkills()].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return byName;
    return String(a.id || a.key || "").localeCompare(String(b.id || b.key || ""));
  });
}

async function installSkill(skillInput, targetIds = ["claude", "codex"]) {
  const skill = {
    key: String(skillInput?.key || ""),
    name: String(skillInput?.name || ""),
    description: String(skillInput?.description || ""),
    directory: String(skillInput?.directory || ""),
    readmeUrl: skillInput?.readmeUrl || null,
    repoOwner: String(skillInput?.repoOwner || ""),
    repoName: String(skillInput?.repoName || ""),
    repoBranch: String(skillInput?.repoBranch || "main") || "main",
  };
  if (!skill.repoOwner || !skill.repoName) throw new Error("Missing GitHub repository information");
  const sourceDir = sanitizeRelativePath(skill.directory);
  // GitHub-sourced skills keep the historical flat install name even when
  // sourceDirectory is nested; local nested-skill support uses importLocalSkill().
  const installName = installNameFromDirectory(sourceDir);
  if (!sourceDir || !installName) throw new Error("Invalid skill directory");

  const registry = readRegistry();
  const existingConflict = registry.skills.find(
    (entry) =>
      entry.directory.toLowerCase() === installName.toLowerCase() &&
      `${entry.repoOwner}/${entry.repoName}`.toLowerCase() !== `${skill.repoOwner}/${skill.repoName}`.toLowerCase(),
  );
  if (existingConflict) {
    throw new Error(
      `Skill directory "${installName}" is already managed by ${existingConflict.repoOwner}/${existingConflict.repoName}`,
    );
  }

  const { branch, tree } = await getRepoTree({
    owner: skill.repoOwner,
    name: skill.repoName,
    branch: skill.repoBranch,
  });
  const files = tree.filter(
    (entry) => entry?.type === "blob" && (entry.path === sourceDir || String(entry.path || "").startsWith(`${sourceDir}/`)),
  );
  if (!files.some((entry) => /(^|\/)SKILL\.md$/i.test(entry.path))) throw new Error("SKILL.md not found in selected directory");

  const dest = managedSkillPath(installName);
  const temp = path.join(dataDir(), "tmp", `${installName}-${Date.now()}`);
  removePath(temp);
  ensureDir(temp);
  try {
    for (const entry of files) {
      const relative = entry.path === sourceDir ? path.basename(entry.path) : entry.path.slice(sourceDir.length + 1);
      const safeRelative = sanitizeRelativePath(relative);
      if (!safeRelative) continue;
      const out = path.join(temp, safeRelative);
      ensureDir(path.dirname(out));
      fs.writeFileSync(out, await fetchText(githubRawUrl(skill.repoOwner, skill.repoName, branch, entry.path)));
    }
    removePath(dest);
    ensureDir(path.dirname(dest));
    fs.renameSync(temp, dest);
  } catch (error) {
    removePath(temp);
    throw error;
  }

  const skillMarker = findSkillMarker(dest);
  const skillMd = skillMarker ? fs.readFileSync(skillMarker, "utf8") : "";
  const metadata = readSkillMetadata(skillMd, skill.name || installName);
  const selectedTargets = targetIds.filter((id) => TARGETS[id]);
  const installed = {
    id: `${skill.repoOwner}/${skill.repoName}:${sourceDir}`,
    key: `${skill.repoOwner}/${skill.repoName}:${sourceDir}`,
    name: metadata.name,
    description: metadata.description || skill.description,
    directory: installName,
    sourceDirectory: sourceDir,
    readmeUrl: githubDocUrl(skill.repoOwner, skill.repoName, branch, `${sourceDir}/SKILL.md`),
    repoOwner: skill.repoOwner,
    repoName: skill.repoName,
    repoBranch: branch,
    installedAt: Date.now(),
    // Fingerprints power idempotent reinstall + the "update available" badge.
    contentHash: hashDirectory(dest),
    sourceSignature: sourceSignatureFromTree(tree, sourceDir),
    targets: selectedTargets,
  };

  registry.skills = registry.skills.filter((entry) => entry.id !== installed.id && entry.directory.toLowerCase() !== installName.toLowerCase());
  registry.skills.push(installed);
  saveRegistry(registry);

  for (const id of selectedTargets) syncSkillToTarget(installName, id);
  appendActivity({ action: "install", name: installed.name, directory: installName, targets: selectedTargets, source: `${skill.repoOwner}/${skill.repoName}` });
  return { ...installed, managed: true, targets: selectedTargets };
}

function uninstallSkill(id) {
  const registry = readRegistry();
  const skill = registry.skills.find((entry) => entry.id === id || entry.key === id);
  if (!skill) throw new Error("Managed skill not found");
  const ssotPath = managedSkillPath(skill.directory);
  for (const targetId of Object.keys(TARGETS)) removeSkillFromTarget(skill.directory, targetId);
  // Move SSOT copy into a trash bucket so it can be restored briefly. The
  // registry entry is retained but flagged so restoreSkill can re-link it.
  if (fs.existsSync(ssotPath)) {
    ensureDir(trashDir());
    const stamp = Date.now();
    const trashName = `${Buffer.from(String(skill.directory || ""), "utf8").toString("base64url")}-${stamp}`;
    const trashPath = path.join(trashDir(), trashName);
    try {
      fs.renameSync(ssotPath, trashPath);
      removeEmptyAncestors(path.dirname(ssotPath), ssotDir());
      skill.trashedAt = stamp;
      skill.trashedDirectory = path.basename(trashPath);
      skill.previousTargets = skill.targets || [];
      skill.targets = [];
      const others = registry.skills.filter((entry) => entry.id !== skill.id);
      registry.skills = [...others, skill];
      saveRegistry(registry);
      purgeExpiredTrash();
      appendActivity({ action: "uninstall", name: skill.name, directory: skill.directory });
      return { ok: true, trashed: true, restoreId: skill.id, ttlMs: TRASH_TTL_MS };
    } catch (_e) {
      removePath(ssotPath);
      removeEmptyAncestors(path.dirname(ssotPath), ssotDir());
    }
  }
  registry.skills = registry.skills.filter((entry) => entry.id !== skill.id);
  saveRegistry(registry);
  appendActivity({ action: "uninstall", name: skill.name, directory: skill.directory });
  return { ok: true, trashed: false };
}

function purgeExpiredTrash() {
  try {
    const registry = readRegistry();
    const now = Date.now();
    let dirty = false;
    registry.skills = registry.skills.filter((skill) => {
      if (!skill.trashedAt) return true;
      if (now - skill.trashedAt < TRASH_TTL_MS) return true;
      const trashPath = skill.trashedDirectory ? path.join(trashDir(), skill.trashedDirectory) : null;
      if (trashPath) removePath(trashPath);
      dirty = true;
      return false;
    });
    if (dirty) saveRegistry(registry);
  } catch (_e) {
    // best-effort
  }
}

function restoreSkill(id) {
  const registry = readRegistry();
  const skill = registry.skills.find((entry) => entry.id === id || entry.key === id);
  if (!skill || !skill.trashedAt) throw new Error("Nothing to restore");
  if (Date.now() - skill.trashedAt > TRASH_TTL_MS) {
    throw new Error("Restore window expired");
  }
  const trashPath = path.join(trashDir(), skill.trashedDirectory || "");
  const ssotPath = managedSkillPath(skill.directory);
  if (!fs.existsSync(trashPath)) throw new Error("Trashed copy is missing");
  ensureDir(path.dirname(ssotPath));
  removePath(ssotPath);
  fs.renameSync(trashPath, ssotPath);
  const targets = Array.isArray(skill.previousTargets) ? skill.previousTargets : [];
  skill.targets = targets;
  delete skill.trashedAt;
  delete skill.trashedDirectory;
  delete skill.previousTargets;
  saveRegistry(registry);
  for (const targetId of targets) syncSkillToTarget(skill.directory, targetId);
  appendActivity({ action: "restore", name: skill.name, directory: skill.directory, targets });
  return { ...skill, managed: true, targets };
}

function setSkillTargets(id, targetIds) {
  const registry = readRegistry();
  const skill = registry.skills.find((entry) => entry.id === id || entry.key === id);
  if (!skill) throw new Error("Managed skill not found");
  const selectedTargets = targetIds.filter((targetId) => TARGETS[targetId]);
  for (const targetId of Object.keys(TARGETS)) {
    if (selectedTargets.includes(targetId)) syncSkillToTarget(skill.directory, targetId);
    else removeSkillFromTarget(skill.directory, targetId);
  }
  skill.targets = selectedTargets;
  saveRegistry(registry);
  appendActivity({ action: "set_targets", name: skill.name, directory: skill.directory, targets: selectedTargets });
  return { ...skill, managed: true, targets: selectedTargets };
}

function findLocalSkillSource(directory) {
  const sourceDir = sanitizeLocalSkillPath(directory);
  if (!sourceDir) return null;
  for (const target of Object.values(TARGETS)) {
    for (const baseDir of targetDirs(target)) {
      const skillPath = targetSkillPath(baseDir, sourceDir);
      if (!skillPath) continue;
      if (findSkillMarker(skillPath)) {
        return { path: skillPath, targetId: target.id };
      }
    }
  }
  return null;
}

function importLocalSkill(directory, targetIds = []) {
  const sourceDir = sanitizeLocalSkillPath(directory);
  if (!sourceDir) throw new Error("Invalid skill directory");
  const registry = readRegistry();
  const existing = registry.skills.find((entry) => String(entry.directory || "").toLowerCase() === sourceDir.toLowerCase());
  if (existing) {
    if (!String(existing.id || existing.key || "").startsWith("local:")) {
      throw new Error(`Skill directory "${sourceDir}" is already managed by another installed skill`);
    }
    if (!targetIds || !targetIds.length) {
      return { ...existing, managed: true, targets: existing.targets || [] };
    }
    return setSkillTargets(existing.id, targetIds);
  }

  const source = findLocalSkillSource(sourceDir);
  if (!source) throw new Error("Local skill not found");

  const dest = managedSkillPath(sourceDir);
  copyDir(source.path, dest);
  const skillMarker = findSkillMarker(dest);
  const metadata = readSkillMetadata(skillMarker ? fs.readFileSync(skillMarker, "utf8") : "", installNameFromDirectory(sourceDir));
  const discoveredTargets = Object.keys(TARGETS).filter((targetId) => scanTargetSkill(sourceDir, targetId));
  const selectedTargets = (targetIds.length ? targetIds : discoveredTargets).filter((targetId) => TARGETS[targetId]);
  const skill = {
    id: `local:${sourceDir}`,
    key: `local:${sourceDir}`,
    name: metadata.name,
    description: metadata.description,
    directory: sourceDir,
    sourceDirectory: sourceDir,
    readmeUrl: null,
    repoOwner: null,
    repoName: null,
    repoBranch: null,
    installedAt: Date.now(),
    contentHash: hashDirectory(dest),
    targets: selectedTargets,
  };

  registry.skills.push(skill);
  saveRegistry(registry);
  for (const targetId of Object.keys(TARGETS)) {
    if (selectedTargets.includes(targetId)) syncSkillToTarget(sourceDir, targetId);
    else removeSkillFromTarget(sourceDir, targetId);
  }
  appendActivity({ action: "import", name: skill.name, directory: sourceDir, targets: selectedTargets });
  return { ...skill, managed: true, targets: selectedTargets };
}

function deleteLocalSkill(directory, targetIds = []) {
  const installName = sanitizeLocalSkillPath(directory);
  if (!installName) throw new Error("Invalid skill directory");
  const selectedTargets = targetIds.length ? targetIds : Object.keys(TARGETS);
  for (const targetId of selectedTargets) removeSkillFromTarget(installName, targetId);
  appendActivity({ action: "delete_local", directory: installName, targets: selectedTargets });
  return { ok: true };
}

function listRepos() {
  return readRegistry().repos.map(normalizeRepo);
}

function addRepo(repoInput) {
  const repo = normalizeRepo(repoInput);
  if (!repo.owner || !repo.name) throw new Error("Repository owner and name are required");
  if (!OWNER_NAME_PATTERN.test(repo.owner) || !OWNER_NAME_PATTERN.test(repo.name)) {
    throw new Error("Repository owner and name may only contain letters, digits, '.', '_', or '-'");
  }
  if (!OWNER_NAME_PATTERN.test(repo.branch)) {
    throw new Error("Repository branch contains unsupported characters");
  }
  const registry = readRegistry();
  registry.repos = registry.repos.filter(
    (entry) => `${entry.owner}/${entry.name}`.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase(),
  );
  registry.repos.push(repo);
  saveRegistry(registry);
  invalidateDiscoverCache();
  return repo;
}

function removeRepo(owner, name) {
  const registry = readRegistry();
  registry.repos = registry.repos.filter(
    (entry) => `${entry.owner}/${entry.name}`.toLowerCase() !== `${owner}/${name}`.toLowerCase(),
  );
  saveRegistry(registry);
  invalidateDiscoverCache();
  return { ok: true };
}

async function searchSkillsSh(query, limit = 20, offset = 0) {
  const q = String(query || "").trim();
  if (q.length < 2) return { query: q, totalCount: 0, skills: [] };
  const url = new URL("https://skills.sh/api/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.max(1, Math.min(50, Number(limit) || 20))));
  url.searchParams.set("offset", String(Math.max(0, Number(offset) || 0)));
  const data = await fetchJson(url.toString());
  const skills = Array.isArray(data?.skills)
    ? data.skills
        .map((entry) => {
          const [owner, repoName] = String(entry?.source || "").split("/", 2);
          if (!owner || !repoName || owner.includes(".") || repoName.includes(".")) return null;
          return {
            key: String(entry.id || `${owner}/${repoName}:${entry.skillId || entry.name}`),
            name: String(entry.name || entry.skillId || "Skill"),
            description: "",
            directory: String(entry.skillId || entry.name || ""),
            repoOwner: owner,
            repoName,
            repoBranch: "main",
            readmeUrl: `https://github.com/${owner}/${repoName}`,
            installs: Number(entry.installs || 0),
          };
        })
        .filter(Boolean)
    : [];
  return {
    query: String(data?.query || q),
    totalCount: Number(data?.count || skills.length),
    skills,
  };
}

const UPDATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — bounds GitHub tree calls
const UPDATE_CHECK_CONCURRENCY = 2;

function updateCachePath() {
  return path.join(dataDir(), "updates-cache.json");
}

// Compare each managed GitHub/skills.sh skill's stored source signature against a
// freshly fetched repo tree. One tree call per repo (skills from the same repo
// share it), concurrency-limited and cached for an hour so a background check
// can't trip GitHub's unauthenticated rate limit. Returns { updates: {id:bool} }.
// Read-only: never mutates the registry or the on-disk skills.
async function checkUpdates({ force = false } = {}) {
  const registry = readRegistry();
  const managed = registry.skills.filter(
    (skill) => !skill.trashedAt && skill.repoOwner && skill.repoName && skill.sourceSignature,
  );
  const fingerprint = managed
    .map((skill) => `${skill.id}@${skill.sourceSignature}`)
    .sort()
    .join("|");

  if (!force) {
    const cached = readJson(updateCachePath(), null);
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      Number.isFinite(cached.checkedAt) &&
      Date.now() - cached.checkedAt < UPDATE_CACHE_TTL_MS &&
      cached.updates &&
      typeof cached.updates === "object"
    ) {
      return { updates: cached.updates, checkedAt: cached.checkedAt, cached: true };
    }
  }

  const byRepo = new Map();
  for (const skill of managed) {
    const branch = skill.repoBranch || "main";
    const key = `${skill.repoOwner}/${skill.repoName}@${branch}`.toLowerCase();
    if (!byRepo.has(key)) {
      byRepo.set(key, { owner: skill.repoOwner, name: skill.repoName, branch, skills: [] });
    }
    byRepo.get(key).skills.push(skill);
  }

  const updates = {};
  await mapWithConcurrency(Array.from(byRepo.values()), UPDATE_CHECK_CONCURRENCY, async (repo) => {
    let tree;
    try {
      ({ tree } = await getRepoTree(repo));
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return; // leave this repo's skills as unknown (omitted)
    }
    for (const skill of repo.skills) {
      const signature = sourceSignatureFromTree(tree, skill.sourceDirectory || skill.directory);
      if (signature) updates[skill.id] = signature !== skill.sourceSignature;
    }
  });

  const checkedAt = Date.now();
  writeJson(updateCachePath(), { fingerprint, checkedAt, updates });
  return { updates, checkedAt, cached: false };
}

// skills.sh exposes only /api/search (no leaderboard endpoint), so "Popular" is
// built honestly on top of it: fan a handful of broad seed queries, merge by
// skill key keeping the highest install count, sort by installs. Cached for 6h.
const POPULAR_SEED_QUERIES = [
  "agent",
  "code",
  "test",
  "review",
  "git",
  "web",
  "design",
  "data",
  "docs",
  "python",
  "api",
  "deploy",
];
const POPULAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function popularCachePath() {
  return path.join(dataDir(), "popular-cache.json");
}

async function fetchPopularSkillsSh({ force = false, limit = 60 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 60));
  if (!force) {
    const cached = readJson(popularCachePath(), null);
    if (
      cached &&
      Array.isArray(cached.skills) &&
      Number.isFinite(cached.generatedAt) &&
      Date.now() - cached.generatedAt < POPULAR_CACHE_TTL_MS
    ) {
      return { skills: cached.skills.slice(0, cap), cached: true, generatedAt: cached.generatedAt };
    }
  }

  const lists = await mapWithConcurrency(POPULAR_SEED_QUERIES, DISCOVER_CONCURRENCY, async (q) => {
    try {
      return (await searchSkillsSh(q, 30, 0)).skills;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return [];
    }
  });

  const byKey = new Map();
  for (const list of lists) {
    for (const skill of list) {
      const key = String(skill.key || `${skill.repoOwner}/${skill.repoName}:${skill.directory}`).toLowerCase();
      const prev = byKey.get(key);
      if (!prev || (skill.installs || 0) > (prev.installs || 0)) byKey.set(key, skill);
    }
  }
  const skills = Array.from(byKey.values())
    .sort((a, b) => (b.installs || 0) - (a.installs || 0))
    .slice(0, 200);
  writeJson(popularCachePath(), { generatedAt: Date.now(), skills });
  return { skills: skills.slice(0, cap), cached: false, generatedAt: Date.now() };
}

module.exports = {
  addRepo,
  assertNotNested,
  checkUpdates,
  discoverSkills,
  deleteLocalSkill,
  fetchPopularSkillsSh,
  findSkillMarker,
  hashDirectory,
  importLocalSkill,
  installSkill,
  listInstalledSkills,
  listRepos,
  readActivity,
  removeRepo,
  restoreSkill,
  searchSkillsSh,
  setSkillTargets,
  sourceSignatureFromTree,
  targetList,
  uninstallSkill,
};
