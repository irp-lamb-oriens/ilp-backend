/**
 * helper/auth/loginHooks.ts
 * ──────────────────────────────────────────────────────────────────────────
 * One middleware, mounted in main.ts before the routers, that observes the
 * three OTP verify routes without editing them:
 *
 *   POST /api/dashboard/auth/verify-otp      → staff
 *   POST /api/provider/auth/verify-otp       → lawyer
 *   POST /api/client-status/auth/verify-otp  → client
 *
 * It wraps `res.json` so that, after the route has decided, we can write the
 * audit row (success or failure) and run per-role session hooks.
 */

import type { NextFunction, Request, Response } from "express";
import { auditAuth, type PortalRole } from "./audit.ts";

export const VERIFY_ROUTES: Record<string, PortalRole> = {
  "/api/dashboard/auth/verify-otp": "staff",
  "/api/provider/auth/verify-otp": "lawyer",
  "/api/client-status/auth/verify-otp": "client",
};

export interface LoginResult {
  role: PortalRole;
  token: string;
  email: string;
  expiresAt?: string;
  body: Record<string, unknown>;
  req: Request;
  res: Response;
}

/** Hooks run (in order) on every successful login; they may mutate `body`. */
const successHooks: Array<(r: LoginResult) => Promise<void> | void> = [];

export function onLoginSuccess(fn: (r: LoginResult) => Promise<void> | void): void {
  successHooks.push(fn);
}

function clientIp(req: Request): string | undefined {
  return (req as Request & { ip?: string }).ip;
}

export function loginHooks(req: Request, res: Response, next: NextFunction): void {
  const role = req.method === "POST" ? VERIFY_ROUTES[req.path] : undefined;
  if (!role) return next();

  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const original = res.json.bind(res);
  let done = false;

  res.json = ((payload: unknown) => {
    if (done) return original(payload);
    done = true;
    const body = (payload ?? {}) as Record<string, unknown>;
    const ok = res.statusCode < 400 && body.success === true && typeof body.token === "string";
    const meta = { portal: role, ip: clientIp(req), projectId: req.body?.projectId };
    if (!ok) {
      auditAuth("auth.login_failed", { email: email || "unknown", role }, `${role}:${email || "unknown"}`, {
        ...meta,
        status: res.statusCode,
      });
      return original(payload);
    }
    const result: LoginResult = {
      role,
      token: body.token as string,
      email: String(body.email ?? email),
      expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : undefined,
      body,
      req,
      res,
    };
    auditAuth("auth.login", { email: result.email, role }, `${role}:${result.email}`, {
      ...meta,
      providerId: body.providerId,
    });
    (async () => {
      for (const h of successHooks) await h(result);
    })()
      .catch(() => {})
      .finally(() => original(result.body));
    return res;
  }) as Response["json"];

  next();
}
