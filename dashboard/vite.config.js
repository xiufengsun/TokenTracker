import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import os from "node:os";

const COPY_REQUIRED_KEYS = [
  "landing.meta.title",
  "landing.meta.description",
  "landing.meta.og_site_name",
  "landing.meta.og_type",
  "landing.meta.og_image",
  "landing.meta.og_url",
  "landing.meta.twitter_card",
  "share.meta.title",
  "share.meta.description",
  "share.meta.og_site_name",
  "share.meta.og_type",
  "share.meta.og_image",
  "share.meta.og_url",
  "share.meta.twitter_card",
];

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COPY_PATH = path.join(ROOT_DIR, "src", "content", "copy.csv");
const PACKAGE_JSON_PATH = path.resolve(ROOT_DIR, "..", "package.json");
const REPO_ROOT = path.resolve(ROOT_DIR, "..");
const LOCAL_SYNC_TIMEOUT_MS = 120_000;

function loadAppVersion() {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.version || "").trim() || null;
  } catch (error) {
    console.warn("[tokentracker] Failed to read package.json version:", error.message);
    return null;
  }
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = raw[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (!row.every((cell) => cell.trim() === "")) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    if (ch === "\r") {
      continue;
    }

    field += ch;
  }

  row.push(field);
  if (!row.every((cell) => cell.trim() === "")) {
    rows.push(row);
  }

  return rows;
}

