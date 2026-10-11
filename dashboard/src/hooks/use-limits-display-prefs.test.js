import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMIT_PROVIDER_IDS } from "../lib/limits-providers.js";
import {
  isDevinProviderSelected,
  isLimitsPrefsStorageKey,
  LIMIT_DISPLAY_MODES,
  LIMITS_PREFS_CHANGED_EVENT,
  useLimitsDisplayPrefs,
} from "./use-limits-display-prefs.js";

const DISPLAY_MODE_KEY = "tt.limits.displayMode";
const ORDER_KEY = "tt.limits.providerOrder";
const VISIBILITY_KEY = "tt.limits.providerVisibility";
const SHOW_SUBSCRIPTIONS_KEY = "tt.limits.showSubscriptions";
const UPDATED_AT_KEY = "tt.limits.updatedAt";

// Devin is the opt-in provider: it defaults OFF because its selection is also
// the consent flag the local API requires before reading CLI credentials.
function defaultVisibility() {
  return Object.fromEntries(
    LIMIT_PROVIDER_IDS.map((id) => [id, id !== "devin"]),
  );
}

function defaultSnapshot(updatedAt = null) {
  return {
    displayMode: LIMIT_DISPLAY_MODES.USED,
    providerOrder: [...LIMIT_PROVIDER_IDS],
    providerVisibility: defaultVisibility(),
    showSubscriptions: true,
    updatedAt,
  };
}

function installNativeBridge() {
  const messages = [];
  window.webkit = {
    messageHandlers: {
      nativeBridge: {
        postMessage(message) {
          messages.push(message);
        },
      },
    },
  };
  return messages;
}

function setStoredSnapshot(snapshot) {
  if (snapshot.providerOrder) {
    window.localStorage.setItem(
      ORDER_KEY,
      JSON.stringify(snapshot.providerOrder),
    );
  }
  if (snapshot.providerVisibility) {
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify(snapshot.providerVisibility),
    );
  }
  if (snapshot.displayMode) {
    window.localStorage.setItem(DISPLAY_MODE_KEY, snapshot.displayMode);
  }
  if (Object.hasOwn(snapshot, "showSubscriptions")) {
    window.localStorage.setItem(
      SHOW_SUBSCRIPTIONS_KEY,
      JSON.stringify(snapshot.showSubscriptions),
    );
  }
  if (Object.hasOwn(snapshot, "updatedAt")) {
    if (snapshot.updatedAt === null || snapshot.updatedAt === undefined) {
      window.localStorage.removeItem(UPDATED_AT_KEY);
    } else {
      window.localStorage.setItem(UPDATED_AT_KEY, String(snapshot.updatedAt));
    }
  }
}

function readStoredSnapshot() {
  return {
    displayMode: window.localStorage.getItem(DISPLAY_MODE_KEY),
    providerOrder: JSON.parse(window.localStorage.getItem(ORDER_KEY)),
    providerVisibility: JSON.parse(window.localStorage.getItem(VISIBILITY_KEY)),
    showSubscriptions: JSON.parse(window.localStorage.getItem(SHOW_SUBSCRIPTIONS_KEY)),
    updatedAt: window.localStorage.getItem(UPDATED_AT_KEY),
  };
}

function bridgeWrites(messages) {
  return messages.filter(
    (message) =>
      message.type === "setSetting" && message.key === "limitsPreferences",
  );
}

