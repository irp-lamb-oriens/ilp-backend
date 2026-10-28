/**
 * helper/listing.ts
 * ──────────────────────────────────────────────────────────────────────────
 * One contract for every list the three portals fetch (docs/workstreams/LISTS.md).
 *
 * Request (all optional; a request with none of limit/cursor/stream gets the
 * route's legacy response so old callers keep working):
 *   ?limit=25        page size, default 25, capped at 100
 *   ?cursor=…        opaque (base64url of sort, dir, last sort key, last id)
 *   ?sort=…&dir=asc|desc   allow-listed per endpoint
 *   ?q=…             search: lowercased, accent-free word prefixes, AND
 *   other keys       allow-listed filters per endpoint (status, owner, country, stage, from, to, …)
 *   ?stream=1 or Accept: application/x-ndjson  → NDJSON instead of one JSON body
 *
 * JSON response: { items, nextCursor, hasMore, total?, ...meta }
 * NDJSON response, one JSON object per line, flushed per batch:
 *   {"type":"meta", ...}           only when the route has metadata (counts, owner lists)
 *   {"type":"item","item":{…}}     one per row, as each Firestore page arrives
 *   {"type":"end","nextCursor":…,"hasMore":…,"total"?:…}
 *   {"type":"error","error":"…"}   if a later batch fails (the stream then ends)
 * The upstream reads stop when the client disconnects (the response "close"
 * event; the request's own "close" fires as soon as a GET body is read).
 *
 * Two ways to produce a page:
 *   - firestorePages(): runQuery with orderBy + __name__, startAt(cursor) and
 *     limit, plus array-contains on `searchTokens` for the first search word
 *     (the other words are checked in memory inside the page window).
 *   - pageRows(): the same contract over rows a route already holds in memory
 *     (joined views: members, capacity, timeline). Only the page is enriched.
 *
 * FILTERS: a spec may carry a `schema` (schemas/listSchemas.ts, the same file
 * the browser uses). Its `f.<key>=<op>:<value>` params are validated (unknown
 * field or operator → 400) and applied to every row: in pageRows, and in the
 * page window of a Firestore query (the `keep` of db/recordLists.ts). The
 * first page's meta carries the schema with option counts when the rows were
 * in memory (`schema` in the meta line).
 */

import type { Request, Response } from "express";
import { documentName, runStructuredQuery, type FirestoreDocument } from "./firestore/firestoreService.ts";
import { toFirestoreValue } from "./firestore/toFirestoreValue.ts";
import {
  facetCounts,
  fieldValue,
  type ListSchema,
  ListSchemaError,
  type ParsedFilter,
  parseFilterParams,
  publicSchema,
  rowMatches,
  searchValues,
  type ValueReader,
} from "../schemas/listSchemas.ts";

export type Dir = "asc" | "desc";
export type SortValue = string | number | boolean | null | undefined;

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
/** Search words beyond this are ignored; each word is cut to MAX_TOKEN_LEN. */
export const MAX_QUERY_TOKENS = 6;
export const MAX_TOKEN_LEN = 20;
/** Firestore docs scanned for one page when the other search words filter in memory. */
export const MAX_SCAN = 1000;

export interface ListSpec<T> {
  /** Allowed sort keys and how to read each from a row. */
  sorts: Record<string, (row: T) => SortValue>;
  defaultSort: string;
  defaultDir?: Dir;
  /** Allowed filters: query key → predicate. Unknown keys are ignored. Empty values are skipped. */
  filters?: Record<string, (row: T, value: string) => boolean>;
  /** Values the search matches against (word prefixes). Without it, `q` is ignored. */
  search?: (row: T) => unknown[];
  /** Row id for the cursor tie-break. Default: row.id. */
  id?: (row: T) => string;
  defaultLimit?: number;
  /** FILTERS: the list's field schema; `f.*` params are checked against it. */
  schema?: ListSchema;
  /** How a schema field is read from a row when the row does not hold it under its key or path. */
  read?: ValueReader<T>;
}

