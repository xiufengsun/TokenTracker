"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");

// A real local broker fixture, with independently constructed handshake MACs.
async function createWorkbuddyBroker(t, options = {}) {
  const root = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "wb-"));
  const home = path.join(root, "home");
  const ticket = crypto.randomBytes(32).toString("base64url");
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\wbipc-${crypto.randomBytes(8).toString("hex")}` : path.join(root, "b.sock");
  const packets = [];
  const requests = [];
  const sockets = new Set();
  function mac(side, hello, nonce) {
    const values = [`wbipc-${side}`, "1", endpoint, hello.client_nonce, nonce];
    const bytes = Buffer.concat(values.flatMap((value) => {
      const bytes = Buffer.from(value);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }));
    return crypto.createHmac("sha256", ticket).update(bytes).digest("base64url");
  }
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    let hello;
    let outgoing = Promise.resolve();
    const nonce = crypto.randomBytes(16).toString("base64url");
    function send(packet) {
      const bytes = Buffer.from(JSON.stringify(packet) + "\n");
      if (!options.fragment) { socket.write(bytes); return; }
      outgoing = outgoing.then(async () => {
        if (socket.destroyed) return;
        socket.write(bytes.subarray(0, 7));
        await new Promise((resolve) => setImmediate(resolve));
        if (!socket.destroyed) socket.write(bytes.subarray(7));
      });
    }
    socket.on("data", (chunk) => {
      input += chunk;
      let index;
      while ((index = input.indexOf("\n")) >= 0) {
        const packet = JSON.parse(input.slice(0, index));
        input = input.slice(index + 1);
        packets.push(packet);
        if (packet.type === "session_hello") {
          hello = packet;
          assert.equal(packet.ticket_id, crypto.createHash("sha256").update(ticket).digest("hex").slice(0, 16));
          if (options.stallHandshake) continue;
          send({ type: "session_challenge", protocol: 1, server_nonce: nonce,
            server_proof: options.badProof ? "invalid-proof" : mac("s", hello, nonce) });
        } else if (packet.type === "session_prove") {
          assert.equal(packet.client_proof, mac("c", hello, nonce));
          send({ type: "session_hello_ack", protocol: 1, pipes: ["wb.request"] });
        } else if (packet.method === "broker/GetPipe") {
          send({ jsonrpc: "2.0", id: packet.id,
            result: { channel: "c:wb.request", methods: ["http.fetch"] } });
        } else {
          assert.equal(packet.method, "c:wb.request/http.fetch");
          assert.equal(packet.mode, "call");
          assert.equal(packet.params.method, "POST");
          assert.deepEqual(Object.keys(packet.params.headers).sort(), ["accept", "content-type"]);
          const body = JSON.parse(Buffer.from(packet.params.body_b64, "base64"));
          requests.push({ path: packet.params.path, body });
          if (options.stallRequest) continue;
          if (options.closeRequest) { socket.end(); continue; }
          if (options.rpcError) {
            send({ jsonrpc: "2.0", id: packet.id, error: { code: "UPSTREAM", message: options.rpcError } });
            continue;
          }
          const payload = options.respond?.(packet.params.path, body) ?? { code: 0, data: {} };
          send({ jsonrpc: "2.0", id: packet.id, result: {
            status: options.status || 200,
            body_b64: Buffer.from(options.rawBody ?? JSON.stringify(payload)).toString("base64"),
          } });
        }
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
  fs.mkdirSync(path.join(home, "wbipc"), { recursive: true });
  const discoveryPath = path.join(home, "wbipc", "endpoint.json");
  fs.writeFileSync(discoveryPath, JSON.stringify({ endpoint, ticket }), { mode: 0o600 });
  const config = path.join(home, "storage", "test");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, "wb-product-config.json"), JSON.stringify({
    "product-config-snapshot": { data: { endpoint: options.origin || "https://www.workbuddy.cn" } },
  }));
  return { root, home, endpoint, ticket, discoveryPath, packets, requests, sockets };
}

module.exports = { createWorkbuddyBroker };
