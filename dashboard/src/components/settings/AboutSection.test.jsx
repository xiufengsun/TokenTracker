import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "./AboutSection.jsx";

vi.mock("../../lib/copy", () => ({
  copy: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

const CONTRIBUTORS = [
  {
    login: "xiufengsun",
    html_url: "https://github.com/xiufengsun",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    contributions: 742,
    type: "User",
  },
  {
    login: "LceAn",
    html_url: "https://github.com/LceAn",
    avatar_url: "https://avatars.githubusercontent.com/u/2?v=4",
    contributions: 96,
    type: "User",
  },
  {
    login: "dependabot[bot]",
    html_url: "https://github.com/apps/dependabot",
    avatar_url: "https://avatars.githubusercontent.com/u/3?v=4",
    contributions: 40,
    type: "Bot",
  },
];

function mockFetchSuccess() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(CONTRIBUTORS),
  });
}

describe("AboutSection", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = mockFetchSuccess();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("introduces the project with version, license and links", async () => {
    render(<AboutSection />);
    await act(async () => {});

    expect(screen.getByText("settings.about.intro.body")).toBeTruthy();
    expect(screen.getByText("settings.about.intro.version")).toBeTruthy();
    expect(screen.getByText("settings.about.intro.licenseMit")).toBeTruthy();

    const repo = screen.getByRole("link", { name: /settings.about.intro.github|github\.com/i });
    expect(repo.getAttribute("href")).toBe("https://github.com/xiufengsun/TokenTracker");
    const site = screen.getByRole("link", { name: "settings.about.intro.website" });
    expect(site.getAttribute("href")).toBe("https://www.tokentracker.cc");
  });

  it("defers the contributors request until the section is active", async () => {
    const { rerender } = render(<AboutSection active={false} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(<AboutSection active />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalled();
  });

  it("loads contributors from the GitHub API and hides bot accounts", async () => {
    render(<AboutSection />);

    await waitFor(() => {
      expect(screen.getByText("xiufengsun")).toBeTruthy();
    });
    expect(screen.getByText("LceAn")).toBeTruthy();
    expect(screen.queryByText("dependabot[bot]")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/xiufengsun/TokenTracker/contributors?per_page=100",
      expect.objectContaining({ headers: expect.anything() }),
    );

    const profile = screen.getByText("LceAn").closest("a");
    expect(profile.getAttribute("href")).toBe("https://github.com/LceAn");
    const chip = screen.getByTitle(
      'settings.about.contributors.itemTitle:{"contributor":"LceAn","contributions":96}',
    );
    expect(chip).toBeTruthy();
  });

  it("falls back to a readable message when the contributors request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    render(<AboutSection />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("settings.about.contributors.error");
    });
    expect(screen.getByRole("link", { name: /settings.about.contributors.viewAll/i }))
      .toBeTruthy();
  });

  it("keeps the section usable while contributors are still loading", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<AboutSection />);
    await act(async () => {});

    expect(screen.getByRole("status").textContent).toBe("settings.about.contributors.loading");
    expect(screen.getByText("settings.about.intro.body")).toBeTruthy();
  });
});
