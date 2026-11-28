import React, { useEffect, useState } from "react";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext";
import { copy } from "../lib/copy";
import { getInsforgeInstanceFingerprint, getInsforgeRemoteUrl } from "../lib/insforge-config";
import { functionUrlFor } from "../lib/function-url";

/**
 * /device — OAuth-style device flow approval page.
 *
 * Pairs a headless CLI session (SSH / Docker / CI) with the user's browser
 * sign-in. The CLI prints an 8-char user_code; the user opens this page,
 * signs in if they aren't already, types the code, hits Approve, and the
 * CLI's next poll comes back with the granted user_id.
 *
 * Deep-link: `…/device?user_code=XXXX-XXXX` pre-fills the input.
 */

function normalizeUserCode(s) {
  return (s || "").toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9-]/g, "");
}

export default function DevicePage() {
  const auth = useInsforgeAuth();
  const [userCode, setUserCode] = useState("");
  const [status, setStatus] = useState({ kind: "idle", message: "" });

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const prefill = params.get("user_code");
      if (prefill) setUserCode(normalizeUserCode(prefill));
    } catch { /* ignore */ }
  }, []);

  async function onSubmit(event) {
    event?.preventDefault?.();
    if (!auth?.signedIn) {
      setStatus({ kind: "error", message: copy("device.approval.error.sign_in") });
      return;
    }
    const code = normalizeUserCode(userCode);
    if (!/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(code)) {
      setStatus({ kind: "error", message: copy("device.approval.error.invalid_code") });
      return;
    }
    setStatus({ kind: "working", message: copy("device.approval.action.approving") });
    try {
      const baseUrl = getInsforgeRemoteUrl();
      const token = await auth.getAccessToken?.();
      if (!token || !baseUrl || getInsforgeInstanceFingerprint() !== baseUrl) {
        setStatus({ kind: "error", message: copy("device.approval.error.no_token") });
        return;
      }
      const res = await fetch(functionUrlFor(baseUrl, "tokentracker-device-flow-grant"), {
        redirect: "error",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ user_code: code }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus({
          kind: "success",
          message:
            body.status === "already_approved"
              ? body.client_info
                ? copy("device.approval.success.already_client", { client: body.client_info })
                : copy("device.approval.success.already")
              : body.client_info
                ? copy("device.approval.success.approved_client", { client: body.client_info })
                : copy("device.approval.success.approved"),
        });
      } else if (res.status === 404) {
        setStatus({ kind: "error", message: copy("device.approval.error.not_found") });
      } else if (res.status === 410) {
        setStatus({ kind: "error", message: copy("device.approval.error.expired") });
      } else if (res.status === 401) {
        setStatus({ kind: "error", message: copy("device.approval.error.session_expired") });
      } else {
        setStatus({
          kind: "error",
          message: body?.error
            ? copy("device.approval.error.server_detail", { message: body.error })
            : copy("device.approval.error.server", { status: res.status }),
        });
      }
    } catch (e) {
      setStatus({
        kind: "error",
        message: copy("device.approval.error.network", { message: e?.message || e }),
      });
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-oai-gray-950 px-6 py-12">
      <div className="w-full max-w-md rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-8">
        <h1 className="text-2xl font-semibold text-oai-gray-900 dark:text-white mb-2">
          {copy("device.approval.title")}
        </h1>
        <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400 mb-6">
          {copy("device.approval.description")}
        </p>

        {!auth?.signedIn ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-4 mb-4">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {copy("device.approval.sign_in_banner")}
            </p>
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block">
            <span className="block text-xs font-medium uppercase tracking-wide text-oai-gray-500 dark:text-oai-gray-400 mb-1">
              {copy("device.approval.code_label")}
            </span>
            <input
              type="text"
              value={userCode}
              onChange={(e) => setUserCode(normalizeUserCode(e.target.value))}
              placeholder="XXXX-XXXX"
              spellCheck={false}
              autoCapitalize="characters"
              maxLength={9}
              className="w-full font-mono text-xl tracking-widest text-center rounded-md border border-oai-gray-300 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-900 text-oai-gray-900 dark:text-white px-4 py-3 focus:outline-none focus:ring-inset focus:ring-2 focus:ring-emerald-600"
            />
          </label>

          <button
            type="submit"
            disabled={status.kind === "working" || !auth?.signedIn}
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:bg-oai-gray-300 disabled:cursor-not-allowed text-white font-medium py-3 transition-colors"
          >
            {status.kind === "working"
              ? copy("device.approval.action.approving")
              : copy("device.approval.action.approve")}
          </button>
        </form>

        {status.kind === "success" && (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 p-4">
            <p className="text-sm text-emerald-700 dark:text-emerald-300">{status.message}</p>
          </div>
        )}
        {status.kind === "error" && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 p-4">
            <p className="text-sm text-red-700 dark:text-red-300">{status.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}
