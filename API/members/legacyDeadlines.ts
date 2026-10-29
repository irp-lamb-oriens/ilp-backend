/**
 * API/members/legacyDeadlines.ts — one reminder system (COMMS-P4).
 * ──────────────────────────────────────────────────────────────────────────
 * Dates on the client record (the older `clients.deadlines` map written by
 * the status page and the lawyer board, and a staff follow-up loop's
 * `deadlineFollowup.deadline` / `filingDeadline`) are bridged into the
 * obligations collection, so the obligations system alone sends reminders:
 * one email per date and stage (30 and 7 days, retentionMessages.ts), with
 * push notifications following the same stages.
 *
 * Non-destructive: the client-record fields are never changed or deleted.
 * A bridged obligation has a stable id (`obl_legacy_<clientId>_<key>`),
 * `bridged: true` and `bridgedFrom` (where the date lives). When the date on
 * the client record changes, the obligation follows it (and its reminder
 * stages start over); when the entry is removed, the obligation is set to
 * "dismissed" (never deleted). A date the person set on their Deadlines page
 * (`userDueAt`) still wins over the bridged one.
 *
 * Not bridged (no second reminder for the same date): an entry whose
 * priority belongs to another country than the client's (the old sweep
 * skipped those too), and an entry that matches an obligation the client
 * already has (same rule id and same day).
 *
 * Reminders the old sweep already sent are carried over: an old 30-day (or
 * any 8 to 30 day) reminder marks stage "30", an old 7-day or later one marks
 * both stages, so nobody gets the same reminder twice after the switch.
 */

import { type CountryCode, obligationDueAt, type Obligation, toCountryCode } from "../../schemas/contracts.ts";
import { priorityById } from "../countries/countryCatalog.ts";
import { COLLECTIONS } from "../../schemas/contracts.ts";
import { createRecord, findRecords, updateRecord } from "../../db/records.ts";
import { isPlaceholderId, PLACEHOLDER_PREFIX } from "../../helper/placeholder.ts";
import log from "../../helper/log.ts";

type Doc = Record<string, unknown>;

export interface LegacyDeadlineEntry {
  priorityId?: string;
  date?: string;
  remindedEmailOffsets?: number[];
  [k: string]: unknown;
}

export interface BridgedFrom {
  field: "deadlines" | "deadlineFollowup";
  key: string;
  priorityId?: string;
  date: string; // YYYY-MM-DD
}

export type BridgedObligation = Obligation & {
  bridged: true;
  bridgedFrom: BridgedFrom;
  remindersSent?: string[];
  bridgeRemovedAt?: string | null;
};

