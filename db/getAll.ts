import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getFirestoreCollectionUrl } from "../helper/firestore/firestoreUrlGetters.ts";
import { fromFirestoreFields } from "../helper/firestore/fromFirestoreValue.ts";

export interface FirestoreDocument {
  id: string;
  [key: string]: unknown;
}

/**
 * List all documents in a collection. Returns an array of { id, ...fields }.
 */
export default async function getAll(
  collection: string,
): Promise<FirestoreDocument[]> {
  const url = `${getFirestoreCollectionUrl(collection)}?pageSize=1000`;
  const res = await fetchWithAuth(url);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firestore list failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    documents?: Array<{
      name: string;
      fields?: Record<string, unknown>;
    }>;
  };

  return (data.documents ?? []).map((doc) => {
    const id = doc.name.split("/").pop() ?? "";
    return { id, ...(doc.fields ? fromFirestoreFields(doc.fields) : {}) };
  });
}