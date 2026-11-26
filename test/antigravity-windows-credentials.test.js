"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadAntigravityCredentials,
  probeAntigravityPortResult,
  decodeAntigravityWindowsCredentialBlob,
} = require("../src/lib/usage-limits");

const payload = JSON.stringify({
  token: {
    access_token: "ya29.credential-manager",
    refresh_token: "1//credential-manager",
    expiry: "2099-01-01T00:00:00Z",
  },
});

describe("Windows Antigravity Credential Manager", () => {
  it("reads the gemini:antigravity generic credential via credentialRunner", async () => {
    const creds = await loadAntigravityCredentials({
      home: path.join(os.tmpdir(), "tokentracker-agy-no-home-win"),
      platform: "win32",
      credentialRunner(target) {
        assert.equal(target, "gemini:antigravity");
        return { status: 0, stdout: `${payload}\n` };
      },
    });
    assert.equal(creds.accessToken, "ya29.credential-manager");
    assert.equal(creds.source, "credential-manager");
    assert.equal(creds.path, null);
  });

  it("does not read Credential Manager on linux unless a runner is injected", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-win-linux-"));
    try {
      const creds = await loadAntigravityCredentials({ home: tmp, platform: "linux" });
      assert.equal(creds, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers a fresh Credential Manager token over an expired file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-agy-win-fresh-"));
    try {
      const credPath = path.join(tmp, ".gemini", "antigravity-cli", "antigravity-oauth-token");
      fs.mkdirSync(path.dirname(credPath), { recursive: true });
      fs.writeFileSync(credPath, JSON.stringify({
        token: { access_token: "ya29.file-stale", refresh_token: "1//file-stale", expiry: "2020-01-01T00:00:00Z" },
      }), "utf8");
      const creds = await loadAntigravityCredentials({
        home: tmp,
        platform: "win32",
        nowMs: Date.parse("2026-11-26T00:00:00.000Z"),
        credentialRunner() { return { status: 0, stdout: payload }; },
      });
      assert.equal(creds.source, "credential-manager");
      assert.equal(creds.accessToken, "ya29.credential-manager");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Windows Credential Manager blob decoding", () => {
  const token = (pad) => JSON.stringify({
    token: {
      access_token: "ya29.blob",
      refresh_token: "1//blob",
      expiry: "2099-01-01T00:00:00Z",
      note: pad,
    },
  });

  it("decodes UTF-8 JSON of both odd and even byte lengths", () => {
    const odd = token("x");
    const even = token("xy");
    assert.equal(Buffer.byteLength(odd, "utf8") % 2, 1);
    assert.equal(Buffer.byteLength(even, "utf8") % 2, 0);
    assert.equal(JSON.parse(decodeAntigravityWindowsCredentialBlob(Buffer.from(odd, "utf8"))).token.access_token, "ya29.blob");
    assert.equal(JSON.parse(decodeAntigravityWindowsCredentialBlob(Buffer.from(even, "utf8"))).token.access_token, "ya29.blob");
  });

  it("decodes UTF-16LE JSON when UTF-8 is not a valid credential", () => {
    const json = token("utf16");
    const blob = Buffer.from(json, "utf16le");
    assert.equal(JSON.parse(decodeAntigravityWindowsCredentialBlob(blob)).token.access_token, "ya29.blob");
  });

  it("reads an even-length UTF-8 blob from the agy-cred-b64 runner form", async () => {
    const even = token("xy");
    assert.equal(Buffer.byteLength(even, "utf8") % 2, 0);
    const creds = await loadAntigravityCredentials({
      home: path.join(os.tmpdir(), "tokentracker-agy-b64-even"),
      platform: "win32",
      credentialRunner() {
        return { status: 0, stdout: `agy-cred-b64:${Buffer.from(even, "utf8").toString("base64")}` };
      },
    });
    assert.equal(creds.accessToken, "ya29.blob");
    assert.equal(creds.source, "credential-manager");
  });
});

describe("Antigravity HTTPS probe fallback", () => {
  it("treats an HTTPS 401 as a TLS response and does not recommend HTTP", async () => {
    const requestFn = async () => {
      throw new Error("HTTP 401: {\"code\":\"unauthenticated\",\"message\":\"unauthenticated: missing CSRF token\"}");
    };
    const result = await probeAntigravityPortResult(18765, null, { requestFn, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.responded, true);
  });

  it("treats an HTTPS 200 with invalid JSON as a TLS response", async () => {
    const requestFn = async () => {
      throw new Error("Invalid JSON response: Unexpected end of JSON input");
    };
    const result = await probeAntigravityPortResult(18765, null, { requestFn, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.equal(result.responded, true);
  });

  it("still allows an HTTP fallback when HTTPS never answers", async () => {
    const requestFn = async ({ scheme }) => {
      if (scheme === "https") throw new Error("connect ECONNREFUSED 127.0.0.1:18765");
      throw new Error("HTTP 401: missing CSRF token");
    };
    const https = await probeAntigravityPortResult(18765, null, { requestFn, timeoutMs: 1000, scheme: "https" });
    assert.equal(https.ok, false);
    assert.equal(https.responded, false);
    const http = await probeAntigravityPortResult(18765, null, { requestFn, timeoutMs: 1000, scheme: "http" });
    assert.equal(http.ok, false);
    assert.equal(http.responded, true);
  });

});
