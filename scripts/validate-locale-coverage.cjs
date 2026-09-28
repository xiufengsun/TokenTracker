#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const COPY_PATH = path.join(ROOT, "dashboard", "src", "content", "copy.csv");
const I18N_ROOT = path.join(ROOT, "dashboard", "src", "content", "i18n");
const LOCALES = ["zh", "zh-TW"];
const LOCALE_FILES = ["core.json", "dashboard.json", "marketing.json"];
const REQUIRED_COLUMNS = ["key", "module", "page", "component", "slot", "text"];

// These values are deliberately language-neutral: commands, URLs, product
// and model names, protocol abbreviations, or formatting-only labels. Keep
// this key-based so a newly added English sentence cannot silently pass.
const SOURCE_IDENTICAL_KEY_ALLOWLIST = [
  /^landing[.]install[.]command$/,
  /^(landing|share)[.]meta[.]/,
  /^landing[.]cta[.]secondary$/,
  /^landing[.]v2[.]hero[.]title_line2$/,
  /^landing[.]v2[.]install[.]os_/,
  /^landing[.]v2[.]nav[.]github$/,
  /^heatmap[.]legend[.]utc$/,
  /^leaderboard[.]range(?:_loading)?$/,
  /^leaderboard[.]column[.]/,
  /^leaderboard[.]community[.]modal[.]global_spend_detail$/,
  /^leaderboard[.]community[.]modal[.]platform[.]/,
  /^dashboard[.]install[.]cmd[.]/,
  /^settings[.]menubar[.]iconStyle[.](?:clawd|bot)$/,
  /^settings[.]menubar[.]updates[.]footerCore$/,
  /^limits[.]provider[.]/,
  /^limits[.]agentPlan[.]setupHint[.]snippet_install$/,
  /^limits[.]commandCode[.]setupHint[.]snippet_(?:login|login_windows|env_windows|read|export|setenv)$/,
  /^provider[.]display[.](?:omp|omo|minimax_code|deepseek_harness|cline)$/,
  /^limits[.]label[.](?:cursor_api|zcode_glm52|zcode_glm5t|claude_opus|codex_spark_[57][hd]|gemini_(?:pro|flash|lite)|antigravity_)/,
  /^skills[.]mode[.]skillssh$/,
  /^skills[.]repo[.]placeholder$/,
  /^ipcheck[.]props[.]asn$/,
  /^ipcheck[.]security[.](?:vpn|tor)$/,
  /^shared[.]app_name$/,
  /^pet[.]character[.](?:clawd|bot|sprout|byte|ember)$/,
];

// Developer-facing product terms stay in English in Chinese UI copy. Scope
// each rule by copy key so ordinary Chinese words outside that product
// concept remain valid.
const PRODUCT_TERMINOLOGY_GLOSSARY = [
  {
    term: "Skill",
    translatedTerm: /技能/u,
    sourceIdentical: /^Skills?$/i,
    keyPatterns: [
      /^nav[.]skills$/,
      /^skills[.]/,
      /^sessions[.]card[.]context_tooltip$/,
      /^dashboard[.]context_breakdown[.](?:system_prefix_tooltip|category[.]skills)$/,
      /^cmdk[.](?:placeholder|group[.]skills)$/,
    ],
  },
  {
    term: "Agent",
    translatedTerm: /智能体|智慧代理/u,
    sourceIdentical: /^(?:Agent|Agents|Sub-agent)$/i,
    keyPatterns: [
      /^skills[.]/,
      /^sessions[.]card[.]subagents$/,
      /^dashboard[.]context_breakdown[.]category[.]custom_agents$/,
      /^landing[.]v3[.](?:tools[.]count|how[.]step1[.]title|how[.]step4[.]body|cap[.]title)$/,
    ],
  },
  {
    term: "Provider",
    translatedTerm: /服务商|服務商/u,
    sourceIdentical: /^Providers?$/i,
    keyPatterns: [
      /(?:^|[.])providers?(?:[.]|$)/,
      /^dashboard[.]device_card[.]account_scope_tip$/,
      /^landing[.]v3[.]cap[.]limits[.]body$/,
    ],
  },
  {
    term: "Star",
    translatedTerm: /加星|星标|星標/u,
    sourceIdentical: /^Star$/i,
    keyPatterns: [
      /^shared[.]github[.]star$/,
    ],
  },
  {
    term: "Prompt",
    translatedTerm: /提示词|提示詞/u,
    sourceIdentical: /^Prompt$/i,
    keyPatterns: [
      /(?:^|[._])prompt(?:[._]|$)/,
      /^sessions[.]card[.]privacy$/,
      /^usage[.]overview[.]antigravity_notice_body$/,
      /^dashboard[.]context_breakdown[.]system_prefix_tooltip$/,
      /^landing[.]v2[.]distill[.]body$/,
      /^landing[.]v3[.]privacy[.](?:title|p2)$/,
    ],
  },
  {
    term: "Hook",
    translatedTerm: /钩子|鉤子/u,
    sourceIdentical: /^Hook$/i,
    keyPatterns: [/^landing[.]v3[.]how[.]step2[.]title$/],
  },
  {
    term: "Core",
    translatedTerm: /核心/u,
    sourceIdentical: /^Core$/i,
    keyPatterns: [/^settings[.]menubar[.]updates[.]footer(?:Core|Combined)$/],
  },
  {
    term: "App",
    translatedTerm: /应用(?:程序)?|應用(?:程式)?/u,
    sourceIdentical: /^(?:App|Mac app)$/i,
    keyPatterns: [
      /^local_only[.]/,
      /^limits[.]opencodeGo[.]setupHint[.](?:note_app|step2_cookie)$/,
      /^pet[.](?:codex[.]subtitle|controls[.]native_only)$/,
      /^settings[.]section[.]menubar$/,
      /^widgets[.]cta[.]download$/,
    ],
  },
];

