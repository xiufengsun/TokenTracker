import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCopyLocale } from "../../lib/copy";
import { CancelPendingOrder } from "./CancelPendingOrder.jsx";
let props;
beforeEach(() => {
  setCopyLocale("en");
  props = { order: {id:"00000000-0000-4000-8000-000000000001",provider:"waffo",status:"ready"},
    auth:{user:{id:"actor-a"},getAccessToken:vi.fn().mockResolvedValue("fixture-token")},
    refresh:vi.fn().mockResolvedValue({}), request:vi.fn().mockResolvedValue({cancellation:"processing"}) };
});
afterEach(cleanup);
function begin() { fireEvent.click(screen.getByRole("button",{name:"Cancel unpaid order"})); }
function confirm() { fireEvent.click(screen.getByRole("button",{name:"Request cancellation"})); }
it("requires explicit confirmation distinct from renewal cancellation, and preserves processing until verified",async()=>{
  render(<CancelPendingOrder {...props}/>);begin();
  expect(screen.getByRole("group")).toHaveTextContent("not subscription auto-renewal cancellation");
  expect(props.request).not.toHaveBeenCalled();confirm();
  await screen.findByRole("button",{name:"Check cancellation status"});
  expect(screen.getByRole("status")).toHaveTextContent("expiry alone does not complete cancellation");
  expect(props.request).toHaveBeenCalledTimes(1);expect(props.refresh).toHaveBeenCalledTimes(1);
});
it("locks duplicate submissions and exposes an actionable failure without a false success",async()=>{
  let reject;props.request.mockReturnValue(new Promise((_,bad)=>{reject=bad;}));
  render(<CancelPendingOrder {...props}/>);begin();confirm();
  expect(screen.getByRole("button",{name:"Checking cancellation…"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Checking cancellation…"}));expect(props.request).toHaveBeenCalledTimes(1);
  await act(async()=>reject(new Error("fixture provider timeout")));
  expect(screen.getByRole("alert")).toHaveTextContent("Do not pay again");expect(props.refresh).not.toHaveBeenCalled();
});
it.each(["cancelled","not_cancelled"])("refreshes authoritative billing after %s and never redeems a code",async(cancellation)=>{
  props.request.mockResolvedValue({cancellation});render(<CancelPendingOrder {...props}/>);begin();confirm();
  await waitFor(()=>expect(props.refresh).toHaveBeenCalledTimes(1));
  expect(props.request.mock.calls.map(([action])=>action)).toEqual(["cancel-order"]);
  expect(screen.getByRole("status")).toHaveTextContent(cancellation==="cancelled"?"no code has been redeemed automatically":"existing entitlement and subscription settings");
});
it("ignores a previous account response and can operate on the new account",async()=>{
  let resolve;props.request.mockReturnValueOnce(new Promise(done=>{resolve=done;}));
  const view=render(<CancelPendingOrder {...props}/>);begin();confirm();
  props={...props,auth:{...props.auth,user:{id:"actor-b"}}};view.rerender(<CancelPendingOrder {...props}/>);
  await act(async()=>resolve({cancellation:"cancelled"}));expect(props.refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();begin();confirm();
  await screen.findByRole("button",{name:"Check cancellation status"});
});
it("does not offer order cancellation for paid or foreign-provider orders",()=>{
  props.order.status="paid";const view=render(<CancelPendingOrder {...props}/>);expect(screen.queryByRole("button")).not.toBeInTheDocument();
  props.order={...props.order,status:"ready",provider:"paddle"};view.rerender(<CancelPendingOrder {...props}/>);expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("explains historical receipts cannot guarantee automatic completion",()=>{props.order.cancel_requested_at="2026-11-17";props.order.checkout_tracking_uncertain=true;render(<CancelPendingOrder {...props}/>);expect(screen.getByRole("note")).toHaveTextContent("may remain processing");expect(screen.getByRole("button",{name:"Check cancellation status"})).toBeEnabled();});

it("does not offer cancellation for a stale ready order with confirmed payment state", () => {
  props.order.payment_state = "paid";
  render(<CancelPendingOrder {...props}/>);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
