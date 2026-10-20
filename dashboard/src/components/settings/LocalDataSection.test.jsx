import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDataSection } from "./LocalDataSection";
import { localUsageAction, readLocalUsageDevices } from "../../lib/local-usage-transfer";
import { saveLocalUsageExport } from "../../lib/native-bridge";
import { copy } from "../../lib/copy";

vi.mock("../../lib/local-usage-transfer", () => ({ localUsageAction: vi.fn(), readLocalUsageDevices: vi.fn(),
  LOCAL_USAGE_CHANGED_EVENT: "local-usage-changed", LOCAL_USAGE_MAX_BYTES: 5 * 1024 * 1024 }));
vi.mock("../../lib/native-bridge", () => ({ saveLocalUsageExport: vi.fn() }));
const snapshot = { machine: { id: "machine-aaaa", name: "Laptop" }, sequence: 1 };
function selectFile(contents = JSON.stringify(snapshot)) {
  const file = new File([contents], "usage.json", { type: "application/json" });
  file.text = async () => contents;
  fireEvent.change(screen.getByLabelText(copy("settings.local_data.choose")), { target: { files: [file] } });
}
describe("local usage transfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readLocalUsageDevices.mockResolvedValue({ devices: [] });
    localUsageAction.mockImplementation(async (action) => action === "preview"
      ? { machine: snapshot.machine, before: 200, after: 300, token: "preview-1", action: "added", exported_at: "2026-10-18T10:00:00.000Z" }
      : action === "export" ? { snapshot } : { ok: true });
  });
  it("previews without importing, cancels without writes, and commits only after confirmation", async () => {
    render(<LocalDataSection />);
    await waitFor(() => expect(readLocalUsageDevices).toHaveBeenCalled());
    selectFile();
    await screen.findByText("Laptop");
    expect(localUsageAction).toHaveBeenCalledTimes(1);
    expect(localUsageAction).toHaveBeenCalledWith("preview", { snapshot });
    fireEvent.click(screen.getByRole("button", { name: copy("settings.local_data.cancel") }));
    expect(localUsageAction).toHaveBeenCalledTimes(1);
    selectFile();
    fireEvent.click(await screen.findByRole("button", { name: copy("settings.local_data.confirm") }));
    await waitFor(() => expect(localUsageAction).toHaveBeenCalledWith("import", { snapshot, token: "preview-1" }));
    expect(await screen.findByRole("status")).toHaveTextContent(copy("settings.local_data.imported"));
  });
  it("rejects invalid JSON without sending it to the backend", async () => {
    render(<LocalDataSection />);
    selectFile("invalid");
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("settings.local_data.error.invalid_snapshot"));
    expect(localUsageAction).not.toHaveBeenCalled();
  });
  it("requires a second action before removing an imported source", async () => {
    readLocalUsageDevices.mockResolvedValue({ devices: [{ id: "local:machine-aaaa", machine_id: "machine-aaaa",
      device_name: "Laptop", imported_at: "2026-10-18T10:00:00.000Z", exported_at: "2026-10-18T10:00:00.000Z" }] });
    render(<LocalDataSection />);
    fireEvent.click(await screen.findByRole("button", { name: copy("settings.local_data.remove") }));
    expect(localUsageAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy("settings.local_data.confirm_remove") }));
    await waitFor(() => expect(localUsageAction).toHaveBeenCalledWith("remove", { machine_id: "machine-aaaa" }));
  });
  it("does not claim a native export was saved when the host reports failure", async () => {
    saveLocalUsageExport.mockRejectedValue(new Error("save_failed"));
    render(<LocalDataSection />);
    fireEvent.click(screen.getByRole("button", { name: copy("settings.local_data.export") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy("settings.local_data.error.transfer_failed"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
