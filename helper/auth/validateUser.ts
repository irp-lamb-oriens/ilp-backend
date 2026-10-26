import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "./verifyToken.ts";
import type { Role, SessionUser } from "./types.ts";
import get from "../../db/get.ts";
import log from "../log.ts";
import { cookieToken, headerTokensEnabled } from "./cookies.ts";

/**
 * Express middleware that resolves the current user from EITHER:
 *   1. the staff session cookie `ilp_staff_session` (or, only when
 *      AUTH_HEADER_TOKENS=true, the legacy `x-dashboard-token` header) —
 *      treated as staff, OR
 *   2. `Authorization: Bearer <JWT>` (customer / provider / staff JWT)
 * and applies optional role checks.
 *
 * Usage:
 *   validateUser()                       — any authenticated user
 *   validateUser("staff")                — staff only
 *   validateUser(["staff", "provider"])  — staff OR provider
 *
 * Backward compatible: the JWT Bearer path is unchanged. The dashboard session
 * path is additive so the staff dashboard (which authenticates via OTP and
 * stores a session token, not a JWT) can reach every `validateUser("staff")`
 * route without a second login.
 */
export default function validateUser(allowed?: Role | Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const allowedRoles = allowed
      ? Array.isArray(allowed) ? allowed : [allowed]
      : null;

    // 1. Dashboard OTP session token (staff). The dashboard authenticates via
    //    OTP and stores a session doc keyed by a random token; it never mints a
    //    JWT. Resolve that session here so staff routes work with the same
    //    token the rest of the dashboard uses.
    const dashboardToken =
      (headerTokensEnabled() ? (req.headers["x-dashboard-token"] as string | undefined) : undefined) ||
      cookieToken(req, "staff");
    if (dashboardToken) {
      try {
        const session = await get("dashboard_sessions", dashboardToken);
        if (session && session.email) {
          const expired = session.expiresAt &&
            new Date(session.expiresAt as string) < new Date();
          if (!expired) {
            if (allowedRoles && !allowedRoles.includes("staff")) {
              return res.status(403).json({ error: "Insufficient permissions." });
            }
            const user: SessionUser = {
              uid: session.email as string,
              email: session.email as string,
              role: "staff",
            };
            (req as Request & { sessionUser?: SessionUser }).sessionUser = user;
            (req as Request & { dashboardUser?: string }).dashboardUser =
              session.email as string;
            return next();
          }
        }
      } catch (err) {
        log(
          `Dashboard session auth failed: ${err instanceof Error ? err.message : err}`,
          "auth",
        );
      }
    }

    // 2. JWT Bearer token (customer / provider / staff).
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid auth token." });
      }

      const token = header.slice("Bearer ".length).trim();
      const payload = verifyToken(token);

      if (allowedRoles && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: "Insufficient permissions." });
      }

      const user: SessionUser = {
        uid: payload.uid,
        email: payload.email,
        role: payload.role,
      };

      (req as Request & { sessionUser?: SessionUser }).sessionUser = user;
      next();
    } catch (err) {
      log(`Auth failed: ${err instanceof Error ? err.message : err}`, "auth");
      return res.status(401).json({ error: "Invalid or expired auth token." });
    }
  };
}