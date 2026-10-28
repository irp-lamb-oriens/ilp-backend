/**
 * db/records.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Thin typed data layer for the member-loop collections defined in
 * `schemas/contracts.ts` (memberships, matters, consultations, handoffs,
 * csm_tasks, obligations, leads).
 *
 * Every record is a top-level document keyed by `id` that also stores its own
 * `id` field. Queries use equality filters only and sort in memory, so they
 * work before composite indexes are deployed (the indexes in
 * firestore.indexes.json are still declared for when ordering moves server
 * side).
 */

import get from "./get.ts";
import put from "./put.ts";
import patch from "./patch.ts";
import query, { type QueryFilter } from "./query.ts";
import getAll from "./getAll.ts";
import { COLLECTIONS } from "../schemas/contracts.ts";
import { derivedStamp, isPlaceholderId, PLACEHOLDER_PREFIX } from "../helper/placeholder.ts";
import { searchTokens } from "../helper/listing.ts";

export type RecordCollection =
  | typeof COLLECTIONS.leads
  | typeof COLLECTIONS.memberships
  | typeof COLLECTIONS.matters
  | typeof COLLECTIONS.consultations
  | typeof COLLECTIONS.handoffs
  | typeof COLLECTIONS.csmTasks
  | typeof COLLECTIONS.obligations;

export const RECORD_COLLECTIONS: RecordCollection[] = [
  COLLECTIONS.leads,
  COLLECTIONS.memberships,
  COLLECTIONS.matters,
  COLLECTIONS.consultations,
  COLLECTIONS.handoffs,
  COLLECTIONS.csmTasks,
  COLLECTIONS.obligations,
];

/** Id prefixes keep ids readable in logs and the Firestore console. */
const PREFIX: Record<RecordCollection, string> = {
  leads: "lead",
  memberships: "mem",
  matters: "mat",
  consultations: "con",
  handoffs: "hof",
  csm_tasks: "task",
  obligations: "obl",
};

/**
 * Fields whose words feed each record's `searchTokens` (helper/listing.ts).
 * Dotted paths read into nested objects and arrays ("legalNextSteps.what").
 * Kept current on every createRecord / updateRecord; older records get them
 * from scripts/backfillSearchTokens.ts.
 */
export const SEARCH_FIELDS: Record<RecordCollection, string[]> = {
  leads: ["name", "email", "country", "source"],
  memberships: ["clientId", "csmEmail", "status", "country", "plan"],
  matters: ["title", "area", "country", "stage", "question"],
  consultations: ["question", "status", "clientId"],
  handoffs: ["legalNextSteps.what", "clientId"],
  csm_tasks: ["title", "type", "ownerEmail", "clientId"],
  obligations: ["title", "country", "status"],
};

function readPath(doc: unknown, path: string): unknown[] {
  let cur: unknown[] = [doc];
  for (const part of path.split(".")) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (Array.isArray(v)) for (const x of v) next.push((x as Record<string, unknown> | null)?.[part]);
      else if (v && typeof v === "object") next.push((v as Record<string, unknown>)[part]);
    }
    cur = next.flat();
  }
  return cur.filter((v) => v !== undefined && v !== null);
}

/** The values a record's search reads (the same ones its tokens come from). */
export function recordSearchValues(collection: RecordCollection, doc: Record<string, unknown>): unknown[] {
  return (SEARCH_FIELDS[collection] ?? []).map((f) => readPath(doc, f));
}

/** The `searchTokens` array for a record of `collection`. */
export function recordSearchTokens(collection: RecordCollection, doc: Record<string, unknown>): string[] {
  const fields = SEARCH_FIELDS[collection] ?? [];
  return searchTokens(...fields.map((f) => readPath(doc, f)));
}

/** True when a write touches a field that feeds the search tokens. */
function touchesSearch(collection: RecordCollection, fields: Record<string, unknown>): boolean {
  const roots = new Set((SEARCH_FIELDS[collection] ?? []).map((f) => f.split(".")[0]));
  return Object.keys(fields).some((k) => roots.has(k));
}

