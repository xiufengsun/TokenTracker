import React from "react";
import { Info, Languages, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../../hooks/useTheme.js";
import { useLocale } from "../../hooks/useLocale.js";
import { useCurrency } from "../../hooks/useCurrency.js";
import { useOverviewPeriodPref } from "../../hooks/use-overview-period-pref.js";
import { useTokenFormat } from "../../hooks/useTokenFormat.js";
import { DE_LOCALE, EN_LOCALE, JA_LOCALE, KO_LOCALE, SYSTEM_LOCALE, ZH_CN_LOCALE, ZH_TW_LOCALE } from "../../lib/locale";
import { CURRENCY_USD, getSupportedCurrencies } from "../../lib/currency";
import { copy } from "../../lib/copy";
import { OVERVIEW_PERIODS } from "../../lib/overview-period-pref.js";
import { TOKEN_FORMAT_MODES, TOKEN_GROUPINGS, TOKEN_UNIT_SYSTEMS } from "../../lib/token-format.js";
import { Select } from "../../ui/components";
import { SectionCard, SegmentedControl, SettingsRow } from "./Controls.jsx";

function buildThemeOptions() {
  return [
    { value: "light", label: copy("settings.appearance.theme.light"), Icon: Sun },
    { value: "dark", label: copy("settings.appearance.theme.dark"), Icon: Moon },
    { value: "system", label: copy("settings.appearance.theme.system"), Icon: Monitor },
  ];
}

function buildLanguageOptions() {
  return [
    { value: SYSTEM_LOCALE, label: copy("settings.appearance.language.system") },
    { value: EN_LOCALE, label: copy("settings.appearance.language.english") },
    { value: ZH_CN_LOCALE, label: copy("settings.appearance.language.chinese") },
    { value: ZH_TW_LOCALE, label: copy("settings.appearance.language.traditional_chinese") },
    { value: JA_LOCALE, label: copy("settings.appearance.language.japanese") },
    { value: KO_LOCALE, label: copy("settings.appearance.language.korean") },
    { value: DE_LOCALE, label: copy("settings.appearance.language.german") },
  ];
}

function formatUpdatedAt(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString();
  } catch {
    return null;
  }
}

function buildSourceTooltip(rateSource, rateFetchedAt) {
  const source = copy(`settings.appearance.currency.rate_source.${rateSource}`);
  const updatedAt = formatUpdatedAt(rateFetchedAt);
  const when = updatedAt
    ? copy("settings.appearance.currency.rate_updated", { when: updatedAt })
    : copy("settings.appearance.currency.rate_never");
  return `${source} · ${when}`;
}

function LanguageDropdown({ locale, setLocale }) {
  const options = buildLanguageOptions();
  return (
    <Select
      value={locale}
      onValueChange={setLocale}
      options={options}
      ariaLabel={copy("settings.appearance.language.label")}
      className="px-2.5 py-1.5 text-xs font-medium"
      leadingIcon={
        <Languages
          className="h-3.5 w-3.5 text-oai-gray-500 dark:text-oai-gray-400"
          aria-hidden
        />
      }
    />
  );
}

function CurrencyDropdown({ currency, setCurrency }) {
  const options = getSupportedCurrencies().map((opt) => ({
    value: opt.code,
    label: copy(opt.labelKey),
  }));
  return (
    <Select
      value={currency}
      onValueChange={setCurrency}
      options={options}
      ariaLabel={copy("settings.appearance.currency.label")}
      className="px-3 py-1.5 text-xs font-medium"
    />
  );
}

function CurrencyHint({ currency, rate, rateSource, rateFetchedAt }) {
  if (currency === CURRENCY_USD) {
    return <>{copy("settings.appearance.currency.hint")}</>;
  }
  const tooltip = buildSourceTooltip(rateSource, rateFetchedAt);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{`1 USD = ${rate.toFixed(4)} ${currency}`}</span>
      <span
        role="img"
        aria-label={tooltip}
        title={tooltip}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center text-oai-gray-400 hover:text-oai-gray-600 dark:text-oai-gray-500 dark:hover:text-oai-gray-300"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </span>
    </span>
  );
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useLocale();
  const { currency, rate, rateSource, rateFetchedAt, setCurrency } = useCurrency();
  const {
    mode: tokenFormatMode,
    setMode: setTokenFormatMode,
    unitSystem: tokenUnitSystem,
    setUnitSystem: setTokenUnitSystem,
    grouping: tokenGrouping,
    setGrouping: setTokenGrouping,
  } = useTokenFormat();
  const { period: overviewPeriod, setOverviewPeriod } = useOverviewPeriodPref();

  return (
    <SectionCard title={copy("settings.section.appearance")}>
      <SettingsRow
        label={copy("settings.appearance.theme.label")}
        hint={copy("settings.appearance.theme.hint")}
        control={<SegmentedControl options={buildThemeOptions()} value={theme} onChange={setTheme} />}
      />
      <SettingsRow
        label={copy("settings.appearance.overview_period.label")}
        hint={copy("settings.appearance.overview_period.hint")}
        control={
          <SegmentedControl
            options={OVERVIEW_PERIODS.map((period) => ({
              value: period,
              label: copy(`usage.period.${period}`),
            }))}
            value={overviewPeriod}
            onChange={setOverviewPeriod}
          />
        }
      />
      <SettingsRow
        label={copy("settings.appearance.language.label")}
        hint={copy("settings.appearance.language.hint")}
        control={<LanguageDropdown locale={locale} setLocale={setLocale} />}
      />
      <SettingsRow
        label={copy("settings.appearance.currency.label")}
        hint={
          <CurrencyHint
            currency={currency}
            rate={rate}
            rateSource={rateSource}
            rateFetchedAt={rateFetchedAt}
          />
        }
        control={<CurrencyDropdown currency={currency} setCurrency={setCurrency} />}
      />
      <SettingsRow
        label={copy("settings.appearance.token_format.label")}
        hint={copy("settings.appearance.token_format.hint")}
        control={
          <SegmentedControl
            options={[
              {
                value: TOKEN_FORMAT_MODES.COMPACT,
                label: copy("settings.appearance.token_format.compact"),
              },
              {
                value: TOKEN_FORMAT_MODES.FULL,
                label: copy("settings.appearance.token_format.full"),
              },
            ]}
            value={tokenFormatMode}
            onChange={setTokenFormatMode}
          />
        }
      />
      <SettingsRow
        label={copy("settings.appearance.token_unit.label")}
        hint={copy("settings.appearance.token_unit.hint")}
        control={
          <SegmentedControl
            disabled={tokenFormatMode !== TOKEN_FORMAT_MODES.COMPACT}
            options={[
              {
                value: TOKEN_UNIT_SYSTEMS.ENGLISH,
                label: copy("settings.appearance.token_unit.english"),
              },
              {
                value: TOKEN_UNIT_SYSTEMS.CHINESE,
                label: copy("settings.appearance.token_unit.chinese"),
              },
            ]}
            value={tokenUnitSystem}
            onChange={setTokenUnitSystem}
          />
        }
      />
      <SettingsRow
        label={copy("settings.appearance.token_grouping.label")}
        hint={copy("settings.appearance.token_grouping.hint")}
        control={
          <SegmentedControl
            options={[
              {
                value: TOKEN_GROUPINGS.THOUSAND,
                label: copy("settings.appearance.token_grouping.thousand"),
              },
              {
                value: TOKEN_GROUPINGS.WAN,
                label: copy("settings.appearance.token_grouping.wan"),
              },
            ]}
            value={tokenGrouping}
            onChange={setTokenGrouping}
          />
        }
      />
    </SectionCard>
  );
}
