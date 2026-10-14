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

/**
 * The database-level `runQuery` endpoint. Structured queries are POSTed here
 * with the target collection named in the `from` clause of the body, NOT in
 * the URL path. Appending `:runQuery` to a collection URL (e.g.
 * `.../documents/email_queue:runQuery`) makes Firestore parse the request as a
 * document write, which is the source of the "Unknown name structuredQuery at
 * 'document'" 400.
 */
export function getFirestoreRunQueryUrl(): string {
  return `${FIRESTORE_BASE}/projects/${getProjectId()}/databases/(default)/documents:runQuery`;
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