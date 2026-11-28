import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CustomCreditSettings } from "./CustomCreditSettings.jsx";
import { customCreditConfig } from "../../lib/api";
import { setCopyLocale } from "../../lib/copy";
import { EN_LOCALE } from "../../lib/locale";

vi.mock("../../lib/api", () => ({ customCreditConfig: vi.fn() }));

describe("CustomCreditSettings", () => {
  it("edits a saved service without retrieving or replacing its API key", async () => {
    setCopyLocale(EN_LOCALE);
    const saved = { gatewayBaseUrl: "https://gateway.example", hasApiKey: true, dailyCreditLimit: 150 };
    vi.mocked(customCreditConfig).mockResolvedValue(saved);
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
});
