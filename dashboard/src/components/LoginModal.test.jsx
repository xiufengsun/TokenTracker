import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../lib/copy";
import { LoginModalProvider, useLoginModal } from "../contexts/LoginModalContext.jsx";
import { LoginModal } from "./LoginModal.jsx";
import { LoginCard } from "./LoginCard.jsx";
import { beginCloudAction, readCloudAction } from "../lib/cloud-action-intent.js";

const state = vi.hoisted(() => ({
  bridge: null,
  navigate: null,
  authListeners: new Set(),
  auth: {
    enabled: true, configurationError: null, loading: false, signedIn: false,
    refreshUser: vi.fn(async () => undefined),
    signInWithPassword: vi.fn(),
    signInWithOAuth: vi.fn(),
    getPublicAuthConfig: vi.fn(),
  },
}));
vi.mock("../contexts/InsforgeAuthContext.jsx", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener) => {
    state.authListeners.add(listener);
    return () => state.authListeners.delete(listener);
  };
  return { useInsforgeAuth: () => {
    const signedIn = useSyncExternalStore(subscribe, () => state.auth.signedIn);
    return { ...state.auth, signedIn };
  } };
});
vi.mock("../lib/native-bridge.js", () => ({ getNativeOAuthBridge: () => state.bridge }));
vi.mock("../hooks/useLocale.js", () => ({ useLocale: () => ({ resolvedLocale: "en" }) }));

