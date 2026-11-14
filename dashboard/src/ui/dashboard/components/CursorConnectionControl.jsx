import React, { useEffect, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { LoaderCircle, MoreHorizontal, X } from "lucide-react";
import { isLocalhostHost, updateCursorConnection } from "../../../lib/api";
import { getNativeOAuthBridge, isBridgeAvailable, isNativeLinuxApp, postNativeMessage } from "../../../lib/native-bridge.js";
import { copy } from "../../../lib/copy";

const BUTTON_CLASS = "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs text-oai-gray-600 hover:bg-oai-gray-100 hover:text-oai-gray-900 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800 dark:hover:text-oai-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oai-brand-500 disabled:opacity-50";

export function CursorConnectionControl({ connected = false, onSaved }) {
  const [attempt, setAttempt] = useState(null);
  const [status, setStatus] = useState("idle");
  const [menuOpen, setMenuOpen] = useState(false);
  const [openManually, setOpenManually] = useState(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (!attempt) return;
    let active = true;
    let timer;
    const poll = async () => {
      try {
        const result = await updateCursorConnection("poll", attempt.attemptId);
        if (!active) return;
        if (result.status === "pending") {
          timer = setTimeout(poll, 2000);
          return;
        }
        setAttempt(null);
        setStatus(result.status);
        if (result.status === "connected") onSavedRef.current?.();
      } catch {
        if (active) {
          setAttempt(null);
          setStatus("failed");
        }
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      clearTimeout(timer);
      void updateCursorConnection("cancel", attempt.attemptId).catch(() => {});
    };
  }, [attempt]);

  if (!isLocalhostHost()) return null;

  const start = async () => {
    setMenuOpen(false);
    setStatus("starting");
    const native = isBridgeAvailable() || isNativeLinuxApp();
    // Reserve the browser tab during the click so popup blocking cannot turn
    // a successful authorization start into a second required click.
    const popup = native ? null : window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const result = await updateCursorConnection("start");
      setAttempt(result);
      setStatus("pending");
      setOpenManually(!native && !popup);
      if (isBridgeAvailable()) postNativeMessage({ type: "action", name: "openURL", value: result.authUrl });
      else if (isNativeLinuxApp()) await getNativeOAuthBridge().postMessage(result.authUrl);
      else if (popup) popup.location.replace(result.authUrl);
    } catch {
      popup?.close();
      setAttempt(null);
      setStatus("failed");
    }
  };
  const disconnect = async () => {
    setMenuOpen(false);
    setStatus("starting");
    try {
      await updateCursorConnection("disconnect");
      setStatus("idle");
      onSavedRef.current?.();
    } catch {
      setStatus("failed");
    }
  };
  const error = status === "failed" || status === "expired"
    ? copy(status === "expired" ? "limits.cursor.connection.expired" : "limits.cursor.connection.failed") : null;

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      {attempt ? (
        <>
          {openManually ? <a className={BUTTON_CLASS} href={attempt.authUrl} target="_blank" rel="noopener noreferrer">{copy("limits.cursor.connection.open")}</a> : (
            <span role="status" className="inline-flex items-center gap-1.5 px-1 text-xs text-oai-gray-500">
              <LoaderCircle size={12} className="motion-safe:animate-spin" aria-hidden />{copy("limits.cursor.connection.waiting")}
            </span>
          )}
          <button className={BUTTON_CLASS} type="button" aria-label={copy("limits.cursor.connection.cancel")} onClick={() => { setAttempt(null); setStatus("idle"); }}><X size={13} aria-hidden /></button>
        </>
      ) : null}
      {!attempt && connected ? (
        <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Popover.Trigger className={BUTTON_CLASS} aria-label={copy("limits.cursor.connection.manage")} disabled={status === "starting"} title={error || copy("limits.cursor.connection.manage")}><MoreHorizontal size={16} aria-hidden /></Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
              <Popover.Popup className="flex min-w-36 flex-col rounded-lg bg-white p-1 shadow-lg ring-1 ring-oai-gray-200 dark:bg-oai-gray-950 dark:ring-oai-gray-800" onClick={(event) => event.stopPropagation()}>
                <button className={`${BUTTON_CLASS} justify-start`} type="button" onClick={start}>{copy("limits.cursor.connection.reconnect")}</button>
                <button className={`${BUTTON_CLASS} justify-start`} type="button" onClick={disconnect}>{copy("limits.cursor.connection.disconnect")}</button>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
      {!attempt && !connected ? (
        <button className={`${BUTTON_CLASS} border border-oai-gray-300 bg-oai-gray-50 font-medium dark:border-oai-gray-700 dark:bg-oai-gray-800`} type="button" disabled={status === "starting"} onClick={start} title={error || undefined}>
          {status === "starting" ? <LoaderCircle size={12} className="motion-safe:animate-spin" aria-hidden /> : null}
          {copy(error ? "limits.cursor.connection.retry" : "limits.cursor.connection.connect")}
        </button>
      ) : null}
      {error ? <span role="alert" className="sr-only">{error}</span> : null}
    </span>
  );
}
