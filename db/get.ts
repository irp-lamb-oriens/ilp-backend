import fetchFirestoreData from "../helper/firestore/fetchFirestoreData.ts";

/**
 * Read a single document by id. Returns null when missing.
 */
export default function get(collection: string, id: string) {
  return fetchFirestoreData(collection, id);
}