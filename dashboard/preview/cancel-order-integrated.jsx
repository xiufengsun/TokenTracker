// Development-only entry: real settings/billing/redemption components, synthetic transport.
// Every JS fetch is intercepted. CSP connect-src 'none' independently prevents real requests.
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {MemoryRouter} from "react-router-dom";
import "../src/styles.css";
import {setCopyLocale} from "../src/lib/copy";
setCopyLocale("zh-CN");
const scenario=new URLSearchParams(location.search).get("state")||"processing";
const fixtureId="00000000-0000-4000-8000-000000000001";
const userId="00000000-0000-4000-8000-000000000002";
let pending=[{id:fixtureId,provider:"waffo",sku:"cloud_usd_monthly_fixed",currency:"USD",amount_cents:499,billing_mode:"fixed",status:"ready",created_at:"2026-11-17T08:00:00Z",expires_at:"2026-11-17T08:30:00Z",cancel_requested_at:scenario==="legacy"?"2026-11-17T08:01:00Z":null,checkout_tracking_uncertain:scenario==="legacy"}];
let payments=[];
function account(){return {environment:"sandbox",membership:{status:payments.length?"active":"free",can_read_cloud:false,can_upload_cloud:false,machine_limit:5},pending_orders:pending.map(x=>({...x})),conflict_orders:[],subscriptions:[],payments,gifts:[],gift_redemption_available:true,redemption_restriction:pending.length?"gift_checkout_pending":null};}
window.fetch=async(input,init={})=>{
 const url=new URL(typeof input==="string"?input:input.url,location.href),action=url.searchParams.get("action");
 if(url.pathname.endsWith("tokentracker-machine-id"))return Response.json({machineId:"preview-fixture-machine"});
 if(action==="devices")return Response.json({machines:[],machine_count:0});
 if(action==="account")return Response.json(account());
 if(action==="cancel-order"){
  const body=JSON.parse(init.body||"{}");if(body.id!==fixtureId)return Response.json({error:"order_not_found"},{status:404});
  await new Promise(r=>setTimeout(r,900));
  if(scenario==="error")return Response.json({error:"billing_operation_failed"},{status:503});
  if(scenario==="draft"){pending=[];return Response.json({cancellation:"cancelled",order:{id:fixtureId,status:"closed"}});}
  if(scenario==="paid"){pending=[];payments=[{id:"preview-payment",order_id:fixtureId,provider:"waffo",currency:"USD",amount_cents:499,refunded_cents:0,starts_at:"2026-11-17",ends_at:"2026-12-17",paid_at:"2026-11-17"}];return Response.json({cancellation:"not_cancelled",order:{id:fixtureId,status:"paid"}});}
  pending=pending.map(x=>({...x,cancel_requested_at:"2026-11-17T08:01:00Z"}));return Response.json({cancellation:"processing",order:{id:fixtureId,status:"ready",cancel_requested_at:"2026-11-17T08:01:00Z"}},{status:202});
 }
 if(action==="redeem-gift")return Response.json({error:pending.length?"gift_checkout_pending":"preview_redemption_disabled"},{status:409});
 return Response.json({error:"preview_network_disabled"},{status:503});
};
const {CloudMembershipAccount}=await import("../src/components/cloud/CloudMembershipCard.jsx");
const part=x=>btoa(JSON.stringify(x)).replaceAll("=","").replaceAll("+","-").replaceAll("/","_");
const fixtureToken=part({alg:"none",typ:"JWT"})+"."+part({sub:userId,exp:4102444800})+".preview-not-a-real-signature";
const auth={signedIn:true,user:{id:userId},getAccessToken:async()=>fixtureToken};
function Integrated(){
 const [data,setData]=useState(account());
 const refresh=async()=>{const next=account();setData(next);return next;};
 return <MemoryRouter initialEntries={["/settings?section=cloud"]}><main className="tt-cloud-settings tt-cloud-theme min-h-screen bg-oai-gray-50 p-4 font-oai text-oai-black sm:p-10"><div className="mx-auto max-w-4xl">
  <p className="mb-5 text-xs text-oai-gray-500">真实云服务设置组件 · 本地测试数据 · 不连接支付/账户服务 · 请勿输入真实会员码</p>
  <nav className="mb-8 flex flex-wrap gap-4 text-sm">{["draft","processing","error","paid","legacy"].map((s,i)=><a key={s} className="underline" href={"?state="+s}>{["未发出链接的草稿","链接仍有效","核验失败","付款竞态（确认时入账）","旧订单回执不完整"][i]}</a>)}</nav>
  <div className="sm:grid sm:grid-cols-[11rem_1fr] sm:gap-10"><aside className="mb-6 space-y-4 text-sm text-oai-gray-500"><p>个人设置</p><p>账户</p><p className="font-medium text-oai-black">云服务</p><p>外观</p></aside><section>
   <CloudMembershipAccount account={data} auth={auth} refresh={refresh} loading={false} showTitle heading="云服务"/>
  </section></div>
 </div></main></MemoryRouter>;
}
createRoot(document.getElementById("root")).render(<Integrated/>);
