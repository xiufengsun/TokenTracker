 <div align="center">

# Token Tracker

[English](./README.md) · [简体中文](./README.zh-CN.md) · **日本語** · [한국어](./README.ko.md) · [Deutsch](./README.de.md)

### AI に使ったコストを正確に把握 — すべての CLI を横断して

**37 種類の AI コーディングツール**からトークン数を自動収集し、ローカルで集計、美しいダッシュボードで本当のコスト推移を可視化します。クラウドアカウント不要、API キー不要、セットアップ不要 — コマンド 1 つで完了です。

[![npm version](https://img.shields.io/npm/v/tokentracker-cli.svg?color=blue)](https://www.npmjs.com/package/tokentracker-cli)
[![npm downloads](https://img.shields.io/npm/dm/tokentracker-cli.svg?color=brightgreen)](https://www.npmjs.com/package/tokentracker-cli)
[![Homebrew](https://img.shields.io/github/v/release/xiufengsun/TokenTracker?label=brew&color=F8B73E&logo=homebrew&logoColor=white)](https://github.com/xiufengsun/homebrew-tokentracker)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/macOS-supported-lightgrey.svg)](https://www.apple.com/macos/)
[![GitHub stars](https://img.shields.io/github/stars/xiufengsun/TokenTracker?style=social)](https://github.com/xiufengsun/TokenTracker/stargazers)
[![Featured in 阮一峰周刊 #393](https://img.shields.io/badge/Featured%20in-%E9%98%AE%E4%B8%80%E5%B3%B0%E5%91%A8%E5%88%8A%20%23393-FF6B35?logo=rss&logoColor=white)](https://github.com/ruanyf/weekly/blob/master/docs/issue-393.md)
[![Author tokens](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=0652839f-d19f-4f67-af85-6b7675875443&metric=tokens&compact=1&label=author%20tokens)](https://github.com/xiufengsun/TokenTracker)

<br/>

<video src="https://github.com/user-attachments/assets/5e709422-5af8-4e4c-8109-f5bb711eb3f8" controls muted playsinline poster="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-dark.png" width="820">
  <img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-dark.png" alt="Token Tracker Dashboard" width="820" />
</video>

<video src="https://github.com/user-attachments/assets/3275979d-bbed-4639-83e2-8b7d83bed6af" controls muted playsinline poster="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-light.png" width="820"></video>

<br/><br/>

⭐ **TokenTracker が時間の節約に役立ったら、ぜひ [GitHub でスターを付けてください](https://github.com/xiufengsun/TokenTracker) — 他の開発者が見つけやすくなります。**

<br/>

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/M4M11XSNWD)

</div>

---

## ⚡ クイックスタート

> **動作要件**: Node.js **20+**（CLI は macOS / Linux / Windows で動作します。ネイティブデスクトップアプリは macOS（メニューバー）、Windows（システムトレイ）、Linux（AppImage、トレイ）を提供します。Cursor のトークン読み取りは、利用可能であればシステムの `sqlite3` CLI を使用し、対応する Node リリースでは `node:sqlite` にフォールバックします）。

```bash
npx tokentracker-cli
```

これだけです。初回実行で hook をインストールし、データを同期して、`http://localhost:7680` でダッシュボードを開きます。

**30 秒で手に入るもの:**
- 📊 `localhost:7680` のローカルダッシュボードで、使用トレンド、モデル別内訳、コスト分析が見える
- 🔌 インストール済みの対応 AI ツールすべてに対する hook を自動検出
- 🏠 100% ローカル — アカウント不要、API キー不要、ネットワーク通信なし（オプションのリーダーボードを除く）
- 🧩 *オプション:* 250+ の公開 Skill を閲覧して Claude · Codex · AStudio · Gemini · OpenCode · Hermes 間で同期できる Skills タブ

> **ネイティブのデスクトップアプリが欲しい?**
> - **macOS** — [`TokenTrackerBar.dmg` をダウンロード](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTrackerBar.dmg) → Applications にドラッグ。デスクトップウィジェット、メニューバーのステータスアイコン、WKWebView 上の同じダッシュボードを含みます。
> - **Windows** — [`TokenTracker-Setup.exe` をダウンロード](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTracker-Setup.exe) → 管理者権限不要のユーザー単位インストーラーを実行。WebView2 上にダッシュボードを表示するシステムトレイアプリです。ポータブル版 zip は[リリースページ](https://github.com/xiufengsun/TokenTracker/releases/latest)にあります。
> - **Linux** — [`TokenTracker-linux-x86_64.AppImage` をダウンロード](https://github.com/xiufengsun/TokenTracker/releases/latest/download/TokenTracker-linux-x86_64.AppImage) → `chmod +x` して実行。WebKitGTK ウィンドウにダッシュボードを表示するトレイアプリです。GTK/WebKit を同梱しているため、比較的新しい glibc 以外にディストリ側の依存はありません。GNOME ではトレイアイコンに [AppIndicator 拡張機能](https://extensions.gnome.org/extension/615/appindicator-support/)が必要です。`.deb` と `.rpm` パッケージも[リリースページ](https://github.com/xiufengsun/TokenTracker/releases/latest)にあり、こちらはディストリの `webkit2gtk-4.1`、`gtk3`、appindicator を利用します。`.deb` は `libappindicator3-1` に依存しますが、Debian 12 はこれを廃止して `libayatana-appindicator3-1` を提供しているため、Debian 12 では AppImage を使ってください。

短いコマンドで使うためグローバルインストール:

```bash
npm i -g tokentracker-cli

tokentracker              # ダッシュボードを開く
tokentracker sync         # 手動同期
tokentracker status       # hook の状態を確認
tokentracker doctor       # ヘルスチェック
```

### 🍺 Homebrew (macOS)

`brew` 派なら、追加の tap 操作なしで直接インストールできます:

```bash
# macOS メニューバーアプリ (DMG)
brew install --cask xiufengsun/tokentracker/tokentracker

# CLI のみ
brew install xiufengsun/tokentracker/tokentracker
```

アップグレードは `brew upgrade --cask xiufengsun/tokentracker/tokentracker`。tap は新リリースから 1 時間以内に自動更新されます。

---


## ✨ 機能

- 🔌 **37 種類の AI ツールを標準対応** — Claude Code、Codex CLI、AStudio、Cursor、Gemini CLI、Antigravity、Kiro、OpenCode、OpenClaw、Every Code、Hermes Agent、GitHub Copilot、Kimi Code、CodeBuddy、WorkBuddy、Grok Build、oh-my-pi、pi、Dots、Prime Agent、Craft Agents、Reasonix、Kilo CLI、Kilo Code、Roo Code、Zed Agent、Goose、Droid、Mimo Code、ZCode、Qoder、AnythingLLM Desktop、Claude Science、DeepSeek Harness、TRAE Work CN、LM Studio、Unsloth Studio
- 🏠 **100% ローカル** — トークンデータがマシンから外に出ることはありません。アカウント不要、API キー不要。
- 🚀 **ゼロコンフィグ** — Hook は初回実行で自動インストール。0 からダッシュボードまで 30 秒。
- 📊 **美しいダッシュボード** — 使用トレンド、モデル別コスト内訳、GitHub スタイルのアクティビティヒートマップ、プロジェクト別の帰属表示
- 🖥️ **ネイティブデスクトップアプリ** — macOS メニューバー（ウィジェット付き）と Windows システムトレイ。それぞれ組み込みサーバーとネイティブ WebView のダッシュボードを備えます
- 🎨 **4 種類のデスクトップウィジェット** — Pin Usage / Activity Heatmap / Top Models / Usage Limits をデスクトップに固定
- 📈 **リアルタイムの利用上限** — Claude / Codex / Cursor / Gemini / Kimi / Kiro / Grok / Copilot / Antigravity / ZCode / OpenCode Go / Qoder / Qoder CN の上限を表示し、ローカル provider アプリが一時的に終了しても last-good キャッシュを保持
- 🟢 **サービス状況ページ** — 8 つの公式 provider ステータスページから稼働状況と障害情報を表示
- 💰 **コストエンジン** — [LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) 経由で 2,200+ モデルの価格設定（毎日自動更新）に加え、ニッチなツール（Kiro、Cursor Composer、Kimi、CodeBuddy hy3）向けに厳選された上書き設定。24 時間のディスクキャッシュ + 同梱のオフラインスナップショットにより、ネット接続なしでも正確な USD 表示が可能です。ベンダーが公式価格を公開していないモデル（例: Tencent hy3-preview）はトークン数のみ追跡され、ベンダーが料金を公開するまでコストは $0 と表示されます。
- 🌐 **オプションのリーダーボード** — 世界中の開発者と比較。ドラッグで列を並び替えて、気になるプロバイダーに絞り込めます（オプトイン制、参加にはサインインが必要）
- 🔄 **デバイス横断アカウントビュー** — クラウド同期をオンにすると、利用しているすべてのマシン（ノート + デスクトップ + サーバー）の使用量を 1 つのビューに統合 — 合計・トレンド・ヒートマップ・モデル内訳をすべてデバイス横断で集計（オプトイン制、サインインが必要。デフォルトのローカルのみの体験は高速かつオフラインのまま）
- 🧩 **オプションの Skills タブ** — `anthropics/skills`、`ComposioHQ/awesome-claude-skills`、`skills.sh`、そして自分で追加した任意の GitHub リポジトリから 250+ の公開 Skill をブラウズ。Claude / Codex / AStudio / Gemini / OpenCode / Hermes にターゲット名を付けて同期し、ワンクリックで Undo
- 🔒 **プライバシー最優先** — トークン数とタイムスタンプのみ。プロンプト、レスポンス、ファイル内容を扱うことは一切ありません。

---

## 🖼️ ショーケース

<table>
<tr>
<td width="50%">

**ダッシュボード** — 使用トレンド、モデル別内訳、コスト分析

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/dashboard-light.png" alt="Dashboard" />

</td>
<td width="50%">

**デスクトップウィジェット** — 使用状況をデスクトップに固定

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/widgets-overview.png" alt="Desktop Widgets" />

</td>
</tr>
<tr>
<td width="50%">

**メニューバーアプリ** — アニメーション付きの Clawd コンパニオン + ネイティブパネル

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/menubar.gif" alt="Menu Bar App" />

</td>
<td width="50%">

**グローバルリーダーボード** — 世界中の開発者と比較

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/leaderboard.png" alt="Leaderboard" />

</td>
</tr>
<tr>
<td colspan="2">

**Skills Manager** — GitHub と `skills.sh` から 250+ の公開 Skill をブラウズし、一度インストールするだけで Claude / Codex / AStudio / Gemini / OpenCode / Hermes に同期。ターゲットごとのトグル、ワンクリック Undo、ファイルの手動コピー不要。

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/skills.png" alt="Skills Manager" />

</td>
</tr>
<tr>
<td colspan="2">

**デスクトップペット** — デスクトップに浮かぶピクセルコンパニオン。実際のトークン消費に反応し、コーディング中は一緒に作業、連続使用ではお祝い、休憩中は居眠り。[codex-pets.net](https://codex-pets.net) のリンクか `.codex-pet.zip` でコミュニティペットをインポートでき、V2 ペットはカーソルを 16 方向で追いかけます。macOS / Windows / Web 対応。

<img src="https://raw.githubusercontent.com/xiufengsun/tokentracker/main/docs/screenshots/pet.png" alt="Desktop Pet" />

</td>
</tr>
</table>

---

## 🔌 対応 AI ツール

| ツール | 検出 | 方式 |
|---|---|---|
| **Claude Code** | ✅ 自動 | `settings.json` 内の SessionEnd hook |
| **Codex CLI** | ✅ 自動 | `config.toml` 内の TOML notify hook |
| **AStudio** | ✅ 自動 | `config.toml` に TOML notify hook を書き込み |
| **Cursor** | ✅ 自動 | API + SQLite の認証トークン |
| **Kiro** | ✅ 自動 | SQLite + JSONL のハイブリッド |
| **Gemini CLI** | ✅ 自動 | SessionEnd hook |
| **OpenCode** | ✅ 自動 | プラグインシステム + SQLite |
| **OpenClaw** | ✅ 自動 | セッションプラグイン |
| **Every Code** | ✅ 自動 | TOML notify hook |
| **Hermes Agent** | ✅ 自動 | SQLite の sessions テーブル (`~/.hermes/state.db`) |
| **GitHub Copilot App / CLI** | ✅ 自動 | リクエスト単位の統合 SQLite 使用量 (`~/.copilot/session-store.db`)、App DB は旧データのベースライン |
| **GitHub Copilot Chat 拡張 / 旧 CLI** | ✅ 自動 | OpenTelemetry のファイルエクスポーター (`COPILOT_OTEL_FILE_EXPORTER_PATH`) |
| **Kimi Code** | ✅ 自動 | パッシブな `wire.jsonl` リーダー (`~/.kimi/sessions/**/wire.jsonl`) |
| **oh-my-pi (Pi Coding Agent)** | ✅ 自動 | パッシブリーダー (`~/.omp/agent/sessions/**/*.jsonl`) |
| **CodeBuddy** (Tencent) | ✅ 自動 | `~/.codebuddy/settings.json` 内の SessionEnd hook（Claude-Code fork） |
| **WorkBuddy** (Tencent) | ✅ 自動 | `~/.workbuddy/settings.json` 内の SessionEnd hook（Claude-Code fork）+ パッシブな `projects/**/*.jsonl` スキャン |
| **Grok Build** (xAI) | ✅ 自動 | SessionEnd hook + パッシブな `updates.jsonl` / `signals.json` スキャン (`~/.grok/sessions/**/`) |
| **Kilo CLI** (kilo.ai) | ✅ 自動 | パッシブな SQLite リーダー (`~/.local/share/kilo/kilo.db`、OpenCode-fork スキーマ) |
| **Kilo Code** (VS Code 拡張) | ✅ 自動 | パッシブな `ui_messages.json` リーダー (Cursor/Code/CodeBuddy/Windsurf の globalStorage) |
| **Antigravity** | ✅ 自動 | パッシブなトランスクリプトリーダー (`~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/brain/**/transcript.jsonl`) |
| **pi** (`@mariozechner/pi-coding-agent`) | ✅ 自動 | パッシブリーダー (`~/.pi/agent/sessions/**/*.jsonl`) |
| **Dots** | ✅ 自動 | pi のプロバイダー分割経由 (`pi-dots` source、同じパッシブリーダーを再利用) — 追加フックなし |
| **Prime Agent** | ✅ 自動 | メタデータのみのパッシブ使用量リーダー (`~/.prime/agent/sessions/*.jsonl`) |
| **Craft Agents** | ✅ 自動 | パッシブなセッションリーダー (`~/.craft-agent` + workspace session logs) |
| **Reasonix** | ✅ 自動 | パッシブなテレメトリリーダー (`~/.reasonix/**/*.jsonl.telemetry.json`) |
| **Roo Code** (VS Code 拡張) | ✅ 自動 | パッシブな `ui_messages.json` リーダー (`rooveterinaryinc.roo-cline`) |
| **Zed Agent** | ✅ 自動 | パッシブな SQLite リーダー (`threads.db`、hosted `zed.dev` models only) |
| **Goose** (Block) | ✅ 自動 | パッシブな SQLite リーダー (`sessions.db`、cumulative deltas) |
| **Droid** (Factory) | ✅ 自動 | パッシブなセッションリーダー (`~/.factory/sessions/**/settings.json`、cumulative deltas) |
| **Mimo Code** (mimocode) | ✅ 自動 | パッシブな SQLite リーダー (`~/.local/share/mimocode/mimocode.db`、OpenCode-fork schema; mimo ネイティブのターンのみ集計 — ミラーされた Claude/claude-mem 履歴は除外) |
| **ZCode** (Z.ai) | ✅ 自動 | パッシブな SQLite リーダー (`~/.zcode/cli/db/db.sqlite`、OpenCode-fork schema; Z.ai/BigModel の GLM ターンのみ集計 — 同梱の Claude/Codex/Gemini サブエージェントは除外) |
| **Qoder** | ✅ 自動 | パッシブ SQLite リーダー (`Qoder/SharedClientCache/cache/db/local.db`; assistant の `token_info` のみを読み、キャッシュ入力を分離。prompt/response は読みません) と、Qoder ローカルセッションからの Plan Credits / Ultimate 無料呼び出し上限 |
| **LM Studio** | ✅ 自動 | `~/.lmstudio/server-logs/**/*.log` のパッシブ再帰リーダー。Chat Completions / Responses API の最終応答から ID・モデル・時刻・スカラー `usage` カウンターだけを読み、応答 ID で重複排除します。prompt/response 本文は保持しません。このデータはローカル推論と LM Link（API の限界費用は $0）を対象とし、Bionic Secure Cloud の請求は含みません。 |
| **Unsloth Studio** | ✅ 自動 | `$UNSLOTH_STUDIO_HOME/studio.db`（既定 `~/.unsloth/studio/studio.db`）のパッシブ SQLite リーダー。スカラー `contextUsage` と内容を含まない `api_usage_events` のみを読み、prompt、reply、添付、API subject、認証情報、学習指標は除外します。ローカル経路は $0、既知の有料 provider は実際に応答したモデルで token コストを推定します。 |
| **AnythingLLM Desktop** | ✅ 自動 | パッシブな SQLite リーダー (`anythingllm-desktop/storage/anythingllm.db`、メッセージごとの token 指標のみ) |
| **Claude Science** | ✅ 自動 | パッシブな SQLite リーダー (`~/.claude-science/operon-cli.db`、`frames` テーブルの token カウンタのみ。prompt・成果物・研究内容は読みません)。ネイティブ Windows 版はなく、Windows では WSL 内で動作するアプリを読み取ります。 |
| **DeepSeek Harness** | ✅ 自動 | パッシブなセッションリーダー (`~/.dsh/sessions/**/session.jsonl[.zstd]`、セッションヘッダーと assistant イベントを解析し、複数フレームの zstd 展開に対応) |
| **TRAE Work CN** | ✅ 自動 | **明示的なオプトインが必要です: `TOKENTRACKER_TRAE_CN_USAGE=1` を設定してください。** 使用量の読み取りはローカルに保存されたサインイン認証を TRAE の内部 API に送信するため、有効にするまで何も送信されません。有効化後: ローカル TRAE Work CN のサインイン認証がある場合、実行可能な非バックグラウンド同期中に macOS のサインイン済みアプリから session-token 使用量を読み取ります。内部 API は変更される可能性があります |

> **プラグインや hook を手動でインストールする必要はありますか?** いいえ。`tokentracker`（または `tokentracker init`）が初回実行ですべて処理します:
> - **Hook ベース**のツール (Claude Code、Codex、AStudio、Gemini、Every Code、**CodeBuddy**、**WorkBuddy**、**Grok Build**) — ツール自身の設定に SessionEnd hook または TOML notify エントリーを書き込みます。
> - **プラグインベース**のツール (OpenCode、**OpenClaw**) — プラグインは npm パッケージ内に同梱されています。OpenClaw のセッションプラグインは `~/.tokentracker/tracker/openclaw-plugin/openclaw-session-sync/` にあり、OpenClaw 自身の CLI でリンクして有効化したうえで、同期を起動するセッション終了イベントを許可するために `hooks.allowConversationAccess=true` を設定します。ダウンロードもドラッグ＆ドロップも不要です。
> - **パッシブリーダー** (Cursor、Kiro、Hermes、Kimi Code、Copilot、**Grok Build**、**oh-my-pi**、**pi**、**Craft Agents**、**Reasonix**、**Kilo CLI**、**Kilo Code**、**Roo Code**、**Antigravity**、**Zed Agent**、**Goose**、**Droid**、**Mimo Code**、**ZCode**、**LM Studio**、**Unsloth Studio**、**AnythingLLM Desktop**、**Claude Science**、**DeepSeek Harness**) — これらのツールには何もインストールしません。ツールがすでに出力しているファイル (SQLite DB、JSONL、OTEL エクスポート、session logs) を読むだけです。Copilot App / CLI の使用量は `~/.copilot/session-store.db` からリクエスト単位で読み取ります。`data.db` は旧データ移行時のベースラインとして一度だけ使い、store が正規ソースになった後は監視専用です。Chat 拡張と旧 CLI は引き続き OTEL を使用し、重複するリクエストは TokenTracker が一度だけ集計します。移行前の混在 App/CLI 履歴でモデルを安全に分離できない残量は、推測したリクエストモデルではなく `github-copilot-legacy` の集計値として保持します。
> - **Grok Build の推定** — 現在のローカルテレメトリは `updates.jsonl` の累積 `totalTokens` を公開していますが、安定したプロンプト/出力/キャッシュの内訳はありません。`signals.json` は `contextTokensUsed` のスナップショットを使ったフォールバックとして残っています。コールごとの利用詳細が利用可能になるまで、TokenTracker は Grok のコストを推定します。
>
> いつでも `tokentracker status` を実行すれば、各統合の状態を確認できます。`skipped` と表示されている場合、`detail` 列にその理由が示されます（例: ツール CLI が `PATH` にない、設定が読めない）。
>
> もっと深く知りたい方へ: [OpenClaw 統合とトラブルシューティング](docs/openclaw-integration.md)。

お使いのツールが見当たらない? [Issue を立ててください](https://github.com/xiufengsun/TokenTracker/issues/new) — 新しいプロバイダーの追加は、たいていパーサーファイル 1 つで済みます。

---

## 🆚 なぜ TokenTracker?

|                          | **TokenTracker** | ccusage     | Cursor stats |
|--------------------------|:---:|:---:|:---:|
| **対応 AI ツール数**     | **37**           | 1 (Claude)  | 1 (Cursor)   |
| **ローカルファースト、アカウント不要** | ✅            | ✅           | ❌            |
| **ネイティブデスクトップアプリ** | ✅ macOS + Windows | ❌          | ❌            |
| **デスクトップウィジェット** | ✅ 4 種類      | ❌           | ❌            |
| **レート制限トラッキング** | ✅ 13 プロバイダー   | ❌           | Cursor のみ  |

---

## 🏗️ 仕組み

```mermaid
flowchart LR
    A["AI coding tools<br/>Claude Code · Codex · AStudio · Cursor · Gemini · Kiro<br/>OpenCode · OpenClaw · Every Code · Hermes · Copilot<br/>Kimi · CodeBuddy · WorkBuddy · Grok · Kilo · Roo · Zed · Goose<br/>Antigravity · oh-my-pi · pi · Craft · Droid · Mimo · ZCode · Qoder · AnythingLLM · Claude Science · DeepSeek Harness · TRAE Work CN · LM Studio · Unsloth Studio"]
    A -->|hooks trigger| B[Token Tracker]
    B -->|parse logs<br/>30-min UTC buckets| C[(Local SQLite)]
    C --> D[Web Dashboard]
    C --> E[Menu Bar App]
    C --> F[Desktop Widgets]
    C -.->|opt-in| G[(Cloud Leaderboard)]
```

1. AI CLI ツールが通常利用中にログを生成
2. 軽量な hook が変更を検出して同期をトリガー（Cursor は hook ではなく API を使用）
3. トークン数はローカルで解析 — プロンプトやレスポンスの内容には一切触れない
4. UTC の 30 分単位バケットに集計
5. ダッシュボード、メニューバーアプリ、ウィジェットはすべて同じローカルスナップショットから読み取る

---

## 🛡️ プライバシー

> 📄 **[プライバシーポリシー全文](docs/PRIVACY.md)**（英語）— アプリが行いうるすべてのネットワークリクエスト、その送信内容、そして無効化の方法を網羅しています。

| 保護 | 説明 |
|---|---|
| **コンテンツをアップロードしない** | トークン数とタイムスタンプのみ。プロンプト、レスポンス、ファイル内容は扱いません。 |
| **デフォルトでローカル限定** | すべてのデータはマシン上に留まります。リーダーボードは完全にオプトインです。 |
| **監査可能** | オープンソース。[`src/lib/rollout.js`](src/lib/rollout.js) を読んでください — 数字とタイムスタンプだけです。 |
| **匿名利用統計のみ** | 外部送信は匿名の 2 種類だけ：(1) 1 日最大 1 回のハートビート——マシン ID の一方向ハッシュ、アプリバージョン、OS プラットフォーム、実行形態（cli/macos/windows/linux）；(2) 匿名のダッシュボードのページ/機能イベント（PostHog——autocapture とセッション録画は無効、ブラウザの Do-Not-Track を尊重）。トークン数、モデル名、プロンプト、パスは一切含まれません。[`src/lib/telemetry.js`](src/lib/telemetry.js) と [`dashboard/src/lib/analytics.js`](dashboard/src/lib/analytics.js) で監査可能。`TOKENTRACKER_NO_TELEMETRY=1` または `DO_NOT_TRACK=1` で両方を無効化できます。 |

---

## 📦 設定

ほとんどのユーザーは触る必要がありません — デフォルトで十分に機能します。高度な設定向け:

| 変数 | 説明 | デフォルト |
|---|---|---|
| `TOKENTRACKER_DEBUG` | デバッグ出力を有効化（`1` で有効） | — |
| `TOKENTRACKER_NO_TELEMETRY` | すべての匿名テレメトリ（日次ハートビート + ダッシュボード分析）を無効化（`1` で無効。`DO_NOT_TRACK` 標準にも対応） | — |
| `TOKENTRACKER_HTTP_TIMEOUT_MS` | HTTP タイムアウト（ミリ秒） | `20000` |
| `TOKENTRACKER_DISABLE_GIT_ATTRIBUTION` | Git コミットの紐付けを無効化（`1` で無効）。紐付けは各セッションの作業ディレクトリ内で `git log` を実行します。無効にすると TokenTracker はプロジェクトディレクトリに一切入りません（Outcomes は手動記録分のみ表示） | — |
| `TOKENTRACKER_GIT_ATTRIBUTION_PROTECTED_DIRS` | Git 紐付けが macOS の保護された場所に入ることを許可（`1` で許可）。既定では `~/Documents`、`~/Downloads`、`~/Desktop`、`~/Library`、メディアフォルダ、`/Volumes` 配下のセッションをスキップします。macOS は場所ごとに個別のアクセス許可ダイアログを出すためです。これらの場所にリポジトリを置いており、許可しても構わない場合のみ有効化してください | — |
| `CODEX_HOME` | Codex CLI ディレクトリの上書き | `~/.codex` |
| `TOKENTRACKER_ACODE_HOME` | AStudio ディレクトリの上書き | `~/.acode` |
| `GEMINI_HOME` | Gemini CLI ディレクトリの上書き | `~/.gemini` |

---

## 🛠️ 開発

```bash
git clone https://github.com/xiufengsun/TokenTracker.git
cd TokenTracker
npm install

# ダッシュボードをビルドして CLI を実行
cd dashboard && npm install && npm run build && cd ..
node bin/tracker.js

# テスト
npm test
```

### macOS アプリのビルド

```bash
cd TokenTrackerBar
npm run dashboard:build              # ダッシュボードバンドルをビルド
./scripts/bundle-node.sh             # Node.js + tokentracker ソースをバンドル
xcodegen generate                    # Xcode プロジェクトを生成
ruby scripts/patch-pbxproj-icon.rb   # Icon Composer アセットをパッチ適用
xcodebuild -scheme TokenTrackerBar -configuration Release clean build
./scripts/create-dmg.sh              # .app を DMG にパッケージ化
```

**Xcode 16+** と [XcodeGen](https://github.com/yonaskolb/XcodeGen) が必要です。

---

## 🔧 トラブルシューティング

### CLI

<details>
<summary><b>「engines.node」または非対応バージョンのエラー</b></summary>

<br/>

TokenTracker は **Node 20+** を必要とします。バージョンを確認:

```bash
node --version
```

低い場合は [nvm](https://github.com/nvm-sh/nvm)、[fnm](https://github.com/Schniz/fnm)、またはパッケージマネージャー (`brew upgrade node`、`apt install nodejs`) でアップグレードしてください。

</details>

<details>
<summary><b>ポート 7680 がすでに使用中</b></summary>

<br/>

ダッシュボードサーバーは `7680` が使われている場合、自動的に次の空きポート (`7681`、`7682`、…) を選びます。実際に使われているポートは起動時にログ出力されます。特定のポートを強制したい場合:

```bash
PORT=7700 tokentracker serve
```

`7680` を掴んでいるプロセスを探すには:

```bash
lsof -i :7680
```

**WSL2 の注意**: Windows ホストでは配信の最適化サービス (`DoSvc`) が `7680` を待ち受けており、NAT ネットワークではこの競合を WSL 内から検出できません — サーバーは正常に起動しますが、Windows ブラウザは `DoSvc` に接続してしまいます。そのため TokenTracker は WSL 上ではデフォルトで `7681` を使います（起動時にログ出力されます）。

</details>

<details>
<summary><b>プロバイダーが検出されない</b></summary>

<br/>

統合の状態を確認:

```bash
tokentracker status
```

次に doctor でより深いヘルスチェックを実行:

```bash
tokentracker doctor
```

使っているはずなのに未設定と表示されるプロバイダーがある場合、`tokentracker activate-if-needed` で hook 検出を再実行してみてください。それでも見つからない場合は、`doctor` の出力を添えて [Issue を立ててください](https://github.com/xiufengsun/TokenTracker/issues/new)。

</details>

<details>
<summary><b>hook をアンインストールして設定をすべて削除する方法</b></summary>

<br/>

```bash
tokentracker uninstall
```

これにより、検出されたすべての AI ツールに対して TokenTracker がインストールした hook を削除し、ローカルの設定とデータも消します。再実行しても安全です。

</details>

### macOS アプリ

<details>
<summary><b>「TokenTrackerBar を開けません」 — 未確認の開発元</b></summary>

<br/>

TokenTrackerBar は **アドホック署名**されています（Apple Developer ID による公証は行っていません — それには有料の Developer アカウントが必要です）。Gatekeeper が初回起動時にブロックします。

1. **システム設定 → プライバシーとセキュリティ**を開く
2. **セキュリティ** セクションまでスクロール — *「TokenTrackerBar は Mac を保護するためブロックされました。」* が表示されます
3. **このまま開く** をクリック
4. 続けて出るダイアログで **開く** を選んで確定（認証が必要です）

一度行えば OK です。古い macOS でのやり方: Finder でアプリを右クリック → **開く** → 確認ダイアログで **開く**。

</details>

<details>
<summary><b>「TokenTrackerBar は壊れているため開けません」</b></summary>

<br/>

これは macOS がダウンロードファイルに付与する `com.apple.quarantine` 属性に Gatekeeper が反応しているだけで、実際の問題ではありません。次のコマンドで一度クリアしてください:

```bash
xattr -cr /Applications/TokenTracker.app
```

これでアプリは普通に開けます。

</details>

<details>
<summary><b>「TokenTrackerBar が他のアプリのデータにアクセスしようとしています」</b></summary>

<br/>

これは **Cursor** と **Kiro** 統合に必要です。これらは認証トークンや利用データを `~/Library/Application Support/` 配下の自分のフォルダーに保存しており、macOS は App Management 権限で保護しています。

- ✅ Cursor または Kiro を使っているなら **許可** をクリック
- ❌ 使っていないなら **許可しない** をクリック — それらのプロバイダーは黙ってスキップされ、それ以外はすべて動き続けます

一度許可すれば、その権限は記憶されます。アドホック署名のビルドは、アップグレードごとに署名アイデンティティが変わるため、再度プロンプトが出る点に注意してください。

</details>

---

## 🪪 README バッジ

GitHub プロフィールやプロジェクトの README で自分のトークン使用量をアピールしましょう。

`YOUR_USER_ID` の取得方法:
1. `tokentracker` を実行してダッシュボードを開き、リーダーボードにサインインします。
2. **Settings → Account** に移動します。
3. そこに表示される **User ID** を使います。headless / SSH 環境では、`tokentracker device-login` も同じ `user_id` を `~/.tokentracker/tracker/config.json` に書き込みます。

以下のどれかを貼り付けてください:

```markdown
[![tokens](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=YOUR_USER_ID&metric=tokens)](https://github.com/xiufengsun/TokenTracker)
[![cost](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=YOUR_USER_ID&metric=cost)](https://github.com/xiufengsun/TokenTracker)
[![rank](https://srctyff5.us-east.insforge.app/functions/tokentracker-badge-svg?user_id=YOUR_USER_ID&metric=rank)](https://github.com/xiufengsun/TokenTracker)
```

> リンク先はデフォルトで TokenTracker リポジトリに設定してあり、クリックがそのまま他の開発者の発見につながります。あなた自身の leaderboard プロフィール、個人サイト、または `https://www.tokentracker.cc` に飛ばしたい場合は URL を差し替えてください。

現在の合計を反映した shields.io 互換バッジが描画されます（60 秒キャッシュ）:

| パラメータ | 値 | デフォルト |
|---|---|---|
| `metric` | `tokens` / `cost` / `rank` | `tokens` |
| `period` | `week` / `month` / `total` | `total` |
| `style` | `flat` / `flat-square` | `flat` |
| `label` | 任意の短い文字列 | metric 名 |
| `color` | hex（例: `ff6b35`） | ブランドグリーン |

> **プライバシー**: バッジはリーダーボード共有が **オン** (`Settings → Account → Public profile`) のプロフィールに対してのみ解決されます。非公開プロフィールには「private」プレースホルダーが返ります。

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

## 🤝 コントリビューション & サポート

- **バグ / 機能リクエスト**: [Issue を立てる](https://github.com/xiufengsun/TokenTracker/issues/new)
- **セキュリティ**: [SECURITY.md](SECURITY.md) を参照 — セキュリティ報告は公開 Issue として立てないでください
- **プルリクエスト**: セットアップ、テスト、新しい AI ツール統合の追加方法は [CONTRIBUTING.md](CONTRIBUTING.md) を参照
- **質問 / ショーケース**: [GitHub Discussions](https://github.com/xiufengsun/TokenTracker/discussions)

## 🙏 クレジット

`bot` コンパニオンのモーフィングエンジンは Jérémy Perret 氏の [bloub](https://github.com/jeremy-prt/bloub)（MIT）です。

Clawd キャラクターのデザインは Anthropic に帰属します。本プロジェクトはコミュニティ主導のものであり、Anthropic との公式な提携関係はありません。

## 🔗 リンク

- [LINUX DO](https://linux.do) — 開発者コミュニティ

## ライセンス

[MIT](LICENSE)

---

<div align="center">

**Token Tracker** — あなたの AI アウトプットを定量化する。

<a href="https://www.tokentracker.cc">tokentracker.cc</a>  ·  <a href="https://www.npmjs.com/package/tokentracker-cli">npm</a>  ·  <a href="https://github.com/xiufengsun/TokenTracker">GitHub</a>

</div>
