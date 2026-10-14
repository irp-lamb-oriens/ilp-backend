import { replaceDocument } from "../helper/firestore/firestoreService.ts";

/**
 * Full-document replace (PUT). Clears unspecified fields.
 * Delegates to the centralized Firestore service.
 */
export default function put(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  return replaceDocument(collection, id, data);
}