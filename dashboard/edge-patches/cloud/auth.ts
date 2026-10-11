import { BillingError, object, uuid } from "./contracts.ts";
import { base64Bytes, bytes, pemBytes } from "./cryptography.ts";

export async function billingUserId(
  authorization: string | null,
  secrets: { jwtSecret?: string; jwtPublicKey?: string },
  nowMs = Date.now(),
): Promise<string> {
  if (!authorization?.startsWith("Bearer ")) throw new BillingError("sign_in_required", 401);
  const token = authorization.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) throw new BillingError("sign_in_required", 401);
  try {
    const decode = (value: string) => base64Bytes(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
    const header = object(JSON.parse(new TextDecoder().decode(decode(parts[0]))));
    let key: CryptoKey;
    let algorithm: string;
    if (header.alg === "HS256" && secrets.jwtSecret) {
      algorithm = "HMAC";
      key = await crypto.subtle.importKey("raw", bytes(secrets.jwtSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    } else if (header.alg === "RS256" && secrets.jwtPublicKey) {
      algorithm = "RSASSA-PKCS1-v1_5";
      key = await crypto.subtle.importKey("spki", pemBytes(secrets.jwtPublicKey), { name: algorithm, hash: "SHA-256" }, false, ["verify"]);
    } else throw new BillingError("sign_in_required", 401);
    if (!await crypto.subtle.verify(algorithm, key, decode(parts[2]), bytes(`${parts[0]}.${parts[1]}`))) {
      throw new BillingError("sign_in_required", 401);
    }
    const claims = object(JSON.parse(new TextDecoder().decode(decode(parts[1]))));
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowMs / 1000 ||
      (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowMs / 1000)) ||
      claims.role === "anon" || claims.role === "service_role") throw new BillingError("sign_in_required", 401);
    return uuid(claims.sub || claims.user_id);
  } catch { throw new BillingError("sign_in_required", 401); }
}
