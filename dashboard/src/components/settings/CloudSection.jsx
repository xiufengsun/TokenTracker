import React, { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { copy } from "../../lib/copy";
import { clearCloudPromptIntent, recordCloudPromptIntent, readCloudPromptState } from "../../lib/cloud-prompt-policy.js";
import { isOfficialInsforgeInstance } from "../../lib/insforge-config";
import { CloudMembershipCard } from "../cloud/CloudMembershipCard.jsx";
import { BillingNotice } from "../cloud/CloudBillingParts.jsx";
import { CloudContextualPrompt } from "../cloud/CloudContextualPrompt.jsx";
import { ToggleSwitch } from "./Controls.jsx";
import { InstanceSectionCard } from "./InstanceSectionCard.jsx";
import { useAccountProfileSettings } from "./useAccountProfileSettings.js";
import { rebuildCloudDeviceUsage } from "../../lib/cloud-sync";
import { ConfirmModal } from "../../ui/components/ConfirmModal.jsx";
import { Button } from "../../ui/components/Button.jsx";

export function CloudSection({ settings, active = true } = {}) {
  return settings ? <CloudSettingsSection settings={settings} active={active} /> : <StandaloneCloudSection active={active} />;
}

function StandaloneCloudSection({ active }) {
  const settings = useAccountProfileSettings();
  return <CloudSettingsSection settings={settings} active={active} />;
}

function CloudSettingsSection({ settings, active }) {
  return (
    <div className="space-y-4">
      <CloudMembershipCard showTitle={false} active={active}
        syncControl={settings.showLocalCloudSync ? <CloudSyncRow settings={settings} /> : null} />
      <InstanceSectionCard signedIn={settings.signedIn} />
    </div>
  );
}

export function CloudSyncRow({ settings }) {
  const prompt = readCloudPromptState(settings.userId);
  const canRebuild = isOfficialInsforgeInstance() && prompt.membership?.status !== "self_hosted" &&
    prompt.membership?.hosting_mode !== "self_hosted" && prompt.catalog?.policy?.hosting_mode !== "self_hosted";
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
      {settings.cloudSyncOn && canRebuild ? <CloudRebuildControl settings={settings} /> : null}
    </>
  );
}

export function CloudRebuildControl({ settings }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const scope = useMemo(() => ({ active: true, busy: false }), [settings.userId, settings.getAccessToken]);
  useEffect(() => {
    scope.active = true;
    setOpen(false); setResult(null); setBusy(false);
    return () => { scope.active = false; };
  }, [scope]);
  const rebuild = async () => {
    if (!scope.active || scope.busy || !settings.cloudSyncOn) return;
    scope.busy = true; setBusy(true); setResult(null);
    try {
      const next = await rebuildCloudDeviceUsage(settings.getAccessToken);
      if (scope.active) { setResult(next.pending ? "pending" : "complete"); setOpen(false); }
    } catch (error) {
      if (scope.active) setResult(error.code === "cloud_usage_reset_sync_busy" ? "busy" : "error");
    } finally {
      scope.busy = false;
      if (scope.active) setBusy(false);
    }
  };
  return (
    <div className="border-t border-oai-gray-200 py-3 dark:border-oai-gray-800">
      <Button size="sm" variant="secondary" disabled={busy || settings.cloudSyncPending}
        onClick={() => { setResult(null); setOpen(true); }}>{copy("cloud.rebuild.action")}</Button>
      {result === "pending" || result === "complete" ? <p role="status" className="mt-2 text-xs text-oai-gray-500">
        {copy(result === "pending" ? "cloud.rebuild.pending" : "cloud.rebuild.complete")}
      </p> : null}
      <ConfirmModal open={open} title={copy("cloud.rebuild.title")} description={copy("cloud.rebuild.description")}
        destructive busy={busy} confirmLabel={copy("cloud.rebuild.action")} cancelLabel={copy("shared.action.cancel")}
        error={result === "error" ? copy("cloud.rebuild.error") : result === "busy" ? copy("cloud.rebuild.busy") : null}
        onConfirm={rebuild} onCancel={() => setOpen(false)} />
    </div>
  );
}
