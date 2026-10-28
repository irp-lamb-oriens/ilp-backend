/**
 * API/members/deadlines.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DEADLINES: pure logic for a person's own deadline list (free check
 * selection, the Deadlines page and its picker). No Firestore here, so it is
 * tested directly (test/deadlines_test.ts).
 *
 * One obligation per (person, rule): the id is `obl_<clientId>_<ruleId>`,
 * the same id the join and profile paths use, so no path duplicates another.
 * The date shown and reminded is `userDueAt ?? dueAt` (obligationDueAt).
 */

import {
  COUNTRIES,
  type CountryCode,
  type Obligation,
  obligationDueAt,
  obligationNeedsDate,
  type ObligationSource,
} from "../../schemas/contracts.ts";
import { answersToFacts, cleanAnswers, type CountryRule, type Facts, nextDue, ruleApplies } from "../countries/rules/engine.ts";
import { questionsFor, ruleById, rulesFor } from "../countries/rules/index.ts";

/** At most this many rule ids in one claim or picker save (the largest country has 49 rules). */
export const MAX_RULE_IDS = 60;
export const MAX_NOTE = 500;
const DAY_MS = 86_400_000;

export const obligationIdFor = (clientId: string, ruleId: string) => `obl_${clientId}_${ruleId}`.replace(/[^A-Za-z0-9_-]/g, "_");

/** Facts for a country from raw answers (unknown keys and values dropped). */
export function factsFor(country: CountryCode, answers: Record<string, unknown> | null | undefined): Facts {
  const qs = questionsFor(country);
  return answersToFacts(qs, cleanAnswers(qs, (answers ?? {}) as Record<string, unknown>));
}

/** Rule ids from a request body: strings only, known rules of `country` only, no duplicates, capped. */
export function cleanRuleIds(country: CountryCode, raw: unknown): { ruleIds: string[]; unknown: string[] } {
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_]{1,80}$/.test(x)) : [];
  const known = new Set(rulesFor(country).map((r) => r.id));
  const ruleIds: string[] = [];
  const unknown: string[] = [];
  for (const id of [...new Set(list)].slice(0, MAX_RULE_IDS)) (known.has(id) ? ruleIds : unknown).push(id);
  return { ruleIds, unknown };
}

