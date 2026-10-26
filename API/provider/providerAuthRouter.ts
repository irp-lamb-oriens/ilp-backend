/**
 * providerAuthRouter.ts — OTP login for lawyers (providers).
 *
 * Providers are the "drivers" of the ILP marketplace. Each lawyer logs in
 * with their own email to reach an isolated dashboard (Kanban + finance)
 * scoped to their assigned clients.
 *
 * The provider is resolved BY EMAIL at login, not by id. The `providers`
 * collection has two id conventions in the wild (`provider_${uid}` from the
 * public self-serve router vs `prov_...` from the staff CRUD router), so
 * email is the only stable join key. The resolved provider id is stored on
 * the session and attached to every subsequent request by
 * `requireProviderAuth`.
 *
 * Routes:
 *   POST /api/provider/auth/request-otp
 *   POST /api/provider/auth/verify-otp
 *   GET  /api/provider/auth/check
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import put from "../../db/put.ts";
import { sendEmailTransport } from "../../config/integrations.ts";
import {
  issueOtp,
  verifyOtp,
  generateSessionToken,
  emailToDocId,
} from "../../helper/auth/otp.ts";
import { requireProviderAuth } from "../../helper/auth/session.ts";

/** Resolve a provider doc by email (case-insensitive). */
async function findProviderByEmail(email: string): Promise<Record<string, unknown> | null> {
  const normalized = email.trim().toLowerCase();
  // Equality query first (emails are stored lowercase by the seeds and the
  // staff providers editor); the scan is only a fallback for legacy
  // mixed-case docs and runs on a miss, never on the data routes.
  for (const value of new Set([normalized, email.trim()])) {
    const hit = await query("providers", [{ field: "email", op: "EQUAL", value }]).catch(() => []);
    if (hit[0]) return hit[0];
  }
  const all = await getAll("providers");
  return (
    all.find(
      (p) =>
        typeof p?.email === "string" && p.email.trim().toLowerCase() === normalized,
    ) ?? null
  );
}

export default function providerAuthRouter(app: Express) {
  log("Provider auth router initialized.");

  app.post(
    "/api/provider/auth/request-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email } = req.body ?? {};
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return res.status(400).json({ error: "A valid email is required." });
      }

      const provider = await findProviderByEmail(email);
      if (!provider) {
        return res.status(404).json({ error: "No lawyer account found for this email." });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const issued = await issueOtp("provider_otps", emailToDocId(normalizedEmail), normalizedEmail);
      if (!issued.ok) return res.status(issued.status).json({ error: issued.error });
      const code = issued.code;

      try {
        await sendEmailTransport({
          to: email,
          subject: "Your ILP Lawyer Login Code",
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
            <h1 style="color:#123b5d;font-size:24px;margin:0">ILP Lawyer Portal</h1>
            <p style="color:#4a5a66;font-size:14px;margin-top:8px">Secure Login Code</p>
            <div style="background:#eff7fb;border-radius:12px;padding:32px;text-align:center">
              <p style="color:#202a33;font-size:16px;margin:0 0 16px">Your verification code is:</p>
              <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#123b5d;font-family:monospace;padding:16px;background:white;border-radius:8px;display:inline-block">${code}</div>
              <p style="color:#7a8a96;font-size:13px;margin-top:16px">This code expires in 10 minutes.</p>
            </div>
          </div>`,
        });
        log(`[provider-auth] OTP sent to ${email}`);
      } catch (err) {
        log(`[provider-auth] Failed to send OTP email: ${err instanceof Error ? err.message : err}`);
        return res.status(500).json({ error: "Failed to send verification code." });
      }

      res.json({ success: true, message: "Verification code sent to your email." });
    })
  );

  app.post(
    "/api/provider/auth/verify-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email, code } = req.body ?? {};
      if (!email || !code) {
        return res.status(400).json({ error: "Email and code are required." });
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const check = await verifyOtp("provider_otps", emailToDocId(normalizedEmail), code);
      if (!check.ok) return res.status(check.status).json({ error: check.error });

      const provider = await findProviderByEmail(email);
      if (!provider) {
        return res.status(404).json({ error: "No lawyer account found for this email." });
      }

      const token = generateSessionToken();
      const sessionExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await put("provider_sessions", token, {
        email: email.trim().toLowerCase(),
        providerId: String(provider.id ?? ""),
        createdAt: new Date().toISOString(),
        expiresAt: sessionExpiry.toISOString(),
      });

      log(`[provider-auth] Session created for ${email}`);
      res.json({
        success: true,
        token,
        email: email.trim().toLowerCase(),
        providerId: String(provider.id ?? ""),
        expiresAt: sessionExpiry.toISOString(),
      });
    })
  );

  app.get(
    "/api/provider/auth/check",
    requireProviderAuth,
    (req: Request, res: Response) => {
      res.json({
        authenticated: true,
        email: (req as Request & { providerUser?: string }).providerUser,
        providerId: (req as Request & { providerId?: string }).providerId,
      });
    }
  );
}