export interface CursorKey {
  s: string;
  d: Dir;
  k: SortValue;
  id: string;
}

export interface ListParams {
  limit: number;
  cursor: CursorKey | null;
  sort: string;
  dir: Dir;
  q: string;
  qTokens: string[];
  filters: Record<string, string>;
  /** FILTERS: validated schema filters (`f.*` params). */
  where: ParsedFilter[];
  /** Filled while the page is built: option counts for the meta line (shared by copies of these params). */
  out: { facets?: Record<string, Record<string, number>> };
}

export interface ListTail {
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export interface ListPage<T> extends ListTail {
  items: T[];
}

/** Yields batches as they arrive; returns the tail. Must stop when `signal` aborts. */
export type ListProducer<T> = (signal: AbortSignal) => AsyncGenerator<T[], ListTail, void>;

export class ListParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListParamError";
  }
}

// ── Cursor ──────────────────────────────────────────────────────────────────

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCursor(c: CursorKey): string {
  return b64urlEncode(JSON.stringify([c.s, c.d, c.k ?? null, c.id]));
}

export function decodeCursor(raw: string): CursorKey {
  try {
    const v = JSON.parse(b64urlDecode(raw));
    if (!Array.isArray(v) || v.length !== 4 || typeof v[0] !== "string" || (v[1] !== "asc" && v[1] !== "desc") || typeof v[3] !== "string") {
      throw new Error("shape");
    }
    const k = v[2];
    if (k !== null && typeof k !== "string" && typeof k !== "number" && typeof k !== "boolean") throw new Error("key");
    return { s: v[0], d: v[1], k, id: v[3] };
  } catch {
    throw new ListParamError("The list cursor is not valid. Reload the list.");
  }
}

// ── Search tokens ───────────────────────────────────────────────────────────

/** Lowercase and strip accents ("Peñas Núñez" → "penas nunez"). */
export function normalizeText(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Words of a value: letters and digits; an email also gives its local part and domain words. */
export function wordsOf(value: unknown): string[] {
  return normalizeText(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Flatten nested values (arrays, plain objects) into strings. */
function flatten(values: unknown[], out: string[] = []): string[] {
  for (const v of values) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) flatten(v, out);
    else if (typeof v === "object") flatten(Object.values(v as Record<string, unknown>), out);
    else out.push(String(v));
  }
  return out;
}

/**
 * The `searchTokens` array stored on a record: every word and every prefix of
 * it (1..MAX_TOKEN_LEN letters), deduplicated, at most 400 entries. A query
 * word matches when it is one of these tokens.
 */
export function searchTokens(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const text of flatten(values)) {
    for (const w of wordsOf(text)) {
      const word = w.slice(0, MAX_TOKEN_LEN);
      for (let i = 1; i <= word.length; i++) out.add(word.slice(0, i));
      if (out.size >= 400) return [...out].slice(0, 400);
    }
  }
  return [...out];
}

/** Query words, deduplicated, longest first (the most selective one goes to Firestore). */
export function queryTokens(q: string): string[] {
  const words = [...new Set(wordsOf(q).map((w) => w.slice(0, MAX_TOKEN_LEN)))].slice(0, MAX_QUERY_TOKENS);
  return words.sort((a, b) => b.length - a.length);
}

/** Every query word is a prefix of some word in `values`. */
export function matchesQuery(values: unknown[], qTokens: string[]): boolean {
  if (!qTokens.length) return true;
  const words = flatten(values).flatMap(wordsOf);
  return qTokens.every((t) => words.some((w) => w.startsWith(t)));
}

/** Same check against a stored token array. */
export function tokensMatch(tokens: readonly string[] | undefined, qTokens: string[]): boolean {
  if (!qTokens.length) return true;
  if (!tokens) return false;
  const set = new Set(tokens);
  return qTokens.every((t) => set.has(t));
}

// ── Params ──────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");

