import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copy } from "../lib/copy";
import {
  addSkillRepo,
  checkSkillUpdates,
  getAccountSkillInventories,
  deleteLocalSkill,
  discoverSkills,
  getInstalledSkills,
  getSkillRepos,
  importLocalSkill,
  installSkill,
  publishSkillInventory,
  removeSkillRepo,
  restoreSkill,
  searchSkills,
  setSkillTargets,
  uninstallSkill,
  updateSkills,
} from "../lib/skills-api";
import { buildLocallyInstalledKeys, SkillsPage } from "./SkillsPage.jsx";

vi.mock("../lib/skills-api", () => ({
  addSkillRepo: vi.fn(),
  checkSkillUpdates: vi.fn(),
  updateSkills: vi.fn(),
  getAccountSkillInventories: vi.fn(),
  deleteLocalSkill: vi.fn(),
  discoverSkills: vi.fn(),
  getInstalledSkills: vi.fn(),
  getSkillRepos: vi.fn(),
  importLocalSkill: vi.fn(),
  installSkill: vi.fn(),
  publishSkillInventory: vi.fn(),
  removeSkillRepo: vi.fn(),
  restoreSkill: vi.fn(),
  searchSkills: vi.fn(),
  setSkillTargets: vi.fn(),
  uninstallSkill: vi.fn(),
}));

const toastSpy = vi.hoisted(() => vi.fn());

vi.mock("../ui/components/Toast.jsx", () => ({
  showToast: toastSpy,
  toastManager: { add: vi.fn() },
  ToastProvider: ({ children }) => children,
}));

const testAuth = vi.hoisted(() => ({
  signedIn: true,
  getAccessToken: async () => "test-access-token",
}));

vi.mock("../contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => testAuth,
}));

beforeEach(() => {
  window.history.replaceState({}, "", "/skills");
  localStorage.removeItem("tokentracker_cloud_device_id_v1");
  vi.mocked(getInstalledSkills).mockResolvedValue({
    targets: [
      { id: "claude", label: "Claude" },
      { id: "grok", label: "Grok" },
      { id: "antigravity", label: "Antigravity" },
    ],
    skills: [
      {
        id: "alpha-skill",
        name: "Alpha Skill",
        directory: "alpha-skill",
        description: "First installed skill.",
        targets: ["claude", "grok", "antigravity"],
        managed: true,
      },
      {
        id: "beta-skill",
        name: "Beta Skill",
        directory: "beta-skill",
        description: "Second installed skill.",
        targets: ["claude"],
        managed: true,
      },
    ],
  });
  vi.mocked(getSkillRepos).mockResolvedValue({ repos: [] });
  vi.mocked(discoverSkills).mockResolvedValue({ skills: [] });
  vi.mocked(searchSkills).mockResolvedValue({ skills: [] });
  vi.mocked(installSkill).mockResolvedValue({ ok: true });
  vi.mocked(getAccountSkillInventories).mockResolvedValue({ devices: [] });
  vi.mocked(publishSkillInventory).mockResolvedValue({ ok: true });
  vi.mocked(uninstallSkill).mockResolvedValue({ ok: true });
  vi.mocked(restoreSkill).mockResolvedValue({ ok: true });
  vi.mocked(setSkillTargets).mockResolvedValue({ ok: true });
  vi.mocked(importLocalSkill).mockResolvedValue({ ok: true });
  vi.mocked(deleteLocalSkill).mockResolvedValue({ ok: true });
  vi.mocked(addSkillRepo).mockResolvedValue({ ok: true });
  vi.mocked(removeSkillRepo).mockResolvedValue({ ok: true });
  vi.mocked(checkSkillUpdates).mockResolvedValue({ updates: {} });
  vi.mocked(updateSkills).mockResolvedValue({ results: [], updated: 0, skipped: 0, failed: 0, rateLimited: null });
  toastSpy.mockClear();
});

