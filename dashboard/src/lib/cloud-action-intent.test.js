import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginCloudAction, beginCloudOrderAction, clearCloudAction, consumeCloudAction, readCloudAction } from "./cloud-action-intent.js";

const config = vi.hoisted(() => ({ backend: "https://instance-a.example" }));
vi.mock("./insforge-config", () => ({ getInsforgeInstanceFingerprint: () => config.backend }));
let currentPath;
const start = (options = {}) => {
  currentPath = beginCloudAction({ trial: false, sku: "cloud_usd_yearly", ...options });
  return currentPath;
};
const orderId = "11111111-1111-4111-8111-111111111111";
const startOrder = (options = {}) => {
  currentPath = beginCloudOrderAction({ orderId, userId: "account-1", ...options });
  return currentPath;
};
beforeEach(() => {
  config.backend = "https://instance-a.example";
  sessionStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearCloudAction(currentPath);
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("retains the explicit trial selection and consumes a guest action once after sign-in", () => {
  const path = start({ trial: true, sku: "cloud_usd_monthly_fixed" });
  const params = new URLSearchParams(path.split("?")[1]);
  expect(params.get("intent")).toBe("trial");
  expect(params.get("sku")).toBe("cloud_usd_monthly_fixed");
  expect(params.get("flow")).toMatch(/^[0-9a-f-]{36}$/);
  expect(readCloudAction(path)).toMatchObject({ nextPath: path, trial: true, ownerId: null, backend: config.backend, createdAt: 1_000_000 });
  expect(consumeCloudAction(path)).toBeNull();
  expect(consumeCloudAction(path, "account-1")).toMatchObject({ sku: "cloud_usd_monthly_fixed", trial: true });
  expect(consumeCloudAction(path, "account-1")).toBeNull();
  expect(sessionStorage.getItem("tt.cloud.action")).toBeNull();
});
it("requires the exact saved path and never grants an action to a deep URL alone", () => {
  const path = start({ userId: "account-1" });
  expect(readCloudAction(path + "&extra=1", "account-1")).toBeNull();
  expect(consumeCloudAction(path.replace("cloud_usd_yearly", "cloud_usd_monthly"), "account-1")).toBeNull();
  expect(consumeCloudAction(path, "account-1")).not.toBeNull();
  expect(readCloudAction(path, "account-1")).toBeNull();
});
it("cannot execute another account's owned action and keeps it available to its owner", () => {
  const path = start({ userId: "account-1" });
  expect(readCloudAction(path)).toBeNull();
  expect(consumeCloudAction(path, "account-2")).toBeNull();
  expect(consumeCloudAction(path, "account-1")).toMatchObject({ ownerId: "account-1" });
});
it("does not borrow the action after switching backend instances", () => {
  const path = start({ userId: "account-1" });
  config.backend = "https://instance-b.example";
  expect(readCloudAction(path, "account-1")).toBeNull();
  expect(consumeCloudAction(path, "account-1")).toBeNull();
  config.backend = "https://instance-a.example";
  expect(consumeCloudAction(path, "account-1")).not.toBeNull();
});
it("expires the action at thirty minutes and rejects future timestamps", () => {
  const path = start();
  Date.now.mockReturnValue(1_000_000 + 30 * 60 * 1000 - 1);
  expect(readCloudAction(path, "account-1")).not.toBeNull();
  Date.now.mockReturnValue(1_000_000 + 30 * 60 * 1000);
  expect(consumeCloudAction(path, "account-1")).toBeNull();
  Date.now.mockReturnValue(999_999);
  expect(readCloudAction(path, "account-1")).toBeNull();
});
it("replaces the previous action with a unique flow and does not let its cancel clear the replacement", () => {
  const previous = start();
  const current = start({ trial: true });
  expect(current).not.toBe(previous);
  expect(readCloudAction(previous, "account-1")).toBeNull();
  clearCloudAction(previous);
  clearCloudAction(undefined);
  expect(readCloudAction(current, "account-1")).not.toBeNull();
  clearCloudAction(current);
  expect(readCloudAction(current, "account-1")).toBeNull();
});
it("keeps a usable one-shot action in memory when browser storage is disabled", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage disabled"); });
  const path = start({ userId: "account-1" });
  expect(consumeCloudAction(path, "account-1")).not.toBeNull();
  expect(consumeCloudAction(path, "account-1")).toBeNull();
});
it("shadows a stored action if deletion fails so it cannot execute twice", () => {
  const path = start({ userId: "account-1" });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("storage disabled"); });
  expect(consumeCloudAction(path, "account-1")).not.toBeNull();
  expect(consumeCloudAction(path, "account-1")).toBeNull();
});
it("does not resurrect a stored action removed by an external session cleanup", () => {
  const path = start({ userId: "account-1" });
  sessionStorage.removeItem("tt.cloud.action");
  expect(consumeCloudAction(path, "account-1")).toBeNull();
});
it("treats malformed storage as unusable rather than authorizing its URL", () => {
  const path = start({ userId: "account-1" });
  sessionStorage.setItem("tt.cloud.action", "invalid JSON");
  expect(readCloudAction(path, "account-1")).toBeNull();
});
it("preserves an explicit order resume without authorizing a new trial or purchase", () => {
  const path = startOrder();
  const params = new URLSearchParams(path.split("?")[1]);
  expect(params.get("order")).toBe(orderId);
  expect(params.get("flow")).toMatch(/^[0-9a-f-]{36}$/);
  expect(params.has("sku")).toBe(false);
  expect(params.has("intent")).toBe(false);
  expect(readCloudAction(path, "account-1")).toMatchObject({ orderId, sku: null, trial: false, ownerId: "account-1", backend: config.backend });
  expect(consumeCloudAction(path, "account-1")).toMatchObject({ orderId });
  expect(consumeCloudAction(path, "account-1")).toBeNull();
});
it("resumes a guest's selected order only after sign-in and only for its exact URL", () => {
  const path = startOrder({ userId: undefined });
  expect(consumeCloudAction(path)).toBeNull();
  expect(consumeCloudAction(path.replace(orderId, "22222222-2222-4222-8222-222222222222"), "account-1")).toBeNull();
  expect(consumeCloudAction(path + "&success=1", "account-1")).toBeNull();
  expect(consumeCloudAction(path, "account-1")).toMatchObject({ orderId, ownerId: null });
});
it.each([undefined, null, "", "not-an-order", "11111111-1111-7111-8111-111111111111", `${orderId} `])(
  "rejects invalid order ID %s without replacing an existing action", (invalid) => {
    const path = start({ userId: "account-1" });
    expect(() => beginCloudOrderAction({ orderId: invalid, userId: "account-1" })).toThrow("invalid_cloud_action_order");
    expect(readCloudAction(path, "account-1")).not.toBeNull();
  },
);
it("keeps order resume scoped to its owner, backend, and expiration", () => {
  const path = startOrder();
  expect(consumeCloudAction(path, "account-2")).toBeNull();
  config.backend = "https://instance-b.example";
  expect(consumeCloudAction(path, "account-1")).toBeNull();
  config.backend = "https://instance-a.example";
  Date.now.mockReturnValue(1_000_000 + 30 * 60 * 1000);
  expect(consumeCloudAction(path, "account-1")).toBeNull();
});
it.each([
  { trial: true },
  { sku: "cloud_usd_yearly" },
  { orderId: "invalid" },
  { orderId: undefined },
  { sku: undefined },
])("rejects malformed or mixed order action fields %j", (fields) => {
  const path = startOrder();
  const record = JSON.parse(sessionStorage.getItem("tt.cloud.action"));
  sessionStorage.setItem("tt.cloud.action", JSON.stringify({ ...record, ...fields }));
  expect(consumeCloudAction(path, "account-1")).toBeNull();
});
it("replaces purchase intent with order resume and prevents the previous cancel from clearing it", () => {
  const previous = start({ userId: "account-1" });
  const path = startOrder();
  clearCloudAction(previous);
  expect(readCloudAction(previous, "account-1")).toBeNull();
  expect(readCloudAction(path, "account-1")).toMatchObject({ orderId });
});
