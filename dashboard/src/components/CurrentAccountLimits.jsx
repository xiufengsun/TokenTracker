import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { accountRequest } from "../lib/subscription-accounts-api";
import { copy } from "../lib/copy";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";
import { AccountQuotaSummary, accountQuotaWindows } from "./AccountQuotaSummary.jsx";

function CurrentQuota({ loading, provider, limits, displayMode }) {
  if (loading) {
    return <div role="status" aria-label={copy("accounts.loading")} className="space-y-4 motion-safe:animate-pulse"><div className="h-3 w-24 rounded bg-oai-gray-100 dark:bg-oai-gray-800" /><div className="h-1.5 rounded bg-oai-gray-100 dark:bg-oai-gray-800" /></div>;
  }
  if (accountQuotaWindows(provider, limits).length) {
    return <AccountQuotaSummary provider={provider} limits={limits} displayMode={displayMode} />;
  }
  return <p className="text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.overview.unavailable")}</p>;
}

// This overview only reads the current login. Account selection and all
// credential mutations belong on /accounts.
export function CurrentAccountLimits({ displayMode, order = ["claude", "codex"], visibility = {} }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try {
        const list = await accountRequest();
        const results = await Promise.all(["claude", "codex"].map(async (provider) => {
          const global = list.global?.[provider];
          const id = global?.activeAccountId || list.systemAccounts?.find((a) => a.provider === provider)?.id;
          if (!id) return { provider };
          try {
            const detail = await accountRequest({ id });
            if (detail.account?.id !== id) return { provider };
            return { provider, detail };
          } catch { return { provider }; }
        }));
        if (request === generation) { setRows(results); setError(false); }
      } catch { if (request === generation) { setRows([]); setError(true); } }
    };
    void refresh();
    const onFocus = () => { setRows(null); void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60000);
    return () => { generation++; clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, []);
  const providers = [...new Set([...order, "claude", "codex"])].filter((id) => ["claude", "codex"].includes(id) && visibility[id] !== false);
  if (!providers.length) return null;
  const visibleRows = providers.map((provider) => rows?.find((row) => row.provider === provider) || { provider });
  return <section className="mb-8" aria-label={copy("accounts.overview.title")}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-medium text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.overview.title")}</h2>
      <Link to="/accounts" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm hover:bg-oai-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:hover:bg-oai-gray-800">{copy("accounts.overview.manage")}<ArrowUpRight size={14} aria-hidden /></Link>
    </div>
    {error ? <p role="status" className="text-sm text-oai-gray-600 dark:text-oai-gray-400">{copy("accounts.overview.unavailable")}</p> : <div className="grid gap-5 lg:grid-cols-2">
      {visibleRows.map(({ provider, detail }) => <div key={provider} className="min-w-0 rounded-xl border border-oai-gray-200 p-5 dark:border-oai-gray-800">
        <div className="mb-5 flex min-w-0 items-center gap-3"><ProviderIcon provider={provider} size={24} /><div className="min-w-0"><h3 className="text-sm font-semibold">{copy(provider === "claude" ? "limits.provider.claude" : "limits.provider.codex")}</h3>{detail?.account?.email && <p className="mt-1 truncate text-xs text-oai-gray-600 dark:text-oai-gray-400" title={detail.account.email}>{detail.account.email}</p>}</div></div>
        <CurrentQuota loading={!rows} provider={provider} limits={detail?.limits} displayMode={displayMode} />
      </div>)}
    </div>}
  </section>;
}
