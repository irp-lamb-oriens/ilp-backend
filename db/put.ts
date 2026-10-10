import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getFirestoreDocumentUrl } from "../helper/firestore/firestoreUrlGetters.ts";
import { toFirestoreDocument } from "../helper/firestore/toFirestoreValue.ts";

/**
 * Full-document replace (PUT). Clears unspecified fields.
 */
export default async function put(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  const url = getFirestoreDocumentUrl(collection, id);
  const res = await fetchWithAuth(url, {
    method: "PUT",
    body: JSON.stringify(toFirestoreDocument(data)),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Firestore put failed (${res.status}) for ${collection}/${id}: ${body}`,
    );
  }
}