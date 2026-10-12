import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import query from "../../db/query.ts";

/**
 * PUBLIC (no-auth) read endpoints for ILP legal-services guides.
 *
 * Ported from IRP-funnel's guidesPublicRouter, tailored to ILP:
 * - IRP's country relocation guides + IAM PDF fallback are relocation-specific
 *   and SKIPPED.
 * - ILP guides are `posts` docs with `kind: "guide"`, editable in the dashboard.
 *
 * Routes:
 *   GET /api/guides            — list published guides
 *   GET /api/guides/:slug      — a single guide by slug
 */
export default (app: Express) => {
  log("Guides public router initialized.");

  app.get(
    "/api/guides",
    asyncHandler(async (_req: Request, res: Response) => {
      const docs = await query("posts", [
        { field: "kind", op: "EQUAL", value: "guide" },
        { field: "status", op: "EQUAL", value: "published" },
      ]);

      res.json({
        guides: docs.map((g) => ({
          slug: g.slug,
          title: g.title ?? g.slug ?? "",
          updatedAt: g.updatedAt ?? g.createdAt ?? "",
        })),
      });
    })
  );

  app.get(
    "/api/guides/:slug",
    asyncHandler(async (req: Request, res: Response) => {
      const slug = String(req.params.slug || "").trim().toLowerCase();
      if (!slug) return res.status(400).json({ error: "Missing slug" });

      const docs = await query("posts", [
        { field: "slug", op: "EQUAL", value: slug },
        { field: "kind", op: "EQUAL", value: "guide" },
      ]);

      const guide = docs[0] ?? null;
      if (!guide || guide.status !== "published") {
        return res.status(404).json({ error: "Guide not found" });
      }

      res.json({
        slug: guide.slug,
        title: guide.title ?? "",
        bodyHtml: guide.bodyHtml ?? guide.body ?? "",
        updatedAt: guide.updatedAt ?? guide.createdAt ?? "",
        createdAt: guide.createdAt ?? "",
      });
    })
  );
};