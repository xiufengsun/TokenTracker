import { describe, expect, it, vi } from "vitest";
import { functionUrlFor, fetchFunctionResponse } from "./function-url";

const api = "https://srctyff5.us-east.insforge.app";
const direct = "https://srctyff5.function2.insforge.app";

describe("function transport parity", () => {
  it("browser and CLI send credentials to the same verified deployment only", () => {
    for (const base of [api, `${api}/`, "http://localhost:7130", "https://custom.example/api", "https://other123.us-east.insforge.app", `${api}/other`, `${api}.evil.example`, "https://user@srctyff5.us-east.insforge.app"]) {
      const root = base.replace(/\/$/, "");
      expect(functionUrlFor(base, "tokentracker-ingest")).toBe(root === api
        ? `${direct}/tokentracker-ingest` : `${root}/functions/tokentracker-ingest`);
    }
    expect(functionUrlFor(api, "tokentracker-ingest")).toBe(`${direct}/tokentracker-ingest`);
  });

  it("an explicit direct GET 404 preserves headers and query on its one legacy fallback", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("missing", { status: 404 })).mockResolvedValueOnce(new Response("{}"));
    const init = { headers: { Authorization: "Bearer fixture" }, cache: "no-store" as RequestCache };
    await fetchFunctionResponse(`${direct}/tokentracker-account-summary?from=today`, init, fetch);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${direct}/tokentracker-account-summary?from=today`, `${api}/functions/tokentracker-account-summary?from=today`]);
    expect(fetch.mock.calls[1][1]).toBe(init);
  });

  it("a POST 404 or ambiguous network failure cannot submit the body twice", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    await fetchFunctionResponse(`${direct}/tokentracker-device-token-issue`, { method: "POST", body: "{}" }, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    const failing = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(fetchFunctionResponse(`${direct}/tokentracker-ingest`, { method: "POST" }, failing)).rejects.toThrow("timeout");
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
