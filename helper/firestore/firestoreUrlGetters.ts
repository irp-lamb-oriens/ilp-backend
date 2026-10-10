import { getProjectId } from "../../db/projectId.ts";

const FIRESTORE_BASE = "https://firestore.googleapis.com/v1";

/** Root of a collection, e.g. .../projects/{pid}/databases/(default)/documents/users */
export function getFirestoreCollectionUrl(collectionName: string): string {
  return `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/(default)/documents/${collectionName}`;
}

/** A single document URL (no document id appended in the path for PATCH-upsert). */
export function getFirestoreDocumentUrl(
  collectionName: string,
  docId: string,
): string {
  const safeId = encodeURIComponent(docId);
  return `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/(default)/documents/${collectionName}/${safeId}`;
}

/** Subcollection document URL. */
export function getFirestoreSubcollectionDocUrl(
  collectionName: string,
  docId: string,
  subcollectionName: string,
  subDocId: string,
): string {
  const safeDoc = encodeURIComponent(docId);
  const safeSub = encodeURIComponent(subDocId);
  return `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/(default)/documents/${collectionName}/${safeDoc}/${subcollectionName}/${safeSub}`;
}