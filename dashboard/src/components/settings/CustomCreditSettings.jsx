import React, { useEffect, useState } from "react";
import { customCreditConfig } from "../../lib/api";
import { copy } from "../../lib/copy";
import { invalidateCustomCreditUsage } from "../../lib/dashboard-preload.js";
import { Button } from "../../ui/components/Button.jsx";
import { SectionCard, SETTINGS_INPUT_CLASS } from "./Controls.jsx";

function editableConfig(config) {
  return {
    displayName: config.displayName ?? "",
    gatewayBaseUrl: config.gatewayBaseUrl ?? "",
    apiKey: "",
    dailyCreditLimit: config.dailyCreditLimit ?? (config.hasApiKey ? "" : "150"),
    weeklyCreditLimit: config.weeklyCreditLimit ?? "",
    monthlyCreditLimit: config.monthlyCreditLimit ?? "",
  };
}

export function CustomCreditSettings() {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState("loading");
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    let active = true;
    customCreditConfig().then((config) => {
      if (!active) return;
      setSaved(config);
      setForm(editableConfig(config));
      setStatus("idle");
    }).catch(() => { if (active) setStatus("load-error"); });
    return () => { active = false; };
  }, [loadVersion]);

  async function persist(method) {
    if (method === "PUT" && [form.dailyCreditLimit, form.weeklyCreditLimit, form.monthlyCreditLimit]
      .some((value) => value !== "" && !(Number(value) > 0))) {
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
      invalidateCustomCreditUsage();
      setSaved(config);
      setForm(editableConfig(config));
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  function field(key, text, props = {}) {
    return (
      <label className="block min-w-0 space-y-1 text-xs text-oai-gray-600 dark:text-oai-gray-300">
        <span>{text}</span>
        <input {...props} className={SETTINGS_INPUT_CLASS} value={form[key]}
          onChange={(e) => { setForm({ ...form, [key]: e.target.value }); setStatus("idle"); }} />
      </label>
    );
  }
  return (
    <SectionCard title={copy("limits.provider.customCredits")} subtitle={copy("limits.customCredits.setup")}>
      {status === "load-error" ? <Button size="sm" variant="secondary" onClick={() => {
        setStatus("loading"); setLoadVersion((v) => v + 1);
      }}>{copy("sessions.error.retry")}</Button> : null}
      {form ? <form onSubmit={(e) => { e.preventDefault(); void persist("PUT"); }}>
        <fieldset disabled={status === "busy"} className="space-y-3 pb-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {field("displayName", copy("limits.customCredits.name"), { type: "text", maxLength: 80 })}
            {field("gatewayBaseUrl", copy("limits.customCredits.gateway"), { type: "url", required: true, autoComplete: "off", spellCheck: false })}
          </div>
          {field("apiKey", copy("limits.customCredits.key"), { type: "password", autoComplete: "new-password",
            required: !saved?.hasApiKey || form.gatewayBaseUrl.trim() !== saved.gatewayBaseUrl,
            placeholder: saved?.hasApiKey ? copy("limits.customCredits.keepKey") : undefined })}
          <div className="grid grid-cols-3 gap-2">
            {field("dailyCreditLimit", copy("limits.label.devin_daily"), { type: "number", min: "0", step: "any", required: true })}
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
