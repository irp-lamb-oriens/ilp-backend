/**
 * helper/auth/sessionHooks.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Login side effects registered on loginHooks, plus the logout routes.
 *
 * On a successful verify-otp:
 *   - set the role's HttpOnly session cookie (see cookies.ts for names);
 *   - staff: stamp `role` (staff | csm | admin) on the dashboard session and
 *     return it in the JSON body.
 * The JSON body still carries `token`, so header-token clients keep working.
 *
 * Logout (all clear the cookie, delete the session doc, write audit):
 *   POST /api/dashboard/auth/logout
 *   POST /api/provider/auth/logout
 *   POST /api/client-status/auth/logout
 */

import type { Express, Request, Response } from "express";
import patch from "../../db/patch.ts";
import remove from "../../db/delete.ts";
import get from "../../db/get.ts";
import log from "../log.ts";
import { auditAuth, type PortalRole } from "./audit.ts";
import { clearSessionCookie, cookieToken, setSessionCookie } from "./cookies.ts";
import { onLoginSuccess } from "./loginHooks.ts";
import { staffRoleFor } from "./roles.ts";

const SESSION_COLLECTION: Record<PortalRole, string> = {
  staff: "dashboard_sessions",
  lawyer: "provider_sessions",
  client: "client_status_sessions",
};

const HEADER: Record<PortalRole, string> = {
  staff: "x-dashboard-token",
  lawyer: "x-provider-token",
  client: "x-client-token",
};

let registered = false;

export function registerSessionHooks(): void {
  if (registered) return;
  registered = true;
  onLoginSuccess(async ({ role, token, email, expiresAt, body, res }) => {
    if (role === "staff") {
      const staffRole = staffRoleFor(email);
      try {
        await patch(SESSION_COLLECTION.staff, token, { role: staffRole });
      } catch (err) {
        log(`[session] could not stamp role on staff session: ${err instanceof Error ? err.message : err}`, "error");
      }
      body.role = staffRole;
    }
    setSessionCookie(res, role, token, expiresAt);
  });
}

export function sessionRoutes(app: Express): void {
  const paths: Record<PortalRole, string> = {
    staff: "/api/dashboard/auth/logout",
    lawyer: "/api/provider/auth/logout",
    client: "/api/client-status/auth/logout",
  };
  for (const role of Object.keys(paths) as PortalRole[]) {
    app.post(paths[role], async (req: Request, res: Response) => {
      const token = (req.headers[HEADER[role]] as string | undefined) || cookieToken(req, role);
      clearSessionCookie(res, role);
      if (token) {
        try {
          const session = await get(SESSION_COLLECTION[role], token);
          await remove(SESSION_COLLECTION[role], token);
          const email = String(session?.email ?? "unknown");
          auditAuth("auth.logout", { email, role }, `${role}:${email}`, { portal: role });
        } catch (err) {
          log(`[session] logout cleanup failed: ${err instanceof Error ? err.message : err}`, "error");
        }
      }
      res.json({ success: true });
    });
  }
}
