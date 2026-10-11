import React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { copy } from "../../lib/copy";
import { clearCloudPromptIntent, recordCloudPromptIntent } from "../../lib/cloud-prompt-policy.js";
import { CloudMembershipCard } from "../cloud/CloudMembershipCard.jsx";
import { BillingNotice } from "../cloud/CloudBillingParts.jsx";
import { CloudContextualPrompt } from "../cloud/CloudContextualPrompt.jsx";
import { ToggleSwitch } from "./Controls.jsx";
import { useAccountProfileSettings } from "./useAccountProfileSettings.js";

export function CloudSection({ settings, active = true } = {}) {
  return settings ? <CloudSettingsSection settings={settings} active={active} /> : <StandaloneCloudSection active={active} />;
}

function StandaloneCloudSection({ active }) {
  const settings = useAccountProfileSettings();
  return <CloudSettingsSection settings={settings} active={active} />;
}

function CloudSettingsSection({ settings, active }) {
  return (
    <CloudMembershipCard showTitle={false} heading={copy("settings.section.cloud")} active={active}
      syncControl={settings.showLocalCloudSync ? <CloudSyncRow settings={settings} /> : null} />
  );
}

export function CloudSyncRow({ settings }) {
  return (
    <>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-3 text-sm font-medium">
          <RefreshCw size={16} className="shrink-0" aria-hidden />
          {copy("settings.account.cloudSync")}
        </span>
          <span className="tt-cloud-theme tt-cloud-sync-control inline-flex" aria-busy={settings.cloudSyncPending || undefined}>
            <ToggleSwitch
              checked={settings.cloudSyncOn}
              disabled={settings.cloudSyncPending}
              onChange={() => {
                if (settings.cloudSyncOn) clearCloudPromptIntent(settings.userId);
                else recordCloudPromptIntent(settings.userId, "sync");
                return settings.handleCloudSyncToggle();
              }}
              ariaLabel={copy("settings.account.cloudSync")}
            />
          </span>
      </div>
      {settings.cloudSyncOn && settings.cloudSyncPending ? (
        <p role="status" className="flex items-center gap-2 py-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden />{copy("settings.account.cloudSyncPending")}
        </p>
      ) : null}
      {settings.cloudSyncOn && settings.cloudSyncError && !settings.cloudSyncPending ? (
        <div className="tt-cloud-theme py-3">
          <BillingNotice role="alert" onRetry={settings.handleCloudSyncRetry}>{copy("settings.account.cloudSyncError")}</BillingNotice>
        </div>
      ) : null}
      <CloudContextualPrompt userId={settings.userId} panel="sync" localHost className="py-3"
        onContinueLocal={() => {
          clearCloudPromptIntent(settings.userId);
          if (settings.cloudSyncOn) settings.handleCloudSyncDisable();
        }} />
    </>
  );
}
