import React from "react";
import { FlaskConical, Gauge, Globe, Monitor, Palette, Settings, UserRound } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { LimitsSettingsPanel } from "../components/LimitsSettingsPanel.jsx";
import { AccountSection } from "../components/settings/AccountSection.jsx";
import { AppearanceSection } from "../components/settings/AppearanceSection.jsx";
import { LabsSection } from "../components/settings/LabsSection.jsx";
import {
  SectionCard,
  SegmentedControl,
  SettingsRow,
  ToggleSwitch,
} from "../components/settings/Controls.jsx";
import { MenuBarSection, NativeAppFooter } from "../components/settings/MenuBarSection.jsx";
import { NetworkSection } from "../components/settings/NetworkSection.jsx";
import { LIMIT_DISPLAY_MODES, useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { useNativeSettings } from "../hooks/use-native-settings.js";
import { useProxySettings } from "../hooks/use-proxy-settings.js";
import { cn } from "../lib/cn";
import { copy } from "../lib/copy";

const SETTINGS_SECTION_IDS = {
  APPEARANCE: "appearance",
  NATIVE_APP: "native-app",
  NETWORK: "network",
  ACCOUNT: "account",
  LIMITS: "limits",
  LABS: "labs",
};

const SETTINGS_GROUP_IDS = {
  PERSONAL: "personal",
  APP: "app",
  DEVELOPER: "developer",
};

function LimitsDisplayModeControl({ prefs }) {
  return (
    <SegmentedControl
      options={[
        { value: LIMIT_DISPLAY_MODES.USED, label: copy("limits.settings.display_mode_used") },
        { value: LIMIT_DISPLAY_MODES.REMAINING, label: copy("limits.settings.display_mode_remaining") },
      ]}
      value={prefs.displayMode}
      onChange={prefs.setDisplayMode}
    />
  );
}

export function SettingsPage() {
  const limitsPrefs = useLimitsDisplayPrefs();
  const {
    available: nativeSettingsAvailable,
    settings: nativeSettings,
    setSetting: setNativeSetting,
  } = useNativeSettings();
  const proxySettings = useProxySettings();
  const { available: proxySettingsAvailable } = proxySettings;
  const toastOnReset = nativeSettings?.toastOnReset !== false;
  const confettiOnReset = nativeSettings?.confettiOnReset !== false;
  const windowsNativeSettings = nativeSettings?.platform === "windows";
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedSection = searchParams.get("section");
  const requestedSectionAvailable =
    Object.values(SETTINGS_SECTION_IDS).includes(requestedSection) &&
    (requestedSection !== SETTINGS_SECTION_IDS.NATIVE_APP || nativeSettingsAvailable) &&
    (requestedSection !== SETTINGS_SECTION_IDS.NETWORK || proxySettingsAvailable);
  const activeSection = requestedSectionAvailable
    ? requestedSection
    : SETTINGS_SECTION_IDS.APPEARANCE;

  const selectSection = (section) => {
    const next = new URLSearchParams(searchParams);
    if (section === SETTINGS_SECTION_IDS.APPEARANCE) {
      next.delete("section");
    } else {
      next.set("section", section);
    }
    setSearchParams(next, { replace: true });
  };

  const sections = [
    {
      id: SETTINGS_SECTION_IDS.APPEARANCE,
      label: copy("settings.section.appearance"),
      description: copy("settings.section.appearance.description"),
      group: SETTINGS_GROUP_IDS.PERSONAL,
      Icon: Palette,
      content: <AppearanceSection />,
    },
    ...(nativeSettingsAvailable
      ? [{
          id: SETTINGS_SECTION_IDS.NATIVE_APP,
          label: copy("settings.section.menubar"),
          description: copy("settings.section.menubar.description"),
          group: SETTINGS_GROUP_IDS.APP,
          Icon: Monitor,
          content: <MenuBarSection />,
        }]
      : []),
    ...(proxySettingsAvailable
      ? [{
          id: SETTINGS_SECTION_IDS.NETWORK,
          label: copy("settings.section.network"),
          description: copy("settings.section.network.description"),
          group: SETTINGS_GROUP_IDS.APP,
          Icon: Globe,
          content: <NetworkSection proxySettings={proxySettings} />,
        }]
      : []),
    {
      id: SETTINGS_SECTION_IDS.ACCOUNT,
      label: copy("settings.section.account"),
      description: copy("settings.section.account.description"),
      group: SETTINGS_GROUP_IDS.PERSONAL,
      Icon: UserRound,
      content: <AccountSection />,
    },
    {
      id: SETTINGS_SECTION_IDS.LIMITS,
      label: copy("settings.section.limits"),
      description: copy("settings.section.limits.description"),
      group: SETTINGS_GROUP_IDS.APP,
      Icon: Gauge,
      content: (
        <div className="space-y-4">
          <SectionCard title={copy("settings.section.limits")}>
            <SettingsRow
              label={copy("limits.settings.display_mode_label")}
              control={<LimitsDisplayModeControl prefs={limitsPrefs} />}
            />
            {!windowsNativeSettings ? (
              <>
                <SettingsRow
                  label={copy("settings.menubar.toastOnReset")}
                  hint={copy("settings.menubar.toastOnResetHint")}
                  control={
                    <ToggleSwitch
                      checked={toastOnReset}
                      disabled={!nativeSettingsAvailable}
                      onChange={() => setNativeSetting("toastOnReset", !toastOnReset)}
                      ariaLabel={copy("settings.menubar.toastOnReset")}
                    />
                  }
                />
                <SettingsRow
                  label={copy("settings.menubar.confettiOnReset")}
                  hint={copy("settings.menubar.confettiOnResetHint")}
                  control={
                    <ToggleSwitch
                      checked={confettiOnReset}
                      disabled={!nativeSettingsAvailable}
                      onChange={() => setNativeSetting("confettiOnReset", !confettiOnReset)}
                      ariaLabel={copy("settings.menubar.confettiOnReset")}
                    />
                  }
                />
              </>
            ) : null}
            <SettingsRow
              label={copy("settings.limits.showSubscriptions")}
              hint={copy("settings.limits.showSubscriptionsHint")}
              control={
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => navigate("/limits?openSubscriptions=1")}
                    aria-label={copy("limits.page.openSubscriptions")}
                    title={copy("limits.page.openSubscriptions")}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-oai-gray-200 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-900 text-oai-gray-500 dark:text-oai-gray-400 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
                  >
                    <Settings size={14} aria-hidden />
                  </button>
                  <ToggleSwitch
                    checked={limitsPrefs.showSubscriptions !== false}
                    onChange={() => limitsPrefs.setShowSubscriptions(!limitsPrefs.showSubscriptions)}
                    ariaLabel={copy("settings.limits.showSubscriptions")}
                  />
                </div>
              }
            />
          </SectionCard>
          <SectionCard title={copy("settings.limits.providers")}>
            <LimitsSettingsPanel prefs={limitsPrefs} />
          </SectionCard>
        </div>
      ),
    },
    {
      id: SETTINGS_SECTION_IDS.LABS,
      label: copy("settings.section.labs"),
      description: copy("settings.section.labs.description"),
      group: SETTINGS_GROUP_IDS.DEVELOPER,
      Icon: FlaskConical,
      content: <LabsSection />,
    },
  ];

  const sectionGroups = [
    {
      id: SETTINGS_GROUP_IDS.PERSONAL,
      label: copy("settings.nav.group.personal"),
    },
    {
      id: SETTINGS_GROUP_IDS.APP,
      label: copy("settings.nav.group.app"),
    },
    {
      id: SETTINGS_GROUP_IDS.DEVELOPER,
      label: copy("settings.nav.group.developer"),
    },
  ]
    .map((group) => ({
      ...group,
      sections: sections.filter((section) => section.group === group.id),
    }))
    .filter((group) => group.sections.length > 0);

  let activeSectionMeta = sections[0];
  for (const section of sections) {
    if (section.id === activeSection) {
      activeSectionMeta = section;
      break;
    }
  }

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-12 pt-8 sm:pb-16 sm:pt-10">
        <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
          <div className="mb-7 max-w-2xl">
            <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
              {copy("settings.page.title")}
            </h1>
            <p className="mt-2 text-sm leading-6 text-oai-gray-500 dark:text-oai-gray-400 sm:text-base">
              {copy("settings.page.subtitle")}
            </p>
          </div>

          <div className="grid min-w-0 gap-6 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
            <aside className="min-w-0 rounded-xl border border-oai-gray-200 bg-oai-gray-50/70 p-2 dark:border-oai-gray-800 dark:bg-oai-gray-900/60 md:border-0 md:bg-transparent md:p-0 md:dark:bg-transparent">
              <nav
                aria-label={copy("settings.page.title")}
                className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:sticky md:top-6 md:flex-col md:gap-4 md:overflow-visible"
              >
                {sectionGroups.map(({ id: groupId, label: groupLabel, sections: groupSections }) => (
                  <div key={groupId} className="flex shrink-0 gap-1 md:block">
                    <div className="hidden px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-oai-gray-400 dark:text-oai-gray-500 md:block">
                      {groupLabel}
                    </div>
                    <div className="flex gap-1 md:flex-col">
                      {groupSections.map(({ id, label, Icon }) => {
                        const active = activeSection === id;
                        return (
                          <button
                            key={id}
                            id={`settings-nav-${id}`}
                            type="button"
                            aria-current={active ? "page" : undefined}
                            aria-controls={`settings-panel-${id}`}
                            onClick={() => selectSection(id)}
                            className={cn(
                              "relative inline-flex min-h-10 min-w-max shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 md:w-full md:min-w-0",
                              active
                                ? "bg-white text-oai-black shadow-sm ring-1 ring-oai-gray-200 dark:bg-oai-gray-800 dark:text-white dark:ring-oai-gray-700"
                                : "text-oai-gray-500 hover:bg-white/80 hover:text-oai-gray-900 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800/70 dark:hover:text-oai-gray-200",
                            )}
                          >
                            {active ? (
                              <span
                                className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-oai-brand-500"
                                aria-hidden
                              />
                            ) : null}
                            <Icon
                              className={cn(
                                "h-4 w-4 shrink-0",
                                active ? "text-oai-brand-600 dark:text-oai-brand-400" : "text-oai-gray-400 dark:text-oai-gray-500",
                              )}
                              aria-hidden
                            />
                            <span className="truncate">{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </nav>
            </aside>

            <div className="min-w-0">
              <div className="mb-4 border-b border-oai-gray-200 pb-4 dark:border-oai-gray-800">
                <h2 className="text-xl font-semibold tracking-tight text-oai-black dark:text-white">
                  {activeSectionMeta.label}
                </h2>
                <p className="mt-1 text-sm leading-5 text-oai-gray-500 dark:text-oai-gray-400">
                  {activeSectionMeta.description}
                </p>
              </div>
              {sections.map(({ id, label, content }) => (
                <section
                  key={id}
                  id={`settings-panel-${id}`}
                  aria-labelledby={`settings-nav-${id}`}
                  aria-label={label}
                  data-settings-panel={id}
                  hidden={activeSection !== id}
                >
                  {content}
                </section>
              ))}

              <NativeAppFooter />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
