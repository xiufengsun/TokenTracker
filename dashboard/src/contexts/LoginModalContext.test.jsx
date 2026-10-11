import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cloudLoginNextPath, LoginModalProvider, useLoginModal } from "./LoginModalContext.jsx";
import { beginCloudAction, readCloudAction } from "../lib/cloud-action-intent.js";

let modal;
let navigate;
function Harness() {
  modal = useLoginModal();
  const location = useLocation();
  navigate = useNavigate();
  return <>
    <button onClick={modal.openLoginModal}>{"Generic login"}</button>
    <output data-testid="location">{location.pathname + location.search}</output>
    <output data-testid="open">{String(modal.isOpen)}</output>
  </>;
}
function show(path = "/cloud") {
  return render(<MemoryRouter initialEntries={Array.isArray(path) ? path : [path]}><LoginModalProvider><Harness /></LoginModalProvider></MemoryRouter>);
}
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

it.each([
  "/cloud", "/cloud?intent=trial&sku=cloud_usd_monthly_fixed",
  "/billing/checkout?intent=trial&sku=cloud_usd_yearly",
  "/billing/checkout?order=11111111-1111-4111-8111-111111111111",
])("accepts the complete internal Cloud path %s", (nextPath) => {
  expect(cloudLoginNextPath(nextPath)).toBe(nextPath);
});
it.each([undefined, "", "https://foreign.example/cloud", "//foreign.example/cloud", "/cloud/../../foreign", "/cloud\\foreign", "/cloud?x=\nforeign", "/dashboard", "/billing/checkout/extra"])(
  "rejects an unrelated or unsafe return path %s", (nextPath) => {
    show();
    act(() => modal.openLoginModal({ nextPath }));
    expect(modal.request.nextPath).toBeNull();
    act(() => modal.completeLoginModal(modal.request.id));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
  },
);
it("keeps existing direct onClick callers generic and does not navigate on success", () => {
  show("/settings");
  fireEvent.click(screen.getByRole("button", { name: "Generic login" }));
  expect(modal.isOpen).toBe(true);
  expect(modal.request.nextPath).toBeNull();
  act(() => modal.completeLoginModal(modal.request.id));
  expect(modal.isOpen).toBe(false);
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings$/);
});
it("consumes success once and preserves the intent, SKU and query", () => {
  const target = "/billing/checkout?intent=trial&sku=cloud_usd_yearly&source=plans";
  show();
  act(() => modal.openLoginModal({ nextPath: target, closePath: "/cloud" }));
  const { id } = modal.request;
  sessionStorage.setItem("tt.cloud.return", target);
  act(() => { modal.completeLoginModal(id); modal.completeLoginModal(id); });
  expect(screen.getByTestId("location")).toHaveTextContent(target);
  expect(modal.isOpen).toBe(false);
  expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
});
it("cancels before a late success can run and clears only its own OAuth return", () => {
  const target = "/billing/checkout?intent=trial&sku=cloud_usd_yearly";
  show("/billing/checkout?intent=trial");
  act(() => modal.openLoginModal({ nextPath: target, closePath: "/cloud" }));
  const { id } = modal.request;
  sessionStorage.setItem("tt.cloud.return", target);
  act(() => { modal.closeLoginModal(id); modal.completeLoginModal(id); });
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
  expect(modal.isOpen).toBe(false);
  expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
  act(() => modal.openLoginModal({ nextPath: target }));
  sessionStorage.setItem("tt.cloud.return", "/billing/checkout?sku=other");
  act(() => modal.closeLoginModal());
  expect(sessionStorage.getItem("tt.cloud.return")).toBe("/billing/checkout?sku=other");
});
it("invalidates the earlier callback immediately when a new request opens", () => {
  show();
  act(() => modal.openLoginModal({ nextPath: "/cloud?intent=trial" }));
  const oldId = modal.request.id;
  act(() => {
    modal.openLoginModal({ nextPath: "/billing/checkout?sku=cloud_usd_monthly_fixed" });
    modal.completeLoginModal(oldId);
    modal.closeLoginModal(oldId);
  });
  expect(modal.isOpen).toBe(true);
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
  act(() => modal.completeLoginModal(modal.request.id));
  expect(screen.getByTestId("location")).toHaveTextContent("/billing/checkout?sku=cloud_usd_monthly_fixed");
});
it("lets a closed dialog reopen without reviving its canceled callback", () => {
  show("/settings");
  act(() => modal.openLoginModal({ nextPath: "/cloud?intent=trial" }));
  const canceledId = modal.request.id;
  act(() => modal.closeLoginModal(canceledId));
  act(() => modal.openLoginModal({ nextPath: "/billing/checkout?sku=cloud_usd_yearly_fixed" }));
  act(() => modal.completeLoginModal(canceledId));
  expect(modal.isOpen).toBe(true);
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings$/);
});
it("cancels a pending request on browser Back without overriding the destination or reviving a late success", async () => {
  const nextPath = beginCloudAction({ trial: false, sku: "cloud_usd_yearly_fixed" });
  show(["/settings?section=account", "/cloud"]);
  act(() => modal.openLoginModal({ nextPath, closePath: "/cloud" }));
  const { id } = modal.request;
  sessionStorage.setItem("tt.cloud.return", nextPath);
  await act(async () => { navigate(-1); });
  expect(modal.isOpen).toBe(false);
  expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=account");
  expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
  expect(readCloudAction(nextPath, "account-1")).toBeNull();
  act(() => modal.completeLoginModal(id));
  expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=account");
  await act(async () => { navigate(1); });
  expect(modal.isOpen).toBe(false);
});
it("does not clear a consumed action when successful login navigates to its own destination", async () => {
  const nextPath = beginCloudAction({ trial: true, sku: "cloud_usd_yearly" });
  show("/cloud");
  act(() => modal.openLoginModal({ nextPath }));
  await act(async () => { modal.completeLoginModal(modal.request.id); });
  expect(screen.getByTestId("location")).toHaveTextContent(nextPath);
  expect(readCloudAction(nextPath, "account-1")).not.toBeNull();
});

