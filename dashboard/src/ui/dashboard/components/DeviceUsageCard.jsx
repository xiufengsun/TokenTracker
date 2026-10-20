import React, { useMemo, useState } from "react";
import { Laptop, Monitor, MonitorSmartphone, Pencil, Check, X } from "lucide-react";
import { Card } from "../../components";
import { copy } from "../../../lib/copy";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { formatDeviceLabel } from "../../../lib/device-label";
import { formatProviderDisplayName } from "../../../lib/provider-display";
import { ProviderIcon } from "./ProviderIcon";

const DOT_DIVIDER = " · ";
const PCT_SIGN = "%";

// Platform → icon. device.platform comes from tokentracker_devices (e.g.
// "darwin", "win32"/"windows", "linux", "web"); fall back to a generic monitor.
function PlatformIcon({ platform, className }) {
  const p = String(platform || "").toLowerCase();
  if (p.includes("darwin") || p.includes("mac")) return <Laptop className={className} aria-hidden />;
  if (p.includes("win")) return <Monitor className={className} aria-hidden />;
  if (p.includes("linux")) return <Monitor className={className} aria-hidden />;
  return <MonitorSmartphone className={className} aria-hidden />;
}

function isCurrentDevice(device, currentDeviceId) {
  return currentDeviceId === device?.id || device?.isCurrent === true;
}

