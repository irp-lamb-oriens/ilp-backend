import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import getAll from "../../db/getAll.ts";
import post from "../../db/post.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import auditLog, { auditFrom } from "../../helper/auditLog.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * Versioned downloadable legal templates. Public list/download (lead capture),
 * staff authoring with jurisdiction + version + review metadata.
 */
export default (app: Express) => {
  log("Templates router initialized.");

  // Public: list published templates, optionally by country/category.
  app.get(
    "/api/templates",
    asyncHandler(async (req: Request, res: Response) => {
      const country = (req.query.country as string | undefined)?.toUpperCase();
      const all = await getAll("templates");
      const published = all.filter(
        (t) => t.status === "published" && (!country || t.country === country),
      );
      res.status(200).json(published);
    })
  );

  // Public: record a download/lead-capture event (no auth — leads are the goal).
  app.post(
    "/api/templates/:id/download",
    asyncHandler(async (req: Request, res: Response) => {
      const { email, country, name } = req.body ?? {};
      await post("template_downloads", {
        templateId: req.params.id,
        email: email ?? null,
        country: country ?? null,
        name: name ?? null,
        at: new Date().toISOString(),
      });
      res.status(200).json({ ok: true });
    })
  );

  // Staff: create a template.
  app.post(
    "/api/templates",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as Record<string, unknown>;
      if (!body.title || !body.country) {
        return res.status(400).json({ error: "title and country are required" });
      }

      const id = await post("templates", {
        ...body,
        country: String(body.country).toUpperCase(),
        status: "draft",
        version: 1,
        author: user.uid,
        createdAt: new Date().toISOString(),
      });

      await auditLog({
        actor: auditFrom(user),
        action: "template.created",
        target: `templates/${id}`,
      });

      res.status(201).json({ id });
    })
  );

  // Staff: publish / bump version.
  app.patch(
    "/api/templates/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as Record<string, unknown>;
      delete body.id;

      await patch("templates", req.params.id, {
        ...body,
        reviewer: user.uid,
        reviewedAt: new Date().toISOString(),
      });

      await auditLog({
        actor: auditFrom(user),
        action: "template.updated",
        target: `templates/${req.params.id}`,
      });

      res.status(200).json({ ok: true });
    })
  );
};