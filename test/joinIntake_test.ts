import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  checkAnswersFromProfile,
  FIRST_NEXT_STEP,
  firstMatterFrom,
  firstMatterId,
  inferArea,
  onboardingDetail,
  parseJoinDetails,
  titleFromQuestion,
} from "../API/payments/joinIntake.ts";
import { intakeWithFindings, profileFromAnswers, profileFromLead } from "../API/payments/membership.ts";
import { evaluateCheck, normalizeAnswers } from "../API/leads/deadlineCheck.ts";
import { COUNTRY_ANSWERS_FIELD, PROFILE_DETAIL_FIELDS, PROFILE_FIELDS, profileCompleteness } from "../schemas/contracts.ts";

/** T3: the guided join form. Run: deno test --allow-env test/joinIntake_test.ts */

const TODAY = "2026-10-27";

/** The demo member: US retiree, house in Guanacaste held by an S.A., no car, no staff. */
const full = () => ({
  email: "ruth.callahan@example.net",
  fullName: "Ruth Callahan",
  phone: "+1 503 555 0141",
  profile: {
    preferredName: "Ruth",
    preferredLanguage: "en",
    nationality: "United States",
    residenceCountry: "Costa Rica",
    residenceProvince: "Guanacaste",
    residenceTown: "Tamarindo",
    timezone: "America/Costa_Rica",
    maritalStatus: "married",
    livesWithPartner: true,
    childrenAtHome: 0,
    otherHousehold: 1,
    pets: "",
    residencyStatus: "applying",
    residencyCategory: "pensionado",
    ownsProperty: true,
    propertyType: "house",
    propertyLocation: "Guanacaste",
    propertyHolding: "company",
    companyType: "SA",
    companyCount: 1,
    companyUpToDate: "unsure",
    ownsVehicle: false,
    hasEmployees: false,
  },
  intake: {
    question: "Is my S.A. up to date with its filings? We bought the house through it in 2019.",
    urgency: "deadline",
    deadlineAt: "2027-01-31",
    documentsOnHand: ["passport", "property_title"],
  },
});

Deno.test("join details: the older short body needs nothing more", () => {
  const r = parseJoinDetails({ email: "a@b.co", fullName: "A B" }, TODAY);
  assertEquals(r, { profile: {}, intake: null, errors: {} });
});

Deno.test("join details: a full answer maps to profile keys from contracts", () => {
  const r = parseJoinDetails(full(), TODAY);
  assertEquals(r.errors, {});
  const known = new Set([...Object.values(PROFILE_FIELDS), ...Object.values(PROFILE_DETAIL_FIELDS)].flat());
  for (const k of Object.keys(r.profile)) assert(known.has(k), `${k} is not a profile key`);
  assertEquals(r.profile.phone, "+1 503 555 0141");
  assertEquals(r.profile.nationality, "United States");
  assertEquals(r.profile.hasCompany, true);
  assertEquals(r.profile.dependents, 1);
  assertEquals(r.profile.residencyCategory, "pensionado");
  assertEquals(r.profile.residenceProvince, "Guanacaste");
  assertEquals("pets" in r.profile, false); // empty optional answers are not written
  assertEquals(r.intake?.urgency, "deadline");
  assertEquals(r.intake?.deadlineAt, "2027-01-31T12:00:00.000Z");
  assertEquals(r.intake?.documentsOnHand, ["passport", "property_title"]);
});

Deno.test("join details: missing and invalid answers come back per field", () => {
  const b = full();
  b.phone = "call me";
  b.profile.preferredLanguage = "fr";
  b.profile.residenceProvince = "Texas";
  b.profile.propertyHolding = "";
  b.profile.companyCount = 0;
  b.intake.question = "Help";
  b.intake.deadlineAt = "2020-01-01";
  b.intake.documentsOnHand = [];
  const r = parseJoinDetails(b, TODAY);
  assertEquals(Object.keys(r.errors).sort(), [
    "companyCount", "deadlineAt", "documentsOnHand", "phone", "preferredLanguage", "propertyHolding", "question", "residenceProvince",
  ]);
  assertEquals(r.intake, null);
  assertEquals(r.profile, {});
});

