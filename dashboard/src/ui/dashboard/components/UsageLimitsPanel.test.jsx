import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../../../lib/copy";
import { DE_LOCALE, EN_LOCALE, JA_LOCALE, KO_LOCALE, ZH_CN_LOCALE, ZH_TW_LOCALE } from "../../../lib/locale";
import { saveProviderApiKey } from "../../../lib/api";
import { UsageLimitsPanel } from "./UsageLimitsPanel.jsx";

vi.mock("../../../lib/api", () => ({
  saveProviderApiKey: vi.fn(),
}));

function formatExpiry(iso) {
  return new Intl.DateTimeFormat(EN_LOCALE, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function formatAmount(value) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function credit(granted_at, expires_at) {
  return { status: "available", reset_type: "weekly", granted_at, expires_at };
}

let getContextSpy;

beforeEach(() => {
  getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText: (text) => ({ width: String(text).length * 6 }),
  });
  vi.mocked(saveProviderApiKey).mockReset();
  vi.mocked(saveProviderApiKey).mockResolvedValue({
    ok: true,
    configured: true,
    source: "stored",
  });
});

afterEach(() => {
  getContextSpy?.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("UsageLimitsPanel", () => {
  afterEach(() => {
    setCopyLocale(EN_LOCALE);
  });

  it("shows one WorkBuddy row with exact credit amounts on hover and keyboard expansion in Chinese", async () => {
    setCopyLocale(ZH_CN_LOCALE);
    render(<UsageLimitsPanel order={["workbuddy", "workbuddyAi"]}
      displayMode="remaining"
      workbuddy={{ configured: true, plan_label: "Free", primary_window: {
        used_percent: 50.586, used_credits: 252.92999996, limit_credits: 500, remaining_credits: 247.07000004,
      } }}
    />);
    expect(screen.getByRole("button", { name: /^WorkBuddy Free/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^WorkBuddy/ })).toHaveLength(1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("已用 252.93 / 500 点额度 · 剩余 247.07");
    expect(screen.getByText("49%")).toBeInTheDocument();
    expect(screen.queryByText("WorkBuddy AI")).not.toBeInTheDocument();
    expect(screen.queryByText(/体验版/)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: /^WorkBuddy Free/ }), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("已用 252.93 / 500 点额度 · 剩余 247.07")).toBeVisible());
  });

  it("keeps the international English plan name in the single WorkBuddy row", () => {
    render(<UsageLimitsPanel workbuddy={{ configured: true, plan_label: "Pro-Trial", primary_window: { used_percent: 20 } }} />);
    expect(screen.getByRole("button", { name: /^WorkBuddy Pro-Trial/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^WorkBuddy/ })).toHaveLength(1);
  });

  it("keeps Start grants collapsed inside the Pro row and expands them independently", () => {
    render(
      <UsageLimitsPanel
        order={["zcode"]}
        displayMode="remaining"
        zcode={{
          configured: true, plan_label: "Pro", plan_kind: "coding-plan",
          primary_window: { used_percent: 2 },
          secondary_window: { used_percent: 30 },
          tertiary_window: { used_percent: 15 },
          start_plan: {
            configured: true, plan_label: "Start",
            buckets: [{
              label: "GLM-5.3-Flash · ZCode Trust Build", plan_name: "ZCode Trust Build", period: "one_time",
              remaining_units: 100000000, total_units: 100000000,
              window: { used_percent: 0, reset_at: "2030-10-07T16:00:00.000Z" },
            }],
          },
        }}
      />,
    );
    const main = screen.getByRole("button", { name: /^ZCode Pro/ });
    const grants = screen.getByRole("button", { name: "ZCode Trust Build" });
    expect(grants).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("GLM-5.3-Flash · ZCode Trust Build")).not.toBeInTheDocument();
    expect(screen.getByText("98%")).toBeInTheDocument();

    fireEvent.click(grants);
    expect(grants).toHaveAttribute("aria-expanded", "true");
    expect(main).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("GLM-5.3-Flash · ZCode Trust Build")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText(copy("limits.zcode.grant_amount", { remaining: "100,000,000", total: "100,000,000" }))).toBeInTheDocument();
    expect(main.parentElement).toHaveTextContent(copy("limits.hover.expires_at", { time: formatExpiry("2030-10-07T16:00:00.000Z") }));
    fireEvent.click(screen.getByText("GLM-5.3-Flash · ZCode Trust Build"));
    expect(main).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(grants, { key: "Enter" });
    expect(main).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(main);
    expect(main).toHaveAttribute("aria-expanded", "true");
    expect(grants).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(grants);
    expect(main).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("GLM-5.3-Flash · ZCode Trust Build")).not.toBeInTheDocument();
    expect(screen.getByText("98%")).toBeInTheDocument();
  });

  it("shows separate usable 5h and weekly reset counts with their earliest expiries", () => {
    render(<UsageLimitsPanel order={["zcode"]} zcode={{
      configured: true, plan_label: "Pro", plan_kind: "coding-plan",
      primary_window: { used_percent: 2 },
      reset_credits: {
        five_hour: [
          { expires_at: "2030-10-19T10:00:00Z" }, { expires_at: "2030-10-18T10:00:00Z" },
          { expires_at: "2000-01-01T00:00:00Z" },
        ],
        weekly: [{ expires_at: "2030-10-20T09:00:00Z" }],
      },
    }} />);
    // Collapsed: the header shows only the total live-card badge.
    expect(screen.getByText(copy("limits.zcode.reset_bank.title"))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.zcode.reset_bank.count", { count: 3 }))).toBeInTheDocument();
    expect(screen.queryByText(copy("limits.zcode.reset_bank.count", { count: 2 }))).not.toBeInTheDocument();

    // Expanding reveals the per-group counts and earliest expiries.
    fireEvent.click(screen.getByText(copy("limits.zcode.reset_bank.title")));
    expect(screen.getByText(copy("limits.zcode.reset_bank.count", { count: 2 }))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.zcode.reset_bank.count", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.zcode.reset_bank.earliest", {
      time: formatExpiry("2030-10-18T10:00:00Z"),
    }))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.zcode.reset_bank.earliest", {
      time: formatExpiry("2030-10-20T09:00:00Z"),
    }))).toBeInTheDocument();
    expect(screen.getByText("2%")).toBeInTheDocument();
  });

  it("clips reset countdown bars at the fixed 5h and weekly scales", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T00:00:00.000Z"));
    render(<UsageLimitsPanel order={["zcode"]} zcode={{
      configured: true, plan_label: "Pro", plan_kind: "coding-plan",
      primary_window: { used_percent: 2 },
      reset_credits: {
        // 10 days out: beyond the fixed 5h scale, so the fill clips at 100%.
        five_hour: [{ expires_at: "2026-11-07T00:00:00Z" }],
        // 3 of 7 days left: a fractional fill.
        weekly: [{ expires_at: "2026-10-31T00:00:00Z" }],
      },
    }} />);
    fireEvent.click(screen.getByText(copy("limits.zcode.reset_bank.title")));
    const section = screen.getByText(copy("limits.zcode.reset_bank.title")).closest("div");
    const fiveRow = within(section).getByText(copy("limits.label.zcode_5h")).closest("div");
    expect(fiveRow.querySelector("div[style]").style.width).toBe("100%");
    const weeklyRow = within(section).getByText(copy("limits.label.zcode_weekly")).closest("div");
    expect(weeklyRow.querySelector("div[style]").style.width).toContain("42.8571");
  });

  it("batches same-instant reset cards into one time-by-count tooltip entry", () => {
    render(<UsageLimitsPanel order={["zcode"]} zcode={{
      configured: true, plan_label: "Pro", plan_kind: "coding-plan",
      primary_window: { used_percent: 2 },
      reset_credits: {
        five_hour: [
          { expires_at: "2030-10-19T10:00:00Z" }, { expires_at: "2030-10-19T10:00:00Z" },
          { expires_at: "2030-10-18T10:00:00Z" },
        ],
      },
    }} />);
    fireEvent.click(screen.getByText(copy("limits.zcode.reset_bank.title")));
    const batchedTitle = `${formatExpiry("2030-10-18T10:00:00Z")}\n${formatExpiry("2030-10-19T10:00:00Z")} ×2`;
    // Both the bar track and the earliest-expiry label carry the batched tooltip.
    // The default title matcher normalizes the attribute's newline away but not
    // the query string, so match on the raw attribute to keep asserting the
    // newline separator between batches.
    expect(screen.getAllByTitle(batchedTitle, { normalizer: (text) => text })).toHaveLength(2);
  });

  it("keeps reset inventory failures separate from normal Pro quota bars", () => {
    render(<UsageLimitsPanel order={["zcode"]} zcode={{
      configured: true, plan_label: "Pro", plan_kind: "coding-plan",
      primary_window: { used_percent: 2 },
      reset_credits: { error: "Reset status unavailable" },
    }} />);
    expect(screen.getByText("2%")).toBeInTheDocument();
    // The failure stays visible even while the section is collapsed.
    expect(screen.getByText(/Reset status unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(copy("limits.zcode.reset_bank.count", { count: 0 }))).not.toBeInTheDocument();
    // Expanding keeps showing the failure instead of empty group rows.
    fireEvent.click(screen.getByText(copy("limits.zcode.reset_bank.title")));
    expect(screen.getByText(/Reset status unavailable/)).toBeInTheDocument();
    const section = screen.getByText(copy("limits.zcode.reset_bank.title")).closest("div");
    expect(within(section).queryByText(copy("limits.label.zcode_5h"))).not.toBeInTheDocument();
  });

  it("hides the whole reset section when no window has live cards", () => {
    render(<UsageLimitsPanel order={["zcode"]} zcode={{
      configured: true, plan_label: "Pro", plan_kind: "coding-plan",
      primary_window: { used_percent: 2 },
      // An expired card and an empty list are both "spent": neither may
      // resurrect the section the way the Codex reset bank never does.
      reset_credits: {
        five_hour: [{ expires_at: "2000-01-01T00:00:00Z" }],
        weekly: [],
      },
    }} />);
    expect(screen.queryByText(copy("limits.zcode.reset_bank.title"))).not.toBeInTheDocument();
    expect(screen.queryByText(copy("limits.zcode.reset_bank.count", { count: 0 }))).not.toBeInTheDocument();
  });

  it("drops zero-count reset rows while keeping the window that still has cards", () => {
    render(<UsageLimitsPanel order={["zcode"]} zcode={{
      configured: true, plan_label: "Pro", plan_kind: "coding-plan",
      primary_window: { used_percent: 2 },
      reset_credits: {
        five_hour: [],
        weekly: [{ expires_at: "2030-10-20T09:00:00Z" }],
      },
    }} />);
    // The collapsed badge counts only the window that still has cards.
    expect(screen.getByText(copy("limits.zcode.reset_bank.count", { count: 1 }))).toBeInTheDocument();
    fireEvent.click(screen.getByText(copy("limits.zcode.reset_bank.title")));
    const section = screen.getByText(copy("limits.zcode.reset_bank.title")).closest("div");
    expect(within(section).queryByText(copy("limits.label.zcode_5h"))).not.toBeInTheDocument();
    expect(within(section).getByText(copy("limits.label.zcode_weekly"))).toBeInTheDocument();
    expect(within(section).getByText(copy("limits.zcode.reset_bank.earliest", {
      time: formatExpiry("2030-10-20T09:00:00Z"),
    }))).toBeInTheDocument();
  });

  it("lets the no-data placeholder through when the reset bank is spent", () => {
    render(<UsageLimitsPanel order={["zcode"]} zcode={{
      configured: true, plan_label: "Pro", plan_kind: "coding-plan",
      reset_credits: { five_hour: [], weekly: [] },
    }} />);
    // A spent bank must hand LimitWindowSection a real null: a truthy element
    // that renders nothing would suppress the placeholder and blank the body.
    expect(screen.getByText(copy("limits.status.no_data"))).toBeInTheDocument();
    expect(screen.queryByText(copy("limits.zcode.reset_bank.title"))).not.toBeInTheDocument();
  });

  it("shows provider status rows instead of hiding configured providers with errors", () => {
    render(
      <UsageLimitsPanel
        claude={{ configured: true, error: "Claude API returned 403" }}
        codex={{ configured: false }}
        cursor={{
          configured: true,
          error: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["claude", "codex", "cursor"]}
      />,
    );

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText(/Claude API returned 403/)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
  });

  it("renders Claude model-scoped weekly windows with their server-provided labels", () => {
    render(
      <UsageLimitsPanel
        claude={{
          configured: true,
          error: null,
          five_hour: { utilization: 42, resets_at: "2026-07-02T05:29:59.000Z" },
          seven_day: { utilization: 5, resets_at: "2026-07-05T14:59:59.000Z" },
          seven_day_opus: null,
          weekly_scoped: [
            { label: "Fable", utilization: 8, resets_at: "2026-07-05T14:59:59.000Z" },
          ],
        }}
        order={["claude"]}
      />,
    );

    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Fable")).toBeInTheDocument();
    expect(screen.getByText("8%")).toBeInTheDocument();
  });

  it("renders Kimi quota windows and not-connected state", () => {
    const { rerender } = render(
      <UsageLimitsPanel
        kimi={{
          configured: true,
          error: null,
          parallel_limit: 20,
          primary_window: { used_percent: 64, reset_at: "2026-05-04T06:02:56.054Z" },
          secondary_window: { used_percent: 4, reset_at: "2026-05-02T05:02:56.054Z" },
          tertiary_window: { used_percent: 1, reset_at: null },
        }}
        order={["kimi"]}
      />,
    );

    expect(screen.getByText("Kimi")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Parallel: 20")).toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
    expect(screen.getByText("4%")).toBeInTheDocument();
    expect(screen.getByText("1%")).toBeInTheDocument();

    rerender(<UsageLimitsPanel kimi={{ configured: false }} order={["kimi"]} />);

    expect(screen.getByText("Kimi")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("shows Kiro credits observed from local usage_summary records", () => {
    const { rerender } = render(
      <UsageLimitsPanel
        kiro={{
          configured: true,
          error: null,
          tracked_credits: 1796.45,
          tracked_credit_records: 193,
          tracked_credit_sessions: 19,
          primary_window: { used_percent: 25, reset_at: "2026-08-01T00:00:00.000Z" },
        }}
        order={["kiro"]}
      />,
    );

    expect(screen.getByText("Kiro")).toBeInTheDocument();
    expect(
      screen.getByText(
        copy("limits.label.kiro_tracked_credits", {
          credits: "1,796.45",
          count: 193,
        }),
      ),
    ).toBeInTheDocument();

    rerender(
      <UsageLimitsPanel
        kiro={{
          configured: true,
          error: "Kiro CLI timed out.",
          tracked_credits: 1796.45,
          tracked_credit_records: 193,
          tracked_credit_sessions: 19,
        }}
        order={["kiro"]}
      />,
    );
    expect(screen.getByText(/Kiro CLI timed out/)).toBeInTheDocument();
    expect(
      screen.getByText(
        copy("limits.label.kiro_tracked_credits", {
          credits: "1,796.45",
          count: 193,
        }),
      ),
    ).toBeInTheDocument();
  });

  it("renders OpenCode Go 5h / Weekly / Monthly windows", () => {
    const { rerender } = render(
      <UsageLimitsPanel
        opencodeGo={{
          configured: true,
          error: null,
          primary_window: { used_percent: 12, reset_at: "2026-06-24T20:00:00.000Z" },
          secondary_window: { used_percent: 30, reset_at: "2026-06-28T00:00:00.000Z" },
          tertiary_window: { used_percent: 60, reset_at: "2026-07-01T00:00:00.000Z" },
        }}
        order={["opencodeGo"]}
      />,
    );

    // Brand name only — no plan_label suffix to avoid "OpenCode Go Go".
    expect(screen.getByText("OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();

    // Not-configured fallback.
    rerender(<UsageLimitsPanel opencodeGo={{ configured: false }} order={["opencodeGo"]} />);
    expect(screen.getByText("OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();

    // Setup hint teaches the official API key flow and saves the key in-app,
    // never in the machine-wide launch environment.
    expect(screen.getByText("Connect OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText(/Sign in at opencode.ai and subscribe to Go\./)).toBeInTheDocument();
    expect(screen.getByText(/Create and copy an API key in the console\./)).toBeInTheDocument();
    expect(screen.getByText(/Paste your API key below\./)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste API key")).toBeInTheDocument();
    expect(screen.queryByText(/launchctl/)).not.toBeInTheDocument();
  });

  it("saves an OpenCode Go key from the panel and refreshes the limits", async () => {
    const onProviderKeySaved = vi.fn();
    render(
      <UsageLimitsPanel
        opencodeGo={{ configured: false }}
        order={["opencodeGo"]}
        onProviderKeySaved={onProviderKeySaved}
      />,
    );

    await fireEvent.change(screen.getByPlaceholderText("Paste API key"), {
      target: { value: "  test-key-123  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    });

    await vi.waitFor(() => {
      expect(saveProviderApiKey).toHaveBeenCalledWith("opencode-go", "test-key-123");
    });
    expect(onProviderKeySaved).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("keeps the entered key and shows an error when saving fails", async () => {
    vi.mocked(saveProviderApiKey).mockRejectedValueOnce(new Error("HTTP 500"));
    render(<UsageLimitsPanel opencodeGo={{ configured: false }} order={["opencodeGo"]} />);

    const input = screen.getByPlaceholderText("Paste API key");
    await fireEvent.change(input, { target: { value: "test-key-123" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    });

    expect(
      await screen.findByText("Could not save the key. Check the key and try again."),
    ).toBeInTheDocument();
    expect(input).toHaveValue("test-key-123");
  });

  it("renders Command Code 5h / Weekly windows with the plan tier", () => {
    render(
      <UsageLimitsPanel
        commandCode={{
          configured: true,
          error: null,
          plan_label: "GOAT",
          primary_window: {
            used_percent: 32,
            reset_at: "2026-09-06T20:00:00.000Z",
          },
          secondary_window: {
            used_percent: 41,
            reset_at: "2026-09-13T00:00:00.000Z",
          },
        }}
        order={["commandCode"]}
      />,
    );

    expect(screen.getByText("Command Code GOAT")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("32%")).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
  });

  it("shows the two-option Command Code setup hint when not connected", () => {
    render(
      <UsageLimitsPanel commandCode={{ configured: false }} order={["commandCode"]} />,
    );

    expect(screen.getByText("Command Code")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Connect Command Code")).toBeInTheDocument();
    expect(screen.getByText("cmd login")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste API key")).toBeInTheDocument();
    expect(screen.queryByText(/launchctl/)).not.toBeInTheDocument();
  });

  it("keeps the Command Code setup hint free of launchctl on every platform", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    const first = render(
      <UsageLimitsPanel commandCode={{ configured: false }} order={["commandCode"]} />,
    );
    expect(screen.getByText("cmdc auth login")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste API key")).toBeInTheDocument();
    expect(screen.queryByText(/launchctl/)).not.toBeInTheDocument();
    first.unmount();

    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (X11; Linux x86_64)" });
    render(<UsageLimitsPanel commandCode={{ configured: false }} order={["commandCode"]} />);
    expect(screen.getByText("cmd login")).toBeInTheDocument();
    expect(screen.queryByText(/launchctl/)).not.toBeInTheDocument();
  });

  it("explains an environment-provided OpenCode Go key and lets the user save one from the notice", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    const onProviderKeySaved = vi.fn();
    render(
      <UsageLimitsPanel
        opencodeGo={{
          configured: true,
          error: null,
          credential_source: "env",
          primary_window: { used_percent: 12, reset_at: "2026-10-21T00:00:00.000Z" },
        }}
        order={["opencodeGo"]}
        onProviderKeySaved={onProviderKeySaved}
      />,
    );

    expect(
      screen.getByText(/Using OPENCODE_GO_API_KEY from the environment\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText("launchctl unsetenv OPENCODE_GO_API_KEY"),
    ).toBeInTheDocument();

    await fireEvent.change(screen.getByPlaceholderText("Paste API key"), {
      target: { value: "stored-key-456" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    });

    await vi.waitFor(() => {
      expect(saveProviderApiKey).toHaveBeenCalledWith("opencode-go", "stored-key-456");
    });
    expect(onProviderKeySaved).toHaveBeenCalledTimes(1);
  });

  it("does not describe a pace marker when the provider cannot render one (issue 445)", () => {
    render(
      <UsageLimitsPanel
        opencodeGo={{
          configured: true,
          error: null,
          primary_window: { used_percent: 12, reset_at: "2026-08-12T20:00:00.000Z" },
          secondary_window: { used_percent: 30, reset_at: "2026-08-16T00:00:00.000Z" },
          tertiary_window: { used_percent: 60, reset_at: "2026-09-01T00:00:00.000Z" },
        }}
        order={["opencodeGo"]}
      />,
    );

    const group = screen.getByText("OpenCode Go").closest("[role='button']");
    expect(group).not.toBeNull();
    fireEvent.click(group);

    expect(within(group).queryByText(copy("limits.explain.body"))).not.toBeInTheDocument();
  });

  it("renders Cursor pace markers from the exact billing-cycle duration (issue 445)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T03:32:21.000Z"));
    render(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          primary_window: {
            used_percent: 42.4,
            reset_at: "2026-09-04T03:32:21.000Z",
            limit_window_seconds: 31 * 24 * 60 * 60,
          },
          quaternary_window: {
            used_percent: 0,
            reset_at: "2026-08-31T10:37:44.547Z",
            limit_window_seconds: 407741,
          },
        }}
        order={["cursor"]}
      />,
    );

    const group = screen.getByText("Cursor").closest("[role='button']");
    expect(group).not.toBeNull();
    expect(within(group).getByText(copy("limits.label.cursor_grok_bot"))).toBeInTheDocument();
    expect(within(group).getByText("0%")).toBeInTheDocument();
    expect(group.querySelectorAll("div.absolute.top-0.h-full")).toHaveLength(2);
    fireEvent.click(group);
    expect(within(group).getByText(copy("limits.explain.body"))).toBeInTheDocument();
  });

  it("shows Grok's weekly pace marker below 5% usage in remaining mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T00:00:00.000Z"));
    const grok = {
      configured: true,
      error: null,
      period_type: "weekly",
      primary_window: { used_percent: 3, reset_at: "2026-10-01T00:00:00.000Z" },
    };
    const { rerender } = render(createElement(UsageLimitsPanel, {
      grok,
      order: ["grok"],
      displayMode: "remaining",
    }));

    const group = screen.getByText("Grok Build").closest("[role='button']");
    expect(within(group).getByText("97%")).toBeInTheDocument();
    const markers = group.querySelectorAll("div.absolute.top-0.h-full");
    expect(markers).toHaveLength(2);
    expect(markers[1].style.left).toContain("85.714");
    fireEvent.click(group);
    expect(within(group).getByText(copy("limits.explain.body_remaining"))).toBeInTheDocument();

    rerender(createElement(UsageLimitsPanel, {
      grok: { ...grok, primary_window: { ...grok.primary_window, used_percent: 0 } },
      order: ["grok"],
      displayMode: "remaining",
    }));
    expect(group.querySelectorAll("div.absolute.top-0.h-full")).toHaveLength(0);
  });

  it("shows Grok's remaining pool as one bar and lists used product shares on click", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T00:00:00.000Z"));
    const resetAt = "2026-10-01T00:00:00.000Z";
    render(createElement(UsageLimitsPanel, {
      grok: {
        configured: true,
        error: null,
        period_type: "weekly",
        primary_window: { used_percent: 62, reset_at: resetAt },
        products: [
          { product: "GrokBuild", label: "Grok Build", window: { used_percent: 45, reset_at: resetAt } },
          { product: "GrokChat", label: "Chat", window: { used_percent: 13, reset_at: resetAt } },
          { product: "GrokVoice", label: "Voice", window: { used_percent: 3, reset_at: resetAt } },
          { product: "GrokNew", label: "Grok New", window: { used_percent: 0.4, reset_at: resetAt } },
        ],
      },
      order: ["grok"],
      displayMode: "remaining",
    }));

    // Collapsed: one whole-pool bar in the selected remaining orientation.
    expect(document.querySelector("[data-limit-legend]")).toBeNull();
    expect(document.querySelector("[data-limit-share-note]")).toBeNull();
    expect(document.querySelectorAll("[data-limit-segment]")).toHaveLength(0);
    const group = screen.getByText("38%").closest("[role='button']");
    expect(within(group).queryByText("62%")).toBeNull();
    // Products are legend entries, not rows with their own 0–100% track.
    const rowLabels = [...group.querySelectorAll("[data-limit-label]")].map((el) => el.textContent);
    expect(rowLabels).toEqual([copy("limits.label.grok_week")]);
    // Pace mark in remaining orientation: one day of seven elapsed.
    let markers = group.querySelectorAll("div.absolute.top-0.h-full");
    expect(markers).toHaveLength(2);
    expect(markers[1].style.left).toContain("85.714");

    // Clicking the group reveals each product's used share. The bar stays a
    // single remaining fill so the headline is not the sum of those shares.
    fireEvent.click(group);
    const legend = group.querySelector("[data-limit-legend]");
    expect(legend).not.toBeNull();
    expect(group.querySelectorAll("[data-limit-segment]")).toHaveLength(0);
    expect(group.querySelector("[data-limit-share-note]")).not.toBeNull();
    expect(within(group).getByText(copy("limits.grok.shares_are_used"))).toBeInTheDocument();
    expect(within(group).getByText("38%")).toBeInTheDocument();
    expect(within(group).queryByText("62%")).toBeNull();
    expect(within(legend).getByText("Grok Build")).toBeInTheDocument();
    expect(within(legend).getByText(copy("limits.label.grok_chat"))).toBeInTheDocument();
    expect(within(legend).getByText(copy("limits.label.grok_voice"))).toBeInTheDocument();
    expect(within(legend).getByText("Grok New")).toBeInTheDocument();
    expect(within(legend).getByText("45%")).toBeInTheDocument();
    expect(within(legend).getByText(`${copy("limits.bar.sub_one_percent")}%`)).toBeInTheDocument();
    markers = group.querySelectorAll("div.absolute.top-0.h-full");
    expect(markers).toHaveLength(2);
    expect(markers[1].style.left).toContain("85.714");
    expect(within(group).getByText(copy("limits.explain.body_remaining"))).toBeInTheDocument();
  });

  it.each([[], [{ product: "GrokBuild", window: { used_percent: 0 } }]])("shows a full Grok pool in remaining mode after reset with products %j", (products) => {
    render(<UsageLimitsPanel order={["grok"]} displayMode="remaining" grok={{
      configured: true, period_type: "weekly",
      primary_window: { used_percent: 0 },
      secondary_window: { used_percent: 20 },
      products,
    }} />);
    const group = screen.getByRole("button", { name: /^Grok Build/ });
    expect(within(group).getByText("100%")).toBeInTheDocument();
    expect(within(group).getByText("80%")).toBeInTheDocument();
    fireEvent.click(group);
    expect(group.querySelector("[data-limit-segments]")).toBeNull();
    expect(group.querySelector("[data-limit-share-note]")).toBeNull();
    expect(within(group).getAllByText(copy("limits.explain.remaining", { label: copy("limits.label.grok_week"), used: "100" }))).toHaveLength(2);
  });

  it.each([98, 97])("budgets near-full Grok slices with %s percent in the first product", (first) => {
    render(<UsageLimitsPanel order={["grok"]} displayMode="used" grok={{
      configured: true, primary_window: { used_percent: first + 2 },
      products: [
        { product: "GrokBuild", window: { used_percent: first } },
        { product: "GrokChat", window: { used_percent: 1 } },
        { product: "GrokVoice", window: { used_percent: 1 } },
      ],
    }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Grok Build/ }));
    const slices = [...document.querySelectorAll("[data-limit-segment]")];
    expect(slices.map((slice) => Number(slice.style.flexGrow))).toEqual([first, 1, 1]);
    for (const slice of slices) {
      expect(slice.style.flexBasis).toBe("0px");
      expect(slice).toHaveClass("min-w-0");
      expect(slice.style.width).toBe("");
      expect(slice.style.minWidth).toBe("");
    }
    const remainder = document.querySelector("[data-limit-remainder]");
    if (first === 98) expect(remainder).toBeNull();
    else expect(remainder.style.flexGrow).toBe("1");
  });

  it("opens and closes Grok's product breakdown from the keyboard", () => {
    const resetAt = "2026-10-01T00:00:00.000Z";
    render(createElement(UsageLimitsPanel, {
      grok: {
        configured: true,
        error: null,
        period_type: "weekly",
        primary_window: { used_percent: 58, reset_at: resetAt },
        products: [
          { product: "GrokBuild", label: "Grok Build", window: { used_percent: 45, reset_at: resetAt } },
          { product: "GrokChat", label: "Chat", window: { used_percent: 13, reset_at: resetAt } },
        ],
      },
      order: ["grok"],
    }));

    const group = screen.getByText("58%").closest("[role='button']");
    // Reachable by Tab, with a visible focus ring like the card's other toggles.
    expect(group).toHaveAttribute("tabindex", "0");
    expect(group.className).toContain("focus-visible:ring-2");
    expect(group).toHaveAttribute("aria-expanded", "false");

    group.focus();
    fireEvent.keyDown(group, { key: "Enter" });
    expect(group).toHaveAttribute("aria-expanded", "true");
    const legend = group.querySelector("[data-limit-legend]");
    expect(legend).not.toBeNull();
    expect(group.querySelectorAll("[data-limit-segment]")).toHaveLength(2);
    expect(within(legend).getByText("Grok Build")).toBeInTheDocument();
    expect(within(legend).getByText("45%")).toBeInTheDocument();

    fireEvent.keyDown(group, { key: " " });
    expect(group).toHaveAttribute("aria-expanded", "false");
    expect(group.querySelector("[data-limit-legend]")).toBeNull();
    expect(group.querySelectorAll("[data-limit-segment]")).toHaveLength(0);
  });

  it("surfaces a configured OpenCode Go error instead of rendering bars", () => {
    render(
      <UsageLimitsPanel
        opencodeGo={{
          configured: true,
          error: "Could not parse any known OpenCode Go dashboard usage windows",
        }}
        order={["opencodeGo"]}
      />,
    );

    expect(screen.getByText("OpenCode Go")).toBeInTheDocument();
    expect(
      screen.getByText(/Could not parse any known OpenCode Go dashboard usage windows/),
    ).toBeInTheDocument();
  });

  it("shows an inactive OpenCode Go status without rendering historical bars", () => {
    render(
      <UsageLimitsPanel
        opencodeGo={{
          configured: true,
          error: null,
          subscription_status: "inactive",
          primary_window: { used_percent: 12, reset_at: "2026-06-24T20:00:00.000Z" },
        }}
        order={["opencodeGo"]}
      />,
    );

    expect(screen.getByText("OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText("OpenCode Go subscription is inactive")).toBeInTheDocument();
    expect(screen.queryByText("5h")).not.toBeInTheDocument();
    expect(screen.queryByText("12%")).not.toBeInTheDocument();
  });

  it("renders Ark Coding Plan 5h / Weekly / Monthly windows", () => {
    const { rerender } = render(
      <UsageLimitsPanel
        codingPlan={{
          configured: true,
          error: null,
          plan_label: "Lite",
          primary_window: { used_percent: 33, reset_at: "2026-08-11T09:42:00.000Z" },
          secondary_window: { used_percent: 16, reset_at: "2026-08-16T16:00:00.000Z" },
          tertiary_window: { used_percent: 9, reset_at: "2026-09-09T15:59:59.000Z" },
        }}
        order={["codingPlan"]}
      />,
    );

    // Brand + tier, without repeating "Coding Plan" (title: "Ark Coding Plan Lite").
    expect(screen.getByText("Ark Coding Plan Lite")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByText("16%")).toBeInTheDocument();
    expect(screen.getByText("9%")).toBeInTheDocument();

    // Not-configured fallback shows the Ark CLI setup guide.
    rerender(<UsageLimitsPanel codingPlan={{ configured: false }} order={["codingPlan"]} />);
    expect(screen.getByText("Ark Coding Plan")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(copy("limits.codingPlan.setupHint.title"))).toBeInTheDocument();
  });

  it("renders Qoder credits with exact amounts in the hover detail", () => {
    render(
      <UsageLimitsPanel
        qoder={{
          configured: true,
          error: null,
          primary_window: {
            used_percent: 25,
            used_credits: 25,
            limit_credits: 100,
            remaining_credits: 75,
            reset_at: "2026-08-01T00:00:00.000Z",
          },
        }}
        order={["qoder"]}
      />,
    );

    expect(screen.getByText("Qoder")).toBeInTheDocument();
    expect(screen.getByText("Credits")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent(/25.*100.*75/);
  });

  it("drops an empty Plan Credits row and keeps Ultimate Free Calls", () => {
    render(
      <UsageLimitsPanel
        qoder={{
          configured: true,
          error: null,
          primary_window: {
            used_percent: 0,
            used_credits: 0,
            limit_credits: 0,
            remaining_credits: 0,
            reset_at: null,
          },
          secondary_window: {
            used_percent: 65.75,
            used_credits: 789,
            limit_credits: 1200,
            remaining_credits: 411,
            reset_at: "2026-07-30T13:19:00.000Z",
            unit: "calls",
          },
        }}
        order={["qoder"]}
      />,
    );

    expect(screen.queryByText("Credits")).not.toBeInTheDocument();
    expect(screen.getByText("Ultimate Free Calls")).toBeInTheDocument();
    expect(screen.getByText("66%")).toBeInTheDocument();
    expect(screen.getAllByRole("tooltip").some((tip) => /789[\s\S]*1200[\s\S]*411/.test(tip.textContent))).toBe(true);
  });

  it("marks Qoder last-good limits as cached with their capture age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T10:10:00.000Z"));
    render(
      <UsageLimitsPanel
        qoder={{
          configured: true,
          error: null,
          cached: true,
          stale: true,
          cached_at: "2026-07-26T10:00:00.000Z",
          secondary_window: {
            used_percent: 75,
            used_credits: 900,
            limit_credits: 1200,
            remaining_credits: 300,
            reset_at: "2026-07-30T15:59:00.000Z",
            unit: "calls",
          },
        }}
        order={["qoder"]}
      />,
    );

    const badge = screen.getAllByText(/^cached/i).find((node) => /10m/i.test(node.textContent));
    expect(badge).toHaveTextContent(/10m/i);
    expect(screen.getByText("Cached limits. Run Qoder to refresh.")).toBeInTheDocument();
  });

  it("renders Qoder CN plan, add-on credits and Ultimate calls as separate buckets", () => {
    const data = {
      configured: true,
      primary_window: { used_percent: 25, used_credits: 25, limit_credits: 100, remaining_credits: 75 },
      secondary_window: { used_percent: 40, used_credits: 80, limit_credits: 200, remaining_credits: 120, unit: "calls" },
      tertiary_window: { used_percent: 7, used_credits: 35, limit_credits: 500, remaining_credits: 465, unit: "credits" },
    };
    const { rerender } = render(<UsageLimitsPanel qoderCn={data} order={["qoderCn"]} />);
    expect(screen.getByText(copy("limits.label.qoder_cn_credits"))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.label.qoder_cn_addon_credits"))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.label.qoder_cn_ultimate"))).toBeInTheDocument();
    expect(screen.getByText("7%")).toBeInTheDocument();
    const details = screen.getAllByRole("tooltip").map((tip) => tip.textContent);
    expect(details.some((text) => /25[\s\S]*100[\s\S]*75/.test(text))).toBe(true);
    expect(details.some((text) => /35[\s\S]*500[\s\S]*465/.test(text))).toBe(true);
    expect(details.some((text) => /80[\s\S]*200[\s\S]*120/.test(text))).toBe(true);
    rerender(<UsageLimitsPanel qoderCn={{ ...data, tertiary_window: undefined }} order={["qoderCn"]} />);
    expect(screen.queryByText(copy("limits.label.qoder_cn_addon_credits"))).not.toBeInTheDocument();
  });

  it("renders Qoder plan, add-on credits and Ultimate calls as separate buckets", () => {
    const data = {
      configured: true,
      primary_window: { used_percent: 25, used_credits: 25, limit_credits: 100, remaining_credits: 75 },
      secondary_window: { used_percent: 40, used_credits: 80, limit_credits: 200, remaining_credits: 120, unit: "calls" },
      tertiary_window: { used_percent: 7, used_credits: 35, limit_credits: 500, remaining_credits: 465, unit: "credits" },
    };
    const { rerender } = render(<UsageLimitsPanel qoder={data} order={["qoder"]} />);
    expect(screen.getByText(copy("limits.label.qoder_credits"))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.label.qoder_addon_credits"))).toBeInTheDocument();
    expect(screen.getByText(copy("limits.label.qoder_ultimate"))).toBeInTheDocument();
    const details = screen.getAllByRole("tooltip").map((tip) => tip.textContent);
    expect(details.some((text) => /25[\s\S]*100[\s\S]*75/.test(text))).toBe(true);
    expect(details.some((text) => /35[\s\S]*500[\s\S]*465/.test(text))).toBe(true);
    expect(details.some((text) => /80[\s\S]*200[\s\S]*120/.test(text))).toBe(true);
    rerender(<UsageLimitsPanel qoder={{ ...data, tertiary_window: undefined }} order={["qoder"]} />);
    expect(screen.queryByText(copy("limits.label.qoder_addon_credits"))).not.toBeInTheDocument();
  });

  it("drops Qoder windows with no quota instead of rendering empty bars", () => {
    const data = {
      configured: true,
      primary_window: { used_percent: 0, used_credits: 0, limit_credits: 0, remaining_credits: 0 },
      tertiary_window: { used_percent: 6.09, used_credits: 67, limit_credits: 1100, remaining_credits: 1033 },
    };
    render(<UsageLimitsPanel qoder={data} order={["qoder"]} />);
    expect(screen.queryByText(copy("limits.label.qoder_credits"))).not.toBeInTheDocument();
    expect(screen.getByText(copy("limits.label.qoder_addon_credits"))).toBeInTheDocument();
  });

  it("appends plan_label to the provider title when present", () => {
    render(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          plan_label: "Pro",
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
      />,
    );

    expect(screen.getByText("Cursor Pro")).toBeInTheDocument();
    expect(screen.queryByText("Cursor")).not.toBeInTheDocument();
  });

  it("renders just the provider name when plan_label is null or absent", () => {
    const { rerender } = render(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          plan_label: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
      />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();

    rerender(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
      />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();
  });

  it("does not duplicate Antigravity cached status with the generic provenance badge", () => {
    render(
      <UsageLimitsPanel
        antigravity={{
          configured: true,
          error: null,
          cached: true,
          cached_at: "2026-07-17T12:00:00.000Z",
          provenance: {
            source: "disk-cache",
            confidence: "observed",
            stale: true,
            captured_at: "2026-07-17T12:00:00.000Z",
          },
          primary_window: { used_percent: 24, reset_at: "2026-07-24T12:00:00.000Z" },
        }}
        order={["antigravity"]}
      />,
    );

    const group = screen.getByText("Antigravity").closest("[role='button']");
    expect(group).not.toBeNull();
    expect(within(group).getByText(/cached\s*·/i)).toBeInTheDocument();
    expect(group.querySelector("span.bg-amber-500")).not.toBeNull();
    expect(within(group).queryByText(/^Stale/i)).not.toBeInTheDocument();
  });

  it("flags Antigravity reauth ahead of the cached badge", () => {
    render(
      <UsageLimitsPanel
        antigravity={{
          configured: true,
          error: null,
          cached: true,
          cached_at: "2026-07-17T12:00:00.000Z",
          auth_action_required: "reauth",
          primary_window: { used_percent: 24, reset_at: "2026-07-24T12:00:00.000Z" },
        }}
        order={["antigravity"]}
      />,
    );

    const group = screen.getByText("Antigravity").closest("[role='button']");
    expect(group).not.toBeNull();
    expect(within(group).getByText(new RegExp(copy("limits.reauth.badge")))).toBeInTheDocument();
    expect(within(group).getByText(/run `agy`/)).toBeInTheDocument();
    expect(within(group).queryByText(/cached/i)).not.toBeInTheDocument();
  });

  it("flags an expired Claude sign-in on cached bars instead of the generic stale badge", () => {
    render(
      <UsageLimitsPanel
        claude={{
          configured: true,
          error: null,
          five_hour: { utilization: 41, resets_at: "2026-07-24T12:00:00.000Z" },
          stale: true,
          cached_at: "2026-07-17T12:00:00.000Z",
          auth_action_required: "reauth",
          provenance: {
            source: "disk-cache",
            confidence: "observed",
            stale: true,
            captured_at: "2026-07-17T12:00:00.000Z",
          },
        }}
        order={["claude"]}
      />,
    );

    const group = screen.getByText("Claude").closest("[role='button']");
    expect(group).not.toBeNull();
    expect(within(group).getByText(new RegExp(copy("limits.reauth.badge")))).toBeInTheDocument();
    expect(within(group).queryByText(/^Stale/i)).not.toBeInTheDocument();
  });

  it("sources the Command Code reauth command from the copy registry into the tooltip (review 594)", () => {
    render(
      <UsageLimitsPanel
        commandCode={{
          configured: true,
          error: null,
          primary_window: { used_percent: 41, reset_at: "2026-07-24T12:00:00.000Z" },
          stale: true,
          cached_at: "2026-07-17T12:00:00.000Z",
          auth_action_required: "reauth",
          provenance: {
            source: "disk-cache",
            confidence: "observed",
            stale: true,
            captured_at: "2026-07-17T12:00:00.000Z",
          },
        }}
        order={["commandCode"]}
      />,
    );

    const group = screen.getByText("Command Code").closest("[role='button']");
    expect(group).not.toBeNull();
    expect(within(group).getByText(new RegExp(copy("limits.reauth.badge")))).toBeInTheDocument();
    expect(within(group).getByText(/run `cmd login`/)).toBeInTheDocument();
    expect(within(group).queryByText(/^Stale/i)).not.toBeInTheDocument();
  });

  it.each([
    [ZH_CN_LOCALE, "实时", "过期"],
    [ZH_TW_LOCALE, "即時", "過期"],
    [JA_LOCALE, "最新", "古い"],
    [KO_LOCALE, "실시간", "오래됨"],
    [DE_LOCALE, "Live", "Veraltet"],
  ])("localizes live and stale status labels for %s", (locale, liveLabel, staleLabel) => {
    setCopyLocale(locale);

    expect(copy("limits.provenance.fresh")).toBe(liveLabel);
    expect(copy("limits.provenance.stale")).toBe(staleLabel);
  });

  it("renders Codex Spark quota windows through compact copy labels", () => {
    function expectLimitRow(label, value) {
      const row = screen.getByText(label).closest("div");
      expect(row).not.toBeNull();
      expect(within(row).getByText(value)).toBeInTheDocument();
    }

    setCopyLocale(ZH_CN_LOCALE);
    render(
      <UsageLimitsPanel
        codex={{
          configured: true,
          error: null,
          primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 30, reset_at: 1_800_604_800, limit_window_seconds: 604800 },
          spark_primary_window: { used_percent: 4, reset_at: 1_800_000_001, limit_window_seconds: 18000 },
          spark_secondary_window: { used_percent: 18, reset_at: 1_800_604_801, limit_window_seconds: 604800 },
        }}
        order={["codex"]}
      />,
    );

    expect(screen.getByText("Codex")).toBeInTheDocument();
    expectLimitRow("5h", "12%");
    expectLimitRow("7d", "30%");
    expectLimitRow("Spark 5h", "4%");
    expectLimitRow("Spark 7d", "18%");
  });

  it("renders Codex credit usage from spend controls", () => {
    render(
      <UsageLimitsPanel
        codex={{
          configured: true,
          error: null,
          credit_window: {
            used_percent: 0.136091596921285,
            remaining_percent: 99.86390840307871,
            reset_at: 1_785_542_400,
            limit_credits: 37_500,
            used_credits: 51.03434884548187,
            remaining_credits: 37_448.96565115452,
          },
        }}
        order={["codex"]}
      />,
    );

    expect(screen.getByText("Codex")).toBeInTheDocument();
    const row = screen.getByText("Credits").closest("div");
    expect(within(row).getByText("<1%")).toBeInTheDocument();
    // Amounts show in the hover tooltip, not as an always-visible line.
    expect(within(row).getByRole("tooltip")).toHaveTextContent(
      `${formatAmount(51.03434884548187)} / ${formatAmount(37_500)} credits used · ${formatAmount(37_448.96565115452)} left`,
    );
  });

  it("renders Codex Reset rows after quota rows without years, collapsed labels, or quota percentages", () => {
    const expiry = "2030-01-11T10:45:00.000Z";
    render(
      <UsageLimitsPanel
        codex={{
          configured: true,
          error: null,
          primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 30, reset_at: 1_800_604_800, limit_window_seconds: 604800 },
          spark_primary_window: { used_percent: 4, reset_at: 1_800_000_001, limit_window_seconds: 18000 },
          spark_secondary_window: { used_percent: 18, reset_at: 1_800_604_801, limit_window_seconds: 604800 },
          reset_credits: {
            available_count: 1,
            total_earned_count: 1,
            credits: [credit("2030-01-01T10:45:00.000Z", expiry)],
          },
        }}
        order={["codex"]}
      />,
    );

    const codexGroupElement = screen.getByText("Codex").closest("[role='button']");
    expect(codexGroupElement).not.toBeNull();
    const codexGroup = within(codexGroupElement);
    expect(codexGroup.getByText("5h")).toBeInTheDocument();
    expect(codexGroup.getByText("7d")).toBeInTheDocument();
    expect(codexGroup.getByText("Spark 5h")).toBeInTheDocument();
    const sparkSevenDay = codexGroup.getByText("Spark 7d");
    const resetsTitle = codexGroup.getByText(copy("limits.codex_reset_bank.title"));
    expect(sparkSevenDay.compareDocumentPosition(resetsTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const resetRows = codexGroupElement.querySelectorAll("[data-reset-bank-row]");
    expect(resetRows).toHaveLength(1);
    const resetRow = within(resetRows[0]);
    expect(resetRow.getByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).toBeInTheDocument();
    const expiryText = formatExpiry(expiry);
    const expiryElement = resetRow.getByText(expiryText);
    expect(expiryElement).toBeInTheDocument();
    expect(expiryElement).toHaveClass("tabular-nums", "w-[4.25rem]");
    expect(expiryText).toMatch(/\d{1,2}:\d{2}/);
    expect(expiryText).not.toMatch(/\b2030\b/);
    expect(resetRow.queryByText(/\b2030\b/)).not.toBeInTheDocument();
    expect(resetRow.queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it("renders Codex count-only Reset state as muted text without a fake row", () => {
    render(
      <UsageLimitsPanel
        codex={{
          configured: true,
          error: null,
          primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
          reset_credits: {
            available_count: 2,
            total_earned_count: 2,
            credits: [credit("2030-01-01T10:45:00.000Z", "not-a-date")],
          },
        }}
        order={["codex"]}
      />,
    );

    const codexGroupElement = screen.getByText("Codex").closest("[role='button']");
    expect(codexGroupElement).not.toBeNull();
    const section = codexGroupElement.querySelector("[data-reset-bank-section='count_only']");
    expect(section).not.toBeNull();
    const fallback = within(section).getByText(copy("limits.codex_reset_bank.count_only", { count: 2 }));
    expect(fallback).toHaveClass("text-oai-gray-500");
    expect(section.querySelector("[data-reset-bank-row]")).toBeNull();
    expect(within(section).queryByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).not.toBeInTheDocument();
  });

  it("does not render Codex Reset Bank when available count is zero", () => {
    render(
      <UsageLimitsPanel
        codex={{
          configured: true,
          error: null,
          primary_window: { used_percent: 12, reset_at: 1_800_000_000, limit_window_seconds: 18000 },
          reset_credits: {
            available_count: 0,
            total_earned_count: 2,
            credits: [credit("2030-01-01T10:45:00.000Z", "2030-01-11T10:45:00.000Z")],
          },
        }}
        order={["codex"]}
      />,
    );

    const codexGroupElement = screen.getByText("Codex").closest("[role='button']");
    expect(codexGroupElement).not.toBeNull();
    expect(codexGroupElement.querySelector("[data-reset-bank-section]")).toBeNull();
    expect(within(codexGroupElement).queryByText(copy("limits.codex_reset_bank.title"))).not.toBeInTheDocument();
    expect(within(codexGroupElement).queryByText(copy("limits.codex_reset_bank.row_label", { index: 1 }))).not.toBeInTheDocument();
  });

  it("renders an inline subscription bar, badge and detail for a linked provider", () => {
    const subscription = {
      id: "s1",
      service: "Cursor",
      plan: "Pro",
      provider: "cursor",
      autoRenew: true,
      nextBillingAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    };

    render(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
        subscriptions={[subscription]}
      />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();
    // Collapsed: top-right auto-renew icon badge and the "Subscription" bar label.
    expect(screen.getByRole("img", { name: "Auto-renew" })).toBeInTheDocument();
    expect(screen.getByText("Subscription")).toBeInTheDocument();

    // Expanding reveals the subscription detail line.
    fireEvent.click(screen.getByText("Cursor").closest("[role='button']"));
    expect(screen.getByText("Next renewal")).toBeInTheDocument();
    expect(screen.getByText("Auto-renew on")).toBeInTheDocument();
  });

  it("does not render subscription rows for a provider without a linked subscription", () => {
    render(
      <UsageLimitsPanel
        cursor={{
          configured: true,
          error: null,
          primary_window: { used_percent: 50, reset_at: "2026-05-10T10:39:54.000Z" },
        }}
        order={["cursor"]}
        subscriptions={[]}
      />,
    );

    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.queryByText("Auto-renew")).not.toBeInTheDocument();
    expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
  });

  it("renders Devin Daily / Weekly windows with the plan label", () => {
    render(
      <UsageLimitsPanel
        devin={{
          configured: true,
          error: null,
          plan_label: "Pro",
          primary_window: {
            used_percent: 40,
            reset_at: "2026-09-13T08:00:00.000Z",
            limit_window_seconds: 86400,
          },
          secondary_window: {
            used_percent: 90,
            reset_at: "2026-09-20T08:00:00.000Z",
            limit_window_seconds: 604800,
          },
        }}
        order={["devin"]}
      />,
    );

    expect(screen.getByText("Devin Pro")).toBeInTheDocument();
    expect(screen.getByText("Daily")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  it("flips Devin percentages to remaining in remaining display mode", () => {
    render(
      <UsageLimitsPanel
        devin={{
          configured: true,
          error: null,
          primary_window: {
            used_percent: 40,
            reset_at: "2026-09-13T08:00:00.000Z",
            limit_window_seconds: 86400,
          },
        }}
        order={["devin"]}
        displayMode="remaining"
      />,
    );

    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.queryByText("40%")).not.toBeInTheDocument();
  });

  it("renders no bogus Daily bar when Devin reports only the weekly window", () => {
    render(
      <UsageLimitsPanel
        devin={{
          configured: true,
          error: null,
          primary_window: null,
          secondary_window: {
            used_percent: 25,
            reset_at: "2026-09-20T08:00:00.000Z",
            limit_window_seconds: 604800,
          },
        }}
        order={["devin"]}
      />,
    );

    expect(screen.getByText("Devin")).toBeInTheDocument();
    expect(screen.getByText("Weekly")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.queryByText("Daily")).not.toBeInTheDocument();
  });

  it("shows the Devin CLI setup hint when not connected", () => {
    render(
      <UsageLimitsPanel devin={{ configured: false }} order={["devin"]} />,
    );

    expect(screen.getByText("Devin")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Connect Devin")).toBeInTheDocument();
    expect(screen.getByText("devin auth login")).toBeInTheDocument();
  });
});
