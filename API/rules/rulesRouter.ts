import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import getAll from "../../db/getAll.ts";
import post from "../../db/post.ts";
import patch from "../../db/patch.ts";
import remove from "../../db/delete.ts";
import log from "../../helper/log.ts";
import auditLog, { auditFrom } from "../../helper/auditLog.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * Admin-managed country/jurisdiction obligation rules. These are DATA, not
 * code: every country/municipality configuration is a document, never
 * hardcoded into the client record.
 */
export default (app: Express) => {
  log("Rules router initialized.");

  // List rules (staff). Optional ?country=CR filter applied client-side.
  app.get(
    "/api/rules",
    validateUser("staff"),
    asyncHandler(async (_req: Request, res: Response) => {
      const rules = await getAll("rules");
      res.status(200).json(rules);
    })
  );

  // Create a rule without code changes.
  app.post(
    "/api/rules",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as {
        country?: string;
        jurisdiction?: string;
        category?: string;
        title?: string;
        description?: string;
      };

      if (!body.country || !body.title) {
        return res.status(400).json({ error: "country and title are required" });
      }

      const id = await post("rules", {
        ...body,
        country: body.country.toUpperCase(),
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await auditLog({
        actor: auditFrom(user),
        action: "rule.created",
        target: `rules/${id}`,
        meta: { country: body.country },
      });

      res.status(201).json({ id });
    })
  );

  // Update a rule.
  app.patch(
    "/api/rules/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as Record<string, unknown> | undefined;
      if (!body) return res.status(400).json({ error: "empty body" });

      delete body.id;
      await patch("rules", req.params.id, {
        ...body,
        updatedAt: new Date().toISOString(),
      });

      await auditLog({
        actor: auditFrom(user),
        action: "rule.updated",
        target: `rules/${req.params.id}`,
      });

      res.status(200).json({ ok: true });
    })
  );

  // Deactivate/delete a rule.
  app.delete(
    "/api/rules/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      await remove("rules", req.params.id);
      await auditLog({
        actor: auditFrom(user),
        action: "rule.deleted",
        target: `rules/${req.params.id}`,
      });
      res.status(200).json({ ok: true });
    })
  );
};