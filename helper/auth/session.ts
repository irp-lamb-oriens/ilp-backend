/**
 * helper/auth/session.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Session middleware for the ILP platform.
 *
 * Token order for every role (AUTH, see cookies.ts):
 *   1. `Authorization: Bearer <token>`
 *   2. the legacy role header (x-dashboard-token / x-provider-token /
 *      x-client-token)
 *   3. the role's session cookie, only when AUTH_COOKIES=true
 * `?token=` query params are never accepted. Downloads opened by the browser
 * use single-use tickets (downloadTicket.ts), which the ticket middleware
 * turns into a Bearer header before these run.
 *
 * Each role validates against its own collection: staff → dashboard_sessions,
 * lawyer → provider_sessions, client → client_status_sessions. A Bearer token
 * is opaque, so the lawyer and client middlewares also try it as a staff
 * session (the audited staff bypass) after their own collection.
 */

import type { Request, Response, NextFunction } from "express";
import getAll from "../../db/getAll.ts";
import { auditStaffBypass } from "./audit.ts";
import log from "../log.ts";
import {
  bearerToken,
  CLIENT_SESSION_MAX_AGE_MS,
  cookieToken,
  legacyHeaderToken,
  nextClientExpiry,
  roleTokens,
  setSessionCookie,
} from "./cookies.ts";
import { sessionStore } from "./sessionStore.ts";
import { staffRoleFor } from "./roles.ts";

/** Shared session validation against a given collection. */
interface ResolvedSession {
  email: string;
  providerId?: string;
  /** Client portal: the `clients` doc id this session may read (projectId). */
  projectId?: string;
  /** Dashboard sessions: staff | csm | admin (missing → staff). */
  role?: StaffRole;
  createdAt?: string;
  expiresAt?: string;
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
  const session = await sessionStore.get(collection, token);
  if (!session || !session.email) return null;
  if (session.expiresAt && new Date(session.expiresAt as string) < new Date()) {
    return null;
  }
  // Sliding client sessions never outlive CLIENT_SESSION_MAX_AGE_MS from login.
  if (
    collection === "client_status_sessions" && typeof session.createdAt === "string" &&
    Date.now() - new Date(session.createdAt).getTime() > CLIENT_SESSION_MAX_AGE_MS
  ) {
    return null;
  }
  return {
    email: session.email as string,
    providerId: typeof session.providerId === "string" ? session.providerId : undefined,
    projectId: typeof session.projectId === "string" ? session.projectId : undefined,
    role: normalizeStaffRole(session.role),
    createdAt: typeof session.createdAt === "string" ? session.createdAt : undefined,
    expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : undefined,
  };
}

/**
 * Client sessions slide: push expiresAt to now + 7 d (at most once an hour,
 * capped at 30 d from login) and re-set the cookie. Fire-and-forget.
 */
function slideClientSession(res: Response, token: string, session: ResolvedSession): void {
  const next = nextClientExpiry(session);
  if (!next) return;
  setSessionCookie(res, "client", token, next);
  sessionStore.patch("client_status_sessions", token, { expiresAt: next }).catch((err) =>
    log(`[session] could not slide client session: ${err instanceof Error ? err.message : err}`, "error")
  );
}

/** The first candidate token with a live session in `collection`. */
async function firstSession(
  collection: string,
  tokens: Array<string | undefined>,
): Promise<{ token: string; session: ResolvedSession } | null> {
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const session = await resolveSession(collection, t);
    if (session) return { token: t, session };
  }
  return null;
}

/** True when a staff session belongs to the org domain (bypass allowed). */
function staffDomainOk(email: string): boolean {
  const domain = email.toLowerCase().split("@")[1];
  return domain === (Deno.env.get("DASHBOARD_ALLOWED_DOMAIN") ?? "internationallegalpartner.com");
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
 * request as `dashboardUser` (and the staff sub-role as `dashboardRole`,
 * resolved from env on every request: see roles.ts).
 */
export async function requireDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tokens = roleTokens(req, "staff");
  if (!tokens.length) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const found = await firstSession("dashboard_sessions", tokens);
    if (!found) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    (req as AuthedRequest).dashboardUser = found.session.email;
    // Role from ADMIN_EMAILS / OWNER_EMAILS / CSM_EMAILS now, not the role
    // stamped at login, so env changes apply without waiting for a new session.
    (req as AuthedRequest).dashboardRole = staffRoleFor(found.session.email);
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed." });
  }
}

