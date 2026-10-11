import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCloudExternal } from "./cloud-checkout.js";

const native = vi.hoisted(() => ({
  platform: "web",
  post: vi.fn(),
  bridge: null,
}));
vi.mock("./native-bridge.js", () => ({
  isNativeEmbed: () => native.platform === "macos",
  isNativeWindowsApp: () => native.platform === "windows",
  isNativeLinuxApp: () => native.platform === "linux",
  postNativeMessage: native.post,
  getNativeOAuthBridge: () => native.bridge,
}));
beforeEach(() => {
  native.platform = "web";
  native.bridge = null;
  native.post.mockReset().mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("Cloud external payment handoff", () => {
  it("opens a separate web checkout with opener isolation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openCloudExternal("https://pancake.waffo.ai/checkout?session=owned");
    expect(open).toHaveBeenCalledWith(
      "https://pancake.waffo.ai/checkout?session=owned",
      "_blank", "noopener,noreferrer",
    );
  });
  it.each(["macos", "windows"])("uses the %s native openURL action", async (platform) => {
    native.platform = platform;
    const open = vi.spyOn(window, "open");
    await openCloudExternal("https://www.tokentracker.cc/billing/checkout?order=owned");
    expect(native.post).toHaveBeenCalledWith({
      type: "action", name: "openURL",
      value: "https://www.tokentracker.cc/billing/checkout?order=owned",
    });
    expect(open).not.toHaveBeenCalled();
  });
  it("reports a missing or rejected native bridge without pretending checkout opened", async () => {
    native.platform = "linux";
    await expect(openCloudExternal("https://www.tokentracker.cc/billing/checkout"))
      .rejects.toThrow("browser_open_failed");
    native.platform = "windows";
    native.post.mockReturnValue(false);
    await expect(openCloudExternal("https://www.tokentracker.cc/billing/checkout"))
      .rejects.toThrow("browser_open_failed");
  });
  it("awaits the Linux system-browser bridge and rejects unsafe schemes", async () => {
    native.platform = "linux";
    native.bridge = { postMessage: vi.fn().mockRejectedValue(new Error("launch failed")) };
    await expect(openCloudExternal("https://www.tokentracker.cc/billing/checkout"))
      .rejects.toThrow("launch failed");
    await expect(openCloudExternal("weixin://wxpay/bizpayurl?pr=direct"))
      .rejects.toThrow("invalid_provider_checkout_url");
    await expect(openCloudExternal("javascript:alert(1)"))
      .rejects.toThrow("invalid_provider_checkout_url");
    expect(native.bridge.postMessage).toHaveBeenCalledTimes(1);
  });
  it.each([
    "https://user:password@pancake.waffo.ai/checkout",
    "https://pancake.waffo.ai@unrelated.example/checkout",
    "http://pancake.waffo.ai/checkout",
    "//pancake.waffo.ai/checkout",
    "not-a-checkout-url",
  ])("rejects unsafe checkout %s before opening a browser", async (url) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await expect(openCloudExternal(url)).rejects.toThrow("invalid_provider_checkout_url");
    expect(open).not.toHaveBeenCalled();
    expect(native.post).not.toHaveBeenCalled();
  });
});
