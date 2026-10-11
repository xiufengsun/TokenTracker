"use strict";

const BACKEND = "https://srctyff5.us-east.insforge.app";
const GATEWAY = "https://srctyff5.function2.insforge.app/tokentracker-native-sandbox-gateway";
const REALM = "tokentracker-native-sandbox-v1";
const tokenHash = value => require("node:crypto").createHash("sha256").update(value).digest("hex");

function sanitized(value) {
  if (Array.isArray(value)) return value.map(sanitized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !["refreshToken", "refresh_token", "password"].includes(key)).map(([key, child]) => [key, sanitized(child)]));
}

function createRAMAuthBroker({ allowedUserIDs, fetchImpl = fetch }) {
  if (!Array.isArray(allowedUserIDs) || !allowedUserIDs.length || allowedUserIDs.some(id =>
    typeof id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))) throw new Error("native_qa_actor_configuration_required");
  let session = null;
  let epoch = 0;
  let sequence = Promise.resolve();
  const issuedTokens = new Set();
  const blocked = (status = 403) => Response.json({ error: "native_qa_auth_rejected" }, { status });
  const reply = (value, status = 200) => Response.json(sanitized(value), { status, headers: {
    "X-Native-QA-Actor": session?.userID || "", "X-Native-QA-Auth-Epoch": String(epoch)
  } });
  const request = (url, init) => fetchImpl(url, { ...init, redirect: "error", credentials: "omit", cache: "no-store" });

  async function verifyActor(accessToken, userID) {
    if (!allowedUserIDs.includes(userID)) throw new Error("native_qa_actor_rejected");
    const response = await request(GATEWAY + "?mode=identity", {
      headers: { Authorization: "Bearer " + accessToken, "X-TokenTracker-Sandbox-Realm": REALM }
    });
    const value = await response.json();
    if (response.status !== 200 || response.headers.get("X-TokenTracker-Sandbox-Realm") !== REALM ||
        response.headers.get("X-TokenTracker-Billing-Environment") !== "sandbox" ||
        value.user_id !== userID || value.realm !== REALM || value.environment !== "sandbox" || value.authenticated !== true) {
      throw new Error("native_qa_actor_rejected");
    }
  }

  async function acceptSession(response, ticket, mode = "web") {
    if (ticket.epoch !== epoch || ticket.session !== session) return blocked();
    const value = await response.json();
    if (response.status !== 200) return blocked(response.status);
    if (typeof value.accessToken !== "string" || !value.accessToken || typeof value.user?.id !== "string" ||
        mode === "web" && (typeof value.csrfToken !== "string" || !value.csrfToken)) throw new Error("native_qa_session_rejected");
    const cookies = response.headers.getSetCookie?.() || [response.headers.get("Set-Cookie") || ""];
    let refreshToken = null;
    for (const cookie of cookies) {
      const match = /(?:^|,\s*)insforge_refresh_token=([^;\s,]+)/.exec(cookie);
      if (match) refreshToken = match[1];
    }
    if (mode === "mobile") refreshToken = value.refreshToken;
    if (typeof refreshToken !== "string" || !refreshToken) throw new Error("native_qa_session_rejected");
    if (ticket.session && value.user.id !== ticket.session.userID) throw new Error("native_qa_session_rejected");
    await verifyActor(value.accessToken, value.user.id);
    if (ticket.epoch !== epoch || ticket.session !== session) return blocked();
    session = { accessToken: value.accessToken, csrfToken: value.csrfToken, refreshToken, userID: value.user.id, mode };
    issuedTokens.add(tokenHash(value.accessToken));
    if (issuedTokens.size > 8) issuedTokens.delete(issuedTokens.values().next().value);
    return reply(value);
  }

  async function execute(pathname, { method, headers, body }) {
    if (pathname === "/__broker/bootstrap-refresh" && method === "POST") {
      const value = JSON.parse(body);
      if (typeof value.refreshToken !== "string" || value.refreshToken.length < 32 || value.refreshToken.length > 8192) return blocked(400);
      epoch++; session = null; issuedTokens.clear();
      const ticket = { epoch, session };
      const response = await request(BACKEND + "/api/auth/refresh?client_type=mobile", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: value.refreshToken }) });
      return acceptSession(response, ticket, "mobile");
    }
    if (pathname === "/api/auth/public-config" && method === "GET") {
      const response = await request(BACKEND + pathname, { headers: { Accept: "application/json" } });
      return Response.json(sanitized(await response.json()), { status: response.status });
    }
    if (pathname === "/api/auth/sessions" && method === "POST") {
      epoch++; session = null; issuedTokens.clear();
      let value;
      try { value = JSON.parse(body); } catch { return blocked(400); }
      if (value.method !== undefined && value.method !== "password" || typeof value.email !== "string" || typeof value.password !== "string" ||
          !value.password || Object.keys(value).some(key => !["method", "email", "password"].includes(key))) return blocked(400);
      const ticket = { epoch, session };
      const response = await request(BACKEND + pathname, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value)
      });
      return acceptSession(response, ticket);
    }
    if (!session) return blocked(401);
    const csrf = new Headers(headers).get("X-CSRF-Token");
    if (pathname === "/api/auth/refresh" && method === "POST") {
      if (session.mode === "web" && csrf !== session.csrfToken || body && !["{}", "null"].includes(body)) return blocked();
      const ticket = { epoch, session };
      const mobile = ticket.session.mode === "mobile";
      const response = await request(BACKEND + pathname + (mobile ? "?client_type=mobile" : ""), mobile ? {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: ticket.session.refreshToken })
      } : {
        method: "POST", headers: { Cookie: "insforge_refresh_token=" + session.refreshToken,
          "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" }
      });
      return acceptSession(response, ticket, mobile ? "mobile" : "web");
    }
    if (pathname === "/api/auth/sessions/current" && method === "GET") {
      const ticket = { epoch, session };
      const response = await request(BACKEND + pathname, { headers: { Authorization: "Bearer " + ticket.session.accessToken } });
      if (response.status !== 200) return blocked(response.status);
      const value = await response.json();
      if (value.user?.id !== ticket.session.userID) throw new Error("native_qa_session_rejected");
      await verifyActor(ticket.session.accessToken, ticket.session.userID);
      if (ticket.epoch !== epoch || ticket.session !== session) return blocked();
      return reply(value);
    }
    if (pathname === "/api/auth/logout" && method === "POST") {
      if (session.mode === "web" && csrf !== session.csrfToken) return blocked();
      const previous = session; epoch++; session = null; issuedTokens.clear();
      const mobile = previous.mode === "mobile";
      const response = await request(BACKEND + pathname + (mobile ? "?client_type=mobile" : ""), { method: "POST", headers: mobile ? {
        "Content-Type": "application/json", Authorization: "Bearer " + previous.accessToken
      } : {
        Cookie: "insforge_refresh_token=" + previous.refreshToken, "X-CSRF-Token": previous.csrfToken,
        Authorization: "Bearer " + previous.accessToken
      }, ...(mobile ? { body: JSON.stringify({ refresh_token: previous.refreshToken }) } : {}) });
      return reply(await response.json(), response.status);
    }
    return blocked(503);
  }

  return {
    request(pathname, options) {
      const next = sequence.then(async () => {
        const ticket = { epoch, session };
        try { return await execute(pathname, options); }
        catch {
          if (ticket.epoch === epoch && ticket.session === session) { epoch++; session = null; issuedTokens.clear(); }
          return blocked();
        }
      });
      sequence = next.then(() => undefined);
      return next;
    },
    accessToken() { return session?.accessToken || null; },
    bootstrapRealRefresh(refreshToken) {
      return this.request("/__broker/bootstrap-refresh", { method: "POST", body: JSON.stringify({ refreshToken }) });
    },
    sessionEpoch() { return epoch; },
    actorID() { return session?.userID || null; },
    acceptsAccessToken(value) { return !!session && typeof value === "string" && issuedTokens.has(tokenHash(value)); },
    async ownedOrder(orderID) {
      if (!session) throw new Error("native_qa_sign_in_required");
      const captured = session; const capturedEpoch = epoch;
      await verifyActor(captured.accessToken, captured.userID);
      const url = new URL(GATEWAY);
      url.searchParams.set("fn", "tokentracker-billing"); url.searchParams.set("action", "order"); url.searchParams.set("id", orderID);
      const response = await request(url, { headers: { Authorization: "Bearer " + captured.accessToken,
        "X-TokenTracker-Sandbox-Realm": REALM } });
      const value = await response.json();
      if (capturedEpoch !== epoch || captured.userID !== session?.userID || response.status !== 200 ||
          response.headers.get("X-TokenTracker-Sandbox-Realm") !== REALM ||
          response.headers.get("X-TokenTracker-Billing-Environment") !== "sandbox" ||
          value.order?.id !== orderID || value.membership?.environment !== "sandbox") throw new Error("native_qa_order_rejected");
      return { order: value.order, userID: captured.userID, epoch: capturedEpoch };
    },
    clear() { epoch++; session = null; issuedTokens.clear(); }
  };
}

module.exports = { createRAMAuthBroker, sanitized, BACKEND, GATEWAY, REALM };