const trialPath = "/cloud?intent=trial&sku=cloud_usd_yearly&source=plans";
const click = (target) => act(async () => { await userEvent.click(target); });
function Harness({ options }) {
  const { openLoginModal } = useLoginModal();
  const location = useLocation();
  state.navigate = useNavigate();
  return <>
    <button onClick={options ? () => openLoginModal(options) : openLoginModal}>{"Open login"}</button>
    <output data-testid="location">{location.pathname + location.search}</output>
  </>;
}
function show(options, path = "/cloud") {
  return render(<MemoryRouter initialEntries={Array.isArray(path) ? path : [path]}><LoginModalProvider>
    <Harness options={options} /><LoginModal />
  </LoginModalProvider></MemoryRouter>);
}
async function open(options, path) {
  const view = show(options, path);
  await click(screen.getByRole("button", { name: "Open login" }));
  await screen.findByRole("button", { name: /GitHub/ });
  return view;
}
async function submitPassword() {
  await click(screen.getByRole("button", { name: "Continue with Email" }));
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "person@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-secret-password" } });
  await click(screen.getByRole("button", { name: "Sign in with email" }));
}
beforeEach(() => {
  setCopyLocale("en");
  sessionStorage.clear();
  state.bridge = null;
  state.auth.enabled = true;
  state.auth.configurationError = null;
  state.auth.signedIn = false;
  state.auth.refreshUser.mockClear();
  state.auth.getPublicAuthConfig.mockReset().mockResolvedValue({ data: { oAuthProviders: ["github"] } });
  state.auth.signInWithOAuth.mockReset().mockResolvedValue({ error: null });
  state.auth.signInWithPassword.mockReset().mockImplementation(async () => {
    state.auth.signedIn = true;
    state.authListeners.forEach((listener) => listener());
    return { error: null };
  });
  window.history.replaceState(null, "", "/cloud");
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

it("returns a password sign-in to the complete Cloud task without activating it", async () => {
  const subtitle = copy("cloud.login.trial_context");
  await open({ nextPath: trialPath, subtitle });
  expect(screen.getByRole("dialog", { name: "Sign in" })).toHaveAccessibleDescription(subtitle);
  expect(screen.getByRole("heading", { name: "Sign in" })).toHaveClass("sr-only");
  expect(screen.queryByText("Sign in to join the leaderboard")).not.toBeInTheDocument();
  expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
  await submitPassword();
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(trialPath));
  expect(state.auth.signInWithPassword).toHaveBeenCalledWith({ email: "person@example.com", password: "a-secret-password" });
  expect(state.auth.signInWithOAuth).not.toHaveBeenCalled();
});
it("does not navigate after the dialog is canceled during a password sign-in", async () => {
  let finishSignIn;
  state.auth.signInWithPassword.mockReturnValue(new Promise((resolve) => { finishSignIn = resolve; }));
  await open({ nextPath: trialPath, closePath: "/cloud" }, "/billing/checkout?intent=trial");
  await submitPassword();
  await click(screen.getByRole("button", { name: "Close dialog" }));
  await act(async () => {
    state.auth.signedIn = true;
    state.authListeners.forEach((listener) => listener());
    finishSignIn({ error: null });
  });
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("cancels the actual login dialog on history Back before a late password result can resume a purchase", async () => {
  let finishSignIn;
  state.auth.signInWithPassword.mockReturnValue(new Promise((resolve) => { finishSignIn = resolve; }));
  const nextPath = beginCloudAction({ trial: false, sku: "cloud_usd_yearly_fixed" });
  await open({ nextPath, closePath: "/cloud" }, ["/settings?section=account", "/cloud"]);
  await submitPassword();
  await act(async () => { state.navigate(-1); });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=account");
  expect(readCloudAction(nextPath, "account-1")).toBeNull();
  await act(async () => {
    state.auth.signedIn = true;
    state.authListeners.forEach((listener) => listener());
    finishSignIn({ error: null });
  });
  expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=account");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("lets ordinary onClick login finish without a return destination", async () => {
  await open(undefined, "/settings");
  expect(screen.queryByText("Sign in to join the leaderboard")).not.toBeInTheDocument();
  await submitPassword();
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings$/);
});
it("keeps focus inside the dialog and cancels its OAuth return on Escape", async () => {
  await open({ nextPath: trialPath, closePath: "/cloud" }, "/billing/checkout?intent=trial");
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("button", { name: "Close dialog" })).toHaveClass("h-11", "w-11");
  await click(screen.getByRole("button", { name: /GitHub/ }));
  expect(sessionStorage.getItem("tt.cloud.return")).toBe(trialPath);
  for (let i = 0; i < 6; i += 1) {
    await act(async () => { await userEvent.tab(); });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  }
  await act(async () => { await userEvent.keyboard("{Escape}"); });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
  expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
});
it.each([false, true])("shows a configuration explanation when auth is disabled, invalid=%s", async (invalid) => {
  state.auth.enabled = false;
  state.auth.configurationError = invalid ? "invalid configuration" : null;
  show({ nextPath: trialPath });
  await click(screen.getByRole("button", { name: "Open login" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole(invalid ? "alert" : "status")).toHaveTextContent(copy(invalid ? "instance.configuration.invalid" : "login.cloud_only"));
  expect(screen.queryByRole("button", { name: /GitHub/ })).not.toBeInTheDocument();
});

it.each([
  "/cloud?intent=trial&sku=cloud_usd_yearly",
  "/billing/checkout?sku=cloud_usd_monthly_fixed",
])("saves an explicit OAuth return only on click and keeps the allowed root web callback for %s", async (target) => {
  render(<LoginCard oauthReturnPath={target} />);
  const oauth = await screen.findByRole("button", { name: /GitHub/ });
  expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
  await click(oauth);
  expect(sessionStorage.getItem("tt.cloud.return")).toBe(target);
  expect(state.auth.signInWithOAuth).toHaveBeenCalledWith("github", `${window.location.origin}/`);
});
it("shows both enabled OAuth providers without restoring the visible modal title", async () => {
  state.auth.getPublicAuthConfig.mockResolvedValue({ data: { oAuthProviders: ["github", "google"], customOAuthProviders: [] } });
  await open({ nextPath: trialPath, subtitle: copy("cloud.login.trial_context") });
  expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Sign in" })).toHaveClass("sr-only");
  expect(screen.getAllByRole("heading", { name: "Sign in" })).toHaveLength(1);
});
it.each([`<!DOCTYPE html><html><body>${"Vite app"}</body></html>`, {}, { oAuthProviders: "github,google" }])(
  "uses the existing unavailable-config fallback for a malformed successful response %j", async (data) => {
    state.auth.getPublicAuthConfig.mockResolvedValue({ data, error: null });
    render(<LoginCard />);
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeInTheDocument();
    expect(state.auth.signInWithOAuth).not.toHaveBeenCalled();
  },
);
it("respects a legitimate empty provider list and leaves email sign-in available", async () => {
  state.auth.getPublicAuthConfig.mockResolvedValue({ data: { oAuthProviders: [], customOAuthProviders: [] }, error: null });
  await act(async () => { render(<LoginCard />); });
  expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Continue with GitHub" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue with Email" })).toBeEnabled();
});
it("detects a native bridge installed after the card renders and retains its Cloud task", async () => {
  render(<LoginCard oauthReturnPath={trialPath} />);
  const oauth = await screen.findByRole("button", { name: /GitHub/ });
  state.bridge = { postMessage: vi.fn() };
  await click(oauth);
  expect(state.auth.signInWithOAuth).toHaveBeenCalledWith("github", "tokentracker://auth/callback");
  expect(sessionStorage.getItem("tt.cloud.return")).toBe(trialPath);
});
it.each([undefined, "//foreign.example/cloud", "https://foreign.example/cloud", "/cloud\\foreign"])(
  "preserves the default OAuth behavior without accepting an unsafe target %s", async (target) => {
    render(<LoginCard oauthReturnPath={target} />);
    await click(await screen.findByRole("button", { name: /GitHub/ }));
    expect(state.auth.signInWithOAuth).toHaveBeenCalledWith("github", `${window.location.origin}/`);
    expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
  },
);
