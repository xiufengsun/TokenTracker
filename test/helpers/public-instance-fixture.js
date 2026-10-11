"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

function publicAnonFor(instance) {
  return [Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ role: "anon", instance })).toString("base64url"), "fixture-signature"].join(".");
}

async function bindPublicInstance(directory, baseUrl, anonKey, config = {}) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({ ...config, baseUrl, anonKey }), { mode: 0o600 });
  await fs.writeFile(path.join(directory, "runtime-instance.json"), JSON.stringify({
    fingerprint: createHash("sha256").update(`${baseUrl}\0${anonKey}`).digest("hex"),
  }), { mode: 0o600 });
}

module.exports = { publicAnonFor, bindPublicInstance };
