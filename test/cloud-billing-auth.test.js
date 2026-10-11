const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac, generateKeyPairSync, randomUUID, sign } = require("node:crypto");
const { billingUserId } = require("./helpers/load-cloud-module")("auth");
const secret = "local-test-jwt-secret";
const userId = randomUUID();
const now = Date.now();
function jwt(claims, header = { alg: "HS256" }, signer) {
  const input = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  const signature = signer ? signer(input) : createHmac("sha256", secret).update(input).digest();
  return `Bearer ${input}.${signature.toString("base64url")}`;
}
const claims = { sub: userId, role: "authenticated", exp: Math.floor(now/1000)+3600 };

test("billing accepts valid user JWTs and verifies both supported signature algorithms", async () => {
  assert.equal(await billingUserId(jwt(claims), { jwtSecret: secret }, now), userId);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const token = jwt(claims, { alg: "RS256" }, input => sign("RSA-SHA256", Buffer.from(input), keys.privateKey));
  assert.equal(await billingUserId(token, { jwtPublicKey: keys.publicKey }, now), userId);
});

test("unsigned, expired, future, anonymous, service-role, or malformed identities cannot access billing", async () => {
  const invalid = [
    jwt({ ...claims, exp: Math.floor(now/1000)-1 }),
    jwt({ ...claims, exp: undefined }),
    jwt({ ...claims, nbf: Math.floor(now/1000)+300 }),
    jwt({ ...claims, role: "anon" }),
    jwt({ ...claims, role: "service_role" }),
    jwt({ ...claims, sub: "not-an-account" }),
    jwt(claims, { alg: "none" }),
    jwt(claims, { alg: "HS256" }, () => Buffer.from("wrong-signature")),
    null,
  ];
  for (const token of invalid) await assert.rejects(billingUserId(token, { jwtSecret: secret }, now), /sign_in_required/);
});
