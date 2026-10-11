"use strict";
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const directory = process.argv[2];
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const actor = "00000000-0000-4000-8000-000000000099";
const server = http.createServer(async (request, response) => {
  const profile = JSON.parse(fs.readFileSync(path.join(directory, "profile.json")));
  if (request.headers["x-tokentracker-qa-challenge"] !== profile.serverChallenge) {
    response.writeHead(403); response.end(); return;
  }
  let text = ""; for await (const chunk of request) text += chunk;
  const value = JSON.parse(text);
  const identity = { runID: profile.runID.toLowerCase(), runDirectory: profile.runDirectory,
    realm: profile.realm, environment: "sandbox", scansDisabled: true,
    challengeProof: hash(profile.serverChallenge + "\n" + profile.runID.toLowerCase() + "\n" + profile.runDirectory),
    bootstrapSHA256: hash(fs.readFileSync(path.join(directory, "bootstrap.js"))) };
  const order = profile.ownedOrderIDs[0];
  const validOrder = request.url === "/__native-qa/validate-order" && value.order === order && value.realm === profile.realm;
  const validActor = request.url === "/__native-qa/validate-actor" && value.actor === actor && value.actorEpoch === 1 && value.realm === profile.realm;
  if (!validOrder && !validActor) { response.writeHead(403); response.end(); return; }
  if (validOrder) await new Promise(resolve => setTimeout(resolve, 5300));
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ...identity, allowed: true, actor, actorEpoch: 1, ...(validOrder ? { order } : {}) }));
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
