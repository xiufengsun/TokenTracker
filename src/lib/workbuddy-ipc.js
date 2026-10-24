"use strict";

// WorkBuddy's authenticated local proxy. The ticket proves both peers; the
// desktop daemon adds its own access token to relative billing requests.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");

const UNAVAILABLE = "Start WorkBuddy and sign in to read its subscription quota.";
const MAX_FRAME_BYTES = 1024 * 1024;
const BILLING_PATHS = new Set([
  "/billing/meter/get-user-resource-summary",
  "/billing/meter/get-user-resource-paid-packages",
  "/billing/meter/get-user-resource-free-packages",
]);

function readWorkbuddyIpcDiscovery(workbuddyHome) {
  let fd;
  try {
    fd = fs.openSync(path.join(workbuddyHome, "wbipc", "endpoint.json"),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384 || (process.platform !== "win32"
      && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Untrusted discovery file.");
    }
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (typeof value.ticket !== "string" || !/^[\w-]{43}$/.test(value.ticket)
      || typeof value.endpoint !== "string") throw new Error("Invalid discovery file.");
    if (process.platform === "win32") {
      if (!/^\\\\\.\\pipe\\wbipc-[\w-]+$/.test(value.endpoint)) throw new Error("Invalid pipe.");
    } else {
      if (!path.isAbsolute(value.endpoint)) throw new Error("Invalid socket.");
      const socket = fs.lstatSync(value.endpoint);
      if (!socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0) {
        throw new Error("Untrusted socket.");
      }
    }
    return { endpoint: value.endpoint, ticket: value.ticket };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    // Never expose discovery contents, tickets, paths or JSON parser excerpts.
    throw new Error("WorkBuddy local connection information is unavailable.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function computeProof(ticket, role, endpoint, clientNonce, serverNonce) {
  const parts = [];
  for (const field of [role === "server" ? "wbipc-s" : "wbipc-c", "1", endpoint, clientNonce, serverNonce]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    parts.push(length, bytes);
  }
  return crypto.createHmac("sha256", ticket).update(Buffer.concat(parts)).digest("base64url");
}

function openWorkbuddyIpc({ discovery, signal, timeoutMs = 12000, connectImpl = net.createConnection }) {
  return new Promise((resolve, reject) => {
    const { endpoint, ticket } = discovery;
    const clientNonce = crypto.randomBytes(16).toString("base64url");
    const pending = new Map();
    let socket;
    let phase = "challenge";
    let channel;
    let nextId = 1;
    let buffer = Buffer.alloc(0);
    let closed = false;
    const timer = setTimeout(() => fail(new Error("WorkBuddy quota request timed out.")), timeoutMs);
    const onAbort = () => fail(new Error("WorkBuddy quota request was cancelled."));

    function fail(error) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
      for (const handlers of pending.values()) handlers.reject(error);
      pending.clear();
      socket?.destroy();
    }
    function send(packet) {
      socket.write(JSON.stringify(packet) + "\n");
    }
    function rpc(method, params, mode) {
      if (closed) return Promise.reject(new Error(UNAVAILABLE));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params, ...(mode ? { mode } : {}) });
      });
    }
    const client = {
      close: () => fail(new Error("WorkBuddy local connection closed.")),
      async postBilling(apiPath, body) {
        if (!BILLING_PATHS.has(apiPath)) throw new Error("Unsupported WorkBuddy quota request.");
        const response = await rpc(`${channel}/http.fetch`, {
          method: "POST",
          path: apiPath,
          headers: { "content-type": "application/json", accept: "application/json" },
          body_b64: Buffer.from(JSON.stringify(body)).toString("base64"),
        }, "call");
        if (response?.status === 401 || response?.status === 403) {
          const error = new Error("WorkBuddy sign-in expired.");
          error.code = "AUTH_EXPIRED";
          throw error;
        }
        if (response?.status !== 200) throw new Error("WorkBuddy quota request failed.");
        try {
          if (typeof response.body_b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(response.body_b64)) {
            throw new Error("Invalid body.");
          }
          return JSON.parse(Buffer.from(response.body_b64, "base64").toString("utf8"));
        } catch {
          throw new Error("WorkBuddy quota response was malformed.");
        }
      },
    };
    function onPacket(packet) {
      if (!packet || typeof packet !== "object") throw new Error("Invalid packet.");
      if (phase === "challenge" && packet.type === "session_challenge" && packet.protocol === 1) {
        if (typeof packet.server_nonce !== "string" || !/^[\w-]{16,128}$/.test(packet.server_nonce)
          || typeof packet.server_proof !== "string") throw new Error("Invalid challenge.");
        const expected = Buffer.from(computeProof(ticket, "server", endpoint, clientNonce, packet.server_nonce));
        const actual = Buffer.from(packet.server_proof);
        if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
          throw new Error("Invalid server proof.");
        }
        phase = "ack";
        send({ type: "session_prove", client_proof: computeProof(ticket, "client", endpoint, clientNonce, packet.server_nonce) });
      } else if (phase === "ack" && packet.type === "session_hello_ack" && packet.protocol === 1
        && Array.isArray(packet.pipes) && packet.pipes.includes("wb.request")) {
        phase = "ready";
        rpc("broker/GetPipe", { pipe: "wb.request" }).then((result) => {
          if (closed) return;
          if (result?.channel !== "c:wb.request" || !Array.isArray(result.methods)
            || !result.methods.includes("http.fetch")) {
            fail(new Error("WorkBuddy billing proxy is unavailable."));
            return;
          }
          channel = result.channel;
          resolve(client);
        }, () => fail(new Error(UNAVAILABLE)));
      } else if (phase === "ready" && packet.jsonrpc === "2.0" && pending.has(packet.id)) {
        const handlers = pending.get(packet.id);
        pending.delete(packet.id);
        if (packet.error) handlers.reject(new Error("WorkBuddy local quota request was rejected."));
        else handlers.resolve(packet.result);
      } else {
        throw new Error("Unexpected packet.");
      }
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      socket = connectImpl(endpoint);
      socket.on("connect", () => send({
        type: "session_hello", protocol_min: 1, protocol_max: 1,
        client_nonce: clientNonce,
        ticket_id: crypto.createHash("sha256").update(ticket, "utf8").digest("hex").slice(0, 16),
        client: { kind: "tokentracker", id: "subscription-quota", version: "1" },
      }));
      socket.on("data", (chunk) => {
        if (closed) return;
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_FRAME_BYTES) { fail(new Error("WorkBuddy quota response was too large.")); return; }
        try {
          let index;
          while ((index = buffer.indexOf(10)) >= 0 && !closed) {
            const line = buffer.subarray(0, index);
            buffer = buffer.subarray(index + 1);
            if (line.length) onPacket(JSON.parse(line.toString("utf8")));
          }
        } catch {
          fail(new Error("WorkBuddy local connection authentication or protocol failed."));
        }
      });
      socket.on("error", () => fail(new Error(UNAVAILABLE)));
      socket.on("close", () => fail(new Error(UNAVAILABLE)));
      socket.on("end", () => fail(new Error(UNAVAILABLE)));
    } catch {
      fail(new Error(UNAVAILABLE));
    }
  });
}

module.exports = { UNAVAILABLE, readWorkbuddyIpcDiscovery, openWorkbuddyIpc };
