// @vitest-environment-options {"url":"https://www.tokentracker.cc/device"}
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CliUpgradeNotice } from "./CliUpgradeNotice";
import { copy } from "../lib/copy";
import * as hosts from "../lib/host-mode";
import * as clipboard from "../lib/safe-browser";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("offers both installation methods without blocking the page", async () => {
  const write = vi.spyOn(clipboard, "safeWriteClipboard").mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  render(<CliUpgradeNotice />);
  const summary = screen.getByText(copy("cli_upgrade.summary"));
  expect(summary.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(summary);
  const [global, npx] = screen.getAllByRole("button", { name: copy("cli_upgrade.copy") });
  fireEvent.click(global);
  expect(await screen.findByText(copy("cli_upgrade.copied"))).toBeVisible();
  fireEvent.click(npx);
  expect(await screen.findByText(copy("cli_upgrade.manual_copy"))).toBeVisible();
  expect(write.mock.calls).toEqual([["npm install -g tokentracker-cli@latest"], ["npx --yes tokentracker-cli@latest"]]);
});

it("keeps the hosted migration notice off local and self-hosted dashboards", () => {
  for (const host of ["localhost", "127.0.0.1", "tracker.example.com"]) expect(hosts.isProductionHost(host)).toBe(false);
  vi.spyOn(hosts, "isProductionHost").mockReturnValue(false);
  const { container } = render(<CliUpgradeNotice />);
  expect(container).toBeEmptyDOMElement();
});
