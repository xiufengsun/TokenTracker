import React, { useEffect, useState } from "react";
import { BookOpen, Loader2, Server } from "lucide-react";
import { copy, getCopyLocale } from "../../lib/copy";
import { resetInsforgeClientForInstanceChange } from "../../lib/insforge-config";
import { useInstanceSettings } from "../../hooks/use-instance-settings.js";
import { SectionCard, SETTINGS_INPUT_CLASS } from "./Controls.jsx";
import { Button } from "../../ui/components/Button.jsx";
import { ConfirmModal } from "../../ui/components/ConfirmModal.jsx";

const ERROR_COPY_KEYS = {
  invalid_instance_url: "settings.instance.error.url",
  instance_anon_key_required: "settings.instance.error.keyRequired",
  invalid_instance_anon_key: "settings.instance.error.keyInvalid",
};

const SELF_HOSTING_GUIDE = {
  chinese: "https://github.com/xiufengsun/TokenTracker/blob/main/docs/self-hosting.zh-CN.md",
  default: "https://github.com/xiufengsun/TokenTracker/blob/main/docs/self-hosting.md",
};

function selfHostingGuideUrl() {
  const locale = getCopyLocale();
  return locale === "zh-CN" || locale === "zh-TW"
    ? SELF_HOSTING_GUIDE.chinese
    : SELF_HOSTING_GUIDE.default;
}

function errorMessage(error) {
  const key = ERROR_COPY_KEYS[error?.message];
  return key ? copy(key) : copy("settings.instance.error.generic");
}

/**
 * Cloud instance target: point the local client at a self-hosted InsForge
 * deployment instead of the official cloud. Only renders when the local
 * dashboard server exposes the instance-config API — public deploys have
 * nothing to reconfigure.
 */
