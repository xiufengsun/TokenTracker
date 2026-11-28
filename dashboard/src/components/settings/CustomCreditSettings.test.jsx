import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomCreditSettings } from "./CustomCreditSettings.jsx";
import { customCreditConfig } from "../../lib/api";
import { CUSTOM_CREDIT_CONFIG_CHANGED } from "../../lib/custom-credit-config";
import { setCopyLocale } from "../../lib/copy";
import { EN_LOCALE } from "../../lib/locale";

vi.mock("../../lib/api", () => ({ customCreditConfig: vi.fn() }));

describe("CustomCreditSettings", () => {
  const saved = { gatewayBaseUrl: "https://gateway.example", hasApiKey: true, dailyCreditLimit: 150 };
  beforeEach(() => {
    vi.mocked(customCreditConfig).mockReset().mockResolvedValue(saved);
    setCopyLocale(EN_LOCALE);
  });

  it("edits a saved service without retrieving or replacing its API key", async () => {
    render(<CustomCreditSettings />);
    const key = await screen.findByLabelText("API key");
    expect(key).toHaveValue("");
    expect(key).not.toBeRequired();
    fireEvent.change(screen.getByLabelText("Weekly"), { target: { value: "650" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(customCreditConfig).toHaveBeenCalledWith("PUT", {
      gatewayBaseUrl: saved.gatewayBaseUrl, displayName: "", dailyCreditLimit: 150,
      weeklyCreditLimit: 650, monthlyCreditLimit: null,
    }));
    fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value: "https://new.example" } });
    expect(key).toBeRequired();
  });

  it.each([
    ["https://gateway.example", "https://GATEWAY.example:443/v1/"],
    ["https://gateway.example/api/v1", "https://gateway.example/api/v1/"],
    ["https://gateway.example/api/v1", "https://gateway.example/api/v1/v1/"],
  ])("retains a key for %s when entered as %s", async (gatewayBaseUrl, value) => {
    vi.mocked(customCreditConfig).mockResolvedValue({ ...saved, gatewayBaseUrl });
    render(<CustomCreditSettings />);
    const key = await screen.findByLabelText("API key");
    fireEvent.change(screen.getByLabelText("Gateway URL"), { target: { value } });
    expect(key).not.toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(customCreditConfig).toHaveBeenCalledWith("PUT", expect.objectContaining({ gatewayBaseUrl: value })));
    expect(customCreditConfig.mock.calls.find(([method]) => method === "PUT")[1]).not.toHaveProperty("apiKey");
  });

  it.each([["Weekly", "weeklyCreditLimit"], ["Monthly", "monthlyCreditLimit"]])(
    "saves a %s-only budget and rejects empty or zero budgets", async (label, cap) => {
      render(<CustomCreditSettings />);
      const daily = await screen.findByLabelText("Daily");
      expect(daily).not.toBeRequired();
      fireEvent.change(daily, { target: { value: "" } });
      const save = screen.getByRole("button", { name: "Save" });
      for (const value of ["", "0"]) {
        fireEvent.change(screen.getByLabelText(label), { target: { value } });
        fireEvent.click(save);
        expect(screen.getByRole("status")).toHaveTextContent(/at least one/i);
        expect(customCreditConfig.mock.calls.some(([method]) => method === "PUT")).toBe(false);
      }
      fireEvent.change(screen.getByLabelText(label), { target: { value: "800" } });
      fireEvent.click(save);
      await waitFor(() => expect(customCreditConfig).toHaveBeenCalledWith("PUT", expect.objectContaining({
        dailyCreditLimit: null, [cap]: 800,
      })));
    },
  );

  it("reloads on activation and config changes, merges untouched fields, and ignores a superseded read", async () => {
    const section = (active) => <CustomCreditSettings active={active} />;
    const { rerender } = render(section(false));
    expect(customCreditConfig).not.toHaveBeenCalled();
    rerender(section(true));
    const name = await screen.findByLabelText("Service name (optional)");
    const key = screen.getByLabelText("API key");
    fireEvent.change(name, { target: { value: "My draft" } });
    fireEvent.change(key, { target: { value: "local-draft-key" } });
    rerender(section(false));
    let finishOld;
    vi.mocked(customCreditConfig).mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
    rerender(section(true));
    const current = { ...saved, gatewayBaseUrl: "https://another.example", displayName: "Remote", weeklyCreditLimit: 720 };
    vi.mocked(customCreditConfig).mockResolvedValue(current);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: CUSTOM_CREDIT_CONFIG_CHANGED })));
    await waitFor(() => expect(screen.getByLabelText("Weekly")).toHaveValue(720));
    await act(async () => finishOld({ ...saved, weeklyCreditLimit: 200 }));
    expect(name).toHaveValue("My draft");
    expect(key).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(customCreditConfig).toHaveBeenCalledWith("PUT", {
      gatewayBaseUrl: current.gatewayBaseUrl, displayName: "My draft",
      dailyCreditLimit: 150, weeklyCreditLimit: 720, monthlyCreditLimit: null,
    }));
  });
});
