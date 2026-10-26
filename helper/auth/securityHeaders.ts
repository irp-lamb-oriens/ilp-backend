/**
 * helper/auth/securityHeaders.ts
 * ──────────────────────────────────────────────────────────────────────────
 * helmet-equivalent response headers for the API, without the dependency.
 * Mounted first in main.ts. A route may override one (document downloads set
 * their own stricter Content-Security-Policy).
 *
 *   X-Content-Type-Options: nosniff
 *   Referrer-Policy: no-referrer
 *   Content-Security-Policy: frame-ancestors 'none'   (+ X-Frame-Options: DENY)
 *   X-Permitted-Cross-Domain-Policies: none
 *   Strict-Transport-Security: max-age=31536000; includeSubDomains   (production only)
 *
 * CSP is limited to frame-ancestors so the few server-rendered HTML pages
 * (e.g. email unsubscribe) keep working; the API otherwise serves JSON.
 */

import type { NextFunction, Request, Response } from "express";

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
};

export const HSTS = "max-age=31536000; includeSubDomains";

export function securityHeaders(isProduction: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isProduction) res.setHeader("Strict-Transport-Security", HSTS);
    next();
  };
}
