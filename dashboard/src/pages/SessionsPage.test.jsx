import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessions } from "../lib/sessions-api";
import { SessionsPage } from "./SessionsPage.jsx";
import { copy } from "../lib/copy";

vi.mock("../lib/sessions-api", () => ({
  getSessions: vi.fn(),
}));

vi.mock("../lib/mock-data", () => ({
  isMockEnabled: () => true,
}));

vi.mock("../ui/components/Toast.jsx", () => ({
  showToast: vi.fn(),
}));

vi.mock("../hooks/useLocale", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));

const daysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
};

async function chooseSelect(label, option) {
  await userEvent.click(screen.getByRole("combobox", { name: label }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

const response = {
  from: "",
  to: "",
  available: true,
  session_count: 3,
  returned_count: 3,
  sessions: [
    {
      session_hash: "claude-row",
      session_id: "11111111-2222-3333-4444-555555555555",
      title: "Fix authentication flow",
      source: "claude",
      project_key: "tokentracker",
      project_ref: "/work/tokentracker",
      model: "claude-opus-4-8",
      started_at: "2026-07-24T08:00:00Z",
      ended_at: "2026-07-24T08:10:00Z",
      duration_ms: 600_000,
      turns: 1,
      edit_turns: 1,
      retry_turns: 0,
      subagent_calls: 0,
      total_tokens: 12_000,
      cost_usd: 0.25,
      productive: true,
      first_pass: true,
      resume_command: "claude --resume 11111111-2222-3333-4444-555555555555",
    },
    {
      session_hash: "codex-row",
      session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Review release",
      source: "codex",
      project_key: "lumaradio",
      project_ref: "/work/lumaradio",
      model: "gpt-5.6-sol",
      started_at: "2026-07-23T08:00:00Z",
      ended_at: "2026-07-23T08:20:00Z",
      duration_ms: 1_200_000,
      turns: 2,
      edit_turns: 0,
      retry_turns: 0,
      subagent_calls: 0,
      total_tokens: 8_000,
      cost_usd: 0.1,
      productive: false,
      first_pass: false,
      resume_command: "codex resume aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
    {
      session_hash: "grok-row",
      session_id: "019f740c-e792-7fb1-a218-59ea1b340714",
      title: "Debug local proxy",
      source: "grok",
      project_key: "alphafox-web",
      project_ref: "/work/alphafox-web",
      model: "grok-4.6",
      started_at: "2026-07-22T08:00:00Z",
      ended_at: "2026-07-22T08:15:00Z",
      duration_ms: 900_000,
      turns: 3,
      edit_turns: 1,
      retry_turns: 0,
      subagent_calls: 0,
      input_tokens: 8_586,
      cached_input_tokens: 192_896,
      cache_creation_input_tokens: 0,
      output_tokens: 1_391,
      reasoning_output_tokens: 1_420,
      total_tokens: 204_293,
      cost_usd: 0.130486,
      cost_source: "provider_reported",
      usage_precision: "reported",
      usage_is_incomplete: false,
      cost_is_partial: false,
      usage_events: 2,
      model_calls: 7,
      api_duration_ms: 55_909,
      context_tokens_used: 31_445,
      context_window_tokens: 500_000,
      context_usage_percent: 6,
      tool_calls: 5,
      tool_failures: 0,
      error_count: 1,
      compaction_count: 0,
      productive: true,
      first_pass: true,
      resume_command: "grok --resume 019f740c-e792-7fb1-a218-59ea1b340714",
    },
  ],
};

const makeThreadSession = (overrides) => ({
  ...response.sessions[1],
  session_hash: "thread-row",
  session_id: "00000000-0000-4000-8000-000000000000",
  title: "Thread session",
  source: "codex",
  project_key: "thread-fixture",
  project_ref: "/work/thread-fixture",
  model: "gpt-5.6-sol",
  parent_session_id: null,
  parent_session_hash: null,
  root_session_hash: "thread-row",
  thread_kind: "root",
  agent_nickname: null,
  agent_role: null,
  orphaned_subagent: false,
  parent_link_conflict: false,
  direct_subagent_count: 0,
  descendant_subagent_count: 0,
  own_total_tokens: 1_000,
  subagent_total_tokens: 0,
  combined_total_tokens: 1_000,
  total_tokens: 1_000,
  own_cost_usd: 0.01,
  subagent_cost_usd: 0,
  combined_cost_usd: 0.01,
  cost_usd: 0.01,
  ...overrides,
});

describe("SessionsPage", () => {
  it("shows a reported zero first-response wait as a measured sample", async () => {
    const row = makeThreadSession({ title: "Instant response", performance: {
      estimated_request_count: 0, estimated_tokens_per_second: null,
      first_response_sample_count: 1, first_response_total_ms: 0, first_response_ms: 0,
    } });
    getSessions.mockResolvedValue({ ...response, sessions: [row], session_count: 1, returned_count: 1 });
    render(<SessionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "View statistics for Instant response" }));
    expect(within(screen.getByRole("dialog")).getByText("0.00s · 1 sample")).toBeInTheDocument();
  });
  beforeEach(() => {
    getSessions.mockReset();
    getSessions.mockResolvedValue(response);
    window.localStorage.clear();
    window.history.replaceState(null, "", "/sessions");
  });

  it("loads local sessions and filters them by source and search", async () => {
    render(<SessionsPage />);

    expect(await screen.findByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.getByText("Review release")).toBeInTheDocument();
    expect(screen.getByText("Debug local proxy")).toBeInTheDocument();
    expect(screen.getByText("Reported cost")).toBeInTheDocument();
    expect(screen.queryByLabelText("Sessions from")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View statistics for Debug local proxy" }));
    const grokDetails = screen.getByRole("dialog", { name: "Session statistics" });
    expect(within(grokDetails).getByText("Input").parentElement).toHaveTextContent("8.6K");
    expect(within(grokDetails).getByText("Cached input").parentElement).toHaveTextContent("192.9K");
    expect(within(grokDetails).getByText("Cache write").parentElement).toHaveTextContent("0");
    expect(within(grokDetails).getByText("Output").parentElement).toHaveTextContent("1.4K");
    expect(within(grokDetails).getByText("Reasoning").parentElement).toHaveTextContent("1.4K");
    await userEvent.click(within(grokDetails).getByText("Observed activity"));
    expect(within(grokDetails).getByText("Model calls 7 · API 55.9s · Tools 5 · Errors 1")).toBeInTheDocument();
    expect(within(grokDetails).getByText("Context 31.4K / 500K (6%)")).toBeInTheDocument();
    await userEvent.click(within(grokDetails).getByRole("button", { name: "Close session statistics" }));
    // The whole list is fetched once; no row cap and no server-side window.
    expect(getSessions).toHaveBeenCalledWith({ refresh: false });

    await chooseSelect("Filter by session source", "Codex");
    expect(screen.queryByText("Fix authentication flow")).not.toBeInTheDocument();
    expect(screen.getByText("Review release")).toBeInTheDocument();
    expect(screen.queryByText("Debug local proxy")).not.toBeInTheDocument();

    await chooseSelect("Filter by session source", "Grok");
    expect(screen.queryByText("Review release")).not.toBeInTheDocument();
    expect(screen.getByText("Debug local proxy")).toBeInTheDocument();

    await chooseSelect("Filter by session source", "All tools");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "auth" },
    });
    expect(screen.getByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.queryByText("Review release")).not.toBeInTheDocument();
    expect(screen.queryByText("Debug local proxy")).not.toBeInTheDocument();
  });

  it("renders and searches every observed model in a mixed Codex session", async () => {
    const mixed = {
      ...response.sessions[1],
      session_hash: "mixed-codex-row",
      title: "Mixed model work",
      model: "mixed",
      own_total_tokens: 8_000,
      cost_usd: 0.1,
      cost_is_partial: true,
      model_usage: [
        { model: "gpt-5.6-sol", total_tokens: 6_000 },
        { model: "gpt-5.6-terra", total_tokens: 2_000 },
      ],
    };
    getSessions.mockResolvedValue({
      ...response,
      session_count: 1,
      returned_count: 1,
      sessions: [mixed],
    });

    render(<SessionsPage />);
    expect(await screen.findByText("Mixed model work")).toBeInTheDocument();
    expect(screen.getByText(/gpt-5\.6-sol 6K.*gpt-5\.6-terra 2K/)).toBeInTheDocument();
    // A Codex session priced from an unrated model must explain itself: the
    // marker alone used to be the only signal and carried no label at all.
    const partialCost = screen.getAllByText(/^≥\$/).find((element) => element.closest("li"));
    expect(partialCost).toBeInTheDocument();
    expect(partialCost).toHaveAttribute("title", expect.stringContaining("Lower bound"));
    expect(screen.getByText("Partial cost")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "terra" },
    });
    expect(screen.getByText("Mixed model work")).toBeInTheDocument();
  });

  it("folds direct and nested subagents under their root session", async () => {
    const root = makeThreadSession({
      session_hash: "root-hash",
      session_id: "10000000-0000-4000-8000-000000000000",
      root_session_hash: "root-hash",
      title: "Root session",
      direct_subagent_count: 1,
      descendant_subagent_count: 2,
      subagent_total_tokens: 500,
      combined_total_tokens: 1_500,
    });
    const child = makeThreadSession({
      session_hash: "child-hash",
      session_id: "20000000-0000-4000-8000-000000000000",
      parent_session_id: root.session_id,
      parent_session_hash: root.session_hash,
      root_session_hash: root.session_hash,
      thread_kind: "subagent",
      agent_nickname: "Direct child",
      agent_role: "luna",
      model: "gpt-5.6-luna",
      own_total_tokens: 300,
      total_tokens: 300,
      combined_total_tokens: 300,
    });
    const grandchild = makeThreadSession({
      session_hash: "grandchild-hash",
      session_id: "30000000-0000-4000-8000-000000000000",
      parent_session_id: child.session_id,
      parent_session_hash: child.session_hash,
      root_session_hash: root.session_hash,
      thread_kind: "subagent",
      agent_nickname: "Grandchild agent",
      agent_role: "spark",
      model: "gpt-5.3-codex-spark",
      own_total_tokens: 200,
      total_tokens: 200,
      combined_total_tokens: 200,
    });
    getSessions.mockResolvedValue({
      ...response,
      session_count: 3,
      returned_count: 3,
      sessions: [root, child, grandchild],
    });

    render(<SessionsPage />);

    expect(await screen.findByText("Root session")).toBeInTheDocument();
    expect(screen.queryByText("Direct child")).not.toBeInTheDocument();
    expect(screen.queryByText("Grandchild agent")).not.toBeInTheDocument();
    expect(screen.getByText(/1 root sessions.*2 subagents collapsed/)).toBeInTheDocument();

    const expand = screen.getByRole("button", { name: "Expand 2 subagents" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);

    expect(screen.getByRole("button", { name: "Collapse 2 subagents" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Subagent model usage")).toBeInTheDocument();
    expect(screen.getByText("Direct child")).toBeInTheDocument();
    expect(screen.getByText("Grandchild agent")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse 2 subagents" }));
    expect(screen.queryByText("Direct child")).not.toBeInTheDocument();
    expect(screen.queryByText("Grandchild agent")).not.toBeInTheDocument();
  });

  it("filters subagents by model within only the selected root", async () => {
    const rootA = makeThreadSession({
      session_hash: "root-a",
      session_id: "40000000-0000-4000-8000-000000000000",
      root_session_hash: "root-a",
      title: "Root A",
    });
    const rootB = makeThreadSession({
      session_hash: "root-b",
      session_id: "50000000-0000-4000-8000-000000000000",
      root_session_hash: "root-b",
      title: "Root B",
    });
    const child = (overrides) => makeThreadSession({
      thread_kind: "subagent",
      title: null,
      ...overrides,
    });
    getSessions.mockResolvedValue({
      ...response,
      session_count: 5,
      returned_count: 5,
      sessions: [
        rootA,
        child({
          session_hash: "root-a-sol",
          session_id: "60000000-0000-4000-8000-000000000000",
          parent_session_id: rootA.session_id,
          parent_session_hash: rootA.session_hash,
          root_session_hash: rootA.session_hash,
          agent_nickname: "A keep",
          agent_role: "sol",
          model: "gpt-5.6-sol",
          own_total_tokens: 300,
          total_tokens: 300,
        }),
        child({
          session_hash: "root-a-luna",
          session_id: "70000000-0000-4000-8000-000000000000",
          parent_session_id: rootA.session_id,
          parent_session_hash: rootA.session_hash,
          root_session_hash: rootA.session_hash,
          agent_nickname: "A hide",
          agent_role: "luna",
          model: "gpt-5.6-luna",
          own_total_tokens: 200,
          total_tokens: 200,
        }),
        rootB,
        child({
          session_hash: "root-b-spark",
          session_id: "80000000-0000-4000-8000-000000000000",
          parent_session_id: rootB.session_id,
          parent_session_hash: rootB.session_hash,
          root_session_hash: rootB.session_hash,
          agent_nickname: "B child",
          agent_role: "spark",
          model: "gpt-5.3-codex-spark",
          own_total_tokens: 100,
          total_tokens: 100,
        }),
      ],
    });

    render(<SessionsPage />);
    expect(await screen.findByText("Root A")).toBeInTheDocument();
    expect(screen.getByText("Root B")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand 2 subagents" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand 1 subagents" }));
    expect(screen.getByText("A keep")).toBeInTheDocument();
    expect(screen.getByText("A hide")).toBeInTheDocument();
    expect(screen.getByText("B child")).toBeInTheDocument();

    const solFilter = screen.getByRole("button", { name: /gpt-5\.6-sol/ });
    fireEvent.click(solFilter);
    expect(solFilter).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("A keep")).toBeInTheDocument();
    expect(screen.queryByText("A hide")).not.toBeInTheDocument();
    expect(screen.getByText("B child")).toBeInTheDocument();
  });

  it("keeps a matching child visible when its root is filtered out", async () => {
    const root = makeThreadSession({
      session_hash: "filtered-root",
      session_id: "90000000-0000-4000-8000-000000000000",
      root_session_hash: "filtered-root",
      title: "Root hidden by search",
    });
    const child = makeThreadSession({
      session_hash: "filtered-child",
      session_id: "a0000000-0000-4000-8000-000000000000",
      title: null,
      parent_session_id: root.session_id,
      parent_session_hash: root.session_hash,
      root_session_hash: root.session_hash,
      thread_kind: "subagent",
      agent_nickname: "Visible child only",
      agent_role: "luna",
      model: "gpt-5.6-luna",
    });
    getSessions.mockResolvedValue({
      ...response,
      session_count: 2,
      returned_count: 2,
      sessions: [root, child],
    });

    render(<SessionsPage />);
    expect(await screen.findByText("Root hidden by search")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search sessions" }), {
      target: { value: "Visible child only" },
    });

    await waitFor(() => {
      expect(screen.getByText("Visible child only")).toBeInTheDocument();
      expect(screen.queryByText("Root hidden by search")).not.toBeInTheDocument();
    });
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Expand .* subagents/ })).not.toBeInTheDocument();
  });

  it("filters the date range client-side without re-querying", async () => {
    getSessions.mockResolvedValue({
      ...response,
      session_count: 3,
      returned_count: 3,
      sessions: [
        { ...response.sessions[0], started_at: daysAgo(1), ended_at: daysAgo(1) },
        // Started well before a 7d window but ran into it: must stay visible.
        // Filtering on started_at alone used to drop exactly these.
        {
          ...response.sessions[1],
          session_hash: "spanning-row",
          title: "Long running migration",
          started_at: daysAgo(40),
          ended_at: daysAgo(2),
        },
        {
          ...response.sessions[1],
          session_hash: "old-row",
          title: "Ancient session",
          started_at: daysAgo(60),
          ended_at: daysAgo(59),
        },
      ],
    });

    render(<SessionsPage />);
    await screen.findByText("Ancient session");
    expect(getSessions).toHaveBeenCalledTimes(1);

    await chooseSelect("Filter by date range", "7d");

    expect(screen.getByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.getByText("Long running migration")).toBeInTheDocument();
    expect(screen.queryByText("Ancient session")).not.toBeInTheDocument();
    // Range chips filter what is already loaded — no extra round trip.
    expect(getSessions).toHaveBeenCalledTimes(1);
  });

  it("copies the project path from the project label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<SessionsPage />);
    await screen.findByText("Fix authentication flow");

    // Titled rows expose the path on the project chip; untitled rows put it on
    // the heading (which is the project name). Both must reach the same path.
    fireEvent.click(screen.getByRole("button", { name: "Copy the local path for tokentracker" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/work/tokentracker"));

    // The tooltip carries the full path plus the click-to-copy hint.
    expect(screen.getAllByRole("tooltip")[0]).toHaveTextContent("/work/tokentracker");
    expect(screen.getAllByRole("tooltip")[0]).toHaveTextContent("Click to copy this path");
  });

  it("reports a truncated list instead of silently dropping sessions", async () => {
    getSessions.mockResolvedValue({ ...response, session_count: 1297, returned_count: 2 });
    render(<SessionsPage />);
    expect(await screen.findByText(/1297/)).toBeInTheDocument();
  });

  it("shows a retryable error instead of the empty state when loading fails", async () => {
    getSessions.mockRejectedValueOnce(new Error("boom"));
    render(<SessionsPage />);

    expect(await screen.findByText("Could not load sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions yet")).not.toBeInTheDocument();

    getSessions.mockResolvedValue(response);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Fix authentication flow")).toBeInTheDocument();
  });

  it("keeps the start date on a row that crossed midnight into its date group", async () => {
    // Built in local time so the test means the same thing in every timezone.
    const started = new Date(2026, 6, 23, 23, 30);
    const ended = new Date(2026, 6, 24, 0, 20);
    const sameDay = new Date(2026, 6, 24, 9, 0);
    getSessions.mockResolvedValue({ ...response, sessions: [
      { ...response.sessions[0], session_hash: "overnight", title: "Overnight run", started_at: started.toISOString(), ended_at: ended.toISOString() },
      { ...response.sessions[1], session_hash: "morning", title: "Morning run", started_at: sameDay.toISOString(), ended_at: sameDay.toISOString() },
    ], session_count: 2, returned_count: 2 });
    render(<SessionsPage />);
    const overnight = (await screen.findByRole("button", { name: "View statistics for Overnight run" })).closest("li");
    const morning = screen.getByRole("button", { name: "View statistics for Morning run" }).closest("li");
    // Match the mocked UI locale, rather than the Windows host's default.
    const day = started.toLocaleDateString("en", { day: "numeric" });
    expect(within(overnight).getByText((text) => text.includes(day) && /\d{4}/.test(text))).toBeInTheDocument();
    expect(within(morning).queryByText(/\d{4}/)).not.toBeInTheDocument();
  });

  it("renders no header element, which the macOS app pads by 36px", async () => {
    // DashboardWindowController injects `.native-app header { padding-top: 36px }`,
    // so a header element here sits lower than every other page's title in the app.
    render(<SessionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "View statistics for Fix authentication flow" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(document.querySelector("header")).toBeNull();
  });

  it("renders a bounded window of rows and extends it on demand", async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      ...response.sessions[0],
      session_hash: `row-${index}`,
      title: `Session ${index}`,
    }));
    getSessions.mockResolvedValue({
      ...response,
      session_count: many.length,
      returned_count: many.length,
      sessions: many,
    });

    render(<SessionsPage />);
    await screen.findByText("Session 0");
    expect(screen.getByText("Session 99")).toBeInTheDocument();
    expect(screen.queryByText("Session 100")).not.toBeInTheDocument();

    await chooseSelect("Group sessions", "By project");
    expect(screen.getByRole("heading", { name: "tokentracker" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /View statistics for/ })).toHaveLength(100);
    expect(screen.queryByText("Session 100")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more sessions" }));
    expect(await screen.findByText("Session 149")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /View statistics for/ })).toHaveLength(150);
  });

  it("applies deep link dates, source, and model together without resetting other filters", async () => {
    window.history.replaceState(null, "", "/sessions?source=codex&model=gpt-5.6-sol&from=2026-07-23&to=2026-07-23");
    render(<SessionsPage />);

    expect(await screen.findByText("Review release")).toBeInTheDocument();
    expect(screen.queryByText("Fix authentication flow")).not.toBeInTheDocument();
    expect(screen.queryByText("Debug local proxy")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Sessions from")).toHaveValue("2026-07-23");
    expect(screen.getByLabelText("Sessions through")).toHaveValue("2026-07-23");
    expect(screen.getByRole("button", { name: "Filter by session model" })).toHaveTextContent("gpt-5.6-sol");
    const summary = screen.getByText("Matching sessions").closest("dl");
    expect(within(summary).getByText("8K")).toBeInTheDocument();
    expect(within(summary).getByText("$0.10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
    fireEvent.click(await screen.findByRole("option", { name: "tokentracker" }));
    expect(screen.getByText("No matching sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter by session model" })).toHaveTextContent("gpt-5.6-sol");
    expect(screen.getByLabelText("Sessions from")).toHaveValue("2026-07-23");

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("Fix authentication flow")).toBeInTheDocument();
    expect(screen.getByText("Debug local proxy")).toBeInTheDocument();
    expect(getSessions).toHaveBeenCalledTimes(1);
  });

  it("filters whole mixed model sessions and recomputes their full own consumption", async () => {
    const mixed = makeThreadSession({
      title: "Mixed models",
      own_total_tokens: 5000,
      total_tokens: 5000,
      own_cost_usd: 0.5,
      model_usage: [{ model: "model-a", total_tokens: 3000 }, { model: "model-b", total_tokens: 2000 }],
    });
    const child = makeThreadSession({
      session_hash: "child-b",
      root_session_hash: mixed.session_hash,
      parent_session_hash: mixed.session_hash,
      thread_kind: "subagent",
      agent_nickname: "Child B",
      title: null,
      model: "model-b",
      own_total_tokens: 1000,
      own_cost_usd: 0.1,
      combined_total_tokens: 4000,
    });
    getSessions.mockResolvedValue({ ...response, sessions: [mixed, child, response.sessions[0]] });
    render(<SessionsPage />);
    await screen.findByText("Mixed models");
    fireEvent.click(screen.getByRole("button", { name: "Filter by session model" }));
    fireEvent.click(await screen.findByRole("option", { name: "model-b" }));
    expect(screen.queryByText("Fix authentication flow")).not.toBeInTheDocument();
    const summary = screen.getByText("Matching sessions").closest("dl");
    expect(within(summary).getByText("2")).toBeInTheDocument();
    expect(within(summary).getByText("6K")).toBeInTheDocument();
    expect(within(summary).getByText("$0.60")).toBeInTheDocument();
    expect(screen.queryByText("Child B")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand 1 subagents" }));
    expect(screen.getByText("Child B")).toBeInTheDocument();
  });

  it("groups by project and sorts sessions by cost and tokens", async () => {
    getSessions.mockResolvedValue({ ...response, sessions: response.sessions.map((session) => ({ ...session, ended_at: "2026-07-24T08:30:00Z" })) });
    render(<SessionsPage />);
    await screen.findByText("Fix authentication flow");
    await chooseSelect("Sort sessions", "Most tokens");
    expect(screen.getAllByRole("button", { name: /View statistics for/ }).map((button) => button.getAttribute("aria-label"))).toEqual([
      "View statistics for Debug local proxy", "View statistics for Fix authentication flow", "View statistics for Review release",
    ]);
    await chooseSelect("Sort sessions", "Highest cost");
    expect(screen.getAllByRole("button", { name: /View statistics for/ })[0]).toHaveAccessibleName("View statistics for Fix authentication flow");
    await chooseSelect("Group sessions", "By project");
    expect(screen.getByRole("heading", { name: "tokentracker" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "lumaradio" })).toBeInTheDocument();
  });

  it("opens metadata details with weighted timing, model pricing, keyboard focus, and no message bodies", async () => {
    const performance = {
      estimated_output_tokens: 300,
      estimated_duration_ms: 10000,
      estimated_request_count: 2,
      estimated_tokens_per_second: 30,
      first_response_total_ms: 2500,
      first_response_sample_count: 2,
      first_response_ms: 1250,
    };
    const session = {
      ...response.sessions[0],
      input_tokens: 700,
      output_tokens: 300,
      cached_input_tokens: 100,
      cache_creation_input_tokens: 50,
      reasoning_output_tokens: 0,
      cost_source: "model_pricing",
      cost_is_partial: true,
      tool_calls: 3,
      performance,
      messages: [{ content: "private body must never render" }],
      model_usage: [
        { model: "priced-model", total_tokens: 1100, cost_usd: 0.25, performance, pricing: { status: "priced", source: "curated", input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } },
        { model: "unpriced-model", total_tokens: 50, cost_usd: 0, pricing: { status: "unpriced", source: null } },
      ],
    };
    getSessions.mockResolvedValue({ ...response, sessions: [session] });
    render(<SessionsPage />);
    const opener = await screen.findByRole("button", { name: "View statistics for Fix authentication flow" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Session statistics" });
    const close = within(dialog).getByRole("button", { name: "Close session statistics" });
    expect(close).toHaveFocus();
    expect(within(dialog).getAllByText("≈30 tok/s")).toHaveLength(2);
    expect(within(dialog).getByText("1.25s · 2 samples")).toBeInTheDocument();
    expect(within(dialog).getByText(/No published rate/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Model pricing estimate/)).toBeInTheDocument();
    expect(within(dialog).getByText(/USD \/ million tokens.*Input 2/)).toBeInTheDocument();
    expect(within(dialog).getByText("Tool calls").parentElement).toHaveTextContent("Not recorded");
    expect(screen.queryByText("private body must never render")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    const user = userEvent.setup();
    await user.tab();
    const pricingSummary = within(dialog).getAllByText(copy("sessions.detail.pricing_details"))[0].closest("summary");
    expect(pricingSummary).toHaveFocus();
    await user.click(pricingSummary);
    expect(pricingSummary.closest("details")).toHaveAttribute("open");
    const summaries = dialog.querySelectorAll("summary");
    const lastSummary = summaries[summaries.length - 1];
    lastSummary.focus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(lastSummary).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps reported Grok costs when its model has no public rate", async () => {
    const session = {
      ...response.sessions[2],
      model: "unknown-grok-model",
      model_usage: [{ model: "unknown-grok-model", total_tokens: 204293, cost_usd: 0.130486, pricing: { status: "unpriced", source: null } }],
    };
    getSessions.mockResolvedValue({ ...response, sessions: [session] });
    render(<SessionsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "View statistics for Debug local proxy" }));
    const dialog = screen.getByRole("dialog", { name: "Session statistics" });
    const modelRow = within(dialog).getByText("unknown-grok-model").closest("li");
    expect(modelRow).toHaveTextContent("$0.13");
    expect(modelRow).toHaveTextContent("No published rate");
    expect(within(dialog).getByText("Tool calls").parentElement).toHaveTextContent("5");
    expect(within(dialog).getByText("Model calls").parentElement).toHaveTextContent("7");
  });

  it("copies each provider resume command from its row action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SessionsPage />);
    await screen.findByText("Fix authentication flow");
    for (const session of response.sessions) {
      fireEvent.click(screen.getByRole("button", { name: `Copy resume command: ${session.resume_command}` }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(session.resume_command));
    }
  });

  it("shows custom dates on demand and explains totals through the help control", async () => {
    render(<SessionsPage />);
    await screen.findByText("Fix authentication flow");
    expect(screen.queryByLabelText("Sessions from")).not.toBeInTheDocument();
    await chooseSelect("Filter by date range", "Custom");
    expect(screen.getByLabelText("Sessions from")).toHaveValue("");
    expect(screen.getByLabelText("Sessions through")).toHaveValue("");
    const scope = copy("sessions.summary.scope");
    expect(screen.queryByText(scope)).not.toBeInTheDocument();
    const user = userEvent.setup();
    const help = screen.getByRole("button", { name: copy("sessions.summary.scope_help") });
    await user.hover(help);
    expect(await screen.findByText(scope)).toBeInTheDocument();
    await user.unhover(help);
    await waitFor(() => expect(screen.queryByText(scope)).not.toBeInTheDocument());
    await user.click(help);
    expect(await screen.findByText(scope)).toBeInTheDocument();
    expect(getSessions).toHaveBeenCalledTimes(1);
  });

  it("opens the speed explanation on keyboard focus and dismisses it with Escape", async () => {
    render(<SessionsPage />);
    await screen.findByText("Fix authentication flow");
    const user = userEvent.setup();
    const help = screen.getByRole("button", { name: copy("sessions.summary.scope_help") });
    expect(help.closest("dt")).toHaveTextContent(copy("sessions.summary.speed"));

    screen.getByRole("button", { name: copy("sessions.filter.model_aria") }).focus();
    await user.tab();
    expect(help).toHaveFocus();
    expect(await screen.findByText(copy("sessions.summary.scope"))).toHaveAttribute("role", "tooltip");
    expect(help).toHaveAccessibleDescription(copy("sessions.summary.scope"));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText(copy("sessions.summary.scope"))).not.toBeInTheDocument());
    expect(help).toHaveFocus();
    expect(help).not.toHaveAttribute("aria-describedby");

    await user.tab();
    await user.tab({ shift: true });
    expect(help).toHaveFocus();
    expect(await screen.findByText(copy("sessions.summary.scope"))).toHaveAttribute("role", "tooltip");
    expect(getSessions).toHaveBeenCalledTimes(1);
  });
});
