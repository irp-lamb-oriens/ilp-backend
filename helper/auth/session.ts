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
import getAll from "../../db/getAll.ts";

/** Shared token resolution: header first, then `?token=` query param. */
function resolveToken(req: Request): string | undefined {
  return (req.headers["x-dashboard-token"] as string) || (req.query.token as string);
}

/** Shared session validation against a given collection. */
interface ResolvedSession {
  email: string;
  providerId?: string;
  /** Client portal: the `clients` doc id this session may read (projectId). */
  projectId?: string;
  /** Dashboard sessions: staff | csm | admin (missing → staff). */
  role?: StaffRole;
}

/** Staff sub-roles on dashboard sessions. Missing on old sessions → "staff". */
export type StaffRole = "staff" | "csm" | "admin";
export const STAFF_ROLES: readonly StaffRole[] = ["staff", "csm", "admin"];

export function normalizeStaffRole(v: unknown): StaffRole {
  return STAFF_ROLES.includes(v as StaffRole) ? (v as StaffRole) : "staff";
}

/** Request fields attached by the middleware below. */
export type AuthedRequest = Request & {
  dashboardUser?: string;
  dashboardRole?: StaffRole;
  providerUser?: string;
  providerId?: string;
  clientUser?: string;
  clientId?: string;
  isIrpStaff?: boolean;
};

async function resolveSession(
  collection: string,
  token: string,
): Promise<ResolvedSession | null> {
  const session = await get(collection, token);
  if (!session || !session.email) return null;
  if (session.expiresAt && new Date(session.expiresAt as string) < new Date()) {
    return null;
  }
  return {
    email: session.email as string,
    providerId: typeof session.providerId === "string" ? session.providerId : undefined,
    projectId: typeof session.projectId === "string" ? session.projectId : undefined,
    role: normalizeStaffRole(session.role),
  };
}

/** Resolve a provider doc for a staff member (dashboard bypass). */
async function findProviderForStaff(
  email: string,
): Promise<Record<string, unknown> | null> {
  const normalized = email.trim().toLowerCase();
  const all = await getAll("providers").catch(() => []);
  const exact = all.find(
    (p) => typeof p?.email === "string" && p.email.trim().toLowerCase() === normalized,
  );
  if (exact) return exact;
  const local = normalized.split("@")[0];
  if (!local) return null;
  return (
    all.find(
      (p) =>
        typeof p?.email === "string" &&
        p.email.trim().toLowerCase().split("@")[0] === local,
    ) ?? null
  );
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
    (req as AuthedRequest).dashboardUser = session.email;
    (req as AuthedRequest).dashboardRole = session.role ?? "staff";
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
 * Middleware: resolve a provider (lawyer) session and attach the provider's
 * email + id to the request as `providerUser` / `providerId`. Providers are
 * the "drivers" of the ILP marketplace: each gets an isolated dashboard
 * scoped to their assigned clients. Mirrors `requireDashboardAuth` but
 * validates against `provider_sessions`.
 */
export async function requireProviderAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 1. Provider session via x-provider-token (the lawyer's own login). This
  //    takes precedence so a lawyer who also holds a staff dashboard session
  //    is still resolved as the lawyer, not the staff member.
  const token =
    (req.headers["x-provider-token"] as string) || (req.query.token as string);
  if (token) {
    try {
      const session = await resolveSession("provider_sessions", token);
      if (session) {
        (req as Request & { providerUser?: string; providerId?: string }).providerUser =
          session.email;
        (req as Request & { providerUser?: string; providerId?: string }).providerId =
          session.providerId ?? "";
        next();
        return;
      }
    } catch {
      // Fall through to staff bypass.
    }
  }

  // 2. Staff bypass via dashboard session (mirrors requireClientAuth). Only
  //    reached when there is no valid provider token.
  const dashboardToken = req.headers["x-dashboard-token"] as string | undefined;
  if (dashboardToken) {
    try {
      const session = await resolveSession("dashboard_sessions", dashboardToken);
      if (session) {
        const domain = session.email.toLowerCase().split("@")[1];
        if (
          domain ===
          (Deno.env.get("DASHBOARD_ALLOWED_DOMAIN") ?? "internationallegalpartner.com")
        ) {
          const provider = await findProviderForStaff(session.email);
          (req as Request & { providerUser?: string; providerId?: string }).providerUser =
            session.email;
          (req as Request & { providerUser?: string; providerId?: string }).providerId =
            provider?.id ? String(provider.id) : "";
          next();
          return;
        }
      }
    } catch {
      // Fall through to the final 401.
    }
  }

  res.status(401).json({ error: "Authentication required." });
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
          const r = req as AuthedRequest;
          r.clientUser = session.email;
          r.isIrpStaff = true;
          // Staff acting on a member's portal name the member explicitly.
          const target = (req.query.clientId as string) || (req.headers["x-client-id"] as string);
          if (target) r.clientId = String(target);
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
    const r = req as AuthedRequest;
    r.clientUser = session.email;
    r.isIrpStaff = false;
    r.clientId = session.projectId;
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed." });
  }
}
