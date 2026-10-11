"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoPath = (relativePath) => path.join(__dirname, "..", relativePath);

test("native pet reset strings interpolate the supplied reset value", (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires macOS Swift runtime");
    return;
  }

  const swiftc = spawnSync("xcrun", ["--find", "swiftc"], { encoding: "utf8" });
  if (swiftc.status !== 0) {
    t.skip("requires xcrun swiftc");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-pet-reset-"));
  const harnessPath = path.join(tempDir, "main.swift");
  const binaryPath = path.join(tempDir, "pet-reset");
  const widgetFixture = path.join(tempDir, "WidgetSnapshot.swift");
  const suiteName = "tokentracker.test." + path.basename(tempDir);
  const widgetSource = fs.readFileSync(repoPath("TokenTrackerBar/Shared/WidgetSnapshot.swift"), "utf8");
  assert.ok(widgetSource.includes('"group.com.tokentracker.bar"'));
  fs.writeFileSync(widgetFixture, widgetSource.replace('"group.com.tokentracker.bar"', JSON.stringify(suiteName)));
  const value = "8/12 05:09";

  fs.writeFileSync(
    harnessPath,
    `import Foundation

var failures: [String] = []

func requireEqual(_ actual: String, _ expected: String, _ locale: String) {
    if actual != expected {
        failures.append("\\(locale): expected \\(expected), got \\(actual)")
    }
}

let value = "${value}"
let cost = "$1.23"
let sharedDefaults = UserDefaults(suiteName: WidgetSharedConstants.appGroupIdentifier)
let originalStandardPreference = UserDefaults.standard.object(forKey: NativeLocalization.preferenceKey)
let originalSharedPreference = sharedDefaults?.object(forKey: NativeLocalization.preferenceKey)
func restorePreferences() {
    if let originalStandardPreference {
        UserDefaults.standard.set(originalStandardPreference, forKey: NativeLocalization.preferenceKey)
    } else {
        UserDefaults.standard.removeObject(forKey: NativeLocalization.preferenceKey)
    }
    if let originalSharedPreference {
        sharedDefaults?.set(originalSharedPreference, forKey: NativeLocalization.preferenceKey)
    } else {
        sharedDefaults?.removeObject(forKey: NativeLocalization.preferenceKey)
    }
}
defer { UserDefaults.standard.removePersistentDomain(forName: WidgetSharedConstants.appGroupIdentifier) }
defer { restorePreferences() }
let cases = [
    (NativeLocalization.englishLocale, "in \\(value)", "\\(cost) today"),
    (NativeLocalization.chineseLocale, "\\(value)后重置", "今日 \\(cost)"),
    (NativeLocalization.traditionalChineseLocale, "\\(value)後重置", "今日 \\(cost)"),
    (NativeLocalization.japaneseLocale, "\\(value)でリセット", "今日 \\(cost)"),
    (NativeLocalization.koreanLocale, "\\(value) 후 초기화", "오늘 \\(cost)"),
]

for (locale, expected, expectedCost) in cases {
    NativeLocalization.storePreference(locale)
    requireEqual(Strings.petLimitReset(value), expected, locale)
    requireEqual(Strings.petCostToday(cost), expectedCost, "\\(locale) cost")
}
if !failures.isEmpty {
    restorePreferences()
    FileHandle.standardError.write(Data(failures.joined(separator: "\\n").appending("\\n").utf8))
    exit(1)
}
`,
    "utf8",
  );

  try {
    const build = spawnSync(
      "xcrun",
      [
        "swiftc",
        widgetFixture,
        repoPath("TokenTrackerBar/Shared/NativeLocalization.swift"),
        repoPath("TokenTrackerBar/Shared/NativeQAProfile.swift"),
        repoPath("TokenTrackerBar/TokenTrackerBar/Models/MenuBarDisplayPreferences.swift"),
        repoPath("TokenTrackerBar/TokenTrackerBar/Models/UsageLimits.swift"),
        repoPath("TokenTrackerBar/TokenTrackerBar/Utilities/Strings.swift"),
        harnessPath,
        "-o",
        binaryPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const run = spawnSync(binaryPath, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
