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

/** Public routes that must stay on the per-IP bucket (codes, LLM, forms, beacons). */
const STRICT = /^\/api\/(?:[a-z-]+\/)?auth\/(request-otp|verify-otp)(\/|$)|^\/api\/(chatbot|leads|journey|csp-report|analytics\/funnel|providers\/apply|privacy\/consents\/join|payments\/join)(\/|$)/;

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
