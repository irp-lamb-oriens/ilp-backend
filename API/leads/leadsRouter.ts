import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import post from "../../db/post.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";
import { sanitizeStr } from "../../helper/sanitize.ts";
import { emailToDocId } from "../../helper/auth/otp.ts";
import { SUPPORTED_COUNTRIES } from "../countries/countryCatalog.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENTS_COLLECTION = "clients";

/** Map an ISO alpha-2 code to its display name, falling back to the code. */
function countryName(code: string): string {
  const match = SUPPORTED_COUNTRIES.find((c) => c.code === code);
  return match ? match.name : code;
}

/**
 * Public lead capture. Lower-friction than a full profile: the landing page
 * collects name/email/country/topic and persists a time-stamped lead for
 * follow-up. Mirrors IRP-funnel's public capture router (API/users/captureRouter).
 *
 * Also promotes the lead into the `clients` collection (the flywheel's source
 * of truth) so the customer immediately has a matter the portal, deadlines,
 * and push notifications can act on. Promotion is non-destructive: an existing
 * client doc is never overwritten.
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

      // Promote to a client doc so the flywheel (portal, deadlines, push) can
      // act on this customer immediately. Read-then-create: never clobber an
      // existing client that already carries real matter data.
      const clientId = emailToDocId(email);
      const existing = await get(CLIENTS_COLLECTION, clientId).catch(() => null);
      if (!existing) {
        const now = new Date().toISOString();
        await put(CLIENTS_COLLECTION, clientId, {
          name: name || "",
          email,
          jurisdiction: countryName(country),
          legalMatter: topic || "",
          stage: "intake",
          source: "landing_hero",
          consent,
          deadlines: {},
          createdAt: now,
          updatedAt: now,
        });
        log(`[leads] promoted ${email} to client ${clientId}`, "leads");
      }

      res.status(201).json({ id, clientId });
    })
  );
};