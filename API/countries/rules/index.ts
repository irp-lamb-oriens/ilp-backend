/**
 * API/countries/rules/index.ts: the six country rulesets, one place to look
 * them up. Data files are generated (scripts/importCountryResearch.py).
 */
import { COUNTRY_CODES, type CountryCode, toCountryCode } from "../../../schemas/contracts.ts";
import type { CountryQuestion, CountryRule, CountryRuleset } from "./engine.ts";
import { CO_RULESET } from "./co.ts";
import { CR_RULESET } from "./cr.ts";
import { ES_RULESET } from "./es.ts";
import { MX_RULESET } from "./mx.ts";
import { PA_RULESET } from "./pa.ts";
import { PT_RULESET } from "./pt.ts";

export const RULESETS: Record<CountryCode, CountryRuleset> = {
  CO: CO_RULESET,
  CR: CR_RULESET,
  PA: PA_RULESET,
  MX: MX_RULESET,
  ES: ES_RULESET,
  PT: PT_RULESET,
};

export function rulesetFor(country: unknown): CountryRuleset | null {
  const code = toCountryCode(country);
  return code ? RULESETS[code] : null;
}

/** Rules of one country, in research order. */
export const rulesFor = (country: unknown): CountryRule[] => rulesetFor(country)?.rules ?? [];

/** Questions of one country; `stage` limits to the free check or the profile ones. */
export function questionsFor(country: unknown, stage?: CountryQuestion["stage"]): CountryQuestion[] {
  const qs = rulesetFor(country)?.questions ?? [];
  return stage ? qs.filter((q) => q.stage === stage) : qs;
}

/** Every rule of every country. */
export const ALL_RULES: CountryRule[] = COUNTRY_CODES.flatMap((c) => RULESETS[c].rules);

/**
 * Rule ids of the first Costa Rica check (W3), kept so obligations stored
 * with them still resolve to the research rule that replaced them.
 */
export const LEGACY_RULE_IDS: Record<string, string | null> = {
  CR_CHECK_DIMEX_RENEWAL: "CR_IMM_TEMP_RENEWAL",
  CR_CHECK_CCSS_MEMBER: "CR_IMM_CCSS_CONTRIBUTIONS",
  CR_CHECK_VISITOR_STAY: null,
  CR_CHECK_MUNICIPAL_TAX: "CR_PROP_MUNICIPAL_TAX",
  CR_CHECK_CORPORATION_TAX: "CR_CORP_ENTITY_TAX",
  CR_CHECK_BENEFICIAL_OWNER: "CR_CORP_RTBF",
  CR_CHECK_MARCHAMO: "CR_VEH_MARCHAMO",
  CR_CHECK_AGUINALDO: "CR_LAB_AGUINALDO",
  CR_CHECK_EMPLOYER_CCSS: "CR_LAB_CCSS_EMPLOYER",
};

const BY_ID = new Map(ALL_RULES.map((r) => [r.id, r]));

/** A rule by id (legacy CR_CHECK_* ids included). */
export function ruleById(id: string): CountryRule | undefined {
  const direct = BY_ID.get(id);
  if (direct) return direct;
  const mapped = LEGACY_RULE_IDS[id];
  return mapped ? BY_ID.get(mapped) : undefined;
}
