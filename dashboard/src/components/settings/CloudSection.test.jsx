import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../../lib/copy";
import { AccountSection } from "./AccountSection.jsx";
import { CloudSection } from "./CloudSection.jsx";

const state = vi.hoisted(() => ({ useSettings: vi.fn(), membershipActive: null }));
vi.mock("./useAccountProfileSettings.js", () => ({ useAccountProfileSettings: state.useSettings }));
vi.mock("../cloud/CloudMembershipCard.jsx", () => ({
  CloudMembershipCard: ({ active }) => { state.membershipActive = active; return <button type="button">{copy("cloud.action.sign_in_continue")}</button>; },
}));
beforeEach(() => {
  setCopyLocale("en");
  state.useSettings.mockReset().mockReturnValue({ enabled: false, signedIn: false, showLocalCloudSync: false });
});
afterEach(cleanup);

it("forwards panel activity without recreating shared account settings", () => {
  const settings = { enabled: false, signedIn: false, showLocalCloudSync: false };
  const view = render(<MemoryRouter><CloudSection settings={settings} active /></MemoryRouter>);
  expect(state).toMatchObject({ membershipActive: true });
  view.rerender(<MemoryRouter><CloudSection settings={settings} active={false} /></MemoryRouter>);
  expect(state.membershipActive).toBe(false);
  expect(state.useSettings).not.toHaveBeenCalled();
});

it("keeps Cloud sign-in management available to a guest even when personal account settings are disabled", () => {
  const settings = { enabled: false, signedIn: false, showLocalCloudSync: false };
  render(<MemoryRouter><AccountSection settings={settings} /><CloudSection settings={settings} /></MemoryRouter>);
  expect(screen.getByRole("button", { name: copy("cloud.action.sign_in_continue") })).toBeEnabled();
  expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  expect(state.useSettings).not.toHaveBeenCalled();
});
it("preserves standalone Cloud rendering while keeping profile controls out of that section", () => {
  render(<MemoryRouter><CloudSection /></MemoryRouter>);
  expect(state.useSettings).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: copy("cloud.action.sign_in_continue") })).toBeInTheDocument();
  expect(screen.queryByRole("switch", { name: "Public profile" })).not.toBeInTheDocument();
});
it("preserves standalone Account rendering with identity and profile but no Cloud management", () => {
  state.useSettings.mockReturnValue({ enabled: true, signedIn: true, userId: "profile-user", email: "person@example.com",
    name: {}, github: {}, publicProfileOn: false, signOut: vi.fn(), handlePublicProfileToggle: vi.fn() });
  render(<MemoryRouter><AccountSection /></MemoryRouter>);
  expect(state.useSettings).toHaveBeenCalledTimes(1);
  expect(screen.getByText("profile-user")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Public profile" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: copy("cloud.action.sign_in_continue") })).not.toBeInTheDocument();
});
