import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getFirestoreCollectionUrl } from "../helper/firestore/firestoreUrlGetters.ts";
import { fromFirestoreFields } from "../helper/firestore/fromFirestoreValue.ts";
import { toFirestoreValue } from "../helper/firestore/toFirestoreValue.ts";
import type { FirestoreDocument } from "./getAll.ts";

/**
 * Structured query against a collection. Supports equality filters
 * on indexed fields plus optional ordering. Firestore REST requires a
 * composite index for equality+orderBy combos on different fields.
 *
 * Example:
 *   query("profiles", [{ field: "country", op: "EQUAL", value: "CR" }])
 */
export interface QueryFilter {
  field: string;
  op: "EQUAL" | "NOT_EQUAL" | "LESS_THAN" | "LESS_THAN_OR_EQUAL" |
    "GREATER_THAN" | "GREATER_THAN_OR_EQUAL" | "ARRAY_CONTAINS";
  value: unknown;
}

export default async function query(
  collection: string,
  filters: QueryFilter[] = [],
  orderBy?: { field: string; direction?: "ASCENDING" | "DESCENDING" },
): Promise<FirestoreDocument[]> {
  const structured: Record<string, unknown> = {};

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
    structured.orderBy = [{
      field: { fieldPath: orderBy.field },
      direction: orderBy.direction ?? "DESCENDING",
    }];
  }

  const url = getFirestoreCollectionUrl(collection) + ":runQuery";
  const res = await fetchWithAuth(url, {
    method: "POST",
    body: JSON.stringify({ structuredQuery: structured }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firestore query failed (${res.status}): ${body}`);
  }

  const results = await res.json() as Array<{
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