Deno.test("join details: conditional questions only when they apply", () => {
  const b = full();
  Object.assign(b.profile, { residenceCountry: "Canada", residenceProvince: undefined, ownsProperty: false, companyType: "none", ownsVehicle: true, marchamoStatus: "yes", residencyStatus: "visitor" });
  // "None yet" is an answer too
  b.intake = { question: "Can I stay longer than 180 days as a tourist?", urgency: "no_rush", documentsOnHand: [], noDocumentsYet: true } as never;
  const r = parseJoinDetails(b, TODAY);
  assertEquals(r.errors, {});
  assertEquals(r.profile.hasCompany, false);
  assertEquals(r.profile.marchamoStatus, "yes");
  assertEquals("propertyType" in r.profile, false);
  assertEquals("residencyCategory" in r.profile, false);
  assertEquals(r.intake?.documentsOnHand, []);
});

Deno.test("join details: profile fields fill completeness (most of the profile from the form)", () => {
  const r = parseJoinDetails(full(), TODAY);
  const record = { ...r.profile, fullName: "Ruth Callahan", email: "ruth.callahan@example.net" };
  const c = profileCompleteness(record);
  // 14 counted fields; only dateOfBirth and residencyExpiresAt (still applying) are missing.
  assertEquals(Math.round(c.score * 100), 86);
  assertEquals(c.consultationReady, true);
  // detail keys never change the score
  assertEquals(profileCompleteness({ ...record, pets: "two dogs", companyCount: 3 }).score, c.score);
});

Deno.test("join details: lead answers carry over, including the detail keys", () => {
  const p = profileFromAnswers({ country: "CR", residencyStatus: "visitor", lastEntryDate: "2026-09-01", hasEmployees: true, junk: "x" });
  assertEquals(p, { residencyStatus: "visitor", lastEntryDate: "2026-09-01", hasEmployees: true });
});

Deno.test("join details: the situation answers give the check's findings", () => {
  const r = parseJoinDetails(full(), TODAY);
  const now = new Date("2026-10-27T12:00:00Z");
  const answers = normalizeAnswers(checkAnswersFromProfile(r.profile)).answers!;
  const expected = evaluateCheck(answers, now).map((f) => f.ruleId);
  const intake = intakeWithFindings(r.intake!, r.profile, now);
  assertEquals(intake.findings?.map((f) => f.ruleId), expected);
  assertEquals(expected.slice(0, 2), ["CR_PROP_MUNICIPAL_TAX", "CR_CORP_ENTITY_TAX"]);
  assert(expected.includes("CR_CORP_RTBF"));
  assertEquals(intake.findings?.some((f) => "meaning" in f), false);
});

Deno.test("first matter: title, area, next step and deadline", () => {
  const r = parseJoinDetails(full(), TODAY);
  const now = new Date("2026-10-28T15:00:00Z");
  const m = firstMatterFrom({ clientId: "ruth_callahan_example_net", membershipId: "mem_1", intake: r.intake!, profile: r.profile }, now);
  assertEquals(m.id, firstMatterId("mem_1"));
  assertEquals(m.title, "Is my S.A. up to date with its filings?");
  assertEquals(m.area, "corporate");
  assertEquals(m.stage, "intake");
  assertEquals(m.nextStep, { what: FIRST_NEXT_STEP, who: "client" });
  assertEquals(m.nextStepSetAt, now.toISOString());
  assertEquals(m.deadlineAt, "2027-01-31T12:00:00.000Z");
  assertEquals(m.documentsOnHand, ["passport", "property_title"]);
  assertEquals(m.source, "join");
});

Deno.test("first matter: area from words, then answers, else general", () => {
  assertEquals(inferArea("When does my DIMEX need renewing?"), "immigration");
  assertEquals(inferArea("Our housekeeper asked about aguinaldo"), "labor");
  assertEquals(inferArea("I want to transfer my car to my wife"), "vehicle");
  assertEquals(inferArea("Is the title on our condo clean?"), "real_estate");
  assertEquals(inferArea("Do I need a will in Costa Rica? I have a will at home"), "family_estate");
  assertEquals(inferArea("it's a question about what applies"), "general");
  assertEquals(inferArea("What should I ask first?", { hasCompany: true }), "corporate");
  assertEquals(inferArea("What should I ask first?", { hasCompany: true, residencyStatus: "applying" }), "general");
});

Deno.test("first matter: long questions make a short title", () => {
  const t = titleFromQuestion("We are thinking about buying a second lot next to our house in Atenas and want to know what checks we should do first before signing anything");
  assert(t.length <= 81, t);
  assert(t.endsWith("…"));
});

