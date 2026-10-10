import type { Express, Request, Response, NextFunction } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import { sendEmailTransport } from "../../config/integrations.ts";

/**
 * Dashboard authentication: email OTP -> session token.
 *
 * Ported from IRP-funnel's `API/dashboard/auth.ts` + the auth routes in
 * `dashboardRouter.ts`, tailored to ILP. Staff log in with their team email,
 * receive a 6-digit code, and exchange it for a 24h session token. The token
 * is sent as `x-dashboard-token` (or `?token=` for iframe/GET contexts) and
 * validated against the `dashboard_sessions` collection.
 *
 * This replaces the previous JWT `role === "staff"` gate, which had no login
 * path and always showed "Staff access required."
 */

const DEFAULT_ALLOWED_DOMAIN = "internationallegalpartner.com";

function allowedDomain(): string {
  return Deno.env.get("DASHBOARD_ALLOWED_DOMAIN") ?? DEFAULT_ALLOWED_DOMAIN;
}

function generateOtp(): string {
  const arr = new Uint8Array(4);
  crypto.getRandomValues(arr);
  const n = ((arr[0] << 24) | (arr[1] << 16) | (arr[2] << 8) | arr[3]) >>> 0;
  return String(100000 + (n % 900000));
}

function generateSessionToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Middleware: resolve the dashboard session from `x-dashboard-token` (or
 * `?token=` for plain GET navigations) and attach the staff email to the
 * request. Mirrors IRP's `requireDashboardAuth`.
 */
export async function requireDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token =
    (req.headers["x-dashboard-token"] as string) || (req.query.token as string);
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    const session = await get("dashboard_sessions", token);
    if (!session || !session.email) {
      res.status(401).json({ error: "Invalid or expired session." });
      return;
    }
    if (session.expiresAt && new Date(session.expiresAt as string) < new Date()) {
      res.status(401).json({ error: "Session expired. Please log in again." });
      return;
    }
    (req as Request & { dashboardUser?: string }).dashboardUser = session.email;
    next();
  } catch {
    res.status(401).json({ error: "Authentication failed." });
  }
}

export default (app: Express) => {
  log("Dashboard router initialized.");

  app.post(
    "/api/dashboard/auth/request-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email is required." });
      }
      const domain = email.split("@")[1]?.toLowerCase();
      if (domain !== allowedDomain()) {
        return res
          .status(403)
          .json({ error: "Access restricted to ILP team members." });
      }

      const code = generateOtp();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
      const otpDocId = email.replace(/[@.]/g, "_");

      await put("dashboard_otps", otpDocId, {
        code,
        email,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });

      try {
        await sendEmailTransport({
          to: email,
          subject: "Your ILP Dashboard Login Code",
          html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
              <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="color: #123b5d; font-size: 24px; margin: 0;">ILP Dashboard</h1>
                <p style="color: #4a5a66; font-size: 14px; margin-top: 8px;">Secure Login Code</p>
              </div>
              <div style="background: #eff7fb; border-radius: 12px; padding: 32px; text-align: center;">
                <p style="color: #202a33; font-size: 16px; margin: 0 0 16px;">Your verification code is:</p>
                <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #123b5d; font-family: monospace; padding: 16px; background: white; border-radius: 8px; display: inline-block;">${code}</div>
                <p style="color: #7a8a96; font-size: 13px; margin-top: 16px;">This code expires in 10 minutes.</p>
              </div>
            </div>
          `,
        });
        log(`[dashboard] OTP sent to ${email}`);
      } catch (err) {
        log(
          `[dashboard] Failed to send OTP email: ${
            err instanceof Error ? err.message : err
          }`,
        );
        return res
          .status(500)
          .json({ error: "Failed to send verification code." });
      }

      res.json({ success: true, message: "Verification code sent to your email." });
    })
  );

  app.post(
    "/api/dashboard/auth/verify-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email, code } = req.body;
      if (!email || !code) {
        return res.status(400).json({ error: "Email and code are required." });
      }

      const otpDocId = email.replace(/[@.]/g, "_");
      const otpDoc = await get("dashboard_otps", otpDocId);
      if (!otpDoc) {
        return res
          .status(401)
          .json({ error: "No verification code found. Please request a new one." });
      }
      if (String(otpDoc.code).trim() !== String(code).trim()) {
        return res.status(401).json({ error: "Invalid verification code." });
      }
      if (new Date(otpDoc.expiresAt as string) < new Date()) {
        return res.status(401).json({ error: "Verification code expired." });
      }

      const token = generateSessionToken();
      const sessionExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await put("dashboard_sessions", token, {
        email,
        createdAt: new Date().toISOString(),
        expiresAt: sessionExpiry.toISOString(),
      });

      log(`[dashboard] Session created for ${email}`);
      res.json({ success: true, token, email, expiresAt: sessionExpiry.toISOString() });
    })
  );

  app.get(
    "/api/dashboard/auth/check",
    requireDashboardAuth,
    (req: Request, res: Response) => {
      res.json({
        authenticated: true,
        email: (req as Request & { dashboardUser?: string }).dashboardUser,
      });
    }
  );
};