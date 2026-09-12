import React, { useEffect, useRef, useState } from "react";
import { Button } from "../ui/components/Button.jsx";
import { ExternalLink, Copy } from "lucide-react";
import { accountRequest } from "../lib/subscription-accounts-api";
import { copy } from "../lib/copy";
import { isNativeEmbed, postNativeMessage } from "../lib/native-bridge.js";

const pending = new Set(["starting", "waiting", "saving", "cancelling"]);
const stateCopy = {
  starting: "accounts.auth.starting", waiting: "accounts.auth.waiting", saving: "accounts.auth.saving",
  complete: "accounts.auth.complete", failed: "accounts.auth.failed", cancelled: "accounts.auth.cancelled", cancelling: "accounts.auth.cancelling",
};

export function AccountAuthorization({ initialLogin, onComplete, onSettled, onRetry }) {
  const [login, setLogin] = useState(initialLogin);
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);
  const actionVersion = useRef(0);
  const submitting = useRef(false);
  const callbacks = useRef({ onComplete, onSettled });
  callbacks.current = { onComplete, onSettled };
  useEffect(() => {
    let stopped = false, timer;
    async function poll() {
      const version = actionVersion.current;
      try {
        const data = await accountRequest({ loginId: initialLogin.id });
        if (stopped) return;
        if (submitting.current || version !== actionVersion.current) { timer = setTimeout(poll, 1000); return; }
        setLogin(data.login); setError(false);
        if (data.login.state === "complete") callbacks.current.onComplete(data.login.accountId);
        if (!pending.has(data.login.state)) { callbacks.current.onSettled(); return; }
      } catch {
        if (stopped) return;
        setError(true);
        if (Date.now() >= initialLogin.expiresAt + 5000) {
          setLogin((current) => ({ ...current, state: "failed", authorizeUrl: null, needsCode: false }));
          callbacks.current.onSettled(); return;
        }
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [initialLogin.id, initialLogin.expiresAt]);
  async function action(body) {
    if (submitting.current) return;
    submitting.current = true; actionVersion.current++; setBusy(true); setActionError(false);
    try {
      const data = await accountRequest({ body }); setLogin(data.login);
      if (body.action === "login_code") setCode("");
    } catch { setActionError(true); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <div className="space-y-4" aria-live="polite">
    <p className="text-sm font-medium">{copy(stateCopy[login.state] || "accounts.auth.failed")}</p>
    {actionError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{copy("accounts.auth.action_failed")}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{copy("accounts.auth.connection_error")}</p>}
    {login.state === "failed" && <p className="text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy(login.error === "cli_unavailable" ? "accounts.auth.install_cli" : "accounts.auth.retry_hint")}</p>}
    {login.authorizeUrl && <>
      <p className="text-xs text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.auth.url_hint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button as="a" href={login.authorizeUrl} target="_blank" rel="noopener noreferrer" className="gap-2" onClick={(event) => {
          if (isNativeEmbed()) { event.preventDefault(); postNativeMessage({ type: "action", name: "openURL", value: login.authorizeUrl }); }
        }}><ExternalLink size={15} aria-hidden />{copy("accounts.auth.open")}</Button>
        <Button type="button" variant="secondary" className="gap-2" onClick={async () => {
          try { await navigator.clipboard.writeText(login.authorizeUrl); setCopied(true); } catch { setError(true); }
        }}><Copy size={14} aria-hidden />{copy(copied ? "accounts.copied" : "accounts.auth.copy_url")}</Button>
      </div>
    </>}
    {login.needsCode && <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void action({ action: "login_code", loginId: login.id, code }); }}>
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">{copy("accounts.auth.code")}<input disabled={busy} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} className="h-10 min-w-0 rounded-lg border border-oai-gray-300 text-sm bg-transparent px-3 py-2 dark:border-oai-gray-700" /></label>
      <Button type="submit" disabled={busy || !code.trim()}>{copy("accounts.auth.submit_code")}</Button>
    </form>}
    {onRetry && ["failed", "cancelled"].includes(login.state) && <Button type="button" disabled={busy} onClick={onRetry}>{copy("accounts.retry")}</Button>}
    {pending.has(login.state) && <Button type="button" variant="ghost" size="sm" disabled={busy || login.state === "cancelling" || login.state === "saving"} onClick={() => void action({ action: "login_cancel", loginId: login.id })}>{copy("accounts.auth.cancel")}</Button>}
  </div>;
}
