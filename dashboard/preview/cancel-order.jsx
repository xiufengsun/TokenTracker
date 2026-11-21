import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import "../src/styles.css";
import {setCopyLocale} from "../src/lib/copy";
import {CancelPendingOrder} from "../src/components/cloud/CancelPendingOrder.jsx";
import {CloudActionDialog} from "../src/components/cloud/CloudActionDialog.jsx";
setCopyLocale("zh-CN");
function Preview(){
 const scenario=new URLSearchParams(location.search).get("state")||"processing";
 const [open,setOpen]=useState(true),[outcome,setOutcome]=useState(null);
 const request=async(action)=>{if(action!=="cancel-order")throw Error("Preview forbids other requests");await new Promise(r=>setTimeout(r,900));if(scenario==="error")throw Error("Fixture timeout");return {cancellation:scenario==="draft"?"cancelled":scenario==="paid"?"not_cancelled":"processing"};};
 const order={id:"00000000-0000-4000-8000-000000000001",provider:"waffo",status:"ready",cancel_requested_at:null};
 return <main className="tt-cloud-theme tt-cloud-settings min-h-screen bg-oai-gray-50 p-4 font-oai text-oai-black dark:bg-oai-gray-950 dark:text-oai-white sm:p-10">
  <div className="mx-auto max-w-4xl"><p className="mb-4 text-xs text-oai-gray-500">本地交互预览 · 全部为虚构测试数据 · 无付款、无真实会员码、无支付网络请求</p>
  <nav className="mb-10 flex flex-wrap gap-4 text-sm">{["draft","processing","error","paid"].map((s,i)=><a key={s} className="underline" href={"?state="+s}>{["草稿可立即取消","链接仍有效","核验失败","付款竞态（确认时入账）"][i]}</a>)}</nav>
  <div className="sm:grid sm:grid-cols-[11rem_1fr] sm:gap-10"><aside className="mb-6 space-y-4 text-sm text-oai-gray-500"><p>个人设置</p><p>账户</p><p className="font-medium text-oai-black">云服务</p><p>外观</p></aside>
  <section><h1 className="mb-2 text-2xl font-semibold">云服务</h1><p className="mb-8 text-sm text-oai-gray-500">免费账户 · 本地功能始终免费</p>
  <div className="rounded-xl border border-oai-gray-200 bg-white px-5 py-3"><CloudActionDialog open={open} onOpenChange={setOpen} title="账单" wide>
   <p className="mb-5 text-xs text-oai-gray-500">本地测试订单 · 当前场景：{scenario} · 非真实账单{scenario==="paid"?" · 初始待付款，确认请求时模拟付款入账":null}</p>
   {outcome&&outcome!=="processing"?<p role="status" className="mb-4 text-sm">{outcome==="cancelled"?"待付款订单已取消。现在可返回兑换会员码，不会自动兑换。":"已确认付款，未取消订单；原会员权益及自动续费设置保持不变。"}</p>:null}
   <div className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 border-y border-oai-gray-200 py-4 sm:grid-cols-[1fr_auto_auto]">
    <p className="text-sm tabular-nums">2026/11/17</p><p className="text-right text-sm font-medium">US$4.99</p><p className="col-span-full text-xs text-oai-gray-500 sm:col-auto">Waffo · {outcome==="cancelled"?"已取消":outcome==="not_cancelled"?"已付款":outcome==="processing"?"取消处理中":"待付款"}</p>
    {!outcome||outcome==="processing"?<CancelPendingOrder order={order} auth={{user:{id:"preview-fixture"},getAccessToken:async()=>"unused-preview"}} request={request} refresh={async()=>{}} onResult={(result)=>setOutcome(result)}/>:null}
   </div><p className="mt-5 text-xs text-oai-gray-500">取消待付款订单与取消订阅自动续费是两项不同操作。</p>
  </CloudActionDialog></div></section></div></div></main>;
}
createRoot(document.getElementById("root")).render(<Preview/>);
