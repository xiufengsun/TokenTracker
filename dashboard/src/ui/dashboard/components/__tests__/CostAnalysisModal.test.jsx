import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CostAnalysisModal } from "../CostAnalysisModal.jsx";

it("invokes onClose when clicking the backdrop", async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const { container } = render(
    <CostAnalysisModal isOpen={true} onClose={onClose} fleetData={[]} />,
  );

  const backdropSelector = '[data-cost-analysis-backdrop="true"]';
  const backdrop = document.querySelector(backdropSelector) ?? container.firstElementChild;

  if (!backdrop) {
    throw new Error(`Expected backdrop element (${backdropSelector}) to exist.`);
  }

  await act(async () => {
    await user.click(backdrop);
  });

  expect(onClose).toHaveBeenCalledTimes(1);
});

it("distinguishes an unknown cost from a free model and preserves tool-reported costs", async () => {
  const user = userEvent.setup();
  render(<CostAnalysisModal isOpen onClose={() => {}} fleetData={[{
    label: "GROK", usd: 2, usage: 900,
    models: [
      { name: "reported-model", usage: 300, cost: 2, costSource: "provider_reported", pricing: { status: "unpriced" } },
      { name: "unknown-model", usage: 300, cost: 0, costSource: "model_pricing", pricing: { status: "unpriced" } },
      { name: "local-model", usage: 300, cost: 0, costSource: "model_pricing", pricing: { status: "free" } },
    ],
  }]} />);
  expect(screen.getByText("Known cost subtotal")).toBeInTheDocument();
  expect(screen.getByText("≥$2.00")).toBeInTheDocument();
  expect(screen.getByText("Unpriced")).toBeInTheDocument();
  expect(screen.getByText("$0.00")).toBeInTheDocument();
  await user.click(screen.getByText("reported-model"));
  expect(screen.getByText("Cost reported by the tool")).toBeVisible();
  expect(screen.queryByText("No rate found. These tokens are retained but their cost is unknown.")).not.toBeVisible();
});

it("shows unpriced instead of a zero total when every model lacks a rate", () => {
  render(<CostAnalysisModal isOpen onClose={() => {}} fleetData={[{
    label: "CLAUDE", usd: 0, usage: 100,
    models: [{ name: "unknown", usage: 100, cost: 0, pricing: { status: "unpriced" } }],
  }]} />);
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  expect(screen.getAllByText("Unpriced")).toHaveLength(2);
});

it("keeps an exact total when the server sends no pricing metadata", () => {
  // Older CLIs and the cloud function before deploy omit `pricing`; a free
  // model's $0 must not turn the total into a lower bound.
  render(<CostAnalysisModal isOpen onClose={() => {}} fleetData={[{
    label: "CODEX", usd: 2, usage: 600,
    models: [
      { name: "paid-model", usage: 300, cost: 2 },
      { name: "free-model", usage: 300, cost: 0 },
    ],
  }]} />);
  expect(screen.queryByText(/≥/)).not.toBeInTheDocument();
  expect(screen.queryByText("Unpriced")).not.toBeInTheDocument();
});

it("keeps request-only (zero-token) providers out of the dollar ranking", () => {
  render(<CostAnalysisModal isOpen onClose={() => {}} fleetData={[{
    label: "QODER", usd: 0, usage: 0,
    models: [{ name: "qfmodel", usage: 0, cost: 0 }],
  }, {
    label: "GROK", usd: 2, usage: 900,
    models: [{ name: "grok-code", usage: 900, cost: 2 }],
  }]} />);
  expect(screen.getByText("GROK")).toBeTruthy();
  expect(screen.queryByText("QODER")).toBeNull();
});
