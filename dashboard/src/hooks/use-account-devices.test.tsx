import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAccountDevices } from "../lib/api";
import { useAccountDevices } from "./use-account-devices";
import { readLocalUsageDevices } from "../lib/local-usage-transfer";

vi.mock("../lib/api", () => ({ fetchAccountDevices: vi.fn() }));
vi.mock("../lib/host-mode", () => ({ isLocalDashboardHost: () => true }));
vi.mock("../lib/local-usage-transfer", () => ({ readLocalUsageDevices: vi.fn(), LOCAL_USAGE_CHANGED_EVENT: "local-usage-changed" }));
vi.mock("../lib/auth-token", () => ({
  resolveAuthAccessToken: async (t: any) => t || "test-token",
}));

describe("useAccountDevices", () => {
  beforeEach(() => vi.mocked(fetchAccountDevices).mockReset());

  it("feeds imported local devices into the existing device controls without cloud authentication", async () => {
    vi.mocked(readLocalUsageDevices).mockResolvedValue({ revision: 3,
      devices: [{ id: "local:laptop", device_name: "Laptop", total_tokens: 100 }], account_sources: [] });
    const { result } = renderHook(() => useAccountDevices({ localView: true, from: "2026-10-01", to: "2026-10-31" }));
    await waitFor(() => expect(result.current.devices[0]?.id).toBe("local:laptop"));
    expect(result.current.revision).toBe(3);
    expect(fetchAccountDevices).not.toHaveBeenCalled();
  });

  it("returns devices in account view", async () => {
    vi.mocked(fetchAccountDevices).mockResolvedValue({
      from: "2026-06-01", to: "2026-06-30",
      devices: [{ id: "d1", device_name: "MacBook", platform: "darwin", total_tokens: 10 }],
    });
    const { result } = renderHook(() =>
      useAccountDevices({
        from: "2026-06-01", to: "2026-06-30", timeZone: "UTC",
        accountView: true, accountAccessToken: "jwt",
      }),
    );
    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(result.current.devices[0]).toMatchObject({ id: "d1", device_name: "MacBook" });
  });

  it("returns empty and does not fetch outside account view", async () => {
    const { result } = renderHook(() =>
      useAccountDevices({ from: "2026-06-01", to: "2026-06-30", accountView: false, accountAccessToken: null }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.devices).toEqual([]);
    expect(fetchAccountDevices).not.toHaveBeenCalled();
  });
});
