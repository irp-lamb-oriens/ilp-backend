/**
 * helper/firestore/firestoreService.ts
 *
 * Centralized Firestore transport service.
 *
 * Every CRUD operation funnels through this module so that URL building,
 * auth, value conversion, error normalization, and logging live in exactly
 * one place. The `db/*.ts` adapters delegate here and keep their stable
 * signatures, so call sites never change.
 *
 * Inspired by the IRP-dashboard-server's single `firestore.ts` service
 * (readDocument / writeDocument / updateDocument / queryCollection /
 * deleteDocument) plus its paginated `listDocuments` helper. Not a migration:
 * the ILP value converters and URL getters are reused as-is.
 */

import fetchWithAuth from "../fetchWithAuth.ts";
import log from "../log.ts";
import {
  getFirestoreCollectionUrl,
  getFirestoreDocumentUrl,
  getFirestoreRunQueryUrl,
} from "./firestoreUrlGetters.ts";
import { toFirestoreDocument, toFirestoreValue } from "./toFirestoreValue.ts";
import { fromFirestoreFields } from "./fromFirestoreValue.ts";

/** A document as returned to callers: Firestore id plus decoded fields. */
export interface FirestoreDocument {
  id: string;
  [key: string]: unknown;
}

/** Equality/range filter for a structured query. */
export interface QueryFilter {
  field: string;
  op:
    | "EQUAL"
    | "NOT_EQUAL"
    | "LESS_THAN"
    | "LESS_THAN_OR_EQUAL"
    | "GREATER_THAN"
    | "GREATER_THAN_OR_EQUAL"
    | "ARRAY_CONTAINS";
  value: unknown;
}

/** Optional ordering for a structured query. */
export interface OrderBy {
  field: string;
  direction?: "ASCENDING" | "DESCENDING";
}

/**
 * Normalized Firestore failure. Every operation throws this same shape so
 * callers and the error detector can classify a fault uniformly.
 */
export class FirestoreError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly target: string,
    body: string,
  ) {
    super(`Firestore ${operation} failed (${status}) for ${target}: ${body}`);
    this.name = "FirestoreError";
  }
}

/**
 * The single request funnel. Attaches auth, normalizes non-2xx responses into
 * a `FirestoreError`, and logs the round trip. No CRUD op bypasses this.
 */
