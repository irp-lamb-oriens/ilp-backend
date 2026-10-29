/**
 * scripts/seedPlaceholdersFull.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Writes the full placeholder (seed) data set from scripts/placeholderData.ts
 * into Firestore: members, lawyers, memberships, matters, consultations,
 * handoffs, CSM tasks, opportunities, quotes, finance, feedback, consents,
 * privacy requests, documents, audit log … (docs/workstreams/SEED.md).
 *
 * (scripts/seedPlaceholders.ts is the older IRP-era status-page seeder with
 * `isPlaceholder`; this script is separate and uses `placeholder: true`.)
 *
 * Safety:
 *   - every id starts with `ph_` (asserted before each write; the one
 *     exception is the PLACEHOLDER_MEMBER_EMAIL login alias, a `clients` doc
 *     that is refused if a real client already uses that email);
 *   - every document has `placeholder: true` and `placeholderBatch`;
 *   - people use @example.com, +1 555-01xx numbers and PH-… identifiers;
 *   - the server must run the placeholder guards (helper/placeholder.ts)
 *     BEFORE this is run, so no email, push, Calendar or Stripe call is made
 *     for this data;
 *   - a real run needs --confirm-project=<Firestore project id>.
 * Re-running with the same --size/--seed rewrites the same ids (full replace of
 * each placeholder doc) and prunes this batch's docs that the new plan no
 * longer has (the story is re-dated to the new "today"), so a re-run is a reset.
 * Remove everything with scripts/removePlaceholders.ts.
 *
 * Flags:
 *   --size=demo|pilot|large   default pilot (≈60 members over 6 months, 6 lawyers, 4 staff)
 *   --seed=N                  default 7 (same seed → same ids and story)
 *   --batch=<id>              default ph-<size>-<seed>
 *   --dry-run                 counts + 2 sample docs per collection, no writes, no credentials
 *   --config=auto|always|never  catalog collections: auto = only when the collection has no real docs
 *   --with-files              upload a tiny placeholder PDF per document (needs DOCUMENT_BUCKET)
 *   --concurrency=N           parallel writes, default 8
 *   --no-journeys             skip the JOURNEYS data (journey events, daily rows, experiments, outreach)
 *   --no-prune                keep this batch's docs that the new plan no longer contains
 *   --confirm-project=<id>    required for a real run; must equal the service account's project
 * Env:
 *   SERVICE_ACCOUNT_KEY       service-account JSON or a path to it (real run)
 *   PLACEHOLDER_MEMBER_EMAIL  your inbox: one placeholder member you can sign in as (/status)
 *   PLACEHOLDER_LAWYER_EMAIL  your inbox: one placeholder lawyer you can sign in as (/lawyer)
 *   PLACEHOLDER_CSM_EMAIL     your staff inbox: owns part of the placeholder CSM queue
 *   DOCUMENT_BUCKET           private bucket, only with --with-files
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read scripts/seedPlaceholdersFull.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/seedPlaceholdersFull.ts --confirm-project=<id>
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import get from "../db/get.ts";
import replace from "../db/replace.ts";
import remove from "../db/delete.ts";
import getAll from "../db/getAll.ts";
import query from "../db/query.ts";
import { clean } from "../db/records.ts";
import { getProjectId } from "../db/projectId.ts";
import { putObject } from "../helper/storage.ts";
import { assertPlaceholderDoc, assertPlaceholderId, isPlaceholderDoc, isReservedEmail } from "../helper/placeholder.ts";
import { buildPlaceholderData, countDocs, diversityReport, type Doc, readyShare, type SeedData, type SeedSize, SIZES } from "./placeholderData.ts";
import { pool, printTable, selectForDeletion } from "./placeholderOps.ts";
import { addJourneyData } from "./journeyPlaceholderData.ts"; // JOURNEYS

export interface CliOptions {
  size: SeedSize;
  seed: number;
  batch?: string;
  dryRun: boolean;
  config: "auto" | "always" | "never";
  withFiles: boolean;
  concurrency: number;
  prune: boolean;
  /** JOURNEYS: add ~6 weeks of journeys, experiments and outreach (default on; --no-journeys). */
  journeys: boolean;
  confirmProject?: string;
  memberEmail?: string;
  lawyerEmail?: string;
  csmEmail?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArgs(args: string[], env: (k: string) => string | undefined): CliOptions | { error: string } {
  const flag = (name: string) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
  };
  const size = (flag("size") ?? "pilot") as SeedSize;
  if (!(size in SIZES)) return { error: `--size must be demo, pilot or large (got "${size}")` };
  const seed = Number(flag("seed") ?? "7");
  if (!Number.isInteger(seed) || seed < 0) return { error: "--seed must be a whole number" };
  const config = (flag("config") ?? "auto") as CliOptions["config"];
  if (!["auto", "always", "never"].includes(config)) return { error: "--config must be auto, always or never" };
  const concurrency = Math.max(1, Math.min(32, Number(flag("concurrency") ?? "8") || 8));
  const email = (k: string) => {
    const v = env(k)?.trim().toLowerCase();
    return v ? v : undefined;
  };
  const out: CliOptions = {
    size, seed, config, concurrency,
    batch: flag("batch"),
    dryRun: flag("dry-run") === "true" || args.includes("-n"),
    withFiles: flag("with-files") === "true",
    prune: flag("no-prune") !== "true",
    journeys: flag("no-journeys") !== "true",
    confirmProject: flag("confirm-project"),
    memberEmail: email("PLACEHOLDER_MEMBER_EMAIL"),
    lawyerEmail: email("PLACEHOLDER_LAWYER_EMAIL"),
    csmEmail: email("PLACEHOLDER_CSM_EMAIL"),
  };
  for (const [k, v] of [["PLACEHOLDER_MEMBER_EMAIL", out.memberEmail], ["PLACEHOLDER_LAWYER_EMAIL", out.lawyerEmail], ["PLACEHOLDER_CSM_EMAIL", out.csmEmail]] as const) {
    if (v && !EMAIL_RE.test(v)) return { error: `${k} is not an email address` };
  }
  if (out.memberEmail && out.lawyerEmail && out.memberEmail === out.lawyerEmail) {
    return { error: "PLACEHOLDER_MEMBER_EMAIL and PLACEHOLDER_LAWYER_EMAIL must be different inboxes" };
  }
  return out;
}

