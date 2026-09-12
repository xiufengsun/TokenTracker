import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionAccounts } from "./SubscriptionAccounts.jsx";

const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/subscription-accounts-api", () => ({ accountRequest: request }));
vi.mock("./AccountQuotaSummary.jsx", () => ({ AccountQuotaSummary: ({ limits, displayMode }) => <div data-testid="account-quota" data-display-mode={displayMode}>{limits?.primary_window?.used_percent}</div> }));
const initial = [
  { id: "a", provider: "claude", label: "Claude Work", registered: false, archived: false },
  { id: "b", provider: "codex", label: "Codex Personal", registered: true, archived: false, email: "personal@example.invalid" },
];
const list = (accounts = initial) => ({ accounts, global: { claude: { state: "active", activeAccountId: accounts.find((a) => a.provider === "claude")?.id }, codex: { state: "active", activeAccountId: accounts.find((a) => a.provider === "codex")?.id } }, platform: "darwin", poolCommands: { claude: "tracker accounts auto claude", codex: "tracker accounts auto codex" } });
const detail = (id) => ({ account: initial.find((a) => a.id === id), status: "ready", commands: { login: `login-${id}`, run: `run-${id}` },
  usage: { daily: [{ date: new Date().toISOString().slice(0, 10), totalTokens: id === "b" ? 222 : 111, estimatedCostUsd: 1 }] },
  limits: { configured: true, status: "ok", primary_window: { used_percent: 35 } } });

