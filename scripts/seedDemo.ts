/**
 * scripts/seedDemo.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Realistic Costa Rica demo data for the member core loop (docs/PLAN.md demo
 * script): 12 members, 3 lawyers, memberships, matters, consultations (past
 * and upcoming), handoffs, open CSM tasks, obligations and leads.
 *
 * Dates are relative to the moment you run it, so "today's calls" are today.
 * Every id starts with `demo_`, every doc carries `seed: true`, and re-running
 * overwrites the same ids (a reset), so it is safe to run before each demo.
 * Sessions are printed at the end so each portal can be opened with a header
 * token without waiting for an OTP email.
 *
 * Env (optional):
 *   DEMO_CSM_EMAIL     owner of seeded CSM tasks (default csm@internationallegalpartner.com)
 *   DEMO_LAWYER_EMAIL  real inbox for the first lawyer, so OTP login works
 *   DEMO_MEMBER_EMAIL  real inbox for the first member (Robert Hayes)
 *
 * Run:
 *   deno run --allow-net --allow-env --allow-read scripts/seedDemo.ts --dry-run
 *   deno run --allow-net --allow-env --allow-read scripts/seedDemo.ts
 */

import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });

import put from "../db/put.ts";
import { createRecord, type RecordCollection } from "../db/records.ts";
import { emailToDocId, generateSessionToken } from "../helper/auth/otp.ts";
import { buildTask } from "../API/members/events.ts";
import {
  COLLECTIONS,
  type Consultation,
  type CsmTask,
  type Handoff,
  type Lead,
  type Matter,
  type Membership,
  type Obligation,
  PLAN_STANDARD,
} from "../schemas/contracts.ts";

const DRY = Deno.args.includes("--dry-run") || Deno.args.includes("-n");
const CSM = Deno.env.get("DEMO_CSM_EMAIL") || "csm@internationallegalpartner.com";
const NOW = new Date();
const DAY = 86400_000;

/** ISO at `days` from today, at `hourCR` Costa Rica time (UTC-6, no DST). */
export function at(days: number, hourCR = 10, minute = 0): string {
  const d = new Date(NOW);
  d.setUTCHours(hourCR + 6, minute, 0, 0);
  return new Date(d.getTime() + days * DAY).toISOString();
}
const ago = (days: number, hourCR = 10) => at(-days, hourCR);

/** Next occurrence of a month/day (UTC midnight CR). */
function nextDate(month: number, day: number): string {
  const y = NOW.getUTCFullYear();
  let d = new Date(Date.UTC(y, month - 1, day, 6));
  if (d.getTime() < NOW.getTime()) d = new Date(Date.UTC(y + 1, month - 1, day, 6));
  return d.toISOString();
}

// ─── Lawyers ───────────────────────────────────────────────────────────────

const LAWYERS = [
  {
    id: "demo_prov_mora",
    name: "Adriana Mora",
    email: Deno.env.get("DEMO_LAWYER_EMAIL") || "adriana.mora@demo.internationallegalpartner.com",
    legalAreas: ["real_estate", "corporate"],
    bio: "Property and corporate lawyer in Liberia, Guanacaste. 14 years with foreign owners.",
  },
  {
    id: "demo_prov_solis",
    name: "Esteban Solís",
    email: "esteban.solis@demo.internationallegalpartner.com",
    legalAreas: ["immigration"],
    bio: "Immigration lawyer in San José. Pensionado, rentista and digital nomad files.",
  },
  {
    id: "demo_prov_vargas",
    name: "Lucía Vargas",
    email: "lucia.vargas@demo.internationallegalpartner.com",
    legalAreas: ["corporate", "tax"],
    bio: "Corporate and tax counsel in Escazú. S.A./S.R.L. maintenance, dissolutions, RTBF filings.",
  },
];

// ─── Members ───────────────────────────────────────────────────────────────

interface Seed {
  key: string;
  name: string;
  surname: string;
  email: string;
  profile: Record<string, unknown>;
  persona: string;
  matter: { title: string; area: string; stage: string; lawyer: string; nextStep?: Matter["nextStep"] };
  /** minutes/calls used are derived from completed consultations in the current period. */
  membership: { status: Membership["status"]; activatedDaysAgo: number; minutesUsed?: number; callsUsed?: number };
  obligations: Array<[ruleId: string, dueAt: string]>;
}

