import { mergeDocument } from "../helper/firestore/firestoreService.ts";

/**
 * Write the given top-level fields to a document, keeping every other field.
 * Creates the document if it does not exist.
 *
 * Historically this was a full replace (PATCH without updateMask), but every
 * caller passes partial payloads (e.g. `{ notes }`, `{ [field]: thread }`), so
 * each write silently wiped the rest of the record. It now merges. Use
 * `db/replace.ts` when a full replace is really intended.
 */
export default function put(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  return mergeDocument(collection, id, data);
}
