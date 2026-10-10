import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getFirestoreDocumentUrl } from "../helper/firestore/firestoreUrlGetters.ts";

/**
 * Delete a document. Returns true if it existed, false on 404.
 */
export default async function remove(
  collection: string,
  id: string,
): Promise<boolean> {
  const url = getFirestoreDocumentUrl(collection, id);
  const res = await fetchWithAuth(url, { method: "DELETE" });

  if (res.status === 404) return false;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Firestore delete failed (${res.status}) for ${collection}/${id}: ${body}`,
    );
  }
  return true;
}