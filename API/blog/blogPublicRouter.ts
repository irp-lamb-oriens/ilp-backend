import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import query from "../../db/query.ts";

/**
 * PUBLIC (no-auth) read endpoint for web-published blog articles.
 *
 * Ported from IRP-funnel's blogPublicRouter, tailored to ILP:
 * - Collection is `posts` (not IRP's `irp_posts`).
 * - Uses ILP's `query()` helper instead of IRP's raw Firestore runQuery.
 * - Only `kind: "article"` with `status: "published"` is exposed.
 *
 * Route:
 *   GET /api/blog/:slug — { slug, title, bodyHtml, author, updatedAt, createdAt }
 */
export default (app: Express) => {
  log("Blog public router initialized.");

  app.get(
    "/api/blog/:slug",
    asyncHandler(async (req: Request, res: Response) => {
      const slug = String(req.params.slug || "").trim().toLowerCase();
      if (!slug) return res.status(400).json({ error: "Missing slug" });

      const docs = await query("posts", [
        { field: "slug", op: "EQUAL", value: slug },
        { field: "kind", op: "EQUAL", value: "article" },
      ]);

      const article = docs[0] ?? null;
      if (!article || article.status !== "published") {
        return res.status(404).json({ error: "Article not found" });
      }

      res.json({
        slug: article.slug,
        title: article.title ?? "",
        bodyHtml: article.bodyHtml ?? article.body ?? "",
        author: article.author ?? "",
        updatedAt: article.updatedAt ?? article.createdAt ?? "",
        createdAt: article.createdAt ?? "",
      });
    })
  );
};