describe("SubscriptionAccounts", () => {
  beforeEach(() => {
    localStorage.clear();
    request.mockReset();
    request.mockImplementation(async (options) => options?.id ? detail(options.id) : list());
  });

  it("groups accounts under provider headers with visible icons and separate add actions", async () => {
    render(<SubscriptionAccounts />);
    expect(await screen.findByRole("heading", { name: "Claude" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Codex" })).toBeInTheDocument();
    const claude = screen.getByRole("heading", { name: "Claude" }).closest("div.flex.items-center.justify-between");
    expect(claude.querySelector("svg, img")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Add account" })).toHaveLength(2);
    await screen.findByRole("button", { name: /Claude Work/ });
    const groups = screen.getAllByRole("group", { name: "Choose an account" });
    expect(within(groups[0]).getByRole("button", { name: /Claude Work/ })).toBeInTheDocument();
    expect(within(groups[0]).queryByRole("button", { name: /Codex Personal/ })).not.toBeInTheDocument();
    expect(within(groups[1]).getByRole("button", { name: /Codex Personal/ })).toBeInTheDocument();
  });

  it("uses the shared display preference for both providers and responds to cross-tab changes", async () => {
    localStorage.setItem("tt.limits.displayMode", "remaining");
    render(<SubscriptionAccounts />);
    await screen.findAllByTestId("account-quota");
    await waitFor(() => expect(screen.getAllByTestId("account-quota")).toHaveLength(2));
    for (const quota of screen.getAllByTestId("account-quota")) expect(quota).toHaveAttribute("data-display-mode", "remaining");
    act(() => {
      localStorage.setItem("tt.limits.displayMode", "used");
      window.dispatchEvent(new StorageEvent("storage", { key: "tt.limits.displayMode", newValue: "used" }));
    });
    for (const quota of screen.getAllByTestId("account-quota")) expect(quota).toHaveAttribute("data-display-mode", "used");
  });

  it("generates a browser login link inside its provider with Keychain access opt-in off by default", async () => {
    const login = { id: "oauth", accountId: "new", state: "waiting", authorizeUrl: "https://claude.ai/oauth/authorize?state=test", expiresAt: Date.now() + 180000 };
    request.mockImplementation(async (options) => {
      if (options?.body?.action === "login_start" || options?.loginId) return { login };
      if (options?.id) return { status: "login_required", commands: { login: "login-new", run: "run-new" } };
      return list([]);
    });
    render(<SubscriptionAccounts />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add account" })[0]);
    fireEvent.change(screen.getByLabelText("Account label (optional)"), { target: { value: "Work" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate sign-in link" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "login_start", provider: "claude", label: "Work", allowKeychain: false } }));
    expect(await screen.findByRole("link", { name: "Open sign-in page" })).toHaveAttribute("href", login.authorizeUrl);
  });

  it("shows the existing local account first with current limits and keeps history unassigned", async () => {
    const local = { id: "system-codex", provider: "codex", system: true, email: "local@example.invalid" };
    request.mockImplementation(async (options) => options?.id === local.id ? { account: local, status: "ready", limits: { status: "ok", configured: true, primary_window: { used_percent: 71 } } } : options?.id ? detail(options.id) : { ...list(), global: {}, systemAccounts: [local] });
    render(<SubscriptionAccounts usageLimits={{ codex: { configured: true, primary_window: { used_percent: 71 } } }} />);
    const row = await screen.findByRole("button", { name: /Local default account/ });
    await waitFor(() => expect(row).toHaveAttribute("aria-pressed", "true"));
    expect(row.parentElement.firstElementChild).toBe(row);
    expect(screen.getAllByTestId("account-quota")[1]).toHaveTextContent("71");
    fireEvent.click(screen.getAllByRole("button", { name: "Account settings" })[1]);
    expect(await screen.findByText(/Old CLI logs may contain multiple identities/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledWith({ id: "system-codex" });
  });

  it("keeps tokens, quota and commands tied to the selected account", async () => {
    render(<SubscriptionAccounts />);
    fireEvent.click(await screen.findByRole("button", { name: /Codex Personal/ }));
    expect(await screen.findByText("222", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("run-b")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("account-quota")[1]).toHaveTextContent("35");
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[1]);
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "refresh", id: "b" } }));
  });

  it("marks the new default only after activation succeeds and preserves details on a repeated click", async () => {
    const rows = [{ ...initial[1], id: "b", label: "First" }, { ...initial[1], id: "c", label: "Second" }];
    let current = "b", finish;
    request.mockImplementation(async (options) => {
      if (options?.body?.action === "activate") return new Promise((resolve) => { finish = () => { current = "c"; resolve({ activation: { status: "applied" } }); }; });
      if (options?.id) return { ...detail("b"), account: rows.find((row) => row.id === options.id) };
      return { ...list(rows), global: { codex: { state: "active", activeAccountId: current } } };
    });
    render(<SubscriptionAccounts />);
    fireEvent.click(await screen.findByRole("button", { name: /Second/ }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(within(screen.getByRole("button", { name: /First/ })).getByLabelText("Current account")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Second/ })).queryByLabelText("Current account")).not.toBeInTheDocument();
    await act(async () => finish());
    await waitFor(() => expect(within(screen.getByRole("button", { name: /Second/ })).getByLabelText("Current account")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(screen.getByText("222", { selector: "p" })).toBeInTheDocument();
    expect(request.mock.calls.filter(([options]) => options?.body?.action === "activate")).toHaveLength(1);
  });

  it("deletes an account after a clear confirmation and exposes no archive controls", async () => {
    let deleted = false;
    request.mockImplementation(async (options) => {
      if (options?.body?.action === "delete") { deleted = true; return { deletion: { status: "deleted" } }; }
      if (options?.id) return detail(options.id);
      return { ...list(deleted ? [initial[0]] : initial), global: {} };
    });
    render(<SubscriptionAccounts />);
    await screen.findByText("222", { selector: "p" });
    fireEvent.click(screen.getAllByRole("button", { name: "Account settings" })[1]);
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Codex Personal?" });
    expect(request.mock.calls.some(([options]) => options?.body?.action === "delete")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Codex Personal/ })).not.toBeInTheDocument());
  });

  it("protects the current account before opening a delete confirmation", async () => {
    render(<SubscriptionAccounts />);
    await screen.findByText("222", { selector: "p" });
    fireEvent.click(screen.getAllByRole("button", { name: "Account settings" })[1]);
    expect(screen.getByRole("button", { name: "Delete account" })).toBeDisabled();
    expect(screen.getByText(/This account is in use/)).toBeInTheDocument();
  });

  it("keeps a failed detail request visible after a successful background list refresh", async () => {
    request.mockImplementation(async (options) => {
      if (options?.id === "b") throw new Error("offline");
      return options?.id ? detail(options.id) : list();
    });
    render(<SubscriptionAccounts />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(request.mock.calls.filter(([o]) => o?.id === "b").length).toBeGreaterThan(1));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps inactive conversations out of the primary session controls", async () => {
    request.mockImplementation(async (options) => options?.id ? detail(options.id) : {
      ...list(), sessions: [{ id: "old", provider: "claude", accountId: "a", state: "disconnected", cwd: "/old/project" }],
    });
    render(<SubscriptionAccounts />);
    await screen.findByRole("button", { name: /Claude Work/ });
    fireEvent.click(screen.getAllByRole("button", { name: "Sessions & automation" })[0]);
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument();
    expect(screen.queryByText(/Add another signed-in/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recent sessions (1)" }));
    expect(screen.getByText("Connection lost")).toBeInTheDocument();
  });

  it("keeps the confirmed delete target fixed when a refresh removes that row", async () => {
    let rows = initial;
    request.mockImplementation(async (options) => {
      if (options?.body?.action === "delete") return { deletion: { status: "deleted" } };
      if (options?.id) return detail(options.id);
      return { ...list(rows), global: {} };
    });
    render(<SubscriptionAccounts />);
    await screen.findByText("222", { selector: "p" });
    fireEvent.click(screen.getAllByRole("button", { name: "Account settings" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    rows = [initial[0], { ...initial[1], id: "replacement", label: "Replacement" }];
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByRole("button", { name: /Replacement/, hidden: true });
    const dialog = screen.getByRole("dialog", { name: "Delete Codex Personal?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "delete", id: "b" } }));
  });

  it("ignores a late response after selecting another account in the same provider", async () => {
    let resolveOld;
    const rows = [{ ...initial[1], id: "b", label: "First" }, { ...initial[1], id: "c", label: "Second" }];
    request.mockImplementation(async (options) => {
      if (options?.id === "b") return new Promise((resolve) => { resolveOld = resolve; });
      if (options?.id === "c") return { ...detail("b"), account: rows[1], commands: { login: "new-login", run: "new-run" } };
      return list(rows);
    });
    render(<SubscriptionAccounts />);
    fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Second" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Account settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Advanced · commands and history" }));
    await screen.findByText("new-run");
    await act(async () => resolveOld(detail("b")));
    expect(screen.getByText("new-run")).toBeInTheDocument();
    expect(screen.queryByText("run-b")).not.toBeInTheDocument();
  });

  it("launches the selected account and persists rotation through direct UI controls", async () => {
    request.mockImplementation(async (options) => {
      if (options?.body?.action === "launch") return { launch: { status: "dispatched" } };
      return options?.id ? detail(options.id) : list([...initial, { ...initial[1], id: "spare", label: "Codex Spare" }]);
    });
    render(<SubscriptionAccounts />);
    fireEvent.click(await screen.findByRole("button", { name: /Codex Personal/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Sessions & automation" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Start a conversation" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toContainElement(document.activeElement));
    fireEvent.change(within(dialog).getByLabelText("Project directory (optional)"), { target: { value: "/work/project" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "launch", id: "b", provider: "codex", auto: false, cwd: "/work/project" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Sessions & automation" })[1]);
    fireEvent.click(screen.getByRole("switch", { name: "Automatic account rotation" }));
    expect(localStorage.getItem("tokentracker.account-rotation.codex")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Start with rotation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open terminal" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "launch", id: "b", provider: "codex", auto: true, cwd: "/work/project" } }));
  });

  it("keeps blocked rotation in the dialog with an account permission action", async () => {
    request.mockImplementation(async (options) => {
      if (options?.body?.action === "launch") return { launch: { status: "blocked", issues: [{ id: "b", reason: "credentials_unavailable" }] } };
      return options?.id ? detail(options.id) : list([...initial, { ...initial[1], id: "spare", label: "Codex Spare" }]);
    });
    render(<SubscriptionAccounts />);
    await screen.findByRole("button", { name: /Codex Personal/ });
    fireEvent.click(screen.getAllByRole("button", { name: "Sessions & automation" })[1]);
    fireEvent.click(screen.getByRole("switch", { name: "Automatic account rotation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start with rotation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open terminal" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(/No account has verifiable quota/)).toBeInTheDocument();
    expect(screen.queryByText(/Sent to your terminal/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect quota" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveAccessibleName("Account settings"));
  });

  it("selecting details does not switch a live session; explicit switch targets the chosen account", async () => {
    const rows = [{ ...initial[0], registered: true }, { ...initial[0], id: "c", label: "Claude Second", registered: true }];
    const session = { id: "session-one", provider: "claude", accountId: "a", state: "running", cwd: "/work/project" };
    request.mockImplementation(async (options) => {
      if (options?.body?.action === "switch_session") return { switch: { status: "requested" } };
      if (options?.id) return detail(options.id);
      return { ...list(rows), sessions: [session] };
    });
    render(<SubscriptionAccounts />);
    fireEvent.click(await screen.findByRole("button", { name: /Claude Second/ }));
    expect(request.mock.calls.some(([options]) => options?.body?.action === "switch_session")).toBe(false);
    fireEvent.click(screen.getAllByRole("button", { name: "Sessions & automation" })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch session account" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Switch session account" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch to Claude Second" });
    expect(within(dialog).getByText(/Stops the current Claude process/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Switch and resume" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "switch_session", sessionId: "session-one", id: "c" } }));
    expect(screen.queryByText("Conversation resumed with this account")).not.toBeInTheDocument();
    expect(await screen.findByText(/Switch requested/)).toBeInTheDocument();
  });

  it("requires an explicit account quota access action before enabling scoped Keychain reads", async () => {
    const rows = [{ ...initial[0], registered: true, allowKeychain: false }];
    request.mockImplementation(async (options) => options?.id ? { ...detail(options.id), limits: { status: "credentials_unavailable" } } : list(rows));
    render(<SubscriptionAccounts />);
    await screen.findByRole("button", { name: "Connect quota" });
    fireEvent.click(screen.getByRole("button", { name: "Account settings" }));
    const button = await screen.findByRole("checkbox");
    expect(request.mock.calls.some(([options]) => options?.body?.allowKeychain)).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "update", id: "a", allowKeychain: true } }));
  });
});
