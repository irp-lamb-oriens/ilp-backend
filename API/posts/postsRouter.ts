import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import post from "../../db/post.ts";
import patch from "../../db/patch.ts";
import remove from "../../db/delete.ts";
import log from "../../helper/log.ts";

/**
 * ILP posts CRUD (blog articles + legal-services guides).
 *
 * Ported from IRP-funnel's postsRouter, tailored to ILP:
 * - IRP's email-broadcast machinery (drip-enabled consultations, destination/
 *   origin country targeting, processIrpPosts dispatch, emailIrpPostBroadcast)
 *   is relocation-specific and SKIPPED.
 * - ILP posts are `posts` docs with `kind: "article" | "guide"`, editable in
 *   the dashboard. No email broadcast, no targeting.
 * - Auth uses ILP's validateUser("staff") instead of IRP's requireDashboardAuth.
 *
 * Routes:
 *   GET    /api/posts            — list all posts (newest first)
 *   POST   /api/posts            — create a draft post
 *   PATCH  /api/posts/:id        — update title/body/status/slug
 *   DELETE /api/posts/:id        — delete a draft post
 */

const POSTS = "posts";

function slugify(s: string): string {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function slugTaken(slug: string, excludeId: string | null, kind: string): Promise<boolean> {
  const docs = await getAll(POSTS);
  return docs.some((d) => d.kind === kind && d.slug === slug && d.id !== excludeId);
}

export default function postsRouter(app: Express) {
  log("Posts router initialized.");

  /** List all posts, newest first. */
  app.get(
    "/api/posts",
    validateUser("staff"),
    asyncHandler(async (_req: Request, res: Response) => {
      const docs = await getAll(POSTS);
      docs.sort((a, b) =>
        String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
      );
      res.json({ posts: docs });
    })
  );

  /** Create a draft post. */
  app.post(
    "/api/posts",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body ?? {};
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml : "";
      if (!title || !bodyHtml) {
        return res.status(400).json({ error: "title and bodyHtml are required" });
      }

      const kind = body.kind === "guide" ? "guide" : "article";
      const status = body.status === "published" ? "published" : "draft";

      const finalSlug = slugify(body.slug || title);
      if (!finalSlug) {
        return res.status(400).json({ error: "A valid URL slug is required" });
      }
      if (await slugTaken(finalSlug, null, kind)) {
        return res.status(409).json({ error: `The slug "${finalSlug}" is already in use.` });
      }

      const now = new Date().toISOString();
      const docData = {
        title,
        bodyHtml,
        kind,
        slug: finalSlug,
        status,
        author: typeof body.author === "string" ? body.author : "",
        createdAt: now,
        updatedAt: now,
      };

      const id = await post(POSTS, docData);
      res.status(201).json({ success: true, post: { id, ...docData } });
    })
  );

  /** Update a post. */
  app.patch(
    "/api/posts/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "A post id is required" });

      const existing = await get(POSTS, id);
      if (!existing) return res.status(404).json({ error: "Post not found" });

      const updates: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
      };
      const allowed = ["title", "bodyHtml", "status", "author", "kind", "slug"];
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) updates[key] = req.body[key];
      }

      if (updates.slug !== undefined) {
        const finalSlug = slugify(String(updates.slug));
        if (!finalSlug) {
          return res.status(400).json({ error: "A valid URL slug is required" });
        }
        const kind = String(updates.kind ?? existing.kind ?? "article");
        if (await slugTaken(finalSlug, id, kind)) {
          return res.status(409).json({ error: `The slug "${finalSlug}" is already in use.` });
        }
        updates.slug = finalSlug;
      }

      await patch(POSTS, id, updates);
      res.json({ success: true });
    })
  );

  /** Delete a draft post. */
  app.delete(
    "/api/posts/:id",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "A post id is required" });

      const existing = await get(POSTS, id);
      if (!existing) return res.status(404).json({ error: "Post not found" });
      if (existing.status !== "draft") {
        return res.status(409).json({ error: "Only draft posts can be deleted." });
      }

      await remove(POSTS, id);
      res.json({ success: true });
    })
  );
}