import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDown, ChevronUp, GripHorizontal, Settings2, ArrowUpRight, Check, X } from "lucide-react";
import { copy, setCopyLocale } from "./lib/copy";
import { desktopQuotaRows, selectQuotaRows, mergeQuotaSnapshot, quotaPeriodLabel, quotaResetCountdown } from "./lib/desktop-quota.js";
import { limitProviderName } from "./lib/limits-providers.js";
import "./quota.css";

function send(message) { window.chrome?.webview?.postMessage(message); }
function remaining(row) { return row.remaining !== 0 && Math.floor(row.remaining) === 0 ? "<1" : String(Math.round(row.remaining)); }
export function QuotaWidget() {
  const [context, setContext] = useState({ limits: null, failed: false, selected: [], light: false });
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState(false);
  const [now, setNow] = useState(Date.now());
  const drag = useRef(null);
  useEffect(() => {
    const receive = event => {
      if (event.data?.type !== "quota:context") return;
      setCopyLocale(event.data.locale);
      setContext(previous => ({ ...event.data, limits: mergeQuotaSnapshot(previous.limits, event.data.limits) }));
    };
    window.chrome?.webview?.addEventListener("message", receive);
    send("quota:ready");
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => { clearInterval(timer); window.chrome?.webview?.removeEventListener("message", receive); };
  }, []);
  useEffect(() => {
    const onKey = event => { if (event.key === "Escape") { setExpanded(false); setSettings(false); send("quota:collapse"); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const label = row => quotaPeriodLabel(row, context.locale) || row.label || copy(row.labelKey);
  const rows = desktopQuotaRows(context.limits);
  const selected = Array.isArray(context.selected) ? context.selected : [];
  const compact = selectQuotaRows(rows, selected);
  const resetText = row => { return row.stale ? copy("quota.stale") : !Number.isFinite(row.resetMs) ? copy("quota.no_reset") : row.resetMs <= now ? copy("quota.awaiting") : copy("quota.reset_in", { time: quotaResetCountdown(row.resetMs, now, context.locale) }); };
  const old = context.limits?.fetched_at && now - Date.parse(context.limits.fetched_at) > 180000;
  const stale = context.failed || old || compact.some(row => row.stale);
  const toggle = () => { const next = !expanded; setExpanded(next); setSettings(false); send(next ? "quota:expand" : "quota:collapse"); };
  const pick = id => {
    const current = selected.length ? selected : compact.map(row => row.id);
    const next = current.includes(id) ? current.filter(item => item !== id) : [...current.slice(-1), id];
    setContext(value => ({ ...value, selected: next }));
    send(JSON.stringify({ type: "quota:select", ids: next }));
  };
  return <main className={`quota ${context.light ? "light" : ""} ${expanded ? "expanded" : ""} ${stale ? "stale" : ""}`}>
    <header>
      {expanded ? <span className="quota-title">{copy("quota.title")}</span> : <span className={`quota-status ${stale ? "stale-status" : ""}`} role="status" aria-label={copy(stale ? "quota.stale" : "quota.remaining")} title={copy(stale ? "quota.stale" : "quota.remaining")}>{stale ? "!" : null}</span>}
      <button className="drag-handle" aria-label={copy("quota.drag")} title={copy("quota.drag")}
        onPointerDown={event => { drag.current = { x: event.clientX, y: event.clientY }; }}
        onPointerMove={event => { if (drag.current && event.buttons === 1 && Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) > 4) { drag.current = null; send("quota:drag"); } }}
        onPointerUp={() => { drag.current = null; }}><GripHorizontal size={14} /></button>
      {expanded && <button aria-label={copy("quota.choose")} onClick={() => setSettings(value => !value)} aria-pressed={settings}><Settings2 size={13} /></button>}
      <button className="quota-toggle" aria-label={copy(expanded ? "quota.collapse" : "quota.expand")} aria-expanded={expanded} onClick={toggle}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
      <button className="quota-close" aria-label={copy("quota.close")} title={copy("quota.close_hint")} onClick={() => send("quota:close")}><X size={14} /></button>
    </header>
    {!expanded ? <button className="quota-summary" onClick={toggle} aria-label={copy("quota.expand")}>
      {compact.length ? compact.map(row => <span className={`compact-metric ${row.remaining <= 10 ? "low" : ""}`} key={row.id} title={`${limitProviderName(row.provider)} · ${label(row)} · ${copy("quota.remaining")}`}><span className="compact-name">{limitProviderName(row.provider)}</span><span className="compact-reading"><strong>{remaining(row)}<small>{copy("quota.percent")}</small></strong></span><span className="compact-reset" title={Number.isFinite(row.resetMs) ? copy("quota.resets", {time: new Intl.DateTimeFormat(context.locale || undefined, {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(row.resetMs))}) : undefined}>{resetText(row)}</span><span className="compact-track quota-track" aria-hidden="true"><span style={{ width: `${row.remaining}%` }} /></span></span>) : <span className="empty-compact">{copy(context.limits ? rows.length ? "quota.unavailable" : "quota.empty" : "quota.loading")}</span>}
    </button> : <>
      <div className="quota-content">
        {settings ? rows.map(row => <button className="quota-choice" key={row.id} onClick={() => pick(row.id)} aria-pressed={compact.some(item => { return item.id === row.id; })}><span>{limitProviderName(row.provider)}<small>{label(row)}</small></span>{compact.some(item => { return item.id === row.id; }) && <Check size={14} />}</button>) : compact.map(row => <section className={row.remaining <= 10 ? "low" : ""} key={row.id}>
          <div className="row-title"><span>{limitProviderName(row.provider)}</span><span className="window-label">{label(row)}</span></div>
          <div className="row-value"><strong>{remaining(row)}<small>{copy("quota.percent")}</small></strong><span>{copy("quota.remaining")}</span></div>
          <div className="quota-track" role="meter" aria-label={`${limitProviderName(row.provider)} ${label(row)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.remaining}><span style={{ width: `${row.remaining}%` }} /></div>
          <div className="reset">{row.stale ? copy("quota.stale") : Number.isFinite(row.resetMs) ? row.resetMs <= now ? copy("quota.awaiting") : copy("quota.resets", { time: new Intl.DateTimeFormat(context.locale || undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(row.resetMs)) }) : copy("quota.no_reset")}</div>
        </section>)}
        {!rows.length && <p className="quota-empty">{copy(context.limits ? "quota.empty" : "quota.loading")}</p>}
        {Boolean(rows.length) && !compact.length && !settings && <p className="quota-empty">{copy("quota.unavailable")}</p>}
      </div>
      <footer><span role="status">{copy(stale ? "quota.stale" : settings ? "quota.pick_two" : "quota.remaining")}</span><button aria-label={copy("quota.dashboard")} title={copy("quota.dashboard")} onClick={() => send("quota:dashboard")}><ArrowUpRight size={14} /></button></footer>
    </>}
  </main>;
}

const root = document.getElementById("quota-root");
if (root) createRoot(root).render(<QuotaWidget />);
