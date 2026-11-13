/**
 * scripts/auditSeedData.ts — read-only check that no seed / placeholder data is left.
 * ──────────────────────────────────────────────────────────────────────────
 * Walks EVERY root collection in the project (listCollectionIds, not a fixed
 * list), plus every subcollection under every `clients` doc, and counts docs
 * carrying any seed marker used by the scripts in this folder:
 *   placeholder == true   (seedPlaceholdersFull, seedAccounts, seedCsmBooks)
 *   isPlaceholder == true (seedPlaceholders, IRP-era)
 *   seed == true          (seedDemo, seedLawyer, seedClient, seedTestData, seedPabloAndAdmin)
 *   id starts with ph_ or demo_
 * Deletes nothing. Exit code 1 if anything is found.
 *
 * Run: deno run -A scripts/auditSeedData.ts [--ids]   (--ids prints the doc paths)
 */
import { loadSync } from "dotenv/mod.ts";
loadSync({ export: true, allowEmptyValues: true, examplePath: null });
import fetchWithAuth from "../helper/fetchWithAuth.ts";
import { getProjectId } from "../db/projectId.ts";

const ROOT = `projects/${getProjectId()}/databases/(default)/documents`;
const API = `https://firestore.googleapis.com/v1/${ROOT}`;
const showIds = Deno.args.includes("--ids");

async function call(url: string, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithAuth(url, { method: "POST", body: JSON.stringify(body) });
    if (res.ok) return await res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    throw new Error(`${res.status} ${text.slice(0, 300)}`); // fail loudly: never report "clean" on an error
  }
}

async function collectionIds(parent: string): Promise<string[]> {
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const r = await call(`https://firestore.googleapis.com/v1/${parent}:listCollectionIds`, { pageSize: 300, pageToken });
    out.push(...(r.collectionIds ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/** Keys-only query under `parent` (a ROOT-relative doc path, or "" for root). */
async function names(parent: string, collectionId: string, where?: unknown): Promise<string[]> {
  const url = `https://firestore.googleapis.com/v1/${ROOT}${parent ? "/" + parent : ""}:runQuery`;
  const out: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const q: any = {
      from: [{ collectionId }],
      select: { fields: [{ fieldPath: "__name__" }] },
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit: 1000,
    };
    if (where) q.where = where;
    if (startAfter) q.startAt = { values: [{ referenceValue: startAfter }], before: false };
    const rows = await call(url, { structuredQuery: q });
    const page = rows.filter((r: any) => r.document).map((r: any) => r.document.name as string);
    out.push(...page);
    if (page.length < 1000) return out;
    startAfter = page[page.length - 1];
  }
}

const eq = (field: string) => ({ fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { booleanValue: true } } });
const prefix = (parent: string, col: string, p: string) => {
  const base = `${ROOT}${parent ? "/" + parent : ""}/${col}/`;
  return {
    compositeFilter: {
      op: "AND",
      filters: [
        { fieldFilter: { field: { fieldPath: "__name__" }, op: "GREATER_THAN_OR_EQUAL", value: { referenceValue: base + p } } },
        { fieldFilter: { field: { fieldPath: "__name__" }, op: "LESS_THAN", value: { referenceValue: base + p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1) } } },
      ],
    },
  };
};

const MARKERS = ["placeholder", "isPlaceholder", "seed"] as const;
const PREFIXES = ["ph_", "demo_"] as const;

async function audit(parent: string, col: string): Promise<{ path: string; hits: Record<string, string[]>; total: number }> {
  const hits: Record<string, string[]> = {};
  for (const m of MARKERS) hits[`${m}=true`] = await names(parent, col, eq(m));
  for (const p of PREFIXES) hits[`id ${p}*`] = await names(parent, col, prefix(parent, col, p));
  const total = new Set(Object.values(hits).flat()).size;
  return { path: parent ? `${parent}/${col}` : col, hits, total };
}

console.log(`Auditing ${getProjectId()} for seed / placeholder data (read-only)…`);
const results: Awaited<ReturnType<typeof audit>>[] = [];
const roots = (await collectionIds(ROOT)).sort();
for (const col of roots) results.push(await audit("", col));

// Subcollections under every clients doc (the only parent the app nests under).
let subs = 0;
if (roots.includes("clients")) {
  for (const name of await names("", "clients")) {
    const docPath = name.slice(ROOT.length + 1);
    for (const sub of await collectionIds(name)) {
      subs++;
      const r = await audit(docPath, sub);
      if (r.total) results.push(r);
    }
  }
}

const dirty = results.filter((r) => r.total);
console.log(`\n${roots.length} root collections and ${subs} client subcollections checked.\n`);
if (!dirty.length) {
  console.log("CLEAN: no document has placeholder/isPlaceholder/seed = true or a ph_/demo_ id.");
  Deno.exit(0);
}
console.log("collection".padEnd(48) + MARKERS.map((m) => `${m}=true`.padStart(19)).join("") + PREFIXES.map((p) => `id ${p}*`.padStart(11)).join("") + "  docs");
for (const r of dirty) {
  console.log(r.path.padEnd(48) + Object.values(r.hits).map((v, i) => String(v.length).padStart(i < 3 ? 19 : 11)).join("") + String(r.total).padStart(6));
  if (showIds) for (const n of new Set(Object.values(r.hits).flat())) console.log("    " + n.slice(ROOT.length + 1));
}
console.log(`\nFOUND ${dirty.reduce((s, r) => s + r.total, 0)} seed/placeholder docs in ${dirty.length} collections. Re-run with --ids to list them.`);
Deno.exit(1);
