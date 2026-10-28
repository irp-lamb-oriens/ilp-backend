import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { COUNTRIES, COUNTRY_CODES, toCountryCode } from "../schemas/contracts.ts";
import {
  answersToFacts,
  type CountryRule,
  type DueRule,
  type Facts,
  nextDue,
  questionShown,
  rollWeekend,
  ruleApplies,
  RULE_AREAS,
} from "../API/countries/rules/engine.ts";
import { ALL_RULES, LEGACY_RULE_IDS, questionsFor, ruleById, RULESETS, rulesFor } from "../API/countries/rules/index.ts";
import { evaluateCheck, normalizeAnswers } from "../API/leads/deadlineCheck.ts";

/**
 * COUNTRIES: the six rulesets imported from docs/research (rules/<code>.ts,
 * scripts/importCountryResearch.py). Run: deno test test/countryRules_test.ts
 */

const ymd = (d: Date | null | undefined) => d ? d.toISOString().slice(0, 10) : null;
const at = (s: string) => new Date(`${s}T15:00:00.000Z`);
const due = (d: DueRule, facts: Facts = {}, now = "2026-10-27", roll?: "next" | "previous") => nextDue({ due: d, rollWeekend: roll }, facts, at(now));

Deno.test("all six countries are open and have rules and questions", () => {
  assertEquals([...COUNTRY_CODES].sort(), ["CO", "CR", "ES", "MX", "PA", "PT"]);
  const counts = Object.fromEntries(COUNTRY_CODES.map((c) => [c, rulesFor(c).length]));
  assertEquals(counts, { CO: 49, CR: 35, MX: 37, PA: 33, PT: 39, ES: 37 });
  for (const c of COUNTRY_CODES) {
    assertEquals(COUNTRIES[c].status, "open");
    assert(questionsFor(c, "check").length >= 9, `${c} has free-check questions`);
    assert(COUNTRIES[c].timeZones.some((z) => z.id === COUNTRIES[c].defaultTimeZone), `${c} default time zone is listed`);
    assert(COUNTRIES[c].lawyerBody.name && COUNTRIES[c].lawyerBody.numberLabel, `${c} lawyer body`);
    for (const r of rulesFor(c)) assertEquals(r.country, c);
  }
  assertEquals(ALL_RULES.length, 230);
  assertEquals(COUNTRIES.ES.timeZones.map((z) => z.id), ["Europe/Madrid", "Atlantic/Canary"]);
  assertEquals(COUNTRIES.PT.timeZones.map((z) => z.id), ["Europe/Lisbon", "Atlantic/Azores"]);
  assertEquals(COUNTRIES.MX.defaultTimeZone, "America/Mexico_City");
});

Deno.test("every rule's conditions reference questions (or answer facts) that exist, with possible values", () => {
  for (const c of COUNTRY_CODES) {
    const qs = questionsFor(c);
    const values = new Map<string, Set<string>>();
    const add = (k: string, v: string) => values.set(k, new Set([...(values.get(k) ?? []), v]));
    for (const q of qs) {
      if (q.type === "date") {
        add(q.key, "<date>");
        for (const t of Object.values(q.dateAs?.map ?? {})) add(t, "<date>");
      }
      for (const o of q.options) {
        add(q.key, o.value);
        for (const [k, v] of Object.entries(o.sets ?? {})) for (const x of Array.isArray(v) ? v : [v]) add(k, x);
      }
      for (const [k, allowed] of Object.entries(q.showIf ?? {})) {
        assert(qs.some((x) => x.key === k), `${c} ${q.key}: showIf ${k} is a question`);
        for (const v of allowed) assert(values.get(k)?.has(v) || qs.find((x) => x.key === k)?.options.some((o) => o.value === v), `${c} ${q.key}: showIf ${k}=${v}`);
      }
    }
    assertEquals(new Set(qs.map((q) => q.key)).size, qs.length, `${c}: question keys are unique`);
    for (const r of rulesFor(c)) {
      const groups = [r.when.all, ...(r.when.anyOf ?? []), ...(r.when.unless ? [r.when.unless] : [])];
      for (const g of groups) {
        for (const [k, allowed] of Object.entries(g)) {
          assert(values.has(k), `${r.id}: condition key "${k}" has no question`);
          for (const v of allowed) assert(values.get(k)!.has(v), `${r.id}: ${k}=${v} is not a possible answer`);
        }
      }
      assert(Object.keys(r.when.all).length || r.when.anyOf?.length, `${r.id} has at least one condition`);
    }
  }
});

