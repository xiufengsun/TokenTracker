import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { copy, getCopyLocale } from "../../../lib/copy";
import { Button, ConfirmModal, Input, Select } from "../../components";
import { ProviderIcon } from "./ProviderIcon.jsx";
import { countdownText, cycleView, remainingLabel } from "../../../lib/subscription-display";
import {
  LIMIT_PROVIDER_IDS,
  limitProviderIconKey,
  limitProviderName,
} from "../../../lib/limits-providers.js";
import {
  createSubscription,
  deleteSubscription,
  updateSubscription,
} from "../../../lib/subscription-manager-api";

const EMPTY_FORM = {
  service: "",
  plan: "",
  provider: "",
  cycle: "monthly",
  autoRenew: true,
  nextBillingAt: "",
};

// datetime-local values are local-time; the stored record is UTC. This is the
// display side of the round trip (openEdit → input → new Date() on submit).
export function toDatetimeLocalValue(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Subscription settings card rendered inside the Limits header popover.
 * Controlled by the parent (which fetches the list and refreshes after
 * mutations); this component only owns form / delete / expand local state.
 */
export function SubscriptionSettingsCard({ subscriptions, onChanged }) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(getCopyLocale(), {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [],
  );

  // Refresh countdowns/remaining labels once a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const providerOptions = useMemo(
    () => [
      { value: "", label: copy("subscriptions.form.provider_none") },
      ...LIMIT_PROVIDER_IDS.map((id) => ({ value: id, label: limitProviderName(id) })),
    ],
    [],
  );

  const cycleOptions = useMemo(
    () => [
      { value: "weekly", label: copy("subscriptions.form.cycle_weekly") },
      { value: "monthly", label: copy("subscriptions.form.cycle_monthly") },
      { value: "yearly", label: copy("subscriptions.form.cycle_yearly") },
    ],
    [],
  );

  const openAdd = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(false);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((subscription) => {
    setForm({
      service: subscription.service,
      plan: subscription.plan || "",
      provider: subscription.provider || "",
      cycle: subscription.cycle || "monthly",
      autoRenew: subscription.autoRenew,
      nextBillingAt: toDatetimeLocalValue(subscription.nextBillingAt),
    });
    setEditingId(subscription.id);
    setFormError(false);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(false);
  }, []);

  const handleSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      setFormError(false);
      const timestamp = new Date(form.nextBillingAt).getTime();
      if (!Number.isFinite(timestamp)) {
        setFormError(true);
        return;
      }
      const payload = {
        service: form.service,
        plan: form.plan,
        provider: form.provider || null,
        autoRenew: form.autoRenew,
        cycle: form.cycle,
        nextBillingAt: timestamp,
      };
      setSaving(true);
      try {
        if (editingId) {
          await updateSubscription(editingId, payload);
        } else {
          await createSubscription(payload);
        }
        closeForm();
        await onChanged?.();
      } catch (_e) {
        setFormError(true);
      } finally {
        setSaving(false);
      }
    },
    [closeForm, editingId, form, onChanged],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      await deleteSubscription(pendingDelete.id);
      setPendingDelete(null);
      await onChanged?.();
    } catch (_e) {
      // Keep the dialog open with a visible error: silently closing it
      // would look exactly like a successful delete.
      setDeleteError(true);
    } finally {
      setDeleting(false);
    }
  }, [onChanged, pendingDelete]);

  const list = subscriptions || [];

  return (
    <div className="flex w-[min(90vw,22rem)] flex-col gap-3 rounded-xl border border-oai-gray-200 bg-white p-4 shadow-lg dark:border-oai-gray-700 dark:bg-oai-gray-900">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-oai-black dark:text-white">
          {copy("limits.page.openSubscriptions")}
        </span>
        <Button type="button" size="sm" onClick={openAdd} className="gap-1.5">
          <Plus size={14} strokeWidth={2} aria-hidden />
          <span>{copy("subscriptions.add")}</span>
        </Button>
      </div>

      {formOpen ? (
        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 border-b border-oai-gray-100 pb-3 dark:border-oai-gray-800">
          <div className="flex flex-col">
            <label
              htmlFor="subscription-provider"
              className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5"
            >
              {copy("subscriptions.form.provider")}
            </label>
            <Select
              id="subscription-provider"
              value={form.provider}
              onValueChange={(value) => setForm({ ...form, provider: String(value) })}
              options={providerOptions}
              matchTriggerWidth
              className="h-10 w-full px-3 text-sm"
            />
          </div>
          <div className="flex flex-col">
            <label
              htmlFor="subscription-cycle"
              className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5"
            >
              {copy("subscriptions.form.cycle")}
            </label>
            <Select
              id="subscription-cycle"
              value={form.cycle}
              onValueChange={(value) => setForm({ ...form, cycle: String(value) })}
              options={cycleOptions}
              matchTriggerWidth
              className="h-10 w-full px-3 text-sm"
            />
          </div>
          <Input
            label={copy("subscriptions.form.service")}
            value={form.service}
            maxLength={120}
            required
            placeholder={copy("subscriptions.form.service_placeholder")}
            onChange={(event) => setForm({ ...form, service: event.target.value })}
          />
          <Input
            label={copy("subscriptions.form.plan")}
            value={form.plan}
            maxLength={120}
            placeholder={copy("subscriptions.form.plan_placeholder")}
            onChange={(event) => setForm({ ...form, plan: event.target.value })}
          />
          <Input
            label={copy("subscriptions.form.next_billing")}
            type="datetime-local"
            value={form.nextBillingAt}
            required
            onChange={(event) => setForm({ ...form, nextBillingAt: event.target.value })}
          />
          <div className="flex flex-col">
            <span className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5">
              {copy("subscriptions.form.auto_renew")}
            </span>
            <label className="flex h-10 items-center gap-2.5">
              <input
                type="checkbox"
                checked={form.autoRenew}
                onChange={(event) => setForm({ ...form, autoRenew: event.target.checked })}
                className="h-4 w-4 accent-oai-brand"
              />
              <span className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
                {copy("subscriptions.form.auto_renew_hint")}
              </span>
            </label>
          </div>
          <div className="flex items-center justify-end gap-2">
            {formError ? (
              <p className="mr-auto text-sm text-oai-error" role="alert">
                {copy("subscriptions.form.error")}
              </p>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={closeForm}>
              {copy("shared.action.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {copy("subscriptions.save")}
            </Button>
          </div>
        </form>
      ) : null}

      {list.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-oai-gray-200 px-4 py-10 text-center dark:border-oai-gray-700">
          <CalendarClock className="h-6 w-6 text-oai-gray-300 dark:text-oai-gray-600 mb-2" aria-hidden />
          <p className="text-sm font-medium text-oai-black dark:text-white">
            {copy("subscriptions.empty.title")}
          </p>
          <p className="text-xs text-oai-gray-500 dark:text-oai-gray-400">
            {copy("subscriptions.empty.body")}
          </p>
        </div>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {list.map((subscription) => {
            const view = cycleView(subscription, now);
            if (!view) return null;
            const { endMs, expired } = view;
            const widthPct = expired ? 100 : view.progress * 100;
            const nearExpiry = !expired && endMs - now <= 3 * 86400000;
            const expanded = expandedId === subscription.id;
            return (
              <li key={subscription.id} className="rounded-lg border border-oai-gray-100 dark:border-oai-gray-800">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : subscription.id)}
                  aria-expanded={expanded}
                  className="w-full flex flex-col gap-1.5 px-3 py-2.5 text-left cursor-pointer hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/40 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <ProviderIcon provider={limitProviderIconKey(subscription.provider) || "OTHER"} size={14} />
                    <span className="text-sm font-medium text-oai-black dark:text-white truncate">
                      {subscription.service}
                    </span>
                    {subscription.plan ? (
                      <span className="text-xs rounded-full border border-oai-gray-200 dark:border-oai-gray-700 px-2 py-0.5 text-oai-gray-500 dark:text-oai-gray-400 shrink-0">
                        {subscription.plan}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-[10px] text-oai-gray-500 dark:text-oai-gray-400 shrink-0">
                      {copy("shared.time.d_ago", { n: view.cycleDays })}
                    </span>
                    <span className="relative flex-1 bg-oai-gray-100 dark:bg-oai-gray-700/50 rounded-full h-1 overflow-hidden">
                      <span
                        className={`${
                          expired ? "bg-red-500" : nearExpiry ? "bg-amber-500" : "bg-oai-brand-500"
                        } rounded-full h-full block transition-[width] duration-500 ease-out`}
                        style={{ width: `${widthPct}%`, minWidth: widthPct > 0 ? "3px" : 0 }}
                      />
                    </span>
                    <span
                      className={`text-[10px] tabular-nums shrink-0 ${
                        expired ? "text-oai-error" : "text-oai-gray-400 dark:text-oai-gray-500"
                      }`}
                    >
                      {remainingLabel(endMs, now)}
                    </span>
                  </span>
                </button>
                {expanded ? (
                  <div className="px-3 pb-3 flex flex-col gap-2 border-t border-oai-gray-100 dark:border-oai-gray-800">
                    <p className="pt-2 text-xs text-oai-gray-600 dark:text-oai-gray-300">
                      <span className="text-oai-gray-400 dark:text-oai-gray-500">
                        {subscription.autoRenew
                          ? copy("subscriptions.label.renews_at")
                          : copy("subscriptions.label.expires_at")}
                      </span>{" "}
                      <span className="font-mono tabular-nums">
                        {dateFormat.format(new Date(endMs))}
                      </span>
                      {" · "}
                      <span className={expired ? "text-oai-error" : undefined}>
                        {countdownText(endMs, now)}
                      </span>
                      {" · "}
                      <span>
                        {subscription.autoRenew
                          ? copy("subscriptions.status.auto_renew")
                          : copy("subscriptions.status.manual")}
                      </span>
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => openEdit(subscription)}
                      >
                        {copy("subscriptions.edit")}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setPendingDelete(subscription)}
                        className="!text-red-600 dark:!text-red-400"
                      >
                        {copy("subscriptions.delete")}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmModal
        open={Boolean(pendingDelete)}
        title={copy("subscriptions.confirm_delete_title")}
        description={pendingDelete?.service || ""}
        error={deleteError ? copy("subscriptions.delete_error") : null}
        confirmLabel={copy("subscriptions.delete")}
        cancelLabel={copy("shared.action.cancel")}
        destructive
        busy={deleting}
        onCancel={() => {
          setPendingDelete(null);
          setDeleteError(false);
        }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