export const FOLLOWUP_KEY = "filing";
export const FOLLOWUP_RULE_ID = "filing_deadline";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: the obligation id for one client-record date. */
export const bridgedId = (clientId: string, key: string) =>
  `${isPlaceholderId(clientId) ? PLACEHOLDER_PREFIX : ""}obl_legacy_${clientId}_${key}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 400);

/** Pure: a calendar day as the ISO date-time obligations store (noon UTC keeps the day in every zone ILP serves). */
export const dayToIso = (day: string) => `${day}T12:00:00.000Z`;

/** Pure: reminder stages the old sweep already covered for a date (its email offsets). */
export function stagesFromOldOffsets(offsets: unknown): string[] {
  const list = Array.isArray(offsets) ? offsets.filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : [];
  if (list.some((n) => n <= 7)) return ["30", "7"];
  if (list.some((n) => n <= 30)) return ["30"];
  return [];
}

export interface BridgePlan {
  create: BridgedObligation[];
  update: Array<{ id: string; fields: Doc }>;
  /** Entries left out, with the reason (for logs and tests). */
  skipped: Array<{ key: string; reason: "invalid" | "unknown_priority" | "other_country" | "already_tracked" }>;
}

/**
 * Pure: what to create or change so the obligations mirror the client
 * record's dates. `existing` = every obligation of this client.
 */
export function planBridge(client: Doc & { id: string }, existing: Array<Obligation & Partial<BridgedObligation>>, now: Date): BridgePlan {
  const plan: BridgePlan = { create: [], update: [], skipped: [] };
  const nowIso = now.toISOString();
  const clientId = client.id;
  const country = toCountryCode(client.jurisdiction) ?? toCountryCode(client.legalCountry) ?? toCountryCode(client.country);
  const byId = new Map(existing.map((o) => [o.id, o]));
  const own = existing.filter((o) => !o.bridged);
  const wanted = new Map<string, { from: BridgedFrom; title: string; country: CountryCode; oldOffsets?: unknown }>();

  const deadlines = (client.deadlines && typeof client.deadlines === "object" ? client.deadlines : {}) as Record<string, LegacyDeadlineEntry>;
  for (const [key, e] of Object.entries(deadlines)) {
    const date = typeof e?.date === "string" ? e.date.slice(0, 10) : "";
    if (!DAY_RE.test(date)) {
      plan.skipped.push({ key, reason: "invalid" });
      continue;
    }
    const p = priorityById(String(e.priorityId ?? ""));
    if (!p) {
      plan.skipped.push({ key, reason: "unknown_priority" });
      continue;
    }
    if (country && p.country !== country) {
      plan.skipped.push({ key, reason: "other_country" });
      continue;
    }
    if (own.some((o) => o.ruleId === p.id && String(obligationDueAt(o) ?? "").slice(0, 10) === date)) {
      plan.skipped.push({ key, reason: "already_tracked" });
      continue;
    }
    wanted.set(bridgedId(clientId, key), {
      from: { field: "deadlines", key, priorityId: p.id, date },
      title: p.title,
      country: (toCountryCode(p.country) ?? country ?? "CR") as CountryCode,
      oldOffsets: e.remindedEmailOffsets,
    });
  }

  // A staff follow-up loop on a filing deadline (jobs/deadlineFollowup.ts).
  const f = (client.deadlineFollowup && typeof client.deadlineFollowup === "object" ? client.deadlineFollowup : null) as Doc | null;
  if (f && f.status === "active") {
    const raw = typeof f.deadline === "string" && f.deadline ? f.deadline : typeof client.filingDeadline === "string" ? client.filingDeadline : "";
    const date = raw.slice(0, 10);
    if (DAY_RE.test(date)) {
      wanted.set(bridgedId(clientId, FOLLOWUP_KEY), {
        from: { field: "deadlineFollowup", key: FOLLOWUP_KEY, date },
        title: "Filing deadline",
        country: (country ?? "CR") as CountryCode,
      });
    }
  }

  for (const [id, w] of wanted) {
    const cur = byId.get(id);
    if (!cur) {
      plan.create.push({
        id,
        clientId,
        country: w.country,
        ruleId: w.from.priorityId ?? FOLLOWUP_RULE_ID,
        title: w.title,
        dueAt: dayToIso(w.from.date),
        status: "upcoming",
        source: "staff",
        remind: true,
        createdAt: nowIso,
        updatedAt: nowIso,
        bridged: true,
        bridgedFrom: w.from,
        remindersSent: stagesFromOldOffsets(w.oldOffsets),
        ...(client.placeholder === true ? { placeholder: true } : {}),
      } as BridgedObligation);
      continue;
    }
    const curDay = String(cur.dueAt ?? "").slice(0, 10);
    const fields: Doc = {};
    if (curDay !== w.from.date) {
      Object.assign(fields, { dueAt: dayToIso(w.from.date), remindersSent: stagesFromOldOffsets(w.oldOffsets), bridgedFrom: w.from });
    }
    if (cur.bridgeRemovedAt) Object.assign(fields, { status: "upcoming", dismissedAt: null, bridgeRemovedAt: null });
    if (Object.keys(fields).length) plan.update.push({ id, fields: { ...fields, updatedAt: nowIso } });
  }

  // Entries removed from the client record: the bridged obligation is dismissed (kept).
  for (const o of existing) {
    if (!o.bridged || wanted.has(o.id) || o.bridgeRemovedAt || o.status !== "upcoming") continue;
    plan.update.push({ id: o.id, fields: { status: "dismissed", dismissedAt: nowIso, bridgeRemovedAt: nowIso, updatedAt: nowIso } });
  }
  return plan;
}

/** Pure: true when the client record holds dates the bridge reads. */
export function hasLegacyDates(client: Doc): boolean {
  const d = client.deadlines;
  if (d && typeof d === "object" && Object.keys(d as Doc).length) return true;
  const f = client.deadlineFollowup as Doc | undefined;
  return !!f && typeof f === "object" && f.status === "active";
}

/**
 * Mirror one client's record dates into obligations (see planBridge). Reads
 * the client's obligations once. Never throws; returns what changed.
 */
export async function bridgeClientDeadlines(client: Doc & { id: string }, now: Date = new Date()): Promise<{ created: number; updated: number }> {
  try {
    const existing = await findRecords<Obligation & Partial<BridgedObligation>>(COLLECTIONS.obligations, { clientId: client.id });
    if (!hasLegacyDates(client) && !existing.some((o) => o.bridged)) return { created: 0, updated: 0 };
    const plan = planBridge(client, existing, now);
    for (const o of plan.create) await createRecord(COLLECTIONS.obligations, o);
    for (const u of plan.update) await updateRecord(COLLECTIONS.obligations, u.id, u.fields);
    if (plan.create.length || plan.update.length) {
      log(`[legacyDeadlines] ${client.id}: ${plan.create.length} bridged, ${plan.update.length} updated`, "deadlineReminder");
    }
    return { created: plan.create.length, updated: plan.update.length };
  } catch (err) {
    log(`[legacyDeadlines] ${client.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    return { created: 0, updated: 0 };
  }
}