const RULES: Record<string, string> = {
  "CR-corp-tax": "Annual corporation tax (impuesto a las personas jurídicas) may require payment",
  "CR-rtbf": "Beneficial ownership declaration (RTBF) may require filing",
  "CR-marchamo": "Vehicle circulation permit (marchamo) renewal may be due",
  "CR-property-tax": "Municipal property tax (bienes inmuebles) instalment may be due",
  "CR-dimex": "Residency card (DIMEX) renewal may require review",
  "CR-ccss": "CCSS (Caja) enrolment for residents may require review",
  "CR-nomad": "Digital nomad stay renewal may require review",
  "CR-rental-tax": "Short-term rental income declaration may require filing",
};

const MEMBERS: Seed[] = [
  {
    key: "hayes",
    name: "Robert",
    surname: "Hayes",
    email: Deno.env.get("DEMO_MEMBER_EMAIL") || "robert.hayes@example.com",
    persona: "US retiree, house in Tamarindo held by a Costa Rican S.A., pensionado residency",
    profile: {
      fullName: "Robert James Hayes", phone: "+1 503 555 0141", nationality: "US", dateOfBirth: "1957-04-12",
      maritalStatus: "married", dependents: 0, residencyStatus: "pensionado", residencyExpiresAt: at(160),
      ownsProperty: true, propertyLocation: "Tamarindo, Guanacaste", hasCompany: true, companyType: "S.A.",
      ownsVehicle: true,
    },
    matter: {
      title: "Tamarindo house: S.A. records and title check", area: "corporate", stage: "legal_review", lawyer: "demo_prov_mora",
      nextStep: { what: "Send the S.A. legal books and last corporation tax receipt", who: "client", dueAt: at(5) },
    },
    membership: { status: "active", activatedDaysAgo: 21, minutesUsed: 0, callsUsed: 0 },
    obligations: [["CR-corp-tax", nextDate(1, 31)], ["CR-rtbf", nextDate(4, 30)], ["CR-property-tax", nextDate(12, 31)], ["CR-marchamo", nextDate(12, 31)]],
  },
  {
    key: "olsen",
    name: "Margaret",
    surname: "Olsen",
    email: "margaret.olsen@example.com",
    persona: "US retiree in Atenas renewing rentista residency",
    profile: {
      fullName: "Margaret Ann Olsen", phone: "+1 612 555 0187", nationality: "US", dateOfBirth: "1954-09-02",
      maritalStatus: "widowed", dependents: 0, residencyStatus: "rentista", residencyExpiresAt: at(75),
      ownsProperty: false, hasCompany: false, ownsVehicle: false,
    },
    matter: {
      title: "Rentista residency renewal", area: "immigration", stage: "documents", lawyer: "demo_prov_solis",
      nextStep: { what: "Get the new bank letter showing US$2,500/month income", who: "client", dueAt: at(9) },
    },
    membership: { status: "active", activatedDaysAgo: 48, minutesUsed: 20, callsUsed: 1 },
    obligations: [["CR-dimex", at(75)], ["CR-ccss", at(20)]],
  },
  {
    key: "kim",
    name: "Daniel",
    surname: "Kim",
    email: "daniel.kim@example.com",
    persona: "Remote software engineer in Santa Teresa on the digital nomad visa",
    profile: {
      fullName: "Daniel Kim", phone: "+1 415 555 0102", nationality: "US", dateOfBirth: "1990-02-18",
      maritalStatus: "single", dependents: 0, residencyStatus: "digital_nomad", residencyExpiresAt: at(120),
      ownsProperty: false, hasCompany: false,
    },
    matter: { title: "Digital nomad stay: extension and local driving", area: "immigration", stage: "intake", lawyer: "demo_prov_solis" },
    membership: { status: "active", activatedDaysAgo: 12, minutesUsed: 0, callsUsed: 0 },
    obligations: [["CR-nomad", at(120)]],
  },
  {
    key: "raman",
    name: "Priya",
    surname: "Raman",
    email: "priya.raman@example.com",
    persona: "Canadian product designer in Escazú, nomad visa, importing a car",
    profile: {
      fullName: "Priya Raman", email: "priya.raman@example.com", phone: "+1 647 555 0199", nationality: "CA",
      dateOfBirth: "1988-11-30", maritalStatus: "married", dependents: 1, residencyStatus: "digital_nomad",
      residencyExpiresAt: at(210), ownsProperty: false, propertyLocation: "", hasCompany: false, ownsVehicle: true,
    },
    matter: { title: "Car import and local plates", area: "vehicle", stage: "scoping", lawyer: "demo_prov_vargas" },
    membership: { status: "active", activatedDaysAgo: 33, minutesUsed: 20, callsUsed: 1 },
    obligations: [["CR-marchamo", nextDate(12, 31)], ["CR-nomad", at(210)]],
  },
  {
    key: "bennett",
    name: "Claire",
    surname: "Bennett",
    email: "claire.bennett@example.com",
    persona: "Canadian couple, Nosara villa rented on short-term platforms through an S.R.L.",
    profile: {
      fullName: "Claire Bennett", phone: "+1 604 555 0123", nationality: "CA", dateOfBirth: "1966-06-21",
      maritalStatus: "married", dependents: 0, residencyStatus: "tourist",
      ownsProperty: true, propertyLocation: "Nosara, Guanacaste", hasCompany: true, companyType: "S.R.L.", ownsVehicle: false,
    },
    matter: {
      title: "Villa rental: tax registration and S.R.L. compliance", area: "tax", stage: "legal_review", lawyer: "demo_prov_vargas",
      nextStep: { what: "Lucía to confirm whether the S.R.L. must register with Hacienda for rental income", who: "lawyer", dueAt: at(3) },
    },
    membership: { status: "active", activatedDaysAgo: 64, minutesUsed: 40, callsUsed: 2 },
    obligations: [["CR-rental-tax", at(18)], ["CR-corp-tax", nextDate(1, 31)], ["CR-property-tax", nextDate(12, 31)]],
  },
  {
    key: "alvarez",
    name: "Hector",
    surname: "Alvarez",
    email: "hector.alvarez@example.com",
    persona: "US owner of an S.A. holding two rental condos in Jacó",
    profile: {
      fullName: "Hector Alvarez", phone: "+1 305 555 0166", nationality: "US", dateOfBirth: "1971-01-09",
      maritalStatus: "divorced", dependents: 2, residencyStatus: "tourist",
      ownsProperty: true, propertyLocation: "Jacó, Puntarenas", hasCompany: true, companyType: "S.A.", ownsVehicle: false,
    },
    matter: {
      title: "Jacó condos: S.A. clean-up before sale", area: "corporate", stage: "quote_sent", lawyer: "demo_prov_mora",
      nextStep: { what: "Review and accept the S.A. clean-up proposal", who: "client", dueAt: at(2) },
    },
    membership: { status: "active", activatedDaysAgo: 40, minutesUsed: 20, callsUsed: 1 },
    obligations: [["CR-corp-tax", nextDate(1, 31)], ["CR-rtbf", nextDate(4, 30)]],
  },
  {
    key: "whitfield",
    name: "Susan",
    surname: "Whitfield",
    email: "susan.whitfield@example.com",
    persona: "US retiree in Grecia applying for pensionado residency",
    profile: {
      fullName: "Susan Whitfield", phone: "+1 720 555 0110", nationality: "US", dateOfBirth: "1959-03-14",
      maritalStatus: "married", dependents: 0, residencyStatus: "applying",
      ownsProperty: false, hasCompany: false, ownsVehicle: false,
    },
    matter: {
      title: "Pensionado residency application", area: "immigration", stage: "documents", lawyer: "demo_prov_solis",
      nextStep: { what: "Upload apostilled birth certificate", who: "client", dueAt: ago(4) },
    },
    membership: { status: "active", activatedDaysAgo: 27, minutesUsed: 20, callsUsed: 1 },
    obligations: [["CR-ccss", at(40)]],
  },
  {
    key: "delaney",
    name: "Mark",
    surname: "Delaney",
    email: "mark.delaney@example.com",
    persona: "New member: US remote worker who just moved to Puerto Viejo",
    profile: { fullName: "Mark Delaney", phone: "+1 718 555 0175", nationality: "US", ownsVehicle: false },
    matter: { title: "Getting started: residency options", area: "immigration", stage: "intake", lawyer: "demo_prov_solis" },
    membership: { status: "active", activatedDaysAgo: 1, minutesUsed: 0, callsUsed: 0 },
    obligations: [],
  },
  {
    key: "brooks",
    name: "Jennifer",
    surname: "Brooks",
    email: "jennifer.brooks@example.com",
    persona: "US buyer of a Dominical land lot, title review",
    profile: {
      fullName: "Jennifer Brooks", phone: "+1 512 555 0133", nationality: "US", dateOfBirth: "1975-08-05",
      maritalStatus: "single", dependents: 0, residencyStatus: "tourist",
      ownsProperty: true, propertyLocation: "Dominical, Puntarenas", hasCompany: false,
    },
    matter: {
      title: "Dominical lot: title and boundary review", area: "real_estate", stage: "legal_review", lawyer: "demo_prov_mora",
      nextStep: { what: "Adriana to deliver the title study (estudio registral)", who: "lawyer", dueAt: at(4) },
    },
    membership: { status: "active", activatedDaysAgo: 55, minutesUsed: 20, callsUsed: 1 },
    obligations: [["CR-property-tax", nextDate(12, 31)]],
  },
  {
    key: "novak",
    name: "Gary",
    surname: "Novak",
    email: "gary.novak@example.com",
    persona: "US retiree in San Ramón, card payment failed this month",
    profile: {
      fullName: "Gary Novak", phone: "+1 216 555 0158", nationality: "US", dateOfBirth: "1952-12-01",
      maritalStatus: "married", dependents: 0, residencyStatus: "pensionado", residencyExpiresAt: at(300),
      ownsProperty: true, propertyLocation: "San Ramón, Alajuela", hasCompany: false, ownsVehicle: true,
    },
    matter: { title: "Vehicle transfer after private sale", area: "vehicle", stage: "scoping", lawyer: "demo_prov_vargas" },
    membership: { status: "past_due", activatedDaysAgo: 95, minutesUsed: 0, callsUsed: 0 },
    obligations: [["CR-marchamo", nextDate(12, 31)]],
  },
  {
    key: "obrien",
    name: "Kevin",
    surname: "O'Brien",
    email: "kevin.obrien@example.com",
    persona: "Canadian owner of a dormant S.A. in Liberia he wants to dissolve",
    profile: {
      fullName: "Kevin O'Brien", phone: "+1 902 555 0147", nationality: "CA", dateOfBirth: "1963-05-27",
      maritalStatus: "married", dependents: 0, residencyStatus: "tourist",
      ownsProperty: false, hasCompany: true, companyType: "S.A.", ownsVehicle: false,
    },
    matter: { title: "Dormant S.A.: dissolve or keep", area: "corporate", stage: "scoping", lawyer: "demo_prov_vargas" },
    membership: { status: "active", activatedDaysAgo: 85, minutesUsed: 20, callsUsed: 1 },
    obligations: [["CR-corp-tax", nextDate(1, 31)], ["CR-rtbf", nextDate(4, 30)]],
  },
  {
    key: "chen",
    name: "Laura",
    surname: "Chen",
    email: "laura.chen@example.com",
    persona: "US remote worker in Heredia who cancelled after her residency was approved",
    profile: {
      fullName: "Laura Chen", phone: "+1 206 555 0190", nationality: "US", dateOfBirth: "1986-07-19",
      maritalStatus: "single", dependents: 0, residencyStatus: "rentista", residencyExpiresAt: at(700),
      ownsProperty: false, hasCompany: false, ownsVehicle: false,
    },
    matter: { title: "Rentista residency (approved)", area: "immigration", stage: "closed", lawyer: "demo_prov_solis" },
    membership: { status: "cancelled", activatedDaysAgo: 130, minutesUsed: 40, callsUsed: 2 },
    obligations: [["CR-dimex", at(700)]],
  },
];

