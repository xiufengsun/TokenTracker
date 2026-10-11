const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");
const { withHome } = require("./helpers/with-home");
const { publicAnonFor, bindPublicInstance } = require("./helpers/public-instance-fixture");

function createRequest({ method = "GET", headers = {}, body } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body != null) yield Buffer.from(body);
    },
  };
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function withTempHome(run) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tokentracker-relay-cookies-"));
  let restoreHome = () => {};
  const prevBaseUrl = process.env.TOKENTRACKER_INSFORGE_BASE_URL;
  const prevFetch = globalThis.fetch;

  try {
    restoreHome = withHome(tmp);
    process.env.TOKENTRACKER_INSFORGE_BASE_URL = "https://relay.example.test";
    await bindPublicInstance(path.join(tmp, ".tokentracker", "tracker"), process.env.TOKENTRACKER_INSFORGE_BASE_URL, publicAnonFor("relay"));
    await run(tmp);
  } finally {
    globalThis.fetch = prevFetch;
    restoreHome();
    if (prevBaseUrl === undefined) delete process.env.TOKENTRACKER_INSFORGE_BASE_URL;
    else process.env.TOKENTRACKER_INSFORGE_BASE_URL = prevBaseUrl;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function getCookiePath(home) {
  return path.join(home, ".tokentracker", "tracker", "relay-cookies.json");
}

test("foreign browser auth requests cannot read or change the persisted session", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    const original = JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=persisted-refresh-token; Path=/; HttpOnly",
    });
    await fs.writeFile(cookiePath, original, "utf8");
    const handler = createLocalApiHandler({ queuePath: path.join(path.dirname(cookiePath), "queue.jsonl") });
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response('{"accessToken":"leaked-access","refreshToken":"leaked-refresh"}', {
        headers: { "content-type": "application/json", "access-control-allow-origin": "https://untrusted.example.invalid" },
      });
    };
    const headersList = [
      { origin: "https://untrusted.example.invalid" },
      { origin: "http://untrusted.example.invalid" },
      { origin: "null" },
      { origin: "http://localhost.untrusted.example.invalid" },
      { referer: "https://untrusted.example.invalid/" },
      { origin: "http://127.0.0.1:8791", referer: "https://untrusted.example.invalid/" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of headersList) {
      for (const [method, route] of [
        ["POST", "refresh"], ["OPTIONS", "refresh"], ["POST", "logout"],
        ["POST", "sign-in"], ["POST", "oauth/exchange"], ["GET", "sessions"],
      ]) {
        const res = createResponse();
        assert.equal(await handler(createRequest({ method, headers, body: "{}" }), res,
          new URL(`http://127.0.0.1:8791/api/auth/${route}`)), true);
        assert.equal(res.statusCode, 403);
        assert.equal(JSON.parse(res.body.toString()).code, "untrusted_auth_origin");
        assert.equal(res.headers["access-control-allow-origin"], undefined);
        assert.equal(res.headers["set-cookie"], undefined);
        assert.equal(await fs.readFile(cookiePath, "utf8"), original);
      }
    }
    assert.equal(upstreamCalls, 0);
  });
});

test("local browser and native auth recovery can still use the persisted refresh token", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.writeFile(cookiePath, JSON.stringify({
      insforge_refresh_token: "insforge_refresh_token=persisted-refresh-token; Path=/; HttpOnly",
    }), "utf8");
    const handler = createLocalApiHandler({ queuePath: path.join(path.dirname(cookiePath), "queue.jsonl") });
    let upstreamCalls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://relay.example.test/api/auth/refresh?client_type=mobile");
      assert.equal(JSON.parse(options.body.toString()).refresh_token, "persisted-refresh-token");
      upstreamCalls += 1;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    const preflight = createResponse();
    await handler(createRequest({ method: "OPTIONS", headers: { origin: "http://127.0.0.1:8791" } }), preflight,
      new URL("http://127.0.0.1:8791/api/auth/refresh"));
    assert.equal(preflight.statusCode, 204);
    assert.equal(upstreamCalls, 0);
    for (const headers of [
      {}, { origin: "http://127.0.0.1:8791" }, { origin: "http://localhost:8791" },
      { origin: "http://[::1]:8791" }, { referer: "http://localhost:8791/auth/native-callback" },
      { "sec-fetch-site": "same-origin" },
    ]) {
      const res = createResponse();
      await handler(createRequest({ method: "POST", headers, body: "{}" }), res,
        new URL("http://127.0.0.1:8791/api/auth/refresh"));
      assert.equal(res.statusCode, 200);
    }
    assert.equal(upstreamCalls, 6);
  });
});

