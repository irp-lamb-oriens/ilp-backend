/**
 * Verify an ILP user-session JWT (HS256) signed with JWT_SECRET and decode it
 * into an AccessTokenPayload. Throws on malformed, expired, or bad-signature
 * tokens. This is the platform's OWN session JWT (symmetric secret), distinct
 * from the Google OAuth assertion used for Firestore access in
 * helper/getAccessToken.ts.
 *
 * Uses node:crypto for a synchronous HMAC-SHA256, mirroring the IRP-funnel
 * backend's proven synchronous crypto pattern (helper/actionToken.ts). The
 * HMAC + timing-safe comparison keeps callers (validateUser) synchronous and
 * backward compatible.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AccessTokenPayload } from "./types.ts";

function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Decode a base64url segment into raw bytes (for the signature). */
function base64UrlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function getSecret(): string {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) {
    throw new Error(
      "JWT_SECRET is not configured; user-session tokens cannot be verified.",
    );
  }
  return secret;
}

function signBytes(signingInput: string, secret: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(signingInput).digest());
}

export function decodePayload(token: string): AccessTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }
  const payload = JSON.parse(base64UrlDecode(parts[1])) as AccessTokenPayload;

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("Token expired");
  }
  return payload;
}

export function verifyToken(token: string): AccessTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }

  // Reject non-HS256 tokens before trusting any payload claim. The platform
  // session JWT is symmetric; accepting other algs would reopen the decode-only
  // hole this replacement closes.
  const header = JSON.parse(base64UrlDecode(parts[0])) as { alg?: string };
  if (header.alg !== "HS256") {
    throw new Error("Unsupported token algorithm");
  }

  const payload = decodePayload(token);

  const expected = signBytes(`${parts[0]}.${parts[1]}`, getSecret());
  const provided = base64UrlToBytes(parts[2]);

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error("Invalid token signature");
  }

  return payload;
}