it("clears its action on cancel before a late sign-in completes", () => {
  const nextPath = beginCloudAction({ trial: true, sku: "cloud_usd_yearly" });
  show();
  act(() => modal.openLoginModal({ nextPath }));
  const { id } = modal.request;
  act(() => { modal.closeLoginModal(id); modal.completeLoginModal(id); });
  expect(readCloudAction(nextPath, "account-1")).toBeNull();
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
});
it("keeps the new action when replacing an earlier pending login request", () => {
  const previous = beginCloudAction({ trial: true, sku: "cloud_usd_yearly" });
  show();
  act(() => modal.openLoginModal({ nextPath: previous }));
  const oldId = modal.request.id;
  const current = beginCloudAction({ trial: false, sku: "cloud_usd_monthly_fixed" });
  act(() => { modal.openLoginModal({ nextPath: current }); modal.closeLoginModal(oldId); });
  expect(readCloudAction(previous, "account-1")).toBeNull();
  expect(readCloudAction(current, "account-1")).not.toBeNull();
  act(() => modal.completeLoginModal(modal.request.id));
  expect(readCloudAction(current, "account-1")).not.toBeNull();
});
it("preserves a valid action after successful login while consuming only the OAuth return", () => {
  const nextPath = beginCloudAction({ trial: false, sku: "cloud_usd_yearly_fixed" });
  show();
  act(() => modal.openLoginModal({ nextPath }));
  sessionStorage.setItem("tt.cloud.return", nextPath);
  act(() => modal.completeLoginModal(modal.request.id));
  expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
  expect(readCloudAction(nextPath, "account-1")).toMatchObject({ trial: false, sku: "cloud_usd_yearly_fixed" });
  expect(screen.getByTestId("location")).toHaveTextContent(nextPath);
});
it("clears the pending Cloud action when a new ordinary login replaces it", () => {
  const nextPath = beginCloudAction({ trial: true, sku: "cloud_usd_yearly" });
  show();
  act(() => modal.openLoginModal({ nextPath }));
  const oldId = modal.request.id;
  act(() => { modal.openLoginModal(); modal.completeLoginModal(oldId); });
  expect(readCloudAction(nextPath, "account-1")).toBeNull();
  expect(modal.isOpen).toBe(true);
  expect(modal.request.nextPath).toBeNull();
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/cloud$/);
});
