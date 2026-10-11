const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function repoPath(relPath) {
  return path.join(__dirname, "..", relPath);
}

function readSource(relPath) {
  return fs.readFileSync(repoPath(relPath), "utf8");
}

test("UsageLimitsView renders Codex Reset Bank as native rows, not the old footnote path", () => {
  const source = readSource("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");

  assert.match(source, /case "codex"[\s\S]*let resetState = codexResetBankViewData\(limits\.codex\.resetCredits\)/);
  assert.match(source, /case "codex"[\s\S]*resetRows:\s*resetState\.rows/);
  assert.doesNotMatch(source, /footnote:\s*codexResetBankFootnote\(limits\.codex\.resetCredits\)/);
  assert.match(source, /private func resetSection\(/);
  assert.match(source, /Strings\.codexResetBankSectionTitle/);
  assert.match(source, /private func resetRow\(/);
  assert.match(source, /UsageLimitBar\(/);
});

test("Codex reset rows stay out of usage-window explanation content", () => {
  const source = readSource("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");

  assert.match(source, /LimitsExplainContent\(providerName: title, specs: specs, remainingMode:/);
  assert.doesNotMatch(source, /LimitsExplainContent\([^)]*resetRows/s);
  assert.doesNotMatch(source, /LimitWindowSpec\([^)]*Reset/s);
});

test("Codex reset row accessibility is reset-specific and does not announce quota percentages", () => {
  const source = readSource("TokenTrackerBar/TokenTrackerBar/Views/UsageLimitsView.swift");
  const resetRowMatch = source.match(/private func resetRow\([\s\S]*?(?=\n    private var|\n    private func displayPercentLabel)/);

  assert.ok(resetRowMatch, "resetRow source block should exist");
  const resetRowSource = resetRowMatch[0];
  assert.match(source, /Strings\.resetCreditAccessibility/);
  assert.match(source, /private static let rowColumnSpacing: CGFloat = 5/);
  assert.match(source, /private static let percentColumnWidth: CGFloat = 34/);
  assert.match(source, /private static let relativeResetColumnWidth: CGFloat = 24/);
  assert.match(source, /private var resetExpiryColumnWidth: CGFloat \{\s*Self\.percentColumnWidth \+ Self\.rowColumnSpacing \+ effectiveResetColumnWidth\s*\}/);
  assert.match(resetRowSource, /\.monospacedDigit\(\)/);
  assert.match(resetRowSource, /\.frame\(width: resetExpiryColumnWidth, alignment: \.trailing\)/);
  assert.doesNotMatch(resetRowSource, /displayPercentLabel/);
  assert.doesNotMatch(resetRowSource, /limitAccessibility/);
  assert.doesNotMatch(resetRowSource, /percent:\s*Int/);
});

test("native reset strings support labelled rows, minute expiry, and passive states", (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires xcrun swiftc on macOS");
    return;
  }
  const swiftc = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });
  if (swiftc.status !== 0) {
    t.skip("requires xcrun swiftc");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-reset-bank-native-"));
  const harnessPath = path.join(tempDir, "main.swift");
  const binaryPath = path.join(tempDir, "reset-bank-native");
  const widgetFixture = path.join(tempDir, "WidgetSnapshot.swift");
  const suiteName = "tokentracker.test." + path.basename(tempDir);
  const widgetSource = readSource("TokenTrackerBar/Shared/WidgetSnapshot.swift");
  assert.ok(widgetSource.includes('"group.com.tokentracker.bar"'));
  fs.writeFileSync(widgetFixture, widgetSource.replace('"group.com.tokentracker.bar"', JSON.stringify(suiteName)));

  fs.writeFileSync(harnessPath, String.raw`
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}

func requireEqual(_ actual: String?, _ expected: String, _ name: String) {
    if actual != expected {
        fail("\(name): expected \(expected), got \(actual ?? "nil")\n")
    }
}

func requireNil(_ actual: String?, _ name: String) {
    if actual != nil {
        fail("\(name): expected nil, got \(actual!)\n")
    }
}

func decodeResetCredits(_ resetCredits: Any?) throws -> CodexLimits.ResetCredits? {
    var codex: [String: Any] = ["configured": true]
    if let resetCredits {
        codex["reset_credits"] = resetCredits
    }
    let payload: [String: Any] = [
        "fetched_at": "2026-06-10T00:00:00Z",
        "claude": ["configured": false],
        "codex": codex,
        "cursor": ["configured": false],
        "gemini": ["configured": false],
        "kiro": ["configured": false],
        "antigravity": ["configured": false],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    return try JSONDecoder().decode(UsageLimitsResponse.self, from: data).codex.resetCredits
}

do {
    NativeLocalization.storePreference(NativeLocalization.englishLocale)
    defer {
        UserDefaults.standard.removeObject(forKey: NativeLocalization.preferenceKey)
        UserDefaults.standard.removePersistentDomain(forName: WidgetSharedConstants.appGroupIdentifier)
    }

    let date = ISO8601DateFormatter().date(from: "2026-07-01T02:13:21Z")!
    let expiry = Strings.codexResetBankExpiryDateTime(date)
    if expiry.range(of: #"\d{1,2}:13"#, options: .regularExpression) == nil {
        fail("expiry should include hour and minute, got \(expiry)\n")
    }
    if expiry.contains("2026") {
        fail("expiry should omit the year in the compact row label, got \(expiry)\n")
    }
    if expiry.range(of: #"AM|PM|上午|下午|오전|오후"#, options: .regularExpression) != nil {
        fail("expiry should use compact 24-hour time, got \(expiry)\n")
    }

    requireEqual(Strings.codexResetBankLabel(1), "Reset 1", "first reset label")
    requireEqual(Strings.codexResetBankLabel(2), "Reset 2", "second reset label")
    NativeLocalization.storePreference(NativeLocalization.chineseLocale)
    requireEqual(Strings.codexResetBankLabel(1), "重置 1", "simplified Chinese reset label")
    NativeLocalization.storePreference(NativeLocalization.traditionalChineseLocale)
    requireEqual(Strings.codexResetBankLabel(1), "重置 1", "traditional Chinese reset label")
    NativeLocalization.storePreference(NativeLocalization.japaneseLocale)
    requireEqual(Strings.codexResetBankLabel(1), "リセット 1", "Japanese reset label")
    NativeLocalization.storePreference(NativeLocalization.koreanLocale)
    requireEqual(Strings.codexResetBankLabel(1), "리셋 1", "Korean reset label")
    NativeLocalization.storePreference(NativeLocalization.englishLocale)

    let accessibility = Strings.resetCreditAccessibility(label: "Reset 1", expiry: expiry)
    if !accessibility.contains("Reset 1") || !accessibility.contains(expiry) {
        fail("accessibility should mention reset label and expiry, got \(accessibility)\n")
    }
    if accessibility.contains("%") {
        fail("accessibility should not mention a quota percentage, got \(accessibility)\n")
    }

    let zero = try decodeResetCredits(["available_count": 0, "credits": []])
    requireNil(Strings.codexResetBankPassiveStatus(zero), "zero reset credits")

    let countOnly = try decodeResetCredits(["available_count": 2, "credits": []])
    requireEqual(Strings.codexResetBankPassiveStatus(countOnly), Strings.codexResetBankCountOnly(2), "count-only reset credits")
    NativeLocalization.storePreference(NativeLocalization.chineseLocale)
    requireEqual(Strings.codexResetBankCountOnly(2), "重置权益：2 次 · 过期时间不可用", "simplified Chinese count-only reset credits")
    NativeLocalization.storePreference(NativeLocalization.traditionalChineseLocale)
    requireEqual(Strings.codexResetBankCountOnly(2), "重置權益：2 次 · 過期時間不可用", "traditional Chinese count-only reset credits")
    NativeLocalization.storePreference(NativeLocalization.japaneseLocale)
    requireEqual(Strings.codexResetBankCountOnly(2), "リセット：2 件 · 期限不明", "Japanese count-only reset credits")
    NativeLocalization.storePreference(NativeLocalization.koreanLocale)
    requireEqual(Strings.codexResetBankCountOnly(2), "리셋: 2회 · 만료일 없음", "Korean count-only reset credits")
    NativeLocalization.storePreference(NativeLocalization.englishLocale)
} catch {
    fail("Swift behavior harness failed: \(error)\n")
}
`, "utf8");

  try {
    const sources = [
      widgetFixture,
      repoPath("TokenTrackerBar/Shared/NativeLocalization.swift"),
      repoPath("TokenTrackerBar/Shared/NativeQAProfile.swift"),
      repoPath("TokenTrackerBar/TokenTrackerBar/Models/MenuBarDisplayPreferences.swift"),
      repoPath("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift"),
      repoPath("TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift"),
      harnessPath,
    ];
    const build = spawnSync("xcrun", ["swiftc", ...sources, "-o", binaryPath], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const run = spawnSync(binaryPath, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("native reset expiry uses compact locale-aware date and minute time without years", () => {
  const strings = readSource("TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift");
  const formatterMatch = strings.match(
    /static func codexResetBankExpiryDateTime\(_ date: Date\) -> String \{[\s\S]*?return formatter\.string\(from: date\)[\s\S]*?\n    \}/,
  );

  assert.ok(formatterMatch, "codexResetBankExpiryDateTime formatter should exist");
  assert.match(formatterMatch[0], /setLocalizedDateFormatFromTemplate\("MdHm"\)/);
  assert.doesNotMatch(formatterMatch[0], /dateStyle/);
  assert.doesNotMatch(formatterMatch[0], /timeStyle/);
});