test("auth proxy loads persisted relay cookies into outbound requests", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        session: "session=persisted; Path=/; HttpOnly",
      }),
      "utf8",
    );

    let proxiedCookieHeader = null;
    globalThis.fetch = async (_url, options = {}) => {
      proxiedCookieHeader = options.headers?.cookie || "";
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({ headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/session"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(proxiedCookieHeader, /session=persisted/);
  });
});

test("auth proxy captures set-cookie headers and persists them under an isolated HOME", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);

    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "relay_session=abc123; Path=/; HttpOnly",
        },
      });

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({ headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/login"));

    assert.equal(handled, true);

    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.equal(saved.relay_session, "relay_session=abc123; Path=/; HttpOnly");
  });
});

test("empty in-memory relay cookies do not wipe an existing on-disk session file", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    const original = '{"session":"keep-me"}\n';
    await fs.writeFile(cookiePath, original, "utf8");

    globalThis.fetch = async () =>
      new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "temp_cookie=1; Path=/, temp_cookie=; Max-Age=0; Path=/",
        },
      });

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({ headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.deepEqual(saved, { session: "keep-me" });
  });
});

test("refresh requests without browser auth context use the persisted refresh token fallback", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        insforge_refresh_token: "insforge_refresh_token=persisted-refresh-token; Path=/; HttpOnly",
      }),
      "utf8",
    );

    let proxiedUrl = null;
    let proxiedBody = null;
    let proxiedCookieHeader = "unset";
    globalThis.fetch = async (url, options = {}) => {
      proxiedUrl = String(url);
      proxiedBody = JSON.parse(String(options.body || "{}"));
      proxiedCookieHeader = options.headers?.cookie || "";
      return new Response(
        JSON.stringify({
          accessToken: "access-token",
          refreshToken: "rotated-refresh-token",
          csrfToken: "csrf-from-refresh",
          user: { id: "user-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({ method: "POST", headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(proxiedUrl, "https://relay.example.test/api/auth/refresh?client_type=mobile");
    assert.deepEqual(proxiedBody, { refresh_token: "persisted-refresh-token" });
    assert.equal(proxiedCookieHeader, "");
    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.match(saved.insforge_refresh_token, /^insforge_refresh_token=rotated-refresh-token;/);
    assert.match(saved.insforge_csrf_token, /^insforge_csrf_token=csrf-from-refresh;/);
  });
});

test("refresh requests with csrf context still receive persisted relay cookies", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        refresh: "refresh=valid-token; Path=/; HttpOnly",
        insforge_csrf_token: "insforge_csrf_token=csrf-123; Path=/; SameSite=Lax",
      }),
      "utf8",
    );

    let proxiedCookieHeader = null;
    globalThis.fetch = async (_url, options = {}) => {
      proxiedCookieHeader = options.headers?.cookie || "";
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({
      method: "POST",
      headers: {
        "x-csrf-token": "csrf-123",
      },
    });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(proxiedCookieHeader, /refresh=valid-token/);
  });
});

test("refresh requests prefer persisted relay auth over stale client cookies", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        insforge_refresh_token: "insforge_refresh_token=persisted-refresh-token; Path=/api/auth; HttpOnly",
        insforge_csrf_token: "insforge_csrf_token=persisted-csrf; Path=/; SameSite=Lax",
      }),
      "utf8",
    );

    let proxiedCookieHeader = null;
    let proxiedCsrfHeader = null;
    globalThis.fetch = async (_url, options = {}) => {
      proxiedCookieHeader = options.headers?.cookie || "";
      proxiedCsrfHeader = options.headers?.["x-csrf-token"] || options.headers?.["X-CSRF-Token"] || "";
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({
      method: "POST",
      headers: {
        cookie: "insforge_refresh_token=stale-client-token; insforge_csrf_token=stale-client-csrf",
        "x-csrf-token": "stale-client-csrf",
      },
    });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.match(proxiedCookieHeader, /insforge_refresh_token=persisted-refresh-token/);
    assert.doesNotMatch(proxiedCookieHeader, /stale-client-token/);
    assert.match(proxiedCookieHeader, /insforge_csrf_token=persisted-csrf/);
    assert.equal(proxiedCsrfHeader, "persisted-csrf");
  });
});

