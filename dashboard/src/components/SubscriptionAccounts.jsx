import React, { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Copy, Trash2, Play, Settings2, ChevronRight, FolderOpen, ArrowRightLeft, Check } from "lucide-react";
import { copy } from "../lib/copy";
import { useLimitsDisplayPrefs } from "../hooks/use-limits-display-prefs.js";
import { accountRequest } from "../lib/subscription-accounts-api";
import { AccountQuotaSummary } from "./AccountQuotaSummary.jsx";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { Button } from "../ui/components/Button.jsx";
import { Select } from "../ui/components/Select.jsx";
import { ToggleSwitch } from "./settings/Controls.jsx";
import { AccountDialog } from "./AccountDialog.jsx";
import { AccountAuthorization } from "./AccountAuthorization.jsx";
import "./subscription-accounts.css";

const inputClass = "h-10 min-w-0 rounded-lg border border-oai-gray-200 bg-transparent px-3 py-2 text-sm dark:border-oai-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500";
const statusKeys = {
  login_required: "accounts.status.login", identity_mismatch: "accounts.status.identity",
  credentials_unavailable: "accounts.status.credentials", auth_expired: "accounts.status.expired",
  auth_unavailable: "accounts.status.expired", cooldown: "accounts.status.cooldown",
  unavailable: "accounts.status.unavailable", archived: "accounts.not_logged_in",
  default_changed: "accounts.global.changed",
};

function Command({ label, command }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setCopied(false); setFailed(false); }, [command]);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  return <div className="min-w-0">
    <p className="mb-2 text-xs text-oai-gray-500">{label}</p>
    <div className="flex items-start gap-2">
      <code className="block min-w-0 flex-1 break-all rounded-lg bg-oai-gray-100 p-3 text-xs dark:bg-oai-gray-900">{command}</code>
      <Button type="button" variant="secondary" size="sm" className="shrink-0 gap-2" aria-label={copy("accounts.copy_command", { label })} onClick={async () => {
        try { await navigator.clipboard.writeText(command); setCopied(true); setFailed(false); }
        catch { setFailed(true); }
      }}><Copy size={14} aria-hidden />{copied ? copy("accounts.copied") : copy("accounts.copy")}</Button>
    </div>
    {failed && <p role="status" className="mt-1 text-xs text-amber-600">{copy("accounts.copy_failed")}</p>}
  </div>;
}

