/**
 * scripts/seedAccounts.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Account seed: the full placeholder story (scripts/placeholderData.ts, pilot
 * size) centred on three REAL login accounts, so each sees a full portal:
 *
 *   lawyer  /lawyer     pablo@internationalrelocationpartner.com   (providers doc, resolved by email)
 *   staff   /dashboard  info@internationallegalpartner.com         (CSM owner of the queue and most opportunities)
 *   member  /status     admin@internationallegalpartner.com        (clients/<email-derived id>)
 *
 * The member is assigned to the lawyer and the CSM, so the three portals tell
 * the same story. Real documents are never replaced or deleted: only EMPTY
 * fields are filled and arrays are appended to, every change is recorded in
 * `placeholderFields` (see scripts/accountSeedOps.ts), and
 * `removePlaceholders.ts --accounts` puts them back exactly. Everything else is
 * normal placeholder data (`ph_` ids, placeholder: true, placeholderBatch
 * "ph-accounts-<seed>"), with the same guards as the full seed: no email, push,
 * Calendar or Stripe call is made by the seed or later for these records.
 *
 * Flags:
 *   --dry-run                 counts per collection and per account, screen report, 2 samples; no writes.
 *                             Reads the three accounts when credentials are available (read-only).
 *   --offline                 with --dry-run: no Firestore reads at all (assumed ids)
 *   --seed=N                  default 7
 *   --confirm-project=<id>    required for a real run; must equal the service account's project
 *   --lawyer-email= --staff-email= --member-email=   default: the three accounts above
 *   --concurrency=N           parallel writes, default 8
 *   --allow-other-batches     write even if another placeholder batch (e.g. ph-pilot-7) is loaded (ids overlap!)
 * Env: SERVICE_ACCOUNT_KEY (JSON or a path; .env works).
 *
 * Run (from server/):
 *   deno run --allow-net --allow-env --allow-read scripts/seedAccounts.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/seedAccounts.ts --confirm-project=<id>
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import get from "../db/get.ts";
import getAll from "../db/getAll.ts";
import query from "../db/query.ts";
import replace from "../db/replace.ts";
import remove from "../db/delete.ts";
import { clean } from "../db/records.ts";
import { getProjectId } from "../db/projectId.ts";
import { commitFieldWrite } from "../helper/firestore/firestoreService.ts";
import { isPlaceholderDoc } from "../helper/placeholder.ts";
import { emailToDocId } from "../helper/auth/otp.ts";
import { type Area, AREAS, buildPlaceholderData, type Doc, type SeedData } from "./placeholderData.ts";
import { addJourneyData } from "./journeyPlaceholderData.ts"; // JOURNEYS
import { pool, printTable, selectForDeletion } from "./placeholderOps.ts";
import {
  accountCounts,
  type AccountIds,
  applyWrite,
  checkAccountPlan,
  type FieldWrite,
  isEmptyWrite,
  planAccountSeed,
  planRestore,
  type RealDocs,
  screenReport,
} from "./accountSeedOps.ts";

export const DEFAULT_ACCOUNTS = {
  lawyer: "pablo@internationalrelocationpartner.com",
  staff: "info@internationallegalpartner.com",
  member: "admin@internationallegalpartner.com",
};
/** Pablo's provider id in scripts/seedPabloAndAdmin.ts; used only by an offline dry run. */
const OFFLINE_LAWYER_ID = "prov_pablo";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AccountCli {
  dryRun: boolean;
  offline: boolean;
  seed: number;
  confirmProject?: string;
  lawyerEmail: string;
  staffEmail: string;
  memberEmail: string;
  concurrency: number;
  allowOtherBatches: boolean;
}

export const normEmail = (v: string) => v.trim().toLowerCase();

export function parseAccountArgs(args: string[]): AccountCli | { error: string } {
  const flag = (name: string) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
  };
  const seed = Number(flag("seed") ?? "7");
  if (!Number.isInteger(seed) || seed < 0) return { error: "--seed must be a whole number" };
  const out: AccountCli = {
    dryRun: flag("dry-run") === "true" || args.includes("-n"),
    offline: flag("offline") === "true",
    seed,
    confirmProject: flag("confirm-project"),
    lawyerEmail: normEmail(flag("lawyer-email") ?? DEFAULT_ACCOUNTS.lawyer),
    staffEmail: normEmail(flag("staff-email") ?? DEFAULT_ACCOUNTS.staff),
    memberEmail: normEmail(flag("member-email") ?? DEFAULT_ACCOUNTS.member),
    concurrency: Math.max(1, Math.min(32, Number(flag("concurrency") ?? "8") || 8)),
    allowOtherBatches: flag("allow-other-batches") === "true",
  };
  for (const [k, v] of [["--lawyer-email", out.lawyerEmail], ["--staff-email", out.staffEmail], ["--member-email", out.memberEmail]] as const) {
    if (!EMAIL_RE.test(v)) return { error: `${k} is not an email address` };
  }
  if (new Set([out.lawyerEmail, out.staffEmail, out.memberEmail]).size < 3) return { error: "the lawyer, staff and member emails must be three different accounts" };
  return out;
}

