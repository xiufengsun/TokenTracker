import React, { useEffect, useState } from "react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useAppUpdate } from "../../hooks/use-app-update.js";
import { useLocale } from "../../hooks/useLocale.js";
import { cn } from "../../lib/cn";
import { copy } from "../../lib/copy";
import { ConfirmModal } from "./ConfirmModal";

/**
 * Sidebar update indicator pill.
 * Renders only on the Windows desktop client when an update is available or
 * actively downloading/installing, and opens a confirmation modal before update.
 *
 * @param {{ collapsed?: boolean }} props
 */
export function SidebarUpdatePill({ collapsed = false }) {
  const {
    hasUpdate,
    updateInProgress,
    currentVersion,
    latestVersion,
    updateBusy,
    updateStatus,
    updateError,
    triggerUpdate,
  } = useAppUpdate();
  useLocale();
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (updateError) {
      setConfirmOpen(true);
    }
  }, [updateError]);

  if (!hasUpdate && !updateInProgress) return null;

  const displayVersion = latestVersion || "";
  const displayCurrent = currentVersion || "";
  const labelText = displayVersion
    ? copy("nav.update_available", { version: displayVersion })
    : copy("nav.update_available_short");
  const titleText = copy("nav.update_available_title", {
    version: displayVersion,
  });
  const isBusy = updateBusy || updateInProgress;
  const pillText = updateInProgress && updateStatus ? updateStatus : labelText;
  const accessibleLabel =
    updateInProgress && updateStatus ? updateStatus : titleText;

  return (
    <div className={cn("px-2 pb-1", collapsed && "flex justify-center")}>
      <button
        type="button"
        disabled={isBusy}
        onClick={() => setConfirmOpen(true)}
        title={accessibleLabel}
        aria-label={accessibleLabel}
        className={cn(
          "group relative flex items-center rounded-full border border-amber-500/35 bg-amber-500/10 text-amber-700 shadow-sm transition-all hover:border-amber-500/50 hover:bg-amber-500/15 hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-80 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300 dark:hover:border-amber-400/50 dark:hover:bg-amber-400/20 dark:hover:text-amber-200",
          collapsed
            ? "h-9 w-9 justify-center p-0"
            : "w-full justify-between gap-2 px-3 py-1.5 text-xs font-medium",
        )}
      >
        {collapsed ? (
          <>
            {updateInProgress ? (
              <RefreshCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
            ) : (
              <ArrowUpCircle className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <span
              className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5"
              aria-hidden
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
            </span>
          </>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-2">
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
              </span>
              <span className="truncate">{pillText}</span>
            </span>
            {updateInProgress ? (
              <RefreshCw
                className="h-3.5 w-3.5 shrink-0 animate-spin opacity-80"
                aria-hidden
              />
            ) : (
              <ArrowUpCircle
                className="h-3.5 w-3.5 shrink-0 opacity-80 transition-transform group-hover:-translate-y-0.5"
                aria-hidden
              />
            )}
          </>
        )}
      </button>

      <ConfirmModal
        open={confirmOpen && !updateInProgress}
        title={copy("nav.update_confirm_title")}
        description={copy("nav.update_confirm_description", {
          version: displayVersion,
          current: displayCurrent,
        })}
        error={updateError}
        confirmLabel={copy("nav.update_confirm_yes")}
        cancelLabel={copy("nav.update_confirm_no")}
        busy={isBusy}
        onConfirm={() => {
          setConfirmOpen(false);
          triggerUpdate();
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