export function parseListParams<T>(query: Record<string, unknown>, spec: ListSpec<T>): ListParams {
  const rawLimit = Number(str(query.limit));
  const def = spec.defaultLimit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : def;
  const sortQ = str(query.sort);
  if (sortQ && !(sortQ in spec.sorts)) throw new ListParamError(`Unknown sort "${sortQ}".`);
  const sort = sortQ || spec.defaultSort;
  const dirQ = str(query.dir);
  if (dirQ && dirQ !== "asc" && dirQ !== "desc") throw new ListParamError(`Unknown direction "${dirQ}".`);
  const dir: Dir = (dirQ as Dir) || (sortQ ? "asc" : spec.defaultDir ?? "asc");
  const cursorQ = str(query.cursor);
  const cursor = cursorQ ? decodeCursor(cursorQ) : null;
  if (cursor && (cursor.s !== sort || cursor.d !== dir)) {
    throw new ListParamError("The list order changed. Start again from the first page.");
  }
  const filters: Record<string, string> = {};
  for (const key of Object.keys(spec.filters ?? {})) {
    const v = str(query[key]).trim();
    if (v) filters[key] = v.slice(0, 200);
  }
  const q = str(query.q).trim().slice(0, 200);
  let where: ParsedFilter[] = [];
  try {
    if (spec.schema) where = parseFilterParams(spec.schema, query);
    else if (Object.keys(query).some((k) => k.startsWith("f."))) throw new ListSchemaError("This list has no filters of that kind.");
  } catch (e) {
    if (e instanceof ListSchemaError) throw new ListParamError(e.message);
    throw e;
  }
  const searchable = !!spec.search || !!spec.schema?.fields.some((f) => f.searchable);
  return { limit, cursor, sort, dir, q, qTokens: searchable ? queryTokens(q) : [], filters, where, out: {} };
}

/** How the spec reads a schema field from a row. */
export function readerOf<T>(spec: ListSpec<T>): ValueReader<T> {
  return spec.read ?? ((row, field) => fieldValue(row, field));
}

/** The row passes the request's schema filters. */
export function matchesWhere<T>(row: T, p: Pick<ListParams, "where">, spec: ListSpec<T>): boolean {
  return !p.where?.length || rowMatches(row, p.where, readerOf(spec));
}

/** Search values: the route's own, else the schema's searchable fields. */
function searchOf<T>(spec: ListSpec<T>): ((row: T) => unknown[]) | undefined {
  if (spec.search) return spec.search;
  const schema = spec.schema;
  if (!schema?.fields.some((f) => f.searchable)) return undefined;
  const read = readerOf(spec);
  return (row) => searchValues(schema, row, read);
}

// ── In-memory pages ─────────────────────────────────────────────────────────

/** Total order on sort keys: blanks first, then numbers, then strings (locale-free, stable). */
export function compareKeys(a: SortValue, b: SortValue): number {
  const blank = (v: SortValue) => v === null || v === undefined || v === "";
  if (blank(a) || blank(b)) return blank(a) && blank(b) ? 0 : blank(a) ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const x = typeof a === "string" ? a.toLowerCase() : String(a);
  const y = typeof b === "string" ? b.toLowerCase() : String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareTuple(a: [SortValue, string], b: [SortValue, string], dir: Dir): number {
  const c = compareKeys(a[0], b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  return dir === "desc" ? -c : c;
}

const idOf = <T>(spec: ListSpec<T>, row: T): string => (spec.id ? spec.id(row) : String((row as { id?: unknown }).id ?? ""));

/** Filter, search, sort and cut one page from rows held in memory. */
export function pageRows<T>(rows: readonly T[], p: ListParams, spec: ListSpec<T>): ListPage<T> & { total: number } {
  const filters = Object.entries(p.filters).map(([k, v]) => [spec.filters?.[k], v] as const).filter(([f]) => !!f);
  const keyOf = spec.sorts[p.sort] ?? spec.sorts[spec.defaultSort];
  const search = searchOf(spec);
  const read = readerOf(spec);
  if (spec.schema && !p.cursor && p.out) p.out.facets = facetCounts(spec.schema, rows, read);
  const matched = rows.filter((r) =>
    filters.every(([f, v]) => f!(r, v)) &&
    (!p.where?.length || rowMatches(r, p.where, read)) &&
    (!p.qTokens.length || !search || matchesQuery(search(r), p.qTokens))
  );
  const keyed = matched.map((r) => ({ r, t: [keyOf(r), idOf(spec, r)] as [SortValue, string] }));
  keyed.sort((a, b) => compareTuple(a.t, b.t, p.dir));
  let start = 0;
  if (p.cursor) {
    const c: [SortValue, string] = [p.cursor.k, p.cursor.id];
    start = keyed.findIndex((x) => compareTuple(x.t, c, p.dir) > 0);
    if (start < 0) start = keyed.length;
  }
  const slice = keyed.slice(start, start + p.limit);
  const hasMore = start + p.limit < keyed.length;
  const last = slice[slice.length - 1];
  return {
    items: slice.map((x) => x.r),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ s: p.sort, d: p.dir, k: last.t[0], id: last.t[1] }) : null,
    total: matched.length,
  };
}

