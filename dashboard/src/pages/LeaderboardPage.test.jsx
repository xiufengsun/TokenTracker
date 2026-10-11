import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLeaderboardPreloadContextKey,
  publishLeaderboardPreloadState,
  readLeaderboardPreloadState,
  resetDashboardPreload,
} from "../lib/dashboard-preload.js";
import { getLeaderboard } from "../lib/api";
import { runCloudUsageSyncNow } from "../lib/cloud-sync";
import { CLOUD_LEADERBOARD_REFRESHED_EVENT } from "../lib/cloud-sync-prefs";
import { LeaderboardPage } from "./LeaderboardPage.jsx";

const openLoginModalMock = vi.hoisted(() => vi.fn());
const insforgeAuthMock = vi.hoisted(() => ({
  signedIn: true,
  loading: false,
  user: { id: "user-1" },
}));

vi.mock("../lib/api", () => ({
  getLeaderboard: vi.fn(),
  refreshLeaderboard: vi.fn(),
}));

vi.mock("../lib/cloud-sync", () => ({
  runCloudUsageSyncNow: vi.fn(),
}));

vi.mock("../lib/config", () => ({
  getLeaderboardBaseUrl: () => "https://edge.example",
}));

vi.mock("../lib/mock-data", () => ({
  isMockEnabled: () => false,
}));

vi.mock("../contexts/LoginModalContext.jsx", () => ({
  useLoginModal: () => ({ openLoginModal: openLoginModalMock }),
}));

vi.mock("../contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => insforgeAuthMock,
}));

vi.mock("../hooks/useCurrency.js", () => ({
  useCurrency: () => ({ currency: "USD", rate: 1 }),
}));

vi.mock("../components/LeaderboardSkeleton.jsx", () => ({
  LeaderboardSkeleton: () => <div data-testid="leaderboard-skeleton" />,
}));

vi.mock("../components/LeaderboardAvatar.jsx", () => ({
  LeaderboardAvatar: ({ displayName, proActive }) => <span data-testid="avatar" data-pro-active={proActive === true ? "true" : undefined}>{displayName}</span>,
}));

const preloadedData = {
  entries: [
    {
      rank: 1,
      user_id: "preloaded-user",
      display_name: "Preloaded User",
      total_tokens: 1234,
      estimated_cost_usd: 1.23,
    },
  ],
  me: null,
  page: 1,
  total_pages: 1,
  total_entries: 1,
  from: null,
  to: null,
  generated_at: null,
};