/** A minimal one-page PDF that says it is a placeholder (≈ 600 bytes). */
export function tinyPdf(title: string): Uint8Array {
  const text = `PLACEHOLDER DOCUMENT - ${title.replace(/[()\\]/g, "")} - not a real record`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function preview(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 117)}...` : v;
  if (Array.isArray(v)) return depth > 2 ? `[${v.length} items]` : v.slice(0, 3).map((x) => preview(x, depth + 1)).concat(v.length > 3 ? [`… +${v.length - 3}`] : []);
  if (v && typeof v === "object") {
    if (depth > 2) return "{…}";
    return Object.fromEntries(Object.entries(v as Doc).map(([k, x]) => [k, preview(x, depth + 1)]));
  }
  return v;
}

/** Every write the seed will make, in order (people first, then records). */
export function plannedWrites(data: SeedData): Array<{ collection: string; id: string; doc: Doc }> {
  const first = ["providers", "lawyer_availability", "clients"];
  const cols = [...first.filter((c) => data.collections[c]), ...Object.keys(data.collections).filter((c) => !first.includes(c)).sort()];
  const out: Array<{ collection: string; id: string; doc: Doc }> = [];
  for (const c of cols) for (const d of data.collections[c]) out.push({ collection: c, id: String(d.id), doc: d });
  for (const s of data.subcollections) for (const d of s.docs) out.push({ collection: s.path, id: String(d.id), doc: d });
  return out;
}

/** The write guard, applied to every planned write before anything is sent. */
export function checkWrites(writes: Array<{ collection: string; id: string; doc: Doc }>, aliasClientId: string | null): void {
  const aliases = new Set(aliasClientId ? [aliasClientId] : []);
  for (const w of writes) {
    assertPlaceholderId(w.collection.includes("/") ? "sub" : w.collection, w.id, aliases);
    assertPlaceholderDoc(w.collection, w.id, w.doc);
  }
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const parsed = parseArgs(args, (k) => Deno.env.get(k));
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const o = parsed;
  const data = buildPlaceholderData({
    size: o.size, seed: o.seed, batch: o.batch, memberEmail: o.memberEmail, lawyerEmail: o.lawyerEmail, csmEmail: o.csmEmail, withFiles: o.withFiles,
  });
  if (o.journeys) addJourneyData(data, { seed: o.seed });
  const writes = plannedWrites(data);
  checkWrites(writes, data.aliasClientId);
  for (const list of Object.values(data.config)) checkWrites(list.map((d) => ({ collection: "config", id: String(d.id), doc: d })), null);

  console.log(`${o.dryRun ? "[dry-run] " : ""}ILP placeholder seed  size=${o.size} seed=${o.seed} batch=${data.batch}  now=${data.now}`);
  if (data.aliasClientId) console.log(`  login member: ${o.memberEmail} (clientId ${data.aliasClientId})`);
  if (o.lawyerEmail) console.log(`  login lawyer: ${o.lawyerEmail} (providerId ph_prov_01)`);
  if (o.csmEmail) console.log(`  CSM queue owner: ${o.csmEmail}`);

  const counts = countDocs(data);
  if (o.dryRun) {
    printTable(counts.map(([k, n]) => [k, n]), ["collection", "docs"]);
    console.log(`  total: ${counts.reduce((s, [, n]) => s + n, 0)} documents; ${data.files.length} files with --with-files; consultation-ready share of active members ${(readyShare(data) * 100).toFixed(0)}%`);
    console.log("\nDiversity report (counts per category):");
    for (const [cat, counts] of diversityReport(data)) {
      console.log(`  ${cat}: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    }
    for (const [col, list] of [...Object.entries(data.collections), ...Object.entries(data.config).map(([k, v]) => [`${k} (config)`, v] as const)]) {
      console.log(`\n── ${col}: 2 of ${list.length}`);
      for (const d of list.slice(0, 2)) console.log(JSON.stringify(preview(d), null, 1));
    }
    return 0;
  }

  // ── Real run: confirm the target, refuse to touch real people ──
  const project = getProjectId();
  if (o.confirmProject !== project) {
    console.error(`This writes ${counts.reduce((s, [, n]) => s + n, 0)} placeholder documents to Firestore project "${project}".`);
    console.error(`Re-run with --confirm-project=${project} once the server with the placeholder guards is deployed.`);
    return 2;
  }
  if (data.aliasClientId) {
    const existing = await get("clients", data.aliasClientId).catch(() => null);
    if (existing && !isPlaceholderDoc(existing)) {
      console.error(`A real client already uses ${o.memberEmail} (clients/${data.aliasClientId}). Choose another PLACEHOLDER_MEMBER_EMAIL.`);
      return 2;
    }
  }
  if (o.lawyerEmail) {
    const real = (await query("providers", [{ field: "email", op: "EQUAL", value: o.lawyerEmail }]).catch(() => []))
      .filter((p) => !isPlaceholderDoc(p));
    if (real.length) {
      console.error(`A real provider already uses ${o.lawyerEmail} (providers/${real[0].id}). Choose another PLACEHOLDER_LAWYER_EMAIL.`);
      return 2;
    }
  }
  for (const e of [o.memberEmail, o.lawyerEmail, o.csmEmail]) {
    if (e && isReservedEmail(e)) console.warn(`  note: ${e} is on a reserved domain, so its sign-in code cannot be delivered.`);
  }

  const done = new Map<string, number>();
  const failed = new Map<string, number>();
  const errors: string[] = [];
  const write = async (w: { collection: string; id: string; doc: Doc }) => {
    const key = w.collection.includes("/") ? `clients/*/${w.collection.split("/").pop()}` : w.collection;
    try {
      // Full replace: every placeholder doc is entirely ours (checked above), and a
      // merge would keep fields an earlier run wrote that this plan no longer has.
      await replace(w.collection, w.id, clean(w.doc));
      done.set(key, (done.get(key) ?? 0) + 1);
    } catch (err) {
      failed.set(key, (failed.get(key) ?? 0) + 1);
      if (errors.length < 10) errors.push(`${w.collection}/${w.id}: ${err instanceof Error ? err.message : err}`);
    }
  };

  // Config / catalog collections: only where no real config exists (unless --config=always).
  const configWrites: Array<{ collection: string; id: string; doc: Doc }> = [];
  const configNote: Array<[string, string]> = [];
  for (const [col, list] of Object.entries(data.config)) {
    if (o.config === "never") {
      configNote.push([col, "skipped (--config=never)"]);
      continue;
    }
    if (o.config === "auto") {
      const docs = await getAll(col).catch(() => []);
      const real = docs.filter((d) => !isPlaceholderDoc(d)).length;
      if (real > 0) {
        configNote.push([col, `skipped: ${real} real docs`]);
        continue;
      }
    }
    configNote.push([col, "seeded"]);
    for (const d of list) configWrites.push({ collection: col, id: String(d.id), doc: d });
  }

  const started = Date.now();
  // People first (so links resolve while the rest is written), then everything else.
  const people = writes.filter((w) => ["providers", "lawyer_availability", "clients"].includes(w.collection));
  const rest = writes.filter((w) => !people.includes(w));
  await pool(people, o.concurrency, write);
  await pool([...rest, ...configWrites], o.concurrency, write);

  // Prune: this batch's docs (ph_ + placeholder: true) that the new plan no longer has.
  let pruned = 0;
  if (o.prune) {
    const planned = new Map<string, Set<string>>();
    for (const w of [...writes, ...configWrites]) {
      (planned.get(w.collection) ?? planned.set(w.collection, new Set()).get(w.collection)!).add(w.id);
    }
    for (const [col, ids] of planned) {
      if (col.includes("/")) continue; // subcollections: stable ids, nothing to prune
      const docs = (await query(col, [{ field: "placeholder", op: "EQUAL", value: true }]).catch(() => [])) as unknown as Doc[];
      const stale = selectForDeletion(col.includes("/") ? "sub" : col, docs, { batch: data.batch }).remove.filter((d) => !ids.has(String(d.id)));
      await pool(stale, o.concurrency, async (d) => {
        try {
          await remove(col, String(d.id));
          pruned++;
        } catch (err) {
          if (errors.length < 10) errors.push(`prune ${col}/${d.id}: ${err instanceof Error ? err.message : err}`);
        }
      });
    }
  }

  // Placeholder files (tiny PDFs) only with --with-files and a bucket.
  let uploaded = 0;
  if (o.withFiles) {
    if (!Deno.env.get("DOCUMENT_BUCKET")) console.warn("  --with-files: DOCUMENT_BUCKET is not set, so no files were uploaded (metadata only).");
    else {
      await pool(data.files, Math.min(4, o.concurrency), async (f) => {
        try {
          await putObject(f.objectName, tinyPdf(f.fileName), "application/pdf");
          uploaded++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/412|exist/i.test(msg)) uploaded++; // already there from an earlier run
          else if (errors.length < 10) errors.push(`file ${f.objectName}: ${msg}`);
        }
      });
    }
  }

  const rows = counts.map(([k, n]) => {
    const key = k.replace(/ \(config\)$/, "");
    return [k, n, done.get(key) ?? 0, failed.get(key) ?? 0] as [string, number, number, number];
  });
  console.log("");
  printTable(rows, ["collection", "planned", "written", "failed"]);
  for (const [c, note] of configNote) console.log(`  config ${c}: ${note}`);
  if (o.withFiles) console.log(`  files uploaded: ${uploaded}/${data.files.length}`);
  if (o.prune) console.log(`  pruned ${pruned} documents of batch ${data.batch} that this run no longer contains.`);
  console.log(`  ${[...done.values()].reduce((s, n) => s + n, 0)} documents written in ${Math.round((Date.now() - started) / 1000)} s.`);
  if (errors.length) {
    console.error("  First errors:");
    for (const e of errors) console.error(`   - ${e}`);
    return 1;
  }
  console.log("  Remove with: deno run --allow-net --allow-env --allow-read scripts/removePlaceholders.ts --confirm-project=" + project);
  return 0;
}

if (import.meta.main) {
  const code = await main();
  if (code) Deno.exit(code);
}
