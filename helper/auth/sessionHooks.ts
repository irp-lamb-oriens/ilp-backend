/**
 * helper/auth/sessionHooks.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Login side effects registered on loginHooks, plus the logout routes.
 *
 * On a successful verify-otp:
 *   - set the session lifetime: 12 h for staff and lawyers, 7 days (sliding,
 *     see session.ts) for clients; stored on the session doc and returned as
 *     `expiresAt`;
 *   - set the role's HttpOnly session cookie (see cookies.ts for names);
 *   - staff: stamp `role` (staff | csm | admin) on the dashboard session and
 *     return it in the JSON body;
 *   - drop `token` from the JSON body unless AUTH_HEADER_TOKENS=true, so the
 *     session secret only ever lives in the HttpOnly cookie.
 *
 * Logout (all clear the cookie, delete the session doc, write audit):
 *   POST /api/dashboard/auth/logout          POST /api/dashboard/auth/logout-all
 *   POST /api/provider/auth/logout           POST /api/provider/auth/logout-all
 *   POST /api/client-status/auth/logout      POST /api/client-status/auth/logout-all
 * `logout-all` needs a valid session and deletes every session of that email
 * in the role's collection (all devices), then answers `{ success, ended }`.
 */

import type { Express, Request, Response } from "express";
import patch from "../../db/patch.ts";
import remove from "../../db/delete.ts";
import get from "../../db/get.ts";
import query from "../../db/query.ts";
import log from "../log.ts";
import { auditAuth, type PortalRole } from "./audit.ts";
import {
  clearSessionCookie,
  cookieToken,
  headerTokensEnabled,
  SESSION_TTL_MS,
  setSessionCookie,
} from "./cookies.ts";
import { onLoginSuccess } from "./loginHooks.ts";
import { staffRoleFor } from "./roles.ts";

export const SESSION_COLLECTION: Record<PortalRole, string> = {
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
  onLoginSuccess(async ({ role, token, email, body, res }) => {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS[role]).toISOString();
    const fields: Record<string, unknown> = { expiresAt };
    if (role === "staff") {
      const staffRole = staffRoleFor(email);
      fields.role = staffRole;
      body.role = staffRole;
    }
    try {
      await patch(SESSION_COLLECTION[role], token, fields);
    } catch (err) {
      log(`[session] could not stamp ${role} session: ${err instanceof Error ? err.message : err}`, "error");
    }
    body.expiresAt = expiresAt;
    setSessionCookie(res, role, token, expiresAt);
    if (!headerTokensEnabled()) delete body.token;
  });
}

/** The caller's own session token for a role: cookie, or the legacy header when enabled. */
function sessionToken(req: Request, role: PortalRole): string | undefined {
  const header = headerTokensEnabled() ? (req.headers[HEADER[role]] as string | undefined) : undefined;
  return header || cookieToken(req, role);
}

export function sessionRoutes(app: Express): void {
  const base: Record<PortalRole, string> = {
    staff: "/api/dashboard/auth",
    lawyer: "/api/provider/auth",
    client: "/api/client-status/auth",
  };
  for (const role of Object.keys(base) as PortalRole[]) {
    app.post(`${base[role]}/logout`, async (req: Request, res: Response) => {
      const token = sessionToken(req, role);
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

    app.post(`${base[role]}/logout-all`, async (req: Request, res: Response) => {
      const token = sessionToken(req, role);
      if (!token) return res.status(401).json({ error: "Authentication required." });
      try {
        const session = await get(SESSION_COLLECTION[role], token);
        const expired = session?.expiresAt && new Date(String(session.expiresAt)) < new Date();
        if (!session?.email || expired) return res.status(401).json({ error: "Invalid or expired session." });
        const email = String(session.email).trim().toLowerCase();
        const rows = await query(SESSION_COLLECTION[role], [{ field: "email", op: "EQUAL", value: email }]);
        const ids = new Set(rows.map((r) => r.id));
        ids.add(token);
        let ended = 0;
        for (const id of ids) {
          try {
            await remove(SESSION_COLLECTION[role], id);
            ended++;
          } catch (err) {
            log(`[session] logout-all could not delete a session: ${err instanceof Error ? err.message : err}`, "error");
          }
        }
        clearSessionCookie(res, role);
        auditAuth("auth.logout_all", { email, role }, `${role}:${email}`, { portal: role, ended });
        res.json({ success: true, ended });
      } catch (err) {
        log(`[session] logout-all failed: ${err instanceof Error ? err.message : err}`, "error");
        res.status(500).json({ error: "Could not end your sessions. Try again." });
      }
    });
  }
}
