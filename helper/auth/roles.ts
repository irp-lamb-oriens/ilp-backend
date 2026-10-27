/**
 * helper/auth/roles.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Staff sub-roles on dashboard sessions: staff (default) | csm | admin.
 *
 * The role comes from env lists and is resolved on every request
 * (requireDashboardAuth calls staffRoleFor with the session's email), so an
 * address added to or removed from ADMIN_EMAILS takes effect on the next
 * request, not when the 12 h session ends. The `role` stamped on the
 * `dashboard_sessions` doc at login is informational only.
 *
 *   ADMIN_EMAILS=ana@internationallegalpartner.com,…   (admins)
 *   CSM_EMAILS=carla@internationallegalpartner.com,…   (Customer Success Managers)
 *   OWNER_EMAILS=owner@…                               (admins, only while ADMIN_EMAILS is empty)
 *
 * Lists are comma (or semicolon / whitespace) separated; entries are trimmed,
 * lowercased and stripped of surrounding quotes, and the email is compared the
 * same way. When ADMIN_EMAILS and OWNER_EMAILS are both empty nobody is admin
 * (never everyone): warnIfNoAdmins() logs that loudly at startup.
 */

import type { NextFunction, Request, Response } from "express";
import type { AuthedRequest, StaffRole } from "./session.ts";
import log from "../log.ts";

/** The 403 body every role gate sends. The front end keys its "Admins only" state on the status. */
export const ROLE_DENIED_MESSAGE = "Your role does not allow this action.";

function normalizeEmail(v: string): string {
  return v.trim().replace(/^["']+|["']+$/g, "").trim().toLowerCase();
}

function list(name: string): string[] {
  return (Deno.env.get(name) ?? "").split(/[,;\s]+/).map(normalizeEmail).filter(Boolean);
}

/** Admin addresses: ADMIN_EMAILS, or OWNER_EMAILS when ADMIN_EMAILS is empty. */
export function adminEmails(): string[] {
  const admins = list("ADMIN_EMAILS");
  return admins.length ? admins : list("OWNER_EMAILS");
}

export function staffRoleFor(email: string | undefined | null): StaffRole {
  const e = normalizeEmail(email ?? "");
  if (!e) return "staff";
  if (adminEmails().includes(e)) return "admin";
  if (list("CSM_EMAILS").includes(e)) return "csm";
  return "staff";
}

/** Startup check: say loudly when no one can open finance, settings or privacy. */
export function warnIfNoAdmins(): boolean {
  if (adminEmails().length) {
    if (!list("ADMIN_EMAILS").length) {
      log("[roles] ADMIN_EMAILS is empty; OWNER_EMAILS are treated as admins. Set ADMIN_EMAILS.", "warn");
    }
    return true;
  }
  log(
    "[roles] WARNING: ADMIN_EMAILS and OWNER_EMAILS are both empty. No staff member is an admin, so the " +
      "sales report, finance, settings and privacy routes answer 403 for everyone. Set ADMIN_EMAILS.",
    "error",
  );
  return false;
}

/**
 * Gate a route to some staff roles. Use after requireDashboardAuth. admin always
 * passes; with no roles listed only admin passes. The role is resolved
 * from env now (staffRoleFor) when the request carries the staff email.
 */
export function requireStaffRole(...roles: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req as AuthedRequest;
    const role = r.dashboardUser ? staffRoleFor(r.dashboardUser) : (r.dashboardRole ?? "staff");
    r.dashboardRole = role;
    if (role === "admin" || roles.includes(role)) return next();
    res.status(403).json({ error: ROLE_DENIED_MESSAGE, code: "role_denied", requiredRole: roles });
  };
}
