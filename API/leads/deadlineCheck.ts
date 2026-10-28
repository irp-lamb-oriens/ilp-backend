/**
 * API/leads/deadlineCheck.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure logic for the free deadline check: validate the visitor's answers and
 * turn them into findings using the country rules (API/countries/rules).
 * No country logic lives here; everything country-specific is rule data.
 *
 * All six countries are open: Colombia, Costa Rica, Mexico, Panama,
 * Portugal and Spain. Answers are the country's question keys (GET
 * /api/countries/:code/questions). The first Costa Rica check's answers
 * (booleans, residencyStatus "resident") are still accepted and translated.
 */

import {
  answersToFacts,
  type Answers,
  cleanAnswers,
  nextDue,
  ruleApplies,
} from "../countries/rules/engine.ts";
import { questionsFor, rulesFor, rulesetFor } from "../countries/rules/index.ts";
import { COUNTRY_CODES, type CountryCode, type LeadFinding, toCountryCode } from "../../schemas/contracts.ts";

/** Countries the check is open for: all six. */
export const CHECK_COUNTRIES: CountryCode[] = [...COUNTRY_CODES];

/** Legacy (first Costa Rica check) values, kept for older join profiles and seeds. */
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

/** Normalized answers: the country plus that country's question keys. */
export interface CheckAnswers {
  [key: string]: string | string[];
  country: CountryCode;
}

/** A finding as returned to the visitor: the contract fields plus the explanation. */
export interface CheckFinding extends LeadFinding {
  meaning: string;
  authority: string;
  reviewedByCounsel: boolean;
}

const yn = (v: unknown): string | undefined =>
  v === true || v === "true" || v === "yes" ? "yes" : v === false || v === "false" || v === "no" ? "no" : undefined;

/**
 * The first Costa Rica check (W3) sent booleans and its own residency values.
 * Translate them to the research questions so older answers keep working.
 */
export function legacyCostaRicaAnswers(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...r };
  const rs = r.residencyStatus;
  if (rs === "resident") out.residencyStatus = r.residencyCategory === "permanent" ? "permanent" : "temporary";
  else if (rs === "applying") out.residencyStatus = "pending";
  else if (rs === "visitor") out.residencyStatus = "none";
  else if (rs === "unsure") delete out.residencyStatus;
  if (typeof r.residencyExpiresAt === "string" && !r.residencyExpiryDate) out.residencyExpiryDate = r.residencyExpiresAt;
  for (const k of ["ownsProperty", "hasLocalWill"]) {
    const v = yn(r[k]);
    if (v) out[k] = v;
  }
  const veh = yn(r.ownsVehicle);
  if (veh === "yes") out.ownsVehicle = "yes"; // "Yes, I do not know the last digit"
  if (veh === "no") out.ownsVehicle = "no";
  const emp = yn(r.hasEmployees);
  if (emp === "yes") out.hasEmployees = "domestic"; // the usual case; both values match the same rules
  if (emp === "no") out.hasEmployees = "no";
  if (typeof r.hasCompany === "boolean" && !r.companyType) out.hasCompany = r.hasCompany ? "unsure" : "no";
  if (r.companyType === "SA" || r.companyType === "SRL") {
    if (!["active", "inactive", "unsure", "no"].includes(String(r.hasCompany))) out.hasCompany = "unsure";
  } else if (r.companyType === "none") {
    out.hasCompany = "no";
    delete out.companyType;
  } else if (r.companyType === "unsure") delete out.companyType;
  return out;
}

/**
 * Keep only known answer keys with valid values. Unknown keys are dropped so
 * the stored lead never carries arbitrary client input. A missing country is
 * Costa Rica (the first check had no country question).
 */
export function normalizeAnswers(raw: unknown): { answers: CheckAnswers | null; error?: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const country = r.country === undefined || r.country === "" ? "CR" : toCountryCode(r.country);
  if (!country || !CHECK_COUNTRIES.includes(country)) {
    return { answers: null, error: "Choose Colombia, Costa Rica, Mexico, Panama, Portugal or Spain." };
  }
  const input = country === "CR" ? legacyCostaRicaAnswers(r) : r;
  const clean = cleanAnswers(questionsFor(country), input);
  return { answers: { country, ...clean } };
}

function toAnswers(a: CheckAnswers): Answers {
  const { country: _c, ...rest } = a;
  return rest;
}

/**
 * Findings for the answers: every rule whose conditions match. Dated ones
 * first, soonest first; then the ones with no calendar date (ongoing duties,
 * events, or a date that depends on an answer not given), with `dueText`.
 */
export function evaluateCheck(answers: CheckAnswers, now: Date = new Date()): CheckFinding[] {
  const set = rulesetFor(answers.country);
  if (!set) return [];
  const facts = answersToFacts(set.questions, toAnswers(answers));
  const rules = rulesFor(answers.country);
  const lookup = (id: string) => rules.find((x) => x.id === id);
  const dated: CheckFinding[] = [];
  const undated: CheckFinding[] = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, facts)) continue;
    const due = nextDue(rule, facts, now, lookup);
    const f: CheckFinding = {
      ruleId: rule.id,
      title: rule.title,
      area: rule.area,
      meaning: rule.meaning,
      authority: rule.authority,
      confidence: rule.confidence,
      dueText: rule.dueText,
      reviewedByCounsel: rule.reviewedByCounsel,
    };
    if (due) {
      f.dueAt = due.dueAt.toISOString();
      if (due.windowStartAt) f.windowStartAt = due.windowStartAt.toISOString();
      dated.push(f);
    } else undated.push(f);
  }
  dated.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  return [...dated, ...undated];
}
