import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { isMockEnabled } from "../lib/mock-data";

const IS_LOCAL_HOST =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
import {
  ArrowUpCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Flame,
  Loader2,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X as XIcon,
} from "lucide-react";
import { Button, Card, ConfirmModal, DismissibleHint, Input, SegmentedControl } from "../ui/components";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { showToast } from "../ui/components/Toast.jsx";
import { SkillDetailPanel } from "./SkillDetailPanel.jsx";
import { copy } from "../lib/copy";
import { cn } from "../lib/cn";
import {
  addSkillRepo,
  checkSkillUpdates,
  deleteLocalSkill,
  discoverSkills,
  getAccountSkillInventories,
  getInstalledSkills,
  getPopularSkills,
  getSkillRepos,
  getSkillUsage,
  importLocalSkill,
  installSkill,
  publishSkillInventory,
  removeSkillRepo,
  restoreSkill,
  searchSkills,
  setSkillTargets,
  uninstallSkill,
  updateSkills,
} from "../lib/skills-api";
import { mergeSkillInventories } from "../lib/skills-inventory";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { getCloudSyncEnabled, getCurrentDeviceId } from "../lib/cloud-sync-prefs";

const DEFAULT_TARGETS = ["claude", "codex"];
const SOURCE_POPULAR = "popular";
const TARGET_CHIP_ICON_CLASSES = {
  claude: "text-orange-500 dark:text-orange-300",
  codex: "text-emerald-600 dark:text-emerald-300",
  grok: "text-zinc-700 dark:text-zinc-200",
  antigravity: "text-violet-600 dark:text-violet-300",
  gemini: "text-sky-600 dark:text-sky-300",
  opencode: "text-amber-600 dark:text-amber-300",
  hermes: "text-indigo-500 dark:text-indigo-300",
};
const SOURCE_ALL = "all";
const SOURCE_SKILLSSH = "skillssh";

function getSkillKey(skill) {
  return `${skill.repoOwner || "local"}/${skill.repoName || "local"}:${skill.directory}`;
}

function normalizedDirectory(value) {
  return String(value || "").replace(/\\/g, "/").trim().toLowerCase();
}

function directoryLeaf(value) {
  const directory = normalizedDirectory(value);
  return directory.split("/").filter(Boolean).pop() || "";
}

function installedDirectoryFallbackKey(skill) {
  if (skill.repoOwner || skill.repoName) return "";
  const directory = normalizedDirectory(skill.directory);
  if (!directory || directory.includes("/")) return "";
  return `dir:${directory}`;
}

function browseDirectoryFallbackKey(skill) {
  const leaf = directoryLeaf(skill.directory);
  return leaf ? `dir:${leaf}` : "";
}

function installedSkillKeys(skill) {
  const keys = new Set([getSkillKey(skill).toLowerCase()]);
  if (skill.repoOwner && skill.repoName) {
    keys.add(`${skill.repoOwner}/${skill.repoName}:${skill.sourceDirectory || skill.directory}`.toLowerCase());
  }
  const fallback = installedDirectoryFallbackKey(skill);
  if (fallback) keys.add(fallback);
  return keys;
}

function countsAsLocallyInstalled(skill) {
  return !skill?.remote && !skill?.inventoryOnly && !skill?.readOnly;
}

export function buildLocallyInstalledKeys(skills) {
  const keys = new Set();
  for (const skill of Array.isArray(skills) ? skills : []) {
    // Inventory-only and read-only rows describe another device or a
    // managed plugin cache. They are visible in My, but Browse must still
    // offer Install so the skill can be added to this machine.
    if (!countsAsLocallyInstalled(skill)) continue;
    for (const key of installedSkillKeys(skill)) keys.add(key);
  }
  return keys;
}

function installBusyKey(skill) {
  return `install:${getSkillKey(skill)}`;
}

function removeBusyKey(skill) {
  return `remove:${skill.id || skill.directory}`;
}

function targetBusyKey(skillId, targetId) {
  return `target:${skillId}:${targetId}`;
}

function skillIdentity(skill) {
  return skill.id || skill.directory;
}

function isManageableTarget(target) {
  return target.manageable !== false;
}

// Tri-state agent dot: synced (colored, ringed), off (muted), orphan (amber —
// the registry says it's synced here but the on-disk copy vanished). Click
// toggles; clicking an orphan re-syncs. Stops propagation so it never opens the
// row's detail panel.
function AgentDot({ target, state, busy, disabled, disabledLabel, onToggle }) {
  const synced = state === "synced";
  const orphan = state === "orphan";
  const stateLabel = orphan
    ? copy("skills.dot.orphan_aria", { agent: target.label })
    : synced
      ? copy("skills.dot.synced_aria", { agent: target.label })
      : copy("skills.dot.off_aria", { agent: target.label });
  const label = disabled && disabledLabel ? `${stateLabel} — ${disabledLabel}` : stateLabel;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={synced}
      disabled={busy || disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle?.(target.id, !synced);
      }}
      className="relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-oai-gray-100 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/40 disabled:cursor-not-allowed dark:hover:bg-oai-gray-800/60"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin text-oai-gray-400" aria-hidden />
      ) : (
        <span
          className={cn(
            "flex h-[18px] w-[18px] items-center justify-center transition",
            // synced + orphan stay full-color (recognizable); off fades out.
            synced && TARGET_CHIP_ICON_CLASSES[target.id],
            !synced && !orphan && "opacity-35 grayscale",
          )}
          aria-hidden
        >
          <ProviderIcon provider={target.id} size={18} />
        </span>
      )}
      {orphan && !busy ? (
        <span
          className="absolute -bottom-px -right-px h-2 w-2 rounded-full bg-amber-500 ring-2 ring-oai-white dark:ring-oai-gray-900"
          aria-hidden
        />
      ) : null}
    </button>
  );
}

function AgentDots({ skill, targets, onToggleTarget, busyKey }) {
  const activeTargetIds = new Set(skill.targets || []);
  const readOnly = Boolean(skill.readOnly || skill.remote);
  const visibleTargets = [];
  for (const target of targets) {
    if (readOnly ? activeTargetIds.has(target.id) : isManageableTarget(target)) {
      visibleTargets.push(target);
    }
  }
  return (
    <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      {visibleTargets.map((target) => (
        <AgentDot
          key={target.id}
          target={target}
          state={skill.targetStates?.[target.id] || "off"}
          busy={busyKey === targetBusyKey(skillIdentity(skill), target.id)}
          disabled={readOnly || target.manageable === false}
          disabledLabel={copy(
            skill.remote ? "skills.inventory.read_only_remote" : "skills.inventory.read_only_managed",
          )}
          onToggle={(targetId, enabled) => onToggleTarget?.(skill, targetId, enabled)}
        />
      ))}
    </div>
  );
}

