import { createDocument } from "../helper/firestore/firestoreService.ts";

/**
 * Create a document with an auto-generated id. Returns the new id.
 * Delegates to the centralized Firestore service.
 */
export default function post(
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  return createDocument(collection, data);
}