const cid = (s: Seed) => emailToDocId(s.email.toLowerCase());
const mid = (s: Seed) => `demo_mat_${s.key}`;
const by = (key: string) => MEMBERS.find((m) => m.key === key)!;

// ─── Consultations, handoffs, tasks ───────────────────────────────────────

function consultations(): Consultation[] {
  const c = (
    key: string,
    n: number,
    over: Partial<Consultation>,
  ): Consultation => {
    const s = by(key);
    return {
      id: `demo_con_${key}_${n}`,
      clientId: cid(s),
      matterId: mid(s),
      providerId: s.matter.lawyer,
      scheduledAt: at(0),
      durationMin: PLAN_STANDARD.callLengthMin,
      status: "booked",
      consent: { recording: "pending" },
      createdAt: ago(3),
      ...over,
    };
  };
  const done = (summary: string, daysAgo: number) => ({
    status: "completed" as const,
    scheduledAt: ago(daysAgo, 11),
    endedAt: ago(daysAgo, 11),
    minutesUsed: 20,
    consent: { recording: "granted" as const, at: ago(daysAgo, 11) },
    transcript: "Recorded with consent. Transcript stored for the member file.",
    summary: { text: summary, status: "confirmed" as const, confirmedAt: ago(daysAgo, 12) },
    createdAt: ago(daysAgo + 4),
  });
  return [
    // Today (lawyer Today screens)
    // Demo steps 5-6: consent granted and a suggested summary waiting for the lawyer to confirm.
    c("hayes", 1, {
      scheduledAt: at(0, 10),
      question: "Is my S.A. in good standing, and what do I need to file before January?",
      consent: { recording: "granted", at: at(0, 9, 58) },
      transcript:
        "Lawyer: Your S.A. is registered and active. Member: I haven't filed the corporation tax. Lawyer: The annual corporation tax is due January 31, and the beneficial-owner (RTBF) filing by April 30. Send me the legal books and I'll check the shareholder register.",
      summary: {
        text: "S.A. is active. Annual corporation tax may require filing by January 31 and the RTBF beneficial-owner filing by April 30. Member to send the legal books; lawyer to review the shareholder register.",
        status: "suggested",
      },
    }),
    c("brooks", 2, { scheduledAt: at(0, 14), question: "What did the title study find on the boundary?" }),
    c("raman", 2, { scheduledAt: at(0, 11, 30), question: "Which documents do I need to register the imported car?" }),
    // Upcoming
    c("kim", 1, { scheduledAt: at(1, 9), question: "Can I extend the nomad stay and drive on my US licence?" }),
    c("olsen", 2, { scheduledAt: at(2, 15), question: "Is the new bank letter enough for the renewal?" }),
    c("obrien", 2, { scheduledAt: at(3, 10), question: "Cost and timeline to dissolve versus keep the S.A." }),
    // Past
    c("olsen", 1, done("Rentista renewal is due in about 75 days. A new bank letter is needed; the rest of the file is current.", 18)),
    c("alvarez", 1, done("Both condos sit in one S.A. with two years of missed corporation tax and an outdated shareholder book. Clean-up is needed before any sale.", 6)),
    c("brooks", 1, done("Purchase is pending a title study; plan shows a 2 m discrepancy on the north boundary.", 25)),
    c("whitfield", 1, done("Pensionado file is complete except the apostilled birth certificate.", 15)),
    c("raman", 1, done("The car can be imported under the nomad visa; customs value sets the tax.", 20)),
    c("bennett", 1, done("Rental income must be declared; the S.R.L. may need to register as taxpayer.", 30)),
    c("bennett", 2, done("Reviewed draft registration; Lucía will confirm the activity code.", 9)),
    c("obrien", 1, done("S.A. has no activity; dissolution or keeping it current are both possible.", 40)),
    c("chen", 1, done("Rentista requirements reviewed.", 120)),
    c("chen", 2, done("Approval received; DIMEX appointment explained.", 70)),
    // A no-show keeps the metrics honest
    c("novak", 1, { status: "no_show", scheduledAt: ago(12, 9), createdAt: ago(15) }),
  ];
}

