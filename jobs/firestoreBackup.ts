/**
 * jobs/firestoreBackup.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Daily Firestore export (P1), 03:00 Costa Rica time (UTC-6, no DST) =
 * 09:00 UTC, registered in jobs/registry.ts.
 *
 * Calls the Firestore Admin export endpoint
 *   POST https://firestore.googleapis.com/v1/projects/<id>/databases/(default):exportDocuments
 *   { outputUriPrefix: "gs://$BACKUP_BUCKET/<YYYY-MM-DD>" }
 * with the service account's datastore-scoped token, and records the started
 * operation in the `backups` collection. The export itself runs in Google's
 * background; check it with `gcloud firestore operations list`.
 *
 * No-op (one log line) when BACKUP_BUCKET is unset.
 *
 * Setup (once): a bucket in the same region as Firestore, ideally with a
 * lifecycle rule deleting objects after 30-90 days; the API service account
 * needs roles/datastore.importExportAdmin on the project, and the Firestore
 * service agent (service-<PROJECT_NUMBER>@gcp-sa-firestore.iam.gserviceaccount.com)
 * needs roles/storage.admin (or objectAdmin + legacyBucketReader) on the bucket.
 * Restore: `gcloud firestore import gs://$BACKUP_BUCKET/<date>`.
 */

import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getProjectId } from "../db/projectId.ts";
import put from "../db/put.ts";
import log from "../helper/log.ts";
import { reportError } from "../helper/errorReporter.ts";

/** Costa Rica is UTC-6 all year. */
const CR_OFFSET_MS = -6 * 3600_000;

/** Backup folder name: the Costa Rica calendar date. Exported for tests. */
export function backupDate(now = new Date()): string {
  return new Date(now.getTime() + CR_OFFSET_MS).toISOString().slice(0, 10);
}

/** gs:// prefix for a bucket name (accepts "bucket" or "gs://bucket/"). Exported for tests. */
export function outputPrefix(bucket: string, date: string): string {
  const b = bucket.replace(/^gs:\/\//, "").replace(/\/+$/, "");
  return `gs://${b}/${date}`;
}

export async function firestoreBackup(now = new Date()): Promise<{ skipped: true } | { operation: string; outputUriPrefix: string }> {
  const bucket = Deno.env.get("BACKUP_BUCKET");
  if (!bucket) {
    log("[backup] BACKUP_BUCKET is not set: Firestore export skipped", "backup");
    return { skipped: true };
  }
  const date = backupDate(now);
  const outputUriPrefix = outputPrefix(bucket, date);
  const url = `https://firestore.googleapis.com/v1/projects/${getProjectId()}/databases/(default):exportDocuments`;
  try {
    const res = await fetchWithAuth(url, { method: "POST", body: JSON.stringify({ outputUriPrefix }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Firestore export failed (${res.status}): ${text.slice(0, 500)}`);
    const operation = String((JSON.parse(text) as { name?: string }).name ?? "");
    log(`[backup] export started → ${outputUriPrefix} (${operation})`, "backup");
    await put("backups", date, { date, outputUriPrefix, operation, startedAt: new Date().toISOString() }).catch(() => {});
    return { operation, outputUriPrefix };
  } catch (err) {
    await reportError(err, { kind: "job", route: "job firestoreBackup" });
    throw err;
  }
}
