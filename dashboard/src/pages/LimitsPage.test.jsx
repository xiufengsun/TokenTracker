import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const refreshLimitsMock = vi.hoisted(() => vi.fn());

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
      refresh: refreshLimitsMock,
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
    refreshLimitsMock.mockReset();
    refreshLimitsMock.mockResolvedValue(null);
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
    fireEvent.click(screen.getByLabelText("Linked tool"));
    const codexOption = screen.getByRole("option", { name: "Codex" });
    fireEvent.pointerDown(codexOption, { pointerType: "mouse" });
    fireEvent.click(codexOption);
    fireEvent.change(screen.getByLabelText("Subscription date"), {
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

  it("reports the data update time after a successful manual refresh", async () => {
    refreshLimitsMock.mockResolvedValueOnce({ ...apiLimits, fetched_at: "2026-10-07T02:30:00.000Z" });

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }));

    await waitFor(() => {
      expect(screen.getByText(/Limits updated/)).toBeInTheDocument();
    });
    // The button leaves the refreshing state once the forced refresh settles.
    expect(screen.getByRole("button", { name: "Refresh limits" })).toBeEnabled();
  });

  it("flags a partial refresh when a provider still reports an error after refreshing", async () => {
    // A fresh fetched_at with a provider-level error must not read as
    // "limits updated": that row came back from the backend broken.
    refreshLimitsMock.mockResolvedValueOnce({
      ...apiLimits,
      kimi: { ...apiLimits.kimi, error: "Request failed with HTTP 500" },
      fetched_at: "2026-10-07T02:30:00.000Z",
    });

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }));

    await waitFor(() => {
      expect(screen.getByText(/some data still comes from cache or failed to update/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Limits updated/)).not.toBeInTheDocument();
  });

  it("flags a cache-only refresh when every provider row is stale", async () => {
    refreshLimitsMock.mockResolvedValueOnce({
      ...apiLimits,
      kimi: { ...apiLimits.kimi, provenance: { source: "disk-cache", stale: true } },
      codex: { configured: false },
      claude: { configured: false, error: "No credentials", provenance: { stale: true } },
      fetched_at: "2026-10-07T02:30:00.000Z",
    });

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }));

    await waitFor(() => {
      expect(screen.getByText(/every provider still reports cached or failed data/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Limits updated/)).not.toBeInTheDocument();
  });

  it("flags a partial refresh when a ZCode extras endpoint failed", async () => {
    // Reset cards / Start Plan fail on their own endpoints without setting
    // the row-level error; the notice must still not claim "limits updated".
    refreshLimitsMock.mockResolvedValueOnce({
      ...apiLimits,
      zcode: {
        error: null,
        start_plan: { configured: true, error: "ZCode start plan grants API error: code=1234" },
      },
      fetched_at: "2026-10-07T02:30:00.000Z",
    });

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }));

    await waitFor(() => {
      expect(screen.getByText(/some data still comes from cache or failed to update/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Limits updated/)).not.toBeInTheDocument();
  });

  it("shows failure feedback and keeps the previous data when the manual refresh fails", async () => {
    // Mirror the real hook contract: a failed refresh sets error, applies
    // nothing, and resolves null.
    const hookState = { data: apiLimits, error: null, isLoading: false, refresh: refreshLimitsMock };
    useUsageLimitsMock.mockImplementation(() => {
      return hookState;
    });
    const view = render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    refreshLimitsMock.mockImplementationOnce(async () => {
      hookState.error = "Request failed with HTTP 500";
      view.rerender(
        <MemoryRouter>
          <LimitsPage />
        </MemoryRouter>,
      );
      return null;
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh limits" }));

    await waitFor(() => {
      expect(screen.getByText("Couldn't refresh limits.")).toBeInTheDocument();
    });
    expect(screen.getByText("Error: Request failed with HTTP 500")).toBeInTheDocument();
    // The failed refresh must not wipe the rows already on screen.
    expect(screen.getByTestId("limits-panel")).toHaveTextContent("Kimi connected");
  });

  it("ignores repeated clicks while a manual refresh is in flight", async () => {
    let resolveRefresh;
    refreshLimitsMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRefresh = resolve; }),
    );

    render(
      <MemoryRouter>
        <LimitsPage />
      </MemoryRouter>,
    );

    const refreshButton = screen.getByRole("button", { name: "Refresh limits" });
    fireEvent.click(refreshButton);
    // The second click lands before any re-render commits the busy state.
    fireEvent.click(refreshButton);

    expect(refreshLimitsMock).toHaveBeenCalledTimes(1);
    expect(refreshButton).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing limits…");

    await act(async () => {
      resolveRefresh({ ...apiLimits, fetched_at: "2026-10-07T03:00:00.000Z" });
    });
    await waitFor(() => expect(refreshButton).toBeEnabled());
    expect(refreshLimitsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Limits updated/)).toBeInTheDocument();
    expect(screen.queryByText("Refreshing limits…")).not.toBeInTheDocument();
  });
});
