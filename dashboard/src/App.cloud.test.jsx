/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://www.tokentracker.cc"} */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";

const labels = {
  cloud: "Public Cloud plans",
  checkout: "Owned Cloud checkout",
  selfHost: "Self-host deployment guidance",
  dashboard: "Account dashboard",
  shell: "App shell",
};
const auth = vi.hoisted(() => ({
  enabled: true,
  signedIn: false,
  loading: false,
  user: null,
  getAccessToken: vi.fn(),
}));
vi.mock("./contexts/InsforgeAuthContext.jsx", () => ({
  useInsforgeAuth: () => auth,
}));
vi.mock("./hooks/useLocale.js", () => ({
  useLocale: () => ({ resolvedLocale: "en" }),
}));
vi.mock("./hooks/use-cloud-usage-sync", () => ({ useCloudUsageSync: vi.fn() }));
vi.mock("./lib/mock-mode", () => ({ isMockEnabled: () => false }));
vi.mock("./lib/dashboard-preload.js", () => ({
  getLeaderboardPreloadContextKey: () => "test",
  markDashboardMainContentVisible: vi.fn(),
  preloadDashboardPageResources: vi.fn(),
  preloadLeaderboardDefaultState: vi.fn(),
}));
vi.mock("./ui/foundation/ThemeProvider.jsx", () => ({
  ThemeProvider: ({ children }) => children,
}));
vi.mock("./contexts/LoginModalContext.jsx", () => ({
  LoginModalProvider: ({ children }) => children,
}));
vi.mock("./components/LoginModal.jsx", () => ({ LoginModal: () => null }));
vi.mock("./ui/components/Sidebar.jsx", () => ({
  AppLayout: ({ children }) => <div aria-label={labels.shell}>{children}</div>,
}));
vi.mock("./ui/dashboard/components/CommandPalette.jsx", () => ({
  CommandPalette: () => null,
}));
vi.mock("./pages/CloudPage.jsx", () => ({
  CloudPage: () => <h1>{labels.cloud}</h1>,
}));
vi.mock("./pages/CloudCheckoutPage.jsx", () => ({
  CloudCheckoutPage: () => <h1>{labels.checkout}</h1>,
}));
vi.mock("./pages/SelfHostPage.jsx", () => ({
  SelfHostPage: () => <h1>{labels.selfHost}</h1>,
}));
vi.mock("./pages/DashboardPage.jsx", () => ({
  DashboardPage: () => <h1>{labels.dashboard}</h1>,
}));
vi.mock("./pages/LoginPage.jsx", () => ({
  LoginPage: () => <h1>{useLocation().pathname + useLocation().search}</h1>,
}));
vi.mock("@vercel/analytics/react", () => ({ Analytics: () => null }));
vi.mock("@vercel/speed-insights/react", () => ({ SpeedInsights: () => null }));

beforeEach(() => {
  auth.signedIn = false;
  auth.user = null;
  sessionStorage.clear();
});
afterEach(cleanup);

describe("Cloud public routing", () => {
  it("retains the protected account route when authentication must be restored", async () => {
    render(<MemoryRouter initialEntries={["/settings?section=account"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "/login?next=%2Fsettings%3Fsection%3Daccount" })).toBeInTheDocument();
  });
  it("does not carry OAuth credentials into the protected sign-in destination", async () => {
    render(<MemoryRouter initialEntries={["/dashboard?insforge_code=fixture-only-code&state=private-state&from=2026-10-01"]}><App /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "/login?next=%2Fdashboard%3Ffrom%3D2026-10-01" })).toBeInTheDocument();
  });
  it.each([
    ["/cloud", labels.cloud],
    ["/billing/checkout?sku=cloud_usd_yearly", labels.checkout],
    ["/self-host", labels.selfHost],
  ])(
    "keeps %s reachable for signed-out visitors on the public host",
    async (path, title) => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>,
      );
      expect(
        await screen.findByRole("heading", { name: title }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(labels.shell)).toBeInTheDocument();
    },
  );
  it.each(["/", "/dashboard"])("restores purchase intent after auth returns to %s", async (callbackPath) => {
    auth.signedIn = true;
    auth.user = { id: "account-1" };
    sessionStorage.setItem("tt.cloud.return", "/billing/checkout?intent=trial");
    render(
      <MemoryRouter initialEntries={[callbackPath]}>
        <App />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole("heading", { name: labels.checkout }),
    ).toBeInTheDocument();
    expect(sessionStorage.getItem("tt.cloud.return")).toBeNull();
  });
});
