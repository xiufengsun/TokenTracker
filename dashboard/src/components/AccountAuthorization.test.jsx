import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountAuthorization } from "./AccountAuthorization.jsx";
const request = vi.hoisted(() => vi.fn());
vi.mock("../lib/subscription-accounts-api", () => ({ accountRequest: request }));
const session = { id: "session", accountId: "account", state: "waiting", authorizeUrl: "https://claude.ai/oauth/authorize?state=test", expiresAt: Date.now() + 180000 };

describe("AccountAuthorization", () => {
  beforeEach(() => request.mockReset());
  it("shows the official link and submits a pasted code to the specific login session", async () => {
    request.mockResolvedValue({ login: { ...session, needsCode: true } });
    render(<AccountAuthorization initialLogin={session} onComplete={vi.fn()} onSettled={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open sign-in page" })).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.change(await screen.findByLabelText("Authorization code"), { target: { value: "code#state" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete authorization" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ body: { action: "login_code", loginId: "session", code: "code#state" } }));
  });
  it("preserves the authorization code after a rejected submission and prevents duplicate submits", async () => {
    let rejectSubmit;
    request.mockImplementation((options) => options?.body ? new Promise((resolve, reject) => { rejectSubmit = reject; }) : Promise.resolve({ login: { ...session, needsCode: true } }));
    render(<AccountAuthorization initialLogin={session} onComplete={vi.fn()} onSettled={vi.fn()} />);
    const input = await screen.findByLabelText("Authorization code");
    fireEvent.change(input, { target: { value: "keep-this-code" } });
    const submit = screen.getByRole("button", { name: "Complete authorization" });
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(request.mock.calls.filter(([o]) => o?.body)).toHaveLength(1);
    rejectSubmit(new Error("offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your input is kept");
    expect(input).toHaveValue("keep-this-code");
    expect(submit).toBeEnabled();
  });

  it("selects the verified account only after server completion", async () => {
    request.mockResolvedValue({ login: { ...session, state: "complete", authorizeUrl: null } });
    const completed = vi.fn(), settled = vi.fn();
    render(<AccountAuthorization initialLogin={session} onComplete={completed} onSettled={settled} />);
    await waitFor(() => expect(completed).toHaveBeenCalledWith("account"));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("cancels the server login and stops offering the URL", async () => {
    request.mockImplementation(async (options) => ({ login: options?.body ? { ...session, state: "cancelling", authorizeUrl: null } : session }));
    render(<AccountAuthorization initialLogin={session} onComplete={vi.fn()} onSettled={vi.fn()} />);
    await waitFor(() => expect(request).toHaveBeenCalledWith({ loginId: "session" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel authorization" }));
    await waitFor(() => expect(screen.queryByRole("link")).not.toBeInTheDocument());
    expect(request).toHaveBeenCalledWith({ body: { action: "login_cancel", loginId: "session" } });
  });
});
