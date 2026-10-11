import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronDown, Download } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { useInsforgeAuth } from "../../contexts/InsforgeAuthContext.jsx";
import { INSFORGE_INSTANCE_CHANGED_EVENT, isCurrentInsforgeClient } from "../../lib/insforge-config";
import { CloudUsageExportError, fetchCloudUsageExport, downloadCloudUsageExport } from "../../lib/cloud-usage-export";
import { copy } from "../../lib/copy";
import { Button } from "../../ui/components/Button.jsx";
import { CloudActionDialog } from "./CloudActionDialog.jsx";
import { DateRangePopover } from "../../ui/dashboard/components/DateRangePopover.jsx";

function errorText(error) {
  if (error?.status === 401) return copy("cloud.export.error_auth");
  if (error?.status === 402 || error?.status === 403) return copy("cloud.export.error_access");
  if (error?.code === "export_invalid_dates") return copy("cloud.export.error_dates");
  if (error?.status === 409) return copy("cloud.export.error_changed");
  return copy("cloud.export.error_failed");
}

export function CloudUsageExport({ from, to, deviceId = null, auth: providedAuth, compact = false, panelContainer = null, layout = "default", dialogOpen, onDialogOpenChange }) {
  const settingsRow = layout === "settings-row";
  const contextAuth = useInsforgeAuth();
  const auth = providedAuth || contextAuth;
  const userId = auth?.signedIn ? auth.user?.id : null;
  const today = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(from || defaultFrom);
  const [end, setEnd] = useState(to || today);
  const [internalExpanded, setExpanded] = useState(false);
  const expanded = settingsRow && typeof dialogOpen === "boolean" ? dialogOpen : internalExpanded;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonths, setCalendarMonths] = useState(2);
  const id = useId();
  const owner = useRef(null);
  const generation = useRef(0);
  const controller = useRef(null);
  const lock = useRef(false);
  const mounted = useRef(false);
  const visible = useRef(expanded);
  visible.current = expanded;
  const wasOpen = useRef(expanded);
  owner.current = { userId, client: auth?.client, start, end, deviceId, from, to };
  useEffect(() => {
    mounted.current = true;
    const changed = () => { ++generation.current; controller.current?.abort(); lock.current = false;
      setBusy(false); setNotice(null); setError(null); setCalendarOpen(false); };
    window.addEventListener(INSFORGE_INSTANCE_CHANGED_EVENT, changed);
    return () => { mounted.current = false; ++generation.current; controller.current?.abort();
      window.removeEventListener(INSFORGE_INSTANCE_CHANGED_EVENT, changed); };
  }, []);
  useEffect(() => {
    ++generation.current; controller.current?.abort(); lock.current = false;
    setBusy(false); setError(null); setNotice(null); setCalendarOpen(false);
    if (from) setStart(from);
    if (to) setEnd(to);
  }, [userId, auth?.client, from, to, deviceId]);
  useEffect(() => {
    if (settingsRow && wasOpen.current && !expanded) invalidateDownload();
    wasOpen.current = expanded;
  }, [expanded, settingsRow]);
  useEffect(() => {
    const narrow = window.matchMedia?.("(max-width: 639px)");
    if (!narrow) return;
    const update = () => setCalendarMonths(narrow.matches ? 1 : 2);
    update();
    narrow.addEventListener("change", update);
    return () => narrow.removeEventListener("change", update);
  }, []);
  if (!userId || auth?.enabled === false) return null;

  function invalidateDownload() {
    ++generation.current; controller.current?.abort(); lock.current = false;
    setBusy(false); setError(null); setNotice(null); setCalendarOpen(false);
  }

  function changeOpen(next) {
    if (!next) invalidateDownload();
    if (typeof dialogOpen !== "boolean") setExpanded(next);
    onDialogOpenChange?.(next);
  }

  function updateDate(setDate, value) {
    ++generation.current; controller.current?.abort(); lock.current = false;
    setBusy(false); setError(null); setNotice(null); setDate(value);
  }

  async function download(format) {
    if (lock.current) return;
    lock.current = true;
    const captured = owner.current;
    const operation = ++generation.current;
    const signalController = new AbortController();
    controller.current = signalController;
    setBusy(true); setError(null); setNotice(null);
    const check = () => {
      const current = owner.current;
      if (!mounted.current || operation !== generation.current || settingsRow && !visible.current || !current ||
          Object.keys(captured).some(key => captured[key] !== current[key]) ||
          captured.client && !isCurrentInsforgeClient(captured.client))
        throw new CloudUsageExportError("export_cancelled", 409);
    };
    try {
      const data = await fetchCloudUsageExport({ userId: captured.userId, auth: auth.getAccessToken,
        from: captured.start, to: captured.end, deviceId: captured.deviceId,
        signal: signalController.signal, assertCurrent: check });
      check();
      await downloadCloudUsageExport(data, format, { signal: signalController.signal, assertCurrent: check });
      check();
      const range = data.metadata.effective_range;
      const message = data.rows.length ? copy("cloud.export.success", { count: data.rows.length, from: range.from, to: range.to })
        : copy("cloud.export.empty");
      setNotice(range.from !== captured.start || range.to !== captured.end
        ? `${message} ${copy("cloud.export.truncated", { from: range.from, to: range.to })}` : message);
    } catch (reason) {
      if (mounted.current && operation === generation.current) setError(errorText(reason));
    } finally {
      if (operation === generation.current) { lock.current = false; if (mounted.current) setBusy(false); }
    }
  }
  const neutral = "hover:!text-oai-black dark:hover:!text-oai-white hover:!bg-oai-gray-100 dark:hover:!bg-oai-gray-800 focus:!ring-oai-gray-500/40";
  let panel = null;
  if (settingsRow || expanded) {
    panel = <div id={id} className={settingsRow ? undefined : compact ? "w-full rounded-lg bg-oai-gray-50 p-4 dark:bg-oai-gray-950/50" : "mt-2 border-l-2 border-oai-gray-200 pl-3 dark:border-oai-gray-700"} aria-busy={busy}>
      {!settingsRow ? <p className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-300">{copy("cloud.export.description")}</p> : null}
      <div className={settingsRow ? "space-y-4" : "mt-3 flex flex-wrap items-end gap-3"}>
        {settingsRow ? <Popover.Root open={calendarOpen} onOpenChange={setCalendarOpen}>
          <Popover.Trigger disabled={busy} aria-label={copy("trend.zoom.pick_range")}
            className="inline-flex h-10 min-h-10 w-full items-center gap-2 rounded-md border border-oai-gray-300 bg-transparent px-3 text-sm text-oai-black transition-colors hover:bg-oai-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-oai-gray-500 disabled:opacity-50 dark:border-oai-gray-700 dark:text-oai-white dark:hover:bg-oai-gray-800">
            <CalendarDays size={16} className="shrink-0 text-oai-gray-500" aria-hidden />
            <span className="flex-1 text-left tabular-nums">{start} → {end}</span>
            <ChevronDown size={14} className="shrink-0 text-oai-gray-500" aria-hidden />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={8} side="bottom" align="start" className="z-[110]">
              <Popover.Popup className="max-w-[calc(100vw-2rem)] rounded-xl border border-oai-gray-200 bg-white shadow-lg outline-none dark:border-oai-gray-700 dark:bg-oai-gray-900">
                <DateRangePopover from={start} to={end} numberOfMonths={calendarMonths}
                  onApply={(nextFrom, nextTo) => {
                    updateDate(setStart, nextFrom); setEnd(nextTo); setCalendarOpen(false);
                  }} onCancel={() => setCalendarOpen(false)} />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root> : <>
        <label className="min-w-0 text-xs text-oai-gray-700 dark:text-oai-gray-200">{copy("cloud.export.from")}
          <input type="date" value={start} onChange={event => updateDate(setStart, event.target.value)}
            className={`${settingsRow ? "min-h-10 min-w-0 w-full " : ""}mt-1 block rounded-md border border-oai-gray-300 bg-white px-2 py-1.5 text-sm text-oai-black focus:outline-none focus:ring-2 focus:ring-inset focus:ring-oai-gray-500/40 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white`} />
        </label>
        <label className="min-w-0 text-xs text-oai-gray-700 dark:text-oai-gray-200">{copy("cloud.export.to")}
          <input type="date" value={end} onChange={event => updateDate(setEnd, event.target.value)}
            className={`${settingsRow ? "min-h-10 min-w-0 w-full " : ""}mt-1 block rounded-md border border-oai-gray-300 bg-white px-2 py-1.5 text-sm text-oai-black focus:outline-none focus:ring-2 focus:ring-inset focus:ring-oai-gray-500/40 dark:border-oai-gray-700 dark:bg-oai-gray-900 dark:text-oai-white`} />
        </label>
        </>}
        <div className={settingsRow ? "flex justify-end gap-2" : "flex gap-2"}>
          <Button type="button" variant={settingsRow ? "secondary" : "ghost"} size="sm" className={`${neutral} ${settingsRow ? "!min-h-8 !h-8" : ""}`} disabled={busy} onClick={() => download("csv")}>{copy("cloud.export.csv")}</Button>
          <Button type="button" variant={settingsRow ? "secondary" : "ghost"} size="sm" className={`${neutral} ${settingsRow ? "!min-h-8 !h-8" : ""}`} disabled={busy} onClick={() => download("json")}>{copy("cloud.export.json")}</Button>
        </div>
      </div>
      {busy ? <p role="status" className="mt-2 text-xs text-oai-gray-600 dark:text-oai-gray-300">{copy("cloud.export.busy")}</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
      {notice ? <p role="status" className="mt-2 text-xs text-oai-gray-600 dark:text-oai-gray-300">{notice}</p> : null}
    </div>;
  }
  if (settingsRow) {
    return <CloudActionDialog open={expanded} onOpenChange={changeOpen}
      title={copy("cloud.export.open")} icon={Download}>{panel}</CloudActionDialog>;
  }
  return <section className={compact && !settingsRow ? "tt-cloud-theme contents" : "tt-cloud-theme"} aria-label={copy("cloud.export.open")}>
    <Button type="button" variant="ghost" size="sm" className={`${neutral} ${settingsRow ? "!h-11 !w-full !justify-start !px-0 !text-oai-black dark:!text-oai-white active:!scale-100" : compact ? "!h-10 !px-0" : ""}`} aria-expanded={expanded}
      aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <Download className={`${settingsRow ? "mr-3" : "mr-2"} h-4 w-4 shrink-0`} aria-hidden="true" />{copy("cloud.export.open")}
      {settingsRow ? <ChevronDown size={16} className={`ml-auto shrink-0 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} aria-hidden /> : null}
    </Button>
    {!settingsRow && panelContainer && panel ? createPortal(panel, panelContainer) : panel}
  </section>;
}