function ProviderAccounts({ groupProvider, displayMode }) {
  const [accounts, setAccounts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loadedDetail, setDetail] = useState(null);
  const detail = loadedDetail?.account?.id === selected ? loadedDetail : null;
  const [globalAccount, setGlobalAccount] = useState(null);
  const [activationMessage, setActivationMessage] = useState(null);
  const [sessionToolsOpen, setSessionToolsOpen] = useState(false);
  const [platform, setPlatform] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [listError, setListError] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [activating, setActivating] = useState(false);
  const [showPastSessions, setShowPastSessions] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const provider = groupProvider;
  const [label, setLabel] = useState("");
  const [allowKeychain, setAllowKeychain] = useState(false);
  const [rename, setRename] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [launchMessage, setLaunchMessage] = useState(null);
  const [blockedAccount, setBlockedAccount] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [switchingSession, setSwitchingSession] = useState(null);
  const [switchError, setSwitchError] = useState(false);
  const [sessionTargets, setSessionTargets] = useState({});
  const [cwd, setCwd] = useState("");
  const [rotation, setRotation] = useState(() => {
    try { return localStorage.getItem(`tokentracker.account-rotation.${groupProvider}`) === "true"; } catch { return false; }
  });
  const [range, setRange] = useState("30");
  const [poolCommand, setPoolCommand] = useState(null);
  const [login, setLogin] = useState(null);
  const [authorizing, setAuthorizing] = useState(false);
  const authDismissed = useRef(false);
  const detailSequence = useRef(0);
  const listSequence = useRef(0);
  const pendingSession = useRef(null);
  const pendingSwitch = useRef(null);

  const loadList = useCallback(async () => {
    const seq = ++listSequence.current;
    try {
      const data = await accountRequest();
      if (seq !== listSequence.current) return;
      const global = data.global?.[groupProvider];
      setGlobalAccount(global || null);
      const rows = [...(global?.state === "active" ? [] : data.systemAccounts || []), ...(data.accounts || [])].filter((account) => account.provider === groupProvider);
      setAccounts(rows); setPlatform(data.platform); setListError(false); setListLoaded(true);
      setSessions((data.sessions || []).filter((session) => session.provider === groupProvider));
      const started = data.sessions?.find((session) => session.id === pendingSession.current);
      if (started && started.state !== "starting") { pendingSession.current = null; setLaunchMessage(null); }
      const switched = data.sessions?.find((session) => session.requestId === pendingSwitch.current && session.switchResult);
      if (pendingSwitch.current && switched) { pendingSwitch.current = null; setLaunchMessage(null); }
      setSelected((current) => rows.some((account) => account.id === current) ? current : rows.find((account) => account.id === global?.activeAccountId)?.id || rows.find((account) => !account.archived)?.id || null);
      setPoolCommand(data.poolCommands?.[groupProvider] || null);
      const ongoing = data.logins?.find((session) => session.provider === groupProvider);
      if (ongoing) { if (!authDismissed.current) setLogin(ongoing); setAuthorizing(true); setShowAdd(false); }
      else setAuthorizing(false);
    } catch { if (seq === listSequence.current) { setListError(true); setListLoaded(true); } }
  }, [groupProvider]);

  const loadDetail = useCallback(async (id, force = false) => {
    const seq = ++detailSequence.current;
    setLoading(true);
    try {
      const data = await accountRequest(force ? { body: id.startsWith("system-") ? { action: "refresh_system", provider: id.slice(7) } : { action: "refresh", id } } : { id });
      if (seq !== detailSequence.current) return;
      if (data.account?.id !== id) throw new Error("account_identity_mismatch");
      setDetail(data); setDetailError(false);
    } catch { if (seq === detailSequence.current) setDetailError(true); }
    finally { if (seq === detailSequence.current) setLoading(false); }
  }, []);

  useEffect(() => { void loadList(); return () => { listSequence.current++; detailSequence.current++; }; }, [loadList]);
  useEffect(() => {
    setDetail(null); setDetailError(false);
    if (selected) void loadDetail(selected);
    else detailSequence.current++;
  }, [selected, loadDetail]);
  // Pick up completed browser logins and changes to the local default login.
  useEffect(() => {
    const refresh = () => { void loadList(); if (selected) void loadDetail(selected); };
    window.addEventListener("focus", refresh);
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 60000);
    return () => { window.removeEventListener("focus", refresh); clearInterval(timer); };
  }, [selected, loadList, loadDetail]);
  const needsFastPolling = authorizing || sessions.some((session) => ["starting", "running", "switching"].includes(session.state));
  useEffect(() => {
    if (!needsFastPolling) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void loadList(); }, 5000);
    return () => clearInterval(timer);
  }, [needsFastPolling, loadList]);

  const active = accounts.find((a) => a.id === selected);
  useEffect(() => { setRename(active?.label || ""); }, [active?.label]);
  async function mutate(body) {
    setBusy(true); setError(false);
    // Mutations invalidate any read that could restore the previous state.
    detailSequence.current++;
    try {
      await accountRequest({ body });
      await loadList();
      if (selected) await loadDetail(selected);
      setSettingsOpen(false);
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  async function startAuthorization(id) {
    if (busy) return;
    setBusy(true); setError(false);
    try {
      const data = await accountRequest({ body: { action: "login_start", ...(id ? { id } : {
        provider, label: label.trim() || `${provider === "claude" ? copy("limits.provider.claude") : copy("limits.provider.codex")} ${accounts.length + 1}`, allowKeychain,
      }) } });
      authDismissed.current = false; setLogin(data.login); setAuthorizing(true); setSettingsOpen(false); setShowAdd(false); await loadList();
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  const cutoff = range === "all" ? "" : new Date(Date.now() - (Number(range) - 1) * 86400000).toISOString().slice(0, 10);
  const daily = (detail?.usage?.daily || []).filter((d) => d.date >= cutoff);
  const tokens = daily.reduce((sum, d) => sum + d.totalTokens, 0);
  const cost = daily.reduce((sum, d) => { return sum + d.estimatedCostUsd; }, 0);
  const status = detail?.status !== "ready" ? detail?.status : detail?.limits?.status;
  const statusKey = statusKeys[status];
  const hasUsage = Boolean(detail?.usage);

  const providerName = copy(groupProvider === "claude" ? "limits.provider.claude" : "limits.provider.codex");
  const eligible = accounts.filter((a) => !a.system && a.registered && !a.archived);
  const rotationCandidates = eligible.filter((account) => account.id !== globalAccount?.activeAccountId && account.id !== globalAccount?.managedAccountId);
  const effectiveRotation = rotation && Boolean(rotationCandidates.length);
  const limits = detail?.limits;
  const activeName = active?.system ? copy("accounts.system.label") : active?.label;
  const displayStatus = active?.system ? "accounts.system.detected" : active?.archived ? "accounts.not_logged_in" : active?.registered ? "accounts.ui.connected" : "accounts.not_logged_in";
  const liveSessions = sessions.filter((session) => ["starting", "running", "switching"].includes(session.state));
  const pastSessions = sessions.filter((session) => !["starting", "running", "switching"].includes(session.state)).slice(0, 5);
  const visibleSessions = showPastSessions ? [...liveSessions, ...pastSessions] : liveSessions;
  const deleteBlocked = active && (active.id === globalAccount?.activeAccountId || active.id === globalAccount?.managedAccountId || liveSessions.some((session) => session.accountId === active.id));
  function changeRotation(next) {
    setRotation(next); setLaunchMessage(null);
    try { localStorage.setItem(`tokentracker.account-rotation.${groupProvider}`, String(next)); } catch { /* optional preference */ }
  }
  async function launch() {
    setBusy(true); setLaunchMessage(null); setBlockedAccount(null);
    try {
      const data = await accountRequest({ body: { action: "launch", id: selected, provider: groupProvider, auto: effectiveRotation, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) } });
      if (data.launch?.status === "blocked") {
        const credentials = data.launch.issues?.find((issue) => issue.reason === "credentials_unavailable");
        setLaunchMessage(credentials ? "accounts.ui.pool_credentials" : "accounts.ui.pool_blocked");
        setBlockedAccount(credentials?.id || null); return;
      }
      pendingSession.current = data.launch?.sessionId || null;
      setLaunchMessage(data.launch?.sessionId ? "accounts.session.starting" : "accounts.ui.launched"); setLaunchOpen(false); await loadList();
    } catch { setLaunchMessage("accounts.ui.launch_failed"); }
    finally { setBusy(false); }
  }
  async function switchSession() {
    setBusy(true); setSwitchError(false);
    try {
      const data = await accountRequest({ body: { action: "switch_session", sessionId: switchingSession.id, id: switchingSession.targetId } });
      pendingSwitch.current = data.switch?.requestId || null;
      setSwitchingSession(null); setLaunchMessage("accounts.session.requested"); await loadList();
    } catch { setSwitchError(true); }
    finally { setBusy(false); }
  }
  async function activate(id, restore = false) {
    setBusy(true); setActivating(true); setActivationMessage(null);
    try {
      const data = await accountRequest({ body: restore ? { action: "restore_default", provider: groupProvider } : { action: "activate", id } });
      if (data.activation?.status !== "applied") {
        const reason = data.activation?.reason;
        setActivationMessage(reason === "account_busy" ? "accounts.global.busy" : reason === "auth_expired" || reason === "credentials_unavailable" ? "accounts.global.login_needed" : reason === "recovery_required" ? "accounts.global.recovery" : "accounts.global.failed");
      } else { setActivationMessage(null); setSettingsOpen(false); }
      await loadList();
      if (id) await loadDetail(id);
    } catch { setActivationMessage("accounts.global.failed"); }
    finally { setBusy(false); setActivating(false); }
  }
  async function removeAccount() {
    if (!deleteTarget || busy) return;
    setBusy(true); setDeleteError(null);
    try {
      const data = await accountRequest({ body: { action: "delete", id: deleteTarget.id } });
      if (data.deletion?.status !== "deleted") { setDeleteError("accounts.delete.busy"); return; }
      setDeleteTarget(null); setSettingsOpen(false); setDetail(null); await loadList();
    } catch { setDeleteError("accounts.delete.failed"); }
    finally { setBusy(false); }
  }
  async function changeSessionRotation(session) {
    setBusy(true);
    try {
      await accountRequest({ body: { action: "session_rotation", sessionId: session.id, auto: !session.auto } });
      await loadList();
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  return <div className="account-panel overflow-hidden rounded-xl border border-oai-gray-200 dark:border-oai-gray-800">
    <div className="flex items-center justify-between gap-4 border-b border-oai-gray-200 px-4 py-4 dark:border-oai-gray-800 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon provider={groupProvider} size={28} />
        <h3 className="text-base font-semibold">{providerName}</h3>
        <span className="text-xs tabular-nums text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.count", { count: accounts.length })}</span>
      </div>
      <Button type="button" variant="secondary" size="sm" className="shrink-0 gap-2" disabled={busy} onClick={() => { authDismissed.current = false; if (authorizing) void loadList(); else setShowAdd(true); }}><Plus size={15} aria-hidden />{copy(authorizing ? "accounts.ui.resume_auth" : "accounts.add")}</Button>
    </div>
    {(error || listError || detailError) && <p role="alert" className="px-5 py-3 text-sm text-red-600 dark:text-red-400">{copy("accounts.error")} <Button type="button" variant="ghost" size="sm" onClick={() => { setError(false); void loadList(); if (selected) void loadDetail(selected); }}>{copy("accounts.retry")}</Button></p>}
    <div className="grid min-w-0 md:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)]">
      <div className="min-w-0 border-b border-oai-gray-200 p-3 dark:border-oai-gray-800 md:border-b-0 md:border-r">
        <div className="flex flex-col gap-1" role="group" aria-label={copy("accounts.choose")}>
          {accounts.map((a) => <button key={a.id} type="button" disabled={busy} onClick={() => { if (a.id !== selected) { setDetail(null); setSelected(a.id); } setLaunchMessage(null); if (a.registered && !a.archived && a.id !== globalAccount?.activeAccountId) void activate(a.id); }} aria-pressed={a.id === selected}
            className={`flex min-h-16 w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 ${a.id === selected ? "bg-oai-gray-100 dark:bg-oai-gray-800" : "hover:bg-oai-gray-50 dark:hover:bg-oai-gray-900"}`}>
            <span className="min-w-0 flex-1"><span className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{a.system ? copy("accounts.system.label") : a.label}</span>{(a.id === globalAccount?.activeAccountId || (a.system && globalAccount?.state !== "active")) && <span aria-label={copy("accounts.global.current")} className="inline-flex shrink-0 items-center gap-1 rounded bg-oai-gray-200/60 px-1.5 py-0.5 text-xs font-normal text-oai-gray-700 dark:bg-oai-gray-700 dark:text-oai-gray-200"><Check size={12} aria-hidden />{copy("accounts.global.current_short")}</span>}</span><span className="mt-1 block truncate text-xs text-oai-gray-600 dark:text-oai-gray-400" title={a.email || undefined}>{a.email || copy("accounts.not_logged_in")}</span>{sessions.some((session) => { return session.accountId === a.id && session.state === "running"; }) && <span className="mt-1 block text-xs text-emerald-700 dark:text-emerald-400">{copy("accounts.session.running")}</span>}</span>
            <ChevronRight size={14} className={a.id === selected ? "shrink-0 text-oai-gray-600 dark:text-oai-gray-300" : "shrink-0 text-oai-gray-400"} aria-hidden />
          </button>)}
          {!listLoaded && <div role="status" className="space-y-3 px-3 py-4"><span className="sr-only">{copy("accounts.loading")}</span><div className="h-4 w-2/3 rounded bg-oai-gray-100 dark:bg-oai-gray-800" /><div className="h-3 w-full rounded bg-oai-gray-100 dark:bg-oai-gray-800" /></div>}
          {listLoaded && !accounts.length && !listError && <p className="px-3 py-4 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.empty")}</p>}
        </div>
        
      </div>
      <div className="min-w-0 p-4 sm:p-5">
        {active ? <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><h4 className="truncate text-sm font-semibold">{activeName}</h4><p className="mt-1 text-xs text-oai-gray-600 dark:text-oai-gray-400">{active.plan || copy(displayStatus)}</p></div>
            <div className="flex shrink-0 gap-1">
              <Button type="button" variant="ghost" size="sm" disabled={loading || busy || active.archived} onClick={() => void loadDetail(selected, !active.system)} aria-label={copy("accounts.refresh")} title={copy("accounts.refresh")}><RefreshCw size={16} className={loading ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden /></Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setError(false); setSettingsOpen(true); setAdvanced(false); }} aria-label={copy("accounts.manage")} title={copy("accounts.manage")}><Settings2 size={16} aria-hidden /></Button>
            </div>
          </div>
          {loading && !detail && <div role="status" className="mt-5 space-y-4 py-2"><span className="sr-only">{copy("accounts.loading")}</span>{[0, 1].map((row) => <div key={row} className="space-y-2"><div className="h-3 w-1/3 rounded bg-oai-gray-100 dark:bg-oai-gray-800" /><div className="h-2 rounded bg-oai-gray-100 dark:bg-oai-gray-800" /></div>)}</div>}
          {statusKey && <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-amber-700 dark:text-amber-400"><p className="max-w-prose">{copy(statusKey)}</p>{status === "identity_mismatch" && <Button type="button" variant="secondary" size="sm" disabled={busy || authorizing} onClick={() => setShowAdd(true)}>{copy("accounts.add")}</Button>}{status === "credentials_unavailable" && <Button type="button" variant="secondary" size="sm" onClick={() => setSettingsOpen(true)}>{copy("accounts.ui.configure")}</Button>}{["login_required", "auth_expired", "auth_unavailable"].includes(status) && !active.system && !active.archived && <Button type="button" variant="secondary" size="sm" disabled={busy || authorizing} onClick={() => void startAuthorization(selected)}>{copy("accounts.auth.reauthorize")}</Button>}</div>}
          {limits?.configured && <div className="mt-5"><AccountQuotaSummary displayMode={displayMode} provider={groupProvider} limits={{ ...limits, status: limits.status || "ok" }} /></div>}
          {!limits?.configured && active.system && !statusKey && !loading && <p className="mt-5 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.system.no_limits")}</p>}
          {limits?.stale && <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">{copy("accounts.stale")}</p>}
          {!active.system && hasUsage && <div className="mt-5 border-t border-oai-gray-200 pt-4 dark:border-oai-gray-800">
            <div className="flex flex-wrap items-center gap-5">
              <div><p className="text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.tokens")}</p><p className="mt-1 text-lg font-semibold tabular-nums">{tokens.toLocaleString()}</p></div>
              <div><p className="text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.cost")}</p><p className="mt-1 text-lg font-semibold tabular-nums">{cost.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })}</p></div>
              <Select value={range} onValueChange={setRange} ariaLabel={copy("accounts.range")} className="ml-auto h-9 px-3 text-xs" options={[{value:"7",label:copy("accounts.days7")},{value:"30",label:copy("accounts.days30")},{value:"all",label:copy("accounts.all")}]} />
            </div>
          </div>}
          {limits?.fetched_at && <p className="mt-3 text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.updated", { date: new Date(limits.fetched_at).toLocaleString() })}</p>}
        </> : <p className="py-6 text-sm text-oai-gray-600 dark:text-oai-gray-400">{copy(!listLoaded ? "accounts.loading" : "accounts.ui.select_account")}</p>}
      </div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-oai-gray-200 px-4 py-3 dark:border-oai-gray-800 sm:px-5">
      <p role="status" className="max-w-prose text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy(activating ? "accounts.global.switching" : globalAccount?.state === "changed" ? "accounts.global.changed" : globalAccount?.state === "active" ? "accounts.global.applied_hint" : "accounts.global.choose")}</p>
      <Button type="button" variant="ghost" size="sm" onClick={() => { setShowPastSessions(false); setSessionToolsOpen(true); }}>{copy("accounts.global.sessions")}</Button>
    </div>
    {activationMessage && <p role="status" className="px-5 pb-4 text-sm text-amber-700 dark:text-amber-400">{copy(activationMessage)}</p>}
    <AccountDialog open={sessionToolsOpen} title={copy("accounts.global.sessions")} description={copy("accounts.global.session_hint")} onClose={() => setSessionToolsOpen(false)}>
    {groupProvider === "claude" && <div className="border-t border-oai-gray-200 py-4 dark:border-oai-gray-800">
      <h4 className="text-xs font-medium text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.session.title")}</h4>
      {!liveSessions.length && <p className="mt-2 max-w-prose text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.session.external")}</p>}
      {Boolean(liveSessions.length) && eligible.length < 2 && <p className="mt-2 max-w-prose text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.session.need_target")}</p>}
      <div className="mt-2 space-y-3">{visibleSessions.map((session) => {
        const targets = eligible.filter((account) => account.id !== session.accountId && account.id !== globalAccount?.activeAccountId);
        const target = targets.find((account) => { return account.id === sessionTargets[session.id]; }) || targets[0];
        return <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-oai-gray-50 p-3 dark:bg-oai-gray-900">
        <div className="min-w-0 flex-1"><p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"><span className="font-medium">{accounts.find((account) => account.id === session.accountId)?.label || providerName}</span><span className="text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy(`accounts.session.${session.state}`)}</span></p><p className="mt-1 break-all text-xs text-oai-gray-600 dark:text-oai-gray-400">{session.cwd}</p>
          {session.switchResult === "complete" && <p role="status" className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">{copy("accounts.session.complete")}</p>}
          {session.error && <p role="status" className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-400">{copy(session.error === "credentials_unavailable" ? "accounts.ui.pool_credentials" : session.switchResult === "restored" ? "accounts.session.restored" : session.error === "pool_empty" ? "accounts.ui.pool_blocked" : session.error === "stop_timeout" ? "accounts.session.stop_timeout" : "accounts.session.failed_hint")}</p>}
        </div>
        {session.state === "running" && <div className="flex flex-wrap items-center gap-3"><div className="flex items-center gap-2"><ToggleSwitch checked={Boolean(session.auto)} onChange={() => void changeSessionRotation(session)} disabled={busy} ariaLabel={copy("accounts.session.rotation")} /><span className="text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.session.rotation")}</span></div>{target && <Select value={target.id} onValueChange={(id) => setSessionTargets((previous) => ({ ...previous, [session.id]: id }))} ariaLabel={copy("accounts.session.target")} options={targets.map((account) => ({ value: account.id, label: account.label }))} className="h-9 max-w-48 text-xs" />}<Button type="button" variant="secondary" size="sm" className="gap-2" disabled={busy || !target} onClick={() => { setSessionToolsOpen(false); setSwitchError(false); setSwitchingSession({ ...session, targetId: target.id, targetLabel: target.label }); }}><ArrowRightLeft size={14} aria-hidden />{copy("accounts.session.switch")}</Button></div>}
      </div>; })}</div>
      {Boolean(pastSessions.length) && <Button type="button" variant="ghost" size="sm" className="mt-3 gap-2" aria-expanded={showPastSessions} onClick={() => setShowPastSessions(!showPastSessions)}><ChevronRight size={14} className={showPastSessions ? "rotate-90" : ""} aria-hidden />{copy("accounts.session.history", { count: pastSessions.length })}</Button>}
    </div>}
    <div className="space-y-4 border-t border-oai-gray-200 py-4 dark:border-oai-gray-800">
      <p className="w-full text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.global.pool_scope")}</p>
      <div className="flex items-center justify-between gap-4"><div><p className="text-sm font-medium">{copy("accounts.pool.title")}</p><p className="mt-1 text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy(!rotationCandidates.length ? "accounts.ui.rotation_unavailable" : effectiveRotation ? "accounts.ui.rotation_on" : "accounts.ui.rotation_off")}</p></div><ToggleSwitch checked={effectiveRotation} onChange={() => changeRotation(!effectiveRotation)} disabled={!rotationCandidates.length || busy} ariaLabel={copy("accounts.pool.title")} /></div>
      <Button type="button" className="w-full gap-2" disabled={busy || authorizing || (!effectiveRotation && (!active || active.archived || (!active.system && !active.registered)))} onClick={() => { setLaunchMessage(null); setBlockedAccount(null); setSessionToolsOpen(false); setLaunchOpen(true); }}><Play size={14} aria-hidden />{copy(effectiveRotation ? "accounts.ui.launch_pool" : "accounts.ui.launch")}</Button>
    </div>
    </AccountDialog>
    {launchMessage && <p role="status" className="border-t border-oai-gray-200 px-5 py-3 text-sm dark:border-oai-gray-800">{copy(launchMessage)}</p>}
    <AccountDialog open={Boolean(switchingSession)} busy={busy} title={copy("accounts.session.switch_title", { account: switchingSession?.targetLabel })} description={copy("accounts.session.switch_hint")} onClose={() => { if (!busy) setSwitchingSession(null); }}>
      <p className="mb-4 break-all text-sm text-oai-gray-600 dark:text-oai-gray-400">{switchingSession?.cwd}</p>
      {switchError && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{copy("accounts.session.failed_hint")}</p>}
      <div className="flex justify-end"><Button type="button" disabled={busy} className="gap-2" onClick={() => void switchSession()}><ArrowRightLeft size={14} aria-hidden />{copy("accounts.session.confirm")}</Button></div>
    </AccountDialog>
    <AccountDialog open={Boolean(deleteTarget)} busy={busy} title={copy("accounts.delete.title", { account: deleteTarget?.label })} description={copy("accounts.delete.description")} onClose={() => { if (!busy) setDeleteTarget(null); }}>
      {deleteError && <p role="alert" className="mb-4 text-sm text-amber-700 dark:text-amber-400">{copy(deleteError)}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => setDeleteOpen(false)}>{copy("accounts.delete.cancel")}</Button><Button type="button" disabled={busy} onClick={() => void removeAccount()}>{copy(busy ? "accounts.delete.progress" : "accounts.delete.action")}</Button></div>
    </AccountDialog>
    <AccountDialog open={showAdd || Boolean(login)} busy={busy} title={copy("accounts.ui.add_title", { provider: providerName })} description={copy("accounts.login_hint")} onClose={() => { authDismissed.current = true; setShowAdd(false); setLogin(null); }}>
      {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{copy("accounts.error")}</p>}
      {login ? <AccountAuthorization key={login.id} initialLogin={login} onRetry={() => void startAuthorization(login.accountId)} onSettled={() => setAuthorizing(false)} onComplete={async (id) => {
        await loadList(); setSelected(id); setLabel(""); setLogin(null); setAuthorizing(false); void loadDetail(id);
      }} /> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void startAuthorization(); }}>
        <label className="flex flex-col gap-2 text-sm">{copy("accounts.auth.optional_label")}<input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder={copy("accounts.label_placeholder")} /></label>
        {platform === "darwin" && provider === "claude" && <label className="flex items-start gap-3 text-xs leading-5"><input className="mt-1" type="checkbox" checked={allowKeychain} onChange={(e) => setAllowKeychain(e.target.checked)} />{copy("accounts.keychain_consent")}</label>}
        <div className="flex justify-end"><Button type="submit" disabled={busy || authorizing}>{copy("accounts.auth.generate")}</Button></div>
      </form>}
    </AccountDialog>
    <AccountDialog open={settingsOpen && Boolean(active)} busy={busy} title={copy("accounts.manage")} description={active?.system ? copy("accounts.system.description") : activeName} onClose={() => setSettingsOpen(false)}>
      {activationMessage && <p role="alert" className="mb-3 text-sm text-amber-700 dark:text-amber-400">{copy(activationMessage)}</p>}
      {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{copy("accounts.error")}</p>}
      {active?.system ? <div className="space-y-4"><p className="text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.global.system_access")}</p><Button type="button" variant="secondary" disabled={loading} onClick={() => void loadDetail(selected, true)}>{copy("accounts.ui.configure")}</Button><p className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.system.history")}</p></div> : <div className="space-y-5">
        <form className="flex items-end gap-3" onSubmit={(event) => { event.preventDefault(); void mutate({ action: "update", id: selected, label: rename }); }}>
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">{copy("accounts.label")}<input className={inputClass} value={rename} maxLength={80} required onChange={(e) => setRename(e.target.value)} /></label><Button disabled={busy || !rename.trim() || rename.trim() === active?.label} type="submit">{copy(busy ? "accounts.ui.saving" : "accounts.save")}</Button>
        </form>
        {platform === "darwin" && provider === "claude" && <label className="flex items-start gap-3 text-xs leading-5"><input className="mt-1" type="checkbox" checked={Boolean(active?.allowKeychain)} disabled={busy} onChange={(e) => void mutate({ action: "update", id: selected, allowKeychain: e.target.checked })} />{copy("accounts.keychain_consent")}</label>}
        <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={busy || authorizing || active?.archived} onClick={() => void startAuthorization(selected)}>{copy("accounts.auth.reauthorize")}</Button></div>
        {active?.subscriptionEndsAt && <p className="text-xs">{copy("accounts.subscription_end", { date: new Date(active.subscriptionEndsAt).toLocaleString() })}</p>}
      </div>}
      <div className="mt-5 space-y-3 border-t border-oai-gray-200 pt-4 dark:border-oai-gray-800"><p className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.global.applied_hint")}</p>{globalAccount?.canRestore && <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void activate(null, true)}>{copy("accounts.global.restore")}</Button>}</div>
      <div className="mt-5 border-t border-oai-gray-200 pt-4 dark:border-oai-gray-800"><Button type="button" variant="ghost" size="sm" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{copy("accounts.ui.advanced")}</Button>
        {advanced && <div className="mt-3 space-y-4">
          <p className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.global.scope")}</p>
          {!active?.system && <p className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.scope")}</p>}
          {poolCommand && <Command label={copy("accounts.pool.command")} command={poolCommand} />}
          {detail?.commands && !active?.archived && <><Command label={copy("accounts.run_command")} command={detail.commands.run} /><Command label={copy("accounts.login_command")} command={detail.commands.login} /></>}
          {Boolean(daily.length) && <div className="max-h-64 overflow-auto"><table className="w-full text-right text-xs tabular-nums"><caption className="mb-2 text-left">{copy("accounts.daily")}</caption><thead><tr><th className="text-left">{copy("accounts.date")}</th><th>{copy("accounts.tokens")}</th><th>{copy("accounts.cost")}</th></tr></thead><tbody>{[...daily].reverse().map((d) => <tr key={d.date}><td className="py-2 text-left">{d.date}</td><td>{d.totalTokens.toLocaleString()}</td><td>{d.estimatedCostUsd.toFixed(2)}</td></tr>)}</tbody></table></div>}
        </div>}
      </div>
      {!active?.system && <div className="mt-5 border-t border-oai-gray-200 pt-4 dark:border-oai-gray-800"><Button type="button" variant="ghost" disabled={busy || deleteBlocked} className="gap-2 text-red-600 dark:text-red-400" onClick={() => { setSettingsOpen(false); setDeleteError(null); setDeleteTarget({ id: active.id, label: activeName }); }}><Trash2 size={14} aria-hidden />{copy("accounts.delete.action")}</Button>{deleteBlocked && <p className="mt-2 text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.delete.busy")}</p>}</div>}
    </AccountDialog>
    <AccountDialog open={launchOpen} busy={busy} title={copy(effectiveRotation ? "accounts.ui.launch_pool" : "accounts.ui.launch")} description={copy(effectiveRotation ? "accounts.ui.launch_pool_hint" : "accounts.ui.launch_hint", { account: activeName })} onClose={() => { if (!busy) setLaunchOpen(false); }}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void launch(); }}>
        <label className="flex flex-col gap-2 text-sm"><span className="flex items-center gap-2"><FolderOpen size={15} aria-hidden />{copy("accounts.ui.directory")}</span><input className={inputClass} value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={copy("accounts.ui.directory_hint")} /></label>
        {launchMessage && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{copy(launchMessage)}</p>}
        {blockedAccount && <Button type="button" variant="secondary" onClick={() => { setSelected(blockedAccount); setLaunchOpen(false); setSettingsOpen(true); }}>{copy("accounts.ui.configure")}</Button>}
        <div className="flex justify-end"><Button type="submit" disabled={busy} className="gap-2"><Play size={14} aria-hidden />{copy(busy ? "accounts.ui.checking_launch" : "accounts.ui.open_terminal")}</Button></div>
      </form>
    </AccountDialog>
  </div>;
}

export function SubscriptionAccounts({ showHeading = true }) {
  const { displayMode } = useLimitsDisplayPrefs();
  return <section className="mb-8" aria-label={copy("accounts.title")}>
    {showHeading && <div className="mb-4"><h2 className="text-lg font-semibold tracking-tight">{copy("accounts.title")}</h2><p className="mt-1 text-sm text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.subtitle")}</p></div>}
    <div className="space-y-5">
      <ProviderAccounts groupProvider="claude" displayMode={displayMode} />
      <ProviderAccounts groupProvider="codex" displayMode={displayMode} />
    </div>
  </section>;
}
