import React from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowUpRight, Download, RefreshCw } from "lucide-react";
import { useNativeSettings } from "../../hooks/use-native-settings.js";
import { useLocale } from "../../hooks/useLocale.js";
import { ConfirmModal } from "../../ui/components";
import { showToast } from "../../ui/components/Toast.jsx";
import { STATUSPAGE_URL } from "../../lib/config";
import { copy } from "../../lib/copy";
import { cn } from "../../lib/cn";
import { isNativeWindowsApp } from "../../lib/native-bridge.js";
import { SectionCard, SettingsRow, ToggleSwitch } from "./Controls.jsx";

export function MenuBarSection() {
  const { available, settings, setSetting, runAction } = useNativeSettings();
  if (!available) return null;
  const isWindows = isNativeWindowsApp();

  // showStats + animatedIcon live on the Widgets page (Menu Bar section) where
  // they sit next to the live preview. This section keeps only the system-level
  // toggles + actions that don't have a visual analogue.
  const launchAtLogin = Boolean(settings?.launchAtLogin);
  const toastOnReset = settings?.toastOnReset !== false;
  const confettiOnReset = settings?.confettiOnReset !== false;
  const launchAtLoginSupported = settings?.launchAtLoginSupported !== false;
  const autoUpdateEnabled = settings?.autoUpdateEnabled !== false;
  const updateStatus = settings?.updateStatus || null;
  const updateBusy = Boolean(settings?.updateBusy);
  const isSyncing = Boolean(settings?.isSyncing);

  return (
    <SectionCard title={copy("settings.section.menubar")}>
      {!isWindows ? (
        <>
          <SettingsRow
            label={copy("settings.menubar.appearance")}
            hint={copy("settings.menubar.appearanceHint")}
            control={
              <Link
                to="/widgets"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 no-underline transition-colors hover:bg-oai-gray-100 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
              >
                {copy("settings.menubar.appearanceLink")}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            }
          />
          <SettingsRow
            label={copy("settings.menubar.toastOnReset")}
            hint={copy("settings.menubar.toastOnResetHint")}
            control={
              <ToggleSwitch
                checked={toastOnReset}
                onChange={() => setSetting("toastOnReset", !toastOnReset)}
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
                onChange={() => setSetting("confettiOnReset", !confettiOnReset)}
                ariaLabel={copy("settings.menubar.confettiOnReset")}
              />
            }
          />
        </>
      ) : null}
      {launchAtLoginSupported ? (
        <SettingsRow
          label={copy("settings.menubar.launchAtLogin")}
          hint={copy("settings.menubar.launchAtLoginHint")}
          control={
            <ToggleSwitch
              checked={launchAtLogin}
              onChange={() => setSetting("launchAtLogin", !launchAtLogin)}
              ariaLabel={copy("settings.menubar.launchAtLogin")}
            />
          }
        />
      ) : null}
      <SettingsRow
        label={copy("settings.menubar.syncNow")}
        hint={copy("settings.menubar.syncNowHint")}
        control={
          <button
            type="button"
            onClick={() => runAction("syncNow")}
            disabled={isSyncing}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isSyncing && "animate-spin")} aria-hidden />
            {isSyncing ? copy("settings.menubar.syncing") : copy("settings.menubar.syncNow")}
          </button>
        }
      />
      <SettingsRow
        label={copy("settings.menubar.autoUpdate")}
        hint={copy("settings.menubar.autoUpdateHint")}
        control={
          <ToggleSwitch
            checked={autoUpdateEnabled}
            onChange={() => setSetting("autoUpdateEnabled", !autoUpdateEnabled)}
            ariaLabel={copy("settings.menubar.autoUpdate")}
          />
        }
      />
      <SettingsRow
        label={copy("settings.menubar.updates")}
        hint={updateStatus || undefined}
        control={
          <button
            type="button"
            onClick={() => runAction("checkForUpdates")}
            disabled={updateBusy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 px-3 text-xs font-medium text-oai-gray-700 transition-colors hover:bg-oai-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-oai-gray-800 dark:text-oai-gray-300 dark:hover:bg-oai-gray-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {copy("settings.menubar.checkUpdates")}
          </button>
        }
      />
    </SectionCard>
  );
}

