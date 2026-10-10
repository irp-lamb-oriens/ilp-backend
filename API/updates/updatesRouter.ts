import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import getAll from "../../db/getAll.ts";
import post from "../../db/post.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * Country legal news CMS + review workflow. Public read, staff write.
 * Every update carries source, reviewer, review date and version status.
 */
export default (app: Express) => {
  log("Updates router initialized.");

  // Public: list published updates, optionally filtered by country.
  app.get(
    "/api/updates",
    asyncHandler(async (req: Request, res: Response) => {
      const country = (req.query.country as string | undefined)?.toUpperCase();
      const all = await getAll("updates");
      const published = all.filter(
        (u) => u.status === "published" && (!country || u.country === country),
      );
      res.status(200).json(published);
    })
  );

  // Public: single update by id.
  app.get(
    "/api/updates/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const { default: get } = await import("../../db/get.ts");
      const doc = await get("updates", req.params.id);
      if (!doc) return res.status(404).json({ error: "update not found" });
      res.status(200).json(doc);
    })
  );

  // Staff: create a legal update (starts as draft -> review).
  app.post(
    "/api/updates",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as Record<string, unknown>;
      if (!body.title || !body.country) {
        return res.status(400).json({ error: "title and country are required" });
      }

      const id = await post("updates", {
        ...body,
        country: String(body.country).toUpperCase(),
        status: "draft",
        author: user.uid,
        version: 1,
        createdAt: new Date().toISOString(),
      });
      res.status(201).json({ id });
    })
  );

  // Staff: approve/publish an update.
  app.patch(
    "/api/updates/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as Record<string, unknown>;
      delete body.id;

      await patch("updates", req.params.id, {
        ...body,
        reviewer: user.uid,
        reviewedAt: new Date().toISOString(),
      });
      res.status(200).json({ ok: true });
    })
  );
};