import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage.jsx";

const nativeSettingsMock = vi.hoisted(() => ({
  windows: false,
  available: true,
  settings: {
    toastOnReset: true,
    confettiOnReset: true,
  },
  setSetting: vi.fn(),
}));

const proxySettingsMock = vi.hoisted(() => ({
  available: false,
}));
const profileSettingsMock = vi.hoisted(() => ({
  settings: { enabled: false, signedIn: false, userId: "shared-settings-user" },
  hook: vi.fn(), accountReceived: null, cloudReceived: null, cloudActive: null, navigate: null,
}));

const LABELS = {
  "settings.page.title": "Settings",
  "settings.page.subtitle": "Manage your preferences",
  "settings.nav.group.personal": "Personal",
  "settings.nav.group.app": "App",
  "settings.nav.group.developer": "Developer",
  "settings.section.appearance": "Appearance",
  "settings.section.appearance.description": "Theme and display preferences",
  "settings.section.menubar": "App & Updates",
  "settings.section.menubar.description": "Background sync and updates",
  "settings.section.account": "Account",
  "settings.section.account.description": "Public profile and account details",
  "settings.section.cloud": "Cloud",
  "settings.section.cloud.description": "Cloud membership, billing and sync",
  "settings.section.limits": "Usage & Limits",
  "settings.section.limits.description": "Usage display and providers",
  "settings.section.labs": "Labs",
  "settings.section.labs.description": "Experimental insights",
  "settings.section.network": "Network",
  "settings.section.network.description": "Proxy configuration",
  "settings.limits.providers": "Providers",
  "limits.settings.display_mode_label": "Usage Display",
  "settings.menubar.toastOnReset": "Toast on limits reset",
  "settings.menubar.toastOnResetHint": "Show a useful reset message",
  "settings.menubar.confettiOnReset": "Confetti on limits reset",
  "settings.menubar.confettiOnResetHint": "Play the reset celebration effect",
};

vi.mock("../lib/copy", () => ({
  copy: (key) => LABELS[key] || key,
}));

vi.mock("../lib/native-bridge", () => ({
  isNativeApp: () => true,
  isNativeWindowsApp: () => nativeSettingsMock.windows,
  isBridgeAvailable: () => nativeSettingsMock.available,
}));

vi.mock("../hooks/use-limits-display-prefs.js", () => ({
  LIMIT_DISPLAY_MODES: { USED: "used", REMAINING: "remaining" },
  useLimitsDisplayPrefs: () => ({
    displayMode: "used",
    setDisplayMode: vi.fn(),
  }),
}));

vi.mock("../hooks/use-native-settings.js", () => ({
  useNativeSettings: () => ({
    available: nativeSettingsMock.available,
    settings: nativeSettingsMock.settings,
    setSetting: nativeSettingsMock.setSetting,
  }),
}));

vi.mock("../hooks/use-proxy-settings.js", () => ({
  useProxySettings: () => ({
    available: proxySettingsMock.available,
    loading: false,
    config: { mode: "system", protocol: "http", host: "", port: "", effective: "none" },
    save: vi.fn(),
    testConnection: vi.fn(),
  }),
}));

vi.mock("../components/settings/AppearanceSection.jsx", () => ({
  AppearanceSection: () => <div data-testid="appearance-content" />,
}));

vi.mock("../components/settings/MenuBarSection.jsx", () => ({
  MenuBarSection: () => <div data-testid="native-content" />,
  NativeAppFooter: () => <footer data-testid="settings-footer" />,
}));

vi.mock("../components/settings/AccountSection.jsx", () => ({
  AccountSection: ({ settings }) => { profileSettingsMock.accountReceived = settings; return <div data-testid="account-content" />; },
}));
vi.mock("../components/settings/CloudSection.jsx", () => ({
  CloudSection: ({ settings, active }) => { profileSettingsMock.cloudReceived = settings; profileSettingsMock.cloudActive = active; return <div data-testid="cloud-content" />; },
}));
vi.mock("../components/settings/useAccountProfileSettings.js", () => ({
  useAccountProfileSettings: () => { profileSettingsMock.hook(); return profileSettingsMock.settings; },
}));

vi.mock("../components/settings/LabsSection.jsx", () => ({
  LabsSection: () => <div data-testid="labs-content" />,
}));

vi.mock("../components/settings/NetworkSection.jsx", () => ({
  NetworkSection: () => <div data-testid="network-content" />,
}));

vi.mock("../components/LimitsSettingsPanel.jsx", () => ({
  LimitsSettingsPanel: () => <div data-testid="limits-content" />,
}));

