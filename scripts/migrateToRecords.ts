/**
 * scripts/migrateToRecords.ts
 * ──────────────────────────────────────────────────────────────────────────
 * One-way migration from the embedded `clients` document to the member-loop
 * records in schemas/contracts.ts.
 *
 * For every `clients` doc:
 *   - one `matters` record   (id mat_mig_<clientId>) from stage, legal area,
 *     jurisdiction, assigned lawyer and the first pending action;
 *   - one `memberships` record (id mem_mig_<clientId>) ONLY when paid
 *     membership data exists: a paid charge labelled membership / activation /
 *     subscription, or a `membership` object on the client doc.
 *
 * Idempotent: deterministic ids; existing records are skipped (never
 * overwritten) unless --force. The clients doc itself is not modified, apart
 * from a `migratedToRecordsAt` stamp (skipped with --no-stamp).
 *
 * Run (dry run first):
 *   deno run --allow-net --allow-env --allow-read scripts/migrateToRecords.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/migrateToRecords.ts
 *   … --only=<clientId>   limit to one client
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import getAll from "../db/getAll.ts";
import patch from "../db/patch.ts";
import { createRecord, getRecord } from "../db/records.ts";
import {
  COLLECTIONS,
  type CountryCode,
  type Matter,
  type Membership,
  type NextStep,
  PLAN_STANDARD,
} from "../schemas/contracts.ts";

type Doc = Record<string, unknown>;

const args = new Set(Deno.args);
const DRY = args.has("--dry-run") || args.has("-n");
const FORCE = args.has("--force");
const STAMP = !args.has("--no-stamp");
const ONLY = Deno.args.find((a) => a.startsWith("--only="))?.slice(7);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function countryOf(c: Doc): CountryCode {
  const f = (c.clientFields as Doc) ?? {};
  const raw = String(c.jurisdiction ?? c.country ?? f.jurisdiction ?? f.country ?? "").toLowerCase();
  if (/(^pa$|panam)/.test(raw)) return "PA";
  if (/(^mx$|mexic|méxic)/.test(raw)) return "MX";
  return "CR";
}

const CLOSED_STAGES = /^(closed|completed|archived|lost|cancel+ed|done)$/i;

/** Pure: the matter a clients doc becomes. Exported for tests. */
export function matterFromClient(c: Doc, now = new Date().toISOString()): Matter {
  const f = (c.clientFields as Doc) ?? {};
  const consult = Array.isArray(c.consultations) ? (c.consultations[0] as Doc | undefined) : undefined;
  const area = str(c.legalArea) ?? str(f.legalArea) ?? str(consult?.legalArea) ?? "general";
  const title = str(c.legalMatter) ?? str(f.legalMatter) ?? str(f.matterTitle) ?? str(consult?.legalMatter) ??
    str(c.serviceType) ?? `${area[0].toUpperCase()}${area.slice(1)} matter`;
  const stage = str(c.stage) ?? "intake";
  const opened = str(c.createdAt) ?? now;
  const actions = Array.isArray(c.pendingActions) ? (c.pendingActions as Doc[]) : [];
  const first = actions.find((a) => str(a.label));
  const nextStep: NextStep | undefined = first
    ? { what: String(first.label), who: "ilp", ...(str(first.dueAt) ? { dueAt: String(first.dueAt) } : {}) }
    : undefined;
  const m: Matter = {
    id: `mat_mig_${c.id}`,
    clientId: String(c.id),
    title,
    area,
    country: countryOf(c),
    stage,
    stageEnteredAt: str(c.stageEnteredAt) ?? str(c.updatedAt) ?? opened,
    openedAt: opened,
  };
  if (str(c.assignedProviderId)) m.assignedProviderId = String(c.assignedProviderId);
  if (nextStep) m.nextStep = nextStep;
  if (CLOSED_STAGES.test(stage)) m.closedAt = str(c.updatedAt) ?? now;
  return m;
}

