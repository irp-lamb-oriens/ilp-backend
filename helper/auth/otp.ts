/**
 * helper/auth/otp.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Shared OTP + session-token primitives for the ILP platform.
 *
 * Extracted from `API/dashboard/dashboardRouter.ts` so the dashboard OTP flow
 * (Phase 0) and the future client-status OTP flow (Phase 1) share one
 * implementation instead of duplicating the crypto + domain-check logic.
 *
 * Backward compatible: `dashboardRouter.ts` re-imports these exact functions,
 * so the existing `/api/dashboard/auth/*` routes behave identically.
 */

/** Default staff domain when `DASHBOARD_ALLOWED_DOMAIN` is unset. */
const DEFAULT_ALLOWED_DOMAIN = "internationallegalpartner.com";

/** Resolve the allowed staff email domain (env-overridable). */
export function allowedDomain(): string {
  return Deno.env.get("DASHBOARD_ALLOWED_DOMAIN") ?? DEFAULT_ALLOWED_DOMAIN;
}

/**
 * Generate a cryptographically random 6-digit OTP. Uses `crypto.getRandomValues`
 * (not `Math.random`) so codes are not predictable.
 */
export function generateOtp(): string {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  const n = ((arr[0] << 24) | (arr[1] << 16) | (arr[2] << 8) | arr[3]) >>> 0;
  return String(100000 + (n % 900000));
}

/**
 * Generate a 64-hex-char (32-byte) session token. Cryptographically random.
 */
export function generateSessionToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Turn an email into a Firestore-safe doc id by replacing `@` and `.` with `_`.
 * Used for both `dashboard_otps` and `client_status_otps` doc ids.
 */
export function emailToDocId(email: string): string {
  return email.replace(/[@.]/g, "_");
}

/** True when `email` belongs to the allowed staff domain. */
export function isAllowedDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain === allowedDomain();
}

// ─── Hardened OTP storage & verification ───────────────────────────────────
// Codes are never stored in clear text: we keep a salted SHA-256 hash, count
// failed attempts per OTP document, delete the document on success, and lock
// out after MAX_OTP_ATTEMPTS. Comparison is constant time.

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import remove from "../../db/delete.ts";
import { sendLockoutEmail } from "./lockout.ts"; // COMMS-P4

export const OTP_TTL_MS = 10 * 60 * 1000;
export const MAX_OTP_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

const enc = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function pepper(): string {
  return Deno.env.get("OTP_PEPPER") ?? "";
}

async function hashCode(code: string, salt: string): Promise<string> {
  return await sha256Hex(`${pepper()}:${salt}:${code.trim()}`);
}

export type IssueOtpResult =
  | { ok: true; code: string }
  | { ok: false; status: number; error: string };

/**
 * Create (or replace) an OTP document. Returns the clear code ONLY so the
 * caller can email it; it is not persisted. Enforces a resend cooldown.
 */
export async function issueOtp(
  collection: string,
  docId: string,
  email: string,
  extra: Record<string, unknown> = {},
): Promise<IssueOtpResult> {
  const existing = await get(collection, docId).catch(() => null);
  if (existing?.createdAt) {
    const age = Date.now() - new Date(existing.createdAt as string).getTime();
    if (age < OTP_RESEND_COOLDOWN_MS) {
      return { ok: false, status: 429, error: "Please wait a moment before requesting another code." };
    }
  }
  const code = generateOtp();
  const salt = generateSessionToken().slice(0, 16);
  const now = new Date();
  await put(collection, docId, {
    ...extra,
    email: email.trim().toLowerCase(),
    codeHash: await hashCode(code, salt),
    salt,
    attempts: 0,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
  });
  return { ok: true, code };
}

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** Verify and consume an OTP. Single use; capped attempts. */
export async function verifyOtp(
  collection: string,
  docId: string,
  code: unknown,
): Promise<VerifyOtpResult> {
  const doc = await get(collection, docId);
  if (!doc) {
    return { ok: false, status: 401, error: "No verification code found. Please request a new one." };
  }
  if (new Date(doc.expiresAt as string) < new Date()) {
    await remove(collection, docId).catch(() => {});
    return { ok: false, status: 401, error: "Verification code expired." };
  }
  const attempts = Number(doc.attempts ?? 0);
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await remove(collection, docId).catch(() => {});
    return { ok: false, status: 429, error: "Too many attempts. Please request a new code." };
  }
  const given = await hashCode(String(code ?? ""), String(doc.salt ?? ""));
  if (!doc.codeHash || !timingSafeEqualStr(given, String(doc.codeHash))) {
    const next = attempts + 1;
    if (next >= MAX_OTP_ATTEMPTS) {
      await remove(collection, docId).catch(() => {});
      // COMMS-P4: tell the address owner, with recovery steps (once a day per portal).
      await sendLockoutEmail(collection, doc.email);
      return { ok: false, status: 429, error: "Too many attempts. Please request a new code." };
    }
    await put(collection, docId, { ...doc, attempts: next });
    return { ok: false, status: 401, error: "Invalid verification code." };
  }
  await remove(collection, docId).catch(() => {});
  return { ok: true };
}
