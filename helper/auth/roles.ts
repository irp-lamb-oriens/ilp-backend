/**
 * helper/auth/roles.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Staff sub-roles on dashboard sessions: staff (default) | csm | admin.
 * Assigned at login from env lists; stored on the `dashboard_sessions` doc as
 * `role` and attached to the request as `dashboardRole`.
 *
 *   ADMIN_EMAILS=ana@internationallegalpartner.com,…
 *   CSM_EMAILS=carla@internationallegalpartner.com,…
 */

import type { NextFunction, Request, Response } from "express";
import type { AuthedRequest, StaffRole } from "./session.ts";

function list(name: string): string[] {
  return (Deno.env.get(name) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function staffRoleFor(email: string): StaffRole {
  const e = email.trim().toLowerCase();
  if (list("ADMIN_EMAILS").includes(e)) return "admin";
  if (list("CSM_EMAILS").includes(e)) return "csm";
  return "staff";
}

/** Gate a route to some staff roles. Use after requireDashboardAuth. admin always passes. */
export function requireStaffRole(...roles: StaffRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = (req as AuthedRequest).dashboardRole ?? "staff";
    if (role === "admin" || roles.includes(role)) return next();
    res.status(403).json({ error: "Your role does not allow this action." });
  };
}
