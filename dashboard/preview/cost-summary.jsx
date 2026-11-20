// Local component integration fixture; no account, payment or production requests.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { setCopyLocale } from "../src/lib/copy";
import { ThemeProvider } from "../src/ui/foundation/ThemeProvider.jsx";
import { formatSummaryCost } from "../src/lib/summary-cost";
setCopyLocale("zh-CN");
window.fetch = async () => Response.json({ error: "fixture_network_disabled" }, { status: 503 });
const { UsageOverview } = await import("../src/ui/dashboard/components/UsageOverview.jsx");
const { CostAnalysisModal } = await import("../src/ui/dashboard/components/CostAnalysisModal.jsx");
const pricing = { status: "unpriced", source: null };
const modelBreakdown = { sources: [{ models: [{ pricing, cost_source: "model_pricing", totals: { total_tokens: 1000000 } }] }] };
const fleetData = [{ label: "CODEX", usage: 538700000, usd: 276.06, models: [
  { id: "priced-fixture", name: "priced-fixture", usage: 537700000, cost: 276.06, pricing: { status: "priced" }, costSource: "model_pricing" },
  { id: "unknown-fixture", name: "unknown-fixture", usage: 1000000, cost: 0, pricing, costSource: "model_pricing" },
] }];
function Preview() {
  const [open, setOpen] = useState(new URLSearchParams(location.search).get("view") === "detail");
  return <main className="min-h-screen bg-oai-gray-50 px-4 py-6 font-oai text-oai-black sm:p-10 dark:bg-oai-gray-950 dark:text-oai-white">
    <div className="mx-auto max-w-4xl"><p className="mb-6 text-xs text-oai-gray-500">本地测试数据 · 真实 UsageOverview / CostAnalysisModal 与主卡格式函数 · 非完整应用页面 · 不连接账户服务</p>
      <UsageOverview periods={[]} summaryLabel="Total Tokens" summaryValue="538.7M" summaryFullValue="538,700,000"
        summaryCostValue={formatSummaryCost(276.06, { modelBreakdown, currency: "USD", rate: 1 })}
        onCostInfo={() => setOpen(true)} fleetData={fleetData} />
      <CostAnalysisModal isOpen={open} onClose={() => setOpen(false)} fleetData={fleetData} />
    </div></main>;
}
createRoot(document.getElementById("root")).render(<ThemeProvider><Preview /></ThemeProvider>);