/** The obligation a rule gives this person: computed date when there is one, needsDate otherwise. */
export function obligationForRule(
  clientId: string,
  country: CountryCode,
  rule: CountryRule,
  facts: Facts,
  source: ObligationSource,
  now: Date = new Date(),
): Obligation {
  const due = nextDue(rule, facts, now, (id) => ruleById(id));
  const o: Obligation = {
    id: obligationIdFor(clientId, rule.id),
    clientId,
    country,
    ruleId: rule.id,
    title: rule.title,
    area: rule.area,
    status: "upcoming",
    confidence: rule.confidence,
    source,
    remind: true,
    needsDate: !due || rule.confidence === "low",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (rule.dueText) o.dueText = rule.dueText;
  if (due) {
    o.dueAt = due.dueAt.toISOString();
    if (due.windowStartAt) o.windowStartAt = due.windowStartAt.toISOString();
  }
  return o;
}

/** Obligations for chosen rule ids (rules of `country`, in the order given). */
export function obligationsForRules(
  clientId: string,
  country: CountryCode,
  ruleIds: string[],
  facts: Facts,
  source: ObligationSource,
  now: Date = new Date(),
): Obligation[] {
  const byId = new Map(rulesFor(country).map((r) => [r.id, r]));
  return ruleIds.map((id) => byId.get(id)).filter((r): r is CountryRule => !!r).map((r) => obligationForRule(clientId, country, r, facts, source, now));
}

/**
 * What to do with an obligation the person chose again: a new one is
 * created; a removed one comes back (status upcoming, dismissedAt cleared);
 * anything else is kept as it is (their dates and notes stay).
 */
export function mergeChosen(existing: Obligation | null, fresh: Obligation): { action: "create" | "restore" | "keep"; fields?: Partial<Obligation> } {
  if (!existing) return { action: "create" };
  if (existing.status === "dismissed" || existing.dismissedAt) {
    return { action: "restore", fields: { status: "upcoming", dismissedAt: null, updatedAt: fresh.updatedAt } };
  }
  return { action: "keep" };
}

// ─── PATCH validation ──────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A date the person typed (YYYY-MM-DD) as noon UTC, within 10 years back and 30 ahead. */
export function parseUserDate(v: unknown, now: Date = new Date()): string | null | { error: string } {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return { error: "Enter the date as year, month and day." };
  const day = v.slice(0, 10);
  if (!DATE_RE.test(day)) return { error: "Enter the date as year, month and day." };
  const d = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return { error: "That date does not exist. Check the day and month." };
  const y = d.getUTCFullYear();
  if (y < now.getUTCFullYear() - 10 || y > now.getUTCFullYear() + 30) return { error: "Enter a date within the next 30 years." };
  return d.toISOString();
}

export type DeadlinePatch = Partial<Pick<Obligation, "userDueAt" | "status" | "remind" | "dismissedAt" | "notes" | "needsDate" | "updatedAt">> & {
  /** Reset when the person sets a new date, so the 30- and 7-day reminders follow it. */
  remindersSent?: string[];
};

/**
 * Fields a person may change on their own deadline:
 *   userDueAt  "YYYY-MM-DD" or null (clear)
 *   status     "upcoming" | "handled" (done); "asked" goes through Ask my lawyer
 *   remind     boolean
 *   dismissed  true (remove: status dismissed + dismissedAt) | false (undo: back to `status` or upcoming)
 *   notes      text up to 500 characters, "" clears
 * Unknown keys are refused, so a typo is not silently ignored.
 */
export function parseDeadlinePatch(body: unknown, current: Obligation, now: Date = new Date()): DeadlinePatch | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const allowed = new Set(["userDueAt", "status", "remind", "dismissed", "notes"]);
  const keys = Object.keys(b);
  if (!keys.length) return { error: "Nothing to save." };
  const bad = keys.find((k) => !allowed.has(k));
  if (bad) return { error: `"${bad}" cannot be changed here.` };
  const out: DeadlinePatch = { updatedAt: now.toISOString() };
  if ("userDueAt" in b) {
    const d = parseUserDate(b.userDueAt, now);
    if (d && typeof d === "object") return d;
    out.userDueAt = d;
    out.needsDate = d ? false : !current.dueAt || current.confidence === "low";
    if ((d ?? null) !== (current.userDueAt ?? null)) out.remindersSent = [];
  }
  if ("status" in b) {
    if (b.status !== "upcoming" && b.status !== "handled") return { error: "status must be 'upcoming' or 'handled'." };
    out.status = b.status;
  }
  if ("remind" in b) {
    if (typeof b.remind !== "boolean") return { error: "remind must be true or false." };
    out.remind = b.remind;
  }
  if ("notes" in b) {
    if (typeof b.notes !== "string") return { error: "notes must be text." };
    const n = b.notes.trim();
    if (n.length > MAX_NOTE) return { error: `Keep the note under ${MAX_NOTE} characters.` };
    out.notes = n;
  }
  if ("dismissed" in b) {
    if (typeof b.dismissed !== "boolean") return { error: "dismissed must be true or false." };
    if (b.dismissed) {
      out.status = "dismissed";
      out.dismissedAt = now.toISOString();
    } else {
      out.dismissedAt = null;
      if (!out.status) out.status = current.status === "dismissed" ? "upcoming" : current.status;
    }
  } else if (current.status === "dismissed" && out.status) {
    return { error: "Restore this deadline first." };
  }
  return out;
}

// ─── Views ─────────────────────────────────────────────────────────────────

export type DeadlineGroup = "soon" | "later" | "needsDate" | "done";

