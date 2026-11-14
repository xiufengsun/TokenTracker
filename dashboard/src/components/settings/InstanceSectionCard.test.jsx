import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSectionCard } from "./InstanceSectionCard.jsx";

const hookMock = vi.hoisted(() => ({
  available: true,
  loading: false,
  config: {
    baseUrl: "https://srctyff5.us-east.insforge.app",
    officialUrl: "https://srctyff5.us-east.insforge.app",
    custom: false,
    dashboardUrl: "",
    anonKeySet: true,
    configurationError: null,
  },
  save: vi.fn(),
  test: vi.fn(),
}));

const resetMock = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/use-instance-settings.js", () => ({
  useInstanceSettings: () => hookMock,
}));

vi.mock("../../lib/insforge-config", () => ({
  resetInsforgeClientForInstanceChange: resetMock,
}));

vi.mock("../../lib/copy", () => ({
  copy: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
  getCopyLocale: () => "zh-CN",
}));

const OFFICIAL = "https://srctyff5.us-east.insforge.app";
const SELF_HOSTED = "https://insforge.self.example.com";
const ANON_KEY = `anon_${"a".repeat(40)}`;

describe("InstanceSectionCard", () => {
  beforeEach(() => {
    hookMock.available = true;
    hookMock.loading = false;
    hookMock.config = {
      baseUrl: OFFICIAL,
      officialUrl: OFFICIAL,
      custom: false,
      dashboardUrl: "",
      anonKeySet: true,
      configurationError: null,
    };
    hookMock.save.mockReset();
    hookMock.test.mockReset();
    hookMock.test.mockResolvedValue({ reachable: true, status: 200, error: null });
    resetMock.mockReset();
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
  });

  it("renders nothing when the local instance API is unavailable", () => {
    hookMock.available = false;
    const { container } = render(<InstanceSectionCard />);
    expect(container.textContent).toBe("");
  });

  it("shows the official cloud state with a self-hosted entry point", () => {
    render(<InstanceSectionCard />);

    expect(screen.getByText("settings.instance.official")).toBeTruthy();
    expect(screen.getByText("settings.instance.badge.official")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "settings.instance.action.useSelfHosted" }),
    ).toBeTruthy();
  });

  it("saves a self-hosted server, resets the SDK session and reloads", async () => {
    const user = userEvent.setup();
    hookMock.save.mockResolvedValue({
      ok: true,
      baseUrl: SELF_HOSTED,
      officialUrl: OFFICIAL,
      custom: true,
      dashboardUrl: SELF_HOSTED,
      anonKeySet: true,
      configurationError: null,
    });
    render(<InstanceSectionCard />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.useSelfHosted" }));
    });
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.url"), SELF_HOSTED);
      await user.type(screen.getByLabelText("settings.instance.field.anonKey"), ANON_KEY);
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.save" }));
    });

    expect(hookMock.save).toHaveBeenCalledWith({ baseUrl: SELF_HOSTED, anonKey: ANON_KEY });
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("settings.instance.applied");
  });

  it("maps API rejection reasons to localized messages", async () => {
    const user = userEvent.setup();
    hookMock.save.mockRejectedValue(new Error("instance_anon_key_required"));
    render(<InstanceSectionCard />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.useSelfHosted" }));
    });
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.url"), SELF_HOSTED);
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.save" }));
    });

    expect(screen.getByRole("alert").textContent).toBe("settings.instance.error.keyRequired");
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("offers restoring the official cloud while a custom instance is active", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      ...hookMock.config,
      baseUrl: SELF_HOSTED,
      custom: true,
      dashboardUrl: SELF_HOSTED,
    };
    hookMock.save.mockResolvedValue({
      ok: true,
      baseUrl: OFFICIAL,
      officialUrl: OFFICIAL,
      custom: false,
      dashboardUrl: "",
      anonKeySet: true,
      configurationError: null,
    });
    render(<InstanceSectionCard />);

    expect(screen.getByText(SELF_HOSTED)).toBeTruthy();
    expect(screen.getByText("settings.instance.badge.selfHosted")).toBeTruthy();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.edit" }));
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.restoreOfficial" }));
    });

    expect(hookMock.save).toHaveBeenCalledWith({ baseUrl: OFFICIAL });
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it("probes the entered address and reports both outcomes", async () => {
    const user = userEvent.setup();
    render(<InstanceSectionCard />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.useSelfHosted" }));
    });
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.url"), SELF_HOSTED);
    });

    hookMock.test.mockResolvedValue({ reachable: true, status: 200, error: null });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.test" }));
    });
    expect(hookMock.test).toHaveBeenCalledWith(SELF_HOSTED);
    expect(screen.getByRole("status").textContent)
      .toBe('settings.instance.test.ok:{"status":200}');

    hookMock.test.mockResolvedValue({ reachable: false, status: null, error: "unreachable" });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.test" }));
    });
    expect(screen.getByRole("status").textContent).toBe("settings.instance.test.unreachable");
  });

  it("asks a signed-in user to confirm a server switch before saving", async () => {
    const user = userEvent.setup();
    hookMock.save.mockResolvedValue({
      ok: true,
      baseUrl: SELF_HOSTED,
      officialUrl: OFFICIAL,
      custom: true,
      dashboardUrl: SELF_HOSTED,
      anonKeySet: true,
      configurationError: null,
    });
    render(<InstanceSectionCard signedIn />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.useSelfHosted" }));
    });
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.url"), SELF_HOSTED);
      await user.type(screen.getByLabelText("settings.instance.field.anonKey"), ANON_KEY);
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.save" }));
    });

    // No save yet — the switch drops the signed-in session, so confirm first.
    expect(hookMock.save).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("settings.instance.confirm.title");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.confirm.confirm" }));
    });
    expect(hookMock.save).toHaveBeenCalledWith({ baseUrl: SELF_HOSTED, anonKey: ANON_KEY });
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it("lets a signed-in user back out of the switch without saving", async () => {
    const user = userEvent.setup();
    render(<InstanceSectionCard signedIn />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.useSelfHosted" }));
    });
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.url"), SELF_HOSTED);
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.save" }));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "shared.action.cancel" }));
    });
    expect(hookMock.save).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });

  it("still confirms when a signed-in user only changes the anon key", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      ...hookMock.config,
      baseUrl: SELF_HOSTED,
      custom: true,
      dashboardUrl: SELF_HOSTED,
    };
    hookMock.save.mockResolvedValue({
      ok: true,
      baseUrl: SELF_HOSTED,
      officialUrl: OFFICIAL,
      custom: true,
      dashboardUrl: SELF_HOSTED,
      anonKeySet: true,
      configurationError: null,
    });
    render(<InstanceSectionCard signedIn />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.edit" }));
    });
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.anonKey"), ANON_KEY);
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.save" }));
    });

    // A new key invalidates the session material on the same server, so this
    // is a sign-out switch too and must confirm first.
    expect(hookMock.save).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.confirm.confirm" }));
    });
    expect(hookMock.save).toHaveBeenCalledWith({ baseUrl: SELF_HOSTED, anonKey: ANON_KEY });
  });

  it("does not treat a trailing slash as a different server", async () => {
    const user = userEvent.setup();
    hookMock.config = {
      ...hookMock.config,
      baseUrl: SELF_HOSTED,
      custom: true,
      dashboardUrl: SELF_HOSTED,
    };
    hookMock.save.mockResolvedValue({
      ok: true,
      baseUrl: SELF_HOSTED,
      officialUrl: OFFICIAL,
      custom: true,
      dashboardUrl: SELF_HOSTED,
      anonKeySet: true,
      configurationError: null,
    });
    render(<InstanceSectionCard signedIn />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.edit" }));
    });
    // The field is prefilled with the active server; append a trailing slash.
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.url"), "/");
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.save" }));
    });

    // Same server modulo the trailing slash and no key change: save directly.
    expect(hookMock.save).toHaveBeenCalledWith({ baseUrl: `${SELF_HOSTED}/`, anonKey: "" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("probes the active server on load and reflects its health next to the badge", async () => {
    hookMock.test.mockResolvedValue({ reachable: true, status: 200, error: null });
    render(<InstanceSectionCard />);
    await act(async () => {});

    expect(hookMock.test).toHaveBeenCalledWith(OFFICIAL);
    expect(screen.getByText("settings.instance.health.ok")).toBeTruthy();

    // A downed server flips the indicator.
    hookMock.test.mockResolvedValue({ reachable: false, status: null, error: "unreachable" });
    const { unmount } = render(<InstanceSectionCard />);
    await act(async () => {});
    expect(screen.getAllByText("settings.instance.health.unreachable").length).toBeGreaterThan(0);
    unmount();
  });

  it("treats a bare domain as https when testing and saving", async () => {
    const user = userEvent.setup();
    hookMock.test.mockResolvedValue({ reachable: true, status: 200, error: null });
    hookMock.save.mockResolvedValue({
      ok: true,
      baseUrl: "https://insforge.bare.example.com",
      officialUrl: OFFICIAL,
      custom: true,
      dashboardUrl: "https://insforge.bare.example.com",
      anonKeySet: true,
      configurationError: null,
    });
    render(<InstanceSectionCard />);

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.useSelfHosted" }));
    });
    await act(async () => {
      await user.type(screen.getByLabelText("settings.instance.field.url"), "insforge.bare.example.com");
    });

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.test" }));
    });
    expect(hookMock.test).toHaveBeenLastCalledWith("https://insforge.bare.example.com");
    expect(screen.getByDisplayValue("https://insforge.bare.example.com")).toBeTruthy();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.instance.action.save" }));
    });
    expect(hookMock.save).toHaveBeenCalledWith({
      baseUrl: "https://insforge.bare.example.com",
      anonKey: "",
    });
  });
});
