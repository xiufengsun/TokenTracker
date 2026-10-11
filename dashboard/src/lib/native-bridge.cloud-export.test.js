import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveCloudUsageExport } from "./native-bridge.js";

const payload = { filename: "tokentracker-cloud-usage-2026-10-10.csv", content: "date,tokens\n2026-10-10,4\n", format: "csv" };
const acknowledge = (detail) => window.dispatchEvent(new CustomEvent("tokentracker:cloud-export-result", { detail }));

describe("saveCloudUsageExport IPC", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.__TOKENTRACKER_CLOUD_EXPORT__ = true;
  });
  afterEach(() => {
    delete window.webkit;
    delete window.chrome;
    delete window.__TAURI_INTERNALS__;
    delete window.__TOKENTRACKER_CLOUD_EXPORT__;
    window.localStorage.clear();
    vi.useRealTimers();
  });
  const mac = (handler) => { window.webkit = { messageHandlers: { nativeBridge: { postMessage: handler } } }; };

  it("returns null only for an ordinary browser", async () => {
    expect(await saveCloudUsageExport(payload)).toBeNull();
    window.localStorage.setItem("tokentracker_native_app", "1");
    await expect(saveCloudUsageExport(payload)).rejects.toMatchObject({ code: "unsupported" });
  });
  it("rejects a detected old host without this capability", async () => {
    const post = vi.fn(); mac(post);
    delete window.__TOKENTRACKER_CLOUD_EXPORT__;
    await expect(saveCloudUsageExport(payload)).rejects.toMatchObject({ code: "unsupported" });
    expect(post).not.toHaveBeenCalled();
  });
  it("ignores unrelated acknowledgements and waits for the actual request", async () => {
    let message; mac((value) => { message = value; });
    const pending = saveCloudUsageExport(payload);
    let complete = false; pending.then(() => { complete = true; });
    acknowledge({ requestId: "different", saved: true, filename: payload.filename });
    await Promise.resolve(); expect(complete).toBe(false);
    expect(message).toEqual(expect.objectContaining({ ...payload, type: "saveCloudUsageExport", requestId: expect.any(String) }));
    acknowledge({ requestId: message.requestId, saved: true, filename: "tokentracker-cloud-usage-2026-10-10-1.csv" });
    expect(await pending).toEqual({ saved: true, filename: "tokentracker-cloud-usage-2026-10-10-1.csv" });
  });
  it("serializes Windows requests and receives the same acknowledgement", async () => {
    window.chrome = { webview: { postMessage: (raw) => {
      const message = JSON.parse(raw);
      acknowledge({ requestId: message.requestId, saved: true, filename: message.filename });
    } } };
    window.localStorage.setItem("tokentracker_native_app", "1");
    expect(await saveCloudUsageExport(payload)).toEqual({ saved: true, filename: payload.filename });
  });
  it("checks the correlated Linux command reply", async () => {
    const invoke = vi.fn(async (_command, { message }) => ({ requestId: message.requestId, saved: true, filename: message.filename }));
    window.__TAURI_INTERNALS__ = { invoke };
    expect(await saveCloudUsageExport(payload)).toEqual({ saved: true, filename: payload.filename });
    expect(invoke).toHaveBeenCalledWith("save_cloud_usage_export", { message: expect.objectContaining(payload) });
  });
  it("rejects native failures without exposing raw errors or paths", async () => {
    mac((message) => acknowledge({ requestId: message.requestId, saved: false, errorCode: "/private/raw failure" }));
    await expect(saveCloudUsageExport(payload)).rejects.toMatchObject({ message: "save_failed", code: "save_failed" });
  });
  it("rejects malformed success replies and unsupported payloads", async () => {
    const post = vi.fn((message) => acknowledge({ requestId: message.requestId, saved: true, filename: "/outside.csv" })); mac(post);
    await expect(saveCloudUsageExport(payload)).rejects.toMatchObject({ code: "save_failed" });
    post.mockClear();
    for (const invalid of [{ filename: "../bad.csv" }, { format: "json" }, { content: "a\0b" },
      { content: "字".repeat(Math.floor(5 * 1024 * 1024 / 3) + 1) }]) {
      await expect(saveCloudUsageExport({ ...payload, ...invalid })).rejects.toMatchObject({ code: "invalid_export" });
    }
    expect(post).not.toHaveBeenCalled();
  });
  it("does not dispatch an already canceled request", async () => {
    const post = vi.fn(); mac(post);
    const controller = new AbortController(); controller.abort();
    await expect(saveCloudUsageExport({ ...payload, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(post).not.toHaveBeenCalled();
  });
  it("discards late acknowledgements after cancellation", async () => {
    let message; mac((value) => { message = value; });
    const controller = new AbortController();
    const pending = saveCloudUsageExport({ ...payload, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    acknowledge({ requestId: message.requestId, saved: true, filename: message.filename });
  });
  it("rejects an unresponsive host", async () => {
    vi.useFakeTimers(); mac(vi.fn());
    const rejected = expect(saveCloudUsageExport(payload)).rejects.toMatchObject({ code: "save_timeout" });
    await vi.advanceTimersByTimeAsync(15000); await rejected;
  });
});
