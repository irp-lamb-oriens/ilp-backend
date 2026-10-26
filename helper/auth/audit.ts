/**
 * helper/auth/audit.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Audit writes for authentication events (master plan section 24):
 *   auth.login         successful OTP verification, all three portals
 *   auth.login_failed  rejected OTP verification (wrong / expired / locked)
 *   auth.logout        explicit logout
 *   auth.logout_all    "sign out everywhere": every session of that email ended
 *   auth.staff_bypass  a staff session acting inside the lawyer or client portal
 *
 * Writes are fire-and-forget: an audit failure is logged, never surfaced to
 * the user. Staff bypass entries are throttled per (staff, target) so a page
 * that fires twenty requests writes one row, not twenty.
 */

import auditLog from "../auditLog.ts";
import log from "../log.ts";

export type PortalRole = "staff" | "lawyer" | "client";

export function auditAuth(
  action: "auth.login" | "auth.login_failed" | "auth.logout" | "auth.logout_all" | "auth.staff_bypass",
  actor: { email: string; role: string; uid?: string },
  target: string,
  meta: Record<string, unknown> = {},
): void {
  auditLog({
    actor: { uid: actor.uid ?? actor.email, email: actor.email, role: actor.role },
    action,
    target,
    meta,
  }).catch((err) => log(`[audit] ${action} write failed: ${err instanceof Error ? err.message : err}`, "error"));
}

const BYPASS_WINDOW_MS = 10 * 60 * 1000;
const lastBypass = new Map<string, number>();

/** Record a staff bypass/impersonation at most once per window per (staff, target). */
export function auditStaffBypass(
  staffEmail: string,
  portal: "lawyer" | "client",
  target: string,
  meta: Record<string, unknown> = {},
  now = Date.now(),
): boolean {
  const key = `${staffEmail}|${portal}|${target}`;
  const prev = lastBypass.get(key);
  if (prev !== undefined && now - prev < BYPASS_WINDOW_MS) return false;
  lastBypass.set(key, now);
  if (lastBypass.size > 5000) lastBypass.clear();
  auditAuth("auth.staff_bypass", { email: staffEmail, role: "staff" }, target, { portal, ...meta });
  return true;
}