/** Producer over a ready page: yields it in chunks of `chunk`, enriching each chunk on the way out. */
export function pageProducer<T, U = T>(
  page: ListPage<T>,
  enrich?: (chunk: T[], signal: AbortSignal) => Promise<U[]> | U[],
  chunk = 10,
): ListProducer<U> {
  return async function* (signal) {
    for (let i = 0; i < page.items.length; i += chunk) {
      if (signal.aborted) break;
      const part = page.items.slice(i, i + chunk);
      yield enrich ? await enrich(part, signal) : (part as unknown as U[]);
    }
    return { nextCursor: page.nextCursor, hasMore: page.hasMore, total: page.total };
  };
}

/** Transform each batch on its way out (strip fields, add names); the tail passes through. */
export function mapProducer<T, U>(produce: ListProducer<T>, fn: (items: T[], signal: AbortSignal) => Promise<U[]> | U[]): ListProducer<U> {
  return async function* (signal) {
    const it = produce(signal);
    while (true) {
      const n = await it.next();
      if (n.done) return n.value;
      if (signal.aborted) {
        await it.return?.({ nextCursor: null, hasMore: false });
        return { nextCursor: null, hasMore: false };
      }
      yield await fn(n.value, signal);
    }
  };
}

// ── Firestore pages ─────────────────────────────────────────────────────────

export interface NativeQuery {
  collection: string;
  /** Equality filters (the scope: providerId, clientId, status, …). */
  where: Record<string, string | number | boolean>;
  /** Firestore field to order by; rows missing it are not returned, so use required fields. */
  sortField: string;
  /** Search word sent as array-contains on `searchTokens`. */
  token?: string;
}

/** The structured query for one Firestore page. Pure; exported for tests. */
export function buildStructuredQuery(nq: NativeQuery, dir: Dir, after: CursorKey | null, limit: number): Record<string, unknown> {
  const filters: Record<string, unknown>[] = Object.entries(nq.where).map(([field, value]) => ({
    fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFirestoreValue(value) },
  }));
  if (nq.token) {
    filters.push({ fieldFilter: { field: { fieldPath: "searchTokens" }, op: "ARRAY_CONTAINS", value: toFirestoreValue(nq.token) } });
  }
  const direction = dir === "desc" ? "DESCENDING" : "ASCENDING";
  const q: Record<string, unknown> = {
    from: [{ collectionId: nq.collection }],
    orderBy: [
      { field: { fieldPath: nq.sortField }, direction },
      { field: { fieldPath: "__name__" }, direction },
    ],
    limit,
  };
  if (filters.length === 1) q.where = filters[0];
  else if (filters.length > 1) q.where = { compositeFilter: { op: "AND", filters } };
  if (after) {
    q.startAt = {
      values: [toFirestoreValue(after.k ?? null), { referenceValue: documentName(nq.collection, after.id) }],
      before: false,
    };
  }
  return q;
}