function renderLeaderboard(initialEntry = "/leaderboard", props = {}) {
  const tree = React.createElement(
    MemoryRouter,
    { initialEntries: [initialEntry] },
    React.createElement(LeaderboardPage, {
      auth: props.auth ?? null,
      signedIn: props.signedIn ?? true,
      sessionSoftExpired: false,
    }),
  );
  return render(props.strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
}

describe("LeaderboardPage window-session cache reuse", () => {
  beforeEach(() => {
    resetDashboardPreload();
    getLeaderboard.mockReset();
    runCloudUsageSyncNow.mockReset();
    runCloudUsageSyncNow.mockResolvedValue(undefined);
    openLoginModalMock.mockReset();
    insforgeAuthMock.signedIn = true;
    insforgeAuthMock.loading = false;
    insforgeAuthMock.user = { id: "user-1" };
    window.localStorage.clear();
  });

  it("shows paid identity on desktop and mobile without stacking the GitHub frame or changing ranks", () => {
    const contextKey = getLeaderboardPreloadContextKey({ accessMode: "cloud", baseUrl: "https://edge.example", mockEnabled: false, userId: "user-1" });
    publishLeaderboardPreloadState({ ...preloadedData, entries: [
      { ...preloadedData.entries[0], rank: 1, display_name: "Free GitHub User", github_url: "https://github.com/free", pro_active: false },
      { ...preloadedData.entries[0], rank: 2, user_id: "paid-user", display_name: "Paid User", github_url: "https://github.com/paid", pro_active: true },
    ] }, { contextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));
    renderLeaderboard("/leaderboard", { auth: () => Promise.resolve("test-token") });
    expect(screen.getAllByRole("img", { name: "TokenTracker Cloud subscriber" })).toHaveLength(2);
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows.map(row => row.textContent)).toEqual([expect.stringContaining("Free GitHub User"), expect.stringContaining("Paid User")]);
    expect(rows[0].querySelector(".gh-avatar-frame")).not.toBeNull();
    expect(rows[1].querySelector(".gh-avatar-frame")).toBeNull();
    expect(rows[1].querySelector('[data-pro-active="true"]')).not.toBeNull();
    expect(rows[1].querySelector('a[href="https://github.com/paid"]')).not.toBeNull();
    const avatars = screen.getAllByTestId("avatar");
    const mobilePaidAvatar = avatars.filter(avatar => avatar.getAttribute("data-pro-active") === "true")[1];
    const mobileFreeAvatar = avatars.filter(avatar => !avatar.hasAttribute("data-pro-active"))[1];
    expect(mobilePaidAvatar.parentElement.className).not.toMatch(/ring-|shadow-/);
    expect(mobileFreeAvatar.parentElement).toHaveClass("ring-amber-400");
  });

  it("does not infer a paid label from sign-in, GitHub, or a truthy non-boolean response", () => {
    const contextKey = getLeaderboardPreloadContextKey({ accessMode: "cloud", baseUrl: "https://edge.example", mockEnabled: false, userId: "user-1" });
    publishLeaderboardPreloadState({ ...preloadedData, entries: [{ ...preloadedData.entries[0], github_url: "https://github.com/free", pro_active: "true" }] }, { contextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));
    renderLeaderboard("/leaderboard", { auth: () => Promise.resolve("test-token") });
    expect(screen.queryByRole("img", { name: "TokenTracker Cloud subscriber" })).not.toBeInTheDocument();
    expect(document.querySelector(".gh-avatar-frame")).not.toBeNull();
  });

  it("renders a matching cache immediately and starts a background refresh", () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    renderLeaderboard("/leaderboard", { auth: () => Promise.resolve("test-token") });

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("leaderboard-skeleton")).not.toBeInTheDocument();
    expect(getLeaderboard).toHaveBeenCalledWith({
      baseUrl: "https://edge.example",
      userId: "user-1",
      period: "total",
      limit: 20,
      offset: 0,
    });
  });

  it("keeps normal token-cell hover backgrounds opaque in dark mode", () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    const { container } = renderLeaderboard();
    const tokenCell = container.querySelector('td[data-column-key="gpt_tokens"]');

    expect(tokenCell).not.toBeNull();
    expect(tokenCell.className).toContain("dark:group-hover:bg-oai-gray-900");
    expect(tokenCell.className).not.toContain("dark:group-hover:bg-oai-gray-900/60");
  });

  it("renders snapshot freshness as a readable localized date instead of raw ISO", () => {
    const generatedAt = "2026-07-20T01:20:43.517Z";
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(
      { ...preloadedData, generated_at: generatedAt },
      { contextKey },
    );
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    const { container } = renderLeaderboard();
    const updatedAt = container.querySelector(`time[datetime="${generatedAt}"]`);

    expect(updatedAt).not.toBeNull();
    expect(updatedAt.textContent).not.toContain(generatedAt);
    expect(updatedAt.textContent).not.toContain("T01:20:43.517Z");
    expect(updatedAt.title).not.toContain(generatedAt);
    expect(updatedAt.className).toContain("text-oai-gray-500");
    expect(updatedAt.className).toContain("dark:text-oai-gray-400");
  });

  it("keeps the pinned me-row rank cell sticky (twMerge must not drop it, issue 265)", () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(
      {
        ...preloadedData,
        me: {
          rank: 227,
          user_id: "user-1",
          display_name: "Me User",
          total_tokens: "999",
          estimated_cost_usd: 1,
        },
      },
      { contextKey },
    );
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    renderLeaderboard("/leaderboard", { auth: () => Promise.resolve("test-token") });

    const rankCell = screen.getByText("227").closest("td");
    expect(rankCell).not.toBeNull();
    expect(rankCell.className).toMatch(/\bsticky\b/);
    expect(rankCell.className).not.toMatch(/\brelative\b/);
  });

  it("keeps matching cache visible under React StrictMode without render-time consumption", () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    renderLeaderboard("/leaderboard", { strict: true });

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("leaderboard-skeleton")).not.toBeInTheDocument();
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({ data: preloadedData });
  });

  it("updates the matching cache when the background refresh succeeds", async () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    const refreshedData = {
      ...preloadedData,
      entries: [
        {
          rank: 1,
          user_id: "refreshed-user",
          display_name: "Refreshed User",
          total_tokens: 4321,
          estimated_cost_usd: 4.32,
        },
      ],
    };
    publishLeaderboardPreloadState(preloadedData, { contextKey });
    getLeaderboard.mockResolvedValue(refreshedData);

    renderLeaderboard();

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getAllByText("Refreshed User").length).toBeGreaterThan(0);
      expect(readLeaderboardPreloadState(contextKey)).toMatchObject({
        data: refreshedData,
        source: "page-load",
      });
    });
  });

  it("reloads the active page after cloud sync publishes a fresh leaderboard snapshot", async () => {
    const initialData = {
      ...preloadedData,
      entries: [{ ...preloadedData.entries[0], display_name: "Before sync" }],
    };
    const refreshedData = {
      ...preloadedData,
      entries: [{ ...preloadedData.entries[0], display_name: "After sync" }],
    };
    getLeaderboard.mockResolvedValueOnce(initialData).mockResolvedValueOnce(refreshedData);

    renderLeaderboard();

    await waitFor(() => {
      expect(screen.getAllByText("Before sync").length).toBeGreaterThan(0);
      expect(getLeaderboard).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      window.dispatchEvent(new Event(CLOUD_LEADERBOARD_REFRESHED_EVENT));
    });

    await waitFor(() => {
      expect(getLeaderboard).toHaveBeenCalledTimes(2);
      expect(screen.getAllByText("After sync").length).toBeGreaterThan(0);
    });
  });

  it("keeps cached data visible when the background refresh fails", async () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey });
    getLeaderboard.mockRejectedValueOnce(new Error("network down"));

    renderLeaderboard();

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByText(/network down/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("leaderboard-skeleton")).not.toBeInTheDocument();
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({ data: preloadedData });
  });

  it("shows an error when cold-start fetch fails without cached data", async () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    // Keep the rejection scoped to the request asserted below. A permanent
    // rejecting mock can be reached by a delayed cleanup/preload from another
    // test and becomes an unhandled rejection in the full suite.
    getLeaderboard.mockRejectedValueOnce(new Error("network down"));

    renderLeaderboard();

    await waitFor(() => {
      expect(screen.getByText(/network down/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("leaderboard-skeleton")).not.toBeInTheDocument();
    expect(readLeaderboardPreloadState(contextKey)).toBeNull();
  });

  it("keeps the existing loading path when the preload context does not match the page defaults", () => {
    const staleContextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      pageSize: 50,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey: staleContextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    renderLeaderboard();

    expect(screen.queryByText("Preloaded User")).not.toBeInTheDocument();
    expect(screen.getByTestId("leaderboard-skeleton")).toBeInTheDocument();
    expect(getLeaderboard).toHaveBeenCalledWith({
      baseUrl: "https://edge.example",
      userId: "user-1",
      period: "total",
      limit: 20,
      offset: 0,
    });
  });

  it("does not fetch or write readable cache while auth access context is unavailable", () => {
    insforgeAuthMock.loading = true;
    insforgeAuthMock.signedIn = false;
    insforgeAuthMock.user = null;
    const cloudContextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey: cloudContextKey });
    getLeaderboard.mockResolvedValue({
      ...preloadedData,
      entries: [{ rank: 1, user_id: "bad", display_name: "Should Not Fetch" }],
    });

    renderLeaderboard();

    expect(getLeaderboard).not.toHaveBeenCalled();
    expect(screen.queryAllByText("Preloaded User")).toHaveLength(0);
    expect(readLeaderboardPreloadState(cloudContextKey)).toMatchObject({ data: preloadedData });
    expect(
      readLeaderboardPreloadState(
        getLeaderboardPreloadContextKey({
          accessMode: "unavailable",
          baseUrl: "https://edge.example",
          mockEnabled: false,
          userId: null,
        }),
      ),
    ).toBeNull();
  });

  it("keeps signed-out public leaderboard reads available when base URL is configured", async () => {
    insforgeAuthMock.loading = false;
    insforgeAuthMock.signedIn = false;
    insforgeAuthMock.user = null;
    const publicData = {
      ...preloadedData,
      entries: [
        {
          rank: 1,
          user_id: "public-user",
          display_name: "Public User",
          total_tokens: 321,
          estimated_cost_usd: 0.32,
        },
      ],
    };
    getLeaderboard.mockResolvedValue(publicData);

    renderLeaderboard("/leaderboard", { signedIn: false });

    await waitFor(() => {
      expect(getLeaderboard).toHaveBeenCalledWith({
        baseUrl: "https://edge.example",
        userId: null,
        period: "total",
        limit: 20,
        offset: 0,
      });
      expect(screen.getAllByText("Public User").length).toBeGreaterThan(0);
    });
    expect(
      readLeaderboardPreloadState(
        getLeaderboardPreloadContextKey({
          accessMode: "public",
          baseUrl: "https://edge.example",
          mockEnabled: false,
          userId: null,
        }),
      ),
    ).toMatchObject({ data: publicData });
  });

  it("reuses matching cache again after remounting in the same window session", () => {
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    const first = renderLeaderboard();

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);

    first.unmount();
    renderLeaderboard();

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);
    expect(readLeaderboardPreloadState(contextKey)).toMatchObject({ data: preloadedData });
  });

  it("uses the matching cache for pageSize-specific contexts", () => {
    window.localStorage.setItem("tokentracker:leaderboard:pageSize", "50");
    const contextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      pageSize: 50,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    renderLeaderboard();

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);
    expect(getLeaderboard).toHaveBeenCalledWith({
      baseUrl: "https://edge.example",
      userId: "user-1",
      period: "total",
      limit: 50,
      offset: 0,
    });
  });

  // Two full-table userEvent transitions can exceed 5s on Windows under load.
  it("does not show old context data after period changes, but reuses matching cached context when returning", async () => {
    const user = userEvent.setup();
    const totalContextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    const weekContextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      period: "week",
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey: totalContextKey });
    publishLeaderboardPreloadState(
      {
        ...preloadedData,
        entries: [
          {
            rank: 1,
            user_id: "week-user",
            display_name: "Week User",
            total_tokens: 777,
            estimated_cost_usd: 0.77,
          },
        ],
      },
      { contextKey: weekContextKey },
    );
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    renderLeaderboard();

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Week" }));
    });

    expect(screen.getAllByText("Week User").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Preloaded User")).toHaveLength(0);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "All" }));
    });

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);
  }, 15000);

  it("clears the visible rows instead of rendering stale data when switching to an uncached context", async () => {
    const user = userEvent.setup();
    const totalContextKey = getLeaderboardPreloadContextKey({
      accessMode: "cloud",
      baseUrl: "https://edge.example",
      mockEnabled: false,
      userId: "user-1",
    });
    publishLeaderboardPreloadState(preloadedData, { contextKey: totalContextKey });
    getLeaderboard.mockReturnValue(new Promise(() => {}));

    renderLeaderboard();

    expect(screen.getAllByText("Preloaded User").length).toBeGreaterThan(0);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Week" }));
    });

    expect(screen.queryAllByText("Preloaded User")).toHaveLength(0);
    expect(screen.getByTestId("leaderboard-skeleton")).toBeInTheDocument();
  });
});
