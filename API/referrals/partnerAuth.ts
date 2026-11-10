/**
 * API/referrals/partnerAuth.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Partner portal sign-in: the same hardened email-code flow as the other
 * portals (helper/auth/otp.ts: hashed, single use, 5 attempts, cooldown),
 * its own collections (partner_otps, partner_sessions) and a 12 h session
 * sent as `Authorization: Bearer`.
 *
 *   POST /api/partner/auth/request-otp  { email }
 *   POST /api/partner/auth/verify-otp   { email, code } → { token, expiresAt }
 *   GET  /api/partner/auth/check
 *   POST /api/partner/auth/logout
 *
 * request-otp answers the same for unknown and known emails (no enumeration).
 */
import type { Express, NextFunction, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import auditLog from "../../helper/auditLog.ts";
import log from "../../helper/log.ts";
import { emailToDocId, generateSessionToken, issueOtp, verifyOtp } from "../../helper/auth/otp.ts";
import { bearerToken } from "../../helper/auth/cookies.ts";
import { sessionStore } from "../../helper/auth/sessionStore.ts";
import { sendEmailTransport } from "../../config/integrations.ts";
import { partnerCodeEmail } from "./emails.ts";
import type { ReferralStore } from "./store.ts";

export const PARTNER_OTPS = "partner_otps";
export const PARTNER_SESSIONS = "partner_sessions";
export const PARTNER_SESSION_MS = 12 * 60 * 60 * 1000;

export type PartnerRequest = Request & { partnerId?: string; partnerEmail?: string };

export function requirePartnerAuth(store: ReferralStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = bearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    try {
      const s = await sessionStore.get(PARTNER_SESSIONS, token);
      if (!s?.email || !s.partnerId || (s.expiresAt && new Date(String(s.expiresAt)) < new Date())) {
        res.status(401).json({ error: "Invalid or expired session." });
        return;
      }
      const p = await store.getPartner(String(s.partnerId));
      if (!p || p.status === "closed" || p.email !== String(s.email)) {
        res.status(401).json({ error: "This partner account is closed." });
        return;
      }
      (req as PartnerRequest).partnerId = p.id;
      (req as PartnerRequest).partnerEmail = p.email;
      next();
    } catch {
      res.status(401).json({ error: "Authentication failed." });
    }
  };
}

export function partnerAuthRoutes(app: Express, store: ReferralStore) {
  app.post(
    "/api/partner/auth/request-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const email = String((req.body ?? {}).email ?? "").trim().toLowerCase();
      if (!email.includes("@") || email.length > 254) return res.status(400).json({ error: "Enter a valid email." });
      const p = await store.findPartnerByEmail(email);
      const ok = { success: true, message: "If this email belongs to a partner, a code is on its way." };
      if (!p || p.status === "closed") return res.json(ok);
      const issued = await issueOtp(PARTNER_OTPS, emailToDocId(email), email);
      if (!issued.ok) return res.status(issued.status).json({ error: issued.error });
      try {
        const mail = partnerCodeEmail(p.language, issued.code);
        await sendEmailTransport({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
      } catch (err) {
        log(`[partner-auth] code email failed: ${err instanceof Error ? err.message : err}`, "error");
        return res.status(500).json({ error: "We could not send the code. Try again in a minute." });
      }
      res.json(ok);
    }),
  );

  app.post(
    "/api/partner/auth/verify-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const email = String((req.body ?? {}).email ?? "").trim().toLowerCase();
      const code = (req.body ?? {}).code;
      if (!email || !code) return res.status(400).json({ error: "Email and code are required." });
      const check = await verifyOtp(PARTNER_OTPS, emailToDocId(email), code);
      if (!check.ok) return res.status(check.status).json({ error: check.error });
      const p = await store.findPartnerByEmail(email);
      if (!p || p.status === "closed") return res.status(401).json({ error: "This partner account is closed." });
      const token = generateSessionToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + PARTNER_SESSION_MS).toISOString();
      await sessionStore.put(PARTNER_SESSIONS, token, { email, partnerId: p.id, createdAt: now.toISOString(), expiresAt });
      await auditLog({ actor: { uid: p.id, email, role: "partner" }, action: "auth.login", target: `partner:${email}`, meta: { portal: "partner" } });
      res.json({ success: true, token, expiresAt, partnerId: p.id, name: p.name, language: p.language });
    }),
  );

  app.get("/api/partner/auth/check", requirePartnerAuth(store), (req: Request, res: Response) => {
    res.json({ authenticated: true, partnerId: (req as PartnerRequest).partnerId, email: (req as PartnerRequest).partnerEmail });
  });

  app.post(
    "/api/partner/auth/logout",
    asyncHandler(async (req: Request, res: Response) => {
      const token = bearerToken(req);
      if (token) await sessionStore.remove(PARTNER_SESSIONS, token).catch(() => {});
      res.json({ success: true });
    }),
  );
}