Deno.test("onboarding task detail: name, question and urgency", () => {
  const r = parseJoinDetails(full(), TODAY);
  assertEquals(
    onboardingDetail("Ruth Callahan", r.intake),
    'Ruth Callahan. First question: "Is my S.A. up to date with its filings? We bought the house through it in 2019.", deadline 2027-01-31',
  );
  assertEquals(onboardingDetail("Ruth Callahan", null), "Ruth Callahan");
  assertEquals(onboardingDetail("", { ...r.intake!, urgency: "soon", question: "x".repeat(300) })!.length, 'First question: ""'.length + 140 + ", wants an answer soon".length);
});

// ─── COUNTRIES: the join form for any of the six countries ─────────────────

/** A US couple in Valencia: non-lucrative residence, an apartment, no company. */
const spain = () => {
  const b = full();
  b.profile = {
    ...b.profile,
    residenceCountry: "Spain",
    residenceProvince: undefined,
    timezone: "Europe/Madrid",
    legalCountry: "ES",
    countryAnswers: {
      residencyStatus: "nonLucrative",
      permitExpiryDate: "2027-05-20",
      isTaxResident: "yes",
      region: "valencia",
      ownsProperty: "yes",
      rentsOutProperty: "no",
      ownsVehicle: "foreignLicenseOnly",
      hasCompany: "no",
      hasEmployees: "no",
      hasForeignAssetsOver50k: "yes",
      hasForeignCryptoOver50k: "no",
      evil: "<script>",
    },
  } as never;
  b.intake.question = "Do I need to renew my residence card before May, and what does the NIE cover?";
  return b;
};

Deno.test("join details (Spain): country answers are cleaned and give the shared profile fields", () => {
  const r = parseJoinDetails(spain(), TODAY);
  assertEquals(r.errors, {});
  assertEquals(r.profile.legalCountry, "ES");
  const ca = r.profile[COUNTRY_ANSWERS_FIELD] as Record<string, string>;
  assertEquals("evil" in ca, false);
  assertEquals(ca.residencyStatus, "nonLucrative");
  assertEquals(r.profile.residencyStatus, "nonLucrative");
  assertEquals(r.profile.residencyExpiresAt, "2027-05-20");
  assertEquals(r.profile.ownsProperty, true);
  assertEquals(r.profile.hasCompany, false);
  assertEquals(r.profile.ownsVehicle, false); // drives on a foreign licence, owns no car
  assertEquals(r.profile.hasEmployees, false);
  assertEquals(checkAnswersFromProfile(r.profile).country, "ES");
  const intake = intakeWithFindings(r.intake!, r.profile, new Date("2026-10-27T12:00:00Z"));
  const ids = intake.findings!.map((f) => f.ruleId);
  assert(ids.includes("ES_IMM_NLV_RENEWAL") && ids.includes("ES_TAX_720") && ids.includes("ES_VEH_LICENSE"));
  assert(ids.every((id) => id.startsWith("ES_")));
  assertEquals(inferArea(r.intake!.question, r.profile), "immigration");
});

Deno.test("join details (any country): unanswered situation questions come back per question", () => {
  const b = spain();
  (b.profile as Record<string, unknown>).countryAnswers = { residencyStatus: "visitor" };
  const r = parseJoinDetails(b, TODAY);
  const keys = Object.keys(r.errors).sort();
  assert(keys.includes("countryAnswers.ownsProperty") && keys.includes("countryAnswers.hasCompany"));
  assertEquals(keys.includes("countryAnswers.permitExpiryDate"), false); // dates are optional
  const bad = spain();
  (bad.profile as Record<string, unknown>).legalCountry = "US";
  assertEquals(Object.keys(parseJoinDetails(bad, TODAY).errors), ["legalCountry"]);
});

Deno.test("join details: lead answers from the check become the country answers map", () => {
  const p = profileFromLead({ country: "CO", answers: { country: "CO", residencyStatus: "visa_R_pre2022", ownsProperty: "medellin" } });
  assertEquals(p.legalCountry, "CO");
  assertEquals(p[COUNTRY_ANSWERS_FIELD], { residencyStatus: "visa_R_pre2022", ownsProperty: "medellin" });
  assertEquals(p.residencyStatus, "visa_R_pre2022");
});