const MEMBERSHIP_CHARGE = /(membership|membres|activation|activaci|subscription|suscrip|monthly plan|plan mensual)/i;

/** Pure: a membership when paid data exists, else null. Exported for tests. */
export function membershipFromClient(c: Doc, nowIso = new Date().toISOString()): Membership | null {
  const embedded = (c.membership as Doc) ?? null;
  const charges = Array.isArray(c.charges) ? (c.charges as Doc[]) : [];
  const paid = charges
    .filter((ch) => ch.status === "paid" && MEMBERSHIP_CHARGE.test(String(ch.label ?? "")))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  if (!paid.length && !embedded) return null;

  const firstPaid = str(paid[0]?.createdAt) ?? str(embedded?.activatedAt) ?? str(c.createdAt) ?? nowIso;
  const lastPaid = str(paid[paid.length - 1]?.createdAt) ?? str(embedded?.periodStart) ?? firstPaid;
  const periodStart = lastPaid;
  const end = new Date(periodStart);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const periodEnd = str(embedded?.periodEnd) ?? end.toISOString();
  const embeddedStatus = str(embedded?.status);
  const status: Membership["status"] = embeddedStatus && ["pending", "active", "past_due", "cancelled"].includes(embeddedStatus)
    ? embeddedStatus as Membership["status"]
    : periodEnd < nowIso ? "past_due" : "active";
  const activation = paid.find((ch) => /activ/i.test(String(ch.label ?? "")));
  const m: Membership = {
    id: `mem_mig_${c.id}`,
    clientId: String(c.id),
    plan: PLAN_STANDARD.id,
    status,
    country: countryOf(c),
    activatedAt: firstPaid,
    periodStart,
    periodEnd,
    minutesIncluded: Number(embedded?.minutesIncluded ?? PLAN_STANDARD.minutesIncluded),
    minutesUsed: Number(embedded?.minutesUsed ?? 0),
    callsIncluded: Number(embedded?.callsIncluded ?? PLAN_STANDARD.callsIncluded),
    callsUsed: Number(embedded?.callsUsed ?? 0),
    paymentRef: "migrated",
    createdAt: firstPaid,
    updatedAt: nowIso,
  };
  if (activation) m.activationPaidAt = String(activation.createdAt ?? firstPaid);
  if (str(embedded?.csmEmail)) m.csmEmail = String(embedded!.csmEmail);
  return m;
}

async function main() {
  const clients = (await getAll(COLLECTIONS.clients)) as Doc[];
  const targets = ONLY ? clients.filter((c) => c.id === ONLY) : clients;
  console.log(`${DRY ? "[dry-run] " : ""}${targets.length} clients to process`);
  const tally = { matters: 0, memberships: 0, skipped: 0, errors: 0 };

  for (const c of targets) {
    try {
      const matter = matterFromClient(c);
      const membership = membershipFromClient(c);
      const plan: Array<[typeof COLLECTIONS.matters | typeof COLLECTIONS.memberships, Matter | Membership]> = [
        [COLLECTIONS.matters, matter],
      ];
      if (membership) plan.push([COLLECTIONS.memberships, membership]);

      for (const [col, rec] of plan) {
        const exists = await getRecord(col, rec.id);
        if (exists && !FORCE) {
          tally.skipped++;
          continue;
        }
        console.log(`${DRY ? "would write" : "write"} ${col}/${rec.id}  (client ${c.id})`);
        if (!DRY) await createRecord(col, rec);
        if (col === COLLECTIONS.matters) tally.matters++;
        else tally.memberships++;
      }
      if (!DRY && STAMP) await patch(COLLECTIONS.clients, String(c.id), { migratedToRecordsAt: new Date().toISOString() });
    } catch (err) {
      tally.errors++;
      console.error(`client ${c.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`${DRY ? "[dry-run] " : ""}done`, tally);
}

if (import.meta.main) await main();
