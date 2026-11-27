// Exercise one explicitly approved recipient in the synthetic QA environment.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";

const [mode, statePath, codePath] = process.argv.slice(2);
assert.ok(mode === "send" || mode === "verify");
assert.equal(statSync(statePath).mode & 0o077, 0);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const base = "https://api-qa-tokentracker-migration-staging.sunxiufeng1992.workers.dev";
assert.equal(state.base, base);
async function api(path, data, status = 200, bearer) {
  const response = await fetch(base + "/api/auth/" + path, {
    method: data === undefined ? "GET" : "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", ...(bearer ? {Authorization:"Bearer "+bearer} : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  assert.equal(response.status, status, path + " returned " + response.status);
  return response.json();
}
const persist = () => writeFileSync(statePath, JSON.stringify(state), {mode:0o600});
if (mode === "send") {
  assert.ok(!state.sentAt, "A code was already requested");
  const login = await api("sessions?client_type=mobile", {email:state.email,password:state.password});
  assert.equal(login.user.id,state.id);
  state.priorAccessToken=login.accessToken;
  persist();
  await api("email/send-reset-password",{email:state.email});
  state.sentAt=new Date().toISOString();persist();
  console.log("QA accepted the email request");
} else {
  assert.ok(state.sentAt && !state.verifiedAt, "Waiting for the first QA message");
  const code = readFileSync(codePath,"utf8").trim();
  assert.match(code,/^[0-9]{6}$/);
  const exchange = () => ({email:state.email,code});
  const proof = await api("email/exchange-reset-password-token",exchange());
  await api("email/exchange-reset-password-token",exchange(),401);
  const password=randomBytes(24).toString("base64url");
  await api("email/reset-password",{newPassword:password,otp:proof.token});
  await api("email/reset-password",{newPassword:password,otp:proof.token},401);
  await api("sessions/current",undefined,401,state.priorAccessToken);
  await api("sessions?client_type=mobile",{email:state.email,password:state.password},401);
  const login=await api("sessions?client_type=mobile",{email:state.email,password});
  assert.equal(login.user.id,state.id);
  await api("logout?client_type=mobile",{refresh_token:login.refreshToken});
  await api("sessions/current",undefined,401,login.accessToken);
  state.verifiedAt=new Date().toISOString();state.password=password;delete state.priorAccessToken;persist();
  console.log(JSON.stringify({accepted:true,code_replay_rejected:true,reset_token_replay_rejected:true,old_session_revoked:true,old_password_rejected:true,original_account_id:true,logout:true,verifiedAt:state.verifiedAt}));
}
