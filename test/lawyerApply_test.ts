import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  applicationBlocksCalls,
  applicationTaskId,
  type ApplyDeps,
  isProviderBookable,
  PARTNER_TERMS_VERSION,
  providerLoginBlock,
  providerStatus,
  reviewApplication,
  submitApplication,
  validateApplication,
} from "../API/providers/applyLogic.ts";
import { LEGAL_VERSIONS } from "../API/privacy/policy.ts";
import { lawyerApplyEmails } from "../API/providers/applyEmails.ts";

type Doc = Record<string, unknown>;
const NOW = new Date("2026-10-27T15:00:00Z");

function body(over: Doc = {}): Doc {
  return {
    name: "Mariela Quesada Rojas",
    email: "Mariela@QuesadaLegal.cr",
    phone: "+506 8812 3456",
    languages: ["es", "en"],
    city: "Escazú",
    province: "San José",
    carne: "21.345",
    yearAdmitted: 2009,
    notary: true,
    notaryCarne: "8765",
    firmName: "Quesada Legal",
    firmWebsite: "quesadalegal.cr",
    yearsInPractice: 16,
    areas: ["immigration", "real_estate"],
    areaComfort: { immigration: "regular", real_estate: "sometimes", tax: "regular" },
    weekly: [{ day: 2, start: "09:00", end: "12:00" }, { day: 4, start: "14:00", end: "17:00" }],
    callsPerWeek: 6,
    minNoticeHours: 24,
    hourlyRateCents: 12000,
    flatFeesCents: { residency: 150000, will: "" },
    quotePreference: "flat",
    invoicingEntity: "firm",
    bio: "I help foreigners with residency and property in Costa Rica. Fifteen years in practice in Escazú, notary public, English and Spanish.",
    agreements: { licensedInGoodStanding: true, partnerTerms: true, partnerTermsVersion: PARTNER_TERMS_VERSION, privacy: true, privacyVersion: LEGAL_VERSIONS.privacy, carneVerification: true },
    elapsedMs: 240000,
    ...over,
  };
}

function fakeDeps(seed: Doc[] = []) {
  const providers = new Map<string, Doc>(seed.map((p) => [String(p.id), p]));
  const tasks = new Map<string, Doc>();
  const availability = new Map<string, Doc>();
  const consents: Doc[] = [];
  const audits: Doc[] = [];
  const mails: Doc[] = [];
  let n = 0;
  const deps: ApplyDeps = {
    now: () => NOW,
    findProviderByEmail: (email) => Promise.resolve([...providers.values()].find((p) => p.email === email) ?? null),
    getProvider: (id) => Promise.resolve(providers.has(id) ? { ...providers.get(id)!, id } : null),
    writeProvider: (id, fields, create) => {
      providers.set(id, create ? { ...fields, id } : { ...(providers.get(id) ?? {}), ...fields });
      return Promise.resolve();
    },
    writeAvailability: (id, doc) => {
      availability.set(id, doc as unknown as Doc);
      return Promise.resolve();
    },
    getTask: (id) => Promise.resolve(tasks.get(id) ?? null),
    writeTask: (id, fields, create) => {
      tasks.set(id, create ? fields : { ...(tasks.get(id) ?? {}), ...fields });
      return Promise.resolve();
    },
    writeConsent: (r) => {
      consents.push(r as unknown as Doc);
      return Promise.resolve();
    },
    audit: (e) => {
      audits.push(e as unknown as Doc);
      return Promise.resolve();
    },
    sendEmail: (m) => {
      mails.push(m as unknown as Doc);
      return Promise.resolve();
    },
    emails: lawyerApplyEmails,
    urls: { signIn: "https://ilp.test/lawyer", apply: "https://ilp.test/lawyers/apply" },
    ownerEmail: "csm@ilp.legal",
    consentId: () => `cns_${++n}`,
  };
  return { deps, providers, tasks, availability, consents, audits, mails };
}

Deno.test("validation: a complete application passes and is cleaned", () => {
  const r = validateApplication(body(), NOW);
  assert("value" in r, JSON.stringify("errors" in r ? r.errors : {}));
  const v = r.value;
  assertEquals(v.email, "mariela@quesadalegal.cr");
  assertEquals(v.carne, "21345");
  assertEquals(v.firmWebsite, "https://quesadalegal.cr");
  assertEquals(v.flatFeesCents, { residency: 150000 });
  assertEquals(v.areaComfort, { immigration: "regular", real_estate: "sometimes" }, "comfort only for chosen areas");
  assertEquals(v.weekly.length, 2);
});