export const accountBatch = (seed: number) => `ph-accounts-${seed}`;

/** Lawyer specialties of the real provider doc, as seed areas. */
export function areasOf(provider: Doc | null): Area[] {
  const list = Array.isArray(provider?.legalAreas) ? (provider!.legalAreas as unknown[]) : [];
  return list.map((a) => String(a)).filter((a): a is Area => (AREAS as readonly string[]).includes(a));
}

export function nameOf(doc: Doc | null, email: string): { first: string; last: string } {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const first = str(doc?.name).split(/\s+/)[0] || str(doc?.fullName).split(/\s+/)[0];
  const last = str(doc?.surname) || (str(doc?.name).split(/\s+/).length > 1 ? str(doc?.name).split(/\s+/).slice(1).join(" ") : "") ||
    str(doc?.fullName).split(/\s+/).slice(1).join(" ");
  if (first) return { first, last };
  const local = email.split("@")[0].split(/[._+-]/)[0];
  return { first: local.charAt(0).toUpperCase() + local.slice(1), last: "" };
}

/** Build the seed data for the resolved accounts. */
export function buildAccountData(o: AccountCli, ids: AccountIds, real: { lawyer: Doc | null; member: Doc | null }, now?: Date): SeedData {
  const lawyerName = nameOf(real.lawyer, o.lawyerEmail);
  const areas = areasOf(real.lawyer);
  const data = buildPlaceholderData({
    size: "pilot",
    seed: o.seed,
    now,
    batch: accountBatch(o.seed),
    memberEmail: o.memberEmail,
    lawyerEmail: o.lawyerEmail,
    csmEmail: o.staffEmail,
    focus: {
      lawyerId: ids.lawyerId,
      lawyerName: [lawyerName.first, lawyerName.last].filter(Boolean).join(" "),
      lawyerAreas: areas.length ? areas : undefined,
      memberId: ids.memberId,
      memberName: real.member ? nameOf(real.member, o.memberEmail) : undefined,
      csmShare: 0.35,
    },
  });
  // JOURNEYS: journeys, experiments and outreach around the same people.
  addJourneyData(data, { seed: o.seed });
  return data;
}

function preview(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 100 ? `${v.slice(0, 97)}...` : v;
  if (Array.isArray(v)) return depth > 1 ? `[${v.length} items]` : v.slice(0, 2).map((x) => preview(x, depth + 1)).concat(v.length > 2 ? [`… +${v.length - 2}`] : []);
  if (v && typeof v === "object") return depth > 1 ? "{…}" : Object.fromEntries(Object.entries(v as Doc).map(([k, x]) => [k, preview(x, depth + 1)]));
  return v;
}

const ACCOUNT_DOCS = ["clients", "providers", "lawyer_availability"] as const;

/** Read the accounts (read-only). Earlier account-seed changes are taken out in memory. */
async function lookup(o: AccountCli): Promise<{ ids: AccountIds; real: RealDocs; raw: Record<string, Doc | null>; notes: string[] }> {
  const notes: string[] = [];
  const providers = (await getAll("providers")) as unknown as Doc[];
  const realLawyers = providers.filter((p) => typeof p.email === "string" && normEmail(p.email) === o.lawyerEmail && !isPlaceholderDoc(p));
  const ourLawyer = providers.find((p) => typeof p.email === "string" && normEmail(p.email) === o.lawyerEmail && isPlaceholderDoc(p));
  if (realLawyers.length > 1) notes.push(`lawyer: ${realLawyers.length} real providers use ${o.lawyerEmail}; using ${realLawyers[0].id}.`);
  const lawyerId = String(realLawyers[0]?.id ?? ourLawyer?.id ?? "ph_prov_acct_lawyer");
  let memberId = emailToDocId(o.memberEmail);
  let member = (await get("clients", memberId).catch(() => null)) as Doc | null;
  if (!member) {
    const byEmail = ((await query("clients", [{ field: "email", op: "EQUAL", value: o.memberEmail }]).catch(() => [])) as unknown as Doc[])
      .filter((c) => !isPlaceholderDoc(c));
    if (byEmail.length) {
      memberId = String(byEmail[0].id);
      member = byEmail[0];
      notes.push(`member: no clients/${emailToDocId(o.memberEmail)}; using clients/${memberId} (same email).`);
    }
  }
  const lawyer = realLawyers[0] ?? (ourLawyer ?? null);
  const availability = (await get("lawyer_availability", lawyerId).catch(() => null)) as Doc | null;
  const memberships = ((await query("memberships", [{ field: "clientId", op: "EQUAL", value: memberId }]).catch(() => [])) as unknown as Doc[]);
  const realMembership = memberships.some((m) => !isPlaceholderDoc(m) && (m.status === "active" || m.status === "past_due"));
  const raw: Record<string, Doc | null> = {
    [`clients/${memberId}`]: member,
    [`providers/${lawyerId}`]: lawyer,
    [`lawyer_availability/${lawyerId}`]: availability,
  };
  // In memory: the real docs as they were before any earlier account seed.
  const restored = (c: string, d: Doc | null) => (d && !isPlaceholderDoc(d) ? applyWrite(d, planRestore(c, "", d)) : d);
  return {
    ids: { lawyerId, memberId, lawyerEmail: o.lawyerEmail, staffEmail: o.staffEmail, memberEmail: o.memberEmail },
    real: {
      lawyer: restored("providers", lawyer),
      member: restored("clients", member),
      availability: restored("lawyer_availability", availability),
      memberHasRealMembership: realMembership,
    },
    raw,
    notes,
  };
}

