import { readDocument } from "../helper/firestore/firestoreService.ts";

/**
 * Read a single document by id. Returns null when missing.
 * Delegates to the centralized Firestore service.
 */
export default function get(collection: string, id: string) {
  return readDocument(collection, id);
}