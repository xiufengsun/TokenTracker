import React from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CurrentAccountLimits } from "./CurrentAccountLimits.jsx";
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/subscription-accounts-api", () => ({ accountRequest: request }));

describe("CurrentAccountLimits", () => {
  it("reads only the active login and links to account management without mutation controls", async () => {
    request.mockImplementation(async (options) => options?.id ? { account: { id: options.id, email: "current@example.invalid" }, limits: { status: "ok", five_hour: { utilization: 28 } } } : { global: { claude: { activeAccountId: "selected" } } });
    render(<MemoryRouter><CurrentAccountLimits displayMode="remaining" /></MemoryRouter>);
    expect(await screen.findByText("72% left")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage accounts" })).toHaveAttribute("href", "/accounts");
    expect(screen.queryByRole("button", { name: "Add account" })).not.toBeInTheDocument();
    expect(request.mock.calls.every(([options]) => !options?.body)).toBe(true);
  });
  it("applies mode, provider order and visibility changes to the overview", async () => {
    request.mockImplementation(async (options) => options?.id ? { account: { id: options.id }, limits: { status: "ok", five_hour: { utilization: 28 }, primary_window: { used_percent: 28 } } } : { global: { claude: { activeAccountId: "claude-current" }, codex: { activeAccountId: "codex-current" } } });
    const { rerender } = render(<MemoryRouter><CurrentAccountLimits displayMode="used" order={["codex", "claude"]} /></MemoryRouter>);
    await screen.findAllByText("28% used");
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => { return heading.textContent; })).toEqual(["Codex", "Claude"]);
    rerender(<MemoryRouter><CurrentAccountLimits displayMode="remaining" visibility={{ codex: false }} /></MemoryRouter>);
    expect(screen.getByText("72% left")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "72");
    expect(screen.queryByRole("heading", { name: "Codex" })).not.toBeInTheDocument();
    rerender(<MemoryRouter><CurrentAccountLimits visibility={{ codex: false, claude: false }} /></MemoryRouter>);
    expect(screen.queryByRole("link", { name: "Manage accounts" })).not.toBeInTheDocument();
  });

  it("discards quota returned for a different account", async () => {
    request.mockImplementation(async (options) => options?.id ? { account: { id: "wrong" }, limits: { status: "ok", five_hour: { utilization: 28 } } } : { global: { claude: { activeAccountId: "selected" } } });
    render(<MemoryRouter><CurrentAccountLimits displayMode="remaining" /></MemoryRouter>);
    await screen.findAllByText(/Quota is unavailable/);
    expect(screen.queryByText("72% left")).not.toBeInTheDocument();
  });
});