function handoffs(): Handoff[] {
  const h = (key: string, n: number, steps: Handoff["legalNextSteps"], commercialNotes?: string): Handoff => {
    const s = by(key);
    const handoff: Handoff = {
      id: `demo_hof_${key}_${n}`,
      consultationId: `demo_con_${key}_${n}`,
      clientId: cid(s),
      matterId: mid(s),
      providerId: s.matter.lawyer,
      legalNextSteps: steps,
      approvedAt: ago(1),
      csmTaskIds: [],
    };
    if (commercialNotes) handoff.commercialNotes = commercialNotes;
    return handoff;
  };
  return [
    h("olsen", 1, [
      { what: "Request a new bank letter showing US$2,500/month", who: "client", dueAt: at(9) },
      { what: "Book the renewal appointment with Migración", who: "ilp", dueAt: at(20) },
    ]),
    h("alvarez", 1, [
      { what: "Send the S.A. legal books and shareholder register", who: "client", dueAt: at(2) },
      { what: "Prepare a clean-up plan with the overdue corporation tax", who: "lawyer", dueAt: at(7) },
    ], "S.A. clean-up quote: overdue corporation tax x2, book legalisation, shareholder update. Est. US$1,450 fees."),
    h("brooks", 1, [{ what: "Commission the title study (estudio registral)", who: "lawyer", dueAt: at(4) }]),
    h("whitfield", 1, [{ what: "Upload apostilled birth certificate", who: "client", dueAt: ago(4) }]),
  ];
}