export type RunQuery = (collection: string, structured: Record<string, unknown>, signal?: AbortSignal) => Promise<FirestoreDocument[]>;

/**
 * Cursor pages straight from Firestore. Each batch is one runQuery call and is
 * yielded as soon as it arrives. With extra search words or `keep`, rows are
 * filtered in memory and more batches are read (at most MAX_SCAN docs) until
 * the page is full.
 */
export function firestorePages<T extends { id: string }>(
  nq: NativeQuery,
  p: ListParams,
  opts: { keep?: (row: T) => boolean; batchSize?: number; run?: RunQuery } = {},
): ListProducer<T> {
  const run = opts.run ?? runStructuredQuery;
  const [first, ...rest] = p.qTokens;
  const query: NativeQuery = { ...nq, token: first ?? nq.token };
  const inMemory = rest.length > 0 || !!opts.keep;
  const keep = (row: T) =>
    (!rest.length || tokensMatch((row as { searchTokens?: string[] }).searchTokens, rest)) && (!opts.keep || opts.keep(row));
  return async function* (signal) {
    let after = p.cursor;
    let got = 0;
    let scanned = 0;
    let lastScanned: CursorKey | null = null;
    while (!signal.aborted) {
      const want = p.limit - got + 1;
      const size = inMemory ? Math.max(want, Math.min(opts.batchSize ?? 50, MAX_SCAN - scanned)) : want;
      const docs = (await run(nq.collection, buildStructuredQuery(query, p.dir, after, size), signal)) as unknown as T[];
      scanned += docs.length;
      const out: T[] = [];
      let moreMatched = false;
      for (const d of docs) {
        if (got >= p.limit) {
          // Past the page: one more match proves there is a next page.
          if (!inMemory || keep(d)) {
            moreMatched = true;
            break;
          }
          continue;
        }
        lastScanned = { s: p.sort, d: p.dir, k: (d as Record<string, unknown>)[nq.sortField] as SortValue, id: d.id };
        if (!inMemory || keep(d)) {
          out.push(d);
          got++;
        }
      }
      if (out.length) yield out;
      const exhausted = docs.length < size;
      if (moreMatched || (got >= p.limit && !exhausted)) {
        return { nextCursor: lastScanned ? encodeCursor(lastScanned) : null, hasMore: true };
      }
      if (exhausted) return { nextCursor: null, hasMore: false };
      if (scanned >= MAX_SCAN) {
        // Stop scanning; the client asks for the next window with this cursor.
        return { nextCursor: lastScanned ? encodeCursor(lastScanned) : null, hasMore: true };
      }
      after = lastScanned;
    }
    return { nextCursor: null, hasMore: false };
  };
}

/** A Firestore error that means "this query needs an index that is not deployed yet". */
export function isIndexError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  const msg = String((e as Error)?.message ?? "");
  return status === 400 && /index|FAILED_PRECONDITION/i.test(msg) || status === 412 || /FAILED_PRECONDITION/.test(msg);
}

/** Use `primary`; if its first batch fails with a missing index, use `fallback` instead. */
export function withFallback<T>(primary: ListProducer<T>, fallback: () => Promise<ListProducer<T>> | ListProducer<T>, onFallback?: (e: unknown) => void): ListProducer<T> {
  return async function* (signal) {
    const it = primary(signal);
    let first: IteratorResult<T[], ListTail>;
    try {
      first = await it.next();
    } catch (e) {
      if (!isIndexError(e)) throw e;
      onFallback?.(e);
      return yield* (await fallback())(signal);
    }
    if (first.done) return first.value;
    yield first.value;
    while (true) {
      const n = await it.next();
      if (n.done) return n.value;
      yield n.value;
    }
  };
}

// ── Response ────────────────────────────────────────────────────────────────

const qstr = (req: Request, k: string) => str(req.query?.[k]);

