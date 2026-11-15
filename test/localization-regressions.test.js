const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, "..", relPath), "utf8");
}

test("zh locale keeps CLI subcommands executable", () => {
  const dashboardCopy = read("dashboard/src/content/i18n/zh/dashboard.json");

  assert.match(
    dashboardCopy,
    /"dashboard\.install\.cmd\.init":\s*"npx --yes tokentracker-cli init"/,
    "expected zh install init command to keep the init subcommand",
  );
  assert.match(
    dashboardCopy,
    /"dashboard\.install\.cmd\.sync":\s*"npx --yes tokentracker-cli sync"/,
    "expected zh sync command to keep the sync subcommand",
  );
  assert.doesNotMatch(dashboardCopy, /tokentracker-cli (初始化|同步)/);
});

test("native macOS strings are wired through the Swift localization helpers", () => {
  const nativeLocalization = read("TokenTrackerBar/Shared/NativeLocalization.swift");
  const strings = read("TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift");
  const widgetStrings = read("TokenTrackerBar/TokenTrackerWidget/Views/WidgetStrings.swift");
  const dateHelpers = read("TokenTrackerBar/TokenTrackerBar/Utilities/DateHelpers.swift");
  const clawdCompanion = read("TokenTrackerBar/TokenTrackerBar/Views/ClawdCompanionView.swift");
  const usageLimitsView = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  const topModelsView = read("TokenTrackerBar/TokenTrackerBar/Views/TopModelsView.swift");
  const summaryWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/SummaryWidget.swift");
  const heatmapWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/HeatmapWidget.swift");
  const topModelsWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/TopModelsWidget.swift");
  const usageLimitsWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/UsageLimitsWidget.swift");
  const sharedWidgetViews = read("TokenTrackerBar/TokenTrackerWidget/Views/SharedWidgetViews.swift");

  // NativeLocalization is the single source of truth for the current locale and
  // recognises all five supported locales (en, zh-CN, zh-TW, ja, ko).
  assert.ok(nativeLocalization.includes("public static var usesChinese: Bool"));
  assert.ok(nativeLocalization.includes("public static let chineseLocale = \"zh-CN\""));
  assert.ok(nativeLocalization.includes("public static let traditionalChineseLocale = \"zh-TW\""));
  assert.ok(nativeLocalization.includes("public static let japaneseLocale = \"ja\""));
  assert.ok(nativeLocalization.includes("public static let koreanLocale = \"ko\""));

  // Strings.swift goes through the t(en, zhCN, zhTW, ja, ko) helper bound to
  // NativeLocalization.currentResolvedLocale.
  assert.ok(strings.includes("NativeLocalization.currentResolvedLocale"));
  assert.ok(strings.includes('t("Server Unavailable", "服务器不可用", "伺服器不可用", "サーバーを利用できません", "서버를 사용할 수 없음")'));
  assert.ok(strings.includes('t("Sync Now", "立即同步", "立即同步", "今すぐ同期", "지금 동기화")'));
  assert.ok(strings.includes('t("Today", "今日", "今日", "今日", "오늘")'));
  assert.ok(strings.includes('t("Settings", "设置", "設定", "設定", "설정")'));
  // Menu-bar inline labels stay English on purpose — they sit next to the token
  // count so they should never swap with system language.
  assert.ok(strings.includes('static var menuTokenLabel: String { "Tokens" }'));
  assert.ok(strings.includes('static var menuCostLabel: String { "Cost" }'));

  // WidgetStrings mirrors the same helper for the WidgetKit target.
  assert.ok(widgetStrings.includes("NativeLocalization.currentResolvedLocale"));
  assert.ok(widgetStrings.includes('t("Usage", "使用情况", "使用情況", "使用状況", "사용량")'));
  assert.ok(widgetStrings.includes('t("Activity Heatmap", "活跃热力图", "活躍熱力圖", "アクティビティヒートマップ", "활동 히트맵")'));

  // DateHelpers / UsageLimitsView / TopModelsView must not re-implement the
  // en/zh branch inline — they must route through Strings.* so the copy table
  // stays centralised.
  assert.ok(dateHelpers.includes("return Strings.periodDayLabel"));
  assert.ok(dateHelpers.includes("return Strings.periodTotalLabel"));
  assert.ok(!dateHelpers.includes('NativeLocalization.usesChinese ? "日" : "Day"'));

  assert.ok(usageLimitsView.includes("Strings.kiroBonusLabel"));
  assert.ok(usageLimitsView.includes("Strings.grokPrimaryLabel"));
  assert.ok(usageLimitsView.includes('case "grok"'));
  assert.ok(usageLimitsView.includes("Strings.limitResetNow"));
  assert.ok(!usageLimitsView.includes('NativeLocalization.usesChinese ? "奖励" : "Bonus"'));

  assert.ok(strings.includes("static var grokWeekLabel"));
  assert.ok(strings.includes("static func grokPrimaryLabel"));
  assert.ok(strings.includes('case "weekly": return grokWeekLabel'));

  const grokLimitsModel = read("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift");
  assert.ok(grokLimitsModel.includes("periodType"));
  assert.ok(grokLimitsModel.includes('case periodType = "period_type"'));

  const limitsSettingsStore = read("TokenTrackerBar/TokenTrackerBar/Models/LimitsSettingsStore.swift");
  assert.ok(limitsSettingsStore.includes('"grok"'));
  assert.ok(limitsSettingsStore.includes('"Grok Build"'));

  assert.ok(topModelsView.includes("Strings.topModelAccessibility"));

  // Clawd quips now pull from Strings rather than hardcoded English arrays.
  assert.ok(clawdCompanion.includes("Strings.syncingQuips"));
  assert.ok(clawdCompanion.includes("Strings.personalityQuips"));
  assert.ok(clawdCompanion.includes("Strings.tokensToday(f)"));

  // Widget entry points and shared chrome flow through WidgetStrings.
  assert.ok(summaryWidget.includes("WidgetStrings.usageName"));
  assert.ok(summaryWidget.includes("WidgetStrings.today"));
  assert.ok(summaryWidget.includes("WidgetStrings.vsYesterday"));
  assert.ok(heatmapWidget.includes("WidgetStrings.heatmapName"));
  assert.ok(heatmapWidget.includes("WidgetStrings.streak(streak)"));
  assert.ok(topModelsWidget.includes("WidgetStrings.topModelsName"));
  assert.ok(topModelsWidget.includes("WidgetStrings.noModelUsage"));
  assert.ok(usageLimitsWidget.includes("WidgetStrings.limitsName"));
  assert.ok(usageLimitsWidget.includes("WidgetStrings.noConfiguredProviders"));
  assert.ok(sharedWidgetViews.includes("WidgetStrings.updated(WidgetFormat.relativeUpdated(updated))"));
});