function loadCopyRegistry() {
  let raw = "";
  try {
    raw = fs.readFileSync(COPY_PATH, "utf8");
  } catch (error) {
    console.warn("[tokentracker] Failed to read copy registry:", error.message);
    return new Map();
  }

  const rows = parseCsv(raw);
  if (!rows.length) return new Map();

  const header = rows[0].map((cell) => cell.trim());
  const keyIndex = header.indexOf("key");
  const textIndex = header.indexOf("text");
  if (keyIndex === -1 || textIndex === -1) {
    console.warn("[tokentracker] Copy registry missing key/text columns.");
    return new Map();
  }

  const map = new Map();
  rows.slice(1).forEach((cells) => {
    const key = String(cells[keyIndex] || "").trim();
    if (!key) return;
    const text = String(cells[textIndex] ?? "").trim();
    map.set(key, text);
  });

  return map;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMeta(prefix = "landing") {
  const map = loadCopyRegistry();
  const read = (key) => map.get(`${prefix}.meta.${key}`) || "";

  const missing = COPY_REQUIRED_KEYS.filter((key) => !map.has(key));
  if (missing.length) {
    console.warn("[tokentracker] Copy registry missing keys:", missing.join(", "));
  }

  return {
    title: read("title"),
    description: read("description"),
    ogSiteName: read("og_site_name"),
    ogType: read("og_type"),
    ogImage: read("og_image"),
    ogUrl: read("og_url"),
    twitterCard: read("twitter_card"),
  };
}

function resolveMetaPrefix(ctx) {
  const rawPath = String(ctx?.path || ctx?.filename || ctx?.originalUrl || "").toLowerCase();
  if (rawPath.includes("share")) return "share";
  return "landing";
}

function injectRichMeta(html, prefix) {
  const meta = buildMeta(prefix);
  const replacements = {
    __TOKENTRACKER_TITLE__: meta.title,
    __TOKENTRACKER_DESCRIPTION__: meta.description,
    __TOKENTRACKER_OG_SITE_NAME__: meta.ogSiteName,
    __TOKENTRACKER_OG_TITLE__: meta.title,
    __TOKENTRACKER_OG_DESCRIPTION__: meta.description,
    __TOKENTRACKER_OG_IMAGE__: meta.ogImage,
    __TOKENTRACKER_OG_TYPE__: meta.ogType,
    __TOKENTRACKER_OG_URL__: meta.ogUrl,
    __TOKENTRACKER_TWITTER_CARD__: meta.twitterCard,
    __TOKENTRACKER_TWITTER_TITLE__: meta.title,
    __TOKENTRACKER_TWITTER_DESCRIPTION__: meta.description,
    __TOKENTRACKER_TWITTER_IMAGE__: meta.ogImage,
  };

  let output = html;
  for (const [token, value] of Object.entries(replacements)) {
    output = output.replaceAll(token, escapeHtml(value));
  }
  return output;
}

function richLinkMetaPlugin() {
  return {
    name: "tokentracker-rich-link-meta",
    transformIndexHtml(html, ctx) {
      return injectRichMeta(html, resolveMetaPrefix(ctx));
    },
  };
}

// Per-route static SEO/AEO pages. The dashboard is a single-page app that serves
// one index.html for every route, with a canonical hardcoded to the homepage.
// Google therefore collapses /ip-check and /leaderboard into "/" ("Page with
// redirect" / "Alternate page with canonical"), so those routes never rank on
// their own. To fix indexability WITHOUT adding rollup inputs (which reshuffle
// shared chunks and have historically broken the native OAuth callback — see
// CLAUDE.md), we clone the built dist/index.html in closeBundle and rewrite the
// canonical, social meta, <title>, description, JSON-LD, and the crawlable
// aeo-seed-content block per route. Vercel rewrites map the clean URLs to these
// files (see vercel.json). Runtime JS still boots the SPA and renders the real
// route, so users see the interactive page while crawlers get a self-canonical,
// route-specific document.
const ROUTE_SEO_PAGES = [
  {
    file: "ip-check.html",
    url: "https://www.tokentracker.cc/ip-check",
    title: "Claude IP Check — Exit IP Reputation, Geo & Risk Score",
    description:
      "Free Claude IP check: see the exit IP used to reach Claude Code plus reputation, geo and cleanliness/risk (纯净度/风险) signals that can trigger sign-in blocks or rate limits.",
    jsonld: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": "https://www.tokentracker.cc/#organization",
          name: "Token Tracker",
          url: "https://www.tokentracker.cc/",
        },
        {
          "@type": "WebPage",
          "@id": "https://www.tokentracker.cc/ip-check#webpage",
          url: "https://www.tokentracker.cc/ip-check",
          name: "Claude IP Check — Exit IP Reputation, Geo & Risk Score",
          isPartOf: { "@id": "https://www.tokentracker.cc/#website" },
          description:
            "Check the exit IP used to reach Claude Code, with reputation, geolocation and cleanliness/risk (纯净度/风险) signals.",
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://www.tokentracker.cc/" },
            { "@type": "ListItem", position: 2, name: "Claude IP Check", item: "https://www.tokentracker.cc/ip-check" },
          ],
        },
        {
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: "What is a Claude IP check?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "A Claude IP check shows the public exit IP that your network uses to reach Claude Code and Claude.ai, along with its reputation, geolocation and cleanliness/risk score, so you can tell whether the IP is likely to trigger sign-in blocks, verification, or rate limits.",
              },
            },
            {
              "@type": "Question",
              name: "Why does my Claude exit IP reputation matter?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Anthropic and its anti-abuse providers score the reputation of the exit IP. Shared, datacenter, VPN, or previously abused IPs (low 纯净度 / high 风险) are more likely to face extra verification, throttling, or blocked logins, even on a paid plan.",
              },
            },
            {
              "@type": "Question",
              name: "How do I check the exit IP used for Claude Code?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Open the Token Tracker IP check page. It detects your current public exit IP and shows its geolocation, network type, and reputation/risk signals so you can decide whether to switch networks before using Claude Code.",
              },
            },
          ],
        },
      ],
    },
    seed: `<main class="aeo-seed-content" aria-label="Claude IP Check AI-readable summary">
      <h1>Claude IP Check: exit IP reputation, geolocation and cleanliness/risk score</h1>
      <p>
        This free Claude IP check detects the public exit IP your network uses to reach Claude Code and
        Claude.ai, then reports its reputation, geolocation, network type, and a cleanliness/risk score.
        A low-reputation, datacenter, VPN, or previously abused exit IP is more likely to trigger extra
        sign-in verification, rate limiting, or blocked logins — even on a paid Claude plan.
      </p>
      <h2>Claude IP 纯净度与风险检测</h2>
      <p>
        本页用于检测你访问 Claude Code / Claude.ai 时使用的出口 IP：展示该 IP 的归属地、网络类型、
        信誉度与"纯净度 / 风险"评分。共享 IP、机房 IP、VPN 或历史被滥用的 IP 通常纯净度低、风险高，
        更容易触发 Claude 的登录验证、限速甚至封禁。检测后可据此决定是否更换网络再使用 Claude Code。
      </p>
      <h2>What this Claude IP check reports</h2>
      <ul>
        <li>Your current public exit IP address (the IP Anthropic actually sees).</li>
        <li>Geolocation and network type (residential, datacenter, mobile, VPN/proxy).</li>
        <li>IP reputation and a cleanliness/risk score (纯净度 / 风险).</li>
        <li>Whether the IP is likely to trigger Claude sign-in verification or rate limits.</li>
      </ul>
      <h2>Part of Token Tracker</h2>
      <p>
        Token Tracker is a free, open-source, local-first dashboard that monitors AI token usage and cost
        across 27 AI coding tools including Claude Code. Install with <code>npx tokentracker-cli</code>.
      </p>
    </main>`,
  },
  {
    file: "leaderboard.html",
    url: "https://www.tokentracker.cc/leaderboard",
    title: "AI Coding Token Usage Leaderboard — Claude, Codex, Cursor",
    description:
      "Public Token Tracker leaderboard ranking AI coding token usage across Claude Code, Codex, Cursor, Gemini and 27 tools. Opt-in, privacy-first — token counts only, never prompts.",
    jsonld: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Organization",
          "@id": "https://www.tokentracker.cc/#organization",
          name: "Token Tracker",
          url: "https://www.tokentracker.cc/",
        },
        {
          "@type": "WebPage",
          "@id": "https://www.tokentracker.cc/leaderboard#webpage",
          url: "https://www.tokentracker.cc/leaderboard",
          name: "AI Coding Token Usage Leaderboard",
          isPartOf: { "@id": "https://www.tokentracker.cc/#website" },
          description:
            "Public leaderboard ranking opt-in AI coding token usage across Claude Code, Codex, Cursor, Gemini and 27 tools.",
        },
        {
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://www.tokentracker.cc/" },
            { "@type": "ListItem", position: 2, name: "Leaderboard", item: "https://www.tokentracker.cc/leaderboard" },
          ],
        },
      ],
    },
    seed: `<main class="aeo-seed-content" aria-label="AI Coding Token Usage Leaderboard AI-readable summary">
      <h1>AI coding token usage leaderboard</h1>
      <p>
        The Token Tracker leaderboard ranks opt-in AI coding token usage across Claude Code, OpenAI Codex,
        Cursor, Gemini CLI and 27 supported tools. It is privacy-first: entries are opt-in and expose token
        counts only — never prompts or conversation content. See how your AI coding token consumption
        compares with other developers by model, tool, and time window.
      </p>
      <h2>How the leaderboard works</h2>
      <ul>
        <li>Opt-in only — you choose whether to appear, using a public display name.</li>
        <li>Token counts only — never prompts, code, or conversation content.</li>
        <li>Ranks usage across Claude Code, Codex, Cursor, Gemini and 27 AI coding tools.</li>
        <li>Powered by optional Token Tracker cloud sync; local-first by default.</li>
      </ul>
      <h2>Part of Token Tracker</h2>
      <p>
        Token Tracker is a free, open-source, local-first dashboard that monitors AI token usage and cost
        across 27 AI coding tools. Install with <code>npx tokentracker-cli</code>.
      </p>
    </main>`,
  },
];

