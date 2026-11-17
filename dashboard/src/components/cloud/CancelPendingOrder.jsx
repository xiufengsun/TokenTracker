import React, { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/components/Button.jsx";
import { copy } from "../../lib/copy";
import { resolveAuthAccessToken } from "../../lib/auth-token";
import { getInsforgeInstanceFingerprint } from "../../lib/insforge-config";
import { cloudBillingRequest, CloudBillingError } from "../../lib/cloud-billing";

export function CancelPendingOrder({ order, auth, refresh, onResult, request = cloudBillingRequest }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  const scope = `${auth?.user?.id}:${getInsforgeInstanceFingerprint()}:${order.id}`;
  const current = useRef(scope);
  current.current = scope;
  const mounted = useRef(false);
  const trigger = useRef(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setConfirm(false); setResult(null); setFailed(false); setBusy(false); lock.current = false; }, [scope]);
  const processing = result === "processing" || (!!order.cancel_requested_at && !["cancelled", "not_cancelled"].includes(result));
  const unverified = !processing && (result === "unverified" || order.cancel_verification_pending);
  const cancelled = result === "cancelled";
  const paid = result === "not_cancelled";
  const run = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setFailed(false);
    setResult("unverified"); setConfirm(false);
    onResult?.("unverified", { id: order.id, status: order.status,
      cancel_requested_at: order.cancel_requested_at, cancel_verification_pending: true });
    const owner = scope;
    const valid = () => mounted.current && current.current === owner;
    try {
      const value = await request("cancel-order", { auth: async () => {
        const token = await resolveAuthAccessToken(auth.getAccessToken);
        if (!valid()) throw new CloudBillingError("authentication_required", 401);
        return token;
      }, body: { id: order.id } });
      if (!valid()) return;
      if (!["processing", "cancelled", "not_cancelled"].includes(value.cancellation)) throw new Error("invalid cancellation response");
      setResult(value.cancellation); setConfirm(false); onResult?.(value.cancellation, value.order ? { ...value.order, cancel_verification_pending: false } : undefined);
      await refresh();
      if (valid()) requestAnimationFrame(() => trigger.current?.querySelector("button")?.focus());
    } catch { if (valid()) { setFailed(true); setResult("unverified"); setConfirm(false); } }
    finally { if (valid()) { lock.current = false; setBusy(false); } }
  };
  if (order.provider !== "waffo" || !["pending", "ready"].includes(order.status) || ["paid", "partially_refunded", "refunded"].includes(order.payment_state) || order.retry_payment_conflict_at) return null;
  return <div ref={trigger} className="col-span-full space-y-2 text-sm">
    {processing || unverified || cancelled || paid ? <p role="status" className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-300">
      {copy(cancelled ? "cloud.order_cancel.done" : paid ? "cloud.order_cancel.paid" : processing ? "cloud.order_cancel.processing" : "cloud.order_cancel.unknown")}
    </p> : null}
    {processing && order.checkout_tracking_uncertain ? <p role="note" className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-300">{copy("cloud.order_cancel.unverified")}</p> : null}
    {failed ? <p role="alert" className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-300">{copy("cloud.order_cancel.error")}</p> : null}
    {!cancelled && !paid ? confirm ? <div role="group" aria-label={copy("cloud.order_cancel.confirm")} className="space-y-2">
      <p className="text-xs leading-5 text-oai-gray-600 dark:text-oai-gray-300">{copy("cloud.order_cancel.detail")}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="min-h-10" variant="secondary" disabled={busy} onClick={() => { setConfirm(false); requestAnimationFrame(() => trigger.current?.querySelector("button")?.focus()); }}>{copy("shared.action.cancel")}</Button>
        <Button size="sm" className="min-h-10" disabled={busy} onClick={() => void run()}>{copy(busy ? "cloud.order_cancel.sending" : "cloud.order_cancel.confirm")}</Button>
      </div>
    </div> : <Button size="sm" variant="ghost" className="!h-10 !px-0" disabled={busy}
      onClick={() => processing || unverified ? void run() : setConfirm(true)}>
      {copy(busy ? "cloud.order_cancel.sending" : processing || unverified ? "cloud.order_cancel.check" : "cloud.order_cancel.action")}
    </Button> : null}
  </div>;
}
