import { describe, expect, it } from "vitest";
import { localDeviceUsage } from "./local-usage-transfer";

describe("local device display totals", () => {
  const devices = [
    { id: "local:a", total_tokens: 200, billable_total_tokens: 180 },
    { id: "local:b", total_tokens: 200, billable_total_tokens: 60 },
  ];
  it("uses the same billable basis for every device contribution", () => {
    const view = localDeviceUsage(devices, []);
    expect(view.devices.map((device) => device.total_tokens)).toEqual([180, 60]);
    expect(devices.map((device) => device.total_tokens)).toEqual([200, 200]);
  });
  it("chooses the fallback once for the whole selected scope, including account sources", () => {
    const zero = devices.map((device) => ({ ...device, billable_total_tokens: 0 }));
    expect(localDeviceUsage(zero, []).devices.map((device) => device.total_tokens)).toEqual([200, 200]);
    const accounts = [{ source: "cursor", total_tokens: 100, billable_total_tokens: 50 }];
    expect(localDeviceUsage(zero, accounts).devices.map((device) => device.total_tokens)).toEqual([0, 0]);
    expect(localDeviceUsage(zero, accounts).accountSources[0].total_tokens).toBe(50);
    expect(localDeviceUsage(zero, accounts, "local:a").devices[0].total_tokens).toBe(200);
    const mixed = [zero[0], devices[1]];
    expect(localDeviceUsage(mixed, []).devices.map((device) => device.total_tokens)).toEqual([0, 60]);
    expect(localDeviceUsage(mixed, [], "local:a").devices[0].total_tokens).toBe(200);
  });
});