test("Codex Spark usage limits are wired through macOS consumers", () => {
  const model = read("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift");
  const usageLimitsView = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  const widgetSnapshotWriter = read("TokenTrackerBar/TokenTrackerBar/Services/WidgetSnapshotWriter.swift");
  const usageLimitsWidget = read("TokenTrackerBar/TokenTrackerWidget/Widgets/UsageLimitsWidget.swift");
  const widgetStrings = read("TokenTrackerBar/TokenTrackerWidget/Views/WidgetStrings.swift");
  const statusBarController = read("TokenTrackerBar/TokenTrackerBar/Services/StatusBarController.swift");
  const menuBarDisplayPreferences = read("TokenTrackerBar/TokenTrackerBar/Models/MenuBarDisplayPreferences.swift");
  const nativeBridge = read("TokenTrackerBar/TokenTrackerBar/Services/NativeBridge.swift");

  assert.ok(model.includes("let sparkPrimaryWindow: CodexWindow?"));
  assert.ok(model.includes("let sparkSecondaryWindow: CodexWindow?"));
  assert.ok(model.includes('case sparkPrimaryWindow = "spark_primary_window"'));
  assert.ok(model.includes('case sparkSecondaryWindow = "spark_secondary_window"'));

  assert.match(usageLimitsView, /if let w = c\.sparkPrimaryWindow \{ s\.append\(makeSpec\("Spark 5h"/);
  assert.match(usageLimitsView, /if let w = c\.sparkSecondaryWindow \{ s\.append\(makeSpec\("Spark 7d"/);
  assert.doesNotMatch(usageLimitsView, /makeSpec\("Sp [57][hd]"/);

  assert.match(widgetSnapshotWriter, /if let w = limits\.codex\.sparkPrimaryWindow \{\s*out\.append\(LimitProvider\([^)]*label: "Codex · Spark 5h"/);
  assert.match(widgetSnapshotWriter, /if let w = limits\.codex\.sparkSecondaryWindow \{\s*out\.append\(LimitProvider\([^)]*label: "Codex · Spark 7d"/);
  assert.ok(widgetStrings.includes("let kind = limitKind(limit.label)"));
  assert.ok(widgetStrings.includes('case "Spark 5h"'));
  assert.ok(widgetStrings.includes('case "Spark 7d"'));
  assert.doesNotMatch(widgetStrings, /label\.contains\("Spark/);
  for (const localizedSparkLabel of [
    String.raw`\(source) · Spark 5小时`,
    String.raw`\(source) · Spark 7天`,
    String.raw`\(source) · Spark 5小時`,
    String.raw`\(source) · Spark 5時間`,
    String.raw`\(source) · Spark 5시간`,
    String.raw`\(source) · Spark 7일`,
  ]) {
    assert.ok(widgetStrings.includes(localizedSparkLabel));
  }
  assert.match(usageLimitsWidget, /let flat = orderedGroups\.flatMap \{ \$0 \}/);
  assert.doesNotMatch(usageLimitsWidget, /flatMap \{ \$0\.sorted \{ \$0\.fraction > \$1\.fraction \} \}/);

  assert.ok(menuBarDisplayPreferences.includes("case codexSpark5h"));
  assert.ok(menuBarDisplayPreferences.includes("case codexSpark7d"));
  assert.ok(menuBarDisplayPreferences.includes('case .codexSpark5h: return "Cx Spark 5h"'));
  assert.ok(menuBarDisplayPreferences.includes('case .codexSpark7d: return "Cx Spark 7d"'));
  assert.doesNotMatch(menuBarDisplayPreferences, /Cx Sp [57][hd]/);
  assert.ok(menuBarDisplayPreferences.includes('case .codexSpark5h: return "Codex Spark 5h Limit"'));
  assert.ok(menuBarDisplayPreferences.includes('case .codexSpark7d: return "Codex Spark 7d Limit"'));
  assert.match(menuBarDisplayPreferences, /case \.codex5h,\s*\.codex7d,\s*(?:\.codexCredits,\s*)?\.codexSpark5h,\s*\.codexSpark7d:\s*return "codex"/);
  assert.match(menuBarDisplayPreferences, /case \.codexSpark5h:\s*return codex\.sparkPrimaryWindow != nil/);
  assert.match(menuBarDisplayPreferences, /case \.codexSpark7d:\s*return codex\.sparkSecondaryWindow != nil/);
  assert.ok(menuBarDisplayPreferences.includes("return limits.isProviderAvailable(provider) && limits.hasWindow(for: metric)"));
  assert.match(menuBarDisplayPreferences, /guard let limits else \{\s*return false\s*\}/);
  assert.match(statusBarController, /case \.codexSpark5h:\s*return codexLimitValue\(id: id, metric: metric, window: viewModel\.usageLimits\?\.codex\.sparkPrimaryWindow\)/);
  assert.match(statusBarController, /case \.codexSpark7d:\s*return codexLimitValue\(id: id, metric: metric, window: viewModel\.usageLimits\?\.codex\.sparkSecondaryWindow\)/);

  assert.doesNotMatch(nativeBridge, /sparkPrimaryWindow|sparkSecondaryWindow|codexSpark/i);
  assert.match(nativeBridge, /MenuBarDisplayPreferences\.availableItemIDs\(\s*for:\s*limits,\s*keepingSelected:\s*MenuBarDisplayPreferences\.read\(\),\s*hiddenProviders:\s*LimitsSettingsStore\.shared\.hiddenProviders\s*\)/);
});

test("Codex Spark usage limit labels use copy keys with compact defaults", () => {
  const copyCsv = read("dashboard/src/content/copy.csv");
  const providerSpecs = read("dashboard/src/ui/dashboard/components/usage-limits-provider-specs.js");

  assert.match(copyCsv, /^limits\.label\.codex_spark_5h,.*"Spark 5h"/m);
  assert.match(copyCsv, /^limits\.label\.codex_spark_7d,.*"Spark 7d"/m);
  assert.match(providerSpecs, /{ key: "spark-5h", labelKey: "limits\.label\.codex_spark_5h", window: data\.spark_primary_window, windowSecondsField: "limit_window_seconds" }/);
  assert.match(providerSpecs, /{ key: "spark-7d", labelKey: "limits\.label\.codex_spark_7d", window: data\.spark_secondary_window, windowSecondsField: "limit_window_seconds" }/);
  assert.doesNotMatch(providerSpecs, /label: "Spark [57][hd]"/);

  for (const locale of ["zh", "zh-TW", "ja", "ko"]) {
    const core = JSON.parse(read(`dashboard/src/content/i18n/${locale}/core.json`));

    assert.equal(core["limits.label.codex_spark_5h"], "Spark 5h");
    assert.equal(core["limits.label.codex_spark_7d"], "Spark 7d");
  }
});

test("Codex Spark usage limit row labels stay on one line", () => {
  const usageLimitsView = read("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  const usageLimitsPanel = read("dashboard/src/ui/dashboard/components/UsageLimitsPanel.jsx");

  // The shared rowLabel helper must keep labels single-line, measure the
  // natural width into LimitLabelWidthKey, and cap the shared column.
  assert.match(usageLimitsView, /private func rowLabel\(_ text: String\) -> some View \{[\s\S]*?\.lineLimit\(1\)[\s\S]*?\.fixedSize\(horizontal: labelColumnWidth == 0, vertical: false\)[\s\S]*?\.frame\(width: labelColumnWidth > 0 \? min\(labelColumnWidth, Self\.labelColumnMaxWidth\) : nil, alignment: \.leading\)[\s\S]*?LimitLabelWidthKey/);
  assert.match(usageLimitsView, /return HStack\(spacing: Self\.rowColumnSpacing\) \{\s*rowLabel\(label\)/);
  assert.match(usageLimitsPanel, /data-limit-label[\s\S]*?\bwhitespace-nowrap\b[\s\S]*?var\(--tt-limits-label-w\)/);
});

test("locale PR stays scoped away from silent auto update flags", () => {
  const app = read("TokenTrackerBar/TokenTrackerBar/TokenTrackerBarApp.swift");
  const plist = read("TokenTrackerBar/TokenTrackerBar/Info.plist");
  const project = read("TokenTrackerBar/project.yml");

  assert.ok(app.includes("UpdateChecker.shared.check(silent: true)"));
  assert.doesNotMatch(app, /TokenTrackerEnableSilentAutoUpdate|isSilentAutoUpdateEnabled/);
  assert.doesNotMatch(plist, /TokenTrackerEnableSilentAutoUpdate/);
  assert.doesNotMatch(project, /TokenTrackerEnableSilentAutoUpdate/);
});

test("profile footer labels the start date instead of a leaderboard rank", () => {
  const expectedLabels = {
    zh: "开始使用",
    "zh-TW": "開始使用",
    ja: "開始日",
    ko: "시작일",
    de: "Beginn",
  };

  for (const [locale, expectedLabel] of Object.entries(expectedLabels)) {
    const core = JSON.parse(read(`dashboard/src/content/i18n/${locale}/core.json`));
    assert.equal(core["identity_card.rank_label"], expectedLabel);
  }
});

test("zh locale uses reviewed natural copy for settings and dashboard", () => {
  const core = read("dashboard/src/content/i18n/zh/core.json");
  const dashboard = read("dashboard/src/content/i18n/zh/dashboard.json");

  assert.match(core, /"identity_card\.rank_label":\s*"开始使用"/);
  assert.match(core, /"widgets\.heatmap\.description":\s*"像 GitHub 一样，一眼看清活跃和空闲的日子。"/);
  assert.match(core, /"widgets\.topModels\.name":\s*"热门模型"/);
  assert.match(core, /"daily\.sort\.conversations\.label":\s*"对话数"/);
  assert.match(core, /"settings\.account\.githubUrl":\s*"GitHub 主页"/);

  assert.doesNotMatch(core, /顶级模特|转化次数|InsForge 可以摄取您的队列|斑点条纹和安静的日子一目了然/);
  assert.doesNotMatch(dashboard, /型号分解|动态的|复制的|编码剂|2025 包裹/);
});

test("language selector localizes the German option in every translated locale", () => {
  const expectedLabels = {
    zh: "德语",
    "zh-TW": "德語",
    ja: "ドイツ語",
    ko: "독일어",
    de: "Deutsch",
  };

  for (const [locale, expectedLabel] of Object.entries(expectedLabels)) {
    const core = JSON.parse(read(`dashboard/src/content/i18n/${locale}/core.json`));
    assert.equal(core["settings.appearance.language.german"], expectedLabel);
  }
});

test("token number display setting is localized in every translated locale", () => {
  const localeFiles = ["zh", "zh-TW", "ja", "ko", "de"];
  const keys = [
    "settings.appearance.token_format.label",
    "settings.appearance.token_format.hint",
    "settings.appearance.token_format.compact",
    "settings.appearance.token_format.full",
  ];

  for (const locale of localeFiles) {
    const core = JSON.parse(read(`dashboard/src/content/i18n/${locale}/core.json`));
    for (const key of keys) {
      assert.equal(typeof core[key], "string", `${locale} missing ${key}`);
      assert.ok(core[key].trim().length > 0, `${locale} has empty ${key}`);
    }
  }
});

test("Dynamic Island expand-on-hover setting is localized in every translated locale", () => {
  const copyCsv = read("dashboard/src/content/copy.csv");
  assert.match(
    copyCsv,
    /^settings\.labs\.island_expand_on_hover\.label,.*"Expand on Hover"/m,
  );
  assert.match(
    copyCsv,
    /^settings\.labs\.island_expand_on_hover\.hint,.*"Open the full Dynamic Island panel immediately on hover\. When off, hovering peeks the edge and clicking expands\."/m,
  );
  assert.match(
    copyCsv,
    /^settings\.labs\.island_expand_on_hover\.aria,.*"Toggle expand Dynamic Island on hover"/m,
  );

  const localeFiles = ["zh", "zh-TW", "ja", "ko", "de"];
  const keys = [
    "settings.labs.island_expand_on_hover.label",
    "settings.labs.island_expand_on_hover.hint",
    "settings.labs.island_expand_on_hover.aria",
  ];

  for (const locale of localeFiles) {
    const dashboard = JSON.parse(read(`dashboard/src/content/i18n/${locale}/dashboard.json`));
    for (const key of keys) {
      assert.equal(typeof dashboard[key], "string", `${locale} missing ${key}`);
      assert.ok(dashboard[key].trim().length > 0, `${locale} has empty ${key}`);
    }
  }
});
