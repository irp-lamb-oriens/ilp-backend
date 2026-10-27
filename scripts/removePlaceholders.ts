/**
 * scripts/removePlaceholders.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Deletes the placeholder (seed) data written by scripts/seedPlaceholdersFull.ts
 * and the records the app derived from it (tasks, bookings … stamped by
 * db/records.ts and API/members/events.ts). See docs/workstreams/SEED.md.
 *
 * A document is deleted only when BOTH hold:
 *   - `placeholder === true`, and
 *   - its id starts with `ph_`
 * (with --include-alias, also the login-alias member's `clients` doc, which is
 * marked `placeholderAlias: true`, and placeholder-flagged records that belong
 * to that alias client). Anything else is never touched, even if it carries
 * the flag; such documents are counted under "kept".
 * Subcollections (clients/<id>/pricing_requests, quoteRequests) of placeholder
 * clients and placeholder files in DOCUMENT_BUCKET (members/<clientId>/ph_…)
 * go first, then the records, then the client docs.
 *
 * Flags:
 *   --dry-run                 list counts, delete nothing (still reads Firestore)
 *   --batch=<id>              only documents with this placeholderBatch (e.g. ph-pilot-7, or "derived")
 *   --include-alias           also remove the PLACEHOLDER_MEMBER_EMAIL member and its flagged records
 *   --concurrency=N           parallel deletes, default 8
 *   --confirm-project=<id>    required unless --dry-run
 * Env: SERVICE_ACCOUNT_KEY; DOCUMENT_BUCKET for placeholder files.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read scripts/removePlaceholders.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/removePlaceholders.ts --confirm-project=<id> [--include-alias]
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import query from "../db/query.ts";
import getAll from "../db/getAll.ts";
import remove from "../db/delete.ts";
import { getProjectId } from "../db/projectId.ts";
import { scopedAccessToken } from "../helper/storage.ts";
import { isPlaceholderId, PLACEHOLDER_PREFIX } from "../helper/placeholder.ts";
import { pool, printTable } from "./seedPlaceholdersFull.ts";

type Doc = Record<string, unknown>;

/** Every collection the seed (or the app, for seed members) can write placeholder docs to. */
export const PLACEHOLDER_COLLECTIONS = [
  "providers", "lawyer_availability", "leads", "memberships", "matters", "consultations", "handoffs", "csm_tasks",
  "obligations", "opportunities", "funnel_events", "member_feedback", "consents", "privacy_requests",
  "member_documents", "audit_log", "quoteSettlements", "financeLedger", "invoices",
  "quote_service_types", "quote_labels", "quote_line_templates", "quote_templates", "vendors", "posts", "updates",
  "clients", // last: subcollections and records first
] as const;
export const CLIENT_SUBCOLLECTIONS = ["pricing_requests", "quoteRequests"] as const;

export interface SelectOptions {
  batch?: string;
  includeAlias?: boolean;
  /** Client ids of login-alias placeholder members (clients docs with placeholderAlias: true). */
  aliasClientIds?: ReadonlySet<string>;
}

/**
 * Pure: which of these documents may be deleted. A document must carry
 * `placeholder: true` AND have a ph_ id; the alias exceptions apply only with
 * includeAlias. Exported for tests.
 */
export function selectForDeletion(collection: string, docs: Doc[], o: SelectOptions = {}): { remove: Doc[]; kept: Doc[] } {
  const out = { remove: [] as Doc[], kept: [] as Doc[] };
  for (const d of docs) {
    if (d.placeholder !== true) continue; // not ours: not even counted
    if (o.batch && d.placeholderBatch !== o.batch) continue;
    const id = String(d.id ?? "");
    const ok = isPlaceholderId(id) ||
      (!!o.includeAlias && collection === "clients" && d.placeholderAlias === true) ||
      (!!o.includeAlias && collection !== "clients" && typeof d.clientId === "string" && !!o.aliasClientIds?.has(d.clientId));
    (ok ? out.remove : out.kept).push(d);
  }
  return out;
}

