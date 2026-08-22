import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copy, setCopyLocale } from "../../../lib/copy";
import { DE_LOCALE, EN_LOCALE, JA_LOCALE, KO_LOCALE, ZH_CN_LOCALE, ZH_TW_LOCALE } from "../../../lib/locale";
import { UsageLimitsPanel } from "./UsageLimitsPanel.jsx";

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
    expect(screen.getByRole("heading", { name: /Usage Limits\s*·\s*Used/ })).toBeInTheDocument();
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

    // Setup hint teaches the official API key flow (follow-up to the closed
    // PR about OpenCode Go direct fill).
    expect(screen.getByText("Connect OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText(/Sign in at opencode.ai and subscribe to Go\./)).toBeInTheDocument();
    expect(screen.getByText(/Create and copy an API key in the console\./)).toBeInTheDocument();
    expect(screen.getByText(/Run this command, paste your API key \(input stays invisible\)/)).toBeInTheDocument();
  });

  it("copies an API-key setup snippet without sending the key anywhere", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<UsageLimitsPanel opencodeGo={{ configured: false }} order={["opencodeGo"]} />);

    await fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const snippet = writeText.mock.calls[0][0];
    // The snippet reads the key interactively (`read -r -s`) so it never lands
    // in shell history, then exports it for both the shell profile path and
    // the macOS app (launchctl) path. It is a template only: no real key.
    expect(snippet).toContain("read -r -s OPENCODE_GO_API_KEY");
    expect(snippet).toContain("export OPENCODE_GO_API_KEY");
    expect(snippet).toContain('launchctl setenv OPENCODE_GO_API_KEY "$OPENCODE_GO_API_KEY"');
    expect(snippet).not.toMatch(/sk-/);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
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
        }}
        order={["cursor"]}
      />,
    );

    const group = screen.getByText("Cursor").closest("[role='button']");
    expect(group).not.toBeNull();
    expect(group.querySelectorAll("div.absolute.top-0.h-full")).toHaveLength(2);
    fireEvent.click(group);
    expect(within(group).getByText(copy("limits.explain.body"))).toBeInTheDocument();
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

  it("renders Qoder Ultimate Free Calls separately from Plan Credits", () => {
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

    expect(screen.getByText("Credits")).toBeInTheDocument();
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
    function expectLimitRow(label, value) {
      const row = screen.getByText(label).closest("div");
      expect(row).not.toBeNull();
      expect(within(row).getByText(value)).toBeInTheDocument();
    }

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
});
