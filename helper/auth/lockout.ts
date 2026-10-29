/**
 * helper/auth/lockout.ts — lockout email after 5 wrong sign-in codes (COMMS-P4).
 * ──────────────────────────────────────────────────────────────────────────
 * verifyOtp (otp.ts) removes the code after MAX_OTP_ATTEMPTS failures and
 * calls `sendLockoutEmail`. The address the code was sent to gets one
 * transactional email with recovery steps, at most once per portal and
 * address per Costa Rica day (the queue dedupe key), so repeated guessing
 * never floods the inbox. Reserved and placeholder addresses are dropped by
 * the email queue. Never throws.
 */

import { enqueueEmail } from "../emailQueue.ts";
import { signInLockoutEmail } from "../emailTemplates.ts";
import { TEAM_CC } from "../team.ts";
import log from "../log.ts";

/** OTP collection → portal and its sign-in page. */
export const LOCKOUT_PORTALS: Record<string, { portal: "member" | "lawyer" | "staff"; path: string }> = {
  client_status_otps: { portal: "member", path: "/status" },
  provider_otps: { portal: "lawyer", path: "/lawyer" },
  dashboard_otps: { portal: "staff", path: "/dashboard" },
};

const site = () => (Deno.env.get("PUBLIC_SITE_URL") || Deno.env.get("FRONTEND_URL") || "http://localhost:3000").replace(/\/$/, "");

/** Pure: the queue key (one lockout email per portal, address and day). */
export function lockoutKey(collection: string, email: string, now: Date): string {
  const day = now.toLocaleDateString("en-CA", { timeZone: "America/Costa_Rica" });
  return `lockout_${collection}_${email.trim().toLowerCase()}_${day}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 400);
}

export async function sendLockoutEmail(collection: string, email: unknown, now: Date = new Date()): Promise<boolean> {
  try {
    const to = typeof email === "string" ? email.trim().toLowerCase() : "";
    const p = LOCKOUT_PORTALS[collection];
    if (!to.includes("@") || !p) return false;
    const mail = signInLockoutEmail({ portal: p.portal, signInUrl: `${site()}${p.path}`, supportEmail: Deno.env.get("SUPPORT_EMAIL") || TEAM_CC });
    await enqueueEmail({ to, subject: mail.subject, html: mail.html, text: mail.text }, lockoutKey(collection, to, now));
    return true;
  } catch (err) {
    log(`[auth] lockout email failed: ${err instanceof Error ? err.message : err}`, "error");
    return false;
  }
}