describe("useLimitsDisplayPrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    delete window.webkit;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    delete window.webkit;
  });

  it("exports the two-mode constant used across panel and settings", () => {
    expect(LIMIT_DISPLAY_MODES.USED).toBe("used");
    expect(LIMIT_DISPLAY_MODES.REMAINING).toBe("remaining");
    expect(Object.values(LIMIT_DISPLAY_MODES)).toEqual(["used", "remaining"]);
  });

  it("matches the provider list used for visibility/order keys", () => {
    expect([...LIMIT_PROVIDER_IDS].sort()).toEqual(
      [
        "agentPlan",
        "antigravity",
        "claude",
        "codex",
        "codingPlan",
        "commandCode",
        "copilot",
        "cursor",
        "devin",
        "gemini",
        "grok",
        "kimi",
        "kiro",
        "opencodeGo",
        "qoder",
        "qoderCn",
        "zcode",
      ].sort(),
    );
  });

  it("reads and normalizes the existing localStorage keys", () => {
    window.localStorage.setItem(
      ORDER_KEY,
      JSON.stringify(["gemini", "unknown", "claude", "gemini"]),
    );
    window.localStorage.setItem(
      VISIBILITY_KEY,
      JSON.stringify({ claude: false, unknown: false }),
    );
    window.localStorage.setItem(DISPLAY_MODE_KEY, LIMIT_DISPLAY_MODES.REMAINING);
    window.localStorage.setItem(UPDATED_AT_KEY, "42");

    const { result } = renderHook(() => useLimitsDisplayPrefs());

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order).toEqual([
      "gemini",
      "claude",
      ...LIMIT_PROVIDER_IDS.filter((id) => id !== "gemini" && id !== "claude"),
    ]);
    expect(result.current.visibility).toEqual({
      ...defaultVisibility(),
      claude: false,
    });
  });

  it("falls back to used mode when localStorage holds an unknown value", () => {
    window.localStorage.setItem(DISPLAY_MODE_KEY, "garbage");
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
  });

  it("writes the existing keys plus updatedAt without a native bridge", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { result } = renderHook(() => useLimitsDisplayPrefs());

    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
    });

    expect(readStoredSnapshot()).toEqual({
      ...defaultSnapshot("1000"),
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
    });
  });

  it("enables or disables all providers in one snapshot without changing other preferences", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const messages = installNativeBridge();
    const initial = {
      ...defaultSnapshot(100),
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: [...LIMIT_PROVIDER_IDS].reverse(),
      showSubscriptions: false,
    };
    setStoredSnapshot(initial);
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    for (const visible of [false, true]) {
      act(() => result.current.setAllVisible(visible));
      const expectedVisibility = Object.fromEntries(LIMIT_PROVIDER_IDS.map((id) => [id, visible]));
      expect(result.current.visibility).toEqual(expectedVisibility);
      expect(readStoredSnapshot().providerVisibility).toEqual(expectedVisibility);
      expect(result.current.order).toEqual(initial.providerOrder);
      expect(result.current.displayMode).toBe(initial.displayMode);
      expect(result.current.showSubscriptions).toBe(false);
      expect(bridgeWrites(messages)).toHaveLength(1);
      expect(bridgeWrites(messages)[0].value.providerVisibility).toEqual(expectedVisibility);
      messages.length = 0;
      act(() => result.current.setAllVisible(visible));
      expect(bridgeWrites(messages)).toHaveLength(0);
    }
  });

  it("warns when localStorage cannot persist a Dashboard change", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());

    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(warn).toHaveBeenCalledWith(
      "[tokentracker] limits preferences localStorage write failed:",
      expect.any(Error),
    );
  });

  it("sends full limitsPreferences snapshots for Dashboard display, visibility, and order changes", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const messages = installNativeBridge();
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
    });
    expect(bridgeWrites(messages).at(-1).value).toEqual({
      ...defaultSnapshot(1000),
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
    });

    act(() => {
      result.current.toggle("claude");
    });
    expect(bridgeWrites(messages).at(-1).value).toEqual({
      ...defaultSnapshot(1001),
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerVisibility: {
        ...defaultVisibility(),
        claude: false,
      },
    });

    act(() => {
      result.current.moveDown("claude");
    });
    expect(bridgeWrites(messages).at(-1).value).toEqual({
      ...defaultSnapshot(1002),
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: [
        "codex",
        "claude",
        ...LIMIT_PROVIDER_IDS.slice(2),
      ],
      providerVisibility: {
        ...defaultVisibility(),
        claude: false,
      },
    });
  });

  it("reset sends one full snapshot when it actually changes preferences", () => {
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const messages = installNativeBridge();
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: ["gemini", ...LIMIT_PROVIDER_IDS],
      providerVisibility: { claude: false },
      updatedAt: 100,
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      result.current.reset();
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
    expect(result.current.order).toEqual(LIMIT_PROVIDER_IDS);
    expect(result.current.visibility).toEqual(defaultVisibility());
    expect(bridgeWrites(messages)).toHaveLength(1);
    expect(bridgeWrites(messages)[0].value).toEqual(defaultSnapshot(2000));
  });

  it("applies newer native limitsPreferences snapshots and preserves their updatedAt", () => {
    vi.spyOn(Date, "now").mockReturnValue(9999);
    const messages = installNativeBridge();
    setStoredSnapshot({
      ...defaultSnapshot(10),
      updatedAt: 10,
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              displayMode: LIMIT_DISPLAY_MODES.REMAINING,
              providerOrder: ["gemini", "claude"],
              providerVisibility: { claude: false, unknown: false },
              updatedAt: 20,
            },
          },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order).toEqual([
      "gemini",
      "claude",
      ...LIMIT_PROVIDER_IDS.filter((id) => id !== "gemini" && id !== "claude"),
    ]);
    expect(result.current.visibility).toEqual({
      ...defaultVisibility(),
      claude: false,
    });
    expect(readStoredSnapshot()).toEqual({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: [
        "gemini",
        "claude",
        ...LIMIT_PROVIDER_IDS.filter(
          (id) => id !== "gemini" && id !== "claude",
        ),
      ],
      providerVisibility: {
        ...defaultVisibility(),
        claude: false,
      },
      showSubscriptions: true,
      updatedAt: "20",
    });
    expect(bridgeWrites(messages)).toHaveLength(0);
  });

  it("applies native custom limitsPreferences without updatedAt when Dashboard storage is empty", () => {
    const messages = installNativeBridge();
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              providerOrder: ["gemini", "claude"],
              providerVisibility: { claude: false, unknown: false },
            },
          },
        }),
      );
    });

    const providerOrder = [
      "gemini",
      "claude",
      ...LIMIT_PROVIDER_IDS.filter((id) => id !== "gemini" && id !== "claude"),
    ];
    const providerVisibility = {
      ...defaultVisibility(),
      claude: false,
    };
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
    expect(result.current.order).toEqual(providerOrder);
    expect(result.current.visibility).toEqual(providerVisibility);
    expect(readStoredSnapshot()).toEqual({
      displayMode: LIMIT_DISPLAY_MODES.USED,
      providerOrder,
      providerVisibility,
      showSubscriptions: true,
      updatedAt: null,
    });
    expect(bridgeWrites(messages)).toHaveLength(0);
  });

  it("does not write back when native limitsPreferences already matches Dashboard", () => {
    const messages = installNativeBridge();
    const providerOrder = [
      "codex",
      "claude",
      ...LIMIT_PROVIDER_IDS.filter((id) => id !== "codex" && id !== "claude"),
    ];
    const providerVisibility = {
      ...defaultVisibility(),
      claude: false,
    };
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder,
      providerVisibility,
      updatedAt: 80,
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              displayMode: LIMIT_DISPLAY_MODES.REMAINING,
              providerOrder,
              providerVisibility,
              updatedAt: 80,
            },
          },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order).toEqual(providerOrder);
    expect(result.current.visibility).toEqual(providerVisibility);
    expect(bridgeWrites(messages)).toHaveLength(0);
  });

  it("keeps the Dashboard snapshot when it is newer than native", () => {
    const messages = installNativeBridge();
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: ["codex", "claude"],
      providerVisibility: { claude: false },
      updatedAt: 50,
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              displayMode: LIMIT_DISPLAY_MODES.USED,
              providerOrder: ["gemini", "claude"],
              providerVisibility: { claude: true },
              updatedAt: 40,
            },
          },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order.slice(0, 2)).toEqual(["codex", "claude"]);
    expect(result.current.visibility.claude).toBe(false);
    expect(bridgeWrites(messages)).toHaveLength(1);
    expect(bridgeWrites(messages)[0].value).toMatchObject({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      updatedAt: 50,
    });
  });

  it("lets Dashboard win when a local key exists and both sides have no updatedAt", () => {
    const messages = installNativeBridge();
    window.localStorage.setItem(DISPLAY_MODE_KEY, LIMIT_DISPLAY_MODES.REMAINING);
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              displayMode: LIMIT_DISPLAY_MODES.USED,
              providerOrder: ["gemini", "claude"],
              providerVisibility: { claude: true },
            },
          },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order).toEqual(LIMIT_PROVIDER_IDS);
    expect(result.current.visibility).toEqual(defaultVisibility());
    expect(bridgeWrites(messages)).toHaveLength(1);
    expect(bridgeWrites(messages)[0].value).toEqual({
      ...defaultSnapshot(null),
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
    });
  });

  it("lets Dashboard win when a local key exists and both sides have the same updatedAt", () => {
    const messages = installNativeBridge();
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: ["codex", "claude"],
      providerVisibility: { claude: false },
      updatedAt: 60,
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              displayMode: LIMIT_DISPLAY_MODES.USED,
              providerOrder: ["gemini", "claude"],
              providerVisibility: { claude: true },
              updatedAt: 60,
            },
          },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order.slice(0, 2)).toEqual(["codex", "claude"]);
    expect(result.current.visibility.claude).toBe(false);
    expect(bridgeWrites(messages)).toHaveLength(1);
    expect(bridgeWrites(messages)[0].value.updatedAt).toBe(60);
  });

  it("treats an invalid local key as Dashboard opinion and normalizes through fallback", () => {
    const messages = installNativeBridge();
    window.localStorage.setItem(ORDER_KEY, "{");
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              displayMode: LIMIT_DISPLAY_MODES.REMAINING,
              providerOrder: ["gemini", "claude"],
              providerVisibility: { claude: false },
            },
          },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
    expect(result.current.order).toEqual(LIMIT_PROVIDER_IDS);
    expect(result.current.visibility).toEqual(defaultVisibility());
    expect(bridgeWrites(messages)).toHaveLength(1);
    expect(bridgeWrites(messages)[0].value).toEqual(defaultSnapshot(null));
    expect(window.localStorage.getItem(ORDER_KEY)).toBe("{");
  });

  it("uses local updatedAt + 1 when the clock moves backward", () => {
    vi.spyOn(Date, "now").mockReturnValue(4000);
    setStoredSnapshot({ ...defaultSnapshot(5000), updatedAt: 5000 });
    const { result } = renderHook(() => useLimitsDisplayPrefs());

    act(() => {
      result.current.toggle("claude");
    });

    expect(window.localStorage.getItem(UPDATED_AT_KEY)).toBe("5001");
  });

  it("uses in-memory updatedAt when localStorage no longer has it", () => {
    vi.spyOn(Date, "now").mockReturnValue(4000);
    setStoredSnapshot({ ...defaultSnapshot(5000), updatedAt: 5000 });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    window.localStorage.removeItem(UPDATED_AT_KEY);

    act(() => {
      result.current.toggle("claude");
    });

    expect(window.localStorage.getItem(UPDATED_AT_KEY)).toBe("5001");
  });

  it("treats invalid updatedAt values as missing", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    window.localStorage.setItem(UPDATED_AT_KEY, "not-a-number");
    const { result } = renderHook(() => useLimitsDisplayPrefs());

    act(() => {
      result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
    });

    expect(window.localStorage.getItem(UPDATED_AT_KEY)).toBe("1234");
  });

  it("treats fractional and unsafe updatedAt values as missing", () => {
    vi.spyOn(Date, "now").mockReturnValue(40);
    for (const updatedAt of ["42.5", String(Number.MAX_SAFE_INTEGER + 1)]) {
      window.localStorage.clear();
      window.localStorage.setItem(UPDATED_AT_KEY, updatedAt);
      const { result, unmount } = renderHook(() => useLimitsDisplayPrefs());

      act(() => {
        result.current.setDisplayMode(LIMIT_DISPLAY_MODES.REMAINING);
      });

      expect(window.localStorage.getItem(UPDATED_AT_KEY)).toBe("40");
      unmount();
    }
  });

  it("treats non-number bridged updatedAt values as missing", () => {
    for (const updatedAt of [true, [], {}]) {
      window.localStorage.clear();
      const messages = installNativeBridge();
      setStoredSnapshot({
        displayMode: LIMIT_DISPLAY_MODES.REMAINING,
        providerOrder: ["codex", "claude"],
        providerVisibility: { claude: false },
        updatedAt: null,
      });
      const { result, unmount } = renderHook(() => useLimitsDisplayPrefs());
      messages.length = 0;

      act(() => {
        window.dispatchEvent(
          new CustomEvent("native:settings", {
            detail: {
              limitsPreferences: {
                displayMode: LIMIT_DISPLAY_MODES.USED,
                providerOrder: ["gemini", "claude"],
                providerVisibility: { claude: true },
                updatedAt,
              },
            },
          }),
        );
      });

      expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
      expect(result.current.order.slice(0, 2)).toEqual(["codex", "claude"]);
      expect(result.current.visibility.claude).toBe(false);
      expect(bridgeWrites(messages)).toHaveLength(1);
      expect(bridgeWrites(messages)[0].value.updatedAt).toBeNull();
      unmount();
    }
  });

  it("re-reads Dashboard localStorage before resolving a delayed native push", () => {
    const messages = installNativeBridge();
    setStoredSnapshot({ ...defaultSnapshot(10), updatedAt: 10 });
    renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: ["codex", "claude"],
      providerVisibility: { claude: false },
      updatedAt: 30,
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: {
            limitsPreferences: {
              ...defaultSnapshot(20),
              updatedAt: 20,
            },
          },
        }),
      );
    });

    expect(bridgeWrites(messages)).toHaveLength(1);
    expect(bridgeWrites(messages)[0].value).toMatchObject({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      updatedAt: 30,
    });
  });

  it("bases Dashboard user changes on a newer localStorage snapshot", () => {
    vi.spyOn(Date, "now").mockReturnValue(20);
    const messages = installNativeBridge();
    setStoredSnapshot({ ...defaultSnapshot(10), updatedAt: 10 });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: ["gemini", "claude"],
      providerVisibility: { claude: false },
      updatedAt: 30,
    });

    act(() => {
      result.current.toggle("gemini");
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order.slice(0, 2)).toEqual(["gemini", "claude"]);
    expect(result.current.visibility).toEqual({
      ...defaultVisibility(),
      claude: false,
      gemini: false,
    });
    expect(readStoredSnapshot()).toMatchObject({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      updatedAt: "31",
    });
    expect(bridgeWrites(messages)).toHaveLength(1);
    expect(bridgeWrites(messages)[0].value).toMatchObject({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: [
        "gemini",
        "claude",
        ...LIMIT_PROVIDER_IDS.filter(
          (id) => id !== "gemini" && id !== "claude",
        ),
      ],
      providerVisibility: {
        ...defaultVisibility(),
        claude: false,
        gemini: false,
      },
      updatedAt: 31,
    });
  });

  it("updates from storage events on all four preference keys without bridge writeback", () => {
    const messages = installNativeBridge();
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: ["gemini", "claude"],
      providerVisibility: { gemini: false },
      updatedAt: 70,
    });

    for (const key of [
      ORDER_KEY,
      VISIBILITY_KEY,
      DISPLAY_MODE_KEY,
      SHOW_SUBSCRIPTIONS_KEY,
      UPDATED_AT_KEY,
    ]) {
      act(() => {
        window.dispatchEvent(new StorageEvent("storage", { key }));
      });
    }

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(result.current.order.slice(0, 2)).toEqual(["gemini", "claude"]);
    expect(result.current.visibility.gemini).toBe(false);
    expect(bridgeWrites(messages)).toHaveLength(0);
  });

  it("handles storage clear events without bridge writeback", () => {
    const messages = installNativeBridge();
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.REMAINING,
      providerOrder: ["gemini", "claude"],
      providerVisibility: { gemini: false },
      updatedAt: 70,
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
    expect(result.current.order).toEqual(LIMIT_PROVIDER_IDS);
    expect(result.current.visibility).toEqual(defaultVisibility());
    expect(bridgeWrites(messages)).toHaveLength(0);
  });

  it("applies old limitsDisplayMode payloads when Dashboard has no updatedAt", () => {
    const messages = installNativeBridge();
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: { limitsDisplayMode: LIMIT_DISPLAY_MODES.REMAINING },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.REMAINING);
    expect(window.localStorage.getItem(DISPLAY_MODE_KEY)).toBe(
      LIMIT_DISPLAY_MODES.REMAINING,
    );
    expect(window.localStorage.getItem(UPDATED_AT_KEY)).toBeNull();
    expect(bridgeWrites(messages)).toHaveLength(0);
  });

  it("ignores old limitsDisplayMode payloads when Dashboard already has updatedAt", () => {
    const messages = installNativeBridge();
    setStoredSnapshot({
      displayMode: LIMIT_DISPLAY_MODES.USED,
      providerOrder: ["codex", "claude"],
      providerVisibility: { claude: false },
      updatedAt: 5000,
    });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    messages.length = 0;

    act(() => {
      window.dispatchEvent(
        new CustomEvent("native:settings", {
          detail: { limitsDisplayMode: LIMIT_DISPLAY_MODES.REMAINING },
        }),
      );
    });

    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
    expect(result.current.order.slice(0, 2)).toEqual(["codex", "claude"]);
    expect(result.current.visibility.claude).toBe(false);
    expect(window.localStorage.getItem(DISPLAY_MODE_KEY)).toBe(
      LIMIT_DISPLAY_MODES.USED,
    );
    expect(window.localStorage.getItem(UPDATED_AT_KEY)).toBe("5000");
    expect(bridgeWrites(messages)).toHaveLength(0);
  });

  it("ignores storage events on unrelated keys", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "some.other.key", newValue: "x" }),
      );
    });
    expect(result.current.displayMode).toBe(LIMIT_DISPLAY_MODES.USED);
  });
});