/** "soon": within 90 days (or past and open); "later"; "needsDate"; "done" (handled). Removed ones are not listed. */
export function deadlineGroup(o: Obligation, now: Date = new Date()): DeadlineGroup {
  if (o.status === "handled") return "done";
  if (obligationNeedsDate(o)) return "needsDate";
  const due = obligationDueAt(o);
  if (!due) return "needsDate";
  return Date.parse(due) - now.getTime() <= 90 * DAY_MS ? "soon" : "later";
}

export interface DeadlineView extends Obligation {
  meaning: string;
  authority: string;
  countryName: string;
  shownDueAt: string | null;
  hasDate: boolean;
  needsDate: boolean;
  group: DeadlineGroup;
  /** The rule's computed date the person can use instead of typing one ("Use the suggested date"). */
  suggestedDueAt: string | null;
}

/** A list row: the obligation plus the rule's explanation and the shown date. */
export function deadlineView(o: Obligation, now: Date = new Date()): DeadlineView {
  const rule = ruleById(o.ruleId);
  const needs = obligationNeedsDate(o);
  const shown = needs ? null : obligationDueAt(o) ?? null;
  return {
    ...o,
    area: o.area ?? rule?.area ?? "other",
    source: o.source ?? "check",
    remind: o.remind !== false,
    meaning: rule?.meaning ?? "",
    authority: rule?.authority ?? "",
    countryName: COUNTRIES[o.country]?.name ?? String(o.country),
    shownDueAt: shown,
    hasDate: !!shown,
    needsDate: needs,
    group: deadlineGroup(o, now),
    suggestedDueAt: o.dueAt && o.confidence !== "low" ? o.dueAt : null,
  };
}

/** Rows the person sees: not removed. */
export const visibleDeadlines = (list: Obligation[]) => list.filter((o) => o.status !== "dismissed" && !o.dismissedAt);

export interface PickerItem {
  ruleId: string;
  country: CountryCode;
  area: string;
  title: string;
  meaning: string;
  authority: string;
  confidence: "high" | "medium" | "low";
  dueText?: string;
  dueAt?: string;
  windowStartAt?: string;
  /** The rule's conditions match the person's answers for this country. */
  matches: boolean;
}

/**
 * Rules of `country` the person does not have on their list yet (removed
 * ones count as not on the list). Matching rules first, then dated ones by
 * date, then the rest in research order.
 */
export function pickerItems(country: CountryCode, facts: Facts, have: Obligation[], now: Date = new Date()): PickerItem[] {
  const on = new Set(visibleDeadlines(have).filter((o) => o.country === country).map((o) => o.ruleId));
  const items = rulesFor(country).filter((r) => !on.has(r.id)).map((r, i) => {
    const matches = ruleApplies(r, facts);
    const due = matches ? nextDue(r, facts, now, (id) => ruleById(id)) : null;
    const item: PickerItem = {
      ruleId: r.id,
      country,
      area: r.area,
      title: r.title,
      meaning: r.meaning,
      authority: r.authority,
      confidence: r.confidence,
      matches,
    };
    if (r.dueText) item.dueText = r.dueText;
    if (due) {
      item.dueAt = due.dueAt.toISOString();
      if (due.windowStartAt) item.windowStartAt = due.windowStartAt.toISOString();
    }
    return { item, i };
  });
  items.sort((a, b) =>
    Number(b.item.matches) - Number(a.item.matches) ||
    Number(!!b.item.dueAt) - Number(!!a.item.dueAt) ||
    String(a.item.dueAt ?? "").localeCompare(String(b.item.dueAt ?? "")) ||
    a.i - b.i
  );
  return items.map((x) => x.item);
}

/** Members whose needsDate items (no date of their own) are older than 7 days: one CSM task per member. */
export function needsDateClients(list: Obligation[], memberIds: Set<string>, now: Date = new Date()): string[] {
  const out = new Set<string>();
  for (const o of visibleDeadlines(list)) {
    if (!memberIds.has(o.clientId) || o.status === "handled" || !obligationNeedsDate(o)) continue;
    const at = Date.parse(String(o.createdAt ?? ""));
    if (Number.isFinite(at) && now.getTime() - at >= 7 * DAY_MS) out.add(o.clientId);
  }
  return [...out];
}