function tasks(hofs: Handoff[]): CsmTask[] {
  const out: CsmTask[] = [];
  const add = (t: CsmTask | null, over: Partial<CsmTask> = {}) => {
    if (t) out.push({ ...t, ownerEmail: CSM, ...over });
  };
  const ev = (name: string, key: string, sourceId: string, detail?: string) =>
    buildTask(name, { clientId: cid(by(key)), matterId: mid(by(key)), sourceId, detail }, NOW, CSM);

  // Onboarding for the newest member (due tomorrow) — demo step 3.
  add(ev("membership.activated", "delaney", "demo_mem_delaney", "Mark Delaney"));
  // Profile checks before upcoming calls.
  add(ev("consultation.booked", "kim", "demo_con_kim_1", "Daniel Kim"), { dueAt: at(0, 16) });
  add(ev("consultation.booked", "obrien", "demo_con_obrien_2", "Kevin O'Brien"));
  // Post-call follow-ups and the S.A. clean-up proposal — demo step 8.
  for (const h of hofs) {
    const key = h.id.replace(/^demo_hof_/, "").replace(/_\d+$/, "");
    const name = `${by(key).name} ${by(key).surname}`;
    const t = ev("handoff.approved", key, h.id, name);
    if (t) {
      add(t, key === "olsen" ? { status: "done", outcome: "Called Margaret; she has asked her bank for the letter.", closedAt: ago(0, 9) } : {});
      h.csmTaskIds.push(t.id);
    }
    if (h.commercialNotes) {
      const p = ev("handoff.opportunity", key, h.id, `S.A. clean-up quote (${name})`);
      if (p) {
        add(p);
        h.csmTaskIds.push(p.id);
      }
    }
  }
  // Time-based rules.
  add(ev("document.missing_3d", "whitfield", "demo_pa_whitfield_birth", "Apostilled birth certificate"), { dueAt: ago(1, 12) });
  add(ev("quote.unanswered_5d", "bennett", "demo_quote_bennett_1", "Hacienda registration for the S.R.L."));
  add(ev("membership.renewal_7d", "obrien", "demo_mem_obrien_renewal", "Kevin O'Brien"), { dueAt: at(1, 12) });
  // A manual escalation: past-due card.
  out.push({
    id: "demo_task_novak_pastdue",
    clientId: cid(by("novak")),
    ownerEmail: CSM,
    type: "escalation",
    title: "Card declined: update payment method with Gary Novak",
    dueAt: ago(2, 12),
    status: "open",
    source: { kind: "membership", id: "demo_mem_novak" },
    createdAt: ago(3),
  });
  return out;
}

