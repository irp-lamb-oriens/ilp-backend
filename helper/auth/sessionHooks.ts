/**
 * helper/auth/sessionHooks.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Login side effects registered on loginHooks, plus the logout routes.
 *
 * On a successful verify-otp:
 *   - set the session lifetime: 12 h for staff and lawyers, 7 days (sliding,
 *     see session.ts) for clients; stored on the session doc and returned as
 *     `expiresAt`;
 *   - staff: stamp `role` (staff | csm | admin) on the dashboard session and
 *     return it in the JSON body (informational: requireDashboardAuth
 *     re-resolves the role from env on every request, see roles.ts);
 *   - keep `token` in the JSON body: the front end stores it and sends it as
 *     `Authorization: Bearer <token>` (AUTH; cross-site cookies are dropped);
 *   - set the role's HttpOnly session cookie only when AUTH_COOKIES=true.
 *
 * Logout (delete the session doc named by the Bearer token / legacy header /
 * cookie, clear the cookie when cookies are on, write audit):
 *   POST /api/dashboard/auth/logout          POST /api/dashboard/auth/logout-all
 *   POST /api/provider/auth/logout           POST /api/provider/auth/logout-all
 *   POST /api/client-status/auth/logout      POST /api/client-status/auth/logout-all
 * `logout-all` needs a valid session and deletes every session of that email
 * in the role's collection (all devices), then answers `{ success, ended }`.
 */

import type { Express, Request, Response } from "express";
import log from "../log.ts";
import { auditAuth, type PortalRole } from "./audit.ts";
import { clearSessionCookie, roleTokens, SESSION_TTL_MS, setSessionCookie } from "./cookies.ts";
import { sessionStore } from "./sessionStore.ts";
import { onLoginSuccess } from "./loginHooks.ts";
import { staffRoleFor } from "./roles.ts";

export const SESSION_COLLECTION: Record<PortalRole, string> = {
  staff: "dashboard_sessions",
  lawyer: "provider_sessions",
  client: "client_status_sessions",
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
      await sessionStore.patch(SESSION_COLLECTION[role], token, fields);
    } catch (err) {
      log(`[session] could not stamp ${role} session: ${err instanceof Error ? err.message : err}`, "error");
    }
    body.expiresAt = expiresAt;
    body.token = token;
    setSessionCookie(res, role, token, expiresAt); // no-op unless AUTH_COOKIES=true
  });
}

/**
 * The caller's own live session token for a role: the first of Bearer, legacy
 * header, cookie that exists in the role's collection (so a staff Bearer sent
 * to the client logout route ends nothing).
 */
async function sessionToken(req: Request, role: PortalRole): Promise<{ token: string; session: Record<string, unknown> } | null> {
  for (const token of roleTokens(req, role)) {
    const session = await sessionStore.get(SESSION_COLLECTION[role], token);
    if (session) return { token, session: session as Record<string, unknown> };
  }
  return null;
}

export function sessionRoutes(app: Express): void {
  const base: Record<PortalRole, string> = {
    staff: "/api/dashboard/auth",
    lawyer: "/api/provider/auth",
    client: "/api/client-status/auth",
  };
  for (const role of Object.keys(base) as PortalRole[]) {
    app.post(`${base[role]}/logout`, async (req: Request, res: Response) => {
      clearSessionCookie(res, role);
      try {
        const found = await sessionToken(req, role);
        if (found) {
          await sessionStore.remove(SESSION_COLLECTION[role], found.token);
          const email = String(found.session.email ?? "unknown");
          auditAuth("auth.logout", { email, role }, `${role}:${email}`, { portal: role });
        }
      } catch (err) {
        log(`[session] logout cleanup failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      res.json({ success: true });
    });

    app.post(`${base[role]}/logout-all`, async (req: Request, res: Response) => {
      if (!roleTokens(req, role).length) return res.status(401).json({ error: "Authentication required." });
      try {
        const found = await sessionToken(req, role);
        const token = found?.token ?? "";
        const session = found?.session;
        const expired = session?.expiresAt && new Date(String(session.expiresAt)) < new Date();
        if (!session?.email || expired) return res.status(401).json({ error: "Invalid or expired session." });
        const email = String(session.email).trim().toLowerCase();
        const rows = await sessionStore.query(SESSION_COLLECTION[role], [{ field: "email", op: "EQUAL", value: email }]);
        const ids = new Set(rows.map((r) => r.id));
        ids.add(token);
        let ended = 0;
        for (const id of ids) {
          try {
            await sessionStore.remove(SESSION_COLLECTION[role], id);
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
