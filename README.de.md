<div align="center">

# Token Tracker

[English](./README.md) · [简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md) · **Deutsch**

### Sieh genau, was du für KI ausgibst – über jedes CLI hinweg

Sammle automatisch Token-Zahlen von **37 KI-Coding-Tools**, aggregiere sie lokal und sieh echte Kostentrends in einem schönen Dashboard. Kein Cloud-Konto, keine API-Keys, kein Setup – nur ein Befehl.

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

<video src="https://github.com/user-attachments/assets/3275979d-bbed-4639-83e2-8b7d83bed6af" controls muted playsinline poster="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-dark.png" width="820">
  <img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-dark.png" alt="Token Tracker Dashboard" width="820" />
</video>

<br/><br/>

⭐ **Wenn TokenTracker dir Zeit spart, [gib ihm einen Star auf GitHub](https://github.com/xiufengsun/TokenTracker) – das hilft anderen Entwicklern, es zu finden.**

<br/>

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/M4M11XSNWD)

</div>

---

## ⚡ Schnellstart

> **Voraussetzungen**: Node.js **20+** (CLI läuft auf macOS / Linux / Windows; native Desktop-Apps gibt es für macOS (Menüleiste), Windows (System Tray) und Linux (AppImage, Tray). Cursor-Token nutzt das systemeigene `sqlite3` CLI, wo verfügbar, und nutzt `node:sqlite` als Fallback auf unterstützten Node-Versionen).

```bash
npx tokentracker-cli
```

Das war's. Beim ersten Start werden Hooks installiert, deine Daten synchronisiert und das Dashboard unter `http://localhost:7680` geöffnet.

**Das bekommst du in 30 Sekunden:**

- 📊 Ein lokales Dashboard auf `localhost:7680` mit Nutzungstrends, Modellaufschlüsselung, Kostenanalyse
- 🔌 Auto-erkannte Hooks für jedes installierte KI-Tool
- 🏠 100 % lokal – kein Konto, keine API-Keys, keine Netzwerkaufrufe (außer optionalem Leaderboard)
- 🧩 *Optional:* Ein Skills-Tab zum Durchsuchen von 250+ öffentlichen Skills – synchronisiert über Claude · Codex · AStudio · Grok · Antigravity · Gemini · OpenCode · Hermes

