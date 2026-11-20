const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  isClaudeTokenStale,
  refreshClaudeTokens,
  persistRefreshedClaudeAuth,
  CLAUDE_REFRESH_ENDPOINT,
  CLAUDE_CLIENT_ID,
  CLAUDE_DEFAULT_SCOPES,
  CLAUDE_ACCESS_TOKEN_REFRESH_WINDOW_MS,
  CLAUDE_AUTH_EXPIRED_MESSAGE,
} = require("../src/lib/claude-token-refresh");

describe("isClaudeTokenStale", () => {
  it("treats null or empty auth bundle as stale", () => {
    assert.equal(isClaudeTokenStale(null), true);
    assert.equal(isClaudeTokenStale({}), true);
    assert.equal(isClaudeTokenStale({ accessToken: "" }), true);
  });

  it("returns false when token expires in more than 5 minutes", () => {
    const now = Date.parse("2026-05-05T00:00:00Z");
    assert.equal(
      isClaudeTokenStale(
        { accessToken: "valid-tok", expiresAtMs: now + 6 * 60 * 1000 },
        now,
      ),
      false,
    );
  });

  it("returns true when token expires within 5 minutes or already expired", () => {
    const now = Date.parse("2026-05-05T00:00:00Z");
    assert.equal(
      isClaudeTokenStale(
        { accessToken: "valid-tok", expiresAtMs: now + 5 * 60 * 1000 },
        now,
      ),
      true,
    );
    assert.equal(
      isClaudeTokenStale(
        { accessToken: "valid-tok", expiresAtMs: now + 2 * 60 * 1000 },
        now,
      ),
      true,
    );
    assert.equal(
      isClaudeTokenStale(
        { accessToken: "valid-tok", expiresAtMs: now - 1000 },
        now,
      ),
      true,
    );
  });

  it("uses the 5-minute refresh window constant", () => {
    assert.equal(CLAUDE_ACCESS_TOKEN_REFRESH_WINDOW_MS, 5 * 60 * 1000);
  });
});

describe("refreshClaudeTokens", () => {
  it("posts to Claude OAuth endpoint with client id and refresh token", async () => {
    let observedUrl = null;
    let observedBody = null;
    let observedHeaders = null;
    const now = Date.parse("2026-05-05T00:00:00Z");

    const result = await refreshClaudeTokens({
      refreshToken: "rt-test-123",
      scopes: ["user:inference", "user:profile"],
      nowMs: now,
      fetchImpl: async (url, opts) => {
        observedUrl = url;
        observedBody = JSON.parse(opts.body);
        observedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            token_type: "Bearer",
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 28800,
            refresh_token_expires_in: 1900000,
            scope: "user:inference user:profile",
          }),
        };
      },
    });

    assert.equal(observedUrl, CLAUDE_REFRESH_ENDPOINT);
    assert.equal(observedBody.client_id, CLAUDE_CLIENT_ID);
    assert.equal(observedBody.grant_type, "refresh_token");
    assert.equal(observedBody.refresh_token, "rt-test-123");
    assert.equal(observedBody.scope, "user:inference user:profile");
    assert.equal(observedHeaders["Content-Type"], "application/json");

    assert.equal(result.accessToken, "new-access-token");
    assert.equal(result.refreshToken, "new-refresh-token");
    assert.equal(result.expiresAt, now + 28800 * 1000);
    assert.equal(result.refreshTokenExpiresAt, now + 1900000 * 1000);
    assert.deepEqual(result.scopes, ["user:inference", "user:profile"]);
  });

  it("preserves old refresh_token if server response does not contain a new one", async () => {
    const now = Date.parse("2026-05-05T00:00:00Z");
    const result = await refreshClaudeTokens({
      refreshToken: "rt-keep-me",
      nowMs: now,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "new-acc",
          expires_in: 3600,
        }),
      }),
    });

    assert.equal(result.accessToken, "new-acc");
    assert.equal(result.refreshToken, "rt-keep-me");
    assert.equal(result.expiresAt, now + 3600 * 1000);
  });

  it("throws NO_REFRESH_TOKEN when refreshToken is missing", async () => {
    await assert.rejects(
      async () => refreshClaudeTokens({ refreshToken: "" }),
      { code: "NO_REFRESH_TOKEN" },
    );
  });

  it("throws REFRESH_TOKEN_EXPIRED with user-friendly message on 400/401", async () => {
    await assert.rejects(
      async () =>
        refreshClaudeTokens({
          refreshToken: "rt-invalid",
          fetchImpl: async () => ({
            ok: false,
            status: 400,
            json: async () => ({ error: "invalid_grant" }),
          }),
        }),
      (err) => {
        assert.equal(err.code, "REFRESH_TOKEN_EXPIRED");
        assert.equal(err.message, CLAUDE_AUTH_EXPIRED_MESSAGE);
        return true;
      },
    );
  });

  it("throws REFRESH_HTTP_ERROR on 500 error", async () => {
    await assert.rejects(
      async () =>
        refreshClaudeTokens({
          refreshToken: "rt-test",
          fetchImpl: async () => ({
            ok: false,
            status: 500,
          }),
        }),
      { code: "REFRESH_HTTP_ERROR" },
    );
  });

  it("throws REFRESH_INVALID_RESPONSE if access_token is missing from response", async () => {
    await assert.rejects(
      async () =>
        refreshClaudeTokens({
          refreshToken: "rt-test",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({}),
          }),
        }),
      { code: "REFRESH_INVALID_RESPONSE" },
    );
  });
});

