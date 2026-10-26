import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { evaluateCheck, normalizeAnswers } from "../API/leads/deadlineCheck.ts";

/**
 * Free deadline check (W3). Demo script step 1: a US retiree with a
 * Guanacaste house and a Costa Rican S.A., residency application in progress,
 * gets three dated findings, including the annual corporation tax.
 */
const NOW = new Date("2026-10-26T15:00:00.000Z");

Deno.test("demo retiree gets 3 dated findings incl. corporation tax", () => {
  const { answers } = normalizeAnswers({
    country: "CR",
    residencyStatus: "applying",
    ownsProperty: true,
    propertyLocation: "Guanacaste",
    companyType: "SA",
    ownsVehicle: false,
    hasEmployees: false,
  });
  const findings = evaluateCheck(answers!, NOW);
  assertEquals(findings.map((f) => [f.ruleId, f.dueAt!.slice(0, 10)]), [
    ["CR_CHECK_MUNICIPAL_TAX", "2026-12-31"],
    ["CR_CHECK_CORPORATION_TAX", "2027-01-31"],
    ["CR_CHECK_BENEFICIAL_OWNER", "2027-04-30"],
  ]);
});

Deno.test("resident DIMEX renewal opens 90 days before expiry", () => {
  const { answers } = normalizeAnswers({
    residencyStatus: "resident",
    residencyExpiresAt: "2027-03-15",
  });
  const f = evaluateCheck(answers!, NOW).find((x) => x.ruleId === "CR_CHECK_DIMEX_RENEWAL");
  assertEquals(f?.dueAt?.slice(0, 10), "2026-12-15");
});

Deno.test("unknown keys are dropped and other countries are refused", () => {
  const { answers } = normalizeAnswers({ residencyStatus: "visitor", evil: "<script>" });
  assertEquals(Object.keys(answers!).sort(), ["country", "residencyStatus"]);
  assertEquals(normalizeAnswers({ country: "PA" }).answers, null);
});

Deno.test("every finding is worded as may require review", () => {
  const { answers } = normalizeAnswers({
    residencyStatus: "resident",
    residencyExpiresAt: "2027-06-01",
    ownsProperty: true,
    companyType: "SRL",
    ownsVehicle: true,
    hasEmployees: true,
  });
  const findings = evaluateCheck(answers!, NOW);
  assertEquals(findings.length, 8);
  for (const f of findings) assertEquals(f.title.endsWith("may require review"), true);
});