// ─── Build everything ─────────────────────────────────────────────────────

function build() {
  const clients: Array<Record<string, unknown>> = [];
  const memberships: Membership[] = [];
  const matters: Matter[] = [];
  const obligations: Obligation[] = [];

  for (const s of MEMBERS) {
    const id = cid(s);
    const activatedAt = ago(s.membership.activatedDaysAgo, 9);
    const months = Math.floor(s.membership.activatedDaysAgo / 30);
    const periodStart = new Date(new Date(activatedAt).getTime() + months * 30 * DAY).toISOString();
    const periodEnd = new Date(new Date(periodStart).getTime() + 30 * DAY).toISOString();
    const charges = [
      { id: `demo_ch_${s.key}_act`, label: "Activation fee", amountMinor: PLAN_STANDARD.activationCents, currency: "USD", status: "paid", createdAt: activatedAt },
      ...Array.from({ length: months + 1 }, (_, i) => ({
        id: `demo_ch_${s.key}_m${i}`,
        label: `Membership month ${i + 1}`,
        amountMinor: PLAN_STANDARD.monthlyCents,
        currency: "USD",
        status: s.membership.status === "past_due" && i === months ? "pending" : "paid",
        createdAt: new Date(new Date(activatedAt).getTime() + i * 30 * DAY).toISOString(),
      })),
    ];
    clients.push({
      id,
      name: s.name,
      surname: s.surname,
      email: s.email.toLowerCase(),
      legalArea: s.matter.area,
      legalMatter: s.matter.title,
      jurisdiction: "Costa Rica",
      country: "CR",
      stage: s.matter.stage,
      stageEnteredAt: ago(5),
      assignedProviderId: s.matter.lawyer,
      persona: s.persona,
      clientFields: { email: s.email.toLowerCase(), ...s.profile },
      consultations: [],
      journey: [],
      stageRatings: [],
      charges,
      quotes: s.key === "alvarez"
        ? [{ id: "demo_quote_alvarez_1", title: "S.A. clean-up before sale", lines: [{ label: "Overdue corporation tax filings (2 years)", amountMinor: 45000 }, { label: "Legal books legalisation and shareholder update", amountMinor: 100000 }], totalMinor: 145000, currency: "USD", status: "sent", createdAt: ago(1) }]
        : s.key === "bennett"
        ? [{ id: "demo_quote_bennett_1", title: "Hacienda registration for the S.R.L.", lines: [{ label: "Taxpayer registration and activity code", amountMinor: 38000 }], totalMinor: 38000, currency: "USD", status: "sent", createdAt: ago(6) }]
        : [],
      notes: [],
      pendingActions: s.key === "whitfield" ? [{ id: "demo_pa_whitfield_birth", label: "Upload apostilled birth certificate", dueAt: ago(4) }] : [],
      conversations: [],
      source: "demo",
      createdAt: activatedAt,
      updatedAt: ago(1),
      seed: true,
    });
    memberships.push({
      id: `demo_mem_${s.key}`,
      clientId: id,
      plan: PLAN_STANDARD.id,
      status: s.membership.status,
      country: "CR",
      activationPaidAt: activatedAt,
      activatedAt,
      periodStart,
      periodEnd: s.key === "obrien" ? at(5) : periodEnd, // renewal inside 7 days
      minutesIncluded: PLAN_STANDARD.minutesIncluded,
      minutesUsed: 0,
      callsIncluded: PLAN_STANDARD.callsIncluded,
      callsUsed: 0,
      csmEmail: CSM,
      paymentRef: "manual",
      ...(s.membership.status === "cancelled" ? { cancelledAt: ago(25) } : {}),
      createdAt: activatedAt,
      updatedAt: ago(1),
    });
    const m: Matter = {
      id: mid(s),
      clientId: id,
      title: s.matter.title,
      area: s.matter.area,
      country: "CR",
      stage: s.matter.stage,
      stageEnteredAt: s.key === "alvarez" ? ago(6) : s.key === "brooks" ? ago(19) : ago(5),
      assignedProviderId: s.matter.lawyer,
      openedAt: activatedAt,
    };
    if (s.matter.nextStep) m.nextStep = s.matter.nextStep;
    if (s.matter.stage === "closed") m.closedAt = ago(30);
    matters.push(m);
    s.obligations.forEach(([ruleId, dueAt], i) =>
      obligations.push({
        id: `demo_obl_${s.key}_${i}`,
        clientId: id,
        country: "CR",
        ruleId,
        title: RULES[ruleId] ?? ruleId,
        dueAt,
        status: s.key === "bennett" && ruleId === "CR-rental-tax" ? "asked" : "upcoming",
      })
    );
  }

  const cons = consultations();
  // Usage this period = completed calls since periodStart; mark them charged so
  // the membership is not charged twice when a lawyer edits the consultation.
  for (const m of memberships) {
    const used = cons.filter((c) => c.clientId === m.clientId && c.status === "completed" && c.scheduledAt >= m.periodStart);
    m.minutesUsed = used.reduce((n, c) => n + (c.minutesUsed ?? 0), 0);
    m.callsUsed = used.length;
  }
  for (const c of cons) if (c.status === "completed") (c as Consultation & { chargedAt?: string }).chargedAt = c.endedAt;
  const hofs = handoffs();
  const csm = tasks(hofs);
  // Link handoffs back onto their consultations.
  for (const h of hofs) {
    const c = cons.find((x) => x.id === h.consultationId);
    if (c) c.handoffId = h.id;
  }

  const leads: Lead[] = [
    {
      id: "demo_lead_hayes",
      email: by("hayes").email.toLowerCase(),
      name: "Robert Hayes",
      country: "CR",
      answers: { residency: "pensionado", ownsProperty: true, propertyRegion: "Guanacaste", hasCompany: "S.A.", ownsVehicle: true },
      findings: [
        { ruleId: "CR-corp-tax", title: RULES["CR-corp-tax"], dueAt: nextDate(1, 31), area: "corporate" },
        { ruleId: "CR-rtbf", title: RULES["CR-rtbf"], dueAt: nextDate(4, 30), area: "corporate" },
        { ruleId: "CR-marchamo", title: RULES["CR-marchamo"], dueAt: nextDate(12, 31), area: "vehicle" },
      ],
      source: "deadline_check",
      createdAt: ago(22),
      convertedClientId: cid(by("hayes")),
      convertedAt: ago(21, 9),
    },
    {
      id: "demo_lead_patel",
      email: "nina.patel@example.com",
      name: "Nina Patel",
      country: "CR",
      answers: { residency: "none", ownsProperty: true, propertyRegion: "Puntarenas", hasCompany: "none" },
      findings: [{ ruleId: "CR-property-tax", title: RULES["CR-property-tax"], dueAt: nextDate(12, 31), area: "property" }],
      source: "deadline_check",
      createdAt: ago(2),
    },
    {
      id: "demo_lead_morgan",
      email: "sam.morgan@example.com",
      country: "CR",
      answers: { residency: "digital_nomad", ownsVehicle: true },
      findings: [
        { ruleId: "CR-nomad", title: RULES["CR-nomad"], dueAt: at(90), area: "immigration" },
        { ruleId: "CR-marchamo", title: RULES["CR-marchamo"], dueAt: nextDate(12, 31), area: "vehicle" },
      ],
      source: "deadline_check",
      createdAt: ago(0, 8),
    },
  ];

  return { clients, memberships, matters, obligations, consultations: cons, handoffs: hofs, tasks: csm, leads };
}