export async function main(args: string[] = Deno.args): Promise<number> {
  const parsed = parseAccountArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const o = parsed;
  const batch = accountBatch(o.seed);
  const haveKey = !!Deno.env.get("SERVICE_ACCOUNT_KEY");
  const offline = o.dryRun && (o.offline || !haveKey);
  if (!o.dryRun && !haveKey) {
    console.error("SERVICE_ACCOUNT_KEY is not set (env or .env). Use --dry-run to preview without credentials.");
    return 2;
  }

  let ids: AccountIds;
  let real: RealDocs;
  let raw: Record<string, Doc | null> = {};
  let notes: string[] = [];
  if (offline) {
    ids = { lawyerId: OFFLINE_LAWYER_ID, memberId: emailToDocId(o.memberEmail), lawyerEmail: o.lawyerEmail, staffEmail: o.staffEmail, memberEmail: o.memberEmail };
    real = { lawyer: null, member: null, availability: null, memberHasRealMembership: false };
    notes.push(`offline: assumed providers/${ids.lawyerId} and clients/${ids.memberId}; real fields are only known with Firestore access.`);
  } else {
    try {
      ({ ids, real, raw, notes } = await lookup(o));
    } catch (err) {
      console.error(`Could not read the accounts from Firestore: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }

  const data = buildAccountData(o, ids, real);
  const seededAt = data.now;
  const plan = planAccountSeed(data, ids, real, seededAt);
  checkAccountPlan(plan, ids, real);

  console.log(`${o.dryRun ? "[dry-run] " : ""}ILP account seed  seed=${o.seed} batch=${batch}  now=${data.now}${offline ? "  (offline)" : ""}`);
  console.log(`  lawyer  ${o.lawyerEmail} → providers/${ids.lawyerId}${real.lawyer ? " (real)" : offline ? "" : " (missing: created as placeholder)"}`);
  console.log(`  staff   ${o.staffEmail} (CSM; no staff document, role comes from ADMIN_EMAILS / CSM_EMAILS)`);
  console.log(`  member  ${o.memberEmail} → clients/${ids.memberId}${real.member ? " (real)" : offline ? "" : " (missing: created as placeholder)"}`);
  // Offline the real docs are unknown: the plan below treats them as missing (a real run merges into them).
  for (const n of offline ? notes : [...notes, ...plan.notes]) console.log(`  - ${n}`);

  console.log("\nDocuments per collection (member / lawyer / staff = docs that reference that account):");
  const counts = accountCounts(data, ids);
  printTable(counts, ["collection", "docs", "member", "lawyer", "staff"]);
  console.log(`  total: ${counts.reduce((s, r) => s + r[1], 0)} documents; ${plan.creates.length} placeholder writes + ${plan.merges.length} merges into real docs`);
  console.log("\nWhat each account will see:");
  printTable(screenReport(data, ids).map((r) => [r.account, r.screen, r.count, r.detail]), ["account", "screen", "count", "detail"]);
  for (const m of plan.merges) {
    console.log(`\n  merge ${m.collection}/${m.id}: fills ${Object.keys(m.set).filter((k) => !k.startsWith("placeholder")).length} empty fields, appends to ${Object.keys(m.append).join(", ") || "-"}; keeps ${m.skipped.length} real fields (${m.skipped.slice(0, 12).join(", ")}${m.skipped.length > 12 ? " …" : ""})`);
  }

  if (o.dryRun) {
    for (const [col, list] of Object.entries(data.collections)) {
      const mine = list.filter((d) => [ids.memberId, ids.lawyerId].some((x) => JSON.stringify(d).includes(`"${x}"`)));
      const pick = (mine.length >= 2 ? mine : list).slice(0, 2);
      console.log(`\n── ${col}: 2 of ${list.length}`);
      for (const d of pick) console.log(JSON.stringify(preview(d)));
    }
    return 0;
  }

  // ── Real run ──
  const project = getProjectId();
  if (o.confirmProject !== project) {
    console.error(`\nThis writes ${plan.creates.length} placeholder documents and ${plan.merges.length} field merges to Firestore project "${project}".`);
    console.error(`Re-run with --confirm-project=${project} once the server with the placeholder guards is deployed.`);
    return 2;
  }
  const others = ((await query("clients", [{ field: "placeholder", op: "EQUAL", value: true }]).catch(() => [])) as unknown as Doc[])
    .filter((c) => c.placeholderBatch && c.placeholderBatch !== batch && c.placeholderBatch !== "derived");
  if (others.length && !o.allowOtherBatches) {
    console.error(`\nAnother placeholder batch is loaded (${[...new Set(others.map((c) => c.placeholderBatch))].join(", ")}); its ph_ ids overlap with this seed.`);
    console.error("Remove it first (scripts/removePlaceholders.ts) or pass --allow-other-batches.");
    return 2;
  }

  const errors: string[] = [];
  // 1. Undo an earlier account seed on the real docs, so the merge starts from the real state.
  for (const [key, doc] of Object.entries(raw)) {
    if (!doc || isPlaceholderDoc(doc)) continue;
    const [col, id] = key.split("/");
    const w = planRestore(col, id, doc);
    if (isEmptyWrite(w)) continue;
    await commitFieldWrite(col, id, w);
    if (w.kept.length) console.log(`  ${key}: kept ${w.kept.join(", ")} (changed since the last seed)`);
  }
  // 2. Merges into the real docs, then the placeholder docs (people first).
  for (const m of plan.merges) {
    if (isEmptyWrite(m)) continue;
    try {
      await commitFieldWrite(m.collection, m.id, m as FieldWrite);
    } catch (err) {
      errors.push(`merge ${m.collection}/${m.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const done = new Map<string, number>();
  const write = async (w: { collection: string; id: string; doc: Doc }) => {
    const key = w.collection.includes("/") ? `clients/*/${w.collection.split("/").pop()}` : w.collection;
    try {
      await replace(w.collection, w.id, clean(w.doc));
      done.set(key, (done.get(key) ?? 0) + 1);
    } catch (err) {
      if (errors.length < 10) errors.push(`${w.collection}/${w.id}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const started = Date.now();
  const people = plan.creates.filter((w) => (ACCOUNT_DOCS as readonly string[]).includes(w.collection));
  await pool(people, o.concurrency, write);
  await pool(plan.creates.filter((w) => !people.includes(w)), o.concurrency, write);

  // 3. Prune this batch's docs the new plan no longer has (stale story from an earlier day).
  let pruned = 0;
  const planned = new Map<string, Set<string>>();
  for (const w of plan.creates) if (!w.collection.includes("/")) (planned.get(w.collection) ?? planned.set(w.collection, new Set()).get(w.collection)!).add(w.id);
  for (const [col, keep] of planned) {
    const docs = (await query(col, [{ field: "placeholder", op: "EQUAL", value: true }]).catch(() => [])) as unknown as Doc[];
    const stale = selectForDeletion(col, docs, { batch }).remove.filter((d) => !keep.has(String(d.id)));
    await pool(stale, o.concurrency, async (d) => {
      try {
        await remove(col, String(d.id));
        pruned++;
      } catch (err) {
        if (errors.length < 10) errors.push(`prune ${col}/${d.id}: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  console.log("");
  printTable(counts.map(([c, n]) => [c, n, done.get(c) ?? 0]), ["collection", "planned", "written"]);
  console.log(`  ${[...done.values()].reduce((s, n) => s + n, 0)} placeholder documents written, ${plan.merges.filter((m) => !isEmptyWrite(m)).length} real docs merged, ${pruned} stale pruned, in ${Math.round((Date.now() - started) / 1000)} s.`);
  if (errors.length) {
    console.error("  First errors:");
    for (const e of errors.slice(0, 10)) console.error(`   - ${e}`);
    return 1;
  }
  console.log(`  Remove with: deno run --allow-net --allow-env --allow-read scripts/removePlaceholders.ts --accounts --confirm-project=${project}`);
  return 0;
}

if (import.meta.main) {
  const code = await main();
  if (code) Deno.exit(code);
}