async function firestoreRequest(
  operation: string,
  target: string,
  url: string,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<Response> {
  const started = Date.now();
  const res = await fetchWithAuth(url, init);

  if (!res.ok) {
    // A 404 is a normal "does not exist" signal for read/delete paths, not a
    // fault. Let the caller decide how to handle it instead of throwing here.
    if (allowNotFound && res.status === 404) {
      log(`[FIRESTORE] ${operation} ${target} not found (404)`);
      return res;
    }

    const body = await res.text();
    log(`[FIRESTORE] ${operation} ${target} failed (${res.status}): ${body}`);
    throw new FirestoreError(operation, res.status, target, body);
  }

  log(`[FIRESTORE] ${operation} ${target} (${Date.now() - started}ms)`);
  return res;
}

/**
 * Read a single document by id. Returns null when it does not exist (404).
 */
export async function readDocument(
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const url = getFirestoreDocumentUrl(collection, id);
  const res = await firestoreRequest("GET", `${collection}/${id}`, url, undefined, true);

  if (res.status === 404) return null;

  const data = (await res.json()) as { fields?: Record<string, unknown> };
  return data.fields ? fromFirestoreFields(data.fields) : {};
}

/**
 * Create a document with an auto-generated id. Returns the new id.
 */
export async function createDocument(
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  const url = getFirestoreCollectionUrl(collection);
  const res = await firestoreRequest("create", collection, url, {
    method: "POST",
    body: JSON.stringify(toFirestoreDocument(data)),
  });

  const doc = (await res.json()) as { name: string };
  return doc.name.split("/").pop() ?? "";
}

/**
 * Full-document replace. Firestore REST has no PUT verb; a PATCH without an
 * updateMask replaces the entire document (clearing unspecified fields).
 */
export async function replaceDocument(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const url = getFirestoreDocumentUrl(collection, id);
  await firestoreRequest("put", `${collection}/${id}`, url, {
    method: "PATCH",
    body: JSON.stringify(toFirestoreDocument(data)),
  });
}

/**
 * Quote one top-level key as a Firestore field path. Simple identifiers pass
 * through; anything else is wrapped in backticks with `\` and `` ` `` escaped.
 */
export function fieldPathFor(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? key
    : "`" + key.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + "`";
}

/**
 * Merge write: only the top-level keys in `data` are written (updateMask);
 * every other field on the document is kept. Creates the doc if missing.
 * This is what `db/put` uses, because every caller in the codebase passes
 * partial payloads and expects the rest of the record to survive.
 */
export async function mergeDocument(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(data);
  if (!keys.length) return;
  const url = getFirestoreDocumentUrl(collection, id);
  const query = keys
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(fieldPathFor(k))}`)
    .join("&");
  await firestoreRequest("merge", `${collection}/${id}`, `${url}?${query}`, {
    method: "PATCH",
    body: JSON.stringify(toFirestoreDocument(data)),
  });
}

/**
 * One write to an EXISTING document through `documents:commit`: `set` keys
 * (top-level or dotted paths such as "clientFields.phone") are written,
 * `unset` paths are deleted, and `append` / `remove` add or take out array
 * elements in place (appendMissingElements / removeAllFromArray), so every
 * other field and every other array element stays exactly as stored (types
 * included). Fails when the document does not exist. Used by the account seed
 * (scripts/seedAccounts.ts) and its cleanup to touch real documents.
 */
export async function commitFieldWrite(
  collection: string,
  id: string,
  o: { set?: Record<string, unknown>; unset?: string[]; append?: Record<string, unknown[]>; remove?: Record<string, unknown[]> },
): Promise<void> {
  const url = getFirestoreDocumentUrl(collection, id);
  const name = url.slice(url.indexOf("/projects/") + 1);
  const path = (p: string) => p.split(".").map(fieldPathFor).join(".");
  // Dotted paths in `set` become nested maps in the body; the mask names each path.
  const fields: Record<string, unknown> = {};
  for (const [p, v] of Object.entries(o.set ?? {})) {
    const parts = p.split(".");
    let node = fields;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]] = v;
  }
  const transforms = [
    ...Object.entries(o.append ?? {}).filter(([, v]) => v.length)
      .map(([p, v]) => ({ fieldPath: path(p), appendMissingElements: { values: v.map(toFirestoreValue) } })),
    ...Object.entries(o.remove ?? {}).filter(([, v]) => v.length)
      .map(([p, v]) => ({ fieldPath: path(p), removeAllFromArray: { values: v.map(toFirestoreValue) } })),
  ];
  const write: Record<string, unknown> = {
    update: { name, ...toFirestoreDocument(fields) },
    updateMask: { fieldPaths: [...Object.keys(o.set ?? {}), ...(o.unset ?? [])].map(path) },
    currentDocument: { exists: true },
  };
  if (transforms.length) write.updateTransforms = transforms;
  const commitUrl = `${url.slice(0, url.indexOf("/documents/"))}/documents:commit`;
  await firestoreRequest("commit", `${collection}/${id}`, commitUrl, {
    method: "POST",
    body: JSON.stringify({ writes: [write] }),
  });
}

/**
 * Upsert a document at a fixed id using PATCH. Only the provided fields are
 * written. When `overwrite` is false, existing fields are preserved
 * (field-level merge via updateMask); when true, the whole doc is replaced.
 */
export async function upsertDocument(
  collection: string,
  id: string,
  data: Record<string, unknown>,
  overwrite = false,
): Promise<void> {
  const keys = Object.keys(data);
  const url = getFirestoreDocumentUrl(collection, id);

  const query =
    keys.length && !overwrite
      ? `?${keys
          .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
          .join("&")}`
      : "";

  await firestoreRequest("patch", `${collection}/${id}`, `${url}${query}`, {
    method: "PATCH",
    body: JSON.stringify(toFirestoreDocument(data)),
  });
}

/**
 * Read-modify-write merge. Reads the existing doc, merges the updates, removes
 * null/undefined keys (deletion markers), then writes back. Mirrors the
 * IRP-dashboard-server `updateDocument` semantics.
 */
export async function updateDocument(
  collection: string,
  id: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const existing = await readDocument(collection, id);
  const merged: Record<string, unknown> = { ...(existing || {}), ...updates };

  for (const key of Object.keys(merged)) {
    if (merged[key] === null || merged[key] === undefined) {
      delete merged[key];
    }
  }

  await replaceDocument(collection, id, merged);
}

/**
 * Delete a document. Returns true if it existed, false on 404.
 */
export async function deleteDocument(
  collection: string,
  id: string,
): Promise<boolean> {
  const url = getFirestoreDocumentUrl(collection, id);
  const res = await firestoreRequest("delete", `${collection}/${id}`, url, {
    method: "DELETE",
  }, true);

  if (res.status === 404) return false;
  return true;
}

/**
 * Structured query against a collection. Supports equality filters on indexed
 * fields plus optional ordering. Firestore REST requires a composite index for
 * equality+orderBy combos on different fields.
 */
export async function queryCollection(
  collection: string,
  filters: QueryFilter[] = [],
  orderBy?: OrderBy,
): Promise<FirestoreDocument[]> {
  const structured: Record<string, unknown> = {
    from: [{ collectionId: collection }],
  };

  const where = filters.length
    ? {
        compositeFilter: {
          op: "AND",
          filters: filters.map((f) => ({
            fieldFilter: {
              field: { fieldPath: f.field },
              op: f.op,
              value: toFirestoreValue(f.value),
            },
          })),
        },
      }
    : undefined;

  if (where) structured.where = where;
  if (orderBy) {
    structured.orderBy = [
      {
        field: { fieldPath: orderBy.field },
        direction: orderBy.direction ?? "DESCENDING",
      },
    ];
  }

  return runStructuredQuery(collection, structured);
}

/**
 * Full Firestore resource name of a document, for `__name__` cursors
 * (`startAt` values in a structured query).
 */
export function documentName(collection: string, id: string): string {
  const url = getFirestoreDocumentUrl(collection, id);
  return decodeURIComponent(url.slice(url.indexOf("/projects/") + 1));
}

/**
 * Run a raw structured query (orderBy, startAt, limit included as given) and
 * decode the rows. `signal` aborts the HTTP request (lists stop reading when
 * the client disconnects). Used by helper/listing.ts for cursor pages.
 */
export async function runStructuredQuery(
  collection: string,
  structured: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FirestoreDocument[]> {
  const url = getFirestoreRunQueryUrl();
  const res = await firestoreRequest("query", collection, url, {
    method: "POST",
    body: JSON.stringify({ structuredQuery: structured }),
    signal,
  });

  const results = (await res.json()) as Array<{
    document?: { name: string; fields?: Record<string, unknown> };
  }>;

  const docs: FirestoreDocument[] = [];
  for (const row of results) {
    if (!row.document) continue; // query may return a readTime sentinel row
    const id = row.document.name.split("/").pop() ?? "";
    docs.push({
      id,
      ...(row.document.fields ? fromFirestoreFields(row.document.fields) : {}),
    });
  }
  return docs;
}

/**
 * List every document in a collection, paginating past the 1000-doc page cap.
 * Returns an array of `{ id, ...fields }`.
 */
export async function listDocuments(
  collection: string,
): Promise<FirestoreDocument[]> {
  const out: FirestoreDocument[] = [];
  const pageSize = 1000;
  let pageToken: string | undefined;
  let page = 0;

  do {
    const base = getFirestoreCollectionUrl(collection);
    const url =
      `${base}?pageSize=${pageSize}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");

    const res = await firestoreRequest("list", collection, url);

    const data = (await res.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, unknown> }>;
      nextPageToken?: string;
    };

    for (const doc of data.documents ?? []) {
      const id = doc.name.split("/").pop() ?? "";
      out.push({ id, ...(doc.fields ? fromFirestoreFields(doc.fields) : {}) });
    }

    pageToken = typeof data.nextPageToken === "string"
      ? data.nextPageToken
      : undefined;
    page++;

    // Safety valve — never scan more than ~50k docs unconditionally.
    if (page >= 50) break;
  } while (pageToken);

  return out;
}