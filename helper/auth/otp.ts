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