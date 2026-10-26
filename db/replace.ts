import { replaceDocument } from "../helper/firestore/firestoreService.ts";

/**
 * Full-document replace: fields not in `data` are DELETED. Only for writes
 * that must clear the whole record; use `db/put` (merge) everywhere else.
 */
export default function replace(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  return replaceDocument(collection, id, data);
}
