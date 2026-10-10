import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import auditLog, { auditFrom } from "../../helper/auditLog.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * Living Legal Profile. The single customer record the whole flywheel
 * enriches: country + contact + consent + profile signals.
 */
export default (app: Express) => {
  log("Profiles router initialized.");

  // Upsert profile (create-on-first-signup or enrich on repeat visits).
  app.post(
    "/api/profiles",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as {
        country?: string;
        consent?: Record<string, boolean>;
        signals?: Record<string, unknown>;
        firstName?: string;
        lastName?: string;
        phone?: string;
      };

      if (!body.country) {
        return res.status(400).json({ error: "country is required" });
      }

      const id = `profile_${user.uid}`;
      const existing = await get("profiles", id);
      const now = new Date().toISOString();

      const record = {
        uid: user.uid,
        email: user.email,
        country: body.country,
        firstName: body.firstName ?? (existing?.firstName as string) ?? "",
        lastName: body.lastName ?? (existing?.lastName as string) ?? "",
        phone: body.phone ?? (existing?.phone as string) ?? "",
        consent: { ...(existing?.consent as Record<string, boolean>), ...body.consent },
        signals: { ...(existing?.signals as Record<string, unknown>), ...body.signals },
        updatedAt: now,
        ...(existing ? {} : { createdAt: now }),
      };

      await patch("profiles", id, record);

      await auditLog({
        actor: auditFrom(user),
        action: existing ? "profile.updated" : "profile.created",
        target: `profiles/${id}`,
        meta: { country: body.country },
      });

      res.status(200).json({ id, ...record });
    })
  );

  // Read own profile.
  app.get(
    "/api/profiles/me",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const profile = await get("profiles", `profile_${user.uid}`);
      res.status(200).json(profile ?? null);
    })
  );
};