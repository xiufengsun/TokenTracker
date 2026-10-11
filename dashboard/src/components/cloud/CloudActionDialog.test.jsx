import React, { useRef, useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CreditCard } from "lucide-react";
import { copy, setCopyLocale } from "../../lib/copy";
import { CloudActionDialog } from "./CloudActionDialog.jsx";

afterEach(cleanup);

function Harness({ preventClose = false }) {
  const [open, setOpen] = useState(false);
  const input = useRef(null);
  return <CloudActionDialog open={open} onOpenChange={setOpen}
    title={copy("cloud.billing.title")} icon={CreditCard} preventClose={preventClose} initialFocus={input}>
    <label>{copy("cloud.checkout.order_id")}<input ref={input} /></label>
  </CloudActionDialog>;
}

const interact = (action) => act(async () => { await action(); });

describe("CloudActionDialog", () => {
  it("opens one labeled modal and restores keyboard focus to its entry on Escape", async () => {
    setCopyLocale("en");
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Billing & payments" });
    await interact(() => userEvent.click(trigger));
    const dialog = screen.getByRole("dialog", { name: "Billing & payments" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getAllByRole("heading")).toHaveLength(1);
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "Order ID" })).toHaveFocus());
    await interact(() => userEvent.keyboard("{Escape}"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps Tab focus inside the modal and closes with its named close button", async () => {
    setCopyLocale("en");
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Billing & payments" });
    await interact(() => userEvent.click(trigger));
    const dialog = screen.getByRole("dialog");
    await interact(() => userEvent.tab());
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await interact(() => userEvent.tab());
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await interact(() => userEvent.click(within(dialog).getByRole("button", { name: copy("shared.dialog.close") })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not dismiss a protected operation until the operation finishes", async () => {
    setCopyLocale("en");
    const view = render(<Harness preventClose />);
    await interact(() => userEvent.click(screen.getByRole("button", { name: "Billing & payments" })));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: copy("shared.dialog.close") })).toBeDisabled();
    await interact(() => userEvent.keyboard("{Escape}"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    view.rerender(<Harness />);
    await interact(() => userEvent.keyboard("{Escape}"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
