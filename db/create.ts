import { createDocumentIfAbsent } from "../helper/firestore/firestoreService.ts";

/**
 * Create a document at a fixed id only when it does not exist yet.
 * Resolves true when created, false when the id is already taken.
 * Delegates to the centralized Firestore service.
 */
export default function createIfAbsent(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  return createDocumentIfAbsent(collection, id, data);
}
