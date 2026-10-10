import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getFirestoreDocumentUrl } from "../helper/firestore/firestoreUrlGetters.ts";
import { toFirestoreDocument } from "../helper/firestore/toFirestoreValue.ts";

/**
 * Upsert a document at a fixed id using PATCH. Only the provided fields are
 * written. Mirrors IRP-funnel's PATCH-with-updateMask pattern. When
 * `overwrite` is false, existing fields are preserved (field-level merge);
 * when true, the whole doc is replaced with the provided fields.
 */
export default async function patch(
  collection: string,
  id: string,
  data: Record<string, unknown>,
  overwrite = false,
): Promise<void> {
  const keys = Object.keys(data);
  const url = getFirestoreDocumentUrl(collection, id);

  // Firestore REST honors `updateMask` on PATCH. When overwrite is set,
  // omit the mask so all existing fields are cleared and replaced.
  const query =
    keys.length && !overwrite
      ? `?${keys.map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&")}`
      : "";

  const res = await fetchWithAuth(`${url}${query}`, {
    method: "PATCH",
    body: JSON.stringify(toFirestoreDocument(data)),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Firestore patch failed (${res.status}) for ${collection}/${id}: ${body}`,
    );
  }
}