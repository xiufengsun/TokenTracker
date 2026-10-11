import { BillingError } from "./contracts.ts";

const encoder = new TextEncoder();
export function bytes(value: string): Uint8Array<ArrayBuffer> { return encoder.encode(value); }
export function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { throw new BillingError("invalid_signature", 401); }
}
export function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new BillingError("invalid_signature", 401);
  return Uint8Array.from(value.match(/../g)!, part => parseInt(part, 16));
}
export function pemBytes(value: string): Uint8Array<ArrayBuffer> {
  return base64Bytes(value.replace(/-----[^-]+-----|\s/g, ""));
}
export function freshTimestamp(value: string, nowMs: number, toleranceSeconds: number): void {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) ||
    Math.abs(nowMs / 1000 - Number(value)) > toleranceSeconds) throw new BillingError("stale_signature", 401);
}
export async function verifyRsa(publicKeyPem: string, message: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", pemBytes(publicKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64Bytes(signature), bytes(message));
  } catch { return false; }
}
export async function signRsa(privateKeyPem: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytes(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
