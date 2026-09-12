import React from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { SubscriptionAccounts } from "../components/SubscriptionAccounts.jsx";
import { LocalOnlyNotice } from "../components/LocalOnlyNotice.jsx";
import { copy } from "../lib/copy";

export function AccountsPage() {
  const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!local) { return <LocalOnlyNotice />; }
  return <main className="flex-1 pb-12 pt-8 font-oai text-oai-black antialiased dark:text-oai-white sm:pb-16 sm:pt-10">
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{copy("nav.ai_accounts")}</h1><p className="mt-3 max-w-prose text-sm text-oai-gray-600 dark:text-oai-gray-400 sm:text-base">{copy("accounts.page.subtitle")}</p></div>
        <Link to="/limits" className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-oai-gray-600 hover:bg-oai-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 dark:text-oai-gray-400 dark:hover:bg-oai-gray-800">{copy("accounts.page.limits")}<ArrowUpRight size={16} aria-hidden /></Link>
      </div>
      <SubscriptionAccounts showHeading={false} />
    </div>
  </main>;
}