export function DeviceUsageCard({ devices = [], accountSources = [], currentDeviceId = "", selectedDeviceId = "", onSelectDevice, onRenameDevice }) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorId, setErrorId] = useState("");

  const canRename = typeof onRenameDevice === "function";
  const canSelect = typeof onSelectDevice === "function";
  const anySelected = Boolean(selectedDeviceId);

  // Denominator spans devices AND account-level sources so the card total
  // matches the dashboard total (account-level usage has no device attribution
  // and is listed as its own row rather than folded into a device).
  const total =
    devices.reduce((sum, d) => sum + (Number(d.total_tokens) || 0), 0) +
    accountSources.reduce((sum, s) => sum + (Number(s.total_tokens) || 0), 0);
  // Rank heaviest-first so the dominant device leads the breakdown. Devices
  // idle in the selected range (0 tokens — typically stale duplicate
  // registrations) are noise, not distribution — hide them.
  const ranked = useMemo(
    () =>
      devices
        .filter((d) => (Number(d.total_tokens) || 0) > 0 || d.id === selectedDeviceId)
        .sort((a, b) => (Number(b.total_tokens) || 0) - (Number(a.total_tokens) || 0)),
    [devices, selectedDeviceId],
  );

  function beginEdit(d) {
    setErrorId("");
    setEditingId(d.id);
    // Prefill the custom name so it can be tweaked; an auto-named device starts
    // blank so the placeholder invites a fresh, memorable name.
    const raw = typeof d.device_name === "string" ? d.device_name : "";
    setDraft(formatDeviceLabel(d) === raw ? raw : "");
  }

  function cancelEdit() {
    setEditingId("");
    setDraft("");
    setErrorId("");
  }

  async function commitEdit(d) {
    const name = draft.trim();
    if (!name || saving) return;
    setSaving(true);
    setErrorId("");
    try {
      await onRenameDevice(d.id, name);
      setEditingId("");
      setDraft("");
    } catch {
      setErrorId(d.id);
    } finally {
      setSaving(false);
    }
  }

  const accountRows = accountSources.filter((s) => (Number(s.total_tokens) || 0) > 0);

  // Empty state (defensive: today the card is only mounted with >= 2 devices).
  if (ranked.length === 0 && accountRows.length === 0) {
    return (
      <Card bodyClassName="!px-3 !py-3.5">
        <div className="flex items-center justify-between gap-2 mb-2 px-2">
          <div className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide px-2">
            {copy("dashboard.device_card.title")}
          </div>
        </div>
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <MonitorSmartphone className="h-7 w-7 text-oai-gray-300 dark:text-oai-gray-600 mb-2 stroke-[1.5]" />
          <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 font-medium">
            {copy("dashboard.device_card.empty")}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card bodyClassName="!px-3 !py-3.5">
      {/* Header styled to match the other cards' titles. */}
      <div className="flex items-center justify-between gap-2 mb-2 px-2">
        <div className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("dashboard.device_card.title")}
        </div>
        {canSelect && anySelected && (
          <button
            type="button"
            onClick={() => onSelectDevice("")}
            className="text-xs text-oai-gray-400 hover:text-oai-brand focus:outline-none transition-colors"
          >
            {copy("dashboard.device_card.clear")}
          </button>
        )}
      </div>

      <div className="space-y-[2px]">
        {ranked.map((d) => {
          const tokens = Number(d.total_tokens) || 0;
          const percent = total > 0 ? ((tokens / total) * 100).toFixed(1) : "0.0";
          const isSelected = selectedDeviceId === d.id;
          const name = formatDeviceLabel(d) || copy("dashboard.device_card.unnamed");
          const isEditing = editingId === d.id;

          const fillClass = isSelected
            ? "bg-oai-brand"
            : anySelected
              ? "bg-oai-gray-300 dark:bg-oai-gray-600"
              : "bg-oai-brand/50";

          // While filtering, fade unselected rows so the active device stands out.
          const itemOpacity = anySelected && !isSelected
            ? "opacity-40 hover:opacity-80"
            : "opacity-100";

          return (
            <div key={d.id} className="group relative">
              {isEditing ? (
                /* Edit state: same padding as the row to avoid layout shift. */
                <div className="w-full rounded-md px-2 py-1.5 bg-oai-gray-50/50 dark:bg-oai-gray-900/40">
                  {/* Row 1: name input (left), save / cancel (right). */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <PlatformIcon platform={d.platform} className="h-3.5 w-3.5 shrink-0 text-oai-gray-500 dark:text-oai-gray-400" />
                      <input
                        autoFocus
                        value={draft}
                        disabled={saving}
                        maxLength={60}
                        placeholder={copy("dashboard.device_card.rename_placeholder")}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(d);
                          else if (e.key === "Escape") cancelEdit();
                        }}
                        className="flex-1 min-w-0 bg-transparent text-xs font-medium text-oai-black dark:text-oai-white border-b border-oai-gray-300 dark:border-oai-gray-700 focus:outline-none focus:border-oai-brand py-0"
                      />
                    </div>
                    <div className="shrink-0 flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={copy("dashboard.device_card.rename_save")}
                        disabled={saving || !draft.trim()}
                        onClick={() => commitEdit(d)}
                        className="text-oai-gray-400 hover:text-oai-brand dark:hover:text-white disabled:opacity-30 transition-colors p-0.5"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={copy("dashboard.device_card.rename_cancel")}
                        disabled={saving}
                        onClick={cancelEdit}
                        className="text-oai-gray-400 hover:text-oai-black dark:hover:text-white disabled:opacity-30 transition-colors p-0.5"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Row 2: dimmed bar — keeps the row height stable while editing. */}
                  <div className="mt-1.5 h-[2px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden opacity-40 select-none">
                    <div
                      className={`h-full rounded-full transition-[width,background-color] duration-700 ease-out ${fillClass}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              ) : (
                /* Display state: the whole row toggles the filter; rename is a sibling
                   overlay (a button must not nest inside a button — invalid DOM). */
                <>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`${copy("dashboard.device_filter.aria")}: ${name}${isCurrentDevice(d, currentDeviceId) ? ` (${copy("dashboard.device_card.current")})` : ""}`}
                    onClick={() => onSelectDevice?.(isSelected ? "" : d.id)}
                    className={`w-full text-left rounded-md px-2 py-1.5 transition-all duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-oai-brand/50 ${itemOpacity} ${
                      isSelected
                        ? "bg-oai-gray-100/70 dark:bg-oai-gray-800/80 text-oai-black dark:text-oai-white"
                        : "bg-transparent hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/40 text-oai-black dark:text-oai-white"
                    }`}
                  >
                    {/* Row 1: name (left); usage (right, fades on hover to reveal the rename pencil). */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <PlatformIcon
                          platform={d.platform}
                          className="h-3.5 w-3.5 shrink-0 text-oai-gray-500 dark:text-oai-gray-400"
                        />
                        <span className="block truncate text-[13px] font-medium text-oai-black dark:text-oai-white" title={name}>
                          {name}
                        </span>
                        {isCurrentDevice(d, currentDeviceId) && (
                          <span className="shrink-0 rounded-full bg-oai-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-oai-brand">
                            {copy("dashboard.device_card.current")}
                          </span>
                        )}
                        {d.imported_at && <span className="shrink-0 whitespace-nowrap text-xs text-oai-gray-500"
                          title={copy("settings.local_data.snapshot_time", { time: new Date(d.exported_at).toLocaleString() })}>
                          {copy("settings.local_data.imported_label")}
                        </span>}
                      </div>
                      <span
                        title={formatTokensTooltip(tokens)}
                        className={`shrink-0 text-[13px] font-semibold tabular-nums text-oai-black dark:text-oai-white transition-opacity duration-150 ${
                          canRename ? "group-hover:opacity-0" : ""
                        }`}
                      >
                        {formatTokens(tokens)}
                        <span className="text-oai-gray-400 dark:text-oai-gray-500 font-normal">
                          {DOT_DIVIDER}
                          {percent}
                          {PCT_SIGN}
                        </span>
                      </span>
                    </div>

                    {/* Row 2: usage bar. */}
                    <div className="mt-1.5 h-[2px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-[width,background-color] duration-700 ease-out ${fillClass}`}
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </button>
                  {canRename && (
                    <button
                      type="button"
                      aria-label={copy("dashboard.device_card.rename_aria")}
                      onClick={() => beginEdit(d)}
                      className="absolute right-2 top-1.5 flex h-4 items-center text-oai-gray-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-oai-brand focus:outline-none transition-opacity duration-150"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </>
              )}

              {/* Rename error. */}
              {errorId === d.id && (
                <div className="px-2 mt-1 text-xs text-red-500 font-medium">
                  {copy("dashboard.device_card.rename_error")}
                </div>
              )}
            </div>
          );
        })}

        {/* Account-level sources (e.g. Cursor) — usage synced from the
            provider's per-account API, so it belongs to the whole account, not
            any one device. Listed as their own rows (after devices, not
            interleaved: a different attribution class) so the card total
            matches the dashboard total; not clickable — there is no device to
            filter by. */}
        {accountRows.map((s) => {
          const tokens = Number(s.total_tokens) || 0;
          const percent = total > 0 ? ((tokens / total) * 100).toFixed(1) : "0.0";
          const rowOpacity = anySelected ? "opacity-40" : "opacity-100";
          return (
            <div
              key={`account-${s.source}`}
              className={`rounded-md px-2 py-1.5 transition-all duration-200 ${rowOpacity}`}
              title={copy("dashboard.device_card.account_scope_tip")}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="h-3.5 w-3.5 shrink-0 flex items-center justify-center">
                    <ProviderIcon provider={s.source} size={14} />
                  </span>
                  <span className="block truncate text-[13px] font-medium text-oai-black dark:text-oai-white">
                    {formatProviderDisplayName(s.source)}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-oai-gray-400 dark:text-oai-gray-500">
                    {copy("dashboard.device_card.account_scope")}
                  </span>
                </div>
                <span
                  title={formatTokensTooltip(tokens)}
                  className="shrink-0 text-[13px] font-semibold tabular-nums text-oai-black dark:text-oai-white"
                >
                  {formatTokens(tokens)}
                  <span className="text-oai-gray-400 dark:text-oai-gray-500 font-normal">
                    {DOT_DIVIDER}
                    {percent}
                    {PCT_SIGN}
                  </span>
                </span>
              </div>
              <div className="mt-1.5 h-[2px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width,background-color] duration-700 ease-out ${
                    anySelected ? "bg-oai-gray-300 dark:bg-oai-gray-600" : "bg-oai-brand/50"
                  }`}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
