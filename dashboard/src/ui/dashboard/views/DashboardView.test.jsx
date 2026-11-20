import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { copy } from "../../../lib/copy";
import { DashboardView } from "./DashboardView.jsx";

const loadingCard = vi.hoisted(() => ({ pending: true, mounts: 0, unmounts: 0 }));

vi.mock("../../components", () => ({ Shell: ({ children }) => <>{children}</>, Card: ({ children }) => <>{children}</> }));
vi.mock("../../foundation/FadeIn.jsx", () => ({ FadeIn: ({ children }) => <>{children}</> }));
vi.mock("../components/StatsPanel.jsx", () => ({ StatsPanel: () => <section data-testid="stats" /> }));
vi.mock("../components/UsageOverview.jsx", () => ({ UsageOverview: ({ cloudNotice }) => <section data-testid="usage">{cloudNotice}</section> }));
vi.mock("../components/CostAnalysisModal.jsx", () => ({ CostAnalysisModal: () => null }));
vi.mock("../components/QualityPerDollarCard.jsx", async () => {
  const { useEffect } = await import("react");
  return { QualityPerDollarCard: function Card() {
    useEffect(() => {
      loadingCard.mounts++;
      return () => { loadingCard.unmounts++; };
    }, []);
    if (loadingCard.pending) return null;
    return <section data-testid="quality" />;
  } };
});

afterEach(cleanup);

it("keeps the Cloud notice inside the right-side usage card", () => {
  render(<DashboardView copy={copy} isLocalMode cloudNotice={<p role="status" aria-label="Cloud notice">{copy("cloud.notice.expired.title")}</p>}
    leftCardOrder={["statsPanel"]} rightCardOrder={["usageOverview"]} />);
  expect(screen.getByTestId("usage")).toContainElement(screen.getByRole("status", { name: "Cloud notice" }));
  expect(screen.getByTestId("stats")).not.toContainElement(screen.getByRole("status", { name: "Cloud notice" }));
});

it("ignores removed promotional cards in saved layouts without leaving draggable empty slots", () => {
  render(<DashboardView copy={copy} isLocalMode
    leftCardOrder={["islandOnboarding", "linuxPetCard", "macAppBanner", "widgetOnboarding", "linuxTopBarCard", "statsPanel"]}
    rightCardOrder={["usageOverview"]} />);
  expect(screen.getByTestId("stats")).toBeInTheDocument();
  expect(screen.getByTestId("usage")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: copy("dashboard.overview.layout.drag_handle") })).toHaveLength(2);
});

it("keeps an async data card mounted while empty so its loaded result can appear", () => {
  loadingCard.pending = true;
  loadingCard.mounts = loadingCard.unmounts = 0;
  const page = () => <DashboardView copy={copy} isLocalMode
    leftCardOrder={["qualityPerDollar"]} rightCardOrder={["usageOverview"]} />;
  const view = render(page());
  expect(screen.queryByTestId("quality")).toBeNull();
  expect(loadingCard.mounts).toBe(1);
  expect(loadingCard.unmounts).toBe(0);
  loadingCard.pending = false;
  view.rerender(page());
  expect(screen.getByTestId("quality")).toBeInTheDocument();
  expect(loadingCard.mounts).toBe(1);
  expect(loadingCard.unmounts).toBe(0);
});