function routeSeoPagesPlugin() {
  return {
    name: "tokentracker-route-seo-pages",
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(ROOT_DIR, "dist");
      const indexPath = path.join(distDir, "index.html");
      let base;
      try {
        base = fs.readFileSync(indexPath, "utf8");
      } catch (error) {
        console.warn("[tokentracker] route SEO: dist/index.html not found, skipping.", error.message);
        return;
      }
      for (const route of ROUTE_SEO_PAGES) {
        let html = base;
        const title = escapeHtml(route.title);
        const description = escapeHtml(route.description);
        html = html
          .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${route.url}$2`)
          .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${route.url}$2`)
          .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
          .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${title}$2`)
          .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${title}$2`)
          .replace(/(<meta name="description" content=")[^"]*(")/, `$1${description}$2`)
          .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${description}$2`)
          .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${description}$2`)
          .replace(/<main class="aeo-seed-content"[\s\S]*?<\/main>/, () => route.seed);
        if (route.jsonld) {
          const ldMarkup = `<script type="application/ld+json">\n${JSON.stringify(route.jsonld, null, 2)}\n    </script>`;
          html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => ldMarkup);
        }
        fs.writeFileSync(path.join(distDir, route.file), html, "utf8");
        console.log(`[tokentracker] route SEO page emitted: dist/${route.file}`);
      }
    },
  };
}

// 本地数据 API 插件 - 直接读取 ~/.tokentracker/tracker/queue.jsonl
// 本地 API 处理函数
function trimCommandOutput(value, maxLength = 4000) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}

function readJsonBodyVite(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) return resolve({});
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function runLocalSyncCommand(extraEnv = {}, opts = {}) {
  return await new Promise((resolve, reject) => {
    const args = ["tokentracker-cli", "sync"];
    if (opts.auto === true) args.push("--auto");
    if (opts.background === true) args.push("--background");
    if (opts.allLocalSources === true) args.push("--all-local-sources");
    if (opts.drain === true) args.push("--drain");
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      handler(value);
    };

    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      finish(reject, Object.assign(new Error("Local sync timed out after 120 seconds"), {
        code: "SYNC_TIMEOUT",
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
      }));
    }, LOCAL_SYNC_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(reject, Object.assign(error, {
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
      }));
    });

    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
      };

      if (code === 0) {
        finish(resolve, result);
        return;
      }

      finish(reject, Object.assign(new Error(result.stderr || result.stdout || `Local sync exited with code ${result.code}`), result));
    });
  });
}

// Per-model pricing — delegated to src/lib/pricing/ (CJS). vite.config.js is
// ESM but createRequire (already imported above) gives us first-class CJS
// interop. The pricing module loads its bundled seed snapshot synchronously
// at require-time, so dev-server mocks still get LiteLLM-backed cost data.
const __viteRequire = createRequire(import.meta.url);
const __pricing = __viteRequire(path.resolve(REPO_ROOT, "src/lib/pricing"));
const { getModelPricing, computeRowCost } = __pricing;

