import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import post from "../../db/post.ts";
import log from "../../helper/log.ts";
import { sanitizeStr } from "../../helper/sanitize.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public lead capture. Lower-friction than a full profile: the landing page
 * collects name/email/country/topic and persists a time-stamped lead for
 * follow-up. Mirrors IRP-funnel's public capture router (API/users/captureRouter).
 */
export default (app: Express) => {
  log("Leads router initialized.");

  app.post(
    "/api/leads",
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as Record<string, unknown> | undefined;

      const email = sanitizeStr(body?.email).toLowerCase();
      const country = sanitizeStr(body?.country).toUpperCase();
      const name = sanitizeStr(body?.name);
      const topic = sanitizeStr(body?.topic);
      const consent = body?.consent === true;

      if (!email || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      if (!country) {
        return res.status(400).json({ error: "country is required" });
      }

      const id = await post("leads", {
        name,
        email,
        country,
        topic,
        consent,
        source: "landing_hero",
        createdAt: new Date().toISOString(),
      });

      res.status(201).json({ id });
    })
  );
};