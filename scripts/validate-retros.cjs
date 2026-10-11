const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RETRO_ROOT = path.join(ROOT, "docs", "retrospective");

const REQUIRED_KEYS = ["repo", "layer", "module", "severity", "design_mismatch", "detection_gap"];
const ALLOWED_LAYER = new Set(["frontend", "backend", "fullstack", "infra"]);
const ALLOWED_SEVERITY = new Set(["S1", "S2", "S3", "S4"]);
const ALLOWED_YN = new Set(["yes", "no"]);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  const body = match[1];
  const out = {};
  let currentListKey = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && currentListKey) {
      if (!Array.isArray(out[currentListKey])) out[currentListKey] = [];
      out[currentListKey].push(listItem[1].trim());
      continue;
    }

    const kv = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();

    if (value === "") {
      out[key] = [];
      currentListKey = key;
      continue;
    }

    currentListKey = null;
    out[key] = value;
  }

  return out;
}

function listRepoDirs(retroRoot) {
  if (!fs.existsSync(retroRoot)) return [];
  return fs
    .readdirSync(retroRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function listRetrosForRepo(repoDirPath) {
  if (!fs.existsSync(repoDirPath)) return [];
  return fs
    .readdirSync(repoDirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_index.md")
    .map((entry) => entry.name)
    .sort();
}

function runRetroValidation({ root = ROOT } = {}) {
  const errors = [];
  const retroRoot = path.join(root, "docs", "retrospective");

  const globalIndexPath = path.join(retroRoot, "_index.md");
  if (!fs.existsSync(globalIndexPath)) {
    errors.push(`Missing global index: ${path.relative(root, globalIndexPath)}`);
    return { errors, warnings: [] };
  }
  const globalIndexText = readText(globalIndexPath);

  const repoDirs = listRepoDirs(retroRoot);
  for (const repo of repoDirs) {
    const repoDirPath = path.join(retroRoot, repo);
    const repoIndexPath = path.join(repoDirPath, "_index.md");

    if (!fs.existsSync(repoIndexPath)) {
      errors.push(`Missing repo index: ${path.relative(root, repoIndexPath)}`);
      continue;
    }
    const repoIndexText = readText(repoIndexPath);

    for (const fileName of listRetrosForRepo(repoDirPath)) {
      const fullPath = path.join(repoDirPath, fileName);
      const relPath = path.join("docs", "retrospective", repo, fileName);
      // Markdown references always use URL separators, including on Windows.
      const relPathFromRetro = path.posix.join(repo, fileName);
      const text = readText(fullPath);
      const fm = parseFrontmatter(text);

      if (!fm) {
        errors.push(`${relPath}: missing YAML frontmatter`);
        continue;
      }

      for (const key of REQUIRED_KEYS) {
        if (!(key in fm) || String(fm[key]).trim() === "") {
          errors.push(`${relPath}: missing required frontmatter key '${key}'`);
        }
      }

      if (fm.repo && fm.repo !== repo) {
        errors.push(`${relPath}: frontmatter repo='${fm.repo}' does not match directory '${repo}'`);
      }
      if (fm.layer && !ALLOWED_LAYER.has(fm.layer)) {
        errors.push(`${relPath}: invalid layer '${fm.layer}'`);
      }
      if (fm.severity && !ALLOWED_SEVERITY.has(fm.severity)) {
        errors.push(`${relPath}: invalid severity '${fm.severity}'`);
      }
      if (fm.design_mismatch && !ALLOWED_YN.has(fm.design_mismatch)) {
        errors.push(`${relPath}: design_mismatch must be yes|no`);
      }
      if (fm.detection_gap && !ALLOWED_YN.has(fm.detection_gap)) {
        errors.push(`${relPath}: detection_gap must be yes|no`);
      }

      if (!globalIndexText.includes(relPathFromRetro)) {
        errors.push(`${relPath}: not referenced in docs/retrospective/_index.md`);
      }
      if (!repoIndexText.includes(fileName)) {
        errors.push(`${relPath}: not referenced in docs/retrospective/${repo}/_index.md`);
      }
    }
  }

  return { errors, warnings: [] };
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : ROOT;

  const { errors } = runRetroValidation({ root });
  if (errors.length) {
    console.error("Retrospective validation errors:");
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log("Retrospective validation ok.");
}

module.exports = { runRetroValidation, parseFrontmatter };

if (require.main === module) {
  main();
}