async function main() {
  const data = build();
  const providers = LAWYERS.map((l) => ({
    ...l,
    email: l.email.toLowerCase(),
    phone: "+506 2222 0000",
    jurisdictions: ["Costa Rica"],
    languages: ["es", "en"],
    active: true,
    status: "active",
    score: 4.8,
    vettedAt: ago(200),
    createdAt: ago(200),
    updatedAt: ago(1),
    seed: true,
  }));

  const writes: Array<[string, string, Record<string, unknown>]> = [];
  for (const p of providers) writes.push(["providers", p.id, p]);
  for (const c of data.clients) writes.push([COLLECTIONS.clients, String(c.id), c]);
  const recs: Array<[RecordCollection, Array<{ id: string }>]> = [
    [COLLECTIONS.memberships, data.memberships],
    [COLLECTIONS.matters, data.matters],
    [COLLECTIONS.consultations, data.consultations],
    [COLLECTIONS.handoffs, data.handoffs],
    [COLLECTIONS.csmTasks, data.tasks],
    [COLLECTIONS.obligations, data.obligations],
    [COLLECTIONS.leads, data.leads],
  ];

  console.log(`${DRY ? "[dry-run] " : ""}Seeding ILP demo (CSM owner ${CSM})`);
  console.log(
    `  ${providers.length} lawyers, ${data.clients.length} members, ${data.memberships.length} memberships, ` +
      `${data.matters.length} matters, ${data.consultations.length} consultations, ${data.handoffs.length} handoffs, ` +
      `${data.tasks.filter((t) => t.status === "open").length} open CSM tasks, ${data.obligations.length} obligations, ${data.leads.length} leads`,
  );
  if (DRY) return;

  for (const [col, id, doc] of writes) await put(col, id, doc);
  for (const [col, list] of recs) for (const r of list) await createRecord(col, r);

  // Ready-made sessions (7 days) so each portal opens without an OTP email.
  const exp = new Date(NOW.getTime() + 7 * DAY).toISOString();
  const lawyerToken = generateSessionToken();
  await put("provider_sessions", lawyerToken, { email: providers[0].email, providerId: providers[0].id, createdAt: NOW.toISOString(), expiresAt: exp, seed: true });
  const memberToken = generateSessionToken();
  const hayes = data.clients[0];
  await put("client_status_sessions", memberToken, { email: hayes.email, projectId: hayes.id, createdAt: NOW.toISOString(), expiresAt: exp, seed: true });
  const staffToken = generateSessionToken();
  await put("dashboard_sessions", staffToken, { email: CSM, role: "csm", createdAt: NOW.toISOString(), expiresAt: exp, seed: true });

  console.log("\nDone. Header tokens (7 days):");
  console.log(`  staff  (${CSM})  x-dashboard-token: ${staffToken}`);
  console.log(`  lawyer (${providers[0].email})  x-provider-token: ${lawyerToken}`);
  console.log(`  member (${hayes.email}, clientId ${hayes.id})  x-client-token: ${memberToken}`);
}

if (import.meta.main) await main();

export { build };
