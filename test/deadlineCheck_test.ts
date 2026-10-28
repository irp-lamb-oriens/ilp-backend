import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { evaluateCheck, normalizeAnswers } from "../API/leads/deadlineCheck.ts";

/**
 * Free deadline check (W3, COUNTRIES). Demo script step 1: a US retiree with
 * a Guanacaste house and a Costa Rican S.A., residency application in
 * progress. The first check's answers (booleans, "applying") still work.
 */
const NOW = new Date("2026-10-26T15:00:00.000Z");
const dated = (f: { ruleId: string; dueAt?: string }[]) => f.filter((x) => x.dueAt).map((x) => [x.ruleId, x.dueAt!.slice(0, 10)]);

Deno.test("demo retiree (older Costa Rica answers) gets property and company dates, soonest first", () => {
  const { answers } = normalizeAnswers({
    country: "CR",
    residencyStatus: "applying",
    ownsProperty: true,
    propertyLocation: "Guanacaste",
    companyType: "SA",
    ownsVehicle: false,
    hasEmployees: false,
  });
  assertEquals(answers, { country: "CR", residencyStatus: "pending", ownsProperty: "yes", hasCompany: "unsure", companyType: "SA", ownsVehicle: "no", hasEmployees: "no" });
  const findings = evaluateCheck(answers!, NOW);
  const d = dated(findings);
  assertEquals(d[0], ["CR_PROP_MUNICIPAL_TAX", "2026-12-31"]);
  // January 31, 2027 is a Sunday: the corporation tax moves to Monday.
  assertEquals(d[1], ["CR_CORP_ENTITY_TAX", "2027-02-01"]);
  assert(d.some(([id]) => id === "CR_CORP_RTBF"));
  for (let i = 1; i < d.length; i++) assert(d[i - 1][1] <= d[i][1], "dated findings are sorted");
  // Undated ones come last and say when instead.
  const undated = findings.filter((f) => !f.dueAt);
  assert(undated.length > 0 && findings.indexOf(undated[0]) === d.length);
  for (const f of undated) assert(f.dueText && f.dueText.length > 3, `${f.ruleId} explains when`);
});

Deno.test("resident DIMEX renewal opens 90 days before expiry", () => {
  const { answers } = normalizeAnswers({ country: "CR", residencyStatus: "temporary", residencyExpiryDate: "2027-03-15" });
  const f = evaluateCheck(answers!, NOW).find((x) => x.ruleId === "CR_IMM_TEMP_RENEWAL");
  assertEquals(f?.dueAt?.slice(0, 10), "2026-12-15");
  assertEquals(f?.windowStartAt?.slice(0, 10), "2026-11-15");
  // The older form's "resident" with an expiry date gives the same.
  const legacy = normalizeAnswers({ residencyStatus: "resident", residencyExpiresAt: "2027-03-15" }).answers!;
  assertEquals(evaluateCheck(legacy, NOW).find((x) => x.ruleId === "CR_IMM_TEMP_RENEWAL")?.dueAt, f?.dueAt);
});

Deno.test("unknown keys and values are dropped; every one of the six countries is open", () => {
  const { answers } = normalizeAnswers({ country: "CR", residencyStatus: "none", evil: "<script>", ownsProperty: "maybe" });
  assertEquals(answers, { country: "CR", residencyStatus: "none" });
  for (const c of ["CO", "CR", "PA", "MX", "ES", "PT", "Spain", "panamá"]) assert(normalizeAnswers({ country: c }).answers, `${c} is open`);
  assertEquals(normalizeAnswers({ country: "US" }).answers, null);
});

Deno.test("each country gives its own findings, worded as may require review", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ country: "CO", residencyStatus: "visa_M", ownsProperty: "bogota", hasCompany: "yes", hasEmployees: "yes_colombian" }, "CO_CO_MATRICULA_RENEWAL"],
    [{ country: "PA", residencyStatus: "provisional_resident", ownsProperty: "yes_primary_home", hasCompany: "sociedad_anonima", incorporationHalf: "jan_jun" }, "PA_CORP_TASA_UNICA"],
    [{ country: "MX", residencyStatus: "temporary", residencyCardExpiry: "2027-02-01", ownsProperty: "yes", holdingStructure: "fideicomiso", propertyInRestrictedZone: "yes" }, "MX_IMM_TEMP_RENEWAL"],
    [{ country: "ES", residencyStatus: "nonLucrative", permitExpiryDate: "2027-01-10", isTaxResident: "yes", ownsProperty: "yes" }, "ES_IMM_NLV_RENEWAL"],
    [{ country: "PT", residencyStatus: "temporary_resident", permitExpiryDate: "2027-02-01", ownsProperty: "yes", isTaxResident: "yes" }, "PT_IMM_PERMIT_RENEWAL"],
  ];
  for (const [raw, expected] of cases) {
    const { answers } = normalizeAnswers(raw);
    const findings = evaluateCheck(answers!, NOW);
    const hit = findings.find((f) => f.ruleId === expected);
    assert(hit?.dueAt, `${raw.country}: ${expected} has a date`);
    for (const f of findings) {
      assert(f.title.endsWith("may require review"), f.ruleId);
      assert(f.ruleId.startsWith(String(answers!.country)), `${f.ruleId} belongs to ${answers!.country}`);
      assertEquals(f.reviewedByCounsel, false);
    }
  }
  const pa = evaluateCheck(normalizeAnswers(cases[1][0]).answers!, NOW).find((f) => f.ruleId === "PA_CORP_TASA_UNICA");
  assertEquals(pa?.dueAt?.slice(0, 10), "2027-07-15");
});