Deno.test("every rule keeps its research fields, sources and the counsel flag", () => {
  for (const r of ALL_RULES) {
    assert(r.title.endsWith("may require review"), `${r.id} title`);
    assert(r.meaning.length > 20, `${r.id} meaning`);
    assert(r.dueText.length > 3, `${r.id} dueText`);
    assert(r.authority.length > 1, `${r.id} authority`);
    assert(["high", "medium", "low"].includes(r.confidence), `${r.id} confidence`);
    assertEquals(r.reviewedByCounsel, false, `${r.id} not yet reviewed by counsel`);
    assert(Array.isArray(r.sources), `${r.id} sources`);
    if (r.confidence !== "low") assert(r.sources.length > 0 && r.sources.every((s) => s.startsWith("http")), `${r.id} has sources`);
    assert(RULE_AREAS.includes(r.area), `${r.id} area ${r.area}`);
    for (const t of [r.title, r.meaning, r.dueText, r.consequence]) assert(!/[–—]/.test(t), `${r.id}: no em or en dash`);
    if (r.due.kind === "sameAs") assert(ruleById(r.due.ruleId)?.country === r.country, `${r.id} sameAs`);
  }
  const low = Object.fromEntries(COUNTRY_CODES.map((c) => [c, rulesFor(c).filter((r) => r.confidence === "low").length]));
  assertEquals(low, { CO: 6, CR: 6, MX: 2, PA: 3, PT: 2, ES: 1 });
});

Deno.test("due: annual, with weekend roll forward and back", () => {
  assertEquals(ymd(due({ kind: "annual", on: [3, 31] })?.dueAt), "2027-03-31");
  assertEquals(ymd(due({ kind: "annual", on: [12, 20] })?.dueAt), "2026-12-20");
  // Costa Rica corporation tax: 31 January 2026 was a Saturday, so it moved to Monday 2 February.
  const entity = ruleById("CR_CORP_ENTITY_TAX")!;
  assertEquals(entity.rollWeekend, "next");
  assertEquals(ymd(nextDue(entity, {}, at("2026-01-10"))?.dueAt), "2026-02-02");
  assertEquals(ymd(rollWeekend(new Date("2029-06-30T12:00:00Z"), "previous")), "2029-06-29");
  // "Last business day": June 30, 2029 is a Saturday.
  assertEquals(ymd(nextDue(ruleById("CR_CORP_PARTIAL_PAYMENTS")!, {}, at("2029-06-01"))?.dueAt), "2029-06-29");
  // Window start kept (marchamo: November 1 to December 31).
  const m = nextDue(ruleById("CR_VEH_MARCHAMO")!, {}, at("2026-10-27"));
  assertEquals([ymd(m?.windowStartAt), ymd(m?.dueAt)], ["2026-11-01", "2026-12-31"]);
});

Deno.test("due: installments, windows (also across the year end) and once", () => {
  assertEquals(ymd(due({ kind: "installments", dates: [[4, 30], [8, 31], [12, 31]] })?.dueAt), "2026-12-31");
  assertEquals(ymd(due({ kind: "installments", dates: [[4, 30], [8, 31]] })?.dueAt), "2027-04-30");
  const irpf = nextDue(ruleById("ES_TAX_IRPF")!, {}, at("2026-10-27"));
  assertEquals([ymd(irpf?.windowStartAt), ymd(irpf?.dueAt)], ["2027-04-08", "2027-06-30"]);
  // Medellín predial: the fourth-quarter window runs October 30 to December 1.
  const q4 = nextDue(ruleById("CO_PROP_PREDIAL_MEDELLIN")!, {}, at("2026-11-15"));
  assertEquals([ymd(q4?.windowStartAt), ymd(q4?.dueAt)], ["2026-10-30", "2026-12-01"]);
  // Spain VAT: January 1 to 30 is the fourth-quarter window.
  const vat = nextDue(ruleById("ES_CO_VAT_303")!, {}, at("2026-10-27"));
  assertEquals([ymd(vat?.windowStartAt), ymd(vat?.dueAt)], ["2027-01-01", "2027-02-01"]); // January 30, 2027 is a Saturday
  assertEquals(ymd(due({ kind: "once", dates: ["2027-12-03"] })?.dueAt), "2027-12-03");
  assertEquals(due({ kind: "once", dates: ["2026-07-01", "2026-07-15"] }), null); // all past
});