export function InstanceSectionCard({ signedIn = false } = {}) {
  const { available, loading, config, save, test } = useInstanceSettings();
  const [baseUrl, setBaseUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [applied, setApplied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pendingSwitch, setPendingSwitch] = useState(null);

  useEffect(() => {
    if (!available) return;
    setBaseUrl(config.custom ? config.baseUrl : "");
    setAnonKey("");
  }, [available, config.baseUrl, config.custom]);

  // A pending availability check is not the same as an unavailable API: show
  // the card's loading line while the probe is in flight so Settings does not
  // silently omit the Server section, and only hide it once the local API is
  // known to be absent (public deploys, older embedded servers).
  if (!available && loading) {
    return (
      <SectionCard title={copy("settings.instance.title")} subtitle={copy("settings.instance.subtitle")}>
        <p role="status" className="py-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <Loader2 size={12} className="mr-1 inline motion-safe:animate-spin" aria-hidden />
          {copy("settings.instance.loading")}
        </p>
      </SectionCard>
    );
  }
  if (!available) return null;

  const persist = async (payload) => {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      await save(payload);
      setApplied(true);
      // Drop the SDK session for the old instance, then reload so the
      // freshly injected runtime config (new baseUrl + anon key) takes over.
      resetInsforgeClientForInstanceChange();
      window.setTimeout(() => window.location.reload(), 600);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  };

  // Switching servers drops the signed-in session: every server keeps its own
  // accounts, so confirm first instead of silently signing the user out.
  const request = (payload) => {
    if (signedIn && payload.baseUrl !== config.baseUrl) {
      setPendingSwitch(payload);
      return;
    }
    persist(payload);
  };

  const runTest = async () => {
    const target = baseUrl.trim() || config.officialUrl;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await test(target);
      // Discard a result that no longer matches the field: a slow probe for a
      // previous address must not read as validation for the current one.
      if ((baseUrl.trim() || config.officialUrl) === target) setTestResult(result);
    } catch (reason) {
      if ((baseUrl.trim() || config.officialUrl) === target) setError(errorMessage(reason));
    } finally {
      setTesting(false);
    }
  };

  return (
    <SectionCard
      title={copy("settings.instance.title")}
      subtitle={copy("settings.instance.subtitle")}
    >
      <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Server className="h-4 w-4 shrink-0 text-oai-gray-400" aria-hidden />
          <span className="min-w-0 break-all text-sm text-oai-gray-700 dark:text-oai-gray-300">
            {config.custom ? config.baseUrl : copy("settings.instance.official")}
          </span>
          {config.configurationError ? (
            <span className="shrink-0 text-xs text-red-600 dark:text-red-400">
              {copy("settings.instance.error.invalidConfig")}
            </span>
          ) : null}
          <span
            className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
              config.custom
                ? "border-oai-gray-200 bg-oai-gray-50 text-oai-gray-700 dark:border-oai-gray-800 dark:bg-oai-gray-800/60 dark:text-oai-gray-300"
                : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
            }`}
          >
            {config.custom
              ? copy("settings.instance.badge.selfHosted")
              : copy("settings.instance.badge.official")}
          </span>
        </div>
        {!editing ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || applied}
            onClick={() => {
              setEditing(true);
              setApplied(false);
              setError(null);
            }}
          >
            {config.custom
              ? copy("settings.instance.action.edit")
              : copy("settings.instance.action.useSelfHosted")}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-3 pb-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-oai-gray-900 dark:text-oai-gray-200">
              {copy("settings.instance.field.url")}
            </span>
            <input
              type="url"
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                // An edited address invalidates any earlier probe result.
                setTestResult(null);
              }}
              placeholder={config.officialUrl}
              spellCheck={false}
              autoComplete="off"
              className={SETTINGS_INPUT_CLASS}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-oai-gray-900 dark:text-oai-gray-200">
              {copy("settings.instance.field.anonKey")}
            </span>
            <input
              type="text"
              value={anonKey}
              onChange={(event) => setAnonKey(event.target.value)}
              placeholder={copy("settings.instance.field.anonKeyPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="settings-instance-anon-key-hint"
              className={SETTINGS_INPUT_CLASS}
            />
          </label>
          <p id="settings-instance-anon-key-hint" className="text-xs leading-5 text-oai-gray-500 dark:text-oai-gray-400">
            {copy("settings.instance.field.anonKeyHint")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy || applied || !baseUrl.trim()}
              onClick={() => request({ baseUrl: baseUrl.trim(), anonKey })}
            >
              {busy || applied ? (
                <>
                  <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden />
                  {copy("settings.instance.applying")}
                </>
              ) : (
                copy("settings.instance.action.save")
              )}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={testing || busy || applied}
              onClick={runTest}
            >
              {testing ? (
                <>
                  <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden />
                  {copy("settings.instance.testing")}
                </>
              ) : (
                copy("settings.instance.action.test")
              )}
            </Button>
            {config.custom ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || applied}
                onClick={() => request({ baseUrl: config.officialUrl })}
              >
                {copy("settings.instance.action.restoreOfficial")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || applied}
              onClick={() => {
                setEditing(false);
                setError(null);
                setTestResult(null);
                setBaseUrl(config.custom ? config.baseUrl : "");
                setAnonKey("");
              }}
            >
              {copy("shared.action.cancel")}
            </Button>
          </div>
          <a
            href={selfHostingGuideUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-oai-gray-500 underline-offset-2 transition-colors hover:text-oai-black hover:underline dark:text-oai-gray-400 dark:hover:text-white"
          >
            <BookOpen className="h-3 w-3" aria-hidden />
            {copy("settings.instance.guide")}
          </a>
        </div>
      ) : null}
      {testResult ? (
        <p
          role="status"
          className={`pb-3 text-xs ${testResult.reachable ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
        >
          {testResult.reachable
            ? copy("settings.instance.test.ok", { status: testResult.status ?? "—" })
            : testResult.error === "certificate"
              ? copy("settings.instance.test.certificate")
              : copy("settings.instance.test.unreachable")}
        </p>
      ) : null}
      {applied ? (
        <p role="status" className="pb-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("settings.instance.applied")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="pb-3 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="pb-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          <Loader2 size={12} className="mr-1 inline motion-safe:animate-spin" aria-hidden />
          {copy("settings.instance.loading")}
        </p>
      ) : null}
      <ConfirmModal
        open={pendingSwitch !== null}
        title={copy("settings.instance.confirm.title")}
        description={copy("settings.instance.confirm.description")}
        destructive
        busy={busy}
        confirmLabel={copy("settings.instance.confirm.confirm")}
        cancelLabel={copy("shared.action.cancel")}
        onConfirm={() => {
          const payload = pendingSwitch;
          setPendingSwitch(null);
          persist(payload);
        }}
        onCancel={() => setPendingSwitch(null)}
      />
    </SectionCard>
  );
}