// Dashboard is ordinary interface vocabulary in this product and should be
// localized as “仪表板” / “儀表板” rather than preserved in English.
const UNLOCALIZED_UI_TERM_REGEX = /\bdashboard\b/i;

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
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
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (!row.every((cell) => String(cell).trim() === "")) rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  row.push(field);
  if (!row.every((cell) => String(cell).trim() === "")) rows.push(row);
  return rows;
}

function readCopyRegistry(copyPath = COPY_PATH) {
  const rows = parseCsv(fs.readFileSync(copyPath, "utf8"));
  const header = rows[0]?.map((cell) => String(cell).trim()) || [];
  const missingColumns = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missingColumns.length) {
    throw new Error(`Copy registry missing columns: ${missingColumns.join(", ")}`);
  }

  const index = Object.fromEntries(header.map((column, position) => [column, position]));
  const records = rows.slice(1).flatMap((cells, rowIndex) => {
    const key = String(cells[index.key] || "").trim();
    if (!key) return [];
    return [{
      key,
      module: String(cells[index.module] || "").trim(),
      page: String(cells[index.page] || "").trim(),
      text: String(cells[index.text] ?? "").trim(),
      row: rowIndex + 2,
    }];
  });
  if (!records.length) {
    throw new Error(`Copy registry has no entries: ${copyPath}`);
  }
  return records;
}