describe("SkillsPage", () => {
  it("renders installed skills instead of the empty state", async () => {
    render(<SkillsPage />);

    expect(await screen.findByText("Alpha Skill")).toBeInTheDocument();
    expect(screen.getByText("Beta Skill")).toBeInTheDocument();
    expect(screen.getByText("First installed skill.")).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: copy("skills.action.search_aria") }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByText(copy("skills.empty.my"))).not.toBeInTheDocument();
    });
  });

  it("filters the My tab list client-side by search query", async () => {
    const user = userEvent.setup();
    render(<SkillsPage />);

    expect(await screen.findByText("Alpha Skill")).toBeInTheDocument();
    expect(screen.getByText("Beta Skill")).toBeInTheDocument();

    const searchInput = screen.getByRole("searchbox", {
      name: copy("skills.action.search_aria"),
    });
    await user.type(searchInput, "alpha");

    await waitFor(() => {
      expect(screen.getByText("Alpha Skill")).toBeInTheDocument();
      expect(screen.queryByText("Beta Skill")).not.toBeInTheDocument();
    });
    expect(searchSkills).not.toHaveBeenCalled();
  });

  it("clears My tab search when clear search is clicked", async () => {
    const user = userEvent.setup();
    render(<SkillsPage />);

    expect(await screen.findByText("Alpha Skill")).toBeInTheDocument();

    const searchInput = screen.getByRole("searchbox", {
      name: copy("skills.action.search_aria"),
    });
    await user.type(searchInput, "alpha");

    await waitFor(() => {
      expect(screen.queryByText("Beta Skill")).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: copy("skills.action.search_clear") }));

    await waitFor(() => {
      expect(screen.getByText("Beta Skill")).toBeInTheDocument();
      expect(searchInput).toHaveValue("");
    });
  });

  it("shows inventory-only skills as read-only and excludes them from destructive actions", async () => {
    const user = userEvent.setup();
    vi.mocked(getInstalledSkills).mockResolvedValue({
      targets: [
        { id: "codex", label: "Codex", manageable: true },
        { id: "zcode", label: "ZCode", manageable: false },
      ],
      skills: [{
        id: "inventory:zcode:plugin:guide:diagnostics",
        key: "inventory:zcode:plugin:guide:diagnostics",
        name: "ZCode Diagnostics",
        directory: "diagnostics",
        targets: ["zcode"],
        targetStates: { zcode: "synced" },
        managed: false,
        readOnly: true,
        inventoryOnly: true,
        scope: "plugin",
        sourceName: "zcode-official/guide",
      }],
    });

    render(<SkillsPage />);

    expect(await screen.findByText("ZCode Diagnostics")).toBeInTheDocument();
    expect(screen.getByText(copy("skills.inventory.plugin"))).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", {
      name: copy("skills.select.row_aria", { name: "ZCode Diagnostics" }),
    })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", {
      name: copy("skills.row.open_details", { name: "ZCode Diagnostics" }),
    }));
    expect(await screen.findByText(copy("skills.inventory.read_only_managed"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy("skills.detail.remove_button") })).not.toBeInTheDocument();
  });

  it("keeps unmanaged skill selection isolated by directory", async () => {
    const user = userEvent.setup();
    vi.mocked(getInstalledSkills).mockResolvedValue({
      targets: [{ id: "claude", label: "Claude" }],
      skills: [
        { name: "Local Alpha", directory: "local-alpha", targets: ["claude"], managed: false },
        { name: "Local Beta", directory: "local-beta", targets: ["claude"], managed: false },
      ],
    });

    render(<SkillsPage />);

    const alpha = await screen.findByRole("checkbox", {
      name: copy("skills.select.row_aria", { name: "Local Alpha" }),
    });
    const beta = screen.getByRole("checkbox", {
      name: copy("skills.select.row_aria", { name: "Local Beta" }),
    });
    await user.click(alpha);

    expect(alpha).toBeChecked();
    expect(beta).not.toBeChecked();
    expect(screen.getByText(copy("skills.select.count", { count: 1 }))).toBeInTheDocument();
  });

  it("does not mark an unrelated browse skill installed when only the nested local leaf matches", async () => {
    const user = userEvent.setup();
    vi.mocked(getInstalledSkills).mockResolvedValue({
      targets: [
        { id: "claude", label: "Claude" },
        { id: "codex", label: "Codex" },
      ],
      skills: [
        {
          id: "local:apple/apple-notes",
          name: "Local Apple Notes",
          directory: "apple/apple-notes",
          description: "Nested local skill.",
          targets: ["claude"],
          managed: true,
        },
      ],
    });
    vi.mocked(getSkillRepos).mockResolvedValue({
      repos: [{ owner: "someone", name: "unrelated-skills", branch: "main", enabled: true }],
    });
    vi.mocked(discoverSkills).mockResolvedValue({
      skills: [
        {
          key: "someone/unrelated-skills:apple-notes",
          name: "Remote Apple Notes",
          directory: "apple-notes",
          description: "Different remote skill with the same leaf name.",
          repoOwner: "someone",
          repoName: "unrelated-skills",
          repoBranch: "main",
        },
      ],
    });

    render(<SkillsPage />);

    expect(await screen.findByText("Local Apple Notes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: copy("skills.tab.browse") }));

    expect(await screen.findByText("Remote Apple Notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy("skills.action.install") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy("skills.card.manage") })).not.toBeInTheDocument();
  });

  it("keeps remote-only inventory rows installable from Browse", () => {
    const keys = buildLocallyInstalledKeys([
      {
        key: "local/local:remote-only",
        directory: "remote-only",
        readOnly: true,
        inventoryOnly: true,
        remote: true,
      },
      {
        key: "local/local:plugin-only",
        directory: "plugin-only",
        readOnly: true,
      },
      {
        key: "local/local:installed",
        directory: "installed",
      },
    ]);

    expect(keys.has("local/local:remote-only")).toBe(false);
    expect(keys.has("dir:remote-only")).toBe(false);
    expect(keys.has("local/local:plugin-only")).toBe(false);
    expect(keys.has("dir:plugin-only")).toBe(false);
    expect(keys.has("local/local:installed")).toBe(true);
    expect(keys.has("dir:installed")).toBe(true);
  });

  it("keeps the other-device view when publishing this device inventory fails", async () => {
    localStorage.setItem("tokentracker_cloud_device_id_v1", "this-device");
    vi.mocked(getInstalledSkills).mockResolvedValue({
      targets: [{ id: "codex", label: "Codex" }],
      skills: [],
    });
    vi.mocked(getAccountSkillInventories).mockResolvedValue({
      devices: [{
        id: "other-device",
        device_name: "Other PC",
        skills: [{
          key: "local/local:remote-only",
          name: "Remote Only Skill",
          directory: "remote-only",
          targets: ["codex"],
        }],
      }],
    });
    vi.mocked(publishSkillInventory).mockRejectedValue(new Error("device revoked"));

    render(<SkillsPage />);

    expect(await screen.findByText("Remote Only Skill")).toBeInTheDocument();
    await waitFor(() => expect(getAccountSkillInventories).toHaveBeenCalledWith("test-access-token"));
    expect(screen.getByText(copy("skills.inventory.remote"))).toBeInTheDocument();
  });
});

// updateSkills reports a rate limit as a return field, not a throw. handleUpdateAll
// branches on it; the per-row button used to fall through and toast success while
// the badge stayed up.
describe("SkillsPage per-row update", () => {
  async function openAlphaAndUpdate() {
    const user = userEvent.setup();
    render(<SkillsPage />);
    await user.click(
      await screen.findByRole("button", {
        name: copy("skills.row.open_details", { name: "Alpha Skill" }),
      }),
    );
    await user.click(await screen.findByRole("button", { name: copy("skills.update.action") }));
    return user;
  }

  beforeEach(() => {
    vi.mocked(checkSkillUpdates).mockResolvedValue({ updates: { "alpha-skill": true } });
    // handleUpdate needs the GitHub coordinates a managed skill always carries;
    // the shared fixture omits them.
    vi.mocked(getInstalledSkills).mockResolvedValue({
      targets: [{ id: "claude", label: "Claude" }],
      skills: [
        {
          id: "alpha-skill",
          name: "Alpha Skill",
          directory: "alpha-skill",
          sourceDirectory: "alpha-skill",
          description: "First installed skill.",
          targets: ["claude"],
          managed: true,
          repoOwner: "demo",
          repoName: "skills",
          repoBranch: "main",
        },
      ],
    });
  });

  it("reports a rate limit instead of claiming the skill was updated", async () => {
    vi.mocked(updateSkills).mockResolvedValue({
      results: [],
      updated: 0,
      skipped: 0,
      failed: 0,
      rateLimited: "GitHub rate-limited this request (HTTP 403). Try again later.",
    });

    await openAlphaAndUpdate();

    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    const titles = toastSpy.mock.calls.map(([options]) => options?.title);
    expect(titles).toContain(copy("skills.update.rate_limited", { count: 0 }));
    expect(titles).not.toContain(copy("skills.toast.updated", { name: "Alpha Skill" }));
  });

  it("does not toast success when the backend reports no rows at all", async () => {
    vi.mocked(updateSkills).mockResolvedValue({
      results: [],
      updated: 0,
      skipped: 0,
      failed: 0,
      rateLimited: null,
    });

    await openAlphaAndUpdate();

    await waitFor(() => {
      expect(screen.getByText(copy("skills.error.generic"))).toBeInTheDocument();
    });
    const titles = toastSpy.mock.calls.map(([options]) => options?.title);
    expect(titles).not.toContain(copy("skills.toast.updated", { name: "Alpha Skill" }));
  });

  it("still toasts success on a normal update", async () => {
    vi.mocked(updateSkills).mockResolvedValue({
      results: [{ id: "alpha-skill", name: "Alpha Skill", ok: true, skipped: false }],
      updated: 1,
      skipped: 0,
      failed: 0,
      rateLimited: null,
    });

    await openAlphaAndUpdate();

    await waitFor(() => {
      const titles = toastSpy.mock.calls.map(([options]) => options?.title);
      expect(titles).toContain(copy("skills.toast.updated", { name: "Alpha Skill" }));
    });
  });
});
