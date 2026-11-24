import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { copy } from "../../../lib/copy";
import { UsageOverview } from "./UsageOverview.jsx";
import { SessionDetailModal } from "./SessionDetailModal.jsx";
import { buildFleetData } from "../../../lib/model-breakdown";
import { LocaleProvider } from "../../foundation/LocaleProvider.jsx";

vi.mock("./ContextBreakdownPanel.jsx", () => ({ ContextBreakdownPanel: () => null }));
vi.mock("../../../hooks/useTheme.js", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

it("does not render the coverage disclosure on the usage overview", () => {
  const { container } = render(<UsageOverview period="day" periods={["day"]} summaryLabel="Total" summaryValue="100" fleetData={[{
    source: "cursor", label: "CURSOR", usage: 100, totalPercent: "100", usd: 0,
    models: [{ id: "grok-bot-default", name: "grok-bot-default", share: 100, usage: 100, cost: 0, costSource: "provider_reported", pricing: { status: "unpriced", source: "cursor_subscription" }, tokens: { input: 100, output: 0, cached: 0, cacheCreate: 0, reasoning: 0 } }],
  }]} />);
  expect(screen.queryByText(copy("usage.evidence.title"))).toBeNull();
  expect(container.textContent).not.toContain("{time}");
  expect(container.textContent).not.toContain("≥");
});

it("shows recorded-zero and subscription meaning inside model details only", async () => {
  const user = userEvent.setup();
  render(<UsageOverview period="day" periods={["day"]} summaryLabel="Total" summaryValue="100" fleetData={[{
    source: "cursor", label: "CURSOR", usage: 100, totalPercent: "100", usd: 0,
    models: [{ id: "grok-bot-default", name: "grok-bot-default", share: 100, usage: 100, cost: 0, costSource: "provider_reported", pricing: { status: "unpriced", source: "cursor_subscription" }, tokens: { input: 100, output: 0, cached: 0, cacheCreate: 0, reasoning: 0 } }],
  }]} />);
  expect(screen.queryByText(copy("usage.evidence.reported"))).toBeNull();
  await user.click(screen.getByRole("button", { name: /CURSOR:/i }));
  await user.click(screen.getByRole("button", { name: /grok-bot-default/i }));
  const explanation = screen.getByText(copy("usage.evidence.reported"), { exact: false });
  expect(explanation).toBeVisible();
  expect(screen.getByText(copy("usage.evidence.subscription"), { exact: false })).toBeVisible();
  expect(explanation.tagName).toBe("P");
  expect(explanation.className).not.toMatch(/(?:^|\s)p[xltr]?-/);
});

it("keeps allocation explanation when a model combines direct and allocated amounts", async () => {
  const user = userEvent.setup();
  render(<UsageOverview period="day" periods={["day"]} summaryLabel="Total" summaryValue="100" fleetData={[{
    source: "grok", label: "GROK", usage: 100, totalPercent: "100", usd: 3,
    models: [{ id: "opaque-worker", name: "opaque-worker", share: 100, usage: 100, cost: 3, costSource: "mixed", hasAllocatedCost: true, pricing: { status: "unpriced" }, tokens: { input: 100 } }],
  }]} />);
  await user.click(screen.getByRole("button", { name: /GROK:/i }));
  await user.click(screen.getByRole("button", { name: /opaque-worker/i }));
  expect(screen.getByText(copy("usage.evidence.allocated"), { exact: false })).toBeVisible();
  expect(screen.getByText(copy("usage.evidence.mixed"), { exact: false })).toBeVisible();
});


it("shows allocation in the existing session detail cost-source line", () => {
  render(<LocaleProvider><SessionDetailModal session={{ session_hash: "fixture", source: "grok", model: "opaque-worker", total_tokens: 100, cost_usd: 1, cost_source: "provider_reported", has_allocated_cost: true, started_at: "2026-11-24T00:00:00Z" }} onClose={() => {}} /></LocaleProvider>);
  expect(screen.getByText(copy("usage.evidence.allocated"), { exact: false })).toBeVisible();
});


it("renders the real request-only Bot amount rather than a fabricated recorded zero", async () => {
  const user = userEvent.setup();
  const totals = { total_tokens: 0, conversation_count: 1, total_cost_usd: "0.37" };
  const fleetData = buildFleetData({ sources: [{ source: "cursor", totals, models: [{ model: "grok-bot-default", totals, cost_source: "provider_reported", pricing: { source: "cursor_subscription", status: "unpriced" } }] }] });
  expect(fleetData[0].models[0].cost).toBe(0.37);
  render(<UsageOverview period="day" periods={["day"]} summaryLabel="Total" summaryValue="0" fleetData={fleetData} />);
  await user.click(screen.getByRole("button", { name: /All tools:.*\$0\.37/i }));
  expect(screen.getAllByText("$0.37").length).toBeGreaterThan(0);
  expect(screen.queryByText("$0.00")).toBeNull();
});