> **Möchtest du eine native Desktop-App?**
> - **macOS** — [Lade `TokenTrackerBar.dmg` herunter](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTrackerBar.dmg) → in Programme ziehen. Menüleisten-Symbol, Desktop-Widgets und das Dashboard in einer WKWebView.
> - **Windows** — [Lade `TokenTracker-Setup.exe` herunter](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTracker-Setup.exe) → per-user Installer ausführen (kein Admin nötig). System-Tray-App mit Dashboard in WebView2. Portables Zip gibt's auf der [Releases-Seite](https://github.com/xiufengsun/TokenTracker/releases/latest).
> - **Linux** — [Lade `TokenTracker-linux-x86_64.AppImage` herunter](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTracker-linux-x86_64.AppImage) → `chmod +x` und starten. Tray-App mit Dashboard in einem WebKitGTK-Fenster. Sie bringt GTK/WebKit selbst mit und braucht aus deiner Distribution nichts außer einer aktuellen glibc; unter GNOME braucht das Tray-Symbol weiterhin die [AppIndicator-Erweiterung](https://extensions.gnome.org/extension/615/appindicator-support/). `.deb`- und `.rpm`-Pakete gibt es ebenfalls auf der [Releases-Seite](https://github.com/xiufengsun/TokenTracker/releases/latest) — diese nutzen stattdessen `webkit2gtk-4.1`, `gtk3` und appindicator der Distribution. Das `.deb` benötigt `libappindicator3-1`, das Debian 12 zugunsten von `libayatana-appindicator3-1` entfernt hat; nutze dort das AppImage.

Für kürzere Befehle global installieren:

```bash
npm i -g tokentracker-cli

tokentracker              # Dashboard öffnen
tokentracker sync         # Manuelle Synchronisation
tokentracker status       # Hook-Status prüfen
tokentracker status --json     # Maschinenlesbare Ausgabe (für jq, AI-Agenten)
tokentracker status --light    # Reine ASCII-Tabelle (CI / SSH, kein Spinner)
tokentracker doctor       # Health Check
```

### 🍺 Homebrew (macOS)

```bash
# macOS Menüleisten-App (DMG)
brew install --cask xiufengsun/tokentracker/tokentracker

# Nur CLI
brew install xiufengsun/tokentracker/tokentracker
```

Aktualisieren mit `brew upgrade --cask xiufengsun/tokentracker/tokentracker`. Der Tap wird innerhalb einer Stunde nach jedem Release automatisch aktualisiert.

---

## ✨ Features

- 🔌 **37 KI-Tools out of the box** — Claude Code, Codex CLI, AStudio, Cursor, Gemini CLI, Antigravity, Kiro, OpenCode, OpenClaw, Every Code, Hermes Agent, GitHub Copilot, Kimi Code, CodeBuddy, WorkBuddy, Grok Build, oh-my-pi, pi, Dots, Prime Agent, Craft Agents, Reasonix, Kilo CLI, Kilo Code, Roo Code, Zed Agent, Goose, Droid, Mimo Code, ZCode, Qoder, AnythingLLM Desktop, Claude Science, DeepSeek Harness, TRAE Work CN, LM Studio, Unsloth Studio
- 🏠 **100 % lokal** — Token-Daten verlassen nie deinen Rechner. Kein Konto, keine API-Keys.
- 🚀 **Zero Config** — Hooks installieren sich beim ersten Start automatisch. Von null zum Dashboard in 30 Sekunden.
- 📊 **Schönes Dashboard** — Nutzungstrends, Kostenaufschlüsselung nach Modell, GitHub-ähnliche Aktivitäts-Heatmap, Projektzuordnung
- 🖥️ **Native Desktop-App** — macOS Menüleiste (+ Widgets) und Windows System Tray, jeweils mit eingebautem Server und Dashboard in einer nativen WebView
- 🎨 **4 Desktop-Widgets** — Nutzung / Aktivitäts-Heatmap / Top-Modelle / Nutzungslimits auf dem Schreibtisch
- 📈 **Echtzeit-Nutzungslimits** — Limits für Claude / Codex / Cursor / Gemini / Kimi / Kiro / Grok / Copilot / Antigravity / ZCode / OpenCode Go / Qoder / Qoder CN; ein Last-Good-Cache bleibt erhalten, wenn eine lokale Provider-App vorübergehend beendet wird
- 🟢 **Service-Statusseite** — Live-Betriebs- und Störungsstatus von 8 offiziellen Provider-Statusseiten
- 💰 **Kosten-Engine** — 2.200+ Modelle bepreist via [LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) (täglich aktualisiert) + kuratierte Overrides für Nischen-Tools; 24h-Disk-Cache + Offline-Snapshot für genaue USD-Angaben ohne Internetverbindung. Modelle ohne veröffentlichte Preise (z. B. Tencent hy3-preview) werden nach Token erfasst, zeigen aber 0 $ Kosten bis der Anbieter einen Preis veröffentlicht.
- 🌐 **Optionales Leaderboard** — Vergleiche dich mit Entwicklern weltweit; Spalten per Drag-and-Drop neu anordnen (Opt-in, Anmeldung erforderlich)
- 🧩 **Optionaler Skills-Tab** — 250+ öffentliche Skills von `anthropics/skills`, `ComposioHQ/awesome-claude-skills`, `skills.sh` und jedem GitHub-Repo durchsuchen; mit einem Klick über Claude / Codex / AStudio / Grok / Antigravity / Gemini / OpenCode / Hermes synchronisieren
- 🔒 **Privacy-First** — Nur Token-Zahlen und Zeitstempel. Nie Prompts, Responses oder Dateiinhalte.

---

## 🖼️ Vorschau

<table>
<tr>
<td width="50%">

**Dashboard** — Nutzungstrends, Modellaufschlüsselung, Kostenanalyse

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-light.png" alt="Dashboard" />

</td>
<td width="50%">

**Desktop-Widgets** — Nutzung auf dem Schreibtisch

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/widgets-overview.png" alt="Desktop-Widgets" />

</td>
</tr>
<tr>
<td width="50%">

**Menüleisten-App** — Animierter Clawd-Begleiter + native Panels

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/menubar.gif" alt="Menüleisten-App" />

</td>
<td width="50%">

**Globales Leaderboard** — Vergleich mit Entwicklern weltweit

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/leaderboard.png" alt="Leaderboard" />

</td>
</tr>
<tr>
<td colspan="2">

**Skills-Manager** — 250+ öffentliche Skills von GitHub & `skills.sh` durchsuchen, einmal installieren, mit Claude / Codex / Grok / Antigravity / Gemini / OpenCode / Hermes synchronisieren. Ein-/Ausschalten pro Tool, Undo mit einem Klick.

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/skills.png" alt="Skills-Manager" />

</td>
</tr>
<tr>
<td colspan="2">

**Desktop-Pet** — ein Pixel-Begleiter, der auf dem Desktop schwebt und auf den echten Token-Verbrauch reagiert: Er codet mit, feiert Streaks und schläft in Pausen. Community-Pets per [codex-pets.net](https://codex-pets.net)-Link oder `.codex-pet.zip` importieren — V2-Pets folgen dem Cursor mit dem Blick in 16 Richtungen. macOS, Windows und Web.

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/pet.png" alt="Desktop Pet" />

</td>
</tr>
</table>

---

## 🔌 Unterstützte KI-Tools

| Tool | Erkennung | Methode |
|---|---|---|
| **Claude Code** | ✅ Auto | SessionEnd-Hook in `settings.json` |
| **Codex CLI** | ✅ Auto | TOML-Notify-Hook in `config.toml` |
| **AStudio** | ✅ Auto | TOML-Notify-Hook in `config.toml` |
| **Cursor** | ✅ Auto | API + SQLite-Auth-Token |
| **Kiro** | ✅ Auto | SQLite + JSONL hybrid |
| **Gemini CLI** | ✅ Auto | SessionEnd-Hook |
| **OpenCode** | ✅ Auto | Plugin-System + SQLite |
| **OpenClaw** | ✅ Auto | Session-Plugin |
| **Every Code** | ✅ Auto | TOML-Notify-Hook |
| **Hermes Agent** | ✅ Auto | SQLite Sessions-Tabelle (`~/.hermes/state.db`) |
| **GitHub Copilot App / CLI** | ✅ Auto | Vereinheitlichte SQLite-Nutzung pro Anfrage (`~/.copilot/session-store.db`); App-DB als Legacy-Baseline |
| **GitHub Copilot Chat-Erweiterung / ältere CLI** | ✅ Auto | OpenTelemetry-Datei-Exporter (`COPILOT_OTEL_FILE_EXPORTER_PATH`) |
| **Kimi Code** | ✅ Auto | Passiver `wire.jsonl`-Reader (`~/.kimi/sessions/**/wire.jsonl`) |
| **oh-my-pi (Pi Coding Agent)** | ✅ Auto | Passiver Reader (`~/.omp/agent/sessions/**/*.jsonl`) |
| **CodeBuddy** (Tencent) | ✅ Auto | SessionEnd-Hook in `~/.codebuddy/settings.json` (Claude-Code-Fork) |
| **WorkBuddy** (Tencent) | ✅ Auto | SessionEnd-Hook in `~/.workbuddy/settings.json` (Claude-Code-Fork) + passiver `projects/**/*.jsonl`-Scan |
| **Grok Build** (xAI) | ✅ Auto | SessionEnd-Hook + passiver `updates.jsonl` / `signals.json`-Scan (`~/.grok/sessions/**/`) |
| **Kilo CLI** (kilo.ai) | ✅ Auto | Passiver SQLite-Reader (`~/.local/share/kilo/kilo.db`, OpenCode-Fork-Schema) |
| **Kilo Code** (VS Code Extension) | ✅ Auto | Passiver `ui_messages.json`-Reader (Cursor/Code/CodeBuddy/Windsurf globalStorage) |
| **Antigravity** | ✅ Auto | Passiver Transcript-Reader (`~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/brain/**/transcript.jsonl`) |
| **pi** (`@mariozechner/pi-coding-agent`) | ✅ Auto | Passiver Reader (`~/.pi/agent/sessions/**/*.jsonl`) |
| **Dots** | ✅ Auto | Über pis Provider-Split geroutet (`pi-dots` source, derselbe passive Reader) — kein eigener Hook |
| **Prime Agent** | ✅ Auto | Metadatenbasierter passiver Usage-Reader (`~/.prime/agent/sessions/*.jsonl`) |
| **Craft Agents** | ✅ Auto | Passiver Session-Reader (`~/.craft-agent` + Workspace-Session-Logs) |
| **Roo Code** (VS Code Extension) | ✅ Auto | Passiver `ui_messages.json`-Reader (`rooveterinaryinc.roo-cline`) |
| **Zed Agent** | ✅ Auto | Passiver SQLite-Reader (`threads.db`, nur `zed.dev`-Modelle) |
| **Goose** (Block) | ✅ Auto | Passiver SQLite-Reader (`sessions.db`, kumulative Deltas) |
| **Droid** (Factory) | ✅ Auto | Passiver Session-Reader (`~/.factory/sessions/**/settings.json`, kumulative Deltas) |
| **Mimo Code** (mimocode) | ✅ Auto | Passiver SQLite-Reader (`~/.local/share/mimocode/mimocode.db`, OpenCode-Fork-Schema; zählt nur mimo-native Turns – gespiegelte Claude/claude-mem-Verläufe werden ausgeschlossen) |
| **ZCode** (Z.ai) | ✅ Auto | Passiver SQLite-Reader (`~/.zcode/cli/db/db.sqlite`, OpenCode-Fork-Schema; zählt nur Z.ai/BigModel-GLM-Turns – gebündelte Claude/Codex/Gemini-Sub-Agenten werden ausgeschlossen) |
| **Qoder** | ✅ Auto | Passiver SQLite-Reader (`Qoder/SharedClientCache/cache/db/local.db`; liest nur assistant-`token_info`, trennt Cache-Eingaben und liest keine Prompts oder Antworten) sowie Plan Credits und Ultimate-Gratisaufrufe aus der lokalen Qoder-Sitzung |
| **LM Studio** | ✅ Auto | Passiver rekursiver Reader für `~/.lmstudio/server-logs/**/*.log`; liest aus finalen Chat-Completions- und Responses-API-Datensätzen nur ID, Modell, Zeitstempel und skalare `usage`-Zähler und dedupliziert gespiegelte Antwort-IDs. Prompt- und Antworttexte werden nicht gespeichert. Diese Daten decken lokale Inferenz und LM Link mit $0 API-Grenzkosten ab, nicht die Bionic-Secure-Cloud-Abrechnung. |
| **Unsloth Studio** | ✅ Auto | Passiver SQLite-Reader für `$UNSLOTH_STUDIO_HOME/studio.db` (Standard `~/.unsloth/studio/studio.db`). Liest nur skalare `contextUsage`-Metadaten und inhaltsfreie `api_usage_events`; Prompts, Antworten, Anhänge, API-Subjects, Zugangsdaten und Trainingsmetriken bleiben ausgeschlossen. Lokale Routen bleiben bei $0, bekannte kostenpflichtige Provider werden anhand des tatsächlich antwortenden Modells geschätzt. |
| **AnythingLLM Desktop** | ✅ Auto | Passiver SQLite-Reader (`anythingllm-desktop/storage/anythingllm.db`, nur Token-Metriken pro Nachricht) |
| **Claude Science** | ✅ Auto | Passiver SQLite-Reader (`~/.claude-science/operon-cli.db`, nur die Token-Zähler der `frames`-Tabelle; keine Prompts, Artefakte oder Forschungsinhalte). Kein natives Windows-Build — unter Windows läuft die App in WSL und wird von dort gelesen. |
| **TRAE Work CN** | ✅ Auto | **Erfordert eine ausdrückliche Zustimmung: `TOKENTRACKER_TRAE_CN_USAGE=1` setzen.** Das Lesen der Nutzung überträgt die lokal gespeicherte Anmeldeautorisierung an die interne API von TRAE, daher wird nichts gesendet, bevor du es aktivierst. Danach: liest bei vorhandener lokaler TRAE Work CN-Anmeldung während eines zulässigen Syncs außerhalb des Hintergrundbetriebs unter macOS die Session-Token-Nutzung der angemeldeten App; die interne API kann sich ändern |

> **Muss ich Plugins oder Hooks manuell installieren?** Nein. `tokentracker` (oder `tokentracker init`) erledigt alles beim ersten Start:
> - **Hook-basiert** (Claude Code, Codex, AStudio, Gemini, Every Code, CodeBuddy, WorkBuddy, Grok Build) — wir schreiben einen SessionEnd-Hook oder TOML-Notify-Eintrag in die Konfiguration des Tools.
> - **Plugin-basiert** (OpenCode, OpenClaw) — das Plugin ist im npm-Paket enthalten (`~/.tokentracker/app/openclaw-plugin/`). Wir verlinken es per CLI (`openclaw plugins install --link …` + `enable`). Kein Download, kein Drag-and-Drop.
> - **Passive Reader** (Cursor, Kiro, Hermes, Kimi Code, Copilot, Grok Build, oh-my-pi, pi, Craft Agents, Kilo CLI, Kilo Code, Roo Code, Antigravity, Zed Agent, Goose, Droid, Mimo Code, ZCode, LM Studio, Unsloth Studio, AnythingLLM Desktop, Claude Science) — wir installieren nichts in diesen Tools. Wir lesen nur Dateien, die sie bereits produzieren (SQLite-DB, JSONL, OTEL-Export, Session-Logs). Die Nutzung von Copilot App / CLI wird pro Anfrage aus `~/.copilot/session-store.db` gelesen; `data.db` liefert einmalig die Legacy-Migrationsbasis und bleibt nach der kanonischen Übernahme des Stores schreibgeschützt im Beobachtungsmodus, während Chat-Erweiterung und ältere CLI-Versionen weiterhin OTEL verwenden. TokenTracker koordiniert diese Quellen, damit überlappende Anfragen nur einmal gezählt werden. Gemischte App/CLI-Historie vor der Übernahme bleibt als `github-copilot-legacy`-Aggregat erhalten, statt einem geratenen Anfrage-Modell zugeordnet zu werden.
>
> Führe `tokentracker status` aus, um den Status jeder Integration zu prüfen. Zeigt ein Tool `skipped`, erklärt die `detail`-Spalte warum.
>
> Tiefergehend: [OpenClaw-Integration & Troubleshooting](docs/openclaw-integration.md).

Fehlt dein Tool? [Erstelle ein Issue](https://github.com/xiufengsun/TokenTracker/issues/new) — neue Provider sind meist nur eine Parser-Datei entfernt.

---

## 🆚 Warum TokenTracker?

> **Suchst du eine ccusage-Alternative mit GUI?** TokenTracker unterstützt 37 Tools (nicht nur Claude Code), bietet native macOS- und Windows-Apps + Desktop-Widgets und dedupliziert Token-Datensätze korrekt über alle Provider hinweg – damit deine Zahlen mit dem Billing der Provider übereinstimmen.

| | **TokenTracker** | ccusage | Cursor Stats |
|---|---|---|---|
| **Unterstützte KI-Tools** | **37** | 1 (Claude) | 1 (Cursor) |
| **Lokal, kein Konto** | ✅ | ✅ | ❌ |
| **Native Desktop-App** | ✅ macOS + Windows | ❌ | ❌ |
| **Desktop-Widgets** | ✅ 4 Widgets | ❌ | ❌ |
| **Rate-Limit-Tracking** | ✅ 13 Provider | ❌ | Nur Cursor |
| **Präzises Multi-Provider-Dedup** | ✅ | ❌ ¹ | — |

<sub>¹ `reqId`-basierte Deduplizierung zählt Provider ohne Request-ID (DeepSeek / Kimi / MiniMax / Claude-Sub-Agenten) 1,6–3,7× über. TokenTracker dedupliziert über einen zusammengesetzten Schlüssel, sodass die Summen mit dem Billing der jeweiligen Provider übereinstimmen.</sub>

---

## 🏗️ Wie es funktioniert

```mermaid
flowchart LR
    A["KI-Coding-Tools<br/>Claude · Codex · AStudio · Cursor · Gemini · Kiro<br/>OpenCode · OpenClaw · Every Code · Hermes · Copilot<br/>Kimi · CodeBuddy · WorkBuddy · Grok · Kilo · Roo · Zed · Goose<br/>Antigravity · oh-my-pi · pi · Craft · Droid · Mimo · ZCode · Qoder · AnythingLLM · Claude Science · DeepSeek Harness · TRAE Work CN · LM Studio · Unsloth Studio"]
    A -->|Hooks lösen aus| B[Token Tracker]
    B -->|Logs parsen<br/>30-Min-UTC-Buckets| C[(Lokales SQLite)]
    C --> D[Web-Dashboard]
    C --> E[Menüleisten-App]
    C --> F[Desktop-Widgets]
    C -.->|Opt-in| G[(Cloud-Leaderboard)]
```

1. KI-CLI-Tools erzeugen Logs während der normalen Nutzung
2. Leichtgewichtige Hooks erkennen Änderungen und lösen Sync aus (Cursor nutzt API statt Hooks)
3. Token-Zahlen werden lokal geparst – nie Prompt- oder Response-Inhalte
4. In 30-Minuten-UTC-Buckets aggregiert
5. Dashboard, Menüleisten-App und Widgets lesen vom gleichen lokalen Snapshot

---

## 🛡️ Datenschutz

> 📄 **[Vollständige Datenschutzerklärung](docs/PRIVACY.md)** (englisch) — jede Netzwerkanfrage, die die App stellen kann, was dabei gesendet wird und wie man sie abschaltet.

| Schutz | Beschreibung |
|---|---|
| **Kein Content-Upload** | Nur Token-Zahlen und Zeitstempel. Nie Prompts, Responses oder Dateiinhalte. |
| **Standardmäßig lokal** | Alle Daten bleiben auf deinem Rechner. Das Leaderboard ist vollständig optional. |
| **Überprüfbar** | Open Source. Sieh selbst in [`src/lib/rollout.js`](src/lib/rollout.js) – nur Zahlen und Zeitstempel. |
| **Nur anonyme Nutzungsstatistiken** | Nur zwei anonyme Übertragungen: (1) höchstens ein täglicher Heartbeat — ein Einweg-Hash der Maschinen-ID, dazu App-Version, OS-Plattform und App-Shell (cli/macos/windows/linux) als separate Klartext-Felder; (2) anonyme Dashboard-Seiten-/Feature-Events (PostHog — Autocapture und Session-Recording deaktiviert, Browser-Do-Not-Track respektiert). Niemals Token-Zahlen, Modellnamen, Prompts oder Pfade. Auditierbar in [`src/lib/telemetry.js`](src/lib/telemetry.js) und [`dashboard/src/lib/analytics.js`](dashboard/src/lib/analytics.js); ein Schalter deaktiviert beides: `TOKENTRACKER_NO_TELEMETRY=1` (oder `DO_NOT_TRACK=1`). |

---

## 📦 Konfiguration

Die meisten Nutzer brauchen das nie – die Standardwerte sind sinnvoll. Für fortgeschrittene Setups:

| Variable | Beschreibung | Standard |
|---|---|---|
| `TOKENTRACKER_DEBUG` | Debug-Ausgabe aktivieren (`1` zum Aktivieren) | — |
| `TOKENTRACKER_NO_TELEMETRY` | Alle anonyme Telemetrie deaktivieren — täglicher Heartbeat und Dashboard-Analytics (`1` zum Deaktivieren; der `DO_NOT_TRACK`-Standard wird ebenfalls respektiert) | — |
| `TOKENTRACKER_HTTP_TIMEOUT_MS` | HTTP-Timeout in Millisekunden | `20000` |
| `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION` | Git-Commit-Zuordnung deaktivieren (`1` zum Deaktivieren). Die Zuordnung führt `git log` im Arbeitsverzeichnis jeder jüngeren Sitzung aus. Deaktiviert bleibt TokenTracker vollständig aus deinen Projektverzeichnissen heraus (Outcomes zeigt dann nur manuell erfasste Ergebnisse) | — |
| `TOKENTRACKER_GIT_ATTRIBUTION_PROTECTED_DIRS` | Der Git-Zuordnung Zugriff auf TCC-geschützte macOS-Orte erlauben (`1` zum Erlauben). Standardmäßig werden Sitzungen unter `~/Documents`, `~/Downloads`, `~/Desktop`, `~/Library`, den Medienordnern und `/Volumes` übersprungen, weil macOS für jeden Ort einen eigenen Zugriffsdialog anzeigt. Nur aktivieren, wenn du dort Repositories liegen hast und den Zugriff gewähren möchtest | — |
| `TOKENTRACKER_WSL_MODE` | WSL-Installations-Auflösungsverhalten unter Windows (zur Aggregation von nativen und WSL-Installationen). `wsl-first` (bevorzugt WSL), `native-first`, `wsl-only`, `native-only`, `both` (aggregiert beide Installationen) | `wsl-first` |
| `CODEX_HOME` | Codex CLI-Verzeichnis überschreiben | `~/.codex` |
| `TOKENTRACKER_ACODE_HOME` | AStudio-Verzeichnis überschreiben | `~/.acode` |
| `GEMINI_HOME` | Gemini CLI-Verzeichnis überschreiben | `~/.gemini` |
| `TOKENTRACKER_GROK_HOME` | Grok Build-Verzeichnis für Grok-Integration und Skills-Manager | `~/.grok` |
| `GROK_HOME` | Legacy-Grok-Build-Verzeichnis, falls `TOKENTRACKER_GROK_HOME` nicht gesetzt | `~/.grok` |
| `TOKENTRACKER_ANTIGRAVITY_HOME` | Einzelnes Antigravity-Skills-Verzeichnis erzwingen (sonst Auto-Erkennung von `~/.gemini/antigravity` + `~/.gemini/antigravity-ide`) | auto |

### 🐧 WSL-Erkennung unter Windows (WSL Auto-Discovery)

Wenn du KI-Coding-Agents unter Windows in WSL verwendest, kann TokenTracker deine Windows- und WSL-Installationen automatisch erkennen und die Token-Nutzung zusammenrechnen.

Konfiguriere dieses Verhalten über die Umgebungsvariable `TOKENTRACKER_WSL_MODE`:
* `both` (Empfohlen): Liest und addiert die Daten aus beiden Umgebungen (Windows und WSL).
* `wsl-first` (Standard): Bevorzugt WSL. Wenn Daten in WSL vorliegen, werden diese genutzt, andernfalls die von Windows.
* `native-first`: Bevorzugt Windows. Wenn Daten unter Windows vorliegen, werden diese genutzt, andernfalls die von WSL.
* `wsl-only`: Liest ausschließlich die Daten aus der WSL-Umgebung.
* `native-only`: Liest ausschließlich die Daten aus der nativen Windows-Umgebung.

> [!NOTE]
> **Präferenz (`-first`) vs. Isolierung (`-only`):** Präferenzmodi bevorzugen deine Auswahl, weichen aber automatisch auf die andere Umgebung aus, falls das Tool dort fehlt. Isolierungsmodi beschränken den Scan strikt auf eine Umgebung und ignorieren die andere komplett.

Unterstützte Provider für WSL-Erkennung und Zusammenführung (Aggregation):
* **Zusammenführung bei paralleler Installation (`both`-Modus):**
  * **Dateibasiert (Logs & Transkripte):** Every Code, Kimi (legacy & Code), Gemini CLI, Antigravity, OpenCode (JSON), Codex CLI, CodeBuddy, WorkBuddy, oh-my-pi (omp), pi, GitHub Copilot (OTEL), Roo Code, Craft, Kilo Code, Droid.
  * **Datenbankbasiert (SQLite):** Hermes, Zed Agent, Goose, OpenCode (`opencode.db`), Kilo CLI, Mimo Code, ZCode, GitHub Copilot (App DB).
* **WSL-Erkennung (nur Präferenz/Isolierung, keine Zusammenführung):**
  * Grok Build (wählt dynamisch entweder die native oder WSL-Umgebung je nach Modus, führt aber im `both`-Modus nicht beide zusammen).

---

## 🛠️ Entwicklung

```bash
git clone https://github.com/xiufengsun/TokenTracker.git
cd TokenTracker
npm install

# Dashboard bauen + CLI ausführen
cd dashboard && npm install && npm run build && cd ..
node bin/tracker.js

# Tests
npm test
```

### macOS-App bauen

```bash
cd TokenTrackerBar
npm run dashboard:build              # Dashboard-Bundle bauen
./scripts/bundle-node.sh             # Node.js + tokentracker-Quellen bündeln
xcodegen generate                    # Xcode-Projekt generieren
ruby scripts/patch-pbxproj-icon.rb   # Icon-Composer-Asset einspielen
xcodebuild -scheme TokenTrackerBar -configuration Release clean build
./scripts/create-dmg.sh              # .app in DMG verpacken
```

Erfordert **Xcode 16+** und [XcodeGen](https://github.com/yonaskolb/XcodeGen).

---

## 🔧 Fehlerbehebung

### CLI

<details>
<summary><b>Fehler „engines.node" oder nicht unterstützte Node-Version</b></summary>

<br/>

TokenTracker benötigt **Node 20+**. Prüfe deine Version:

```bash
node --version
```

Falls niedriger, aktualisiere via [nvm](https://github.com/nvm-sh/nvm), [fnm](https://github.com/Schniz/fnm) oder deinem Paketmanager (`brew upgrade node`, `apt install nodejs`).

</details>

<details>
<summary><b>Port 7680 bereits belegt</b></summary>

<br/>

Der Dashboard-Server wählt automatisch den nächsten freien Port (`7681`, `7682`, …), wenn `7680` belegt ist. Der tatsächliche Port wird beim Start ausgegeben. Um einen bestimmten Port zu erzwingen:

```bash
PORT=7700 tokentracker serve
```

Herausfinden, was `7680` blockiert:

```bash
lsof -i :7680
```

</details>

<details>
<summary><b>Ein Provider wird nicht erkannt</b></summary>

<br/>

Integrationsstatus prüfen:

```bash
tokentracker status
```

Für einen tiefergehenden Health Check:

```bash
tokentracker doctor
```

Zeigt ein Provider `not configured`, obwohl du ihn nutzt, versuche `tokentracker activate-if-needed`. Falls immer noch fehlend, [erstelle ein Issue](https://github.com/xiufengsun/TokenTracker/issues/new) mit der `doctor`-Ausgabe.

</details>

<details>
<summary><b>Hooks deinstallieren und Konfiguration löschen</b></summary>

<br/>

```bash
tokentracker uninstall
```

Entfernt alle von TokenTracker installierten Hooks sowie die lokale Konfiguration und Daten. Kann bedenkenlos wiederholt werden.

</details>

### macOS-App

<details>
<summary><b>„TokenTrackerBar kann nicht geöffnet werden" – nicht verifizierter Entwickler</b></summary>

<br/>

TokenTrackerBar ist **ad-hoc signiert** (nicht notariell beglaubigt mit einer Apple Developer ID – das erfordert ein kostenpflichtiges Developer-Konto). Gatekeeper blockiert sie beim ersten Start.

1. **Systemeinstellungen → Datenschutz & Sicherheit** öffnen
2. Zum Bereich **Sicherheit** scrollen – dort steht *„TokenTrackerBar wurde blockiert, um deinen Mac zu schützen."*
3. **Trotzdem öffnen** klicken
4. Mit **Öffnen** im Folgedialog bestätigen (Authentifizierung erforderlich)

Nur einmal nötig. Alternative unter älterem macOS: Rechtsklick auf die App im Finder → **Öffnen** → **Öffnen** im Bestätigungsdialog.

</details>

<details>
<summary><b>„TokenTrackerBar ist beschädigt und kann nicht geöffnet werden"</b></summary>

<br/>

Das ist Gatekeeper, das auf das `com.apple.quarantine`-Attribut reagiert – kein echtes Problem. Einmalig beheben mit:

```bash
xattr -cr /Applications/TokenTracker.app
```

Danach öffnet die App normal.

</details>

<details>
<summary><b>„TokenTrackerBar möchte auf Daten anderer Apps zugreifen"</b></summary>

<br/>

Das wird für die **Cursor**- und **Kiro**-Integration benötigt. Sie speichern Auth-Tokens / Nutzungsdaten in eigenen `~/Library/Application Support/`-Ordnern, die macOS mit der App-Management-Berechtigung schützt.

- ✅ **Erlauben** klicken, wenn du Cursor oder Kiro nutzt
- ❌ **Nicht erlauben** klicken, wenn nicht – diese Provider werden übersprungen, alles andere funktioniert

Nach einmaliger Gewährung wird die Berechtigung gemerkt. Ad-hoc-signierte Builds fragen nach jedem Update erneut, da jeder Build eine neue Signatur hat.

</details>

---

## 🪪 README-Badges

Zeig deine Token-Nutzung auf deinem GitHub-Profil oder in deiner Projekt-README.

So findest du `DEINE_USER_ID`:
1. Führe `tokentracker` aus, öffne das Dashboard und melde dich beim Leaderboard an.
2. Gehe zu **Einstellungen → Konto**.
3. Nutze die dort angezeigte **User ID**. Auf Headless-Maschinen schreibt `tokentracker device-login` die `user_id` ebenfalls nach `~/.tokentracker/tracker/config.json`.

Dann füge eines davon ein:

```markdown
[![tokens](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=DEINE_USER_ID&metric=tokens)](https://github.com/xiufengsun/TokenTracker)
[![cost](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=DEINE_USER_ID&metric=cost)](https://github.com/xiufengsun/TokenTracker)
[![rank](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=DEINE_USER_ID&metric=rank)](https://github.com/xiufengsun/TokenTracker)
```

> Der Link verweist standardmäßig auf das TokenTracker-Repo, damit jeder Klick anderen Entwicklern hilft, das Tool zu entdecken. Du kannst ihn gegen dein Leaderboard-Profil, deine Website oder `https://www.tokentracker.cc` austauschen.

Shields.io-kompatible Badges mit deinen aktuellen Gesamtwerten (60s Cache):

| Parameter | Werte | Standard |
|---|---|---|
| `metric` | `tokens` / `cost` / `rank` | `tokens` |
| `period` | `week` / `month` / `total` | `total` |
| `style` | `flat` / `flat-square` | `flat` |
| `label` | beliebiger kurzer Text | Metrik-Name |
| `color` | hex, z. B. `ff6b35` | Marken-Grün |

> **Datenschutz**: Badges werden nur für Profile aufgelöst, bei denen das Leaderboard-Sharing **aktiv** ist (`Einstellungen → Konto → Öffentliches Profil`). Private Profile zeigen einen „private"-Platzhalter.

---

## ⭐ Stern-Verlauf

<a href="https://www.star-history.com/?repos=xiufengsun%2FTokenTracker&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xiufengsun/TokenTracker&type=date&theme=dark&legend=top-left&sealed_token=Vr7qbPNqOTtzQEdtkxS2yArAReX2QkBZKNJgs3n32Q5oJa1iXddLlrT201teNSnt7QnsXtDcHy_T387xvXJ_HXHrPtvH2QQ1xqQZ67N_HV45ulWrt3j6hziDW5eshRCmu8CAT_W31PY0-WVZpFv7NQD-acv1stVK8ndribTokIp9ukSYAedx3icuUrOu" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xiufengsun/TokenTracker&type=date&legend=top-left&sealed_token=Vr7qbPNqOTtzQEdtkxS2yArAReX2QkBZKNJgs3n32Q5oJa1iXddLlrT201teNSnt7QnsXtDcHy_T387xvXJ_HXHrPtvH2QQ1xqQZ67N_HV45ulWrt3j6hziDW5eshRCmu8CAT_W31PY0-WVZpFv7NQD-acv1stVK8ndribTokIp9ukSYAedx3icuUrOu" />
    <img alt="Star-History-Diagramm" src="https://api.star-history.com/chart?repos=xiufengsun/TokenTracker&type=date&legend=top-left&sealed_token=Vr7qbPNqOTtzQEdtkxS2yArAReX2QkBZKNJgs3n32Q5oJa1iXddLlrT201teNSnt7QnsXtDcHy_T387xvXJ_HXHrPtvH2QQ1xqQZ67N_HV45ulWrt3j6hziDW5eshRCmu8CAT_W31PY0-WVZpFv7NQD-acv1stVK8ndribTokIp9ukSYAedx3icuUrOu" />
  </picture>
</a>

---

## 🤝 Beitragen & Support

- **Bugs / Feature-Wünsche**: [Issue erstellen](https://github.com/xiufengsun/TokenTracker/issues/new)
- **Sicherheit**: Siehe [SECURITY.md](SECURITY.md) – bitte keine öffentlichen Issues für Sicherheitsmeldungen
- **Pull Requests**: Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für Setup, Tests und das Hinzufügen neuer KI-Tool-Integrationen
- **Fragen / Vorstellungen**: [GitHub Discussions](https://github.com/xiufengsun/TokenTracker/discussions)

## 🙏 Danksagungen

Die Morphing-Engine des `bot`-Begleiters ist [bloub](https://github.com/jeremy-prt/bloub) von Jérémy Perret (MIT).

Das Clawd-Charakterdesign gehört Anthropic. Dies ist ein Community-Projekt ohne offizielle Verbindung zu Anthropic.

## 🔗 Links

- [LINUX DO](https://linux.do) — eine Entwickler-Community

## Lizenz

[MIT](LICENSE)

---

<div align="center">

**Token Tracker** – Quantifiziere deine KI-Ausgaben.

<a href="https://www.tokentracker.cc">tokentracker.cc</a>  ·  <a href="https://www.npmjs.com/package/tokentracker-cli">npm</a>  ·  <a href="https://github.com/xiufengsun/TokenTracker">GitHub</a>

</div>
