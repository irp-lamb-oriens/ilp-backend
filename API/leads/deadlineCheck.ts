/**
 * API/leads/deadlineCheck.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure logic for the free deadline check: validate the visitor's answers and
 * turn them into dated findings using the country catalog's CHECK_RULES.
 * No country logic lives here; everything country-specific is catalog data.
 */

import {
  type CheckDue,
  type CheckRule,
  checkRulesForCountry,
} from "../countries/countryCatalog.ts";
import type { CountryCode, LeadFinding } from "../../schemas/contracts.ts";

/** Countries the check is open for (launch order: CR first). */
export const CHECK_COUNTRIES: CountryCode[] = ["CR"];

export const RESIDENCY_STATUSES = ["resident", "applying", "visitor", "unsure"] as const;
export const COMPANY_TYPES = ["SA", "SRL", "none", "unsure"] as const;
export const CR_PROVINCES = [
  "Guanacaste",
  "San José",
  "Alajuela",
  "Heredia",
  "Cartago",
  "Puntarenas",
  "Limón",
] as const;

/** Normalized answers; keys match PROFILE_FIELDS where one exists. */
export interface CheckAnswers {
  [key: string]: string | boolean;
  country: CountryCode;
}

/** A finding as returned to the visitor: the contract fields plus the explanation. */
export interface CheckFinding extends LeadFinding {
  meaning: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asBool(v: unknown): boolean | undefined {
  if (v === true || v === "true" || v === "yes") return true;
  if (v === false || v === "false" || v === "no") return false;
  return undefined;
}

function asDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !DATE_RE.test(v)) return undefined;
  const d = new Date(`${v}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  return y >= 1990 && y <= 2100 ? v : undefined;
}

function oneOf<T extends string>(list: readonly T[], v: unknown): T | undefined {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * Keep only known answer keys with valid values. Unknown keys are dropped so
 * the stored lead never carries arbitrary client input.
 */
export function normalizeAnswers(raw: unknown): { answers: CheckAnswers | null; error?: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const country = String(r.country ?? "CR").toUpperCase() as CountryCode;
  if (!CHECK_COUNTRIES.includes(country)) {
    return { answers: null, error: "The free check is open for Costa Rica for now." };
  }
  const a: CheckAnswers = { country };

  const residencyStatus = oneOf(RESIDENCY_STATUSES, r.residencyStatus);
  if (residencyStatus) a.residencyStatus = residencyStatus;
  if (residencyStatus === "resident") {
    const exp = asDate(r.residencyExpiresAt);
    if (exp) a.residencyExpiresAt = exp;
  }
  if (residencyStatus === "visitor") {
    const entry = asDate(r.lastEntryDate);
    if (entry) a.lastEntryDate = entry;
  }

  const ownsProperty = asBool(r.ownsProperty);
  if (ownsProperty !== undefined) a.ownsProperty = ownsProperty;
  if (ownsProperty) {
    const loc = oneOf(CR_PROVINCES, r.propertyLocation);
    if (loc) a.propertyLocation = loc;
  }

  const companyType = oneOf(COMPANY_TYPES, r.companyType);
  if (companyType) {
    a.companyType = companyType;
    if (companyType === "SA" || companyType === "SRL") a.hasCompany = true;
    if (companyType === "none") a.hasCompany = false;
  }

  for (const key of ["ownsVehicle", "hasEmployees"]) {
    const b = asBool(r[key]);
    if (b !== undefined) a[key] = b;
  }
  return { answers: a };
}

const noon = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12));
const startOfDay = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Next date for a rule's schedule, or null when the answer it needs is missing. */
export function nextDue(due: CheckDue, answers: CheckAnswers, now: Date): Date | null {
  const today = startOfDay(now);
  const y = today.getUTCFullYear();
  switch (due.kind) {
    case "annual": {
      const d = noon(y, due.month, due.day);
      return d >= today ? d : noon(y + 1, due.month, due.day);
    }
    case "installments": {
      const upcoming = [y, y + 1]
        .flatMap((yr) => due.dates.map(([m, d]) => noon(yr, m, d)))
        .filter((d) => d >= today)
        .sort((a, b) => a.getTime() - b.getTime());
      return upcoming[0] ?? null;
    }
    case "monthEnd":
      return noon(y, today.getUTCMonth() + 2, 0); // day 0 of next month = last day of this month
    case "fromAnswer": {
      const v = answers[due.field];
      if (typeof v !== "string" || !DATE_RE.test(v)) return null;
      const d = new Date(`${v}T12:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + due.offsetDays);
      return d;
    }
  }
}

function matches(rule: CheckRule, answers: CheckAnswers): boolean {
  return Object.entries(rule.when).every(([key, allowed]) => {
    const v = answers[key];
    return v !== undefined && allowed.includes(v);
  });
}

/** Dated findings for the answers, soonest first. Undated rules are skipped. */
export function evaluateCheck(answers: CheckAnswers, now: Date = new Date()): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const rule of checkRulesForCountry(answers.country)) {
    if (!matches(rule, answers)) continue;
    const due = nextDue(rule.due, answers, now);
    if (!due) continue;
    out.push({
      ruleId: rule.id,
      title: rule.title,
      area: rule.area,
      dueAt: due.toISOString(),
      meaning: rule.meaning,
    });
  }
  return out.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
}
