/**
 * helper/placeholderScope.ts — "Exclude placeholder data", once, for every staff screen.
 * ──────────────────────────────────────────────────────────────────────────
 * Placeholder (seed) records live next to real ones (docs/workstreams/SEED.md).
 * A staff member can ask to leave them out with `?excludePlaceholder=1` (or
 * the `X-ILP-Exclude-Placeholder: 1` header) on any GET. The request then runs
 * inside a scope in which every list and query the server makes
 * (helper/firestore/firestoreService.ts) answers without placeholder
 * documents, so counts, KPIs, charts, boards and lists are all computed from
 * real records only, with no change to the route that builds them.
 *
 * Rules:
 *   - GET only. A change (POST/PATCH/PUT/DELETE) always sees everything, so
 *     nothing is written from a filtered view.
 *   - Reads of one document by id are never filtered, and a request about one
 *     placeholder record (a `ph_` id in its path) is not scoped at all: a
 *     direct link to a placeholder member still opens with its story.
 *   - Placeholder elements inside arrays of a real document (the account
 *     seed appends example charges, quotes and messages to three real
 *     accounts) are left out of listed documents too.
 *   - Jobs and scripts run outside any scope and see everything.
 *   - The read cache keeps full answers; the scope filters each caller's copy.
 *
 * No imports from db/ or helper/placeholder.ts on purpose: the Firestore
 * service imports this file.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

export const EXCLUDE_PARAM = "excludePlaceholder";
export const EXCLUDE_HEADER = "x-ilp-exclude-placeholder";

const scope = new AsyncLocalStorage<{ exclude: boolean }>();

/** True while the current request asked to leave placeholder data out. */
export function placeholderExcluded(): boolean {
  return scope.getStore()?.exclude === true;
}

/** Run `fn` with placeholder data left out of every list and query it makes. */
export function excludingPlaceholders<T>(fn: () => T): T {
  return scope.run({ exclude: true }, fn);
}

/** Run `fn` seeing everything, whatever the request asked (placeholder counts, cleanup). */
export function includingPlaceholders<T>(fn: () => T): T {
  return scope.run({ exclude: false }, fn);
}

const on = (v: unknown) => v === "1" || v === "true";

/** The request asked for real data only (query parameter or header). */
export function wantsExclusion(req: Pick<Request, "method" | "query" | "headers"> & { path?: string }): boolean {
  if (String(req.method ?? "GET").toUpperCase() !== "GET") return false;
  if (typeof req.path === "string" && /\/ph_[^/]/.test(req.path)) return false;
  const q = (req.query ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(q[EXCLUDE_PARAM]) ? (q[EXCLUDE_PARAM] as unknown[])[0] : q[EXCLUDE_PARAM];
  return on(raw) || on((req.headers ?? {})[EXCLUDE_HEADER]);
}

/** Express middleware: mount before the routers. */
export function placeholderScope() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!wantsExclusion(req)) return next();
    scope.run({ exclude: true }, () => next());
  };
}

/** Same test as helper/placeholder.ts isPlaceholderDoc (kept here to avoid an import cycle; a test compares them). */
export function isPlaceholderRecord(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as Record<string, unknown>;
  return d.placeholder === true || d.isPlaceholder === true || (typeof d.id === "string" && d.id.startsWith("ph_"));
}

/** A real document without the placeholder elements the account seed appended to its arrays. */
function withoutPlaceholderElements<T>(doc: T): T {
  if (!doc || typeof doc !== "object") return doc;
  const d = doc as Record<string, unknown>;
  // Only documents the account seed touched carry this marker; everything else is returned as is.
  if (d.placeholderAccountBatch === undefined && d.placeholderFields === undefined) return doc;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(d)) {
    if (!Array.isArray(v) || !v.some((x) => x && typeof x === "object" && (x as Record<string, unknown>).placeholder === true)) continue;
    out ??= { ...d };
    out[k] = v.filter((x) => !(x && typeof x === "object" && (x as Record<string, unknown>).placeholder === true));
  }
  return (out ?? d) as T;
}

/** What a list or query answers inside the current scope. Outside an excluding scope: the same array. */
export function applyPlaceholderScope<T>(docs: T[]): T[] {
  if (!placeholderExcluded()) return docs;
  const out: T[] = [];
  for (const d of docs) if (!isPlaceholderRecord(d)) out.push(withoutPlaceholderElements(d));
  return out;
}