describe("Devin opt-in selection", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    delete window.webkit;
  });

  afterEach(() => {
    window.history.pushState({}, "", "/");
    delete window.webkit;
  });

  it("defaults Devin off while every other provider stays on", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.visibility.devin).toBe(false);
    for (const id of LIMIT_PROVIDER_IDS) {
      if (id === "devin") continue;
      expect(result.current.visibility[id]).toBe(true, `${id} must stay on`);
    }
    expect(isDevinProviderSelected()).toBe(false);
  });

  it("treats a stored devin:true as the explicit selection and keeps it across normalize", () => {
    setStoredSnapshot({ providerVisibility: { devin: true } });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(result.current.visibility.devin).toBe(true);
    expect(isDevinProviderSelected()).toBe(true);
  });

  it("treats default-filled devin values as not selected", () => {
    // A snapshot persisted before the selection mattered — devin present but
    // non-boolean, or a claude-only map — must not read as consent.
    for (const stored of [{ devin: "true" }, { claude: true }]) {
      window.localStorage.clear();
      setStoredSnapshot({ providerVisibility: stored });
      expect(isDevinProviderSelected()).toBe(false);
    }
  });

  it("reset leaves Devin off", () => {
    setStoredSnapshot({ providerVisibility: { devin: true } });
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    expect(isDevinProviderSelected()).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.visibility.devin).toBe(false);
    expect(isDevinProviderSelected()).toBe(false);
  });

  it("dispatches the prefs-changed event so same-window consumers re-read the selection", () => {
    const { result } = renderHook(() => useLimitsDisplayPrefs());
    const seen = [];
    window.addEventListener(LIMITS_PREFS_CHANGED_EVENT, () => seen.push(1));

    act(() => {
      result.current.toggle("devin");
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(isDevinProviderSelected()).toBe(true);
    expect(isLimitsPrefsStorageKey(VISIBILITY_KEY)).toBe(true);
    expect(isLimitsPrefsStorageKey("unrelated")).toBe(false);
    expect(isLimitsPrefsStorageKey(null)).toBe(true);
  });
});