Deno.test("due: monthly, business days, relative, by answer, by ID digits, same as, event and ongoing", () => {
  assertEquals(ymd(due({ kind: "monthly", day: 15 })?.dueAt), "2026-11-15");
  assertEquals(ymd(due({ kind: "monthly", day: 15 }, {}, "2026-10-27", "next")?.dueAt), "2026-11-16"); // Sunday → Monday
  assertEquals(ymd(due({ kind: "monthly", day: null })?.dueAt), "2026-10-31");
  const pila = due({ kind: "monthlyBusinessDays", from: 2, to: 16 }, {}, "2026-10-27");
  assertEquals([ymd(pila?.windowStartAt), ymd(pila?.dueAt)], ["2026-11-03", "2026-11-23"]);
  // Relative to an answer: expiry minus 90 days, window from minus 120.
  const dimex = due({ kind: "relative", anchor: "residencyExpiryDate", days: -90, windowStartDays: -120 }, { residencyExpiryDate: ["2027-03-15"] });
  assertEquals([ymd(dimex?.windowStartAt), ymd(dimex?.dueAt)], ["2026-11-15", "2026-12-15"]);
  assertEquals(due({ kind: "relative", anchor: "residencyExpiryDate", days: -90 }), null); // no answer, no date
  assertEquals(ymd(due({ kind: "relative", anchor: "x", months: 6 }, { x: ["2026-08-31"] })?.dueAt), "2027-02-28");
  assertEquals(ymd(due({ kind: "relative", anchor: "x", years: 5 }, { x: ["2024-02-29"] })?.dueAt), "2029-02-28");
  assertEquals(ymd(due({ kind: "relative", anchor: "x", businessDays: 15 }, { x: ["2026-10-23"] })?.dueAt), "2026-11-13");
  assertEquals(ymd(due({ kind: "relative", anchor: "x", endOfMonthAfter: 1 }, { x: ["2026-10-05"] })?.dueAt), "2026-11-30");
  assertEquals(ymd(due({ kind: "relative", anchor: "x", years: 1, annual: true }, { x: ["2019-03-10"] })?.dueAt), "2027-03-10");
  assertEquals(ymd(due({ kind: "relative", anchor: "fiscalYearEnd", months: 3, fallback: [3, 31] })?.dueAt), "2027-03-31");
  assertEquals(ymd(due({ kind: "annualByAnswer", answer: "incorporationHalf", map: { jan_jun: [7, 15], jul_dec: [1, 15] } }, { incorporationHalf: ["jul_dec"] })?.dueAt), "2027-01-15");
  // Costa Rica inspection month from the last plate digit: 0 is October.
  assertEquals(ymd(nextDue(ruleById("CR_VEH_RTV")!, { plateLastDigit: ["0"] }, at("2026-10-27"))?.dueAt), "2026-10-31");
  assertEquals(ymd(nextDue(ruleById("CR_VEH_RTV")!, { plateLastDigit: ["3"] }, at("2026-10-27"))?.dueAt), "2027-03-31");
  assertEquals(ymd(due({ kind: "monthByAnswer", answer: "m", offsetDays: -30 }, { m: ["2"] }, "2026-10-27")?.dueAt), "2027-01-29");
  // Colombia individual income tax: the NIT-digit table summarized to August 12 to October 26.
  const renta = nextDue(ruleById("CO_TAX_RENTA_INDIVIDUAL")!, {}, at("2026-10-27"));
  assertEquals([ymd(renta?.windowStartAt), ymd(renta?.dueAt)], ["2027-08-12", "2027-10-26"]);
  const lookup = (id: string) => ruleById(id);
  assertEquals(ymd(nextDue(ruleById("CO_TAX_FOREIGN_ASSETS")!, {}, at("2026-10-27"), lookup)?.dueAt), "2027-10-26");
  assertEquals(due({ kind: "event", trigger: "sale" }), null);
  assertEquals(due({ kind: "ongoing" }), null);
});

