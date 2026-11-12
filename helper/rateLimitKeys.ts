/**
 * Rate-limit buckets (QA round 3, 2026-11-03).
 *
 * A staff or lawyer page fires up to 12 API calls, and the old limit was 50
 * a minute per IP, so a CSM clicking through a few pages (or several staff
 * behind one office router) got 429s. Requests that carry a session now
 * count against that session (SESSION_LIMIT a minute); everything else, and
 * every abuse-prone public route whether or not it carries a token, stays
 * on the strict per-IP limit. A made-up token buys nothing: the route
 * answers 401, and the per-IP global limiter still caps the address.
 */
import type { Request } from "express";

export const IP_LIMIT = 50;
export const SESSION_LIMIT = 300;
export const GLOBAL_IP_LIMIT = 1000;
/** Sign-in code requests and checks per IP per minute (each code also has its own 5-try cap and 30 s resend wait). */
export const AUTH_LIMIT = 30;

/** Public routes that must stay on the per-IP bucket (codes, LLM, forms, beacons). */
const STRICT = /^\/api\/(?:[a-z-]+\/)?auth\/(request-otp|verify-otp)(\/|$)|^\/api\/(chatbot|leads|journey|csp-report|analytics\/funnel|providers\/apply|privacy\/consents\/join|payments\/join)(\/|$)/;

/**
 * Fire-and-forget beacons that carry their own limiter (cspReport.ts 20/min,
 * journeysRouter.ts 120/min, analyticsRouter.ts 60/10min). They skip the
 * shared per-IP API bucket: otherwise a browsing visitor's beacons used up
 * the 50/min that sign-in shares, and the next code check got a 429 that the
 * login screen showed as "Too many attempts" (2026-11-10).
 */
const BEACONS = /^\/api\/(csp-report|journey\/events|journey\/behavior|analytics\/funnel)\/?$/;

/** True for beacon routes that are limited by their own router instead of the shared per-IP bucket. */
export function hasOwnLimiter(req: Request): boolean {
  return String(req.method ?? "").toUpperCase() === "POST" && BEACONS.test(pathOf(req));
}

/**
 * Public read-only lists the marketing pages fetch from the browser
 * (frontend/src/lib/public.ts: updates, templates, vetted providers). They
 * get their own wider per-IP bucket so browsing the site never uses up the
 * 50/min that sign-in codes share, and visitors behind one shared IP (office,
 * carrier NAT) don't get 429s (QA regression 2026-11-11, /api/updates).
 */
export const PUBLIC_READ_LIMIT = 300;
const PUBLIC_READS = /^\/api\/(updates|templates|providers)\/?$/;

/** True for GETs of the public read-only lists, limited by their own per-IP bucket. */
export function isPublicRead(req: Request): boolean {
  return String(req.method ?? "").toUpperCase() === "GET" && PUBLIC_READS.test(pathOf(req));
}

const header = (req: Request, name: string): string => {
  const v = req.headers?.[name];
  return typeof v === "string" ? v : Array.isArray(v) ? String(v[0] ?? "") : "";
};

/** The session token a request carries (Bearer, legacy role header or session cookie), or "". */
export function sessionTokenOf(req: Request): string {
  const auth = header(req, "authorization");
  if (/^Bearer\s+\S{16,}/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  for (const h of ["x-dashboard-token", "x-provider-token", "x-client-token"]) {
    const v = header(req, h).trim();
    if (v.length >= 16) return v;
  }
  const m = header(req, "cookie").match(/(?:^|;\s*)ilp_(?:staff|lawyer|client|csm)_session=([^;]{16,})/);
  return m ? decodeURIComponent(m[1]) : "";
}

/** FNV-1a, so the limiter's memory store never holds a raw token. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

const pathOf = (req: Request) => String(req.originalUrl ?? req.url ?? "").split("?")[0];

/** True when the request goes to the per-session bucket instead of the per-IP one. */
export function usesSessionBucket(req: Request): boolean {
  return !!sessionTokenOf(req) && !STRICT.test(pathOf(req));
}

export function sessionBucketKey(req: Request): string {
  return `s:${hash(sessionTokenOf(req))}`;
}

const AUTH = /^\/api\/(?:[a-z-]+\/)?auth\/(request-otp|verify-otp)\/?$/;

/**
 * Sign-in code routes get their own per-IP bucket (AUTH_LIMIT), so nothing
 * else a browser does (pages, forms, the chat) can lock a person out of
 * signing in, and sign-in guessing cannot hide in the wider API bucket.
 */
export function isAuthCode(req: Request): boolean {
  return String(req.method ?? "").toUpperCase() === "POST" && AUTH.test(pathOf(req));
}

/**
 * The visitor's address for per-IP limits. The API sits behind Cloudflare
 * (Render): `cf-connecting-ip` is set by Cloudflare and cannot be forged by
 * the visitor, while the first X-Forwarded-For entry (what `req.ip` gives
 * with trust proxy on) can: sending a made-up X-Forwarded-For used to open a
 * fresh bucket on every request. Falls back to req.ip off Cloudflare (local dev).
 */
export function clientIpKey(req: Request): string {
  const cf = header(req, "cf-connecting-ip").trim();
  if (/^[0-9a-fA-F:.]{3,45}$/.test(cf)) return cf;
  return String((req as Request & { ip?: string }).ip ?? "unknown");
}
