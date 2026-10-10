import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getFirestoreCollectionUrl } from "../helper/firestore/firestoreUrlGetters.ts";
import { toFirestoreDocument } from "../helper/firestore/toFirestoreValue.ts";

/**
 * Create a document with an auto-generated id. Returns the new id.
 */
export default async function post(
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  const url = getFirestoreCollectionUrl(collection);
  const res = await fetchWithAuth(url, {
    method: "POST",
    body: JSON.stringify(toFirestoreDocument(data)),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Firestore create failed (${res.status}): ${body}`);
  }

  const doc = await res.json() as { name: string };
  return doc.name.split("/").pop() ?? "";
}