export function wantsStream(req: Request): boolean {
  const accept = String(req.headers?.accept ?? "");
  return qstr(req, "stream") === "1" || accept.includes("application/x-ndjson");
}

/** True when the caller speaks this contract; otherwise the route answers in its legacy shape. */
export function isListRequest(req: Request): boolean {
  return wantsStream(req) || qstr(req, "limit") !== "" || qstr(req, "cursor") !== "";
}

/** Internal field never sent to a browser. */
function publicItem<T>(item: T): T {
  if (item && typeof item === "object" && "searchTokens" in (item as object)) {
    const copy = { ...(item as Record<string, unknown>) };
    delete copy.searchTokens;
    return copy as T;
  }
  return item;
}

interface StreamResponse {
  write(chunk: string): boolean;
  flushHeaders?: () => void;
  headersSent?: boolean;
  writableEnded?: boolean;
}

/**
 * Send a list as JSON (all batches collected) or NDJSON (each batch written as
 * it arrives). Stops the producer when the client goes away.
 */
export async function sendList<T>(
  req: Request,
  res: Response,
  produce: ListProducer<T>,
  metaIn: Record<string, unknown> | (() => Record<string, unknown>) = {},
): Promise<void> {
  const ac = new AbortController();
  // A function is read after the first batch, when the page has been built (FILTERS: option counts).
  const metaOf = () => (typeof metaIn === "function" ? metaIn() : metaIn);
  res.on("close", () => ac.abort());
  const it = produce(ac.signal);
  if (!wantsStream(req)) {
    const items: T[] = [];
    let n = await it.next();
    while (!n.done) {
      items.push(...n.value.map(publicItem));
      n = await it.next();
    }
    const tail = n.value;
    res.json({ items, nextCursor: tail.nextCursor, hasMore: tail.hasMore, ...(tail.total !== undefined ? { total: tail.total } : {}), ...metaOf() });
    return;
  }
  // First batch before the headers: an early failure still becomes a normal error response.
  let n = await it.next();
  const out = res as unknown as StreamResponse;
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  out.flushHeaders?.();
  const meta = metaOf();
  if (Object.keys(meta).length) out.write(JSON.stringify({ type: "meta", ...meta }) + "\n");
  try {
    while (!n.done) {
      if (ac.signal.aborted) {
        await it.return?.({ nextCursor: null, hasMore: false });
        return;
      }
      if (n.value.length) out.write(n.value.map((item) => JSON.stringify({ type: "item", item: publicItem(item) })).join("\n") + "\n");
      n = await it.next();
    }
    if (ac.signal.aborted) return;
    const tail = n.value;
    out.write(JSON.stringify({ type: "end", nextCursor: tail.nextCursor, hasMore: tail.hasMore, ...(tail.total !== undefined ? { total: tail.total } : {}) }) + "\n");
  } catch (e) {
    if (!ac.signal.aborted) out.write(JSON.stringify({ type: "error", error: e instanceof Error ? e.message : "The list could not be loaded." }) + "\n");
  }
  if (!out.writableEnded) res.end();
}

/**
 * Parse the params (400 on a bad cursor or sort), build the producer, send it.
 * Routes use this for their paged branch.
 */
export async function respondList<T, U = T>(
  req: Request,
  res: Response,
  spec: ListSpec<T>,
  build: (p: ListParams) => Promise<{ produce: ListProducer<U>; meta?: Record<string, unknown> }> | { produce: ListProducer<U>; meta?: Record<string, unknown> },
): Promise<void> {
  let p: ListParams;
  try {
    p = parseListParams(req.query ?? {}, spec);
  } catch (e) {
    if (e instanceof ListParamError) {
      res.status(400).json({ error: e.message });
      return;
    }
    throw e;
  }
  const { produce, meta } = await build(p);
  const schema = spec.schema;
  if (!schema || p.cursor) return sendList(req, res, produce, meta ?? {});
  await sendList(req, res, produce, () => ({ ...(meta ?? {}), schema: publicSchema(schema, p.out.facets) }));
}