function readLocale(locale) {
  const values = new Map();
  const duplicateKeys = [];

  const parseJsonStrict = (text, context) => {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in ${context}: ${error.message}`);
    }
  };

  for (const filename of LOCALE_FILES) {
    const relativePath = path.join(locale, filename);
    const filePath = path.join(I18N_ROOT, relativePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseJsonStrict(raw, relativePath);
    const fileKeys = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*"((?:\\.|[^"\\])+)"\s*:/.exec(line);
      if (!match) continue;
      const key = parseJsonStrict(`"${match[1]}"`, `${relativePath} key literal`);
      if (fileKeys.has(key)) duplicateKeys.push(`${key} (${relativePath}, repeated)`);
      fileKeys.add(key);
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (values.has(key)) {
        duplicateKeys.push(`${key} (${values.get(key).file}, ${relativePath})`);
      }
      values.set(key, { value, file: relativePath });
    }
  }

  return { values, duplicateKeys };
}

function groupByPage(records) {
  const groups = new Map();
  for (const record of records) {
    const group = `${record.module}/${record.page}`;
    const values = groups.get(group) || [];
    values.push(record.key);
    groups.set(group, values);
  }
  return groups;
}

function printGrouped(label, records) {
  if (!records.length) return;
  console.error(`${label} (${records.length}):`);
  for (const [group, keys] of groupByPage(records)) {
    console.error(`- ${group}: ${keys.join(", ")}`);
  }
}

function placeholders(value) {
  return [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

function samePlaceholders(left, right) {
  return JSON.stringify(placeholders(left)) === JSON.stringify(placeholders(right));
}

function isAllowedSourceIdentical(record) {
  if (SOURCE_IDENTICAL_KEY_ALLOWLIST.some((pattern) => pattern.test(record.key))) return true;
  const sourceText = record.text.trim();
  return PRODUCT_TERMINOLOGY_GLOSSARY.some((entry) => (
    entry.keyPatterns.some((pattern) => pattern.test(record.key)) &&
    entry.sourceIdentical.test(sourceText)
  ));
}

function hasUnlocalizedUiTerm(record, localized) {
  const visibleText = String(localized)
    .replace(/\{\{\w+\}\}/g, "")
    .replace(/https?:\/\/\S+/g, "");
  return UNLOCALIZED_UI_TERM_REGEX.test(visibleText);
}

function findTerminologyViolations(record, localized) {
  return PRODUCT_TERMINOLOGY_GLOSSARY.filter((entry) => (
    entry.keyPatterns.some((pattern) => pattern.test(record.key)) &&
    entry.translatedTerm.test(String(localized))
  )).map((entry) => entry.term);
}

function main() {
  const showDetails = process.argv.includes("--details");
  const localeArg = process.argv.find((argument) => argument.startsWith("--locale="));
  const locales = localeArg ? [localeArg.slice("--locale=".length)] : LOCALES;
  const unknownLocales = locales.filter((locale) => !LOCALES.includes(locale));
  if (unknownLocales.length) {
    throw new Error(`Unsupported locale: ${unknownLocales.join(", ")}`);
  }
  const registry = readCopyRegistry();
  const registryByKey = new Map(registry.map((record) => [record.key, record]));
  let failed = false;

  for (const locale of locales) {
    const { values, duplicateKeys } = readLocale(locale);
    const missing = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      return typeof localized !== "string" || localized.trim() === "";
    });
    const extra = [...values.keys()].filter((key) => !registryByKey.has(key));
    const placeholderMismatches = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      return typeof localized === "string" && !samePlaceholders(record.text, localized);
    });
    const identicalText = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      const fixedText = record.text.replace(/\{\{\w+\}\}/g, "");
      return (
        localized === record.text &&
        /[A-Za-z]{2,}/.test(fixedText) &&
        !isAllowedSourceIdentical(record)
      );
    });
    const mixedUnlocalizedText = registry.filter((record) => {
      const localized = values.get(record.key)?.value;
      return typeof localized === "string" && hasUnlocalizedUiTerm(record, localized);
    });
    const terminologyViolations = registry.flatMap((record) => {
      const localized = values.get(record.key)?.value;
      if (typeof localized !== "string") return [];
      return findTerminologyViolations(record, localized).map((term) => ({ record, term }));
    });

    console.log(
      `${locale}: ${registry.length - missing.length}/${registry.length} copy keys localized ` +
        `(${((registry.length - missing.length) / registry.length * 100).toFixed(1)}%).`,
    );

    if (duplicateKeys.length) {
      failed = true;
      console.error(`${locale} duplicate keys (${duplicateKeys.length}):`);
      duplicateKeys.forEach((entry) => console.error(`- ${entry}`));
    }
    if (extra.length) {
      failed = true;
      console.error(`${locale} keys absent from copy.csv (${extra.length}):`);
      extra.forEach((key) => console.error(`- ${key}`));
    }
    if (missing.length) {
      failed = true;
      printGrouped(`${locale} missing translations`, missing);
      if (showDetails) {
        console.error(`${locale} source text:`);
        missing.forEach((record) => console.error(`- ${record.key} = ${JSON.stringify(record.text)}`));
      }
    }
    if (placeholderMismatches.length) {
      failed = true;
      console.error(`${locale} placeholder mismatches (${placeholderMismatches.length}):`);
      placeholderMismatches.forEach((record) => {
        const localized = values.get(record.key).value;
        console.error(
          `- ${record.key}: source=${JSON.stringify(placeholders(record.text))} ` +
            `localized=${JSON.stringify(placeholders(localized))}`,
        );
      });
    }
    if (identicalText.length) {
      failed = true;
      console.error(`${locale} source-identical UI text (${identicalText.length}):`);
      identicalText.forEach((record) => console.error(`- ${record.key} = ${JSON.stringify(record.text)}`));
    }
    if (mixedUnlocalizedText.length) {
      failed = true;
      console.error(`${locale} mixed untranslated UI terms (${mixedUnlocalizedText.length}):`);
      mixedUnlocalizedText.forEach((record) => {
        console.error(`- ${record.key} = ${JSON.stringify(values.get(record.key).value)}`);
      });
    }
    if (terminologyViolations.length) {
      failed = true;
      console.error(`${locale} product terminology violations (${terminologyViolations.length}):`);
      terminologyViolations.forEach(({ record, term }) => {
        console.error(
          `- ${record.key}: preserve ${term} in ${JSON.stringify(values.get(record.key).value)}`,
        );
      });
    }
  }

  if (failed) process.exit(1);
  console.log("Chinese locale coverage ok.");
}

if (require.main === module) main();

module.exports = {
  PRODUCT_TERMINOLOGY_GLOSSARY,
  findTerminologyViolations,
  hasUnlocalizedUiTerm,
  isAllowedSourceIdentical,
  parseCsv,
  readCopyRegistry,
};