function SkillRow({ skill, targets, selected, onSelect, selectable, checked, onToggleSelect, onToggleTarget, hasUpdate, busyKey }) {
  const sourceLabel =
    skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : null;
  const titleAttr = [skill.directory, sourceLabel, skill.sourceName].filter(Boolean).join(" · ");
  const deviceSources = Array.isArray(skill.deviceSources) ? skill.deviceSources : [];
  const inventoryBadges = [
    skill.remote ? copy("skills.inventory.remote") : null,
    skill.scope === "plugin" ? copy("skills.inventory.plugin") : null,
  ].filter(Boolean);

  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.(skill);
    }
  };

  return (
    <div
      data-skill-row="1"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={copy("skills.row.open_details", { name: skill.name || skill.directory })}
      onClick={() => onSelect?.(skill)}
      onKeyDown={handleKeyDown}
      className={cn(
        "cursor-pointer rounded-md py-3 pr-2 transition focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30",
        selected
          ? "bg-oai-gray-100 ring-1 ring-oai-gray-200 dark:bg-oai-gray-800/60 dark:ring-oai-gray-800"
          : checked
            ? "bg-oai-gray-50 dark:bg-oai-gray-900/40"
            : "hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900/40",
      )}
    >
      {/* Title line: checkbox + name + badge + agent dots + chevron all on one
          centered row so the checkbox aligns with the title, not the taller
          title+description block. Description sits below, indented under the name. */}
      <div className="flex items-center gap-3">
        {selectable ? (
          <label className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => onToggleSelect?.(skill, event.target.checked)}
              aria-label={copy("skills.select.row_aria", { name: skill.name || skill.directory })}
              className="h-4 w-4 rounded border-oai-gray-300 text-oai-black focus:ring-oai-gray-400 dark:border-oai-gray-600 dark:bg-oai-gray-900 dark:text-white"
            />
          </label>
        ) : null}
        <h2
          className="min-w-0 flex-1 truncate text-sm font-semibold text-oai-black dark:text-white"
          title={titleAttr}
        >
          {skill.name || skill.directory}
        </h2>
        {inventoryBadges.map((badge) => (
          <span
            key={badge}
            className="inline-flex shrink-0 rounded-full bg-oai-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-oai-gray-600 ring-1 ring-oai-gray-200 dark:bg-oai-gray-800 dark:text-oai-gray-300 dark:ring-oai-gray-700"
          >
            {badge}
          </span>
        ))}
        {hasUpdate ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-800/60">
            <ArrowUpCircle className="h-2.5 w-2.5" aria-hidden />
            {copy("skills.update.badge")}
          </span>
        ) : null}
        <AgentDots skill={skill} targets={targets} onToggleTarget={onToggleTarget} busyKey={busyKey} />
        <ChevronRight
          className={cn(
            "hidden h-4 w-4 shrink-0 text-oai-gray-300 transition-colors dark:text-oai-gray-600 lg:block",
            selected && "text-oai-gray-500 dark:text-oai-gray-300",
          )}
          aria-hidden
        />
      </div>
      {skill.description ? (
        <p className={cn("mt-1 line-clamp-2 text-xs text-oai-gray-500 dark:text-oai-gray-400", selectable && "pl-7")}>
          {skill.description}
        </p>
      ) : null}
      {skill.sourceName || deviceSources.length ? (
        <div
          className={cn(
            "mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-oai-gray-400 dark:text-oai-gray-500",
            selectable && "pl-7",
          )}
        >
          {skill.sourceName ? <span className="truncate">{skill.sourceName}</span> : null}
          {deviceSources.length ? (
            <span
              className="inline-flex min-w-0 items-center gap-1"
              title={deviceSources.map((device) => device.name).join(", ")}
            >
              <MonitorSmartphone className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">
                {copy("skills.inventory.on_devices", {
                  devices: deviceSources.map((device) => device.name).join(", "),
                })}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FilterToolbar({
  agentFilter,
  agentOptions,
  onAgentFilter,
  filteredCount,
  totalCount,
  anyFilter,
  onClearFilters,
  searchQuery,
  onSearchQuery,
  searchPlaceholder,
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 pt-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
      <Select.Root value={agentFilter} onValueChange={onAgentFilter}>
        <Select.Trigger
          aria-label={copy("skills.filter.agent_label")}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 bg-oai-white px-2.5 text-xs font-medium text-oai-gray-700 transition hover:border-oai-gray-300 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 data-[popup-open]:border-oai-gray-300 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-200 dark:hover:border-oai-gray-700"
        >
          <span className="text-oai-gray-500 dark:text-oai-gray-400">
            {copy("skills.filter.agent_label")}:
          </span>
          <Select.Value>
            {(value) =>
              value === "all"
                ? copy("skills.filter.agent_all")
                : agentOptions.find((t) => t.id === value)?.label || value
            }
          </Select.Value>
          <Select.Icon className="text-oai-gray-400">
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-[60]">
            <Select.Popup className="min-w-[var(--anchor-width)] overflow-hidden rounded-md border border-oai-gray-200 bg-white p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)] outline-none dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]">
              <Select.Item
                value="all"
                className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
              >
                <Select.ItemText>{copy("skills.filter.agent_all")}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check className="h-3.5 w-3.5" aria-hidden />
                </Select.ItemIndicator>
              </Select.Item>
              {agentOptions.map((target) => (
                <Select.Item
                  key={target.id}
                  value={target.id}
                  className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
                >
                  <div className="flex items-center gap-2">
                    <ProviderIcon provider={target.id} size={14} />
                    <Select.ItemText>{target.label}</Select.ItemText>
                  </div>
                  <Select.ItemIndicator>
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>

      <div className="relative w-56 max-w-full">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" aria-hidden />
        <Input
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && searchQuery) {
              event.preventDefault();
              onSearchQuery("");
            }
          }}
          aria-label={copy("skills.action.search_aria")}
          placeholder={searchPlaceholder}
          className="h-8 pl-9 pr-8 !border-oai-gray-200 dark:!border-oai-gray-800 focus:!border-oai-gray-400 focus:!ring-oai-gray-400/20 dark:focus:!border-oai-gray-500 dark:focus:!ring-oai-gray-500/20 [&::-webkit-search-cancel-button]:appearance-none"
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSearchQuery("")}
          aria-label={copy("skills.action.search_clear")}
          aria-hidden={!searchQuery}
          tabIndex={searchQuery ? 0 : -1}
          className={cn(
            "absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-oai-gray-400 transition duration-150 ease-out before:absolute before:-inset-1.5 before:content-[''] hover:bg-oai-gray-100 hover:text-oai-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-gray-400/40 motion-reduce:transition-none dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-200",
            searchQuery ? "scale-100 opacity-100" : "pointer-events-none scale-90 opacity-0",
          )}
        >
          <XIcon className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      <span
        role="status"
        aria-live="polite"
        className="ml-auto shrink-0 tabular-nums text-oai-gray-500 dark:text-oai-gray-400"
      >
        {copy("skills.filter.result_count", { filtered: filteredCount, total: totalCount })}
      </span>

      {anyFilter ? (
        <button
          type="button"
          onClick={onClearFilters}
          className="shrink-0 inline-flex h-7 items-center gap-1 rounded-full bg-oai-gray-100 px-2.5 text-[11px] font-medium text-oai-gray-700 transition hover:bg-oai-gray-200 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:bg-oai-gray-800/70 dark:text-oai-gray-200 dark:hover:bg-oai-gray-700"
        >
          <XIcon className="h-3 w-3" aria-hidden />
          {copy("skills.filter.clear")}
        </button>
      ) : null}
    </div>
  );
}

// Batch toolbar — appears only when a selection exists. Capability-gated: the
// bulk-sync popover and remove button act on every selected skill at once.
function BatchToolbar({ count, targets, busy, onBulkSync, onBulkRemove, onClear }) {
  const manageableTargets = targets.filter(isManageableTarget);
  return (
    <div
      role="toolbar"
      aria-label={copy("skills.select.toolbar_aria")}
      className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-3 py-2 dark:border-oai-gray-800 dark:bg-oai-gray-900/50"
    >
      <span className="text-xs font-medium text-oai-gray-700 dark:text-oai-gray-200" aria-live="polite">
        {copy("skills.select.count", { count })}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Popover.Root>
          <Popover.Trigger
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-oai-gray-200 bg-oai-white px-2.5 text-xs font-medium text-oai-gray-700 transition hover:border-oai-gray-300 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 disabled:opacity-60 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-oai-gray-200"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            {copy("skills.select.bulk_sync")}
            <ChevronDown className="h-3 w-3" aria-hidden />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={6} side="bottom" align="end" className="!z-[80]">
              <Popover.Popup className="min-w-[200px] rounded-lg bg-white p-1.5 shadow-lg ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800">
                <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("skills.select.bulk_sync_hint")}
                </div>
                {manageableTargets.map((target) => (
                  <button
                    key={target.id}
                    type="button"
                    onClick={() => onBulkSync(target.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-oai-black hover:bg-oai-gray-100 dark:text-white dark:hover:bg-oai-gray-800"
                  >
                    <ProviderIcon provider={target.id} size={16} />
                    <span className="flex-1">{target.label}</span>
                  </button>
                ))}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onBulkRemove}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {copy("skills.select.bulk_remove")}
        </Button>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium text-oai-gray-500 transition hover:text-oai-black focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:text-oai-gray-400 dark:hover:text-white"
        >
          <XIcon className="h-3 w-3" aria-hidden />
          {copy("skills.select.clear")}
        </button>
      </div>
    </div>
  );
}

function MySkillsView({
  items,
  totalCount,
  targets,
  agentOptions,
  agentFilter,
  onAgentFilter,
  anyFilter,
  onClearFilters,
  searchQuery,
  onSearchQuery,
  searchPlaceholder,
  selectedId,
  onSelect,
  onToggleTarget,
  busyKey,
  updates,
  selectedIds,
  onToggleSelect,
  onClearSelection,
  onBulkSync,
  onBulkRemove,
  updateCount,
  onUpdateAll,
}) {
  const selectionCount = selectedIds.size;
  return (
    <div>
      {selectionCount > 0 ? (
        <BatchToolbar
          count={selectionCount}
          targets={targets}
          busy={busyKey === "batch"}
          onBulkSync={onBulkSync}
          onBulkRemove={onBulkRemove}
          onClear={onClearSelection}
        />
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <FilterToolbar
            agentFilter={agentFilter}
            agentOptions={agentOptions}
            onAgentFilter={onAgentFilter}
            filteredCount={items.length}
            totalCount={totalCount}
            anyFilter={anyFilter}
            onClearFilters={onClearFilters}
            searchQuery={searchQuery}
            onSearchQuery={onSearchQuery}
            searchPlaceholder={searchPlaceholder}
          />
          {updateCount ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mb-2 shrink-0"
              disabled={busyKey === "update-all"}
              onClick={onUpdateAll}
            >
              {busyKey === "update-all" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden />
              )}
              {copy("skills.update.all_action", { count: updateCount })}
            </Button>
          ) : null}
        </div>
      )}
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center text-sm text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
          <p>{copy("skills.empty.no_match")}</p>
          <Button type="button" variant="secondary" size="sm" onClick={onClearFilters}>
            {copy("skills.filter.clear")}
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-oai-gray-200/70 dark:divide-oai-gray-800/70">
          {items.map((skill) => (
            <SkillRow
              key={skillIdentity(skill)}
              skill={skill}
              targets={targets}
              selected={selectedId === (skill.id || skill.directory)}
              onSelect={onSelect}
              selectable={!skill.readOnly && !skill.remote}
              checked={selectedIds.has(skillIdentity(skill))}
              onToggleSelect={onToggleSelect}
              onToggleTarget={onToggleTarget}
              hasUpdate={Boolean(skill.id && updates?.[skill.id])}
              busyKey={busyKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const BROWSE_CARD_STYLE = {
  contentVisibility: "auto",
  containIntrinsicSize: "0 240px",
};

const BrowseCard = React.memo(function BrowseCard({ skill, installed, installing, allTargets, defaultTargets, onInstall, onManage }) {
  const [selectedTargets, setSelectedTargets] = useState(() =>
    (defaultTargets || []).filter((id) => allTargets.some((t) => t.id === id)),
  );

  const toggleTarget = (id) => {
    setSelectedTargets((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  };

  const sourceLabel = skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : null;
  const sourceHref = sourceLabel ? `https://github.com/${skill.repoOwner}/${skill.repoName}` : null;
  const installsLabel = skill.installs != null
    ? copy("skills.card.installs", { count: Number(skill.installs || 0).toLocaleString() })
    : null;
  const targetSummary = selectedTargets.length
    ? selectedTargets
        .map((id) => allTargets.find((t) => t.id === id)?.label || id)
        .join(", ")
    : copy("skills.action.choose_targets");

  return (
    <Card
      className="h-full rounded-lg"
      bodyClassName="flex h-full flex-col"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {skill.readmeUrl ? (
            <a
              href={skill.readmeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex max-w-full items-center gap-1 truncate text-base font-semibold text-oai-black hover:underline dark:text-white"
              title={skill.readmeUrl}
            >
              <span className="truncate">{skill.name || skill.directory}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-oai-gray-400 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
            </a>
          ) : (
            <h2 className="truncate text-base font-semibold text-oai-black dark:text-white">
              {skill.name || skill.directory}
            </h2>
          )}
          {(sourceLabel || installsLabel) ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 truncate text-xs text-oai-gray-500 dark:text-oai-gray-400">
              {sourceHref ? (
                <a
                  href={sourceHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  className="inline-flex items-center gap-1 truncate rounded text-oai-gray-500 hover:text-oai-black hover:underline focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:text-oai-gray-400 dark:hover:text-white"
                  title={sourceHref}
                >
                  <span className="truncate">{sourceLabel}</span>
                  <ExternalLink className="h-2.5 w-2.5 shrink-0" aria-hidden />
                </a>
              ) : null}
              {sourceLabel && installsLabel ? <span aria-hidden>·</span> : null}
              {installsLabel ? <span className="truncate">{installsLabel}</span> : null}
            </div>
          ) : null}
        </div>
      </div>

      {skill.description ? (
        <p className="mt-3 line-clamp-3 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">
          {skill.description}
        </p>
      ) : null}

      <div className="mt-auto pt-5">
        {installed ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onManage?.(skill)}
            className="w-full"
          >
            <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" aria-hidden />
            {copy("skills.card.manage")}
          </Button>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
              <span className="text-oai-gray-500 dark:text-oai-gray-400">
                {copy("skills.card.targets_prefix")}
              </span>
              <span className="min-w-0 truncate font-medium text-oai-black dark:text-white">
                {selectedTargets.length ? targetSummary : copy("skills.target.none")}
              </span>
              <Popover.Root>
                <Popover.Trigger
                  disabled={installing}
                  aria-label={copy("skills.action.choose_targets")}
                  className="rounded text-xs font-medium text-oai-gray-500 underline decoration-oai-gray-300 decoration-dotted underline-offset-2 transition hover:text-oai-black hover:decoration-oai-gray-500 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 disabled:cursor-not-allowed disabled:opacity-60 dark:text-oai-gray-400 dark:decoration-oai-gray-600 dark:hover:text-white dark:hover:decoration-oai-gray-400"
                >
                  {copy("skills.card.targets_change")}
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner sideOffset={6} side="bottom" align="end" className="!z-[80]">
                    <Popover.Popup className="min-w-[220px] rounded-lg bg-white p-1.5 shadow-lg ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800">
                      <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400">
                        {copy("skills.target.menu_label")}
                      </div>
                      {allTargets.map((target) => {
                        const checked = selectedTargets.includes(target.id);
                        return (
                          <label
                            key={target.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-oai-black hover:bg-oai-gray-100 dark:text-white dark:hover:bg-oai-gray-800"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 shrink-0 rounded border-oai-gray-300 text-oai-black focus:ring-oai-gray-400 dark:border-oai-gray-600 dark:bg-oai-gray-900 dark:text-white"
                              checked={checked}
                              onChange={() => toggleTarget(target.id)}
                            />
                            <ProviderIcon provider={target.id} size={16} />
                            <span className="flex-1 text-left">{target.label}</span>
                          </label>
                        );
                      })}
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => onInstall(skill, selectedTargets)}
              disabled={installing || selectedTargets.length === 0}
              className="w-full"
            >
              {installing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              )}
              {copy("skills.action.install")}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
});

function RepoManager({ repos, repoInput, onRepoInput, busyKey, onAdd, onRemove }) {
  return (
    <div className="rounded-lg border border-oai-gray-200 bg-white p-4 dark:border-oai-gray-800 dark:bg-oai-gray-950">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={repoInput}
          onChange={(event) => onRepoInput(event.target.value)}
          placeholder={copy("skills.repo.placeholder")}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          size="md"
          onClick={onAdd}
          disabled={busyKey === "repo:add"}
          className="shrink-0 whitespace-nowrap"
        >
          {busyKey === "repo:add" ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          {copy("skills.repo.add")}
        </Button>
      </div>
      {repos.length ? (
        <div className="mt-3 divide-y divide-oai-gray-200/70 dark:divide-oai-gray-800/70">
          {repos.map((repo) => {
            const removing = busyKey === `repo:${repo.owner}/${repo.name}`;
            return (
              <div key={`${repo.owner}/${repo.name}`} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-oai-black dark:text-white">
                    {repo.owner}/{repo.name}
                  </div>
                  <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400">{repo.branch}</div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={removing}
                  onClick={() => onRemove(repo)}
                  className="shrink-0"
                >
                  {removing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  )}
                  <span className="sr-only">{copy("skills.repo.remove")}</span>
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function readTabFromUrl() {
  if (typeof window === "undefined") return "my";
  const params = new URLSearchParams(window.location.search);
  return params.get("tab") === "browse" ? "browse" : "my";
}

export function SkillsPage() {
  const auth = useInsforgeAuth() || {};
  const signedIn = Boolean(auth.signedIn);
  const getAccessToken = auth.getAccessToken;
  const [tab, setTab] = useState(readTabFromUrl);
  const [installedData, setInstalledData] = useState({ skills: [], targets: [] });
  const [discoverData, setDiscoverData] = useState([]);
  const [searchData, setSearchData] = useState([]);
  const [repos, setRepos] = useState([]);
  const [source, setSource] = useState(SOURCE_ALL);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [myQuery, setMyQuery] = useState("");
  const [myDebouncedQuery, setMyDebouncedQuery] = useState("");
  const [repoInput, setRepoInput] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [agentFilter, setAgentFilter] = useState("all");
  const [selectedSkillId, setSelectedSkillId] = useState(null);
  const [busyKey, setBusyKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingRemove, setPendingRemove] = useState(null);
  const [pendingBulkRemove, setPendingBulkRemove] = useState(null); // array of skills
  const [pendingUpdateAll, setPendingUpdateAll] = useState(null); // array of stale skill ids
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [updates, setUpdates] = useState({}); // skillId -> bool
  const [usageBySkill, setUsageBySkill] = useState({}); // lowercased dir/name -> usage entry
  const [popularData, setPopularData] = useState([]);
  const [popularLoading, setPopularLoading] = useState(false);
  const appliedSkillParam = useRef(false);
  const cloudInventoryRequest = useRef(0);

  const installedKeys = useMemo(() => {
    return buildLocallyInstalledKeys(installedData.skills);
  }, [installedData.skills]);

  const loadInstalled = useCallback(async () => {
    const requestId = ++cloudInventoryRequest.current;
    const data = await getInstalledSkills();
    if (cloudInventoryRequest.current !== requestId) return;
    const localData = { skills: data.skills || [], targets: data.targets || [] };
    setInstalledData(localData);

    const deviceId = getCurrentDeviceId();
    if (!signedIn || !getCloudSyncEnabled() || !deviceId || typeof getAccessToken !== "function") return;
    // Cloud inventory is a best-effort enrichment. Local Skills render
    // immediately and remain usable if auth/network/backend sync is unavailable.
    void (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken || cloudInventoryRequest.current !== requestId) return;
        const [cloudResult] = await Promise.allSettled([
          getAccountSkillInventories(accessToken),
          publishSkillInventory({ accessToken, deviceId, skills: localData.skills }),
        ]);
        if (cloudResult.status !== "fulfilled") return;
        const cloud = cloudResult.value;
        if (cloudInventoryRequest.current !== requestId) return;
        setInstalledData({
          targets: localData.targets,
          skills: mergeSkillInventories(localData.skills, cloud, deviceId),
        });
      } catch (_e) {
        // Deliberately silent: a cloud outage must not break local management.
      }
    })();
  }, [getAccessToken, signedIn]);

  const loadRepos = useCallback(async () => {
    const data = await getSkillRepos();
    setRepos(data.repos || []);
  }, []);

  const loadDiscover = useCallback(async ({ force = false } = {}) => {
    setBrowseLoading(true);
    try {
      const data = await discoverSkills({ force });
      setDiscoverData(data.skills || []);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const loadPopular = useCallback(async ({ force = false } = {}) => {
    setPopularLoading(true);
    try {
      const data = await getPopularSkills({ force });
      setPopularData(data.skills || []);
    } finally {
      setPopularLoading(false);
    }
  }, []);

  // Update + usage signals are best-effort enrichments for the My tab — a failure
  // (e.g. GitHub rate limit) must never block the core list.
  const loadUpdates = useCallback(async () => {
    try {
      const data = await checkSkillUpdates();
      setUpdates(data?.updates || {});
    } catch (_e) {
      // Keep the verdicts we already have: clearing them here takes away both
      // the badges and the Update all button, so a rate-limited user is left
      // with nothing to retry.
    }
  }, []);

  // Drop verdicts for skills that no longer exist, so nothing a user just
  // removed can keep counting toward "Update all".
  const forgetUpdates = useCallback((ids) => {
    const gone = new Set((ids || []).filter(Boolean));
    if (!gone.size) return;
    setUpdates((prev) => {
      if (!Object.keys(prev).some((id) => gone.has(id))) return prev;
      const next = {};
      for (const [id, stale] of Object.entries(prev)) if (!gone.has(id)) next[id] = stale;
      return next;
    });
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const data = await getSkillUsage();
      const map = {};
      for (const entry of data?.skills || []) {
        if (entry.installed) {
          if (entry.directory) map[String(entry.directory).toLowerCase()] = entry;
          map[String(entry.skill).toLowerCase()] = entry;
        }
      }
      setUsageBySkill(map);
    } catch (_e) {
      setUsageBySkill({});
    }
  }, []);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadInstalled(), loadRepos()]);
    } catch (err) {
      setError(err?.message || copy("skills.error.generic"));
    } finally {
      setLoading(false);
    }
  }, [loadInstalled, loadRepos]);

  const handleRefresh = useCallback(async () => {
    await loadInitial();
    const fail = (err) => setError(err?.message || copy("skills.error.generic"));
    if (tab === "my") {
      loadUpdates();
      loadUsage();
    } else if (source === SOURCE_POPULAR) {
      loadPopular({ force: true }).catch(fail);
    } else if (source !== SOURCE_SKILLSSH) {
      loadDiscover({ force: true }).catch(fail);
    }
  }, [loadDiscover, loadInitial, loadPopular, loadUpdates, loadUsage, source, tab]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Deep-link from the command palette: ?skill=<directory|id> opens that skill's
  // detail panel once the installed list has loaded, then strips the param.
  useEffect(() => {
    if (appliedSkillParam.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const want = params.get("skill");
    if (!want) {
      appliedSkillParam.current = true;
      return;
    }
    const list = installedData.skills || [];
    if (!list.length) return; // wait for the first load
    const match = list.find((s) => s.directory === want || s.id === want);
    if (match) {
      setTab("my");
      setSelectedSkillId(match.id || match.directory);
    }
    appliedSkillParam.current = true;
    params.delete("skill");
    const search = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
    );
  }, [installedData.skills]);

  useEffect(() => {
    if (tab !== "browse") return;
    if (source === SOURCE_SKILLSSH || source === SOURCE_POPULAR) return;
    if (discoverData.length === 0) {
      loadDiscover().catch((err) => setError(err?.message || copy("skills.error.generic")));
    }
  }, [discoverData.length, loadDiscover, source, tab]);

  // Popular = skills.sh search results aggregated by install count (no leaderboard
  // endpoint exists), loaded lazily on first switch to the Popular source.
  useEffect(() => {
    if (tab !== "browse" || source !== SOURCE_POPULAR) return;
    if (popularData.length === 0) {
      loadPopular().catch((err) => setError(err?.message || copy("skills.error.generic")));
    }
  }, [loadPopular, popularData.length, source, tab]);

  // Enrich the My tab with update + usage signals. Loaded once (guarded on
  // emptiness like the discover/popular effects) so toggling tabs doesn't refetch;
  // handleRefresh forces a reload. Best-effort: never surfaced as a hard error.
  const hasUpdatesLoaded = Object.keys(updates).length > 0;
  const hasUsageLoaded = Object.keys(usageBySkill).length > 0;
  useEffect(() => {
    if (tab !== "my") return;
    if (!hasUpdatesLoaded) loadUpdates();
    if (!hasUsageLoaded) loadUsage();
  }, [tab, hasUpdatesLoaded, hasUsageLoaded, loadUpdates, loadUsage]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => setMyDebouncedQuery(myQuery), 120);
    return () => clearTimeout(timer);
  }, [myQuery]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const current = params.get("tab");
    if (tab === "my") {
      if (!current) return;
      params.delete("tab");
    } else {
      if (current === tab) return;
      params.set("tab", tab);
    }
    const search = params.toString();
    const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, [tab]);

  // Skills are scanned from local directories (~/.claude/skills etc.) by the
  // CLI — there's no cloud source. On the deployed web app, surface the
  // local-only notice instead of an empty list. (Placed after all hooks so
  // hook order stays stable across renders.)
  if (!IS_LOCAL_HOST && !isMockEnabled()) {
    return (
      <div className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
        <LocalOnlyNotice />
      </div>
    );
  }

  const runMutation = async (key, task) => {
    setBusyKey(key);
    setError("");
    try {
      await task();
      await loadInstalled();
    } catch (err) {
      setError(err?.message || copy("skills.error.generic"));
    } finally {
      setBusyKey("");
    }
  };

  const handleInstall = (skill, targets) => {
    const finalTargets = (targets && targets.length ? targets : DEFAULT_TARGETS).filter(
      (id) => (installedData.targets || []).some((t) => t.id === id),
    );
    runMutation(installBusyKey(skill), async () => {
      await installSkill(skill, finalTargets);
      const labels = finalTargets
        .map((id) => (installedData.targets || []).find((t) => t.id === id)?.label || id)
        .join(", ");
      showToast({
        title: copy("skills.toast.installed", {
          name: skill.name || skill.directory,
          targets: labels || copy("skills.target.none"),
        }),
        timeout: 4000,
      });
    });
  };

  const handleRemove = (skill) => {
    if (skill?.readOnly || skill?.remote) return;
    setPendingRemove(skill);
  };

  const confirmRemove = () => {
    const skill = pendingRemove;
    if (!skill) return;
    setPendingRemove(null);
    runMutation(removeBusyKey(skill), async () => {
      let result = null;
      if (skill.managed) {
        result = await uninstallSkill(skill.id);
      } else {
        await deleteLocalSkill(skill.directory, skill.targets || []);
      }
      forgetUpdates([skill.id]);
      const canUndo = Boolean(result?.trashed && skill.managed && skill.id);
      showToast({
        title: copy("skills.toast.removed", { name: skill.name || skill.directory }),
        timeout: 6000,
        data: canUndo
          ? {
              onUndo: async () => {
                try {
                  await restoreSkill(skill.id);
                  await loadInstalled();
                } catch (err) {
                  setError(err?.message || copy("skills.error.generic"));
                }
              },
            }
          : undefined,
      });
    });
  };

  const handleToggleTarget = (skill, targetId, enabled) => {
    if (skill?.readOnly || skill?.remote) return Promise.resolve();
    return runMutation(targetBusyKey(skillIdentity(skill), targetId), async () => {
      const next = new Set(skill.targets || []);
      if (enabled) next.add(targetId);
      else next.delete(targetId);
      if (skill.managed) {
        await setSkillTargets(skill.id, Array.from(next));
      } else {
        // Unmanaged → promote to managed via importLocalSkill so toggling any
        // target updates registry + SSOT uniformly.
        await importLocalSkill(skill.directory, Array.from(next));
      }
      const toastVars = { name: skill.name || skill.directory, agent: targetLabelFor(targetId) };
      showToast({
        title: enabled
          ? copy("skills.toast.synced_one", toastVars)
          : copy("skills.toast.unsynced_one", toastVars),
        timeout: 3000,
      });
    });
  };

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleToggleSelect = useCallback((skill, checked) => {
    if (skill?.readOnly || skill?.remote) return;
    const id = skillIdentity(skill);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const targetLabelFor = (targetId) =>
    (installedData.targets || []).find((t) => t.id === targetId)?.label || targetId;

  const handleBulkSync = (targetId) => {
    const list = (installedData.skills || []).filter(
      (s) => selectedIds.has(skillIdentity(s)) && !s.readOnly && !s.remote,
    );
    if (!list.length) return;
    runMutation("batch", async () => {
      for (const skill of list) {
        const next = new Set(skill.targets || []);
        next.add(targetId);
        // Unmanaged skills get promoted + synced via importLocalSkill (same path
        // as a single-dot toggle); managed ones just update their target set.
        if (skill.managed) await setSkillTargets(skill.id, Array.from(next));
        else await importLocalSkill(skill.directory, Array.from(next));
      }
      clearSelection();
      showToast({
        title: copy("skills.toast.bulk_synced", { count: list.length, agent: targetLabelFor(targetId) }),
        timeout: 4000,
      });
    });
  };

  const handleBulkRemove = () => {
    const list = (installedData.skills || []).filter(
      (s) => selectedIds.has(skillIdentity(s)) && !s.readOnly && !s.remote,
    );
    if (list.length) setPendingBulkRemove(list);
  };

  const confirmBulkRemove = () => {
    const list = pendingBulkRemove;
    if (!list) return;
    setPendingBulkRemove(null);
    runMutation("batch", async () => {
      for (const skill of list) {
        if (skill.managed) await uninstallSkill(skill.id);
        else await deleteLocalSkill(skill.directory, skill.targets || []);
      }
      forgetUpdates(list.map((skill) => skill.id));
      clearSelection();
      showToast({
        title: copy("skills.toast.bulk_removed", { count: list.length }),
        timeout: 4000,
      });
    });
  };

  // Apply an upstream update by re-installing the same skill (overwrites the SSOT
  // copy + re-syncs to its targets, then refreshes the update signal). Routed
  // through the same call as Update all so both take targets from the registry's
  // intent rather than from whichever agent dirs happen to resolve on disk.
  const handleUpdate = (skill) => {
    if (!skill?.id || !skill?.repoOwner || !skill?.repoName) return;
    runMutation(installBusyKey(skill), async () => {
      const result = await updateSkills([skill.id]);
      await loadUpdates();
      const { results = [], rateLimited = null, updated = 0 } = result || {};
      // A rate limit comes back as a field rather than a throw, so it has to be
      // branched on first — same order as Update all. Without it a 403 read as
      // "Updated {{name}}" while the badge stayed up.
      if (rateLimited) {
        showToast({ title: copy("skills.update.rate_limited", { count: updated }), timeout: 6000 });
        return;
      }
      const row = results[0];
      if (!row || !row.ok) throw new Error(row?.error || copy("skills.error.generic"));
      showToast({
        title: copy("skills.toast.updated", { name: skill.name || skill.directory }),
        timeout: 4000,
      });
    });
  };

  // `updates` records every checked skill, false entries included — counting keys
  // would report how many were checked, not how many are stale. Intersecting with
  // what is installed keeps a verdict stranded by a removal (or any other
  // registry change) from inflating the count. Deliberately not a useMemo: the
  // local-only early return above sits between this and the hooks.
  const installedSkillIds = new Set((installedData.skills || []).map((skill) => skill.id).filter(Boolean));
  const staleUpdateIds = Object.entries(updates)
    .filter(([id, stale]) => stale && installedSkillIds.has(id))
    .map(([id]) => id);
  const updateCount = staleUpdateIds.length;

  const handleUpdateAll = () => {
    if (!staleUpdateIds.length) return;
    setPendingUpdateAll(staleUpdateIds);
  };

  const confirmUpdateAll = () => {
    const ids = pendingUpdateAll;
    setPendingUpdateAll(null);
    if (!ids || !ids.length) return;
    runMutation("update-all", async () => {
      const result = await updateSkills(ids);
      await loadUpdates();
      const { updated = 0, failed = 0, rateLimited = null, results = [] } = result || {};
      // Total is the rows the backend actually returned, so updated + failed
      // always reconciles with it — ids it could not match report as failures
      // rather than vanishing from the arithmetic.
      const attempted = results.length;
      if (rateLimited) {
        showToast({ title: copy("skills.update.rate_limited", { count: updated }), timeout: 6000 });
      } else if (failed > 0) {
        showToast({
          title: copy("skills.toast.updated_partial", { count: updated, total: attempted, failed }),
          timeout: 6000,
        });
      } else if (updated === 0) {
        showToast({ title: copy("skills.toast.updated_none"), timeout: 4000 });
      } else if (updated === 1) {
        const only = results.find((item) => item.ok && !item.skipped);
        showToast({
          title: copy("skills.toast.updated", { name: only?.name || "" }),
          timeout: 4000,
        });
      } else {
        showToast({ title: copy("skills.toast.updated_many", { count: updated }), timeout: 4000 });
      }
    });
  };

  const handleSearch = async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setBusyKey("search");
    setError("");
    try {
      const data = await searchSkills(trimmed);
      setSearchData(data.skills || []);
    } catch (err) {
      setError(err?.message || copy("skills.error.generic"));
    } finally {
      setBusyKey("");
    }
  };

  const handleAddRepo = async () => {
    const raw = repoInput.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    const [owner, name] = raw.split("/");
    if (!owner || !name) {
      setError(copy("skills.repo.invalid"));
      return;
    }
    await runMutation("repo:add", async () => {
      await addSkillRepo({ owner, name, branch: "main", enabled: true });
      setRepoInput("");
      await loadRepos();
      await loadDiscover();
    });
  };

  const handleRemoveRepo = async (repo) => {
    await runMutation(`repo:${repo.owner}/${repo.name}`, async () => {
      await removeSkillRepo(repo.owner, repo.name);
      await loadRepos();
      await loadDiscover();
    });
  };

  const targets = installedData.targets || [];
  const manageableTargets = targets.filter(isManageableTarget);
  const mySkills = installedData.skills || [];

  const filteredMySkills = useMemo(() => {
    const byAgent =
      agentFilter === "all"
        ? mySkills
        : mySkills.filter((skill) => (skill.targets || []).includes(agentFilter));
    const q = myDebouncedQuery.trim().toLowerCase();
    if (!q) return byAgent;
    return byAgent.filter(
      (skill) =>
        (skill.name || "").toLowerCase().includes(q) ||
        (skill.directory || "").toLowerCase().includes(q) ||
        (skill.description || "").toLowerCase().includes(q),
    );
  }, [mySkills, agentFilter, myDebouncedQuery]);

  // Search is not a "filter": the search box owns its own clear (×). The
  // toolbar "Clear filters" pill is gated on the agent filter only, so typing
  // a query never makes it appear.
  const myAnyFilter = agentFilter !== "all";

  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) return null;
    return mySkills.find((s) => (s.id || s.directory) === selectedSkillId) || null;
  }, [mySkills, selectedSkillId]);

  const handleClearMyFilters = useCallback(() => {
    setAgentFilter("all");
    setMyQuery("");
  }, []);

  const handleSelectSkill = useCallback((skill) => {
    setSelectedSkillId((prev) => {
      const next = skill?.id || skill?.directory || null;
      return prev === next ? null : next;
    });
  }, []);

  const handleCloseDetail = useCallback(() => setSelectedSkillId(null), []);

  // "Manage" on an installed browse/popular card: open that skill's detail panel
  // in place (sync targets, usage, remove) without leaving the current tab.
  const handleManage = useCallback(
    (browseSkill) => {
      const fullKey = getSkillKey(browseSkill).toLowerCase();
      const fallbackKey = browseDirectoryFallbackKey(browseSkill);
      const match = (installedData.skills || []).find(
        (skill) => {
          const keys = installedSkillKeys(skill);
          return keys.has(fullKey) || (fallbackKey && keys.has(fallbackKey));
        },
      );
      if (match) setSelectedSkillId(match.id || match.directory);
    },
    [installedData.skills],
  );

  // Multi-select is My-tab only; drop it when leaving. The detail panel may stay
  // open on either tab (Browse "Manage" opens it in place).
  useEffect(() => {
    if (tab !== "my" && selectedIds.size) setSelectedIds(new Set());
  }, [tab, selectedIds.size]);
  useEffect(() => {
    if (selectedSkillId && !selectedSkill) setSelectedSkillId(null);
  }, [selectedSkill, selectedSkillId]);

  const browseItems = useMemo(() => {
    const pool =
      source === SOURCE_SKILLSSH ? searchData : source === SOURCE_POPULAR ? popularData : discoverData;
    // skills.sh-backed sources (search, popular) are already server-ranked; only
    // the repo sources get the per-repo dropdown filter applied.
    const serverRanked = source === SOURCE_SKILLSSH || source === SOURCE_POPULAR;
    const filtered = serverRanked || source === SOURCE_ALL
      ? pool
      : pool.filter((skill) => `${skill.repoOwner}/${skill.repoName}` === source);
    const q = debouncedQuery.trim().toLowerCase();
    const matched = source === SOURCE_SKILLSSH || !q
      ? filtered
      : filtered.filter((skill) =>
          (skill.name || "").toLowerCase().includes(q) ||
          (skill.directory || "").toLowerCase().includes(q) ||
          (skill.description || "").toLowerCase().includes(q));
    return matched.map((skill) => {
      const fullKey = getSkillKey(skill).toLowerCase();
      const dirKey = browseDirectoryFallbackKey(skill);
      return {
        ...skill,
        installed: installedKeys.has(fullKey) || (dirKey && installedKeys.has(dirKey)),
      };
    });
  }, [debouncedQuery, discoverData, installedKeys, popularData, searchData, source]);

  const loadingNode = (
    <div className="flex h-64 items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-oai-gray-400" aria-hidden />
    </div>
  );
  const browseLoadingNode = (
    <div className="flex h-64 flex-col items-center justify-center gap-3 px-6 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-oai-gray-400" aria-hidden />
      <p className="max-w-md text-xs text-oai-gray-500 dark:text-oai-gray-400">
        {copy("skills.browse.loading_hint")}
      </p>
    </div>
  );
  const emptyNode = (key, action = null) => (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center text-sm text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
      <p>{copy(key)}</p>
      {action}
    </div>
  );

  let contentNode;
  if (loading) {
    contentNode = loadingNode;
  } else if (tab === "my") {
    contentNode = mySkills.length ? (
      <MySkillsView
        items={filteredMySkills}
        totalCount={mySkills.length}
        targets={targets}
        agentOptions={targets}
        agentFilter={agentFilter}
        onAgentFilter={setAgentFilter}
        anyFilter={myAnyFilter}
        onClearFilters={handleClearMyFilters}
        searchQuery={myQuery}
        onSearchQuery={setMyQuery}
        searchPlaceholder={copy("skills.my.placeholder")}
        selectedId={selectedSkillId}
        onSelect={handleSelectSkill}
        onToggleTarget={handleToggleTarget}
        busyKey={busyKey}
        updates={updates}
        selectedIds={selectedIds}
        onToggleSelect={handleToggleSelect}
        onClearSelection={clearSelection}
        onBulkSync={handleBulkSync}
        onBulkRemove={handleBulkRemove}
        updateCount={updateCount}
        onUpdateAll={handleUpdateAll}
      />
    ) : (
      <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center dark:border-oai-gray-800">
        {targets.length > 0 ? (
          <div className="relative h-11 w-80 overflow-hidden" aria-hidden>
            {/* Blurred icons — masked to mid-edge transition zones (skips center) */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                maskImage:
                  "linear-gradient(to right, transparent 8%, black 20%, black 32%, transparent 44%, transparent 56%, black 68%, black 80%, transparent 92%)",
                WebkitMaskImage:
                  "linear-gradient(to right, transparent 8%, black 20%, black 32%, transparent 44%, transparent 56%, black 68%, black 80%, transparent 92%)",
              }}
            >
              <div
                className="absolute inset-y-0 left-0 flex w-max items-center animate-marquee-x"
                style={{ filter: "blur(2.5px)" }}
              >
                {[...targets, ...targets].map((target, i) => (
                  <span key={`b-${i}`} className="shrink-0 px-3">
                    <ProviderIcon provider={target.id} size={30} />
                  </span>
                ))}
              </div>
            </div>
            {/* Clear icons — masked to center */}
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                maskImage:
                  "linear-gradient(to right, transparent 28%, black 42%, black 58%, transparent 72%)",
                WebkitMaskImage:
                  "linear-gradient(to right, transparent 28%, black 42%, black 58%, transparent 72%)",
              }}
            >
              <div className="absolute inset-y-0 left-0 flex w-max items-center animate-marquee-x">
                {[...targets, ...targets].map((target, i) => (
                  <span key={`c-${i}`} className="shrink-0 px-3">
                    <ProviderIcon provider={target.id} size={30} />
                  </span>
                ))}
              </div>
            </div>
            {/* Background color fade — left edge */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 w-20 bg-gradient-to-r from-oai-white to-transparent dark:from-oai-gray-900"
            />
            {/* Background color fade — right edge */}
            <div
              className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-oai-white to-transparent dark:from-oai-gray-900"
            />
          </div>
        ) : null}
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
          {copy("skills.empty.my")}
        </p>
        <Button type="button" size="sm" onClick={() => setTab("browse")}>
          {copy("skills.empty.my_cta")}
        </Button>
      </div>
    );
  } else {
    // Browse
    const isSkillsSh = source === SOURCE_SKILLSSH;
    const isPopular = source === SOURCE_POPULAR;
    const noSources = repos.length === 0 && !isSkillsSh && !isPopular;
    const browseBusy = (browseLoading && !isSkillsSh && !isPopular) || (isPopular && popularLoading);
    const browseAnyFilter = !isSkillsSh && !isPopular && (debouncedQuery.trim() !== "" || source !== SOURCE_ALL);
    const handleClearBrowseFilters = () => {
      setQuery("");
      setSource(SOURCE_ALL);
    };

    const countNode =
      !noSources && !browseBusy && (browseItems.length > 0 || browseAnyFilter) ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <span>
            {copy("skills.filter.result_count_browse", { count: browseItems.length })}
          </span>
          {browseAnyFilter ? (
            <button
              type="button"
              onClick={handleClearBrowseFilters}
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-full bg-oai-gray-100 px-2.5 text-[11px] font-medium text-oai-gray-700 transition hover:bg-oai-gray-200 focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:bg-oai-gray-800/70 dark:text-oai-gray-200 dark:hover:bg-oai-gray-700"
            >
              <XIcon className="h-3 w-3" aria-hidden />
              {copy("skills.filter.clear")}
            </button>
          ) : null}
        </div>
      ) : null;

    let resultNode;
    if (noSources) {
      resultNode = (
        <div className="rounded-lg border border-dashed border-oai-gray-200 p-6 text-center dark:border-oai-gray-800">
          <p className="text-sm text-oai-gray-600 dark:text-oai-gray-300">
            {copy("skills.browse.empty_sources")}
          </p>
        </div>
      );
    } else if (browseBusy) {
      resultNode = browseLoadingNode;
    } else if (isSkillsSh && query.trim().length < 2) {
      resultNode = (
        <div className="rounded-lg border border-dashed border-oai-gray-200 px-4 py-6 text-center text-sm text-oai-gray-500 dark:border-oai-gray-800 dark:text-oai-gray-400">
          {copy("skills.browse.hint_skillssh")}
        </div>
      );
    } else if (browseItems.length) {
      resultNode = (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {browseItems.map((skill) => (
            <div key={skill.id || skill.key} style={BROWSE_CARD_STYLE}>
              <BrowseCard
                skill={skill}
                installed={Boolean(skill.installed)}
                installing={busyKey === installBusyKey(skill)}
                allTargets={manageableTargets}
                defaultTargets={DEFAULT_TARGETS}
                onInstall={handleInstall}
                onManage={handleManage}
              />
            </div>
          ))}
        </div>
      );
    } else if (browseAnyFilter) {
      resultNode = emptyNode(
        "skills.empty.no_match",
        <Button type="button" variant="secondary" size="sm" onClick={handleClearBrowseFilters}>
          {copy("skills.filter.clear")}
        </Button>,
      );
    } else if (isSkillsSh) {
      resultNode = emptyNode("skills.empty.search");
    } else if (isPopular) {
      resultNode = emptyNode("skills.empty.popular");
    } else {
      resultNode = emptyNode("skills.empty.browse");
    }

    const manageNode = noSources || manageOpen ? (
      <div className="mb-5">
        <RepoManager
          repos={repos}
          repoInput={repoInput}
          onRepoInput={setRepoInput}
          busyKey={busyKey}
          onAdd={handleAddRepo}
          onRemove={handleRemoveRepo}
        />
      </div>
    ) : null;

    const hintNode =
      !manageOpen && !isSkillsSh && !isPopular && repos.length <= 1 && browseItems.length > 0 ? (
        <DismissibleHint id="skills-browse-intro" className="mt-6">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{copy("skills.browse.add_repo_hint")}</span>
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              className="rounded font-medium text-oai-gray-700 underline decoration-dotted underline-offset-2 transition hover:text-oai-black focus:outline-none focus:ring-2 focus:ring-oai-gray-400/30 dark:text-oai-gray-200 dark:hover:text-white"
            >
              {copy("skills.browse.manage_sources")}
            </button>
          </div>
        </DismissibleHint>
      ) : null;

    contentNode = (
      <>
        {manageNode}
        {countNode}
        {resultNode}
        {hintNode}
      </>
    );
  }

  return (
    <div className="flex flex-1 flex-col font-oai text-oai-black antialiased dark:text-oai-white">
      <main className="flex-1 pb-12 pt-8 sm:pb-16 sm:pt-10">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="mb-6 flex items-end justify-between gap-4">
            <h1 className="text-3xl font-semibold tracking-tight text-oai-black dark:text-white sm:text-4xl">
              {copy("skills.page.title")}
            </h1>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleRefresh}
              disabled={loading || browseLoading || popularLoading}
            >
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", (loading || browseLoading || popularLoading) && "animate-spin")} aria-hidden />
              {copy("skills.action.refresh")}
            </Button>
          </div>

          <div className="mb-5 flex gap-6 border-b border-oai-gray-200 dark:border-oai-gray-800">
            {[
              ["my", copy("skills.tab.my")],
              ["browse", copy("skills.tab.browse")],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "-mb-px border-b-2 pb-2 text-sm font-medium transition-colors",
                  tab === value
                    ? "border-oai-black text-oai-black dark:border-white dark:text-white"
                    : "border-transparent text-oai-gray-500 hover:text-oai-black dark:text-oai-gray-400 dark:hover:text-white",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          ) : null}

          {tab === "browse" ? (
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
              <SegmentedControl
                className="shrink-0"
                ariaLabel={copy("skills.source.label")}
                options={[
                  { id: "repo", label: copy("skills.mode.repo") },
                  { id: "popular", label: copy("skills.mode.popular"), icon: <Flame className="h-3.5 w-3.5" aria-hidden /> },
                  { id: "skillssh", label: copy("skills.mode.skillssh") },
                ]}
                value={source === SOURCE_SKILLSSH ? "skillssh" : source === SOURCE_POPULAR ? "popular" : "repo"}
                onChange={(next) => {
                  if (next === "skillssh") setSource(SOURCE_SKILLSSH);
                  else if (next === "popular") setSource(SOURCE_POPULAR);
                  else if (source === SOURCE_SKILLSSH || source === SOURCE_POPULAR) setSource(SOURCE_ALL);
                }}
              />
              {source !== SOURCE_SKILLSSH && source !== SOURCE_POPULAR ? (
                <Select.Root value={source} onValueChange={setSource}>
                  <Select.Trigger
                    aria-label={copy("skills.source.label")}
                    className="inline-flex h-8 w-44 shrink-0 items-center justify-between gap-2 rounded-md border border-oai-gray-200 bg-oai-white px-2.5 text-xs text-oai-black focus:outline-none data-[popup-open]:border-oai-gray-300 dark:border-oai-gray-800 dark:bg-oai-gray-900 dark:text-white dark:data-[popup-open]:border-oai-gray-700"
                  >
                    <Select.Value>
                      {(value) => (value === SOURCE_ALL ? copy("skills.source.all") : value)}
                    </Select.Value>
                    <Select.Icon className="text-oai-gray-400">
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-[60]">
                      <Select.Popup className="min-w-[var(--anchor-width)] overflow-hidden rounded-md border border-oai-gray-200 bg-white p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)] outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]">
                        <Select.Item
                          value={SOURCE_ALL}
                          className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
                        >
                          <Select.ItemText>{copy("skills.source.all")}</Select.ItemText>
                          <Select.ItemIndicator>
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          </Select.ItemIndicator>
                        </Select.Item>
                        {repos.map((repo) => {
                          const value = `${repo.owner}/${repo.name}`;
                          return (
                            <Select.Item
                              key={value}
                              value={value}
                              className="flex cursor-default select-none items-center justify-between gap-2 rounded px-3 py-1.5 text-sm text-oai-black outline-none data-[highlighted]:bg-oai-gray-100 dark:text-white dark:data-[highlighted]:bg-oai-gray-800"
                            >
                              <Select.ItemText>{value}</Select.ItemText>
                              <Select.ItemIndicator>
                                <Check className="h-3.5 w-3.5" aria-hidden />
                              </Select.ItemIndicator>
                            </Select.Item>
                          );
                        })}
                      </Select.Popup>
                    </Select.Positioner>
                  </Select.Portal>
                </Select.Root>
              ) : null}
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-oai-gray-400" aria-hidden />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && source === SOURCE_SKILLSSH) handleSearch();
                  }}
                  aria-label={copy("skills.action.search_aria")}
                  placeholder={
                    source === SOURCE_SKILLSSH
                      ? copy("skills.browse.placeholder_skillssh")
                      : source === SOURCE_POPULAR
                        ? copy("skills.browse.placeholder_popular")
                        : source === SOURCE_ALL
                          ? copy("skills.browse.placeholder_all")
                          : copy("skills.browse.placeholder_repo", { repo: source })
                  }
                  className="h-8 pl-9 !border-oai-gray-200 dark:!border-oai-gray-800 focus:!border-oai-gray-400 focus:!ring-oai-gray-400/20 dark:focus:!border-oai-gray-500 dark:focus:!ring-oai-gray-500/20"
                />
              </div>
              {source === SOURCE_SKILLSSH ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSearch}
                  disabled={query.trim().length < 2 || busyKey === "search"}
                  className="focus:!ring-oai-gray-400/30"
                >
                  {busyKey === "search" ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Search className="mr-1.5 h-4 w-4" aria-hidden />
                  )}
                  {copy("skills.action.search")}
                </Button>
              ) : source === SOURCE_POPULAR ? null : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setManageOpen((prev) => !prev)}
                  aria-expanded={manageOpen}
                  className="!h-8 shrink-0 whitespace-nowrap !border-oai-gray-200 dark:!border-oai-gray-800 hover:!border-oai-gray-300 dark:hover:!border-oai-gray-700 hover:!text-oai-black dark:hover:!text-white focus:!ring-oai-gray-400/30"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  {copy("skills.browse.manage_sources")}
                  <span className="ml-1.5 rounded bg-oai-gray-100 px-1.5 py-0.5 text-xs font-medium text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-300">
                    {repos.length}
                  </span>
                </Button>
              )}
            </div>
          ) : null}

          {contentNode}
          <SkillDetailPanel
            skill={selectedSkill}
            targets={targets}
            busyKey={busyKey}
            usage={
              selectedSkill
                ? usageBySkill[String(selectedSkill.directory || "").toLowerCase()] ||
                  usageBySkill[String(selectedSkill.name || "").toLowerCase()] ||
                  null
                : null
            }
            hasUpdate={Boolean(selectedSkill?.id && updates?.[selectedSkill.id])}
            updating={selectedSkill ? busyKey === installBusyKey(selectedSkill) : false}
            onUpdate={handleUpdate}
            onClose={handleCloseDetail}
            onToggleTarget={handleToggleTarget}
            onRemove={handleRemove}
          />
        </div>
      </main>

      <ConfirmModal
        open={Boolean(pendingRemove)}
        title={copy("skills.confirm.remove_title", {
          name: pendingRemove?.name || pendingRemove?.directory || "",
        })}
        description={
          pendingRemove
            ? pendingRemove.managed
              ? copy("skills.confirm.remove_managed")
              : copy("skills.confirm.remove_local")
            : ""
        }
        confirmLabel={copy("skills.action.remove")}
        cancelLabel={copy("shared.action.cancel")}
        destructive
        busy={busyKey === removeBusyKey(pendingRemove || {})}
        onCancel={() => setPendingRemove(null)}
        onConfirm={confirmRemove}
      />

      <ConfirmModal
        open={Boolean(pendingBulkRemove)}
        title={copy("skills.confirm.bulk_remove_title", { count: pendingBulkRemove?.length || 0 })}
        description={copy("skills.confirm.bulk_remove_desc")}
        confirmLabel={copy("skills.action.remove")}
        cancelLabel={copy("shared.action.cancel")}
        destructive
        busy={busyKey === "batch"}
        onCancel={() => setPendingBulkRemove(null)}
        onConfirm={confirmBulkRemove}
      />

      <ConfirmModal
        open={Boolean(pendingUpdateAll)}
        title={copy("skills.confirm.update_all_title", { count: pendingUpdateAll?.length || 0 })}
        description={copy("skills.confirm.update_all_desc")}
        confirmLabel={copy("skills.update.action")}
        cancelLabel={copy("shared.action.cancel")}
        busy={busyKey === "update-all"}
        onCancel={() => setPendingUpdateAll(null)}
        onConfirm={confirmUpdateAll}
      />
    </div>
  );
}
