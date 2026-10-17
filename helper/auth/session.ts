/**
 * helper/auth/session.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Session middleware for the ILP platform.
 *
 * `requireDashboardAuth` resolves a staff session from `x-dashboard-token`
 * (or `?token=` for plain GET navigations) against the `dashboard_sessions`
 * collection and attaches the staff email to the request.
 *
 * `requireClientStatusAuth` is the client-portal variant (Phase 1): it reads
 * the same token shape but validates against `client_status_sessions` and
 * attaches the client email. It is declared here so the client-status router
 * can import it without a circular dependency on the dashboard router.
 *
 * Both mirror IRP-funnel's `requireDashboardAuth` / `requireClientAuth`.
 */

import type { Request, Response, NextFunction } from "express";
import get from "../../db/get.ts";

/** Shared token resolution: header first, then `?token=` query param. */
function resolveToken(req: Request): string | undefined {
  return (req.headers["x-dashboard-token"] as string) || (req.query.token as string);
}

/** Shared session validation against a given collection. */
async function resolveSession(
  collection: string,
  token: string,
): Promise<{ email: string } | null> {
  const session = await get(collection, token);
  if (!session || !session.email) return null;
  if (session.expiresAt && new Date(session.expiresAt as string) < new Date()) {
    return null;
  }
  return { email: session.email as string };
}

/**
 * Middleware: resolve the dashboard session and attach the staff email to the
 * request as `dashboardUser`. Mirrors IRP's `requireDashboardAuth`.
 */
export async function requireDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const session = await resolveSession("dashboard_sessions", token);
    if (!session) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    (req as Request & { dashboardUser?: string }).dashboardUser = session.email;
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed." });
  }
}

/**
 * Middleware: resolve a client-status session and attach the client email to
 * the request as `clientUser`. Used by the Phase 1 client portal.
 */
export async function requireClientStatusAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = resolveToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const session = await resolveSession("client_status_sessions", token);
    if (!session) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    (req as Request & { clientUser?: string }).clientUser = session.email;
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed." });
  }
}

/**
 * Combined client-portal auth: staff bypass via `x-dashboard-token` (org
 * domain) OR end-customer via `x-client-token`. Mirrors IRP's
 * `requireClientAuth`. Attaches `clientUser` and `isIrpStaff`.
 */
export async function requireClientAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const dashboardToken = req.headers["x-dashboard-token"] as string | undefined;
  const clientToken = req.headers["x-client-token"] as string | undefined;

  // 1. Staff bypass via dashboard session (org domain only).
  if (dashboardToken) {
    try {
      const session = await resolveSession("dashboard_sessions", dashboardToken);
      if (session) {
        const domain = session.email.toLowerCase().split("@")[1];
        if (domain === (Deno.env.get("DASHBOARD_ALLOWED_DOMAIN") ?? "internationallegalpartner.com")) {
          (req as Request & { clientUser?: string; isIrpStaff?: boolean }).clientUser = session.email;
          (req as Request & { clientUser?: string; isIrpStaff?: boolean }).isIrpStaff = true;
          next();
          return;
        }
      }
    } catch {
      // Fall through to client-token check.
    }
  }

  // 2. End-customer session via client token.
  if (!clientToken) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const session = await resolveSession("client_status_sessions", clientToken);
    if (!session) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    (req as Request & { clientUser?: string; isIrpStaff?: boolean }).clientUser = session.email;
    (req as Request & { clientUser?: string; isIrpStaff?: boolean }).isIrpStaff = false;
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed." });
  }
}