async function handleLocalApi(req, res, url) {
  // Honor the dashboard's tz / tz_offset_minutes params so hourly/daily
  // buckets match the real backend (local-api.js / cloud edge funcs).
  // Without this, hour_start (always UTC) gets sliced as if it were local
  // time — e.g. UTC 06:00 lands in the "06:00" bucket for a Beijing user,
  // but should be 14:00 Beijing.
  const tzParam = String(url.searchParams.get("tz") || "").trim();
  const rawOffset = Number(url.searchParams.get("tz_offset_minutes"));
  const offsetMinutes = Number.isFinite(rawOffset) ? Math.trunc(rawOffset) : null;
  const zonedFormatter = tzParam
    ? (() => {
        try {
          return new Intl.DateTimeFormat("en-CA", {
            timeZone: tzParam,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          });
        } catch (_e) {
          return null;
        }
      })()
    : null;
  function getZonedParts(iso) {
    if (!iso) return null;
    const dt = new Date(iso);
    if (!Number.isFinite(dt.getTime())) return null;
    if (zonedFormatter) {
      const acc = {};
      for (const p of zonedFormatter.formatToParts(dt)) {
        if (p.type && p.value) acc[p.type] = p.value;
      }
      const y = acc.year, m = acc.month, d = acc.day;
      const h = Number(acc.hour);
      const mi = Number(acc.minute);
      if (y && m && d && Number.isFinite(h) && Number.isFinite(mi)) {
        return { day: `${y}-${m}-${d}`, hour: h, minute: mi };
      }
    }
    const shifted = offsetMinutes != null
      ? new Date(dt.getTime() + offsetMinutes * 60000)
      : dt;
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const d = String(shifted.getUTCDate()).padStart(2, "0");
    return {
      day: `${y}-${m}-${d}`,
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
    };
  }
  const QUEUE_PATH = path.join(os.homedir(), ".tokentracker", "tracker", "queue.jsonl");

  function isLegacyInclusiveCodexRow(row) {
    if (!row || (row.source !== "codex" && row.source !== "every-code")) return false;
    const inputTokens = Number(row.input_tokens || 0);
    const cachedInputTokens = Number(row.cached_input_tokens || 0);
    const outputTokens = Number(row.output_tokens || 0);
    const totalTokens = Number(row.total_tokens || 0);
    if (!Number.isFinite(inputTokens) || !Number.isFinite(cachedInputTokens)) return false;
    if (cachedInputTokens <= 0 || inputTokens < cachedInputTokens) return false;
    return totalTokens === inputTokens + outputTokens;
  }

  function normalizeQueueRow(row) {
    if (!isLegacyInclusiveCodexRow(row)) return row;
    return {
      ...row,
      input_tokens: Number(row.input_tokens || 0) - Number(row.cached_input_tokens || 0),
    };
  }

  function readQueueData() {
    try {
      const raw = fs.readFileSync(QUEUE_PATH, "utf8");
      const lines = raw.split("\n").filter(line => line.trim());
      const parsed = lines.map(line => JSON.parse(line));
      // Deduplicate: each sync appends cumulative totals per bucket, so for
      // each (source, model, hour_start) keep only the latest (last) entry.
      const seen = new Map();
      for (const row of parsed) {
        const key = `${row.source || ""}|${row.model || ""}|${row.hour_start || ""}`;
        seen.set(key, normalizeQueueRow(row));
      }
      return Array.from(seen.values());
    } catch (error) {
      console.warn("[localDataApi] Failed to read queue.jsonl:", error.message);
      return [];
    }
  }

  function aggregateByDay(rows) {
    const byDay = new Map();
    for (const row of rows) {
      const hourStart = row.hour_start;
      if (!hourStart) continue;
      const parts = getZonedParts(hourStart);
      if (!parts) continue;
      const day = parts.day;
      if (!byDay.has(day)) {
        byDay.set(day, {
          day,
          total_tokens: 0,
          billable_total_tokens: 0,
          total_cost_usd: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_output_tokens: 0,
          conversation_count: 0,
        });
      }
      const agg = byDay.get(day);
      agg.total_tokens += row.total_tokens || 0;
      agg.billable_total_tokens += row.total_tokens || 0;
      agg.total_cost_usd += computeRowCost(row);
      agg.input_tokens += row.input_tokens || 0;
      agg.output_tokens += row.output_tokens || 0;
      agg.cached_input_tokens += row.cached_input_tokens || 0;
      agg.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      agg.reasoning_output_tokens += row.reasoning_output_tokens || 0;
      agg.conversation_count += row.conversation_count || 0;

      if (!agg.models) {
        agg.models = {};
      }
      const model = row.model || "unknown";
      agg.models[model] = (agg.models[model] || 0) + (row.total_tokens || 0);
    }
    return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  }

  const pathname = url.pathname;

  if (pathname === "/functions/tokentracker-local-sync") {
    if (String(req.method || "GET").toUpperCase() !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
      return true;
    }

    try {
      let body = {};
      try {
        body = await readJsonBodyVite(req);
      } catch {
        body = {};
      }
      const extraEnv = {};
      const drain = body.drain === true;
      const auto = body.auto === true && !drain;
      const background = auto && body.background === true;
      const allLocalSources = background && body.allLocalSources === true;
      if (typeof body.deviceToken === "string" && body.deviceToken.trim()) {
        extraEnv.TOKENTRACKER_DEVICE_TOKEN = body.deviceToken.trim();
      }
      if (typeof body.insforgeBaseUrl === "string" && /^https?:\/\//i.test(body.insforgeBaseUrl.trim())) {
        extraEnv.TOKENTRACKER_INSFORGE_BASE_URL = body.insforgeBaseUrl.trim();
      }
      const result = await runLocalSyncCommand(extraEnv, {
        drain,
        auto,
        background,
        allLocalSources,
      });
      try {
        const esmRequire = createRequire(import.meta.url);
        const { resetUsageLimitsCache } = esmRequire("../src/lib/usage-limits");
        resetUsageLimitsCache();
      } catch (_e) {
        // ignore
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: false,
        error: error?.message || "Local sync failed",
        code: error?.code ?? null,
        stdout: error?.stdout || "",
        stderr: error?.stderr || "",
      }));
    }
    return true;
  }

  // 处理 tokentracker-outcomes
  if (pathname === "/functions/tokentracker-outcomes") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    try {
      const outcomesEnginePath = path.resolve(REPO_ROOT, "src/lib/outcomes-engine");
      const {
        readOutcomesData,
        resolveOutcomesPath,
        computeQualityPerDollar,
      } = __viteRequire(outcomesEnginePath);

      const outcomes = readOutcomesData(resolveOutcomesPath());
      if (!outcomes.length) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ available: false, from, to, by_model: [], by_tool: [], totals: null }));
        return true;
      }

      const queueRows = readQueueData();
      const result = computeQualityPerDollar(queueRows, outcomes, { from, to });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ from, to, scope: null, excluded_sources: [], ...result }));
    } catch (e) {
      console.warn("[vite-mock] tokentracker-outcomes failed:", e?.message || e);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e?.message || "Unknown error" }));
    }
    return true;
  }

  // 处理 usage-summary
  if (pathname === "/functions/tokentracker-usage-summary") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const rows = readQueueData();
    const daily = aggregateByDay(rows).filter(d => d.day >= from && d.day <= to);
    const totals = daily.reduce((acc, row) => {
      acc.total_tokens += row.total_tokens;
      acc.billable_total_tokens += row.billable_total_tokens;
      acc.total_cost_usd += row.total_cost_usd || 0;
      acc.input_tokens += row.input_tokens;
      acc.output_tokens += row.output_tokens;
      acc.cached_input_tokens += row.cached_input_tokens;
      acc.cache_creation_input_tokens += row.cache_creation_input_tokens;
      acc.reasoning_output_tokens += row.reasoning_output_tokens;
      acc.conversation_count += row.conversation_count;
      return acc;
    }, {
      total_tokens: 0, billable_total_tokens: 0, total_cost_usd: 0, input_tokens: 0,
      output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 0,
    });
    const totalCost = totals.total_cost_usd;

    // 计算 rolling 统计数据（最近7天和30天）
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const allDaily = aggregateByDay(rows);

    // 计算最近7天
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const dayData = allDaily.find(x => x.day === dayStr);
      if (dayData) last7Days.push(dayData);
    }
    const last7dTotals = last7Days.reduce((acc, row) => {
      acc.billable_total_tokens += row.billable_total_tokens;
      acc.conversation_count += row.conversation_count;
      return acc;
    }, { billable_total_tokens: 0, conversation_count: 0 });

    // 计算最近30天
    const last30Days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const dayData = allDaily.find(x => x.day === dayStr);
      if (dayData) last30Days.push(dayData);
    }
    const last30dTotals = last30Days.reduce((acc, row) => {
      acc.billable_total_tokens += row.billable_total_tokens;
      acc.conversation_count += row.conversation_count;
      return acc;
    }, { billable_total_tokens: 0, conversation_count: 0 });
    const avgPerActiveDay = last30Days.length > 0 ? Math.round(last30dTotals.billable_total_tokens / last30Days.length) : 0;

    // 计算 last_7d 和 last_30d 的日期范围
    const last7dFrom = new Date(today);
    last7dFrom.setUTCDate(last7dFrom.getUTCDate() - 6);
    const last30dFrom = new Date(today);
    last30dFrom.setUTCDate(last30dFrom.getUTCDate() - 29);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      from, to, days: daily.length,
      totals: { ...totals, total_cost_usd: totalCost.toFixed(6) },
      rolling: {
        last_7d: {
          from: last7dFrom.toISOString().slice(0, 10),
          to: todayStr,
          active_days: last7Days.length,
          totals: last7dTotals,
        },
        last_30d: {
          from: last30dFrom.toISOString().slice(0, 10),
          to: todayStr,
          active_days: last30Days.length,
          totals: last30dTotals,
          avg_per_active_day: avgPerActiveDay,
        },
      },
    }));
    return true;
  }

  // 处理 usage-daily
  if (pathname === "/functions/tokentracker-usage-daily") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const rows = readQueueData();
    const daily = aggregateByDay(rows).filter(d => d.day >= from && d.day <= to);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ from, to, data: daily }));
    return true;
  }

  // 处理 usage-monthly
  if (pathname === "/functions/tokentracker-usage-monthly") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const rows = readQueueData();
    const byMonth = new Map();
    for (const row of rows) {
      if (!row.hour_start) continue;
      const parts = getZonedParts(row.hour_start);
      if (!parts) continue;
      const day = parts.day;
      if (day < from || day > to) continue;
      const month = day.slice(0, 7);
      if (!byMonth.has(month)) {
        byMonth.set(month, {
          month,
          total_tokens: 0,
          billable_total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_output_tokens: 0,
          conversation_count: 0,
          models: {},
        });
      }
      const agg = byMonth.get(month);
      agg.total_tokens += row.total_tokens || 0;
      agg.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
      agg.input_tokens += row.input_tokens || 0;
      agg.output_tokens += row.output_tokens || 0;
      agg.cached_input_tokens += row.cached_input_tokens || 0;
      agg.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      agg.reasoning_output_tokens += row.reasoning_output_tokens || 0;
      agg.conversation_count += row.conversation_count || 0;

      const model = row.model || "unknown";
      agg.models[model] = (agg.models[model] || 0) + (row.total_tokens || 0);
    }
    const data = Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ from, to, data }));
    return true;
  }

  // 处理 usage-hourly
  if (pathname === "/functions/tokentracker-usage-hourly") {
    const day = url.searchParams.get("day") || new Date().toISOString().slice(0, 10);
    const rows = readQueueData();
    const hourlyData = [];
    for (let i = 0; i < 24; i++) {
      const hourStr = String(i).padStart(2, "0");
      hourlyData.push({
        hour: hourStr,
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        conversation_count: 0,
        models: {},
      });
    }

    for (const row of rows) {
      if (!row.hour_start) continue;
      const parts = getZonedParts(row.hour_start);
      if (!parts) continue;
      if (parts.day !== day) continue;
      const hourIdx = parts.hour;
      if (hourIdx >= 0 && hourIdx < 24) {
        const agg = hourlyData[hourIdx];
        agg.total_tokens += row.total_tokens || 0;
        agg.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
        agg.input_tokens += row.input_tokens || 0;
        agg.output_tokens += row.output_tokens || 0;
        agg.cached_input_tokens += row.cached_input_tokens || 0;
        agg.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
        agg.reasoning_output_tokens += row.reasoning_output_tokens || 0;
        agg.conversation_count += row.conversation_count || 0;

        const model = row.model || "unknown";
        agg.models[model] = (agg.models[model] || 0) + (row.total_tokens || 0);
      }
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ day, data: hourlyData }));
    return true;
  }


  // 处理 usage-heatmap
  if (pathname === "/functions/tokentracker-usage-heatmap") {
    const weeks = parseInt(url.searchParams.get("weeks") || "52", 10);
    const rows = readQueueData();
    const daily = aggregateByDay(rows);
    const today = new Date();
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - weeks * 7 + 1);
    const from = start.toISOString().slice(0, 10);
    const to = end.toISOString().slice(0, 10);
    const byDay = new Map(daily.map(d => [d.day, d]));
    const cells = [];
    const cursor = new Date(start);

    // 先收集所有有数据的天，计算 level 阈值
    const allValues = daily.map(d => d.billable_total_tokens).filter(v => v > 0).sort((a, b) => a - b);
    const maxValue = allValues.length > 0 ? allValues[allValues.length - 1] : 0;

    // 根据最大值计算 level (0-4)
    function calcLevel(value) {
      if (value <= 0) return 0;
      if (maxValue === 0) return 1;
      const ratio = value / maxValue;
      if (ratio <= 0.25) return 1;
      if (ratio <= 0.5) return 2;
      if (ratio <= 0.75) return 3;
      return 4;
    }

    while (cursor <= end) {
      const day = cursor.toISOString().slice(0, 10);
      const data = byDay.get(day);
      const billable = data?.billable_total_tokens || 0;
      cells.push({
        day,
        total_tokens: data?.total_tokens || 0,
        billable_total_tokens: billable,
        level: calcLevel(billable),
        models: data?.models || null,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const activeDays = cells.filter(c => c.billable_total_tokens > 0).length;
    // 转为 weeks 二维数组（每 7 天一组），与 local-api.js 格式一致
    const weeksArr = [];
    for (let i = 0; i < cells.length; i += 7) {
      weeksArr.push(cells.slice(i, i + 7));
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ from, to, week_starts_on: "sun", active_days: activeDays, streak_days: 0, weeks: weeksArr }));
    return true;
  }

  // 处理 usage-model-breakdown
  if (pathname === "/functions/tokentracker-usage-model-breakdown") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const rows = readQueueData();

    // 过滤日期范围
    const filteredRows = rows.filter(row => {
      if (!row.hour_start) return false;
      const parts = getZonedParts(row.hour_start);
      if (!parts) return false;
      return parts.day >= from && parts.day <= to;
    });

    const bySource = new Map();

    // 先按 source 和 model 分组统计
    for (const row of filteredRows) {
      const source = row.source || "unknown";
      const modelName = row.model || "unknown";

      if (!bySource.has(source)) {
        bySource.set(source, {
          source,
          totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" },
          models: new Map()
        });
      }
      const sourceAgg = bySource.get(source);

      // 累加 source 总计
      sourceAgg.totals.total_tokens += row.total_tokens || 0;
      sourceAgg.totals.billable_total_tokens += row.total_tokens || 0;
      sourceAgg.totals.input_tokens += row.input_tokens || 0;
      sourceAgg.totals.output_tokens += row.output_tokens || 0;
      sourceAgg.totals.cached_input_tokens += row.cached_input_tokens || 0;
      sourceAgg.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      sourceAgg.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;

      // 按 model 分组
      if (!sourceAgg.models.has(modelName)) {
        sourceAgg.models.set(modelName, {
          model: modelName,
          model_id: modelName,
          totals: { total_tokens: 0, billable_total_tokens: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_cost_usd: "0" }
        });
      }
      const modelAgg = sourceAgg.models.get(modelName);
      modelAgg.totals.total_tokens += row.total_tokens || 0;
      modelAgg.totals.billable_total_tokens += row.total_tokens || 0;
      modelAgg.totals.input_tokens += row.input_tokens || 0;
      modelAgg.totals.output_tokens += row.output_tokens || 0;
      modelAgg.totals.cached_input_tokens += row.cached_input_tokens || 0;
      modelAgg.totals.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      modelAgg.totals.reasoning_output_tokens += row.reasoning_output_tokens || 0;
    }

    // 转换为最终格式
    const sources = Array.from(bySource.values()).map(s => {
      s.models = Array.from(s.models.values()).map(m => {
        const cost = computeRowCost({
          ...m.totals,
          model: m.model,
          source: s.source,
        });
        return { ...m, totals: { ...m.totals, total_cost_usd: cost.toFixed(6) } };
      }).sort((a, b) => b.totals.total_tokens - a.totals.total_tokens);
      const sourceCost = s.models.reduce((sum, m) => sum + Number(m.totals.total_cost_usd), 0);
      s.totals.total_cost_usd = sourceCost.toFixed(6);
      return s;
    });

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      from, to, days: 0, sources,
      pricing: { model: "default", pricing_mode: "add", source: "default", effective_from: new Date().toISOString().slice(0, 10), rates_per_million_usd: { input: "1.750000", cached_input: "0.175000", output: "14.000000", reasoning_output: "14.000000" } },
    }));
    return true;
  }

  // 处理 usage-category-breakdown — Claude Code only
  // Reuse the CLI's claude-categorizer module so dev server returns the
  // same shape as the production endpoint.
  if (pathname === "/functions/tokentracker-usage-category-breakdown") {
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const requestedSource = (url.searchParams.get("source") || "claude").trim().toLowerCase();
    try {
      const categorizerPath = path.join(ROOT_DIR, "..", "src", "lib", "claude-categorizer");
      // Bust the require cache so dev edits to the categorizer module
      // surface without restarting the vite server.
      const resolved = __viteRequire.resolve(categorizerPath);
      delete __viteRequire.cache[resolved];
      const { computeClaudeCategoryBreakdown, unsupportedSourcePayload } = __viteRequire(categorizerPath);
      if (requestedSource !== "claude") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ from, to, ...unsupportedSourcePayload(requestedSource) }));
        return true;
      }
      const result = await computeClaudeCategoryBreakdown({ from, to, projectDir: process.cwd() });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ from, to, ...result }));
    } catch (e) {
      console.warn("[vite-mock] usage-category-breakdown failed:", e?.message || e);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e?.message || "compute_failed" }));
    }
    return true;
  }


  // 处理 usage-limits
  if (pathname === "/functions/tokentracker-usage-limits") {
    try {
      const esmRequire = createRequire(import.meta.url);
      const { getUsageLimits, resetUsageLimitsCache } = esmRequire("../src/lib/usage-limits");
      const forceRefresh = url.searchParams.get("refresh");
      if (forceRefresh === "1" || forceRefresh === "true") {
        resetUsageLimitsCache();
      }
      const data = await getUsageLimits({
        home: os.homedir(),
        env: process.env,
        platform: process.platform,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e?.message || "Unknown error" }));
    }
    return true;
  }

  // 处理 user-status
  if (pathname === "/functions/tokentracker-user-status") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      user_id: "local-user", email: "local@localhost", name: "Local User", is_public: false,
      created_at: new Date().toISOString(),
      pro: { active: true, sources: ["local"], expires_at: null, partial: false, as_of: new Date().toISOString() },
    }));
    return true;
  }

  return null;
}

