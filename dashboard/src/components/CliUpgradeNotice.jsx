import React, { useState } from "react";
import { copy } from "../lib/copy";
import { isProductionHost } from "../lib/host-mode";
import { safeWriteClipboard } from "../lib/safe-browser";

function Command({ label, command }) {
  const [feedback, setFeedback] = useState(null);
  async function handleCopy() {
    setFeedback(await safeWriteClipboard(command) ? "copied" : "failed");
  }
  return (
    <div role="group" aria-label={label}>
      <p className="mb-1">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="select-all break-all font-mono">{command}</code>
        <button type="button" onClick={handleCopy} className="rounded px-2 py-1 text-xs font-medium underline">
          {copy("cli_upgrade.copy")}
        </button>
      </div>
      <span role="status" className="text-xs">
        {feedback === "copied" && copy("cli_upgrade.copied")}
        {feedback === "failed" && copy("cli_upgrade.manual_copy")}
      </span>
    </div>
  );
}

export function CliUpgradeNotice({ className = "" }) {
  // Neither the public website nor legacy device codes identify the installed CLI version.
  if (typeof window === "undefined" || !isProductionHost(window.location.hostname)) return null;
  return (
    <details className={`text-left text-sm ${className}`}>
      <summary className="cursor-pointer font-medium">{copy("cli_upgrade.summary")}</summary>
      <div className="mt-3 space-y-3 border-l border-current pl-3">
        <p>{copy("cli_upgrade.restart")}</p>
        <Command label={copy("cli_upgrade.global")} command={copy("cli_upgrade.global_command")} />
        <Command label={copy("cli_upgrade.npx")} command={copy("cli_upgrade.npx_command")} />
      </div>
    </details>
  );
}
