import React from "react";
import { copy } from "../../lib/copy";
import { SectionCard, SettingsRow, ToggleSwitch, SegmentedControl } from "./Controls.jsx";
import { useQualityPerDollarPref } from "../../hooks/use-quality-per-dollar-pref.js";
import { useSessionEfficiencyPref } from "../../hooks/use-session-efficiency-pref.js";
import { useNativeSettings } from "../../hooks/use-native-settings.js";

function BetaLabel({ labelKey }) {
  return (
    <div className="flex items-center gap-1.5">
      <span>{copy(labelKey)}</span>
      <span className="px-1.5 py-0.5 text-[8px] font-semibold tracking-wider text-oai-gray-500 bg-oai-gray-100 dark:text-oai-gray-400 dark:bg-oai-gray-800/80 rounded uppercase scale-90 origin-left">
        {copy("qpd.card.badge")}
      </span>
    </div>
  );
}

/**
 * Experimental features. Everything here works on local data alone, so the
 * section must stay reachable without signing in.
 */
export function LabsSection() {
  const { enabled: qpdEnabled, toggle: toggleQpd } = useQualityPerDollarPref();
  const { enabled: sessionsEnabled, toggle: toggleSessions } = useSessionEfficiencyPref();
  // Dynamic Island is a native macOS feature: the toggle drives the Swift app
  // through the NativeBridge (not localStorage), and only renders when the
  // macOS bridge advertises support (Windows/browser never send the flag).
  const { available: nativeAvailable, settings: nativeSettings, setSetting } = useNativeSettings();
  const islandSupported = nativeAvailable && Boolean(nativeSettings?.dynamicIslandSupported);
  const islandEnabled = Boolean(nativeSettings?.dynamicIslandEnabled);
  const placement = nativeSettings?.dynamicIslandPlacement === "edge" ? "edge" : "island";

  return (
    <SectionCard title={copy("settings.section.labs")}>
      {islandSupported && (
        <>
          <SettingsRow
            label={<BetaLabel labelKey="settings.labs.island.label" />}
            hint={copy("settings.labs.island.hint")}
            control={
              <ToggleSwitch
                checked={islandEnabled}
                onChange={() => setSetting("dynamicIslandEnabled", !islandEnabled)}
                ariaLabel={copy("settings.labs.island.aria")}
              />
            }
          />
          {islandEnabled && (
            <>
              <SettingsRow
                label={copy("settings.labs.island_placement.label")}
                hint={copy("settings.labs.island_placement.hint")}
                control={
                  <SegmentedControl
                    options={[
                      {
                        value: "island",
                        label: copy("settings.labs.island_placement.island"),
                      },
                      {
                        value: "edge",
                        label: copy("settings.labs.island_placement.edge"),
                      },
                    ]}
                    value={placement}
                    onChange={(next) => setSetting("dynamicIslandPlacement", next)}
                  />
                }
              />
              <SettingsRow
                label={copy("settings.labs.island_hide_menubar.label")}
                hint={copy("settings.labs.island_hide_menubar.hint")}
                control={
                  <ToggleSwitch
                    checked={Boolean(nativeSettings?.hideMenuBarIcon)}
                    onChange={() => setSetting("hideMenuBarIcon", !nativeSettings?.hideMenuBarIcon)}
                    ariaLabel={copy("settings.labs.island_hide_menubar.aria")}
                  />
                }
              />
            </>
          )}
        </>
      )}
      <SettingsRow
        label={<BetaLabel labelKey="settings.labs.qpd.label" />}
        hint={copy("settings.labs.qpd.hint")}
        control={
          <ToggleSwitch
            checked={qpdEnabled}
            onChange={toggleQpd}
            ariaLabel={copy("settings.labs.qpd.aria")}
          />
        }
      />
      <SettingsRow
        label={<BetaLabel labelKey="settings.labs.sessions.label" />}
        hint={copy("settings.labs.sessions.hint")}
        control={
          <ToggleSwitch
            checked={sessionsEnabled}
            onChange={toggleSessions}
            ariaLabel={copy("settings.labs.sessions.aria")}
          />
        }
      />
    </SectionCard>
  );
}