async function proxyToLocalCli(req, res) {
  const target = `http://127.0.0.1:7680${req.url}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  const init = { method: req.method, headers };
  if (req.method && !["GET", "HEAD"].includes(req.method.toUpperCase())) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }
  try {
    const upstream = await fetch(target, init);
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (key === "content-encoding" || key === "content-length") return;
      res.setHeader(key, value);
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      error: `Local CLI not reachable on :7680 — start it with: node bin/tracker.js serve --no-sync --no-open`,
      detail: String(error?.message || error),
    }));
  }
}

function localDataApiPlugin() {
  // Pet packages are implemented in the current checkout's local API. Do not
  // proxy these routes to :7680: a developer may have an older packaged app
  // running there, which would make the import UI silently disappear even
  // though the source tree already supports the feature.
  const esmRequire = createRequire(import.meta.url);
  // Vite config reloads reuse the same node process, so the CJS require
  // cache would otherwise keep serving the local-api module loaded at the
  // first startup — evict it so a config reload picks up edits to
  // local-api.js ITSELF. Session insights is loaded lazily by that module,
  // so evict its derived-metrics scanner too; otherwise a dashboard refresh
  // can keep serving stale edit-turn, provider/model, retry, and incremental
  // scan behavior until Vite restarts.
  // NOTE: editing src/lib/*.js alone does NOT hot-reload here (those files are
  // outside dashboard's module graph). Only a Vite config reload / full restart
  // re-runs this eviction — e.g. the Sessions browser title (ai-title /
  // thread_name) and fragment merging will keep serving stale data until then.
  for (const modulePath of ["../src/lib/local-api", "../src/lib/session-analytics"]) {
    try {
      delete esmRequire.cache[esmRequire.resolve(modulePath)];
    } catch {
      // fresh process — nothing cached yet
    }
  }
  const { createLocalApiHandler, resolveQueuePath } = esmRequire("../src/lib/local-api");
  const handleRepoLocalApi = createLocalApiHandler({ queuePath: resolveQueuePath() });

  return {
    name: "tokentracker-local-data-api",
    configureServer(server) {
      // 添加中间件到最前面，拦截所有请求
      server.middlewares.use((req, res, next) => {
        if (typeof req.url !== "string") {
          next();
          return;
        }
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const isRepoPetApi = url.pathname === "/api/local-auth"
          || url.pathname === "/functions/tokentracker-pets"
          // The subscription store schema/shape evolves with this checkout
          // (cycle field, corrupt-store backups); a stale packaged app on
          // :7680 would 404 the Limits-page subscription UI in dev mode.
          || url.pathname === "/functions/tokentracker-subscription-manager"
          || url.pathname === "/api/pets/import"
          || url.pathname.startsWith("/api/pets/local/")
          || url.pathname.startsWith("/api/pets/codex/");
        // Project usage also runs against the current checkout (not :7680):
        // the endpoints evolve with the dashboard UI, and a stale packaged
        // app on :7680 would 404 the drill-down modal.
        const isRepoProjectUsageApi =
          url.pathname === "/functions/tokentracker-project-usage-summary"
          || url.pathname === "/functions/tokentracker-project-usage-detail"
          // Achievements ship with this checkout too — a stale packaged app
          // on :7680 would 404 the local badges.
          || url.pathname === "/functions/tokentracker-achievements";
        // Session efficiency, context health, and automatic Git outcomes are
        // implemented together in this checkout. Keep them on the same code
        // version as the dashboard; an older app listening on :7680 does not
        // know these routes and would otherwise make their cards disappear.
        const isRepoSessionAnalyticsApi =
          url.pathname === "/functions/tokentracker-session-insights"
          || url.pathname === "/functions/tokentracker-context-health"
          || url.pathname === "/functions/tokentracker-outcomes"
          // The metadata-only session browser lives in this checkout's
          // local-api.js (it needs the raw session id + local project path to
          // build resume commands). Keep it off :7680 so a stale packaged app
          // there does not 404 the Sessions page.
          || url.pathname === "/functions/tokentracker-sessions";
        // Skills inventory evolves with both the dashboard and skills-manager.
        // Serve the checkout implementation so a stale packaged desktop app (or
        // Windows DoSvc occupying :7680) cannot hide newly supported tool roots.
        const isRepoSkillsApi = url.pathname === "/functions/tokentracker-skills";
        if (isRepoPetApi || isRepoProjectUsageApi || isRepoSessionAnalyticsApi || isRepoSkillsApi) {
          Promise.resolve(handleRepoLocalApi(req, res, url))
            .then((handled) => { if (!handled) next(); })
            .catch(next);
          return;
        }
        if (req.url.startsWith("/functions/")) {
          Promise.resolve(handleLocalApi(req, res, url))
            .then((handled) => {
              if (handled) return;
              // Mock 没识别的 endpoint → 转发到仓库 CLI（7680）
              return proxyToLocalCli(req, res);
            })
            .catch(next);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT_DIR, "VITE_");
  const fallbackVersion = loadAppVersion();
  const define = {};

  if (!env.VITE_APP_VERSION && fallbackVersion) {
    define["import.meta.env.VITE_APP_VERSION"] = JSON.stringify(fallbackVersion);
  }

  // Build inputs. The Windows tray app's floating-pet page (pet.html) is an
  // OPT-IN extra entry, enabled only when TOKENTRACKER_BUILD_PET=1 (set by the
  // Windows build). Adding a rollup entry reshuffles shared chunks, so keeping it
  // off by default makes the macOS + web builds byte-identical to a no-pet build —
  // this matters because this project has a history of chunk-split changes subtly
  // breaking the native OAuth callback (see CLAUDE.md). macOS never loads pet.html.
  const rollupInput = {
    main: path.resolve(ROOT_DIR, "index.html"),
    share: path.resolve(ROOT_DIR, "share.html"),
  };
  if (process.env.TOKENTRACKER_BUILD_PET === "1") {
    rollupInput.pet = path.resolve(ROOT_DIR, "pet.html");
  }

  return {
    plugins: [react(), richLinkMetaPlugin(), routeSeoPagesPlugin(), localDataApiPlugin()],
    ...(Object.keys(define).length ? { define } : {}),
    build: {
      rollupOptions: {
        input: rollupInput,
      },
    },
    server: {
      port: 5173,
      // Prefer 5173 for local CLI integration, but don't fail if already in use.
      strictPort: false,
      // 确保 API 请求不被 SPA fallback 处理
      historyApiFallback: {
        rewrites: [
          { from: /^\/functions\/.*$/, to: (ctx) => ctx.parsedUrl.pathname }
        ]
      },
      // 代理 InsForge auth/functions 请求到云端，避免跨域 cookie 问题
      proxy: (() => {
        const proxies = {
          // IP-check page proxies ip.net.coffee API + assets. Without this,
          // 5173 dev mode shows "无数据" because trust score / geoip endpoints
          // are not part of the Vite mock — they live on ip.net.coffee.
          "/proxy/ipcheck": {
            target: "https://ip.net.coffee",
            changeOrigin: true,
            secure: true,
            rewrite: (p) => p.replace(/^\/proxy\/ipcheck/, ""),
          },
        };
        const insforge = loadEnv("development", ROOT_DIR, "VITE_").VITE_INSFORGE_BASE_URL;
        if (insforge) {
          proxies["/api/auth"] = {
            target: insforge,
            changeOrigin: true,
            secure: true,
            cookieDomainRewrite: "localhost",
          };
        }
        return proxies;
      })(),
    },
  };
});
