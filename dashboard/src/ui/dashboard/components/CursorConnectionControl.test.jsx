import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CursorConnectionControl } from "./CursorConnectionControl.jsx";
import { isLocalhostHost, updateCursorConnection } from "../../../lib/api";
import { copy } from "../../../lib/copy";
import { isBridgeAvailable, postNativeMessage } from "../../../lib/native-bridge.js";

vi.mock("../../../lib/api", () => ({ isLocalhostHost: vi.fn(), updateCursorConnection: vi.fn() }));
vi.mock("../../../lib/native-bridge.js", () => ({ isBridgeAvailable: vi.fn(), isNativeLinuxApp: () => false, getNativeOAuthBridge: vi.fn(), postNativeMessage: vi.fn() }));
const popup = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };
const attempt = { status: "pending", attemptId: "test-attempt", authUrl: "https://cursor.com/loginDeepControl?challenge=test" };
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "open").mockReturnValue(popup);
  popup.location.replace.mockClear();
  vi.mocked(isLocalhostHost).mockReturnValue(true);
  vi.mocked(isBridgeAvailable).mockReturnValue(false);
  vi.mocked(postNativeMessage).mockClear();
  vi.mocked(updateCursorConnection).mockReset().mockImplementation(async (action) => action === "start" ? attempt : { status: "pending" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function start() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: copy("limits.cursor.connection.connect") })));
}
describe("Cursor browser connection", () => {
  it("does no auth work until clicked, then opens an explicit browser link and refreshes on success", async () => {
    const saved = vi.fn();
    render(<CursorConnectionControl onSaved={saved} />);
    expect(updateCursorConnection).not.toHaveBeenCalled();
    await start();
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(popup.location.replace).toHaveBeenCalledWith(attempt.authUrl);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    vi.mocked(updateCursorConnection).mockResolvedValue({ status: "connected" });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(updateCursorConnection).toHaveBeenCalledWith("poll", attempt.attemptId);
    expect(saved).toHaveBeenCalledOnce();
    expect(screen.queryByText(/saved only on this device/)).not.toBeInTheDocument();
  });
  it("uses the native external-browser action without creating a WebView popup", async () => {
    vi.mocked(isBridgeAvailable).mockReturnValue(true);
    render(<CursorConnectionControl />);
    await start();
    expect(window.open).not.toHaveBeenCalled();
    expect(postNativeMessage).toHaveBeenCalledWith({ type: "action", name: "openURL", value: attempt.authUrl });
  });
  it("offers a compact sign-in link only if the browser blocks the new tab", async () => {
    vi.mocked(window.open).mockReturnValue(null);
    render(<CursorConnectionControl />);
    await start();
    expect(screen.getByRole("link", { name: copy("limits.cursor.connection.open") })).toHaveAttribute("href", attempt.authUrl);
  });
  it("cancels when the user cancels or leaves the panel", async () => {
    const { unmount } = render(<CursorConnectionControl />);
    await start();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: copy("limits.cursor.connection.cancel") })));
    expect(updateCursorConnection).toHaveBeenCalledWith("cancel", attempt.attemptId);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(updateCursorConnection).not.toHaveBeenCalledWith("poll", attempt.attemptId);
    await start();
    unmount();
    expect(updateCursorConnection.mock.calls.filter(([action]) => action === "cancel")).toHaveLength(2);
  });
  it("shows expiry and never renders raw server errors", async () => {
    render(<CursorConnectionControl />);
    await start();
    vi.mocked(updateCursorConnection).mockResolvedValue({ status: "expired" });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole("alert")).toHaveTextContent(copy("limits.cursor.connection.expired"));
    vi.mocked(updateCursorConnection).mockRejectedValue(new Error("secret-upstream-payload"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: copy("limits.cursor.connection.retry") })));
    expect(screen.getByRole("alert")).toHaveTextContent(copy("limits.cursor.connection.failed"));
    expect(screen.queryByText(/secret-upstream/)).not.toBeInTheDocument();
  });
  it("disconnects the saved connection and hides local controls on the cloud site", async () => {
    const saved = vi.fn();
    const { rerender } = render(<CursorConnectionControl connected onSaved={saved} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: copy("limits.cursor.connection.manage") })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: copy("limits.cursor.connection.disconnect") })));
    expect(updateCursorConnection).toHaveBeenCalledWith("disconnect");
    expect(saved).toHaveBeenCalledOnce();
    vi.mocked(isLocalhostHost).mockReturnValue(false);
    rerender(<CursorConnectionControl />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
