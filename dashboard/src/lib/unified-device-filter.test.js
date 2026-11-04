import { describe, expect, it } from "vitest";
import {
  DEVICE_FILTER_LOCAL_SCOPE,
  resolveUnifiedDeviceFilterChange,
  unifiedDeviceFilterValue,
} from "./unified-device-filter.js";

describe("unified device/scope filter helpers", () => {
  it("maps This device / Account-wide / local / cloud ids without flipping local rows to cloud", () => {
    expect(resolveUnifiedDeviceFilterChange(DEVICE_FILTER_LOCAL_SCOPE)).toEqual({
      scopeOverride: "local",
      deviceId: null,
    });
    expect(resolveUnifiedDeviceFilterChange("")).toEqual({
      scopeOverride: null,
      deviceId: null,
    });
    expect(resolveUnifiedDeviceFilterChange("local:laptop")).toEqual({
      scopeOverride: "local",
      deviceId: "local:laptop",
    });
    expect(resolveUnifiedDeviceFilterChange("cloud-device-1")).toEqual({
      scopeOverride: null,
      deviceId: "cloud-device-1",
    });
  });

  it("prefers a concrete selected device over the This device sentinel", () => {
    expect(
      unifiedDeviceFilterValue({
        accountScopeSwitchable: true,
        accountView: false,
        selectedDevice: "local:laptop",
      }),
    ).toBe("local:laptop");
    expect(
      unifiedDeviceFilterValue({
        accountScopeSwitchable: true,
        accountView: false,
        selectedDevice: null,
      }),
    ).toBe(DEVICE_FILTER_LOCAL_SCOPE);
    expect(
      unifiedDeviceFilterValue({
        accountScopeSwitchable: true,
        accountView: true,
        selectedDevice: null,
      }),
    ).toBe("");
    expect(
      unifiedDeviceFilterValue({
        accountScopeSwitchable: false,
        accountView: true,
        selectedDevice: "d1",
      }),
    ).toBe("d1");
  });
});
