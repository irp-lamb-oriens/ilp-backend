import {
  queryCollection,
  type FirestoreDocument,
  type QueryFilter,
  type OrderBy,
} from "../helper/firestore/firestoreService.ts";

export type { FirestoreDocument, QueryFilter, OrderBy };

/**
 * Structured query against a collection. Supports equality filters on indexed
 * fields plus optional ordering. Delegates to the centralized Firestore
 * service.
 */
export default function query(
  collection: string,
  filters: QueryFilter[] = [],
  orderBy?: OrderBy,
): Promise<FirestoreDocument[]> {
  return queryCollection(collection, filters, orderBy);
}