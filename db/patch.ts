import { upsertDocument } from "../helper/firestore/firestoreService.ts";

/**
 * Upsert a document at a fixed id using PATCH. Only the provided fields are
 * written. When `overwrite` is false, existing fields are preserved
 * (field-level merge); when true, the whole doc is replaced with the provided
 * fields. Delegates to the centralized Firestore service.
 */
export default function patch(
  collection: string,
  id: string,
  data: Record<string, unknown>,
  overwrite = false,
): Promise<void> {
  return upsertDocument(collection, id, data, overwrite);
}