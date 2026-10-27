/**
 * helper/auth/cookies.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Session lifetimes, request-token helpers and the OPTIONAL session cookies.
 *
 * AUTH (2026-10): sessions travel as `Authorization: Bearer <token>`. The
 * site (Netlify) and the API (Render) are different sites, so a session
 * cookie set by the API is third-party and browsers drop it; header tokens
 * are the default and always on. The legacy role headers still work:
 *   x-dashboard-token  staff (staff | csm | admin)
 *   x-provider-token   lawyer
 *   x-client-token     client
 * `?token=` query tokens are never accepted (downloads use single-use
 * tickets instead, see downloadTicket.ts).
 *
 * Cookies are off unless AUTH_COOKIES=true. When on, verify-otp also sets
 *   ilp_staff_session / ilp_lawyer_session / ilp_client_session
 * (HttpOnly) and the middleware reads them after the headers.
 *
 * Env (cookies only, ignored unless AUTH_COOKIES=true):
 *   COOKIE_DOMAIN     optional, e.g. ".internationallegalpartner.com"
 *   COOKIE_SAMESITE   Lax (default) | Strict | None
 *   COOKIE_INSECURE   "true" drops the Secure flag (plain-http dev only)
 *
 * Session lifetimes (P1): staff and lawyers 12 h from login; clients 7 days,
 * sliding (each authenticated request at least an hour after the last refresh
 * pushes expiry to now + 7 d), capped at 30 days from login.
 */

import type { Request, Response } from "express";
import type { PortalRole } from "./audit.ts";

export const SESSION_COOKIES: Record<PortalRole, string> = {
  staff: "ilp_staff_session",
  lawyer: "ilp_lawyer_session",
  client: "ilp_client_session",
};

/** Session cookies are opt-in: only when AUTH_COOKIES === "true" (default off). */
export function cookiesEnabled(): boolean {
  return Deno.env.get("AUTH_COOKIES") === "true";
}

/** Legacy per-role headers, still accepted after `Authorization: Bearer`. */
export const LEGACY_HEADERS: Record<PortalRole, string> = {
  staff: "x-dashboard-token",
  lawyer: "x-provider-token",
  client: "x-client-token",
};

/** `Authorization: Bearer <token>`, or undefined. */
export function bearerToken(req: Request): string | undefined {
  const h = req.headers?.authorization;
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1] : undefined;
}

/** A JWT (three dot-separated parts), as opposed to an opaque session token. */
export function isJwt(token: string): boolean {
  return token.split(".").length === 3;
}

/** A legacy role header value, or undefined. */
export function legacyHeaderToken(req: Request, role: PortalRole): string | undefined {
  const v = req.headers?.[LEGACY_HEADERS[role]];
  return typeof v === "string" && v ? v : undefined;
}

const HOUR_MS = 3600_000;
export const SESSION_TTL_MS: Record<PortalRole, number> = {
  staff: 12 * HOUR_MS,
  lawyer: 12 * HOUR_MS,
  client: 7 * 24 * HOUR_MS,
};
/** Client sessions slide, but never past this age (from createdAt). */
export const CLIENT_SESSION_MAX_AGE_MS = 30 * 24 * HOUR_MS;
/** Refresh a sliding client session at most this often. */
export const CLIENT_SLIDE_EVERY_MS = HOUR_MS;

/**
 * Sliding client expiry: the new expiresAt to store, or null when no refresh
 * is due yet. Pure; exported for tests.
 */
export function nextClientExpiry(
  session: { createdAt?: unknown; expiresAt?: unknown },
  now = Date.now(),
): string | null {
  const exp = session.expiresAt ? new Date(String(session.expiresAt)).getTime() : NaN;
  const created = session.createdAt ? new Date(String(session.createdAt)).getTime() : NaN;
  const cap = Number.isFinite(created) ? created + CLIENT_SESSION_MAX_AGE_MS : Infinity;
  const target = Math.min(now + SESSION_TTL_MS.client, cap);
  if (Number.isFinite(exp) && target - exp < CLIENT_SLIDE_EVERY_MS) return null;
  if (target <= now) return null;
  return new Date(target).toISOString();
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(";") : header ?? "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** The role's session cookie, only when AUTH_COOKIES=true. */
export function cookieToken(req: Request, role: PortalRole): string | undefined {
  if (!cookiesEnabled()) return undefined;
  const v = parseCookies(req.headers.cookie)[SESSION_COOKIES[role]];
  return v || undefined;
}

function sameSite(): "Lax" | "Strict" | "None" {
  const v = (Deno.env.get("COOKIE_SAMESITE") ?? "Lax").toLowerCase();
  return v === "none" ? "None" : v === "strict" ? "Strict" : "Lax";
}

/** Serialize one Set-Cookie value. Exported for tests. */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSec: number; domain?: string; sameSite: "Lax" | "Strict" | "None"; secure: boolean },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", `SameSite=${opts.sameSite}`];
  // SameSite=None is only honoured on Secure cookies.
  if (opts.secure || opts.sameSite === "None") parts.push("Secure");
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`);
  if (opts.maxAgeSec <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return parts.join("; ");
}

function appendSetCookie(res: Response, cookie: string): void {
  const prev = res.getHeader("Set-Cookie");
  const list = Array.isArray(prev) ? prev.map(String) : prev ? [String(prev)] : [];
  res.setHeader("Set-Cookie", [...list, cookie]);
}

function baseOpts() {
  return {
    domain: Deno.env.get("COOKIE_DOMAIN") || undefined,
    sameSite: sameSite(),
    secure: Deno.env.get("COOKIE_INSECURE") !== "true",
  };
}

/** Set the role's session cookie. No-op unless AUTH_COOKIES=true. */
export function setSessionCookie(res: Response, role: PortalRole, token: string, expiresAt?: string): void {
  if (!cookiesEnabled()) return;
  const exp = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 24 * 3600_000;
  const maxAgeSec = Math.max(60, (exp - Date.now()) / 1000);
  appendSetCookie(res, serializeCookie(SESSION_COOKIES[role], token, { ...baseOpts(), maxAgeSec }));
}

/** Clear the role's session cookie. No-op unless AUTH_COOKIES=true. */
export function clearSessionCookie(res: Response, role: PortalRole): void {
  if (!cookiesEnabled()) return;
  appendSetCookie(res, serializeCookie(SESSION_COOKIES[role], "", { ...baseOpts(), maxAgeSec: 0 }));
}

/**
 * The caller's own session token candidates for a role, in order: Bearer,
 * the legacy role header, the role cookie (AUTH_COOKIES=true). Deduplicated.
 */
export function roleTokens(req: Request, role: PortalRole): string[] {
  const out: string[] = [];
  for (const t of [bearerToken(req), legacyHeaderToken(req, role), cookieToken(req, role)]) {
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
