/**
 * scripts/backfillSearchTokens.ts
 * ──────────────────────────────────────────────────────────────────────────
 * One-off (LISTS): write `searchTokens` on every member-loop record created
 * before db/records.ts started keeping them. Paged lists search with
 * array-contains on that field, so a record without it never matches a
 * search until this runs.
 *
 * Idempotent: a record whose stored tokens already equal the computed ones is
 * skipped, so it can be re-run at any time (also after changing SEARCH_FIELDS).
 * Only `searchTokens` is written (field-mask merge); nothing else changes.
 *
 * Run (dry run first):
 *   deno run --allow-net --allow-env --allow-read scripts/backfillSearchTokens.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/backfillSearchTokens.ts
 *   … --only=<collection>   one collection (leads, memberships, matters, consultations, handoffs, csm_tasks, obligations)
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import getAll from "../db/getAll.ts";
import patch from "../db/patch.ts";
import { RECORD_COLLECTIONS, recordSearchTokens, type RecordCollection } from "../db/records.ts";

type Doc = Record<string, unknown> & { id: string };

export interface TokenPlan {
  update: Array<{ id: string; searchTokens: string[] }>;
  unchanged: number;
}

const same = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/** Pure: which docs need new tokens. Exported for tests. */
export function planSearchTokens(collection: RecordCollection, docs: Doc[]): TokenPlan {
  const plan: TokenPlan = { update: [], unchanged: 0 };
  for (const d of docs) {
    if (!d || typeof d.id !== "string") continue;
    const tokens = recordSearchTokens(collection, d);
    if (same(d.searchTokens, tokens)) plan.unchanged++;
    else plan.update.push({ id: d.id, searchTokens: tokens });
  }
  return plan;
}

async function main() {
  const dry = Deno.args.includes("--dry-run");
  const only = Deno.args.find((a) => a.startsWith("--only="))?.slice(7);
  const targets = only ? RECORD_COLLECTIONS.filter((c) => c === only) : RECORD_COLLECTIONS;
  if (only && !targets.length) {
    console.error(`Unknown collection "${only}". Use one of: ${RECORD_COLLECTIONS.join(", ")}`);
    Deno.exit(1);
  }
  let written = 0;
  for (const collection of targets) {
    const docs = (await getAll(collection)) as Doc[];
    const plan = planSearchTokens(collection, docs);
    console.log(`${collection}: ${docs.length} records, ${plan.update.length} to update, ${plan.unchanged} already current`);
    if (dry) continue;
    for (let i = 0; i < plan.update.length; i += 20) {
      const batch = plan.update.slice(i, i + 20);
      await Promise.all(batch.map((u) => patch(collection, u.id, { searchTokens: u.searchTokens })));
      written += batch.length;
    }
  }
  console.log(dry ? "Dry run: nothing written." : `Done: ${written} records updated.`);
}

if (import.meta.main) await main();