/**
 * Middleware: resolve a client-status session and attach the client email to
 * the request as `clientUser`. Used by the Phase 1 client portal. (The legacy
 * x-dashboard-token header is also tried here, against the client collection,
 * as before.)
 */
export async function requireClientStatusAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const tokens = [...roleTokens(req, "client"), legacyHeaderToken(req, "staff")].filter(Boolean) as string[];
  if (!tokens.length) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const found = await firstSession("client_status_sessions", tokens);
    if (!found) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    (req as Request & { clientUser?: string }).clientUser = found.session.email;
    slideClientSession(res, found.token, found.session);
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed." });
  }
}

/**
 * Middleware: resolve a provider (lawyer) session and attach the provider's
 * email + id to the request as `providerUser` / `providerId`. A lawyer
 * session wins; otherwise a staff session from the org domain is accepted as
 * an audited bypass.
 */
export async function requireProviderAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const r = req as AuthedRequest;
  // 1. The lawyer's own session (Bearer, x-provider-token, lawyer cookie).
  try {
    const found = await firstSession("provider_sessions", roleTokens(req, "lawyer"));
    if (found) {
      r.providerUser = found.session.email;
      r.providerId = found.session.providerId ?? "";
      next();
      return;
    }
  } catch {
    // Fall through to staff bypass.
  }

  // 2. Staff bypass: x-dashboard-token, then Bearer, then the staff cookie.
  const staffTokens = [legacyHeaderToken(req, "staff"), bearerToken(req), cookieToken(req, "staff")];
  try {
    const found = await firstSession("dashboard_sessions", staffTokens);
    if (found && staffDomainOk(found.session.email)) {
      const email = found.session.email;
      const provider = await findProviderForStaff(email);
      r.providerUser = email;
      r.providerId = provider?.id ? String(provider.id) : "";
      auditStaffBypass(email, "lawyer", `provider:${provider?.id ?? "none"}`, { path: req.path });
      next();
      return;
    }
  } catch {
    // Fall through to the final 401.
  }

  res.status(401).json({ error: "Authentication required." });
}

/**
 * Combined client-portal auth: end-customer session OR a staff session from
 * the org domain (audited bypass). Attaches `clientUser`, `isIrpStaff` and
 * `clientId`.
 *
 * Order: an explicit x-dashboard-token header (legacy, staff first), then the
 * client session (Bearer, x-client-token, client cookie), then the Bearer
 * token or staff cookie as a staff session. The member's own session wins
 * over a staff cookie in the same browser.
 */
export async function requireClientAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const r = req as AuthedRequest;
  const staffOk = async (tokens: Array<string | undefined>): Promise<boolean> => {
    const found = await firstSession("dashboard_sessions", tokens);
    if (!found || !staffDomainOk(found.session.email)) return false;
    r.clientUser = found.session.email;
    r.isIrpStaff = true;
    // Staff acting on a member's portal name the member explicitly.
    const target = (req.query.clientId as string) || (req.headers["x-client-id"] as string);
    if (target) r.clientId = String(target);
    auditStaffBypass(found.session.email, "client", `client:${target || "none"}`, { path: req.path });
    return true;
  };

  // 1. Legacy explicit staff header keeps its old precedence.
  try {
    if (legacyHeaderToken(req, "staff") && (await staffOk([legacyHeaderToken(req, "staff")]))) {
      next();
      return;
    }
  } catch {
    // Fall through to the client session.
  }

  // 2. End-customer session.
  const clientTokens = roleTokens(req, "client");
  let clientError = false;
  try {
    const found = await firstSession("client_status_sessions", clientTokens);
    if (found) {
      r.clientUser = found.session.email;
      r.isIrpStaff = false;
      r.clientId = found.session.projectId;
      slideClientSession(res, found.token, found.session);
      next();
      return;
    }
  } catch {
    clientError = true;
  }

  // 3. Bearer (or the staff cookie when no client cookie) as a staff session.
  try {
    const staffCookie = cookieToken(req, "client") ? undefined : cookieToken(req, "staff");
    if (await staffOk([bearerToken(req), staffCookie])) {
      next();
      return;
    }
  } catch {
    // Fall through to the 401.
  }

  if (clientError) {
    res.status(401).json({ error: "Authentication failed." });
  } else if (!clientTokens.length && !legacyHeaderToken(req, "staff")) {
    res.status(401).json({ error: "Authentication required." });
  } else {
    res.status(401).json({ error: "Invalid or expired session." });
  }
}
