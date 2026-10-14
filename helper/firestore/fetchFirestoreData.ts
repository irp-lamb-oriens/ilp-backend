import { readDocument } from "./firestoreService.ts";

/**
 * Fetch a single document as plain JS, or null when it does not exist (404).
 * Thin adapter over the centralized Firestore service. Kept for backward
 * compatibility with any historical importers.
 */
export default function fetchFirestoreData(
  collectionName: string,
  docId: string,
): Promise<Record<string, unknown> | null> {
  return readDocument(collectionName, docId);
}