Deno.test("validation: missing and wrong answers get one plain error per field", () => {
  const r = validateApplication(
    body({
      name: "",
      email: "not-an-email",
      carne: "AB12",
      yearAdmitted: 2030,
      notary: true,
      notaryCarne: "",
      areas: [],
      weekly: [],
      hourlyRateCents: 0,
      flatFeesCents: { residency: "abc" },
      bio: "Too short.",
      agreements: { licensedInGoodStanding: true, partnerTerms: true, privacy: false, carneVerification: false },
    }),
    NOW,
  );
  assert("errors" in r);
  for (const k of ["name", "email", "carne", "yearAdmitted", "notaryCarne", "areas", "weekly", "hourlyRateCents", "fee_residency", "bio", "privacy", "carneVerification"]) {
    assert(r.errors[k], `expected an error for ${k}`);
  }
  assertEquals(r.errors.licensedInGoodStanding, undefined);
  assert(!/[–—]/.test(Object.values(r.errors).join(" ")), "no dashes in error copy");
});

Deno.test("validation: an outdated terms version is refused; years in practice must fit the admission year", () => {
  const old = validateApplication(body({ agreements: { ...(body().agreements as Doc), partnerTermsVersion: "partner-terms-old" } }), NOW);
  assert("errors" in old && old.errors.partnerTerms);
  const years = validateApplication(body({ yearAdmitted: 2020, yearsInPractice: 20 }), NOW);
  assert("errors" in years && years.errors.yearsInPractice);
});

Deno.test("submit: creates a pending_review provider that is not active, with availability, task, consents, audit and email", async () => {
  const f = fakeDeps();
  const r = await submitApplication(body(), f.deps, "203.0.113.9");
  assertEquals(r.status, 201);
  const id = (r.body as { providerId: string }).providerId;
  const p = f.providers.get(id)!;
  assertEquals(p.status, "pending_review");
  assertEquals(p.active, false);
  assertEquals(isProviderBookable(p), false);
  assertEquals(applicationBlocksCalls(p), true);
  assertEquals(p.email, "mariela@quesadalegal.cr");
  assertEquals((p.application as Doc).carne, "21345");
  const av = f.availability.get(id)!;
  assertEquals(av.minLeadHours, 24);
  assertEquals(av.specialties, ["immigration", "real_estate"]);
  const task = f.tasks.get(applicationTaskId(id))!;
  assertEquals(task.type, "follow_up");
  assertEquals(task.title, "Review lawyer application: Mariela Quesada Rojas");
  assertEquals(task.status, "open");
  assertEquals(task.ownerEmail, "csm@ilp.legal");
  assertEquals(task.dueAt, "2026-10-28T15:00:00.000Z");
  assertEquals(f.consents.map((c) => `${c.kind}:${c.version}`), [`terms:${PARTNER_TERMS_VERSION}`, `privacy:${LEGAL_VERSIONS.privacy}`]);
  assertEquals(f.audits[0].action, "provider.applied");
  assertEquals(f.mails.length, 1);
  assertEquals(f.mails[0].to, "mariela@quesadalegal.cr");
});

Deno.test("submit: a second application with the same email is refused; nothing is overwritten", async () => {
  const f = fakeDeps();
  const first = await submitApplication(body(), f.deps);
  const id = (first.body as { providerId: string }).providerId;
  const again = await submitApplication(body({ email: "MARIELA@quesadalegal.cr", name: "Someone Else" }), f.deps);
  assertEquals(again.status, 409);
  assertEquals((again.body as { code: string }).code, "exists");
  assertEquals(f.providers.size, 1);
  assertEquals(f.providers.get(id)!.name, "Mariela Quesada Rojas");
  // An existing active lawyer is refused too, and stays active.
  const g = fakeDeps([{ id: "prov_x", email: "lic.solano@example.cr", status: "active", active: true, name: "Lic. Solano" }]);
  const dup = await submitApplication(body({ email: "lic.solano@example.cr" }), g.deps);
  assertEquals(dup.status, 409);
  assertEquals(g.providers.get("prov_x")!.status, "active");
  assertEquals(g.tasks.size, 0);
});

