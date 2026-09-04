 <div align="center">

# Token Tracker

**English** · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · [Deutsch](./README.de.md)

### Track every AI token — then bring your usage to life

An accurate, local-first token usage and cost dashboard for **37 AI coding tools** — plus a desktop pet, **4 native widgets**, and **15 achievement tracks**. No cloud account, no API keys, no setup.

[![npm version](https://img.shields.io/npm/v/tokentracker-cli.svg?color=blue)](https://www.npmjs.com/package/tokentracker-cli)
[![npm downloads](https://img.shields.io/npm/dm/tokentracker-cli.svg?color=brightgreen)](https://www.npmjs.com/package/tokentracker-cli)
[![Homebrew](https://img.shields.io/github/v/release/xiufengsun/TokenTracker?label=brew&color=F8B73E&logo=homebrew&logoColor=white)](https://github.com/xiufengsun/homebrew-tokentracker)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![CLI](https://img.shields.io/badge/CLI-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey.svg)](https://www.npmjs.com/package/tokentracker-cli)
[![macOS app](https://img.shields.io/badge/macOS%20app-menu%20bar%20%2B%20widgets-lightgrey.svg?logo=apple&logoColor=white)](https://github.com/xiufengsun/TokenTracker/releases/latest)
[![Windows app](https://img.shields.io/badge/Windows%20app-system%20tray-lightgrey.svg?logo=windows&logoColor=white)](https://github.com/xiufengsun/TokenTracker/releases/latest)
[![GitHub stars](https://img.shields.io/github/stars/xiufengsun/TokenTracker?style=social)](https://github.com/xiufengsun/TokenTracker/stargazers)
[![Featured in 阮一峰周刊 #393](https://img.shields.io/badge/Featured%20in-%E9%98%AE%E4%B8%80%E5%B3%B0%E5%91%A8%E5%88%8A%20%23393-FF6B35?logo=rss&logoColor=white)](https://github.com/ruanyf/weekly/blob/master/docs/issue-393.md)
[![Author tokens](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=0652839f-d19f-4f67-af85-6b7675875443&metric=tokens&compact=1&label=author%20tokens)](https://github.com/xiufengsun/TokenTracker)

<br/>

<strong>📊 See the token dashboard in action</strong>

<br/><br/>

<video src="https://github.com/user-attachments/assets/3275979d-bbed-4639-83e2-8b7d83bed6af" controls muted playsinline poster="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-light.png" width="820"></video>

<br/><br/>

<table>
<tr>
<td width="58%"><img src="docs/screenshots/pet.png" alt="TokenTracker desktop pet powered by real AI coding activity" /></td>
<td width="42%"><img src="docs/screenshots/widgets-overview.png" alt="TokenTracker desktop widgets for usage, heatmap, models, and limits" /></td>
</tr>
<tr>
<td><strong>🐾 A living desktop companion</strong><br/>Codes, celebrates streaks, follows your cursor, and rests when you do.</td>
<td><strong>🧩 Four native widgets</strong><br/>Usage, activity heatmap, top models, and rate limits at a glance.</td>
</tr>
</table>

<p>
  <img src="dashboard/public/achievements/token-titan.png" alt="Token Titan achievement" width="64" />
  <img src="dashboard/public/achievements/streak.png" alt="Streak achievement" width="64" />
  <img src="dashboard/public/achievements/multitool.png" alt="Multitool achievement" width="64" />
  <img src="dashboard/public/achievements/night-owl.png" alt="Night Owl achievement" width="64" />
  <img src="dashboard/public/achievements/project-devotion.png" alt="Project Devotion achievement" width="64" />
</p>

<strong>🏆 Unlock achievements from the way you actually code.</strong>

<br/><br/>

<strong>🎬 Meet TokenTracker</strong>

<br/><br/>

<video src="https://github.com/user-attachments/assets/5e709422-5af8-4e4c-8109-f5bb711eb3f8" controls muted playsinline poster="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-dark.png" width="820">
  <img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-dark.png" alt="Token Tracker Dashboard" width="820" />
</video>

<br/><br/>

⭐ **If TokenTracker saves you time, please [star it on GitHub](https://github.com/xiufengsun/TokenTracker) — it helps other developers find it.**

<br/>

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/M4M11XSNWD)

</div>

---

## ⚡ Quick Start

> **Requirements**: Node.js **20+** (CLI runs on macOS / Linux / Windows; native desktop app ships for macOS (menu bar), Windows (system tray) and Linux (AppImage, tray). Cursor token reading uses the system `sqlite3` CLI when available and falls back to `node:sqlite` on supported Node releases).

```bash
npx tokentracker-cli
```

That's it. First run installs hooks, syncs your data, and opens the dashboard at `http://localhost:7680`.

**What you get in 30 seconds:**
- 📊 A local dashboard at `localhost:7680` with usage trends, model breakdown, cost analysis
- 🔌 Auto-detected hooks for every supported AI tool you have installed
- 🏠 100% local — no account, no API keys, no network calls (except optional leaderboard)
- 🧩 *Optional:* a Skills tab that browses 250+ public skills and syncs them across Claude · Codex · AStudio · Grok · Antigravity · Gemini · OpenCode · Hermes

> **Want a native desktop app?**
> - **macOS** — [Download `TokenTrackerBar.dmg`](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTrackerBar.dmg) → drag to Applications. Menu bar status icon, desktop widgets, and the dashboard in a WKWebView.
> - **Windows** — [Download `TokenTracker-Setup.exe`](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTracker-Setup.exe) → run the per-user installer (no admin needed). System-tray app with the dashboard in WebView2. Portable zip also on the [releases page](https://github.com/xiufengsun/TokenTracker/releases/latest).
> - **Linux** — [Download `TokenTracker-linux-x86_64.AppImage`](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTracker-linux-x86_64.AppImage) → `chmod +x` and run. Tray app with the dashboard in a WebKitGTK window. It carries its own GTK/WebKit, so it needs nothing from your distro beyond a current glibc; on GNOME the tray icon still needs the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/). `.deb` and `.rpm` packages are also on the [releases page](https://github.com/xiufengsun/TokenTracker/releases/latest) — those link the distro's `webkit2gtk-4.1`, `gtk3` and appindicator instead, so the `.deb` will not install on Debian 12 (use the AppImage there).

Install globally for shorter commands:

```bash
npm i -g tokentracker-cli

tokentracker              # Open the dashboard
tokentracker sync         # Manual sync
tokentracker status       # Check hook status
tokentracker status --json     # Machine-readable summary (pipe to jq, ingest from AI agents)
tokentracker status --light    # Plain ASCII table (CI / SSH, no spinner)
tokentracker doctor       # Health check
```

### 🍺 Homebrew (macOS)

Prefer `brew`? Install directly — no extra tap step needed:

```bash
# macOS menu bar app (DMG)
brew install --cask xiufengsun/tokentracker/tokentracker

# CLI only
brew install xiufengsun/tokentracker/tokentracker
```

Upgrade with `brew upgrade --cask xiufengsun/tokentracker/tokentracker`. The tap auto-bumps within an hour of every new release.

### 🐧 Linux (AppImage, `.deb`, `.rpm`)

Every release ships all three. One self-contained file, no package manager:

```bash
chmod +x TokenTracker-linux-x86_64.AppImage
./TokenTracker-linux-x86_64.AppImage
```

Or install through your package manager:

```bash
sudo apt install ./TokenTracker-linux-x86_64.deb    # Debian / Ubuntu
sudo dnf install ./TokenTracker-linux-x86_64.rpm    # Fedora / RHEL
```

> **Debian 12:** the `.deb` depends on `libappindicator3-1`, which bookworm dropped in favour of `libayatana-appindicator3-1`, so `apt` refuses it. Use the AppImage.

All three bundle their own Node runtime and the dashboard. The AppImage additionally carries GTK3, WebKitGTK and appindicator, which is why it is ~120MB and installs nowhere; the `.deb` and `.rpm` link the distro's `webkit2gtk-4.1`, `gtk3` and appindicator instead, at ~55MB. Tested on Arch + KDE Plasma; on GNOME the tray icon requires the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/), and clicking the tray icon opens the menu rather than the window (a libayatana-appindicator limitation).

An Arch `PKGBUILD` for a local pacman install lives in `TokenTrackerLinux/packaging/arch/tokentracker-linux` — see [`TokenTrackerLinux/README.md`](TokenTrackerLinux/README.md). It is not published to the AUR.

---


## ✨ Features

- 🔌 **37 AI tools out of the box** — Claude Code, Codex CLI, AStudio, Cursor, Gemini CLI, Antigravity, Kiro, OpenCode, OpenClaw, Every Code, Hermes Agent, GitHub Copilot, Kimi Code, CodeBuddy, WorkBuddy, Grok Build, oh-my-pi, pi, Dots, Prime Agent, Craft Agents, Reasonix, Kilo CLI, Kilo Code, Roo Code, Zed Agent, Goose, Droid, Mimo Code, ZCode, Qoder, AnythingLLM Desktop, Claude Science, DeepSeek Harness, TRAE Work CN, LM Studio, Unsloth Studio
- 🏠 **100% local** — Token data never leaves your machine. No account, no API keys.
- 🚀 **Zero config** — Hooks auto-install on first run. From zero to dashboard in 30 seconds.
- 📊 **Beautiful dashboard** — Usage trends, cost breakdowns by model, GitHub-style activity heatmap, project attribution
- 🖥️ **Native desktop app** — macOS menu bar (+ widgets) and Windows system tray, each with an embedded server and the dashboard in a native webview
- 🐾 **Desktop pet** — A pixel companion powered by real coding activity: it works when you work, celebrates streaks, and sleeps when you rest
- 🎨 **4 desktop widgets** — Pin Usage / Activity Heatmap / Top Models / Usage Limits to your desktop
- 🏆 **15 achievement tracks** — Turn daily usage, streaks, tools, models, and milestones into collectible badges worth sharing
- 📈 **Real-time usage limits** — Claude / Codex / Cursor / Gemini / Kimi / Kiro / Grok / Copilot / Antigravity / ZCode / OpenCode Go / Qoder / Qoder CN quota windows, with last-good caching when a local provider app is temporarily closed
- 🟢 **Service Status page** — live operational and incident status from 8 official provider status pages
- 💰 **Cost engine** — 2,200+ models priced via [LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) (auto-refreshed daily) + curated overrides for niche tools (Kiro, Cursor Composer, Kimi, CodeBuddy hy3); 24h disk cache + bundled offline snapshot mean accurate USD without an internet connection. Models without published vendor pricing (e.g. Tencent hy3-preview) are tracked by tokens but show $0 cost until the vendor publishes a rate.
- 🌐 **Optional leaderboard** — Compare with developers worldwide; drag-to-reorder columns to focus on the providers you care about (opt-in, sign in to participate)
- 🔄 **Cross-device account view** — Opt in to cloud sync and the dashboard merges your usage across every machine you work on (laptop + desktop + server) into one combined view — totals, trends, heatmap and model breakdown all device-aggregated (opt-in, sign in; the default local-only experience stays instant and offline)
- 🧩 **Optional Skills tab** — browse 250+ public skills from `anthropics/skills`, `ComposioHQ/awesome-claude-skills`, `skills.sh` and any GitHub repo you add; sync them across Claude / Codex / AStudio / Grok / Antigravity / Gemini / OpenCode / Hermes with named targets and one-click Undo
- 🔒 **Privacy-first** — Only token counts and timestamps. Never prompts, responses, or file contents.

---

## 🖼️ Showcase

<table>
<tr>
<td width="50%">

**Dashboard** — usage trends, model breakdown, cost analysis

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-light.png" alt="Dashboard" />

</td>
<td width="50%">

**Desktop Widgets** — pin usage to your desktop

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/widgets-overview.png" alt="Desktop Widgets" />

</td>
</tr>
<tr>
<td width="50%">

**Menu Bar App** — animated Clawd companion + native panels

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/menubar.gif" alt="Menu Bar App" />

</td>
<td width="50%">

**Global Leaderboard** — compare with developers worldwide

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/leaderboard.png" alt="Leaderboard" />

</td>
</tr>
<tr>
<td colspan="2">

**Skills Manager** — browse 250+ public skills from GitHub & `skills.sh`, install once, sync to Claude / Codex / AStudio / Grok / Antigravity / Gemini / OpenCode / Hermes. Per-target toggles, one-click Undo, no manual file copying.

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/skills.png" alt="Skills Manager" />

</td>
</tr>
<tr>
<td colspan="2">

**Desktop Pet** — a pixel companion that floats on your desktop and reacts to your real token burn: it codes when you code, celebrates streaks, and sleeps when you rest. Import community pets from [codex-pets.net](https://codex-pets.net) with a link or a `.codex-pet.zip` — V2 pets even turn their head to follow your cursor in 16 directions. macOS, Windows, and web.

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/pet.png" alt="Desktop Pet" />

</td>
</tr>
<tr>
<td colspan="2">

**Achievements** — 15 tracks turn usage milestones, streaks, tools, and models into collectible badges — with progress visible before each unlock.

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/achievements.png" alt="TokenTracker Achievements" />

</td>
</tr>
</table>

---

## 🔌 Supported AI Tools

| Tool | Detection | Method |
|---|---|---|
| **Claude Code** | ✅ Auto | SessionEnd hook in `settings.json` |
| **Codex CLI** | ✅ Auto | TOML notify hook in `config.toml` |
| **AStudio** | ✅ Auto | TOML notify hook in `config.toml` |
| **Cursor** | ✅ Auto | API + SQLite auth token |
| **Kiro** | ✅ Auto | SQLite + JSONL hybrid |
| **Gemini CLI** | ✅ Auto | SessionEnd hook |
| **OpenCode** | ✅ Auto | Plugin system + SQLite |
| **OpenClaw** | ✅ Auto | Session plugin |
| **Every Code** | ✅ Auto | TOML notify hook |
| **Hermes Agent** | ✅ Auto | SQLite sessions table (`~/.hermes/state.db`) |
| **GitHub Copilot App / CLI** | ✅ Auto | Unified per-request SQLite usage (`~/.copilot/session-store.db`); App DB legacy baseline |
| **GitHub Copilot Chat extension / legacy CLI** | ✅ Auto | OpenTelemetry file exporter (`COPILOT_OTEL_FILE_EXPORTER_PATH`) |
| **Kimi Code** | ✅ Auto | Passive `wire.jsonl` reader (`~/.kimi/sessions/**/wire.jsonl`) |
| **oh-my-pi (Pi Coding Agent)** | ✅ Auto | Passive reader (`~/.omp/agent/sessions/**/*.jsonl`) + managed notify extension written by `tokentracker init` to `~/.omp/agent/extensions/tokentracker-notify.ts` for near-real-time sync (skipped if a same-named unmanaged file already exists; removed by `tokentracker uninstall` when still managed) |
| **CodeBuddy** (Tencent) | ✅ Auto | SessionEnd hook in `~/.codebuddy/settings.json` (Claude-Code fork) |
| **WorkBuddy** (Tencent) | ✅ Auto | SessionEnd hook in `~/.workbuddy/settings.json` (Claude-Code fork) + passive `projects/**/*.jsonl` scan |
| **Grok Build** (xAI) | ✅ Auto | SessionEnd hook + passive `updates.jsonl` / `signals.json` scan (`~/.grok/sessions/**/`) |
| **Kilo CLI** (kilo.ai) | ✅ Auto | Passive SQLite reader (`~/.local/share/kilo/kilo.db`, OpenCode-fork schema) |
| **Kilo Code** (VS Code extension) | ✅ Auto | Passive `ui_messages.json` reader (Cursor/Code/CodeBuddy/Windsurf globalStorage) |
| **Antigravity** | ✅ Auto | Passive transcript reader (`~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/brain/**/transcript.jsonl`) |
| **pi** (`@mariozechner/pi-coding-agent`) | ✅ Auto | Passive reader (`~/.pi/agent/sessions/**/*.jsonl`) |
| **Dots** | ✅ Auto | Routed through pi's provider split (`pi-dots` source, same passive reader) — no separate hook |
| **Prime Agent** | ✅ Auto | Metadata-only passive usage reader (`~/.prime/agent/sessions/*.jsonl`; reads usage/model/provider/timestamp, never prompts or responses) |
| **Craft Agents** | ✅ Auto | Passive session reader (`~/.craft-agent` + workspace session logs) |
| **Reasonix** | ✅ Auto | Passive telemetry reader (`~/.reasonix/**/*.jsonl.telemetry.json`) |
| **Roo Code** (VS Code extension) | ✅ Auto | Passive `ui_messages.json` reader (`rooveterinaryinc.roo-cline`) |
| **Zed Agent** | ✅ Auto | Passive SQLite reader (`threads.db`, all providers — hosted `zed.dev` + bring-your-own) |
| **Goose** (Block) | ✅ Auto | Passive SQLite reader (`sessions.db`, cumulative deltas) |
| **Droid** (Factory) | ✅ Auto | Passive session reader (`~/.factory/sessions/**/settings.json`, cumulative deltas) |
| **Mimo Code** (mimocode) | ✅ Auto | Passive SQLite reader (`~/.local/share/mimocode/mimocode.db`, OpenCode-fork schema; counts only mimo-native turns — mirrored Claude/claude-mem history is excluded) |
| **ZCode** (Z.ai) | ✅ Auto | Passive SQLite reader (`~/.zcode/cli/db/db.sqlite`, OpenCode-fork schema; counts only Z.ai/BigModel GLM turns — bundled Claude/Codex/Gemini sub-agents are excluded) |
| **Qoder** | ✅ Auto | Passive SQLite reader (`Qoder/SharedClientCache/cache/db/local.db`; reads assistant `token_info`, separates cached input, and never reads prompt or response text), plus Plan Credits and Ultimate Free Calls limits from Qoder's local session. Qoder CN (国内版, `QoderCN/SharedClientCache/cache/db/local.db`) is tracked as its own source with quota from `qoder.com.cn`. |
| **LM Studio** | ✅ Auto | Passive recursive reader for `~/.lmstudio/server-logs/**/*.log`; reads only final-response IDs, models, timestamps, and scalar `usage` counters from Chat Completions and Responses API records. Mirrored response IDs are deduplicated; prompt and response bodies are never retained. These developer-server records cover local inference and LM Link at zero marginal API cost, not Bionic Secure Cloud billing. |
| **Unsloth Studio** | ✅ Auto | Passive SQLite reader for `$UNSLOTH_STUDIO_HOME/studio.db` (default `~/.unsloth/studio/studio.db`). Reads scalar `contextUsage` metadata and content-free `api_usage_events` only; prompts, replies, attachments, API subjects, credentials, and training metrics are excluded. Local routes stay zero-cost, while known paid provider routes use the model that actually answered for estimated token cost. |
| **AnythingLLM Desktop** | ✅ Auto | Passive SQLite reader (`anythingllm-desktop/storage/anythingllm.db`; reads per-message token metrics only, never prompts or responses) |
| **Claude Science** | ✅ Auto | Passive SQLite reader (`~/.claude-science/operon-cli.db`; reads the `frames` table's token counters only, never prompts, artifacts or research content). No native Windows build — on Windows the app runs inside WSL and is read from there. |
| **DeepSeek Harness** | ✅ Auto | Passive session reader (`~/.dsh/sessions/**/session.jsonl[.zstd]`; parses session header and assistant events, handles multi-frame zstd decompression) |
| **TRAE Work CN** | ✅ Auto | **Requires an explicit opt-in: set `TOKENTRACKER_TRAE_CN_USAGE=1`.** Reading usage transmits the locally stored sign-in authorization to TRAE's internal API, so nothing is sent until you turn it on. Once opted in: during eligible non-background sync when local TRAE Work CN auth exists, reads session-token usage from the locally signed-in macOS / Windows app; its internal API may change |

> **Do I need to install any plugin or hook manually?** No. `tokentracker` (or `tokentracker init`) handles everything on first run:
> - **Hook-based** tools (Claude Code, Codex, AStudio, Gemini, Every Code, **CodeBuddy**, **WorkBuddy**, **Grok Build**) — we write a SessionEnd hook or TOML notify entry into the tool's own config.
> - **Plugin-based** tools (OpenCode, **OpenClaw**) — plugins ship inside the npm package. OpenClaw's session plugin lives at `~/.tokentracker/tracker/openclaw-plugin/openclaw-session-sync/`; we link and enable it via OpenClaw's own CLI, then set `hooks.allowConversationAccess=true` so OpenClaw permits the session-finished event that triggers sync. No download, no drag-and-drop.
> - **oh-my-pi** — passive session scan is always the billing/token source of truth (`~/.omp/agent/sessions/**/*.jsonl`). When OMP is detected, `tokentracker init` also writes a managed notify extension to `~/.omp/agent/extensions/tokentracker-notify.ts` so turns can trigger near-real-time sync. That file is owned only when it carries TokenTracker's managed marker: a same-named user-authored extension is never overwritten or deleted. `tokentracker uninstall` removes the extension only while it is still managed.
> - **Passive readers** (Cursor, Kiro, Hermes, Kimi Code, Copilot, **Grok Build**, **pi**, **Craft Agents**, **Reasonix**, **Kilo CLI**, **Kilo Code**, **Roo Code**, **Antigravity**, **Zed Agent**, **Goose**, **Droid**, **Mimo Code**, **ZCode**, **Qoder**, **LM Studio**, **Unsloth Studio**, **AnythingLLM Desktop**, **Claude Science**, **DeepSeek Harness**) — nothing is installed into those tools. We only read files they already produce (SQLite DB, JSONL, OTEL export, session logs). Copilot App / CLI usage is read per request from `~/.copilot/session-store.db`; `data.db` provides the one-time legacy adoption baseline and stays observe-only after the store becomes canonical, while the Chat extension and legacy CLI continue using OTEL. TokenTracker coordinates the sources so overlapping requests are counted once. Mixed App/CLI usage that predates adoption is retained as a `github-copilot-legacy` aggregate rather than assigned to a guessed request model.
> - **Grok Build estimate** — current local telemetry exposes cumulative `updates.jsonl` `totalTokens`, but not a stable prompt/output/cache split; `signals.json` remains a fallback with `contextTokensUsed` snapshots. TokenTracker estimates Grok cost until per-call usage details are available.
>
> Run `tokentracker status` anytime to verify every integration's state. If something shows `skipped`, the `detail` column explains why (e.g. tool CLI not on `PATH`, config unreadable).
>
> Deeper dives: [OpenClaw integration & troubleshooting](docs/openclaw-integration.md).

Missing your tool? [Open an issue](https://github.com/xiufengsun/TokenTracker/issues/new) — adding new providers is usually one parser file away.

---

## 🆚 Why TokenTracker? <a id="ccusage-alternative"></a>

> **Looking for a ccusage alternative with a GUI?** TokenTracker covers 37 tools (not just Claude Code), adds native macOS and Windows apps + desktop widgets, and de-duplicates token records correctly across providers — so your numbers match the providers' own billing.

|                          | **TokenTracker** | ccusage     | Cursor stats |
|--------------------------|:---:|:---:|:---:|
| **AI tools supported**   | **37**           | 1 (Claude)  | 1 (Cursor)   |
| **Local-first, no account** | ✅            | ✅           | ❌            |
| **Native desktop app**   | ✅ macOS + Windows | ❌           | ❌            |
| **Desktop widgets**      | ✅ 4 widgets      | ❌           | ❌            |
| **Rate-limit tracking**  | ✅ 13 providers   | ❌           | Cursor only  |
| **Accurate multi-provider dedup** | ✅      | ❌ ¹         | —            |

<sub>¹ `reqId`-based deduplication over-counts providers that omit a request ID (DeepSeek / Kimi / MiniMax / Claude sub-agents) by 1.6–3.7×. TokenTracker dedups on a composite key, so totals match each provider's own billing dashboard.</sub>

---

## 🏗️ How It Works

```mermaid
flowchart LR
    A["AI coding tools<br/>Claude Code · Codex · AStudio · Cursor · Gemini · Kiro<br/>OpenCode · OpenClaw · Every Code · Hermes · Copilot<br/>Kimi Code · CodeBuddy · WorkBuddy · Grok Build · Kilo CLI · Kilo Code<br/>Antigravity · oh-my-pi · pi · Dots · Craft · Roo · Zed · Goose · Droid · Mimo · ZCode · Qoder · AnythingLLM · Claude Science · DeepSeek Harness · TRAE Work CN · LM Studio · Unsloth Studio"]
    A -->|hooks trigger| B[Token Tracker]
    B -->|parse logs<br/>30-min UTC buckets| C[(Local SQLite)]
    C --> D[Web Dashboard]
    C --> E[Menu Bar App]
    C --> F[Desktop Widgets]
    C -.->|opt-in| G[(Cloud Leaderboard)]
```

1. AI CLI tools generate logs during normal use
2. Lightweight hooks detect changes and trigger sync (Cursor uses API instead of hooks)
3. Token counts parsed locally — never any prompt or response content
4. Aggregated into 30-minute UTC buckets
5. Dashboard, menu bar app, and widgets all read from the same local snapshot

---

## 🛡️ Privacy

> 📄 **[Full Privacy Policy](docs/PRIVACY.md)** — every network request the app can make, what each one sends, and how to switch it off.

| Protection | Description |
|---|---|
| **No content upload** | Only token counts and timestamps. Never prompts, responses, or file contents. |
| **Local-only by default** | All data stays on your machine. The leaderboard is fully opt-in. |
| **Auditable** | Open source. Read [`src/lib/rollout.js`](src/lib/rollout.js) — only numbers and timestamps. |
| **Anonymous usage stats only** | Two things phone home, both anonymous: (1) at most one daily heartbeat — a one-way hash of the machine id, plus the app version, OS platform, and app shell (cli/macos/windows/linux) as separate plain fields; (2) anonymous dashboard pageview/feature events (PostHog — autocapture and session recording disabled, browser Do-Not-Track respected). Never token counts, model names, prompts, or paths. Audit [`src/lib/telemetry.js`](src/lib/telemetry.js) and [`dashboard/src/lib/analytics.js`](dashboard/src/lib/analytics.js); one switch disables both on your machine: `TOKENTRACKER_NO_TELEMETRY=1` (or `DO_NOT_TRACK=1`). |

---

## 📦 Configuration

Most users never need this — defaults are sensible. For advanced setups:

| Variable | Description | Default |
|---|---|---|
| `TOKENTRACKER_DEBUG` | Enable debug output (`1` to enable) | — |
| `TOKENTRACKER_NO_TELEMETRY` | Disable all anonymous telemetry — daily heartbeat and dashboard analytics (`1` to disable; the `DO_NOT_TRACK` standard is also respected) | — |
| `TOKENTRACKER_HTTP_TIMEOUT_MS` | HTTP timeout in milliseconds | `20000` |
| `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION` | Skip Git commit attribution (`1` to disable). Attribution runs `git log` inside the working directory of each recent session. Disabling keeps TokenTracker out of your project directories entirely — the Outcomes view then shows only manually recorded outcomes | — |
| `TOKENTRACKER_GIT_ATTRIBUTION_PROTECTED_DIRS` | Let Git attribution enter macOS TCC-protected locations (`1` to allow). By default sessions under `~/Documents`, `~/Downloads`, `~/Desktop`, `~/Library`, the media folders and `/Volumes` are skipped, because macOS raises a separate folder-access prompt for each one. Enable this only if you keep repositories there and don't mind granting access | — |
| `TOKENTRACKER_WSL_MODE` | WSL install resolution behavior on Windows (for aggregating native and WSL installations). `wsl-first` (prefer WSL), `native-first`, `wsl-only`, `native-only`, `both` (aggregate both installs) | `wsl-first` |
| `CODEX_HOME` | Override Codex CLI directory | `~/.codex` |
| `TOKENTRACKER_ACODE_HOME` | Override AStudio directory | `~/.acode` |
| `GEMINI_HOME` | Override Gemini CLI directory | `~/.gemini` |
| `TOKENTRACKER_GROK_HOME` | Override Grok Build directory for the Grok integration and Skills Manager | `~/.grok` |
| `GROK_HOME` | Legacy Grok Build directory override, used when `TOKENTRACKER_GROK_HOME` is unset | `~/.grok` |
| `TOKENTRACKER_ANTIGRAVITY_HOME` | Force a single Antigravity Skills directory (auto-detects `~/.gemini/antigravity` + `~/.gemini/antigravity-ide` otherwise) | auto |
| `TOKENTRACKER_LMSTUDIO_HOME` | Override the LM Studio data directory used by the passive server-log reader | `~/.lmstudio` |
| `TOKENTRACKER_UNSLOTH_DB` | Override the Unsloth Studio database file used by the passive usage reader | `$UNSLOTH_STUDIO_HOME/studio.db` |

### 🐧 Windows Subsystem for Linux (WSL) Auto-Discovery

If you run AI coding agents inside WSL on Windows, TokenTracker can auto-discover and aggregate metrics from both native Windows and WSL installations.

Configure this behavior using the `TOKENTRACKER_WSL_MODE` environment variable:
* `both` (Recommended): Scans and aggregates metrics from both native Windows and WSL.
* `wsl-first` (Default): Checks WSL first; if found, uses WSL metrics, otherwise falls back to Windows.
* `native-first`: Checks native Windows first; if found, uses Windows metrics, otherwise falls back to WSL.
* `wsl-only`: Scans WSL environment only.
* `native-only`: Scans native Windows environment only.

> [!NOTE]
> **Preference (`-first`) vs. Isolation (`-only`):** Preference modes prioritize your choice but gracefully fall back to scanning the other environment if the tool is missing. Isolation modes strictly lock scanning to that single environment and ignore the other completely.

Supported providers for WSL auto-discovery and aggregation:
* **Dual-Install Aggregation (`both` mode):**
  * **File-list & Active CLIs:** Every Code, Kimi (legacy & Code), Gemini CLI, Antigravity, OpenCode (JSON), Codex CLI, AStudio, CodeBuddy, WorkBuddy, oh-my-pi (omp), pi, GitHub Copilot (OTEL), Roo Code, Craft, Kilo Code, Droid.
  * **SQLite-based DBs:** Hermes, Zed Agent, Goose, OpenCode (`opencode.db`), Kilo CLI, Mimo Code, ZCode, Qoder, Claude Science (`operon-cli.db`), GitHub Copilot (App DB).
* **WSL Auto-Discovery (Preference/Isolation only, no dual aggregation):**
  * Grok Build (dynamically selects either native or WSL depending on the mode, but does not aggregate both in `both` mode).

---

## 🛠️ Development

```bash
git clone https://github.com/xiufengsun/TokenTracker.git
cd TokenTracker
npm install

# Build dashboard + run CLI
cd dashboard && npm install && npm run build && cd ..
node bin/tracker.js

# Tests
npm test
```

### Building the macOS App

```bash
cd TokenTrackerBar
npm run dashboard:build              # Build the dashboard bundle
./scripts/bundle-node.sh             # Bundle Node.js + tokentracker source
xcodegen generate                    # Generate the Xcode project
ruby scripts/patch-pbxproj-icon.rb   # Patch in the Icon Composer asset
xcodebuild -scheme TokenTrackerBar -configuration Release clean build
./scripts/create-dmg.sh              # Package the .app into a DMG
```

Requires **Xcode 16+** and [XcodeGen](https://github.com/yonaskolb/XcodeGen).

---

## 🔧 Troubleshooting

### CLI

<details>
<summary><b>"engines.node" or unsupported version error</b></summary>

<br/>

TokenTracker requires **Node 20+**. Check your version:

```bash
node --version
```

If lower, upgrade via [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm), or your package manager (`brew upgrade node`, `apt install nodejs`).

</details>

<details>
<summary><b>Port 7680 already in use</b></summary>

<br/>

The dashboard server picks the next free port automatically (`7681`, `7682`, ...) when `7680` is taken. The actual port is logged on startup. If you want to force a specific port:

```bash
PORT=7700 tokentracker serve
```

To find what's holding `7680`:

```bash
lsof -i :7680
```

**WSL2 note**: on Windows hosts the Delivery Optimization service (`DoSvc`) listens on `7680`, and under NAT networking the conflict is invisible from inside WSL — the server starts fine but the Windows browser reaches `DoSvc` instead. TokenTracker therefore defaults to `7681` when running under WSL (logged on startup).

</details>

<details>
<summary><b>A provider isn't being detected</b></summary>

<br/>

Check the integration status:

```bash
tokentracker status
```

Then run the doctor for a deeper health check:

```bash
tokentracker doctor
```

If a provider shows as not configured even though you use it, try `tokentracker activate-if-needed` to re-run hook detection. If still missing, [open an issue](https://github.com/xiufengsun/TokenTracker/issues/new) with the `doctor` output attached.

</details>

<details>
<summary><b>How to uninstall hooks and remove all config</b></summary>

<br/>

```bash
tokentracker uninstall
```

This removes every hook TokenTracker installed across all detected AI tools, plus the local config and data. Safe to re-run.

</details>

### macOS App

<details>
<summary><b>"TokenTrackerBar can't be opened" — unidentified developer</b></summary>

<br/>

TokenTrackerBar is **ad-hoc signed** (not notarized with an Apple Developer ID — that requires a paid developer account). Gatekeeper blocks it on first launch.

1. Open **System Settings → Privacy & Security**
2. Scroll to the **Security** section — you'll see *"TokenTrackerBar was blocked to protect your Mac."*
3. Click **Open Anyway**
4. Confirm with **Open** in the follow-up dialog (you'll need to authenticate)

You only need to do this once. Older macOS alternative: right-click the app in Finder → **Open** → **Open** in the confirmation dialog.

</details>

<details>
<summary><b>"TokenTrackerBar is damaged and can't be opened"</b></summary>

<br/>

This is Gatekeeper reacting to the `com.apple.quarantine` attribute macOS attaches to every downloaded file — not an actual problem. Clear it once with:

```bash
xattr -cr /Applications/TokenTracker.app
```

After that the app opens normally.

</details>

<details>
<summary><b>"TokenTrackerBar wants to access data from other apps"</b></summary>

<br/>

This is required for the **Cursor** and **Kiro** integrations. They store auth tokens / usage data inside their own `~/Library/Application Support/` folders, which macOS protects with the App Management permission.

- ✅ Click **Allow** if you use Cursor or Kiro
- ❌ Click **Don't Allow** if you don't — those providers will be silently skipped, everything else keeps working

Once granted, the permission is remembered. Note that ad-hoc signed builds re-prompt after each upgrade because each build has a new signing identity.

</details>

---

## 🪪 README Badges

Show off your token usage on your GitHub profile or project README.

To get `YOUR_USER_ID`:
1. Run `tokentracker`, open the dashboard, and sign in to the leaderboard.
2. Go to **Settings → Account**.
3. Use the **User ID** shown there. On headless machines, `tokentracker device-login` also writes the same `user_id` to `~/.tokentracker/tracker/config.json`.

Then drop one of these in:

```markdown
[![tokens](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=YOUR_USER_ID&metric=tokens)](https://github.com/xiufengsun/TokenTracker)
[![cost](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=YOUR_USER_ID&metric=cost)](https://github.com/xiufengsun/TokenTracker)
[![rank](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=YOUR_USER_ID&metric=rank)](https://github.com/xiufengsun/TokenTracker)
```

> The link target defaults to the TokenTracker repo so every click helps other developers discover the tool. Swap it for your leaderboard profile, personal site, or `https://www.tokentracker.cc` if you'd rather route clicks elsewhere.

Renders shields.io-compatible badges with your current totals (60s cache):

| Param | Values | Default |
|---|---|---|
| `metric` | `tokens` / `cost` / `rank` | `tokens` |
| `period` | `week` / `month` / `total` | `total` |
| `style` | `flat` / `flat-square` | `flat` |
| `label` | any short string | metric name |
| `color` | hex, e.g. `ff6b35` | brand green |

> **Privacy**: badges only resolve for profiles where leaderboard sharing is **on** (`Settings → Account → Public profile`). Private profiles get a "private" placeholder.

---

## ⭐ Star History

<a href="https://www.star-history.com/?repos=xiufengsun%2FTokenTracker&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xiufengsun/TokenTracker&type=date&theme=dark&legend=top-left&sealed_token=Vr7qbPNqOTtzQEdtkxS2yArAReX2QkBZKNJgs3n32Q5oJa1iXddLlrT201teNSnt7QnsXtDcHy_T387xvXJ_HXHrPtvH2QQ1xqQZ67N_HV45ulWrt3j6hziDW5eshRCmu8CAT_W31PY0-WVZpFv7NQD-acv1stVK8ndribTokIp9ukSYAedx3icuUrOu" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xiufengsun/TokenTracker&type=date&legend=top-left&sealed_token=Vr7qbPNqOTtzQEdtkxS2yArAReX2QkBZKNJgs3n32Q5oJa1iXddLlrT201teNSnt7QnsXtDcHy_T387xvXJ_HXHrPtvH2QQ1xqQZ67N_HV45ulWrt3j6hziDW5eshRCmu8CAT_W31PY0-WVZpFv7NQD-acv1stVK8ndribTokIp9ukSYAedx3icuUrOu" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xiufengsun/TokenTracker&type=date&legend=top-left&sealed_token=Vr7qbPNqOTtzQEdtkxS2yArAReX2QkBZKNJgs3n32Q5oJa1iXddLlrT201teNSnt7QnsXtDcHy_T387xvXJ_HXHrPtvH2QQ1xqQZ67N_HV45ulWrt3j6hziDW5eshRCmu8CAT_W31PY0-WVZpFv7NQD-acv1stVK8ndribTokIp9ukSYAedx3icuUrOu" />
  </picture>
</a>

---

## 🤝 Contributing & Support

- **Bugs / feature requests**: [open an issue](https://github.com/xiufengsun/TokenTracker/issues/new)
- **Security**: see [SECURITY.md](SECURITY.md) — please don't open public issues for security reports
- **Pull requests**: see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and how to add a new AI tool integration
- **Questions / showcase**: [GitHub Discussions](https://github.com/xiufengsun/TokenTracker/discussions)

## 🙏 Credits

The `bot` companion's morphing engine is [bloub](https://github.com/jeremy-prt/bloub) by Jérémy Perret (MIT).

The Clawd character design belongs to Anthropic. This is a community project with no official affiliation with Anthropic.

## 🔗 Friendly Links

- [LINUX DO](https://linux.do) — a developer community we like

## License

[MIT](LICENSE)

---

<div align="center">

**Token Tracker** — Quantify your AI output.

<a href="https://www.tokentracker.cc">tokentracker.cc</a>  ·  <a href="https://www.npmjs.com/package/tokentracker-cli">npm</a>  ·  <a href="https://github.com/xiufengsun/TokenTracker">GitHub</a>

</div>
