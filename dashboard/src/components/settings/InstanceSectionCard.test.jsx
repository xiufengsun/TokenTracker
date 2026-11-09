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
});
