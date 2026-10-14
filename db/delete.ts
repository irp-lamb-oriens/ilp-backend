import { deleteDocument } from "../helper/firestore/firestoreService.ts";

/**
 * Delete a document. Returns true if it existed, false on 404.
 * Delegates to the centralized Firestore service.
 */
export default function remove(
  collection: string,
  id: string,
): Promise<boolean> {
  return deleteDocument(collection, id);
}