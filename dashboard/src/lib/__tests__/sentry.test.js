import { describe, expect, it } from "vitest";
import { isBenignBrowserNetworkNoise, scrubEvent } from "../sentry.js";

describe("dashboard sentry scrubEvent", () => {
  it("redacts secrets and strips user PII fields", () => {
    const scrubbed = scrubEvent({
      message: "Bearer abcdefghijklmnop",
      extra: { refresh_token: "xyz", safe: 1 },
      user: { id: "u1", email: "x@y.z" },
    });
    expect(scrubbed.message).toMatch(/Bearer \[Filtered\]/);
    expect(scrubbed.extra.refresh_token).toBe("[Filtered]");
    expect(scrubbed.extra.safe).toBe(1);
    expect(scrubbed.user).toEqual({ id: "u1" });
  });
});

describe("dashboard sentry isBenignBrowserNetworkNoise", () => {
  it("drops Safari empty-stack Load failed unhandledrejection noise", () => {
    expect(
      isBenignBrowserNetworkNoise({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Load failed",
              mechanism: { type: "auto.browser.global_handlers.onunhandledrejection" },
              stacktrace: { frames: [] },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("drops Cancelled / NetworkError / Failed to fetch when there are no frames", () => {
    for (const value of [
      "Cancelled",
      "canceled",
      "AbortError",
      "The user aborted a request.",
      "NetworkError when attempting to fetch resource.",
      "Failed to fetch",
    ]) {
      expect(
        isBenignBrowserNetworkNoise({
          exception: {
            values: [{
              type: "TypeError",
              value,
              mechanism: { type: "onunhandledrejection" },
            }],
          },
        }),
      ).toBe(true);
    }
  });

  it("keeps the same messages when a stack is present", () => {
    expect(
      isBenignBrowserNetworkNoise({
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Failed to fetch",
              stacktrace: {
                frames: [{ filename: "app.js", function: "loadLeaderboard", lineno: 12 }],
              },
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("keeps message-only captures and non-browser exception types", () => {
    expect(isBenignBrowserNetworkNoise({ message: "Load failed" })).toBe(false);
    expect(
      isBenignBrowserNetworkNoise({
        exception: {
          values: [{
            type: "ApplicationError",
            value: "Cancelled",
            mechanism: { handled: true, type: "generic" },
          }],
        },
      }),
    ).toBe(false);
  });

  it("keeps unrelated application errors", () => {
    expect(
      isBenignBrowserNetworkNoise({
        exception: {
          values: [{ type: "TypeError", value: "Cannot read properties of null" }],
        },
      }),
    ).toBe(false);
    expect(isBenignBrowserNetworkNoise(null)).toBe(false);
  });
});
