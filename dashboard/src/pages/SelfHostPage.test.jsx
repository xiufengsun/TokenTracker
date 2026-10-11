import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copy, setCopyLocale } from "../lib/copy";
import { SelfHostPage } from "./SelfHostPage.jsx";

beforeEach(() => setCopyLocale("en"));
afterEach(cleanup);

it("explains the preview boundary and links to existing backend sources", () => {
  render(<MemoryRouter><SelfHostPage /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Run your own backend." })).toBeInTheDocument();
  expect(screen.getByText("Technical preview")).toBeInTheDocument();
  expect(screen.getByText(/clean TokenTracker schema bootstrap/)).toHaveTextContent(/verification are still pending/);
  expect(screen.getByText(/Released desktop apps currently/)).toHaveTextContent(/requires a client build/);
  expect(screen.getByText(/private instance has its own accounts/)).toHaveTextContent(/does not feed the official public leaderboard/);
  expect(screen.getByRole("link", { name: "Backend source" })).toHaveAttribute("href", "https://github.com/xiufengsun/TokenTracker/tree/main/dashboard/edge-patches");
  expect(screen.getByRole("link", { name: "View Cloud plans" })).toHaveAttribute("href", "/cloud");
});

it("opens the deployment guide at the top after following a link below the pricing fold",async()=>{
  render(<div data-testid="page-scroller"><MemoryRouter initialEntries={["/cloud"]}><Routes>
    <Route path="/cloud" element={<Link to="/self-host">{copy("cloud.self_host.cta")}</Link>} />
    <Route path="/self-host" element={<SelfHostPage />} />
  </Routes></MemoryRouter></div>);
  const scroller=screen.getByTestId("page-scroller");
  scroller.scrollTop=795;
  await act(async () => { await userEvent.click(screen.getByRole("link",{name:"Read deployment guidance"})); });
  expect(await screen.findByRole("heading",{name:"Run your own backend."})).toBeInTheDocument();
  expect(scroller.scrollTop).toBe(0);
});
