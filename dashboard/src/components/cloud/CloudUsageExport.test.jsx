/** @vitest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudUsageExport } from "./CloudUsageExport.jsx";

const state = vi.hoisted(() => ({ userId: "account-a", client: null, getter: null, save: null }));
vi.mock("../../lib/native-bridge.js", () => ({ saveCloudUsageExport: options => state.save(options) }));
vi.mock("../../contexts/InsforgeAuthContext.jsx", () => ({ useInsforgeAuth: () => ({ enabled: true,
  signedIn: Boolean(state.userId), user: { id: state.userId }, client: state.client, getAccessToken: state.getter }) }));
vi.mock("../../lib/insforge-config", () => ({ getInsforgeRemoteUrl: () => "https://backend.test",
  getInsforgeAnonKey: () => "fixture-anon", INSFORGE_INSTANCE_CHANGED_EVENT: "tt.insforgeInstanceChanged",
  isCurrentInsforgeClient: () => true }));
let blobs, links;
const membership = { environment: "live", membership: { can_read_cloud: true, status: "legacy_free", phase: "preview" } };
const daily = { from: "2026-10-01", to: "2026-10-10", data: [{ day: "2026-10-01", total_tokens: 100,
  billable_total_tokens: 100, input_tokens: 40, output_tokens: 60, cached_input_tokens: 0,
  cache_creation_input_tokens: 0, reasoning_output_tokens: 0, conversation_count: 1, total_cost_usd: 0.25,
  prompt: "private-prompt-canary" }] };
function jwt(owner) {
  const encode = value => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return encode({ alg: "HS256" }) + "." + encode({ sub: owner, role: "authenticated", exp: Date.now() / 1000 + 300 }) + ".fixture";
}
const text = blob => new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
beforeEach(() => {
  state.userId = "account-a"; state.client = { instance: "a" }; state.getter = vi.fn(async () => jwt(state.userId));
  state.save = vi.fn(async () => null);
  blobs = []; links = [];
  vi.stubGlobal("fetch", vi.fn(async url => new Response(JSON.stringify(String(url).includes("billing") ? membership : daily),
    { headers: { "Content-Type": "application/json" } })));
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(blob => { blobs.push(blob); return "blob:export"; }) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { links.push(this.download); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount() { return render(<CloudUsageExport from="2026-09-01" to="2026-10-10" />); }
async function open() { fireEvent.click(screen.getByRole("button", { name: "Export Cloud usage" })); }
function ControlledSettingsExport() {
  const [dialogOpen, onDialogOpenChange] = React.useState(false);
  return <CloudUsageExport from="2026-09-01" to="2026-10-10" layout="settings-row"
    dialogOpen={dialogOpen} onDialogOpenChange={onDialogOpenChange} />;
}
function mountSettingsRow(controlled = false) {
  return render(controlled ? <ControlledSettingsExport />
    : <CloudUsageExport from="2026-09-01" to="2026-10-10" layout="settings-row" />);
}
async function openSettingsDialog(user) {
  await act(async () => user.click(screen.getByRole("button", { name: "Export Cloud usage" })));
  return screen.findByRole("dialog", { name: "Export Cloud usage" });
}
async function closeSettingsDialog(user) {
  await act(async () => user.keyboard("{Escape}"));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
}

it("downloads actual CSV and JSON Blob contents with accessible labels and effective range", async () => {
  mount(); await open();
  expect(screen.getByText("Daily totals · UTC dates · USD estimates")).toBeVisible();
  expect(screen.getByLabelText("From (UTC)")).toHaveValue("2026-09-01");
  expect(screen.getByLabelText("To (UTC)")).toHaveValue("2026-10-10");
  fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
  await waitFor(() => expect(blobs).toHaveLength(1));
  expect(links[0]).toBe("tokentracker-cloud-usage-2026-10-01-2026-10-10.csv");
  const csv = await text(blobs[0]);
  expect(csv).toContain('"metadata"');
  expect(csv).toContain('"usage"');
  expect(csv).toContain('"estimated_cost_usd"');
  expect(csv).not.toContain("private-prompt-canary");
  expect(await screen.findByRole("status")).toHaveTextContent("only the available range");
  fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
  await waitFor(() => expect(blobs).toHaveLength(2));
  const json = JSON.parse(await text(blobs[1]));
  expect(json.schema).toBe("tokentracker.cloud-usage.v1");
  expect(json.metadata).toMatchObject({ source: "cloud", timezone: "UTC", row_count: 1, requested_range: { from: "2026-09-01", to: "2026-10-10" } });
  expect(json.rows[0].estimated_cost_usd).toBe(0.25);
});

it("shows permission errors and retries fresh instead of downloading an earlier file", async () => {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockResolvedValueOnce(new Response("{}", { status: 402 }));
  mount(); await open(); fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
  expect(blobs).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
  await waitFor(() => expect(blobs).toHaveLength(1));
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it.each(["account", "client", "date", "device", "signout", "instance"])("does not download a late response after %s changes", async change => {
  let release;
  state.getter = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const view = mount(); await open(); fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
  await waitFor(() => expect(state.getter).toHaveBeenCalled());
  if (change === "account") { state.userId = "account-b"; view.rerender(<CloudUsageExport from="2026-09-01" to="2026-10-10" />); }
  if (change === "client") { state.client = { instance: "b" }; view.rerender(<CloudUsageExport from="2026-09-01" to="2026-10-10" />); }
  if (change === "date") fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2026-09-02" } });
  if (change === "device") view.rerender(<CloudUsageExport from="2026-09-01" to="2026-10-10" deviceId="33333333-3333-4333-8333-333333333333" />);
  if (change === "signout") { state.userId = null; view.rerender(<CloudUsageExport from="2026-09-01" to="2026-10-10" />); }
  if (change === "instance") act(() => window.dispatchEvent(new Event("tt.insforgeInstanceChanged")));
  await act(async () => release(jwt("account-a")));
  await waitFor(() => expect(screen.queryByText("Checking Cloud access and preparing your file…")).not.toBeInTheDocument());
  expect(blobs).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("waits for native save acknowledgement and never creates a browser Blob", async () => {
  let acknowledge;
  state.save = vi.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  mount(); await open(); fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Download JSON" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("preparing your file");
  expect(state.save.mock.calls[0][0]).toMatchObject({ format: "json", filename: "tokentracker-cloud-usage-2026-10-01-2026-10-10.json" });
  expect(JSON.parse(state.save.mock.calls[0][0].content).rows[0].estimated_cost_usd).toBe(0.25);
  await act(async () => acknowledge({ saved: true, filename: "tokentracker-cloud-usage-2026-10-01-2026-10-10.json" }));
  expect(screen.getByRole("status")).toHaveTextContent("Downloaded 1 recorded days");
  expect(blobs).toHaveLength(0);
});

it("does not fall back to a browser download after a native save failure", async () => {
  state.save = vi.fn(async () => { throw Error("private-native-path-canary"); });
  mount(); await open(); fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The export failed");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private-native-path-canary");
  expect(blobs).toHaveLength(0);
});

it("cancels waiting for native acknowledgement and discards a late acknowledgement on account switch", async () => {
  let acknowledge;
  state.save = vi.fn(() => new Promise(resolve => { acknowledge = resolve; }));
  const view = mount(); await open(); fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
  await waitFor(() => { expect(state.save).toHaveBeenCalledOnce(); });
  const nativeSignal = state.save.mock.calls[0][0].signal;
  state.userId = "account-b"; view.rerender(<CloudUsageExport from="2026-09-01" to="2026-10-10" />);
  expect(nativeSignal.aborted).toBe(true);
  await act(async () => acknowledge({ saved: true, filename: "tokentracker-cloud-usage-2026-10-01-2026-10-10.json" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(blobs).toHaveLength(0);
});

it.each([false, true])("opens one settings export dialog and restores trigger focus on Escape (controlled: %s)", async controlled => {
  const user = userEvent.setup();
  mountSettingsRow(controlled);
  const trigger = screen.getByRole("button", { name: "Export Cloud usage" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("From (UTC)")).not.toBeInTheDocument();
  const dialog = await openSettingsDialog(user);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(within(dialog).getByRole("heading", { name: "Export Cloud usage" })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Pick a date range" })).toHaveTextContent("2026-09-01 → 2026-10-10");
  await closeSettingsDialog(user);
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("applies and cancels a draft range using the shared Dashboard calendar", async () => {
  const user = userEvent.setup();
  mountSettingsRow();
  const dialog = await openSettingsDialog(user);
  const range = within(dialog).getByRole("button", { name: "Pick a date range" });
  await act(async () => user.click(range));
  expect(screen.getAllByRole("grid")).toHaveLength(2);
  await act(async () => user.keyboard("{Escape}"));
  expect(dialog).toBeVisible();
  expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  await act(async () => user.click(range));
  await act(async () => user.click(screen.getByRole("button", { name: "Cancel", exact: true })));
  expect(range).toHaveTextContent("2026-09-01 → 2026-10-10");
  await act(async () => user.click(range));
  await act(async () => user.click(screen.getByRole("button", { name: /September 15th, 2026/ })));
  await act(async () => user.click(screen.getByRole("button", { name: "Apply", exact: true })));
  expect(range).toHaveTextContent("2026-09-01 → 2026-09-15");
  expect(screen.queryByRole("grid")).not.toBeInTheDocument();
});

it("cancels a delayed token on dialog close without downloading or leaking feedback after reopening", async () => {
  let release;
  state.getter = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const user = userEvent.setup();
  mountSettingsRow();
  const dialog = await openSettingsDialog(user);
  await act(async () => user.click(within(dialog).getByRole("button", { name: "Download CSV" })));
  await waitFor(() => expect(state.getter).toHaveBeenCalledOnce());
  expect(within(dialog).getByRole("status")).toHaveTextContent("preparing your file");
  await closeSettingsDialog(user);
  const reopened = await openSettingsDialog(user);
  await act(async () => release(jwt("account-a")));
  expect(fetch).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(blobs).toHaveLength(0);
  expect(links).toHaveLength(0);
  expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
  expect(within(reopened).queryByRole("status")).not.toBeInTheDocument();
  expect(within(reopened).getByRole("button", { name: "Download CSV" })).toBeEnabled();
});

it.each(["response", "error"])("aborts a delayed request on dialog close and ignores its late %s", async result => {
  let settle, requestSignal;
  vi.mocked(fetch).mockImplementationOnce((_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve, reject) => { settle = result === "error" ? reject : resolve; });
  });
  const user = userEvent.setup();
  mountSettingsRow();
  const dialog = await openSettingsDialog(user);
  await act(async () => user.click(within(dialog).getByRole("button", { name: "Download CSV" })));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(requestSignal.aborted).toBe(false);
  await closeSettingsDialog(user);
  expect(requestSignal.aborted).toBe(true);
  const reopened = await openSettingsDialog(user);
  await act(async () => settle(result === "error" ? Error("late-request-canary")
    : new Response(JSON.stringify(membership), { headers: { "Content-Type": "application/json" } })));
  expect(fetch).toHaveBeenCalledOnce();
  expect(state.save).not.toHaveBeenCalled();
  expect(blobs).toHaveLength(0);
  expect(links).toHaveLength(0);
  expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
  expect(within(reopened).queryByRole("status")).not.toBeInTheDocument();
  expect(within(reopened).getByRole("button", { name: "Download CSV" })).toBeEnabled();
});

it.each(["saved", "unhandled", "error"])("cancels native save on dialog close and ignores late %s without a browser fallback", async result => {
  let settle;
  state.save = vi.fn(() => new Promise((resolve, reject) => { settle = result === "error" ? reject : resolve; }));
  const user = userEvent.setup();
  mountSettingsRow();
  const dialog = await openSettingsDialog(user);
  await act(async () => user.click(within(dialog).getByRole("button", { name: "Download JSON" })));
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  const nativeSignal = state.save.mock.calls[0][0].signal;
  expect(nativeSignal.aborted).toBe(false);
  await closeSettingsDialog(user);
  expect(nativeSignal.aborted).toBe(true);
  const reopened = await openSettingsDialog(user);
  await act(async () => settle(result === "error" ? Error("late-native-canary")
    : result === "saved" ? { saved: true, filename: "tokentracker-cloud-usage-2026-10-01-2026-10-10.json" } : null));
  expect(state.save).toHaveBeenCalledOnce();
  expect(blobs).toHaveLength(0);
  expect(links).toHaveLength(0);
  expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
  expect(within(reopened).queryByRole("status")).not.toBeInTheDocument();
  expect(within(reopened).getByRole("button", { name: "Download JSON" })).toBeEnabled();
});
