import {
  listDocuments,
  type FirestoreDocument,
} from "../helper/firestore/firestoreService.ts";

export type { FirestoreDocument };

/**
 * List all documents in a collection. Returns an array of { id, ...fields }.
 * Delegates to the centralized Firestore service (paginated past 1000 docs).
 */
export default function getAll(
  collection: string,
): Promise<FirestoreDocument[]> {
  return listDocuments(collection);
}