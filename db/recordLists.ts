/**
 * db/recordLists.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Cursor pages over the member-loop records (helper/listing.ts contract).
 *
 * A page is read straight from Firestore (orderBy + startAt + limit) when the
 * request matches one of NATIVE's index combos below: the same equality
 * filters, the collection's sort field and direction, and optionally a search
 * word (array-contains on searchTokens). Every combo has a composite index in
 * firestore.indexes.json (test/listing_test.ts checks this). Anything else,
 * or a combo whose index is not deployed yet, is paged in memory over the
 * equality-filtered records, as the lists worked before.
 */

import { findRecords, recordSearchValues, type RecordCollection } from "./records.ts";
import {
  type Dir,
  firestorePages,
  type ListParams,
  type ListProducer,
  type ListSpec,
  pageProducer,
  pageRows,
  withFallback,
} from "../helper/listing.ts";
import log from "../helper/log.ts";

type Doc = Record<string, unknown> & { id: string };

export interface NativeCombo {
  /** Equality fields, sorted. */
  eq: string[];
  dir: Dir;
  /** With a search word (array-contains on searchTokens). */
  q: boolean;
}

export interface NativeConfig {
  /** A field every record of the collection has (Firestore drops rows without the orderBy field). */
  sortField: string;
  combos: NativeCombo[];
}

const both = (eq: string[], dir: Dir): NativeCombo[] => [{ eq, dir, q: false }, { eq, dir, q: true }];

/** Index-backed list shapes. Obligations are absent: dueAt is optional, so they always page in memory. */
export const NATIVE: Partial<Record<RecordCollection, NativeConfig>> = {
  csm_tasks: {
    sortField: "dueAt",
    combos: [...both(["status"], "asc"), ...both(["ownerEmail", "status"], "asc"), ...both(["clientId"], "asc")],
  },
  matters: {
    sortField: "stageEnteredAt",
    combos: [...both(["assignedProviderId"], "asc"), ...both(["assignedProviderId", "stage"], "asc"), ...both(["clientId"], "asc"), ...both([], "asc")],
  },
  consultations: {
    sortField: "scheduledAt",
    combos: [...both(["providerId"], "asc"), ...both(["clientId"], "desc"), ...both(["clientId"], "asc")],
  },
  handoffs: {
    sortField: "approvedAt",
    combos: [...both(["providerId"], "desc"), ...both(["clientId"], "desc")],
  },
  leads: {
    sortField: "createdAt",
    combos: [...both([], "desc"), ...both(["country"], "desc")],
  },
  memberships: {
    sortField: "createdAt",
    combos: [...both([], "desc"), ...both(["status"], "desc"), ...both(["clientId"], "desc")],
  },
};

/** The combo a request matches, or null. */
export function nativeCombo(collection: RecordCollection, sort: string, dir: Dir, eqKeys: string[], hasQuery: boolean): NativeCombo | null {
  const cfg = NATIVE[collection];
  if (!cfg || sort !== cfg.sortField) return null;
  const want = [...eqKeys].sort().join(",");
  return cfg.combos.find((c) => c.dir === dir && c.q === hasQuery && [...c.eq].sort().join(",") === want) ?? null;
}

/** ListSpec for a record list: sorts on the given fields, equality filters, search on SEARCH_FIELDS. */
export function recordSpec<T extends Doc>(
  collection: RecordCollection,
  o: {
    sorts: string[];
    defaultSort: string;
    defaultDir?: Dir;
    /** Query keys that filter by equality on the field of the same name. */
    eqFilters?: string[];
    /** Extra predicates (open, from, to, …). */
    filters?: Record<string, (row: T, value: string) => boolean>;
  },
): ListSpec<T> {
  const filters: Record<string, (row: T, value: string) => boolean> = {};
  for (const k of o.eqFilters ?? []) filters[k] = (row, v) => String(row[k] ?? "") === v;
  Object.assign(filters, o.filters ?? {});
  return {
    sorts: Object.fromEntries(o.sorts.map((f) => [f, (row: T) => row[f] as string | number | null | undefined])),
    defaultSort: o.defaultSort,
    defaultDir: o.defaultDir,
    filters,
    search: (row) => recordSearchValues(collection, row),
  };
}

/** Common non-equality filters: open (no closedAt), from / to on a date field. */
export function rangeFilters<T extends Doc>(dateField: string): Record<string, (row: T, value: string) => boolean> {
  return {
    open: (row, v) => (v === "1" ? !row.closedAt : true),
    from: (row, v) => String(row[dateField] ?? "") >= v,
    to: (row, v) => String(row[dateField] ?? "") <= v,
  };
}

/**
 * One page of records. `scope` is the caller's fixed equality scope (clientId
 * for a member, providerId for a lawyer); it always applies and a cursor can
 * never widen it. Request filters that are equality filters join the scope
 * in the Firestore query; the rest filter in memory.
 */
export function pageRecords<T extends Doc>(
  collection: RecordCollection,
  scope: Record<string, string>,
  p: ListParams,
  spec: ListSpec<T>,
  eqFilterKeys: string[] = [],
): ListProducer<T> {
  const where: Record<string, string> = { ...scope };
  const others: ListParams["filters"] = {};
  for (const [k, v] of Object.entries(p.filters)) {
    if (eqFilterKeys.includes(k) && !(k in scope)) where[k] = v;
    else if (!(k in scope)) others[k] = v;
  }
  const memory = async (): Promise<ListProducer<T>> => {
    const rows = await findRecords<T>(collection, where);
    return pageProducer(pageRows(rows, { ...p, filters: others }, spec));
  };
  const combo = nativeCombo(collection, p.sort, p.dir, Object.keys(where), p.qTokens.length > 0);
  if (!combo) {
    return async function* (signal) {
      return yield* (await memory())(signal);
    };
  }
  const otherPreds = Object.entries(others).map(([k, v]) => [spec.filters?.[k], v] as const).filter(([f]) => !!f);
  const keep = otherPreds.length ? (row: T) => otherPreds.every(([f, v]) => f!(row, v)) : undefined;
  return withFallback(
    firestorePages<T>({ collection, where, sortField: NATIVE[collection]!.sortField }, p, { keep }),
    memory,
    () => log(`[lists] ${collection}: index for (${Object.keys(where).join(", ")}${p.qTokens.length ? ", searchTokens" : ""}) not ready, paging in memory`),
  );
}