export function newId(collection: RecordCollection): string {
  return `${PREFIX[collection]}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Drop undefined values (Firestore REST has no undefined). Recurses into plain objects/arrays. */
export function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => clean(v)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = clean(v);
    }
    return out as T;
  }
  return value;
}

/** Return a deep copy without the listed keys at any depth. */
export function stripFields<T>(value: T, fields: readonly string[]): T {
  const hidden = new Set(fields);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (!hidden.has(k)) out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export async function getRecord<T>(collection: RecordCollection, id: string): Promise<T | null> {
  const doc = await get(collection, id);
  if (!doc) return null;
  return { ...(doc as Record<string, unknown>), id } as T;
}

/** Create (or replace) a record. Uses `data.id` when given, else a new id. */
export async function createRecord<T extends object>(
  collection: RecordCollection,
  data: T,
): Promise<T & { id: string }> {
  const given = (data as { id?: unknown }).id;
  const clientId = (data as { clientId?: unknown }).clientId;
  // Records about placeholder (seed) members are placeholder too: ph_ id + flag,
  // so scripts/removePlaceholders.ts finds them (helper/placeholder.ts).
  const ph = isPlaceholderId(clientId) || isPlaceholderId(given);
  const base = typeof given === "string" && given ? given : newId(collection);
  const id = ph && !isPlaceholderId(base) ? `${PLACEHOLDER_PREFIX}${base}` : base;
  const stamp = ph && (data as { placeholder?: unknown }).placeholder !== true ? derivedStamp() : {};
  const base0 = clean({ ...data, ...stamp, id }) as Record<string, unknown>;
  const doc = { ...base0, searchTokens: recordSearchTokens(collection, base0) } as unknown as T & { id: string };
  await put(collection, id, doc as unknown as Record<string, unknown>);
  return doc;
}

/** Merge fields into an existing record. Returns the merged record or null if missing. */
export async function updateRecord<T>(
  collection: RecordCollection,
  id: string,
  fields: Record<string, unknown>,
): Promise<T | null> {
  const existing = await get(collection, id);
  if (!existing) return null;
  const rest = { ...fields };
  delete rest.id;
  const cleaned = clean(rest);
  delete (cleaned as Record<string, unknown>).searchTokens;
  if (touchesSearch(collection, cleaned) || !Array.isArray((existing as Record<string, unknown>).searchTokens)) {
    (cleaned as Record<string, unknown>).searchTokens = recordSearchTokens(collection, { ...(existing as Record<string, unknown>), ...cleaned });
  }
  await patch(collection, id, cleaned);
  return { ...(existing as Record<string, unknown>), ...cleaned, id } as T;
}

export interface ListOptions {
  /** Field to sort by in memory (ISO strings sort lexically). */
  sortBy?: string;
  desc?: boolean;
  limit?: number;
}

export function sortDocs<T>(docs: T[], opts: ListOptions): T[] {
  let out = docs;
  if (opts.sortBy) {
    const key = opts.sortBy;
    out = [...docs].sort((a, b) => {
      const x = String((a as Record<string, unknown>)[key] ?? "");
      const y = String((b as Record<string, unknown>)[key] ?? "");
      return opts.desc ? y.localeCompare(x) : x.localeCompare(y);
    });
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** Equality query on one or more fields. Empty `where` lists the collection. */
export async function findRecords<T>(
  collection: RecordCollection,
  where: Record<string, unknown> = {},
  opts: ListOptions = {},
): Promise<T[]> {
  const filters: QueryFilter[] = Object.entries(where)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([field, value]) => ({ field, op: "EQUAL" as const, value }));
  const docs = filters.length ? await query(collection, filters) : await getAll(collection);
  return sortDocs(docs as unknown as T[], opts);
}

export function listByClient<T>(
  collection: RecordCollection,
  clientId: string,
  opts: ListOptions = {},
): Promise<T[]> {
  return findRecords<T>(collection, { clientId }, opts);
}
