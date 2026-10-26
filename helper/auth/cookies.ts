/**
 * helper/auth/cookies.ts
 * ──────────────────────────────────────────────────────────────────────────
 * HttpOnly session cookies for the three portals. The verify-otp responses
 * set them (via loginHooks); the session middleware reads them after the
 * legacy header tokens, which keep working during the transition.
 *
 * Cookie names (frontend must send requests with `credentials: "include"`):
 *   ilp_staff_session   dashboard (staff | csm | admin)
 *   ilp_lawyer_session  lawyer portal
 *   ilp_client_session  client portal (/status)
 *
 * Env:
 *   COOKIE_DOMAIN     optional, e.g. ".internationallegalpartner.com"
 *   COOKIE_SAMESITE   Lax (default) | Strict | None (None when the API and
 *                     the front end are on different sites)
 *   COOKIE_INSECURE   "true" drops the Secure flag (plain-http dev only)
 *   AUTH_HEADER_TOKENS "true" re-enables the legacy header / ?token= session
 *                     tokens and returns `token` in verify-otp bodies (seed
 *                     scripts, local tools). Default off: cookies only.
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

/** Legacy header / query tokens: only when AUTH_HEADER_TOKENS === "true". */
export function headerTokensEnabled(): boolean {
  return Deno.env.get("AUTH_HEADER_TOKENS") === "true";
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

export function cookieToken(req: Request, role: PortalRole): string | undefined {
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

export function setSessionCookie(res: Response, role: PortalRole, token: string, expiresAt?: string): void {
  const exp = expiresAt ? new Date(expiresAt).getTime() : Date.now() + 24 * 3600_000;
  const maxAgeSec = Math.max(60, (exp - Date.now()) / 1000);
  appendSetCookie(res, serializeCookie(SESSION_COOKIES[role], token, { ...baseOpts(), maxAgeSec }));
}

export function clearSessionCookie(res: Response, role: PortalRole): void {
  appendSetCookie(res, serializeCookie(SESSION_COOKIES[role], "", { ...baseOpts(), maxAgeSec: 0 }));
}