function hasUpdate(current, latest) {
  function parseParts(v) {
    return v.replace(/^v/, "").split(".").map(Number);
  }
  const currParts = parseParts(current);
  const lateParts = parseParts(latest);
  for (let i = 0; i < Math.max(currParts.length, lateParts.length); i++) {
    const curr = currParts[i] || 0;
    const late = lateParts[i] || 0;
    if (curr < late) return true;
    if (curr > late) return false;
  }
  return false;
}

export function NativeAppFooter() {
  const { available, settings, runAction } = useNativeSettings();
  const showNativeInfo = available && settings?.version;
  const nativePlatform = settings?.platform || "macos";
  const [checking, setChecking] = React.useState(false);
  const [updateModal, setUpdateModal] = React.useState({
    open: false,
    latestVersion: "",
    htmlUrl: "",
  });
  const { resolvedLocale } = useLocale();
  const currentVersion = import.meta.env.VITE_APP_VERSION || "0.64.2";

  const handleCheckUpdates = async () => {
    setChecking(true);
    try {
      const res = await fetch("https://api.github.com/repos/xiufengsun/TokenTracker/releases/latest");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      const latestVersion = data.tag_name;

      if (hasUpdate(currentVersion, latestVersion)) {
        setUpdateModal({
          open: true,
          latestVersion,
          htmlUrl: data.html_url
        });
      } else {
        showToast({
          title: copy("settings.menubar.updates.upToDate"),
        });
      }
    } catch (err) {
      console.error("Check updates failed:", err);
      showToast({
        title: copy("settings.menubar.updates.failed"),
      });
    } finally {
      setChecking(false);
    }
  };

  const modalTitle = copy("settings.menubar.updates.modalTitle");
  const modalDescription = copy("settings.menubar.updates.modalDescription", {
    version: updateModal.latestVersion,
  });
  const modalConfirm = copy("settings.menubar.updates.modalConfirm");
  const modalCancel = copy("settings.menubar.updates.modalCancel");

  return (
    <div className="mt-6 flex flex-col items-center justify-center gap-4 text-xs text-oai-gray-500 dark:text-oai-gray-500">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {showNativeInfo ? (
          <>
            <span>
              {nativePlatform === "windows"
                ? copy("settings.menubar.updates.footerCore", { version: settings.version })
                : copy("settings.menubar.updates.footerCombined", {
                    barVersion: settings.version,
                    coreVersion: currentVersion,
                  })}
            </span>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={() => runAction("openAbout")}
              className="underline-offset-2 transition-colors hover:text-oai-gray-700 hover:underline dark:hover:text-oai-gray-300"
            >
              GitHub
            </button>
            <span aria-hidden>·</span>
          </>
        ) : (
          <>
            <span>{copy("settings.menubar.updates.footerCore", { version: currentVersion })}</span>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={handleCheckUpdates}
              disabled={checking}
              className="underline-offset-2 transition-colors hover:text-oai-gray-700 hover:underline dark:hover:text-oai-gray-300 disabled:opacity-50"
            >
              {checking ? copy("settings.menubar.updates.checking") : copy("settings.menubar.checkUpdates")}
            </button>
            <span aria-hidden>·</span>
          </>
        )}
        <a
          href={STATUSPAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 underline-offset-2 transition-colors hover:text-oai-gray-700 hover:underline dark:hover:text-oai-gray-300"
        >
          <Activity className="h-3.5 w-3.5" aria-hidden />
          {copy("settings.footer.statusPage")}
        </a>
      </div>

      <ConfirmModal
        open={updateModal.open}
        title={modalTitle}
        description={modalDescription}
        confirmLabel={modalConfirm}
        cancelLabel={modalCancel}
        onConfirm={() => {
          window.open(updateModal.htmlUrl, "_blank");
          setUpdateModal((prev) => ({ ...prev, open: false }));
        }}
        onCancel={() => setUpdateModal((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}