Deno.test("submit: honeypot and too-fast submits write nothing", async () => {
  const f = fakeDeps();
  assertEquals((await submitApplication(body({ homepage: "http://spam.example" }), f.deps)).status, 202);
  assertEquals((await submitApplication(body({ elapsedMs: 800 }), f.deps)).status, 202);
  assertEquals(f.providers.size + f.tasks.size + f.mails.length, 0);
});

Deno.test("review: request changes, resubmit, approve; only approve activates", async () => {
  const f = fakeDeps();
  const id = ((await submitApplication(body(), f.deps)).body as { providerId: string }).providerId;
  const staff = { uid: "sofia@ilp.legal", email: "sofia@ilp.legal", role: "csm" };

  assertEquals((await reviewApplication(id, { action: "request_changes" }, staff, f.deps)).status, 400, "a note is required");
  const asked = await reviewApplication(id, { action: "request_changes", note: "Add your notary number." }, staff, f.deps);
  assertEquals(asked.status, 200);
  assertEquals(f.providers.get(id)!.status, "changes_requested");
  assertEquals(f.providers.get(id)!.active, false);
  assertEquals(f.tasks.get(applicationTaskId(id))!.status, "done");
  assertEquals(providerLoginBlock(f.providers.get(id)), null, "can still sign in");

  const resent = await submitApplication(body({ name: "Mariela Quesada Rojas" }), f.deps);
  assertEquals(resent.status, 201);
  assertEquals((resent.body as { resubmitted?: boolean }).resubmitted, true);
  assertEquals(f.providers.size, 1);
  assertEquals(f.providers.get(id)!.status, "pending_review");
  assertEquals(f.tasks.get(applicationTaskId(id))!.status, "open", "review task reopens");

  const ok = await reviewApplication(id, { action: "approve" }, staff, f.deps);
  assertEquals(ok.status, 200);
  assertEquals(f.providers.get(id)!.status, "active");
  assertEquals(f.providers.get(id)!.active, true);
  assertEquals(isProviderBookable(f.providers.get(id)), true);
  assertEquals(f.tasks.get(applicationTaskId(id))!.outcome, "Approved");
  assertEquals((await reviewApplication(id, { action: "decline", note: "Too late." }, staff, f.deps)).status, 409);
  assertEquals(f.audits.map((a) => a.action), [
    "provider.applied",
    "provider.application_changes_requested",
    "provider.application_resubmitted",
    "provider.application_approved",
  ]);
  assertEquals(f.mails.map((m) => String(m.subject)).at(-1), "Your ILP partner lawyer profile is approved");
});

Deno.test("review: decline needs a reason, blocks sign-in and calls", async () => {
  const f = fakeDeps();
  const id = ((await submitApplication(body(), f.deps)).body as { providerId: string }).providerId;
  const staff = { uid: "a@ilp.legal", email: "a@ilp.legal", role: "admin" };
  assertEquals((await reviewApplication(id, { action: "decline", note: "" }, staff, f.deps)).status, 400);
  assertEquals((await reviewApplication(id, { action: "decline", note: "We could not confirm the carné with the Colegio." }, staff, f.deps)).status, 200);
  const p = f.providers.get(id)!;
  assertEquals(p.status, "declined");
  assertEquals(p.active, false);
  assert(providerLoginBlock(p));
  assertEquals(applicationBlocksCalls(p), true);
  assertEquals((await reviewApplication("prov_missing", { action: "approve" }, staff, f.deps)).status, 404);
});

Deno.test("status rules: lawyers created before T2 keep working", () => {
  assertEquals(providerStatus({ active: true }), "active");
  assertEquals(providerStatus({}), "active");
  assertEquals(providerStatus({ active: false }), "inactive");
  assertEquals(providerStatus({ status: "vetted" }), "active");
  assertEquals(applicationBlocksCalls({ active: false }), false, "switched-off lawyers keep their old booking behaviour");
  assertEquals(providerLoginBlock({ status: "pending_review" }), null, "applicants may sign in");
  assertEquals(providerLoginBlock(null), null);
});