async function deleteObject(objectName: string): Promise<void> {
  const bucket = Deno.env.get("DOCUMENT_BUCKET");
  if (!bucket) throw new Error("DOCUMENT_BUCKET is not set");
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${await scopedAccessToken()}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed (${res.status})`);
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const flag = (name: string) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    return hit ? (hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true") : undefined;
  };
  const dry = flag("dry-run") === "true";
  const o: SelectOptions = { batch: flag("batch"), includeAlias: flag("include-alias") === "true" };
  const concurrency = Math.max(1, Math.min(32, Number(flag("concurrency") ?? "8") || 8));
  const project = getProjectId();
  if (!dry && flag("confirm-project") !== project) {
    console.error(`This deletes placeholder documents in Firestore project "${project}". Re-run with --confirm-project=${project} (or --dry-run first).`);
    return 2;
  }
  console.log(`${dry ? "[dry-run] " : ""}Removing placeholder data from ${project}${o.batch ? ` (batch ${o.batch})` : ""}${o.includeAlias ? " incl. login alias" : ""}`);

  const flagged = async (col: string) =>
    (await query(col, [{ field: "placeholder", op: "EQUAL", value: true }])) as unknown as Doc[];

  // Placeholder clients (and alias ids) decide the subcollections to clear.
  const clientDocs = await flagged("clients");
  o.aliasClientIds = new Set(clientDocs.filter((c) => c.placeholderAlias === true).map((c) => String(c.id)));
  const clientSel = selectForDeletion("clients", clientDocs, o);

  const rows: Array<[string, number, number, number]> = [];
  const errors: string[] = [];
  let failed = 0;
  const del = (col: string) => async (d: Doc) => {
    try {
      if (!dry) await remove(col, String(d.id));
    } catch (err) {
      failed++;
      if (errors.length < 10) errors.push(`${col}/${d.id}: ${err instanceof Error ? err.message : err}`);
    }
  };

  // 1. Subcollections of placeholder clients.
  for (const sub of CLIENT_SUBCOLLECTIONS) {
    let found = 0;
    let removed = 0;
    let kept = 0;
    for (const c of clientSel.remove) {
      const path = `clients/${c.id}/${sub}`;
      const docs = (await getAll(path).catch(() => [])) as unknown as Doc[];
      const sel = selectForDeletion(sub, docs, { ...o, includeAlias: false });
      found += docs.length;
      kept += sel.kept.length + docs.filter((d) => d.placeholder !== true).length;
      await pool(sel.remove, concurrency, del(path));
      removed += sel.remove.length;
    }
    rows.push([`clients/*/${sub}`, found, removed, kept]);
  }

  // 2. Files of placeholder documents, then every collection (clients last).
  let files = 0;
  for (const col of PLACEHOLDER_COLLECTIONS) {
    // Repeat until nothing deletable is left (a page can grow while we work).
    let found = 0;
    let removed = 0;
    let kept = 0;
    for (let round = 0; round < 20; round++) {
      const docs = col === "clients" && round === 0 ? clientDocs : await flagged(col).catch(() => []);
      const sel = selectForDeletion(col, docs, o);
      if (round === 0) {
        found = docs.length;
        kept = sel.kept.length;
      }
      if (!sel.remove.length) break;
      if (col === "member_documents") {
        const withFile = sel.remove.filter((d) => typeof d.objectName === "string" && String(d.objectName).startsWith("members/") &&
          String(d.objectName).split("/").pop()!.startsWith(PLACEHOLDER_PREFIX));
        if (withFile.length && !Deno.env.get("DOCUMENT_BUCKET")) {
          console.warn(`  ${withFile.length} placeholder files: DOCUMENT_BUCKET is not set, files not deleted (documents are).`);
        } else {
          await pool(withFile, 4, async (d) => {
            try {
              if (!dry) await deleteObject(String(d.objectName));
              files++;
            } catch (err) {
              if (errors.length < 10) errors.push(`file ${d.objectName}: ${err instanceof Error ? err.message : err}`);
            }
          });
        }
      }
      await pool(sel.remove, concurrency, del(col));
      removed += sel.remove.length;
      if (dry) break;
    }
    rows.push([col, found, removed, kept]);
  }

  console.log("");
  printTable(rows, ["collection", "flagged", dry ? "would delete" : "deleted", "kept"]);
  console.log(`  files ${dry ? "to delete" : "deleted"}: ${files}`);
  console.log(`  total ${dry ? "to delete" : "deleted"}: ${rows.reduce((s, r) => s + r[2], 0)} documents${failed ? `, ${failed} failed` : ""}`);
  console.log("  \"kept\" = flagged placeholder but not deletable by the rules (no ph_ id; the login alias needs --include-alias).");
  if (errors.length) {
    for (const e of errors) console.error(`   - ${e}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const code = await main();
  if (code) Deno.exit(code);
}
