import fetchWithAuth from "../fetchWithAuth.ts";
import { getFirestoreDocumentUrl } from "./firestoreUrlGetters.ts";
import { fromFirestoreFields } from "./fromFirestoreValue.ts";

/**
 * Fetch a single document as plain JS, or null when it does not exist (404).
 */
export default async function fetchFirestoreData(
  collectionName: string,
  docId: string,
): Promise<Record<string, unknown> | null> {
  const url = getFirestoreDocumentUrl(collectionName, docId);
  const res = await fetchWithAuth(url);

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Firestore GET failed (${res.status}) for ${collectionName}/${docId}: ${body}`,
    );
  }

  const data = await res.json() as
    { fields?: Record<string, unknown> };
  return data.fields ? fromFirestoreFields(data.fields) : {};
}