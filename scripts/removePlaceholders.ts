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
 *   --accounts                account seed (scripts/seedAccounts.ts): remove batch ph-accounts-<seed>
 *                             (--seed=N, default 7, or --batch), strip what it added to the REAL
 *                             account docs (placeholderFields) and take its elements out of their
 *                             arrays; real docs are never deleted. Dry run unless --confirm-project.
 * Env: SERVICE_ACCOUNT_KEY; DOCUMENT_BUCKET for placeholder files.
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read scripts/removePlaceholders.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/removePlaceholders.ts --confirm-project=<id> [--include-alias]
 *   deno run --allow-net --allow-env --allow-read scripts/removePlaceholders.ts --accounts [--confirm-project=<id>]
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import query from "../db/query.ts";
import getAll from "../db/getAll.ts";
import remove from "../db/delete.ts";
import { getProjectId } from "../db/projectId.ts";
import { scopedAccessToken } from "../helper/storage.ts";
import { commitFieldWrite } from "../helper/firestore/firestoreService.ts";
import { PLACEHOLDER_PREFIX } from "../helper/placeholder.ts";
import { CLIENT_SUBCOLLECTIONS, PLACEHOLDER_COLLECTIONS, pool, printTable, selectAccountDeletion, type SelectOptions, selectForDeletion } from "./placeholderOps.ts";
import { isEmptyWrite, planRestore } from "./accountSeedOps.ts";

export { CLIENT_SUBCOLLECTIONS, PLACEHOLDER_COLLECTIONS, selectAccountDeletion, selectForDeletion, type SelectOptions } from "./placeholderOps.ts";

type Doc = Record<string, unknown>;

async function deleteObject(objectName: string): Promise<void> {
  const bucket = Deno.env.get("DOCUMENT_BUCKET");
  if (!bucket) throw new Error("DOCUMENT_BUCKET is not set");
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${await scopedAccessToken()}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed (${res.status})`);
}

/** Real docs the account seed may have touched (they carry placeholderAccountBatch). */
const ACCOUNT_DOC_COLLECTIONS = ["clients", "providers", "lawyer_availability", "memberships"] as const;

/** --accounts: remove the account-seed batch and restore the real account docs. Dry run unless confirmed. */
async function accountsCleanup(flag: (n: string) => string | undefined): Promise<number> {
  const batch = flag("batch") ?? `ph-accounts-${Number(flag("seed") ?? "7")}`;
  const concurrency = Math.max(1, Math.min(32, Number(flag("concurrency") ?? "8") || 8));
  const project = getProjectId();
  const confirmed = flag("confirm-project") === project && flag("dry-run") !== "true";
  if (flag("confirm-project") && flag("confirm-project") !== project) {
    console.error(`--confirm-project does not match the service account's project "${project}".`);
    return 2;
  }
  const dry = !confirmed;
  console.log(`${dry ? "[dry-run] " : ""}Removing account seed ${batch} from ${project}${dry ? ` (add --confirm-project=${project} to delete)` : ""}`);
  const errors: string[] = [];
  const flagged = async (col: string) => (await query(col, [{ field: "placeholder", op: "EQUAL", value: true }])) as unknown as Doc[];

  // 1. Real docs: take out what the seed added (fields back to their prior value, ph elements out of arrays).
  const realRows: Array<[string, string, string]> = [];
  const accountClients = new Set<string>();
  for (const col of ACCOUNT_DOC_COLLECTIONS) {
    const docs = (await query(col, [{ field: "placeholderAccountBatch", op: "EQUAL", value: batch }]).catch(() => [])) as unknown as Doc[];
    for (const d of docs) {
      if (d.placeholder === true) continue; // a placeholder doc: deleted below
      if (col === "clients") accountClients.add(String(d.id));
      const w = planRestore(col, String(d.id), d);
      const what = `${Object.keys(w.set).length} restored, ${w.unset.length} removed, ${Object.values(w.remove).reduce((s, l) => s + l.length, 0)} array elements out` +
        (w.kept.length ? `; kept (changed since seed): ${w.kept.join(", ")}` : "");
      realRows.push([col, String(d.id), what]);
      if (dry || isEmptyWrite(w)) continue;
      try {
        await commitFieldWrite(col, String(d.id), w);
      } catch (err) {
        errors.push(`restore ${col}/${d.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // 2. Placeholder docs of the batch (and derived records about its members), clients last.
  const clientDocs = await flagged("clients");
  for (const c of clientDocs) if (c.placeholderBatch === batch) accountClients.add(String(c.id));
  const rows: Array<[string, number, number]> = [];
  for (const sub of CLIENT_SUBCOLLECTIONS) {
    let n = 0;
    for (const cid of accountClients) {
      const path = `clients/${cid}/${sub}`;
      const docs = (await getAll(path).catch(() => [])) as unknown as Doc[];
      const sel = selectAccountDeletion(sub, docs, batch, accountClients);
      n += sel.remove.length;
      if (!dry) await pool(sel.remove, concurrency, async (d) => {
        await remove(path, String(d.id)).catch((err) => errors.push(`${path}/${d.id}: ${err instanceof Error ? err.message : err}`));
      });
    }
    rows.push([`clients/*/${sub}`, n, n]);
  }
  for (const col of PLACEHOLDER_COLLECTIONS) {
    const docs = col === "clients" ? clientDocs : await flagged(col).catch(() => []);
    const sel = selectAccountDeletion(col, docs, batch, accountClients);
    rows.push([col, docs.length, sel.remove.length]);
    if (!dry) await pool(sel.remove, concurrency, async (d) => {
      await remove(col, String(d.id)).catch((err) => errors.push(`${col}/${d.id}: ${err instanceof Error ? err.message : err}`));
    });
  }
  console.log("");
  if (realRows.length) printTable(realRows, ["real doc", "id", dry ? "would restore" : "restored"]);
  else console.log("  no real document carries this batch's placeholderFields.");
  console.log("");
  printTable(rows, ["collection", "flagged", dry ? "would delete" : "deleted"]);
  console.log(`  total ${dry ? "to delete" : "deleted"}: ${rows.reduce((s, r) => s + r[2], 0)} documents; ${realRows.length} real docs ${dry ? "to restore" : "restored"}`);
  if (errors.length) {
    for (const e of errors.slice(0, 10)) console.error(`   - ${e}`);
    return 1;
  }
  return 0;
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const flag = (name: string) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    return hit ? (hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true") : undefined;
  };
  if (flag("accounts") === "true") return accountsCleanup(flag);
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
