import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishUsageLimitsPreloadState,
  resetDashboardPreload,
} from "../lib/dashboard-preload.js";
import { LimitsPage } from "./LimitsPage.jsx";

const useUsageLimitsMock = vi.hoisted(() => vi.fn());
const useLimitsDisplayPrefsMock = vi.hoisted(() => vi.fn());
const listSubscriptionsMock = vi.hoisted(() => vi.fn());
const createSubscriptionMock = vi.hoisted(() => vi.fn());

vi.mock("../hooks/use-usage-limits", () => ({
  useUsageLimits: useUsageLimitsMock,
}));

vi.mock("../hooks/use-limits-display-prefs.js", () => ({
  useLimitsDisplayPrefs: useLimitsDisplayPrefsMock,
}));

vi.mock("../lib/subscription-manager-api", () => ({
  listSubscriptions: listSubscriptionsMock,
  createSubscription: createSubscriptionMock,
}));

vi.mock("../ui/dashboard/components/UsageLimitsPanel.jsx", () => ({
  UsageLimitsPanel: ({ kimi, codex, subscriptions, displayMode }) => (
    <div data-testid="limits-panel" data-display-mode={displayMode ?? "absent"}>
      {kimi?.configured ? "Kimi connected" : "Kimi missing"}
      {codex?.configured ? " Codex connected" : ""}
      {subscriptions?.map((subscription) => subscription.service).join(",")}
    </div>
  ),
}));

vi.mock("../components/LimitsPageSkeleton.jsx", () => ({
  LimitsPageSkeleton: () => <div data-testid="limits-skeleton" />,
}));

const apiLimits = {
  kimi: {
    configured: true,
    error: null,
    primary_window: { used_percent: 64, reset_at: "2026-05-04T06:02:56.054Z" },
  },
};

const preloadedLimits = {
  codex: {
    configured: true,
    error: null,
    primary_window: { used_percent: 22, reset_at: 1_779_999_999 },
  },
};

describe("LimitsPage", () => {
  beforeEach(() => {
    resetDashboardPreload();
    useUsageLimitsMock.mockReset();
    useUsageLimitsMock.mockImplementation(() => ({
      data: apiLimits,
      error: null,
      isLoading: false,
    }));
    useLimitsDisplayPrefsMock.mockReset();
    useLimitsDisplayPrefsMock.mockImplementation(() => ({
      order: ["kimi"],
      visibility: { kimi: true },
      displayMode: "used",
    }));
    listSubscriptionsMock.mockReset();
    listSubscriptionsMock.mockResolvedValue([]);
    createSubscriptionMock.mockReset();
    createSubscriptionMock.mockResolvedValue({ id: "sub-new" });
  });

  it("passes Kimi limits from the API response into the limits panel", () => {
    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Kimi connected")).toBeInTheDocument();
  });

  it("uses matching preloaded limits as the hook initial state and skips the full skeleton", () => {
    publishUsageLimitsPreloadState(preloadedLimits);
    useUsageLimitsMock.mockImplementation((options) => ({
      data: options.initialState?.data,
      error: null,
      isLoading: false,
    }));

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(useUsageLimitsMock).toHaveBeenCalledWith({
      initialRefresh: true,
      initialState: expect.objectContaining({
        data: preloadedLimits,
        source: "dashboard-existing",
      }),
      publishToPreloadCache: true,
    });
    expect(screen.queryByTestId("limits-skeleton")).not.toBeInTheDocument();
    expect(screen.getByTestId("limits-panel")).toHaveTextContent("Codex connected");
  });

  it("keeps the initialRefresh path when no preloaded state exists", () => {
    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(useUsageLimitsMock).toHaveBeenCalledWith({
      initialRefresh: true,
      publishToPreloadCache: true,
    });
  });

  it("forwards the active displayMode to the limits panel", () => {
    useLimitsDisplayPrefsMock.mockImplementation(() => ({
      order: ["kimi"],
      visibility: { kimi: true },
      displayMode: "remaining",
    }));

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("limits-panel")).toHaveAttribute(
      "data-display-mode",
      "remaining",
    );
  });

  it("opens Settings directly on the Limits Display section", () => {
    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Display settings" })).toHaveAttribute(
      "href",
      "/settings?section=limits",
    );
  });

  // Saves a subscription through the settings popover the way a user would,
  // which triggers the post-mutation refresh that races the initial GET.
  async function saveThroughPopover() {
    fireEvent.click(screen.getByRole("button", { name: "Subscriptions" }));
    fireEvent.click(await screen.findByText("Add subscription"));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "GPT" } });
    fireEvent.change(screen.getByLabelText("Next renewal / expiry"), {
      target: { value: "2027-08-16T14:00" },
    });
    fireEvent.click(screen.getByText("Save"));
  }

  it("ignores a stale list response that resolves after a newer refresh", async () => {
    let resolveFirst;
    listSubscriptionsMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    listSubscriptionsMock.mockResolvedValue([{ id: "sub-2", service: "Newer" }]);

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    await saveThroughPopover();
    await waitFor(() => {
      expect(screen.getByTestId("limits-panel")).toHaveTextContent("Newer");
    });

    // The mount-time GET finally settles with older rows; it must lose.
    resolveFirst([{ id: "sub-1", service: "Stale" }]);
    await Promise.resolve();
    expect(screen.getByTestId("limits-panel")).not.toHaveTextContent("Stale");
    expect(screen.getByTestId("limits-panel")).toHaveTextContent("Newer");
  });

  it("keeps loaded subscriptions and shows a notice when a refresh fails", async () => {
    listSubscriptionsMock.mockResolvedValueOnce([{ id: "sub-1", service: "GPT" }]);

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("limits-panel")).toHaveTextContent("GPT");
    });
    expect(screen.queryByText("Failed to load subscriptions.")).not.toBeInTheDocument();

    listSubscriptionsMock.mockRejectedValueOnce(new Error("boom"));
    await saveThroughPopover();

    await waitFor(() => {
      expect(screen.getByText("Failed to load subscriptions.")).toBeInTheDocument();
    });
    // Rows stay on screen instead of being wiped to a fake empty state.
    expect(screen.getByTestId("limits-panel")).toHaveTextContent("GPT");
  });

  it("clears the load notice once a later refresh succeeds", async () => {
    listSubscriptionsMock.mockRejectedValueOnce(new Error("boom"));

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Failed to load subscriptions.")).toBeInTheDocument();
    });

    listSubscriptionsMock.mockResolvedValueOnce([{ id: "sub-1", service: "GPT" }]);
    await saveThroughPopover();

    await waitFor(() => {
      expect(screen.queryByText("Failed to load subscriptions.")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("limits-panel")).toHaveTextContent("GPT");
  });
});
