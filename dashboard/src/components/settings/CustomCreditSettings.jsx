import React, { useEffect, useState } from "react";
import { customCreditConfig } from "../../lib/api";
import { copy } from "../../lib/copy";
import { invalidateCustomCreditUsage, subscribeCustomCreditChanges } from "../../lib/custom-credit-config";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard, SETTINGS_INPUT_CLASS } from "./Controls.jsx";

function editableConfig(config) {
  return {
    displayName: config.displayName ?? "",
    gatewayBaseUrl: config.gatewayBaseUrl ?? "",
    dailyCreditLimit: config.dailyCreditLimit ?? (config.hasApiKey ? "" : "150"),
    weeklyCreditLimit: config.weeklyCreditLimit ?? "",
    monthlyCreditLimit: config.monthlyCreditLimit ?? "",
  };
}

// Match the server's accepted spellings of a saved canonical gateway.
function isSavedGateway(value, savedBase) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    const base = url.origin + url.pathname.replace(/\/+$/, "");
    return base === savedBase || base.replace(/\/v1$/, "").replace(/\/+$/, "") === savedBase;
  } catch { return false; }
}

const creditLimits = ["dailyCreditLimit", "weeklyCreditLimit", "monthlyCreditLimit"];
function validLimits(form) {
  const filled = creditLimits.map((key) => form[key]).filter((value) => value !== "");
  return filled.length > 0 && filled.every((value) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount <= Number.MAX_SAFE_INTEGER && amount > 0;
  });
}

export function CustomCreditSettings({ active = true }) {
  const [saved, setSaved] = useState(null);
  const [edits, setEdits] = useState({});
  const [keyDraft, setKeyDraft] = useState(null);
  const [status, setStatus] = useState("idle");
  const [loadState, setLoadState] = useState("loading");
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    if (!active) return;
    let generation = 0;
    async function load() {
      const request = ++generation;
      setLoadState("loading");
      try {
        const config = await customCreditConfig();
        if (request !== generation) return;
        setSaved(config);
        setLoadState("ready");
      } catch {
        if (request === generation) setLoadState("error");
      }
    }
    void load();
    const unsubscribe = subscribeCustomCreditChanges(load);
    return () => { generation++; unsubscribe(); };
  }, [active, loadVersion]);

  const form = saved && { ...editableConfig(saved), ...edits };
  if (form) form.apiKey = keyDraft?.gateway === form.gatewayBaseUrl ? keyDraft.value : "";
  const retainsKey = saved?.hasApiKey && isSavedGateway(form.gatewayBaseUrl, saved.gatewayBaseUrl);

  function edit(key, value) {
    setStatus("idle");
    if (key === "apiKey") {
      setKeyDraft({ gateway: form.gatewayBaseUrl, value });
      return;
    }
    if (key === "gatewayBaseUrl") setKeyDraft(null);
    setEdits((previous) => {
      const next = { ...previous, [key]: value };
      if (value === String(editableConfig(saved)[key])) delete next[key];
      return next;
    });
  }

  async function persist(method) {
    if (method === "PUT" && !validLimits(form)) {
      setStatus("invalid-limit");
      return;
    }
    setStatus("busy");
    try {
      const amount = (value) => value === "" ? null : Number(value);
      const payload = method === "PUT" ? {
        gatewayBaseUrl: form.gatewayBaseUrl.trim(), displayName: form.displayName.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        dailyCreditLimit: amount(form.dailyCreditLimit),
        weeklyCreditLimit: amount(form.weeklyCreditLimit),
        monthlyCreditLimit: amount(form.monthlyCreditLimit),
      } : undefined;
      const config = await customCreditConfig(method, payload);
      setSaved(config);
      setEdits({});
      setKeyDraft(null);
      setStatus("saved");
      invalidateCustomCreditUsage();
    } catch {
      setStatus("error");
    }
  }

  function field(key, text, props = {}) {
    return (
      <label className="block min-w-0 space-y-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
        <span>{text}</span>
        <input {...props} className={SETTINGS_INPUT_CLASS} value={form[key]}
          onChange={(e) => edit(key, e.target.value)} />
      </label>
    );
  }
  return (
    <SectionCard title={copy("limits.provider.customCredits")} subtitle={copy("limits.customCredits.setup")}>
      {loadState === "error" ? <Button size="sm" variant="secondary" onClick={() => {
        setLoadVersion((v) => v + 1);
      }}>{copy("sessions.error.retry")}</Button> : null}
      {form ? <form onSubmit={(e) => { e.preventDefault(); void persist("PUT"); }}>
        <fieldset disabled={status === "busy" || loadState !== "ready"} className="space-y-3 pb-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {field("displayName", copy("limits.customCredits.name"), { type: "text", maxLength: 80 })}
            {field("gatewayBaseUrl", copy("limits.customCredits.gateway"), { type: "url", required: true, autoComplete: "off", spellCheck: false })}
          </div>
          {field("apiKey", copy("limits.customCredits.key"), { type: "password", autoComplete: "new-password",
            required: !retainsKey,
            placeholder: retainsKey ? copy("limits.customCredits.keepKey") : undefined })}
          <div className="grid grid-cols-3 gap-2">
            {field("dailyCreditLimit", copy("limits.label.devin_daily"), { type: "number", min: "0", step: "any" })}
            {field("weeklyCreditLimit", copy("limits.label.devin_weekly"), { type: "number", min: "0", step: "any" })}
            {field("monthlyCreditLimit", copy("limits.label.opencode_go_monthly"), { type: "number", min: "0", step: "any" })}
          </div>
          <p className="text-xs text-oai-gray-500">{copy("limits.customCredits.budgets")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" type="submit">{copy("settings.network.save")}</Button>
            {saved?.hasApiKey && <Button size="sm" variant="secondary" type="button" onClick={() => void persist("DELETE")}>
              {copy("limits.cursor.connection.disconnect")}
            </Button>}
            <span role="status" className="text-xs text-oai-gray-500">
              {status === "saved" && copy("limits.customCredits.saved")}
              {status === "error" && copy("limits.customCredits.failed")}
              {status === "invalid-limit" && copy("limits.customCredits.positive")}
            </span>
          </div>
        </fieldset>
      </form> : null}
    </SectionCard>
  );
}