vi.mock("../components/settings/Controls.jsx", () => ({
  SectionCard: ({ title, children }) => (
    <div data-testid="section-card" data-section-card-title={title}>
      {children}
    </div>
  ),
  SettingsRow: ({ label, control }) => (
    <div>
      <span>{label}</span>
      {control}
    </div>
  ),
  SegmentedControl: () => <div data-testid="limits-mode" />,
  ToggleSwitch: ({ checked, onChange, disabled, ariaLabel }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
    />
  ),
}));

function Location() {
  const location = useLocation();
  profileSettingsMock.navigate = useNavigate();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}
function renderSettings(initialPath = "/settings") {
  return render(
    <MemoryRouter initialEntries={Array.isArray(initialPath) ? initialPath : [initialPath]}>
      <SettingsPage />
      <Location />
    </MemoryRouter>,
  );
}

describe("SettingsPage category navigation", () => {
  beforeEach(() => {
    nativeSettingsMock.windows = false;
    nativeSettingsMock.available = true;
    nativeSettingsMock.settings = {
      toastOnReset: true,
      confettiOnReset: true,
    };
    nativeSettingsMock.setSetting.mockReset();
    proxySettingsMock.available = false;
    profileSettingsMock.hook.mockReset();
    profileSettingsMock.accountReceived = null;
    profileSettingsMock.cloudReceived = null;
    profileSettingsMock.cloudActive = null;
  });

  it("hides macOS reset controls on Windows before native settings arrive", () => {
    nativeSettingsMock.windows = true;
    nativeSettingsMock.settings = null;
    const view = renderSettings("/settings?section=limits");
    expect(screen.queryByRole("switch", { name: "Toast on limits reset" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Confetti on limits reset" })).toBeNull();

    nativeSettingsMock.settings = { platform: "windows" };
    view.rerender(<MemoryRouter initialEntries={["/settings?section=limits"]}><SettingsPage /></MemoryRouter>);
    expect(screen.queryByRole("switch", { name: "Toast on limits reset" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Confetti on limits reset" })).toBeNull();
  });

  it("switches the visible category while keeping every section mounted", async () => {
    const user = userEvent.setup();
    const { container } = renderSettings();

    const appearanceButton = screen.getByRole("button", { name: "Appearance" });
    const accountButton = screen.getByRole("button", { name: "Account" });
    const appearancePanel = container.querySelector('[data-settings-panel="appearance"]');
    const accountPanel = container.querySelector('[data-settings-panel="account"]');

    expect(screen.getByText("Manage your preferences")).toBeInTheDocument();
    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("Developer")).toBeInTheDocument();
    expect(appearanceButton).toHaveAttribute("aria-current", "page");
    expect(appearancePanel).not.toHaveAttribute("hidden");
    expect(accountPanel).toHaveAttribute("hidden");
    expect(screen.getByTestId("appearance-content")).toBeInTheDocument();
    expect(screen.getByTestId("account-content")).toBeInTheDocument();

    await act(async () => {
      await user.click(accountButton);
    });

    expect(accountButton).toHaveAttribute("aria-current", "page");
    expect(appearanceButton).not.toHaveAttribute("aria-current");
    expect(appearancePanel).toHaveAttribute("hidden");
    expect(accountPanel).not.toHaveAttribute("hidden");
  });

  it("opens the dedicated Personal Cloud panel from its deep link with one shared account state", async () => {
    const { container } = renderSettings("/settings?section=cloud&source=trial");
    const cloudButton = screen.getByRole("button", { name: "Cloud", exact: true });
    const accountButton = screen.getByRole("button", { name: "Account", exact: true });
    const cloudPanel = container.querySelector('[data-settings-panel="cloud"]');
    const accountPanel = container.querySelector('[data-settings-panel="account"]');
    expect(profileSettingsMock.hook).toHaveBeenCalledTimes(1);
    expect(profileSettingsMock.accountReceived).toBe(profileSettingsMock.settings);
    expect(profileSettingsMock.cloudReceived).toBe(profileSettingsMock.settings);
    expect(cloudButton).toHaveAttribute("aria-current", "page");
    expect(cloudButton).toHaveAttribute("aria-controls", "settings-panel-cloud");
    expect(cloudPanel).toHaveAttribute("aria-labelledby", "settings-nav-cloud");
    expect(cloudPanel).not.toHaveAttribute("hidden");
    expect(container.firstChild).toHaveClass("tt-cloud-settings");
    expect(screen.queryByText("Cloud membership, billing and sync")).not.toBeInTheDocument();
    expect(accountPanel).toHaveAttribute("hidden");
    expect(cloudButton.closest("nav").textContent).toContain("Personal");
    await act(async () => { await userEvent.click(accountButton); });
    expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=account&source=trial");
    expect(accountButton).toHaveFocus();
    expect(accountPanel).not.toHaveAttribute("hidden");
    expect(cloudPanel).toHaveAttribute("hidden");
    expect(container.firstChild).not.toHaveClass("tt-cloud-settings");
    await act(async () => { await userEvent.click(cloudButton); });
    expect(cloudButton).toHaveFocus();
    expect(container.firstChild).toHaveClass("tt-cloud-settings");
    expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=cloud&source=trial");
    expect(screen.getByTestId("account-content")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-content")).toBeInTheDocument();
  });

  it("deactivates Cloud portals on browser Back while retaining the shared account section state", async () => {
    renderSettings(["/settings?section=account", "/settings?section=cloud"]);
    expect(profileSettingsMock.cloudActive).toBe(true);
    await act(async () => { profileSettingsMock.navigate(-1); });
    expect(screen.getByTestId("location")).toHaveTextContent("/settings?section=account");
    expect(profileSettingsMock.cloudActive).toBe(false);
    expect(screen.getByTestId("cloud-content")).toBeInTheDocument();
    expect(profileSettingsMock.cloudReceived).toBe(profileSettingsMock.settings);
    await act(async () => { profileSettingsMock.navigate(1); });
    expect(profileSettingsMock.cloudActive).toBe(true);
  });

  it("omits the network category when the local proxy API is unavailable", () => {
    proxySettingsMock.available = false;
    const { container } = renderSettings();

    expect(screen.queryByRole("button", { name: "Network" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-settings-panel="network"]')).toBeNull();
  });

  it("shows the network category when the local proxy API is available", () => {
    proxySettingsMock.available = true;
    const { container } = renderSettings();

    expect(screen.getByRole("button", { name: "Network" })).toBeInTheDocument();
    expect(container.querySelector('[data-settings-panel="network"]')).not.toBeNull();
    expect(screen.getByTestId("network-content")).toBeInTheDocument();
  });

  it("omits the native-app category when the native bridge is unavailable", () => {
    nativeSettingsMock.available = false;
    const { container } = renderSettings();

    expect(screen.queryByRole("button", { name: "App & Updates" })).not.toBeInTheDocument();
    expect(container.querySelector('[data-settings-panel="native-app"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps reset feedback settings visible but disabled without the native bridge", () => {
    nativeSettingsMock.available = false;
    renderSettings("/settings?section=limits");

    expect(screen.getByRole("switch", { name: "Toast on limits reset" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Confetti on limits reset" })).toBeDisabled();
  });

  it("selects Usage & Limits from a settings deep link", () => {
    const { container } = renderSettings("/settings?section=limits");

    expect(screen.getByRole("button", { name: "Usage & Limits" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(container.querySelector('[data-settings-panel="limits"]')).not.toHaveAttribute("hidden");
    expect(container.querySelector('[data-settings-panel="appearance"]')).toHaveAttribute("hidden");
  });

  it("offers independent reset toast and confetti settings in Usage & Limits", async () => {
    const user = userEvent.setup();
    renderSettings("/settings?section=limits");

    const toastSwitch = screen.getByRole("switch", { name: "Toast on limits reset" });
    const confettiSwitch = screen.getByRole("switch", { name: "Confetti on limits reset" });

    expect(toastSwitch).toHaveAttribute("aria-checked", "true");
    expect(confettiSwitch).toHaveAttribute("aria-checked", "true");

    await act(async () => {
      await user.click(toastSwitch);
      await user.click(confettiSwitch);
    });

    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("toastOnReset", false);
    expect(nativeSettingsMock.setSetting).toHaveBeenCalledWith("confettiOnReset", false);
  });

  it("groups display mode and reset feedback above the provider list", () => {
    renderSettings("/settings?section=limits");

    const [settingsCard, providersCard] = screen.getAllByTestId("section-card");
    expect(settingsCard.dataset.sectionCardTitle).toBe("Usage & Limits");
    expect(within(settingsCard).getByTestId("limits-mode")).toBeInTheDocument();
    expect(within(settingsCard).getByRole("switch", { name: "Toast on limits reset" })).toBeInTheDocument();
    expect(within(settingsCard).getByRole("switch", { name: "Confetti on limits reset" })).toBeInTheDocument();

    expect(providersCard.dataset.sectionCardTitle).toBe("Providers");
    expect(within(providersCard).getByTestId("limits-content")).toBeInTheDocument();
  });
});
