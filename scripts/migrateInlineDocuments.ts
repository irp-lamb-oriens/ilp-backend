/**
 * scripts/migrateInlineDocuments.ts
 * ──────────────────────────────────────────────────────────────────────────
 * One-off: move member documents stored inline (base64 `dataBase64` on the
 * `member_documents` doc, the pre-P1 / dev fallback) into the private bucket
 * DOCUMENT_BUCKET through helper/storage.ts, then drop `dataBase64`.
 *
 * For each inline doc: decode → check the bytes are an allowed type → upload
 * to members/<clientId>/<docId> (never overwrites; an object that already
 * exists from an interrupted run is reused) → rewrite the metadata doc with
 * `storage: "gcs"`, `objectName`, `migratedAt`, without `dataBase64`.
 *
 * Idempotent: docs already on GCS are skipped, so it can be re-run.
 * Downloads keep working throughout (readMemberDocument reads either form).
 *
 * Needs DOCUMENT_BUCKET and SERVICE_ACCOUNT_KEY (roles/storage.objectAdmin on
 * the bucket), as the API does.
 *
 * Run (dry run first):
 *   deno run --allow-net --allow-env --allow-read scripts/migrateInlineDocuments.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/migrateInlineDocuments.ts
 *   … --only=<docId>   limit to one document
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import getAll from "../db/getAll.ts";
import replace from "../db/replace.ts";
import { DOCUMENTS_COLLECTION, objectNameFor, putObject, safeId, sniffContentType } from "../helper/storage.ts";

type Doc = Record<string, unknown>;

export interface InlinePlanItem {
  id: string;
  clientId: string;
  objectName: string;
  bytes: Uint8Array;
  contentType: string;
}

export type InlinePlan = {
  move: InlinePlanItem[];
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Pure: which docs to move and why others are skipped. Exported for tests.
 * Skips docs already on GCS, docs without inline data, unsafe ids and bytes
 * that are not an allowed document type.
 */
export function planInlineMigration(docs: Doc[], only?: string): InlinePlan {
  const plan: InlinePlan = { move: [], skipped: [] };
  for (const d of docs) {
    const id = String(d.id ?? "");
    if (only && id !== only) continue;
    if (typeof d.dataBase64 !== "string" || !d.dataBase64) {
      if (d.storage !== "gcs") plan.skipped.push({ id, reason: "no inline data" });
      continue;
    }
    const docId = safeId(id);
    const clientId = safeId(d.clientId);
    if (!docId || !clientId) {
      plan.skipped.push({ id, reason: "unsafe id or clientId" });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(d.dataBase64.replace(/^data:[^,]*,/, "")), (c) => c.charCodeAt(0));
    } catch {
      plan.skipped.push({ id, reason: "base64 could not be decoded" });
      continue;
    }
    const contentType = sniffContentType(bytes);
    if (!contentType) {
      plan.skipped.push({ id, reason: "not an allowed file type (left inline)" });
      continue;
    }
    plan.move.push({ id: docId, clientId, objectName: objectNameFor(clientId, docId), bytes, contentType });
  }
  return plan;
}

/** Pure: the metadata doc after the move (no `id`, no `dataBase64`). Exported for tests. */
export function movedDoc(d: Doc, item: Pick<InlinePlanItem, "objectName" | "bytes" | "contentType">, now: string): Doc {
  const { id: _id, dataBase64: _b, ...rest } = d;
  return { ...rest, storage: "gcs", objectName: item.objectName, contentType: item.contentType, size: item.bytes.length, migratedAt: now };
}

async function main() {
  const DRY = Deno.args.includes("--dry-run") || Deno.args.includes("-n");
  const ONLY = Deno.args.find((a) => a.startsWith("--only="))?.slice(7);
  if (!DRY && !Deno.env.get("DOCUMENT_BUCKET")) {
    console.error("DOCUMENT_BUCKET is not set. Set it (and SERVICE_ACCOUNT_KEY) before migrating.");
    Deno.exit(1);
  }
  const docs = (await getAll(DOCUMENTS_COLLECTION)) as Doc[];
  const plan = planInlineMigration(docs, ONLY);
  console.log(`${DRY ? "[dry-run] " : ""}${docs.length} documents; ${plan.move.length} to move, ${plan.skipped.length} skipped`);
  for (const s of plan.skipped) console.log(`  skip ${s.id}: ${s.reason}`);
  const tally = { moved: 0, reused: 0, errors: 0 };

  for (const item of plan.move) {
    const label = `${DOCUMENTS_COLLECTION}/${item.id} → gs://${Deno.env.get("DOCUMENT_BUCKET") ?? "<DOCUMENT_BUCKET>"}/${item.objectName} (${item.bytes.length} bytes)`;
    if (DRY) {
      console.log(`would move ${label}`);
      continue;
    }
    try {
      try {
        await putObject(item.objectName, item.bytes, item.contentType);
      } catch (err) {
        // 412 = the object already exists (an earlier run uploaded it, then stopped).
        if (!(err instanceof Error && err.message.includes("(412)"))) throw err;
        tally.reused++;
      }
      const d = docs.find((x) => String(x.id) === item.id)!;
      await replace(DOCUMENTS_COLLECTION, item.id, movedDoc(d, item, new Date().toISOString()));
      tally.moved++;
      console.log(`moved ${label}`);
    } catch (err) {
      tally.errors++;
      console.error(`${item.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`${DRY ? "[dry-run] " : ""}done`, tally);
}

if (import.meta.main) await main();