test("cookie-less refresh takes the mobile fallback even when a relay csrf token exists", async () => {
  // Regression: app restart after an update leaves the WebView cookie-less.
  // Background mobile rotations leave the relay csrf stale; injecting it as a
  // header forced the cookie/csrf path → 403 Invalid CSRF → signed out.
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        insforge_refresh_token: "insforge_refresh_token=persisted-refresh-token; Path=/; HttpOnly",
        insforge_csrf_token: "insforge_csrf_token=stale-relay-csrf; Path=/; SameSite=Lax",
      }),
      "utf8",
    );

    let proxiedUrl = null;
    let proxiedBody = null;
    globalThis.fetch = async (url, options = {}) => {
      proxiedUrl = String(url);
      proxiedBody = JSON.parse(String(options.body || "{}"));
      return new Response(
        JSON.stringify({
          accessToken: "access-token",
          refreshToken: "rotated-refresh-token",
          csrfToken: "csrf-from-refresh",
          user: { id: "user-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({ method: "POST", headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(proxiedUrl, "https://relay.example.test/api/auth/refresh?client_type=mobile");
    assert.deepEqual(proxiedBody, { refresh_token: "persisted-refresh-token" });
    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.match(saved.insforge_refresh_token, /^insforge_refresh_token=rotated-refresh-token;/);
    assert.match(saved.insforge_csrf_token, /^insforge_csrf_token=csrf-from-refresh;/);
  });
});

test("403 invalid csrf on the cookie path is rescued via the mobile flow", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        insforge_refresh_token: "insforge_refresh_token=persisted-refresh-token; Path=/; HttpOnly",
        insforge_csrf_token: "insforge_csrf_token=stale-relay-csrf; Path=/; SameSite=Lax",
      }),
      "utf8",
    );

    const proxiedUrls = [];
    globalThis.fetch = async (url, options = {}) => {
      proxiedUrls.push(String(url));
      if (proxiedUrls.length === 1) {
        // Cookie/csrf path: stale relayed csrf → upstream rejects and tells the
        // browser to delete its refresh cookie.
        return new Response(JSON.stringify({ message: "Invalid CSRF token" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "insforge_refresh_token=; Path=/api/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly",
          },
        });
      }
      assert.deepEqual(JSON.parse(String(options.body || "{}")), {
        refresh_token: "persisted-refresh-token",
      });
      assert.equal(options.headers?.cookie, undefined);
      return new Response(
        JSON.stringify({
          accessToken: "rescued-access-token",
          refreshToken: "rescued-refresh-token",
          csrfToken: "rescued-csrf",
          user: { id: "user-1" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({
      method: "POST",
      headers: {
        cookie: "insforge_refresh_token=stale-client-token; insforge_csrf_token=stale-client-csrf",
        "x-csrf-token": "stale-client-csrf",
      },
    });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(proxiedUrls.length, 2);
    assert.equal(proxiedUrls[1], "https://relay.example.test/api/auth/refresh?client_type=mobile");
    assert.match(JSON.parse(res.body.toString("utf8")).accessToken, /^rescued-access-token$/);
    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.match(saved.insforge_refresh_token, /^insforge_refresh_token=rescued-refresh-token;/);
    assert.match(saved.insforge_csrf_token, /^insforge_csrf_token=rescued-csrf;/);
  });
});

test("deletion set-cookies on error responses do not destroy the persisted relay session", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        insforge_refresh_token: "insforge_refresh_token=still-valid-token; Path=/; HttpOnly",
      }),
      "utf8",
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "AUTH_UNAUTHORIZED" }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "set-cookie":
            "insforge_refresh_token=; Path=/api/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly",
        },
      });

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({
      method: "POST",
      headers: { cookie: "some_cookie=1" },
    });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/session"));

    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.match(saved.insforge_refresh_token, /=still-valid-token;/);
  });
});

test("stale refresh csrf errors do not clear relay cookies when no relay cookies were replayed", async () => {
  await withTempHome(async (home) => {
    const cookiePath = getCookiePath(home);
    await fs.mkdir(path.dirname(cookiePath), { recursive: true });
    await fs.writeFile(
      cookiePath,
      JSON.stringify({
        other_cookie: "other_cookie=keep-me; Path=/; HttpOnly",
      }),
      "utf8",
    );

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "Invalid CSRF token" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });

    const handler = createLocalApiHandler({ queuePath: path.join(home, ".tokentracker", "tracker", "queue.jsonl") });
    const req = createRequest({ method: "POST", headers: {} });
    const res = createResponse();

    const handled = await handler(req, res, new URL("http://localhost/api/auth/refresh"));

    assert.equal(handled, true);
    const saved = JSON.parse(await fs.readFile(cookiePath, "utf8"));
    assert.deepEqual(saved, { other_cookie: "other_cookie=keep-me; Path=/; HttpOnly" });
  });
});
