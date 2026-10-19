/**
 * schemas/collections/content.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for public content collections (blog, guides, updates,
 * templates, posts).
 */
import type { Extensible, IsoTimestamp } from "../types.ts";

/** posts — a blog post or guide. */
export interface PostDoc extends Extensible {
  id: string;
  kind: "guide" | "post";
  slug: string;
  title: string;
  body?: string;
  country?: string;
  category?: string;
  status?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** updates — a legislative/regulatory update. */
export interface UpdateDoc extends Extensible {
  id: string;
  title: string;
  country?: string;
  category?: string;
  summary?: string;
  source?: string;
  status?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** templates — a public template record. */
export interface TemplateDoc extends Extensible {
  id: string;
  title: string;
  country?: string;
  category?: string;
  status?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** template_downloads — a template download event. */
export interface TemplateDownloadDoc extends Extensible {
  id: string;
  templateId: string;
  email?: string;
  country?: string;
  name?: string;
  createdAt: IsoTimestamp;
}