Deno.test("Colombia: older resident visas must be transferred (traspaso) before 2026-10-31", () => {
  const rule = ruleById("CO_IMM_RESIDENT_TRASPASO_2026")!;
  assertEquals(rule.confidence, "high");
  assertEquals(rule.due, { kind: "once", dates: ["2026-10-31"] });
  const { answers } = normalizeAnswers({ country: "CO", residencyStatus: "visa_R_pre2022" });
  const f = evaluateCheck(answers!, at("2026-10-27"));
  assertEquals(f[0].ruleId, "CO_IMM_RESIDENT_TRASPASO_2026");
  assertEquals(f[0].dueAt?.slice(0, 10), "2026-10-31");
  // After the date it stays on the list, with no date, so nobody is told it has gone away.
  const later = evaluateCheck(answers!, at("2026-11-05")).find((x) => x.ruleId === "CO_IMM_RESIDENT_TRASPASO_2026");
  assertEquals(later?.dueAt, undefined);
  assert(later?.dueText?.includes("October 31, 2026"));
});

Deno.test("answers set facts: company kinds, multi-value answers, date aliases and exclusions", () => {
  const facts = (c: string, a: Record<string, string | string[]>) => answersToFacts(questionsFor(c), a);
  assertEquals(facts("CR", { hasCompany: "active" }).hasCompany, ["yes"]);
  assertEquals(facts("CR", { hasCompany: "active" }).companyActivity, ["active"]);
  assertEquals(facts("CR", { ownsVehicle: "7" }).plateLastDigit, ["7"]);
  assertEquals(facts("MX", { rentsOutProperty: "both" }).rentsOutProperty, ["yes", "long_term", "short_term_platform", "both"]);
  assertEquals(facts("PA", { residencyStatus: "tourist", keyDate: "2026-09-01" }).entryDate, ["2026-09-01"]);
  assertEquals(facts("PA", { residencyStatus: "permanent_resident", keyDate: "2030-01-01" }).idCardExpiryDate, ["2030-01-01"]);
  // Spain: the Basque Country and Navarra set their own income tax dates.
  const irpf = ruleById("ES_TAX_IRPF")!;
  assertEquals(ruleApplies(irpf, facts("ES", { isTaxResident: "yes", region: "madrid" })), true);
  assertEquals(ruleApplies(irpf, facts("ES", { isTaxResident: "yes", region: "paisVasco_navarra" })), false);
  // A follow-up is only kept when its parent answer shows it.
  const cat = questionsFor("CR").find((q) => q.key === "residencyCategory")!;
  assertEquals(questionShown(cat, { residencyStatus: "temporary" }), true);
  assertEquals(questionShown(cat, { residencyStatus: "permanent" }), false);
  assertEquals(normalizeAnswers({ country: "CR", residencyStatus: "permanent", residencyCategory: "rentista" }).answers, { country: "CR", residencyStatus: "permanent" });
});

Deno.test("low-confidence rules stay in, flagged, for every country that has them", () => {
  const { answers } = normalizeAnswers({ country: "CR", residencyStatus: "temporary", residencyExpiryDate: "2027-03-01" });
  const watch = evaluateCheck(answers!, at("2026-10-27")).find((f) => f.ruleId === "CR_TAX_FOREIGN_INCOME_WATCH");
  assertEquals(watch?.confidence, "low");
  assertEquals(watch?.dueAt, undefined);
  for (const r of ALL_RULES.filter((x) => x.confidence === "low")) assert(r.notes.length > 0 || r.dueText.length > 0, `${r.id} explains why`);
});

Deno.test("country codes: stored names and legacy ids still resolve", () => {
  assertEquals(toCountryCode("Costa Rica"), "CR");
  assertEquals(toCountryCode("cr"), "CR");
  assertEquals(toCountryCode("España"), "ES");
  assertEquals(toCountryCode("Panamá"), "PA");
  assertEquals(toCountryCode("Atlantis"), null);
  for (const [old, now] of Object.entries(LEGACY_RULE_IDS)) if (now) assertEquals(ruleById(old)?.id, now);
  assertEquals(Object.keys(RULESETS).length, 6);
  const sample: CountryRule = ruleById("PT_PROP_IMI")!;
  assertEquals(sample.rollWeekend, "next");
});