describe("persistRefreshedClaudeAuth", () => {
  it("updates keychain on macOS via security add-generic-password", async () => {
    let observedArgs = null;
    const runner = (bin, args) => {
      observedArgs = { bin, args };
      return { status: 0 };
    };

    const currentPayload = {
      claudeAiOauth: {
        accessToken: "old-acc",
        refreshToken: "old-rt",
        subscriptionType: "team",
      },
    };

    const newTokens = {
      accessToken: "new-acc",
      refreshToken: "new-rt",
      expiresAt: 1799999999000,
      refreshTokenExpiresAt: 1899999999000,
      scopes: ["user:inference"],
    };

    const res = await persistRefreshedClaudeAuth({
      currentPayload,
      newTokens,
      platform: "darwin",
      service: "Claude Code-credentials",
      account: "testuser",
      securityRunner: runner,
    });

    assert.equal(observedArgs.bin, "security");
    assert.deepEqual(observedArgs.args.slice(0, 5), [
      "add-generic-password",
      "-s",
      "Claude Code-credentials",
      "-a",
      "testuser",
    ]);
    assert.equal(observedArgs.args[observedArgs.args.length - 1], "-U");

    const writtenJson = JSON.parse(observedArgs.args[6]);
    assert.equal(writtenJson.claudeAiOauth.accessToken, "new-acc");
    assert.equal(writtenJson.claudeAiOauth.refreshToken, "new-rt");
    assert.equal(writtenJson.claudeAiOauth.expiresAt, 1799999999000);
    assert.equal(writtenJson.claudeAiOauth.subscriptionType, "team");
    assert.equal(res.claudeAiOauth.accessToken, "new-acc");
  });

  it("atomically writes to .credentials.json on Linux", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-claude-persist-linux-"));
    try {
      const credDir = path.join(tmp, ".claude");
      fs.mkdirSync(credDir, { recursive: true });
      const credPath = path.join(credDir, ".credentials.json");

      const currentPayload = {
        otherSetting: "preserve-me",
        claudeAiOauth: {
          accessToken: "old-acc",
          refreshToken: "old-rt",
          subscriptionType: "pro",
        },
      };
      fs.writeFileSync(credPath, JSON.stringify(currentPayload));

      const newTokens = {
        accessToken: "new-acc",
        refreshToken: "new-rt",
        expiresAt: 1799999999000,
      };

      await persistRefreshedClaudeAuth({
        currentPayload,
        newTokens,
        platform: "linux",
        credentialsPath: credPath,
      });

      const updated = JSON.parse(fs.readFileSync(credPath, "utf8"));
      assert.equal(updated.otherSetting, "preserve-me");
      assert.equal(updated.claudeAiOauth.accessToken, "new-acc");
      assert.equal(updated.claudeAiOauth.refreshToken, "new-rt");
      assert.equal(updated.claudeAiOauth.subscriptionType, "pro");
      assert.equal(updated.claudeAiOauth.expiresAt, 1799999999000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips writing if stored refreshToken changed concurrently (macOS and Linux)", async () => {
    let writeCalled = false;
    const runner = (_bin, args) => {
      if (args[0] === "find-generic-password") {
        return {
          status: 0,
          stdout: JSON.stringify({
            claudeAiOauth: { accessToken: "other-acc", refreshToken: "other-rt" },
          }),
        };
      }
      writeCalled = true;
      return { status: 0 };
    };

    const macResult = await persistRefreshedClaudeAuth({
      currentPayload: { claudeAiOauth: { accessToken: "old-acc", refreshToken: "old-rt" } },
      newTokens: { accessToken: "new-acc", refreshToken: "new-rt", expiresAt: 1799999999000 },
      platform: "darwin",
      service: "Claude Code-credentials",
      account: "testuser",
      securityRunner: runner,
    });
    assert.equal(writeCalled, false);
    assert.equal(macResult.claudeAiOauth.refreshToken, "other-rt");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-claude-persist-race-"));
    try {
      const credDir = path.join(tmp, ".claude");
      fs.mkdirSync(credDir, { recursive: true });
      const credPath = path.join(credDir, ".credentials.json");
      fs.writeFileSync(
        credPath,
        JSON.stringify({ claudeAiOauth: { accessToken: "other-acc", refreshToken: "other-rt" } }),
      );

      await persistRefreshedClaudeAuth({
        currentPayload: { claudeAiOauth: { accessToken: "old-acc", refreshToken: "old-rt" } },
        newTokens: { accessToken: "new-acc", refreshToken: "new-rt", expiresAt: 1799999999000 },
        platform: "linux",
        credentialsPath: credPath,
      });

      const onDisk = JSON.parse(fs.readFileSync(credPath, "utf8"));
      assert.equal(onDisk.claudeAiOauth.refreshToken, "other-rt");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
