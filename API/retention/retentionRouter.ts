/**
 * API/retention/retentionRouter.ts — member email preferences + feedback (P2).
 * Registered from paymentsRouter (main.ts is shared).
 *
 *   GET /api/retention/unsubscribe?c=<clientId>&t=<sig>[&confirm=1]
 *       Signed link from reminder emails. Without confirm it shows one button
 *       (so link scanners do not unsubscribe people); with confirm it sets
 *       clients.emailOptOut = true. Payment and account emails still arrive.
 *   GET /api/retention/unsubscribe?l=<leadId>&t=<sig>[&confirm=1]
 *       COMMS-P1: the same for the free deadline check email (a lead, no
 *       client record): marks the lead and suppresses the address for
 *       marketing (email_suppressions).
 *   /api/retention/me/feedback/*  post-call rating + monthly 0-10 (feedback.ts)
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import patch from "../../db/patch.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import auditLog from "../../helper/auditLog.ts";
import { siteUrl, SUPPRESSIONS, suppressionId, verifyLeadUnsubscribe, verifyUnsubscribe } from "./mailer.ts";
import { registerFeedbackRoutes } from "./feedback.ts";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="font-family:Helvetica,Arial,sans-serif;color:#202a33;line-height:1.6;max-width:34rem;margin:0 auto;padding:2rem 1rem;font-size:18px">
  <h1 style="color:#123b5d;font-size:1.5rem;line-height:1.2">${title}</h1>${body}</body></html>`;

export function registerRetentionRoutes(app: Express) {
  registerFeedbackRoutes(app); // /api/retention/me/feedback/* (feedback.ts)

  app.get(
    "/api/retention/unsubscribe",
    asyncHandler(async (req: Request, res: Response) => {
      const c = String(req.query.c ?? "").slice(0, 200);
      const l = String(req.query.l ?? "").slice(0, 200);
      const t = String(req.query.t ?? "").slice(0, 64);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (l && !c) {
        // COMMS-P1: the free deadline check email (a lead without a client record).
        if (!(await verifyLeadUnsubscribe(l, t))) {
          return res.status(400).send(page("This link is not valid", "<p>Reply to the email and we will update your email settings.</p>"));
        }
        if (req.query.confirm !== "1") {
          const href = `?l=${encodeURIComponent(l)}&t=${encodeURIComponent(t)}&confirm=1`;
          return res.status(200).send(page(
            "Stop emails about your deadline check?",
            `<p>You will not get more emails from ILP about your free deadline check. If you saved deadlines in an ILP account, you can turn their reminders off on your Deadlines page.</p>
             <p><a href="${href}" style="display:inline-block;background:#5cccf7;color:#123b5d;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">Stop these emails</a></p>`,
          ));
        }
        const lead = (await get("leads", l).catch(() => null)) as Record<string, unknown> | null;
        const at = new Date().toISOString();
        await patch("leads", l, { emailOptOut: true, emailOptOutAt: at });
        const email = typeof lead?.email === "string" ? lead.email.trim().toLowerCase() : "";
        if (email) await put(SUPPRESSIONS, suppressionId(email), { email, active: true, scope: "marketing", source: "free_check", leadId: l, at });
        await auditLog({ actor: { uid: l, email, role: "lead" }, action: "email.opt_out", target: `leads/${l}`, meta: { via: "unsubscribe_link" } });
        return res.status(200).send(page(
          "These emails are off",
          `<p>You will not get more emails from ILP about your deadline check.</p><p><a href="${siteUrl()}/check" style="color:#123b5d">Back to ILP</a></p>`,
        ));
      }
      if (!(await verifyUnsubscribe(c, t))) {
        return res.status(400).send(page("This link is not valid", "<p>Open your ILP home and message your team, and we will update your email settings.</p>"));
      }
      if (req.query.confirm !== "1") {
        const href = `?c=${encodeURIComponent(c)}&t=${encodeURIComponent(t)}&confirm=1`;
        return res.status(200).send(page(
          "Stop reminder emails?",
          `<p>You will stop getting reminders, monthly check-ins and next-step emails from ILP. Payment and account emails still arrive, and everything stays visible in your ILP home.</p>
           <p><a href="${href}" style="display:inline-block;background:#5cccf7;color:#123b5d;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">Stop reminder emails</a></p>`,
        ));
      }
      await patch("clients", c, { emailOptOut: true, emailOptOutAt: new Date().toISOString() });
      await auditLog({ actor: { uid: c, email: "", role: "client" }, action: "email.opt_out", target: `clients/${c}`, meta: { via: "unsubscribe_link" } });
      res.status(200).send(page(
        "Reminder emails are off",
        `<p>You will not get reminder emails from ILP any more. Payment and account emails still arrive.</p><p><a href="${siteUrl()}/status" style="color:#123b5d">Open your ILP home</a></p>`,
      ));
    }),
  );
}
