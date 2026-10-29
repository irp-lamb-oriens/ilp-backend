/**
 * scripts/placeholderData.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure, deterministic builder of the placeholder (seed) data set that
 * `scripts/seedPlaceholdersFull.ts` writes to Firestore. No IO here, so the
 * whole story can be generated and tested offline
 * (test/seedPlaceholders_test.ts).
 *
 * Every document: id starts with `ph_`, `placeholder: true`,
 * `placeholderBatch: <batch>`. People use @example.com addresses, +1 555-01xx
 * phone numbers and "PH-…" identifiers. See docs/workstreams/SEED.md.
 *
 * Same --size and --seed → same ids and the same story; dates are relative to
 * `now` (today's calls are today).
 */

import {
  COLLECTIONS,
  type ConsentKind,
  type CsmTask,
  type Lead,
  type LegalNextStep,
  type Membership,
  type Opportunity,
  PLAN_STANDARD,
  profileCompleteness,
  TASK_RULES,
  DEFAULT_SPECIALTIES,
} from "../schemas/contracts.ts";
import { buildTask, type EventPayload } from "../API/members/events.ts";
import { opportunityFromHandoff } from "../API/opportunities/logic.ts";
import { type CheckAnswers, evaluateCheck, normalizeAnswers } from "../API/leads/deadlineCheck.ts";
import { COUNTRIES, COUNTRY_ANSWERS_FIELD, type CountryCode } from "../schemas/contracts.ts";
import { lineClientPrice } from "../API/dashboard/quotePricing.ts";
import { LEGAL_VERSIONS } from "../API/privacy/policy.ts";
import { CANCEL_REASONS } from "../API/payments/cancel.ts";
import { missingDocumentEvents, renewalEvents, unansweredQuoteEvents } from "../jobs/taskRuleSweep.ts";
import { PLACEHOLDER_PREFIX } from "../helper/placeholder.ts";
import { GAP_SPECIALTIES, reviewsAndRatings, routingProfileFor, salesCallDoc, SEED_SALES_EMAIL, seedDecision, seedLawyerForRouting } from "./routingPlaceholderData.ts"; // ROUTING
import {
  ACCESSIBILITY,
  type Background,
  BACKGROUNDS,
  BLOCKED_NAMES,
  COMPANIES,
  COMPANY_WEIGHTS,
  type CompanyKind,
  COVER_PEOPLE,
  EMPLOYEE_WEIGHTS,
  type EmployeeKind,
  EMPLOYEES,
  type Gender,
  type Household,
  HOUSEHOLDS,
  LANGUAGES,
  MARITAL,
  NATIONALITIES,
  PETS,
  PLACES,
  PROPERTIES,
  PROPERTY_LABEL,
  PROPERTY_WEIGHTS,
  type PropertyKind,
  ACCOUNT_LAWYER_COUNTRIES,
  COUNTRY_PLACES,
  COUNTRY_WEIGHTS,
  LAWYER_COUNTRIES,
  PROVINCES,
  PRONOUNS,
  RESIDENCIES,
  RESIDENCY_WEIGHTS,
  type Residency,
  VEHICLE_WEIGHTS,
  type VehicleKind,
  VEHICLES,
} from "./placeholderPeople.ts";

export type Doc = Record<string, unknown>;
export type SeedSize = "demo" | "pilot" | "large";

export const SIZES: Record<SeedSize, { members: number; lawyers: number; staff: number; windowDays: number; leadsPerCheckMember: number }> = {
  demo: { members: 16, lawyers: 3, staff: 3, windowDays: 180, leadsPerCheckMember: 6 },
  pilot: { members: 60, lawyers: 6, staff: 4, windowDays: 182, leadsPerCheckMember: 10 },
  large: { members: 300, lawyers: 12, staff: 6, windowDays: 365, leadsPerCheckMember: 10 },
};

export interface SeedOptions {
  size: SeedSize;
  seed: number;
  now?: Date;
  /** Batch id stamped on every document (default ph-<size>-<seed>). */
  batch?: string;
  /** Real inbox for one placeholder member (PLACEHOLDER_MEMBER_EMAIL). */
  memberEmail?: string;
  /** Real inbox for one placeholder lawyer (PLACEHOLDER_LAWYER_EMAIL). */
  lawyerEmail?: string;
  /** Real staff inbox that owns part of the CSM queue (PLACEHOLDER_CSM_EMAIL). */
  csmEmail?: string;
  /** Object names for tiny placeholder PDFs (--with-files). */
  withFiles?: boolean;
  /** Account seed (scripts/seedAccounts.ts): centre the story on real login accounts. */
  focus?: FocusOptions;
}

/**
 * Account seed: lawyer 0 takes the real providers doc id, member 0 the real
 * clients doc id; lawyer 0 gets a larger book (`lawyerShare` of the members),
 * a scripted "today" (six calls in every state) and fee history over the
 * window; member 0 gets every money state, a long message thread and more
 * documents. Without `focus` the output is unchanged.
 */
export interface FocusOptions {
  lawyerId: string;
  lawyerName?: string;
  lawyerAreas?: Area[];
  memberId: string;
  memberName?: { first: string; last: string };
  /** Share of the other members whose matters all go to lawyer 0 (default 0.4). */
  lawyerShare?: number;
  /** Share of members owned by the first CSM (the staff account); default 0.65, account seed 0.35. */
  csmShare?: number;
}

export interface SeedData {
  batch: string;
  now: string;
  /** Client id of the login-alias member (not ph_), when memberEmail is set. */
  aliasClientId: string | null;
  /** Business data, by collection. */
  collections: Record<string, Doc[]>;
  /** Config/catalog docs, written only when the collection is empty (or --config=always). */
  config: Record<string, Doc[]>;
  /** Subcollection docs: path "clients/<id>/<sub>". */
  subcollections: Array<{ path: string; docs: Doc[] }>;
  /** Placeholder files to upload with --with-files. */
  files: Array<{ clientId: string; docId: string; objectName: string; fileName: string }>;
}

// ─── Deterministic randomness ─────────────────────────────────────────────

export class Rng {
  private a: number;
  private readonly base: number;
  constructor(seed: number) {
    this.base = (seed >>> 0) || 1;
    this.a = this.base;
  }
  /**
   * Restart the stream from (seed, keys…). Each member/phase gets its own
   * stream, so a change in one member's story (a new month, today's date)
   * does not reshuffle every member after it.
   */
  reseed(...keys: Array<number | string>): void {
    let h = this.base ^ 0x9e3779b9;
    for (const k of keys) {
      const s = String(k);
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    }
    this.a = h || 1;
  }
  next(): number {
    let t = (this.a = (this.a + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
  weighted<T>(pairs: ReadonlyArray<readonly [T, number]>): T {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      r -= w;
      if (r < 0) return v;
    }
    return pairs[pairs.length - 1][0];
  }
  shuffle<T>(list: readonly T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

// ─── Time helpers (Costa Rica = UTC-6, no DST) ────────────────────────────

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

function crMidnight(now: Date): number {
  const d = new Date(now.getTime() - 6 * HOUR);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + 6 * HOUR;
}
const iso = (ms: number) => new Date(ms).toISOString();
const ymd = (ms: number) => iso(ms).slice(0, 10);
function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
}
/** Day of week (0 = Sunday) in Costa Rica. */
const crDow = (ms: number) => new Date(ms - 6 * HOUR).getUTCDay();

// ─── Content pools ────────────────────────────────────────────────────────

const US_AREA = ["503", "612", "415", "512", "720", "206", "305", "216", "919", "480", "602", "828", "941", "571"] as const;
const CA_AREA = ["604", "416", "647", "902", "403", "613", "250"] as const;

type Loc = { place: string; province: string };

/** ILP legal areas used on matters, specialties and opportunities. */
export const AREAS = ["immigration", "real_estate", "corporate", "tax", "vehicle", "family_estate", "labor"] as const;
export type Area = (typeof AREAS)[number];
/** providers.legalAreas only accepts the provider taxonomy. */
const PROVIDER_AREA: Record<Area, string> = {
  immigration: "immigration",
  real_estate: "real_estate",
  corporate: "corporate",
  tax: "compliance",
  vehicle: "other",
  family_estate: "family_estate",
  labor: "other",
};

interface LawyerSeed {
  first: string;
  last: string;
  city: string;
  areas: Area[];
  bio: string;
  hourly: number;
}
export const LAWYERS: LawyerSeed[] = [
  { first: "Carolina", last: "Mora Jiménez", city: "Liberia, Guanacaste", areas: ["real_estate", "corporate", "family_estate"], bio: "Property and corporate lawyer and notary. Title studies, S.A. clean-ups and wills for owners in Guanacaste.", hourly: 150 },
  { first: "Esteban", last: "Solano Rojas", city: "San José", areas: ["immigration", "labor"], bio: "Immigration lawyer: pensionado, rentista, inversionista and digital nomad files, DIMEX renewals; household employment.", hourly: 130 },
  { first: "Lucía", last: "Vindas Calderón", city: "Escazú, San José", areas: ["corporate", "tax", "vehicle"], bio: "Corporate and tax counsel. S.A./S.R.L. upkeep, corporation tax, RTBF filings, rental income and IVA; vehicle imports.", hourly: 165 },
  { first: "Mauricio", last: "Quesada Arias", city: "Tamarindo, Guanacaste", areas: ["real_estate", "family_estate"], bio: "Real estate closings, maritime zone (ZMT) concessions and estates for foreign owners on the Pacific coast.", hourly: 155 },
  { first: "Daniela", last: "Chaves Brenes", city: "Heredia", areas: ["immigration", "labor"], bio: "Residency applications and renewals, CCSS registration, domestic staff contracts and aguinaldo.", hourly: 120 },
  { first: "Rodrigo", last: "Alfaro Céspedes", city: "Santa Ana, San José", areas: ["tax", "corporate", "vehicle"], bio: "Tax filings for rental owners, IVA registration, corporate compliance; marchamo and vehicle transfers.", hourly: 160 },
  { first: "Gabriela", last: "Monge Ulate", city: "Atenas, Alajuela", areas: ["family_estate", "immigration"], bio: "Wills, prenuptial agreements (capitulaciones) and family residency for retirees in the Central Valley.", hourly: 135 },
  { first: "Andrés", last: "Salas Zúñiga", city: "Uvita, Puntarenas", areas: ["real_estate"], bio: "Boundary surveys, title review and purchases in the Southern Zone (Dominical, Uvita, Ojochal).", hourly: 145 },
  { first: "Marcela", last: "Rojas Villalobos", city: "Grecia, Alajuela", areas: ["labor", "corporate"], bio: "Employment law for households and small businesses: contracts, Caja, work-risk policy, terminations.", hourly: 125 },
  { first: "Pablo", last: "Herrera Segura", city: "Alajuela", areas: ["vehicle", "tax"], bio: "Vehicle imports, RTV and marchamo questions; personal income tax for residents.", hourly: 115 },
  { first: "Natalia", last: "Campos Barrantes", city: "Nosara, Guanacaste", areas: ["immigration", "real_estate"], bio: "Residency and property work for the Nicoya Peninsula community.", hourly: 140 },
  { first: "Felipe", last: "Arce Murillo", city: "Puerto Viejo, Limón", areas: ["real_estate", "family_estate"], bio: "Caribbean coast property, estates and title clean-ups.", hourly: 140 },
];

export const STAFF = [
  { name: "Mariana Quesada", email: "mariana.quesada@example.com", role: "csm" },
  { name: "Kevin Araya", email: "kevin.araya@example.com", role: "csm" },
  { name: "Sofía Herrera", email: "sofia.herrera@example.com", role: "csm" },
  { name: "Daniel Ortiz", email: "daniel.ortiz@example.com", role: "admin" },
  { name: "Laura Jiménez", email: "laura.jimenez@example.com", role: "csm" },
  { name: "Tomás Rivera", email: "tomas.rivera@example.com", role: "staff" },
] as const;

// ─── Matter scripts by legal area ─────────────────────────────────────────

interface MatterScript {
  title: string; // {loc} = place
  question: string;
  /** Short call dialogue; {L} lawyer first name, {M} member first name, {loc} place. */
  dialogue: string[];
  summary: string;
  steps: LegalNextStep[]; // dueAt filled at build time (days in `dueInDays`)
  dueInDays: number[];
  nextStep: { what: string; who: "client" | "lawyer" | "ilp" };
  opportunity?: { title: string; min: number; max: number; lines: string[]; note: string };
}

export const SCRIPTS: Record<Area, MatterScript[]> = {
  immigration: [
    {
      title: "Pensionado residency application",
      question: "Which documents do I need for pensionado residency, and do they all need apostilles?",
      dialogue: [
        "{L}: Thanks for joining, {M}. You have a US pension of at least US$1,000 a month, correct?",
        "{M}: Yes, Social Security plus a small pension from my old employer.",
        "{L}: Good. We need the pension letter, your birth certificate and an FBI background check, all apostilled and translated.",
        "{M}: Does the background check expire?",
        "{L}: It is usually valid for six months from issue, so we time it close to filing. Fingerprints are taken here at the Ministry of Security.",
      ],
      summary: "Member appears to qualify for pensionado residency. Documents needed: pension letter, birth certificate and FBI check, apostilled and translated. Background check should be issued within six months of filing.",
      steps: [
        { what: "Request the apostilled pension letter and birth certificate", who: "client" },
        { what: "Order the FBI background check once the other documents are in hand", who: "client" },
        { what: "Review the translated file before the Migración appointment", who: "lawyer" },
      ],
      dueInDays: [14, 30, 45],
      nextStep: { what: "Send the apostilled pension letter", who: "client" },
      opportunity: { title: "Pensionado residency filing", min: 1200, max: 2200, lines: ["Residency application preparation and filing", "Certified translations", "Accompaniment to fingerprints and Migración"], note: "Wants us to run the full pensionado filing. Quote the application package; translations extra." },
    },
    {
      title: "Rentista residency renewal",
      question: "My rentista residency expires soon. Is my new bank letter enough for the renewal?",
      dialogue: [
        "{L}: {M}, your DIMEX expires in about three months, so this is the right time.",
        "{M}: My bank issued a letter showing the deposit, is that enough?",
        "{L}: It needs to show US$2,500 a month guaranteed for two years, or the US$60,000 deposit. Let's check the wording.",
        "{M}: And the Caja?",
        "{L}: Your CCSS payments must be current; bring the certificate. Book the renewal appointment early, they fill up.",
      ],
      summary: "Rentista renewal is due in roughly three months. The bank letter may need different wording (US$2,500/month for two years). CCSS must be current; a certificate is needed for the appointment.",
      steps: [
        { what: "Ask the bank to reissue the letter with the two-year guarantee wording", who: "client" },
        { what: "Download the CCSS good-standing certificate", who: "client" },
        { what: "Book the renewal appointment", who: "ilp" },
      ],
      dueInDays: [10, 14, 21],
      nextStep: { what: "Get the reissued bank letter", who: "client" },
    },
    {
      title: "DIMEX renewal",
      question: "How early can I renew my DIMEX card and what do I bring?",
      dialogue: [
        "{L}: You can renew up to three months before the card expires.",
        "{M}: Do I go to Migración or to the bank?",
        "{L}: Renewals of the card itself are done through the Banco de Costa Rica appointment system. Bring the Caja certificate and the payment receipts.",
        "{M}: Great, that is simpler than I feared.",
      ],
      summary: "DIMEX can be renewed up to three months before expiry through the BCR appointment system. Bring CCSS certificate and payment receipts.",
      steps: [
        { what: "Book the BCR DIMEX appointment", who: "client" },
        { what: "Pay the renewal fee and keep the receipts", who: "client" },
      ],
      dueInDays: [7, 14],
      nextStep: { what: "Book the BCR appointment", who: "client" },
    },
    {
      title: "Digital nomad stay: extension and local driving",
      question: "Can I extend the digital nomad stay, and can I drive on my US licence?",
      dialogue: [
        "{L}: The digital nomad stay is one year and can usually be extended once for another year.",
        "{M}: And my US driver's licence?",
        "{L}: Under this status you can typically drive with your foreign licence for the length of the stay. Keep your passport with the entry stamp in the car.",
        "{M}: Do I need private health insurance for the extension?",
        "{L}: Yes, coverage for the whole extension period.",
      ],
      summary: "Digital nomad stay may be extended once. Foreign licence generally valid during the stay. Extension requires income proof and health insurance for the full period.",
      steps: [
        { what: "Get a health insurance certificate covering the extension year", who: "client" },
        { what: "Prepare the extension request", who: "lawyer" },
      ],
      dueInDays: [21, 30],
      nextStep: { what: "Send the insurance certificate", who: "client" },
      opportunity: { title: "Digital nomad extension filing", min: 450, max: 900, lines: ["Extension request preparation and filing"], note: "Interested in us filing the extension. Small package." },
    },
    {
      title: "Inversionista residency through the {loc} property",
      question: "Does my house in {loc} qualify me for investor residency?",
      dialogue: [
        "{L}: The threshold is US$150,000 of registered value. Your property is registered above that.",
        "{M}: The house is in my S.A. Does that still count?",
        "{L}: It can, with a certification of the shares and the registry. We need to show you own the company.",
      ],
      summary: "Property value appears to meet the US$150,000 investor threshold. Ownership through an S.A. needs share and registry certifications.",
      steps: [
        { what: "Send the S.A. share register and a recent registry certification", who: "client" },
        { what: "Confirm the registered value meets the threshold", who: "lawyer" },
      ],
      dueInDays: [10, 20],
      nextStep: { what: "Lawyer to confirm the registered value", who: "lawyer" },
      opportunity: { title: "Inversionista residency filing", min: 1800, max: 3200, lines: ["Investor residency application", "Corporate certifications and share review", "Translations and apostille check"], note: "Strong candidate for inversionista via the S.A. property. Quote the full filing." },
    },
  ],
  real_estate: [
    {
      title: "Title study before buying in {loc}",
      question: "What should a title study check before I sign the purchase of a lot in {loc}?",
      dialogue: [
        "{L}: We pull the registry for liens, annotations and the cadastral plan.",
        "{M}: The seller says everything is clean.",
        "{L}: Usually it is, but we also compare the plan with the site. In {loc} boundaries along the road are often off by a metre or two.",
        "{M}: How long does it take?",
        "{L}: About a week once we have the folio real number.",
      ],
      summary: "Title study recommended before purchase: registry liens and annotations, cadastral plan versus the site, municipal status. Needs the folio real number.",
      steps: [
        { what: "Send the folio real number and the seller's plan", who: "client" },
        { what: "Deliver the title study (estudio registral)", who: "lawyer" },
      ],
      dueInDays: [3, 10],
      nextStep: { what: "Lawyer to deliver the title study", who: "lawyer" },
      opportunity: { title: "Purchase closing and title transfer", min: 1500, max: 4500, lines: ["Purchase agreement review", "Closing deed and registration", "Escrow coordination"], note: "Will close in ~6 weeks. Quote closing and transfer; transfer taxes paid separately." },
    },
    {
      title: "Boundary discrepancy on the {loc} lot",
      question: "My neighbour's fence is two metres inside my plan. What can I do?",
      dialogue: [
        "{L}: First we confirm with a surveyor whether the plan or the fence is right.",
        "{M}: I'd rather not fight with the neighbour.",
        "{L}: Most of these settle with a joint survey and an agreement. Only if that fails do we look at a legal claim.",
      ],
      summary: "Apparent two-metre boundary discrepancy. Next: joint survey; settlement agreement usually possible before any claim.",
      steps: [
        { what: "Hire a topógrafo for a joint survey", who: "client" },
        { what: "Draft a boundary agreement if the survey confirms the plan", who: "lawyer" },
      ],
      dueInDays: [14, 30],
      nextStep: { what: "Book the surveyor", who: "client" },
      opportunity: { title: "Boundary agreement and plan correction", min: 600, max: 1400, lines: ["Boundary agreement drafting", "Plan correction filing"], note: "Survey first; then agreement and plan correction. Mid-size quote." },
    },
    {
      title: "Maritime zone (ZMT) concession review",
      question: "My beach house in {loc} is on a concession. When does it expire and can I renew?",
      dialogue: [
        "{L}: Concessions in the maritime zone are granted by the municipality, usually for 20 years.",
        "{M}: Mine was transferred to me with the house.",
        "{L}: Then we need the municipal file and the ICT approval of the transfer. Renewal depends on canon payments being current.",
      ],
      summary: "Property sits on a ZMT concession. Need the municipal file and ICT approval of the transfer; renewal depends on current canon payments.",
      steps: [
        { what: "Request the concession file from the municipality", who: "ilp" },
        { what: "Review canon payments and renewal date", who: "lawyer" },
      ],
      dueInDays: [10, 21],
      nextStep: { what: "ILP to request the municipal file", who: "ilp" },
      opportunity: { title: "ZMT concession renewal", min: 2000, max: 4500, lines: ["Concession renewal application", "Municipal and ICT follow-up"], note: "Concession renewal in under two years. Quote renewal application." },
    },
    {
      title: "Selling the {loc} house: transfer and taxes",
      question: "I'm selling my house in {loc}. What taxes apply and who pays the transfer costs?",
      dialogue: [
        "{L}: Transfer tax and registry fees are usually split or paid by the buyer, it is negotiable.",
        "{M}: What about capital gains?",
        "{L}: Since 2019 there is a capital gains tax that may apply; there are exemptions for a primary residence. We need your purchase deed and improvements.",
      ],
      summary: "Sale costs negotiable between parties. Capital gains tax may apply; primary-residence exemption possible. Needs purchase deed and records of improvements.",
      steps: [
        { what: "Gather the purchase deed and receipts for improvements", who: "client" },
        { what: "Estimate capital gains exposure", who: "lawyer" },
      ],
      dueInDays: [7, 14],
      nextStep: { what: "Send the purchase deed", who: "client" },
      opportunity: { title: "Sale closing and capital gains filing", min: 1800, max: 4000, lines: ["Sale agreement and closing deed", "Capital gains declaration"], note: "Seller side, closing in ~2 months. Quote closing + capital gains filing." },
    },
  ],
  corporate: [
    {
      title: "S.A. clean-up: overdue corporation tax and books",
      question: "My S.A. hasn't paid the corporation tax for two years. How bad is it?",
      dialogue: [
        "{L}: Unpaid corporation tax carries interest and blocks registry certifications, so it matters if you sell.",
        "{M}: I didn't know it applied to a company that only holds the house.",
        "{L}: It applies to active and inactive companies. We can pay the arrears and update the legal books.",
        "{M}: And the beneficial-owner filing?",
        "{L}: That too, every April. Let's get it current in one go.",
      ],
      summary: "S.A. owes about two years of corporation tax; registry certifications are blocked until paid. Legal books need updating. RTBF beneficial-owner filing also due each April.",
      steps: [
        { what: "Send the S.A. legal books and shareholder register", who: "client" },
        { what: "Prepare a clean-up plan with the overdue corporation tax", who: "lawyer" },
      ],
      dueInDays: [5, 12],
      nextStep: { what: "Send the legal books", who: "client" },
      opportunity: { title: "S.A. clean-up", min: 900, max: 2200, lines: ["Overdue corporation tax filings", "Legal books legalisation and shareholder update", "RTBF beneficial-owner filing"], note: "S.A. clean-up quote: overdue corporation tax x2, book legalisation, shareholder update. RTBF included." },
    },
    {
      title: "RTBF beneficial-owner filing",
      question: "Do I need to file the beneficial-owner declaration for my S.R.L. every year?",
      dialogue: [
        "{L}: Yes, the RTBF declaration with the Central Bank is annual, usually in April.",
        "{M}: I need a digital signature for that, right?",
        "{L}: The legal representative signs with a Firma Digital, or we file through an authorised agent.",
      ],
      summary: "RTBF beneficial-owner declaration is annual (April). Requires Firma Digital or filing through an authorised agent.",
      steps: [
        { what: "Confirm who the legal representative is", who: "client" },
        { what: "File the RTBF declaration through the agent", who: "lawyer" },
      ],
      dueInDays: [7, 30],
      nextStep: { what: "Confirm the legal representative", who: "client" },
      opportunity: { title: "Annual RTBF filing service", min: 300, max: 600, lines: ["RTBF declaration as authorised agent"], note: "Recurring RTBF filing. Small annual quote." },
    },
    {
      title: "Dormant S.A.: dissolve or keep",
      question: "I have an S.A. with nothing in it. Should I dissolve it?",
      dialogue: [
        "{L}: A dormant S.A. still owes the annual corporation tax and the RTBF filing.",
        "{M}: So dissolving saves money every year.",
        "{L}: Usually, once arrears are paid. Dissolution is published in the Gazette and takes a few months.",
      ],
      summary: "Dormant S.A. still has annual tax and RTBF duties. Dissolution possible after arrears are paid; takes a few months including publication.",
      steps: [
        { what: "Decide between dissolution and keeping the S.A.", who: "client" },
        { what: "Check arrears with Hacienda", who: "lawyer" },
      ],
      dueInDays: [14, 7],
      nextStep: { what: "Decide: dissolve or keep", who: "client" },
      opportunity: { title: "S.A. dissolution", min: 700, max: 1300, lines: ["Shareholder resolution and dissolution deed", "Gazette publication and registry filing"], note: "Likely to dissolve. Quote dissolution after arrears check." },
    },
    {
      title: "Moving the {loc} property out of the S.A.",
      question: "Should I move my house out of the S.A. into my own name?",
      dialogue: [
        "{L}: It is possible but there is transfer tax on the registered value.",
        "{M}: Is there any benefit?",
        "{L}: Fewer annual filings and simpler estate planning; we can compare the costs side by side.",
      ],
      summary: "Transfer out of the S.A. possible; transfer tax applies on registered value. Trade-off: fewer annual filings and simpler estate planning.",
      steps: [{ what: "Prepare a cost comparison: keep S.A. vs. personal title", who: "lawyer" }],
      dueInDays: [10],
      nextStep: { what: "Lawyer to send the cost comparison", who: "lawyer" },
      opportunity: { title: "Property transfer out of S.A.", min: 1200, max: 3000, lines: ["Transfer deed", "Registry filing", "S.A. dissolution (optional)"], note: "Wants comparison then likely transfer. Quote transfer + optional dissolution." },
    },
  ],
  tax: [
    {
      title: "Short-term rental income: Hacienda registration and IVA",
      question: "I rent my villa on short-term platforms. Do I need to register with Hacienda and charge IVA?",
      dialogue: [
        "{L}: Short-term rentals are generally subject to income tax and 13% IVA.",
        "{M}: The platform already collects something.",
        "{L}: Some platforms withhold part of it, but you still need to be registered and file. We should register the activity code.",
      ],
      summary: "Short-term rental income generally requires Hacienda registration, income tax and 13% IVA filings, even when a platform withholds.",
      steps: [
        { what: "Send last year's platform payout statements", who: "client" },
        { what: "Confirm the activity code and registration", who: "lawyer" },
      ],
      dueInDays: [7, 14],
      nextStep: { what: "Send platform payout statements", who: "client" },
      opportunity: { title: "Hacienda registration and first IVA filings", min: 400, max: 900, lines: ["Taxpayer registration and activity code", "First quarter IVA filings"], note: "Needs registration + IVA filings. Possible monthly bookkeeping upsell." },
    },
    {
      title: "Annual rental income declaration (D-101)",
      question: "What is the deadline for declaring my long-term rental income?",
      dialogue: [
        "{L}: The annual income tax return is usually due in March for the previous year.",
        "{M}: Can I deduct the property management fees?",
        "{L}: Under the simplified rental regime there's a flat deduction instead. We can compare which is better for you.",
      ],
      summary: "Annual income tax return generally due in March. Compare flat rental deduction with actual expenses.",
      steps: [{ what: "Send rental income and expense summary for the year", who: "client" }],
      dueInDays: [21],
      nextStep: { what: "Send the rental income summary", who: "client" },
      opportunity: { title: "Annual D-101 filing", min: 300, max: 700, lines: ["Annual income tax return preparation"], note: "Annual return. Small recurring quote." },
    },
    {
      title: "Capital gains on the {loc} sale",
      question: "How is capital gains tax calculated if I sell my condo in {loc}?",
      dialogue: [
        "{L}: You can choose 15% of the gain, or 2.25% of the sale price when you can't prove the purchase cost.",
        "{M}: I have the original deed.",
        "{L}: Then we'll calculate both and pick the lower one.",
      ],
      summary: "Capital gains may be taxed at 15% of gain or 2.25% of price. Member has the original deed; compute both options.",
      steps: [{ what: "Calculate both capital gains options", who: "lawyer" }],
      dueInDays: [10],
      nextStep: { what: "Lawyer to calculate the options", who: "lawyer" },
    },
  ],
  vehicle: [
    {
      title: "Marchamo and RTV for the car",
      question: "When do I pay the marchamo and what happens if my RTV inspection is late?",
      dialogue: [
        "{L}: The marchamo is paid every year by December 31; payment usually opens in November.",
        "{M}: My RTV sticker expired last month.",
        "{L}: Book the RTV inspection now; driving with an expired RTV can be fined, and some insurers ask for it.",
      ],
      summary: "Marchamo due by December 31 each year. RTV inspection expired; book a new inspection promptly.",
      steps: [{ what: "Book the RTV inspection", who: "client" }],
      dueInDays: [7],
      nextStep: { what: "Book the RTV inspection", who: "client" },
    },
    {
      title: "Importing the car under residency",
      question: "I want to bring my SUV from Florida. What are the import taxes?",
      dialogue: [
        "{L}: Import taxes depend on the vehicle's age and value; for a few years old SUV it can be around 50% to 80% of the customs value.",
        "{M}: That's a lot.",
        "{L}: It often makes sense to buy locally. We can estimate both before you ship.",
      ],
      summary: "Import taxes depend on age and value and are often 50-80% of customs value. Compare with buying locally before shipping.",
      steps: [{ what: "Send the VIN and purchase invoice for an estimate", who: "client" }],
      dueInDays: [7],
      nextStep: { what: "Send the VIN and invoice", who: "client" },
      opportunity: { title: "Vehicle import and registration", min: 600, max: 1200, lines: ["Customs broker coordination", "Registration and plates"], note: "Will import if estimate is acceptable. Quote import + registration." },
    },
    {
      title: "Vehicle transfer after a private sale",
      question: "I sold my car privately. How do I make sure the transfer is registered?",
      dialogue: [
        "{L}: The transfer is done by notarial deed and registered with the Registro Nacional.",
        "{M}: The buyer says he'll do it later.",
        "{L}: Until it's registered, fines and the marchamo stay in your name. Better to sign the deed together now.",
      ],
      summary: "Private sale must be registered by notarial deed; until then fines and marchamo stay with the seller. Sign the deed promptly.",
      steps: [{ what: "Schedule the deed signing with the buyer", who: "client" }],
      dueInDays: [5],
      nextStep: { what: "Schedule the deed signing", who: "client" },
      opportunity: { title: "Vehicle transfer deed", min: 300, max: 500, lines: ["Transfer deed and registration"], note: "Notarial transfer deed. Small quote." },
    },
  ],
  family_estate: [
    {
      title: "Costa Rican will for the {loc} property",
      question: "Does my US will cover my house in {loc}?",
      dialogue: [
        "{L}: A foreign will can be recognised, but probate here is slow and costly without a local will.",
        "{M}: So I should have one here too?",
        "{L}: A Costa Rican will limited to assets here is common and works alongside your US will.",
      ],
      summary: "Foreign will may be recognised but local probate is slow. A Costa Rican will covering local assets is recommended alongside the US will.",
      steps: [
        { what: "List Costa Rican assets and beneficiaries", who: "client" },
        { what: "Draft the Costa Rican will", who: "lawyer" },
      ],
      dueInDays: [14, 30],
      nextStep: { what: "Send the asset and beneficiary list", who: "client" },
      opportunity: { title: "Costa Rican will", min: 500, max: 1100, lines: ["Will drafting and notarisation", "Registry of wills filing"], note: "Wants a local will for the property. Quote will + registration." },
    },
    {
      title: "Prenuptial agreement (capitulaciones)",
      question: "We're getting married here. Do we need a prenup for our property?",
      dialogue: [
        "{L}: Without capitulaciones, assets acquired during marriage are shared on divorce.",
        "{M}: We each own a house from before.",
        "{L}: Those stay separate, but improvements and new purchases may not. A short agreement settles it.",
      ],
      summary: "Without capitulaciones, assets acquired during marriage are shared. Pre-marital houses stay separate; an agreement clarifies improvements and new assets.",
      steps: [{ what: "Draft capitulaciones for review", who: "lawyer" }],
      dueInDays: [21],
      nextStep: { what: "Lawyer to send the draft agreement", who: "lawyer" },
      opportunity: { title: "Capitulaciones matrimoniales", min: 600, max: 1200, lines: ["Prenuptial agreement drafting and notarisation"], note: "Wedding in 3 months. Quote capitulaciones." },
    },
    {
      title: "Estate (sucesión) for late spouse's property",
      question: "My husband passed away. How do I transfer our house in {loc} to my name?",
      dialogue: [
        "{L}: I'm sorry for your loss. The transfer is done through a sucesión, which can be notarial if there's no dispute.",
        "{M}: There are no disputes, the kids agree.",
        "{L}: Then a notarial process is faster, usually several months. We need the death certificate, apostilled.",
      ],
      summary: "Transfer through a notarial sucesión appears possible (no disputes). Needs apostilled death certificate; several months.",
      steps: [
        { what: "Send the apostilled death certificate", who: "client" },
        { what: "Open the notarial sucesión", who: "lawyer" },
      ],
      dueInDays: [14, 30],
      nextStep: { what: "Send the apostilled death certificate", who: "client" },
      opportunity: { title: "Notarial sucesión", min: 2000, max: 4500, lines: ["Notarial probate process", "Property transfer registration"], note: "Uncontested estate. Quote notarial sucesión." },
    },
  ],
  labor: [
    {
      title: "Housekeeper contract, Caja and aguinaldo",
      question: "We have a housekeeper three days a week. What do we owe her?",
      dialogue: [
        "{L}: Domestic workers are entitled to minimum wage pro rata, Caja registration, vacation and the aguinaldo in December.",
        "{M}: We pay her cash.",
        "{L}: That's common, but you should register as an employer with the Caja and get a work-risk policy from INS.",
      ],
      summary: "Housekeeper is entitled to pro-rata minimum wage, Caja, vacation and aguinaldo. Employer registration with the Caja and an INS work-risk policy are needed.",
      steps: [
        { what: "Register as an employer with the Caja", who: "client" },
        { what: "Prepare a written employment contract", who: "lawyer" },
      ],
      dueInDays: [14, 21],
      nextStep: { what: "Register with the Caja", who: "client" },
      opportunity: { title: "Domestic employment set-up", min: 300, max: 650, lines: ["Employment contract", "Caja and INS registration support"], note: "Household employer set-up. Small package." },
    },
    {
      title: "Ending the gardener's employment (liquidación)",
      question: "We're moving and need to end our gardener's job. What do we pay?",
      dialogue: [
        "{L}: Without cause you owe notice, severance (cesantía), unused vacation and proportional aguinaldo.",
        "{M}: He has worked for us four years.",
        "{L}: Then I'll calculate it exactly and prepare a settlement he signs.",
      ],
      summary: "Termination without cause: notice, cesantía, unused vacation and proportional aguinaldo. Four years of service; calculate and document a signed settlement.",
      steps: [{ what: "Calculate the liquidación and draft the settlement", who: "lawyer" }],
      dueInDays: [7],
      nextStep: { what: "Lawyer to send the liquidación figures", who: "lawyer" },
    },
  ],
};

/** Member questions for Lily (AI assistant) and its general replies. */
const LILY: Array<[string, string]> = [
  ["What is the marchamo?", "The marchamo is Costa Rica's annual vehicle circulation permit, usually paid between November and December 31. This is general information from the AI assistant; your ILP team will confirm what applies to you."],
  ["Do I need to file anything for my S.A. this year?", "Most corporations pay the annual corporation tax by January 31 and file the beneficial-owner (RTBF) declaration in April. This is general information from the AI assistant, not legal advice; your lawyer will confirm for your company."],
  ["How long is a DIMEX valid?", "Temporary residency cards are commonly valid for one or two years and permanent ones for longer. This is general information from the AI assistant; your ILP team will confirm your dates."],
  ["Can I work remotely for a US company on a tourist stay?", "That question depends on your status and the work. The digital nomad stay was created for remote work for foreign employers. This is general information from the AI assistant; please book a call so your lawyer can confirm."],
  ["What is the aguinaldo?", "The aguinaldo is a year-end bonus, roughly one month of salary prorated, usually due by December 20, including for household staff. This is general information from the AI assistant; your ILP team will confirm what you owe."],
  ["Is there property tax in Costa Rica?", "Yes, municipal property tax (bienes inmuebles) is generally 0.25% of the registered value, paid to the municipality. This is general information from the AI assistant, not legal advice."],
];

const TEAM_MESSAGES = [
  "Hi {M}, welcome to ILP. I'm your member success manager. Your first call can be booked from the Book tab whenever you're ready.",
  "Thanks for sending the documents, {M}. I've passed them to {L} and will confirm once they're reviewed.",
  "Quick reminder: {L} asked for the item in your Next step card. Let me know if anything is unclear.",
  "{L} confirmed the summary from your call; the next steps are now on your home page.",
];
const MEMBER_MESSAGES = [
  "Thanks! Is there anything I should prepare before the call?",
  "I uploaded the scan, can you confirm you received it?",
  "Could we move my call to next week? Something came up.",
  "That's very helpful, thank you.",
];
const TEAM_MESSAGES_ES = [
  "Hola {M}, bienvenido a ILP. Soy tu gestora de cuenta. Puedes reservar tu primera llamada desde la pestaña Book cuando quieras.",
  "Gracias por enviar los documentos, {M}. Ya se los pasé a {L} y te confirmo cuando estén revisados.",
  "{L} confirmó el resumen de tu llamada; los próximos pasos ya están en tu página de inicio.",
];
const MEMBER_MESSAGES_ES = [
  "¡Gracias! ¿Necesito preparar algo antes de la llamada?",
  "Subí el escaneo del pasaporte, ¿me confirman que les llegó?",
  "¿Podemos mover la llamada a la próxima semana?",
];
/**
 * Account seed: the member account's message thread, oldest first.
 * [who, days ago, text]; "ask"/"ai" go to the AI assistant thread (labelled AI in the portal).
 */
const FOCUS_THREAD: Array<["csm" | "lawyer" | "member" | "ask" | "ai", number, string]> = [
  ["csm", 46, "Hi {M}, welcome to ILP! I'm your member success manager. I've set up your profile from the check you took; when you have a minute, please finish the household and property sections so {L} has everything before your first call."],
  ["member", 45.8, "Thank you! Quick question before I start: do you need my spouse's documents too, or only mine?"],
  ["csm", 45.6, "Only yours for now. If your spouse applies as your dependent later, we'll ask for their birth and marriage certificates then."],
  ["ask", 44, "How long is a DIMEX valid?"],
  ["ai", 44, "Temporary residency cards are commonly valid for one or two years and permanent ones for longer. This is general information from the AI assistant; your ILP team will confirm what applies to you."],
  ["member", 40, "I uploaded my passport scan and the pension letter (PDF) to Documents. The bank letter is still on its way from Vermont."],
  ["csm", 39.9, "Got both, thank you. The passport scan is clear; the pension letter needs the apostille page too. Could you upload that page as a separate file when you have it?"],
  ["lawyer", 35, "Hello {M}, I'm {L}. I read your profile before our call. Please have the property deed (escritura) for the house in {loc} at hand; we'll go through the registry details together."],
  ["member", 34.5, "Will do. I've attached the deed and the cadastral plan (plano catastrado) as JPGs, sorry they're photos and not scans 📎"],
  ["lawyer", 34.4, "Photos are fine for now. For the filing itself we'll need a certified copy, which I can request from the Registro Nacional."],
  ["ask", 28, "Do I need to file anything for my S.A. this year?"],
  ["ai", 28, "Most corporations pay the annual corporation tax by January 31 and file the beneficial-owner (RTBF) declaration in April. This is general information from the AI assistant; your ILP team will confirm what applies to you."],
  ["member", 27.9, "The assistant mentioned the RTBF filing. Is that something ILP handles?"],
  ["csm", 27.5, "Yes. {L} can quote the annual corporate upkeep (corporation tax + RTBF). I've added it to your proposals so you can review it under Money."],
  ["member", 20, "Hola, ¿pueden confirmarme si el pago de la Caja de mi empleada doméstica está al día? Mi contadora dice que falta un mes."],
  ["csm", 19.8, "¡Hola {M}! Lo revisé con {L}: falta el mes de agosto. Te dejé los pasos en tu tarjeta de próximo paso. Cualquier duda me escribes."],
  ["member", 12, "I accepted the proposal for the corporate work. When is the second payment due?"],
  ["csm", 11.8, "Thanks {M}! The deposit is received ✅. The balance is due on completion; you'll see it under Money with the due date."],
  ["lawyer", 6, "Filing update: the registry accepted the corporate documents. I'll confirm the new personería jurídica as soon as it's issued (usually 5-8 business days)."],
  ["member", 5.9, "Fantastic news, thank you so much! 🙏🌴"],
  ["ask", 3, "Is there property tax in Costa Rica?"],
  ["ai", 3, "Yes, municipal property tax (bienes inmuebles) is generally 0.25% of the registered value, paid to the municipality. This is general information from the AI assistant; your ILP team will confirm what applies to you."],
  ["csm", 1, "Reminder: your next call with {L} is booked (Google Meet link on your home page). If you'd like to add the property tax question to that call, use \"Ask my lawyer\" on the obligation card."],
  ["member", 0.2, "Perfect, see you then. I'll have the municipal receipt ready 🧾"],
];

/** A very long free-text note and a very short one (layout edge cases). */
const LONG_NOTE =
  "Long welcome call with {M}. Background: bought the {loc} property in 2019 through an S.A. set up by the developer's lawyer, never received the legal books, and is not sure who the current legal representative is. " +
  "Spouse is a dual citizen and may apply for residency separately next year. Adult children live abroad and would inherit; member asked whether a Costa Rican will is needed in addition to the US trust (flagged for the lawyer, no advice given). " +
  "Prefers email, reads Spanish slowly, and asked us to avoid calls before 9:00 because of a hearing aid fitting schedule. Wants a written summary after each call. Mentioned possibly selling the lot next to the house in 18 months; noted as a future real estate opportunity, not raised with the member.";
const SHORT_NOTES = ["ok", "👍", "Left voicemail."];
const CSM_NOTES = [
  "Welcome call done. Prefers email over WhatsApp; spends winters in {loc}.",
  "Asked about adding spouse to the membership. Explained the plan covers one member for now.",
  "Profile reviewed with member, missing items flagged on the Next step card.",
  "Member mentioned a possible property purchase next year; keep an eye out for a real estate opportunity.",
  "Called to confirm next steps after the lawyer call; member is on track.",
];
const OUTCOMES: Record<CsmTask["type"], string[]> = {
  onboarding: ["Welcome call done; profile reviewed and first call booked.", "Welcome email and call completed; member exploring the Book tab.", "Reached by phone, walked through the home page and minutes."],
  follow_up: ["Confirmed next steps with member by email.", "Called member; they understood the lawyer's next steps.", "Profile checked and complete before the call."],
  missing_document: ["Document received and filed.", "Member uploaded the scan; lawyer notified."],
  proposal: ["Proposal sent and walked through with member.", "Member reviewed the proposal; follow-up booked."],
  renewal: ["Renewal check-in done; member happy to continue.", "Member confirmed renewal; asked about annual plan."],
  escalation: ["Card updated; payment went through.", "Member paid by transfer; membership back to active."],
  privacy: ["Export sent to the member's verified email.", "Request reviewed and answered within the legal deadline."],
};

// ─── Builder ──────────────────────────────────────────────────────────────

export const defaultBatch = (size: SeedSize, seed: number) => `ph-${size}-${seed}`;
const pad = (n: number, w = 3) => String(n).padStart(w, "0");
const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
/**
 * COUNTRIES: the matter scripts were written for Costa Rica. For a member in
 * another country, the Costa Rican names of IDs, offices and fees become that
 * country's (from docs/research), so the story reads right.
 */
const LOCAL_TERMS: Record<Exclude<CountryCode, "CR">, Array<[RegExp, string]>> = {
  CO: [[/\bDIMEX\b/g, "cédula de extranjería"], [/\b(the )?(Caja|CCSS)\b/g, "$1social security (PILA)"], [/\bmarchamo\b/g, "vehicle tax"], [/\bRTBF\b/g, "RUB"], [/\bHacienda\b/g, "DIAN"], [/\bRegistro Nacional\b/g, "Cámara de Comercio"], [/\bMigración\b/g, "Migración Colombia"]],
  PA: [[/\bDIMEX\b/g, "carné de residente"], [/\b(the )?(Caja|CCSS)\b/g, "$1CSS"], [/\bmarchamo\b/g, "plate renewal"], [/\bRTBF\b/g, "beneficial-owner register"], [/\bHacienda\b/g, "DGI"], [/\bRegistro Nacional\b/g, "Registro Público"], [/\bMigración\b/g, "Servicio Nacional de Migración"]],
  MX: [[/\bDIMEX\b/g, "resident card"], [/\b(the )?(Caja|CCSS)\b/g, "$1IMSS"], [/\bmarchamo\b/g, "refrendo"], [/\bRTBF\b/g, "beneficial-owner records"], [/\bHacienda\b/g, "SAT"], [/\bRegistro Nacional\b/g, "Registro Público"], [/\bMigración\b/g, "INM"]],
  ES: [[/\bDIMEX\b/g, "TIE"], [/\b(the )?(Caja|CCSS)\b/g, "$1Seguridad Social"], [/\bmarchamo\b/g, "vehicle tax (IVTM)"], [/\bRTBF\b/g, "beneficial-owner form"], [/\bHacienda\b/g, "Agencia Tributaria"], [/\bRegistro Nacional\b/g, "Registro Mercantil"], [/\bMigración\b/g, "Extranjería"]],
  PT: [[/\bDIMEX\b/g, "residence card"], [/\b(the )?(Caja|CCSS)\b/g, "$1Segurança Social"], [/\bmarchamo\b/g, "IUC"], [/\bRTBF\b/g, "RCBE"], [/\bHacienda\b/g, "Autoridade Tributária"], [/\bRegistro Nacional\b/g, "Conservatória"], [/\bMigración\b/g, "AIMA"]],
};
export function localize(text: string, country?: string): string {
  if (!country || country === "CR" || !(country in LOCAL_TERMS)) return text;
  const c = country as Exclude<CountryCode, "CR">;
  let out = text.replace(/Costa Rican/g, COUNTRIES[c].adjective).replace(/Costa Rica/g, COUNTRIES[c].name);
  for (const [re, to] of LOCAL_TERMS[c]) out = out.replace(re, to);
  return out;
}
/** The yearly company obligation an "obligation" opportunity starts from, per country (lower-case rule id). */
const COMPANY_RULE: Record<CountryCode, string> = {
  CR: "cr_corp_entity_tax", CO: "co_co_matricula_renewal", PA: "pa_corp_tasa_unica", MX: "mx_co_annual_return", ES: "es_co_accounts_deposit", PT: "pt_co_ies",
};
const fill = (s: string, v: Record<string, string>) => localize(s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? ""), v.country);

/**
 * A member's free-check answers in their country's questions (docs/research),
 * from the generator's situation. Costa Rica keeps the first check's answers,
 * which normalizeAnswers translates.
 */
function seedCountryAnswers(country: CountryCode, x: {
  residency: string; resident: boolean; expires?: string; entry?: string; property: string; company: string; vehicle: string; employees: string; place: string;
}): Record<string, unknown> {
  const owns = x.property !== "none";
  const rents = x.property === "airbnb_rental";
  const hasCo = x.company !== "none";
  const car = x.vehicle !== "none";
  const staff = x.employees !== "none";
  switch (country) {
    case "CO": {
      const rs = x.residency === "permanent" ? "visa_R" : x.residency === "digital_nomad" ? "visa_digital_nomad" : x.resident ? "visa_M" : x.residency === "refused" ? "unsure" : "visitor";
      return {
        residencyStatus: rs,
        ...(rs.startsWith("visa_") && x.expires ? { visaExpiryDate: x.expires } : {}),
        ...(rs === "visitor" && x.entry ? { entryDate: x.entry } : {}),
        daysInColombia: x.resident ? "gt183" : "lt120",
        ownsProperty: !owns ? "no" : x.place === "Medellín" ? "medellin" : x.place === "Bogotá" ? "bogota" : "other",
        boughtWithForeignFunds: owns ? "yes_registered" : "na",
        rentsProperty: rents ? "short_term" : "no",
        hasCompany: hasCo ? "yes" : "no",
        ownsVehicle: !car ? "no" : x.place === "Bogotá" ? "bogota" : x.place === "Medellín" ? "antioquia" : "other",
        hasEmployees: staff ? "yes_colombian" : "no",
        hasForeignAssetsOver2000UVT: "yes",
      };
    }
    case "PA": {
      const rs = x.residency === "pensionado" || x.residency === "permanent" ? "permanent_resident" : x.residency === "in_process" ? "application_pending"
        : x.residency === "digital_nomad" ? "remote_worker_visa" : x.resident ? "provisional_resident" : x.residency === "refused" ? "not_sure" : "tourist";
      return {
        residencyStatus: rs,
        ...(rs === "permanent_resident" || rs === "provisional_resident" || rs === "application_pending" ? { residencyProgram: x.residency === "pensionado" ? "pensionado" : "friendly_nations" } : {}),
        ...(rs === "tourist" && x.entry ? { keyDate: x.entry } : x.expires && rs !== "remote_worker_visa" && rs !== "not_sure" ? { keyDate: x.expires } : {}),
        ownsProperty: !owns ? "no" : hasCo ? "yes_through_company" : rents ? "yes_second_home" : "yes_primary_home",
        ...(owns ? { rentsOutProperty: rents ? "short_term" : "no", hasPanamaWill: "no" } : {}),
        hasCompany: hasCo ? "sociedad_anonima" : "no",
        ...(hasCo ? { incorporationHalf: "jan_jun" } : {}),
        businessOperatesInPanama: x.employees === "small_business" ? "yes" : "no",
        ownsVehicle: car ? "yes" : "no",
        ...(car ? { vehicleRenewalMonth: "3" } : {}),
        hasEmployees: !staff ? "no" : x.employees === "small_business" ? "business_staff" : "domestic_staff",
        hasPanamaIncome: rents || x.employees === "small_business" ? "yes" : "no",
      };
    }
    case "MX": {
      const rs = x.residency === "permanent" ? "permanent" : x.residency === "in_process" ? "residency_visa_not_yet_exchanged"
        : x.resident ? "temporary" : x.residency === "refused" ? "not_living_in_mexico" : "visitor";
      const coastal = ["Puerto Vallarta", "Mérida", "Playa del Carmen"].includes(x.place);
      const state: Record<string, string> = { "San Miguel de Allende": "Guanajuato", "Mérida": "Yucatán", "Puerto Vallarta": "Jalisco", "Playa del Carmen": "Quintana Roo" };
      return {
        residencyStatus: rs,
        ...(rs === "temporary" && x.expires ? { residencyCardExpiry: x.expires } : {}),
        ...(rs === "visitor" && x.entry ? { visitorAuthorizedUntil: ymd(Date.parse(`${x.entry}T12:00:00Z`) + 180 * DAY) } : {}),
        ownsProperty: owns ? "yes" : "no",
        ...(owns ? { holdingStructure: coastal ? "fideicomiso" : "direct_title", propertyInRestrictedZone: coastal ? "yes" : "no" } : {}),
        rentsOutProperty: rents ? "short_term_platform" : "no",
        hasCompany: hasCo ? "yes" : "no",
        ownsVehicle: !car ? "no" : x.vehicle === "imported" ? "foreign_plates_with_TIP" : "mexican_plates",
        hasEmployees: !staff ? "no" : x.employees === "small_business" ? "company_staff" : "domestic_worker",
        hasMexicanWill: "no",
        state: state[x.place] ?? "other",
      };
    }
    case "ES": {
      const rs = x.residency === "pensionado" || x.residency === "rentista" ? "nonLucrative" : x.residency === "inversionista" ? "goldenVisa"
        : x.residency === "permanent" ? "longTerm" : x.residency === "digital_nomad" ? "digitalNomad" : x.resident ? "other" : "visitor";
      const region: Record<string, string> = { Valencia: "valencia", "Málaga": "andalucia", Madrid: "madrid" };
      return {
        residencyStatus: rs,
        ...(rs !== "visitor" && x.expires ? { permitExpiryDate: x.expires } : {}),
        isTaxResident: x.resident ? "yes" : "no",
        region: region[x.place] ?? "otra",
        ownsProperty: owns ? "yes" : "no",
        ...(owns ? { rentsOutProperty: rents ? "yes" : "no" } : {}),
        ownsVehicle: car ? "spanishPlated" : "no",
        hasCompany: hasCo ? "yes" : "no",
        hasEmployees: staff ? "yes" : "no",
        hasForeignAssetsOver50k: "yes",
        hasForeignCryptoOver50k: "no",
        netWealthBand: "under2M",
      };
    }
    case "PT": {
      const rs = x.residency === "inversionista" ? "golden_visa" : x.residency === "permanent" ? "permanent_resident" : x.residency === "in_process" ? "residence_visa_holder"
        : x.resident || x.residency === "digital_nomad" ? "temporary_resident" : "visitor";
      return {
        residencyStatus: rs,
        ...(["temporary_resident", "golden_visa", "permanent_resident"].includes(rs) && x.expires ? { permitExpiryDate: x.expires } : {}),
        isTaxResident: x.resident ? "yes" : "no",
        ...(x.resident ? { taxRegime: "none" } : {}),
        ownsProperty: !owns ? "no" : hasCo ? "company" : "yes",
        ...(owns ? { propertyValueBand: "under_600k", rentsOutProperty: rents ? "short_term" : "no" } : {}),
        hasCompany: hasCo ? "yes" : "no",
        ownsVehicle: car ? "yes" : "no",
        hasEmployees: staff ? "yes" : "no",
        hasPortugueseWill: "yes_home",
      };
    }
    default:
      return {};
  }
}
const dollars = (n: number) => Math.round(n * 100) / 100;

/** Fake Meet link in Google's xxx-xxxx-xxx shape, stable per id. */
export function meetUrlFor(id: string): string {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const letters = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + ((h >>> (i % 4) * 8) + i * 7) % 26)).join("");
  return `https://meet.google.com/${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

type Persona = "retiree" | "remote" | "owner" | "business" | "applicant";
const PERSONA_AREAS: Record<Persona, Area[]> = {
  retiree: ["immigration", "real_estate", "family_estate", "vehicle", "tax"],
  remote: ["immigration", "vehicle", "tax"],
  owner: ["real_estate", "corporate", "tax", "labor", "family_estate"],
  business: ["corporate", "tax", "labor", "real_estate"],
  applicant: ["immigration", "real_estate", "corporate"],
};
const PERSONA_LABEL: Record<Persona, string> = {
  retiree: "Retiree living in {loc}",
  remote: "Remote worker based in {loc}",
  owner: "Owns a house in {loc}, spends part of the year abroad",
  business: "Owns a Costa Rican company and rental property in {loc}",
  applicant: "Relocating to {loc}, residency in progress",
};

interface Member {
  i: number;
  id: string;
  first: string;
  last: string;
  email: string;
  phone: string;
  persona: Persona;
  loc: Loc;
  /** COUNTRIES: the country the membership covers. */
  country: CountryCode;
  profile: Doc;
  answers: CheckAnswers;
  csm: string;
  status: Membership["status"];
  activatedAt: number;
  periods: number[]; // period starts that were paid or are current
  membership: Membership & Doc;
  cancelAt?: number;
  leadId?: string;
  aiConsent: boolean;
  recordingWithdrawnAt?: number;
  /** Diversity dimensions (report + area choice). */
  situation: { background: string; residency: string; property: string; company: string; vehicle: string; employees: string; household: string; language: string; age: number; nationalities: string[]; province: string };
}

interface MatterRec {
  doc: Doc;
  script: MatterScript;
  area: Area;
  commercial: boolean;
  openedAt: number;
}

export function buildPlaceholderData(opts: SeedOptions): SeedData {
  const cfg = SIZES[opts.size];
  const rng = new Rng(opts.seed * 7919 + cfg.members);
  const now = opts.now ?? new Date();
  const NOW = now.getTime();
  const today0 = crMidnight(now);
  const batch = opts.batch ?? defaultBatch(opts.size, opts.seed);
  const stamp = { placeholder: true, placeholderBatch: batch };
  const collections: Record<string, Doc[]> = {};
  const add = <T extends object>(col: string, doc: T): T => {
    Object.assign(doc, stamp);
    (collections[col] ??= []).push(doc as unknown as Doc);
    return doc;
  };
  const at = (ms: number) => iso(Math.min(ms, NOW));
  /** A CR-time instant `daysAgo` before now at a business hour. */
  const crAt = (dayStart: number, hour: number, minute = 0) => dayStart + hour * HOUR + minute * MIN;

  // ── Staff and lawyers ──
  const staff = STAFF.slice(0, cfg.staff).map((s, i) => ({
    ...s,
    email: i === 0 && opts.csmEmail ? opts.csmEmail.toLowerCase().trim() : s.email,
  }));
  const csms = staff.filter((s) => s.role !== "admin");
  const admin = staff.find((s) => s.role === "admin") ?? staff[0];

  /** COUNTRIES: lawyer i's country of practice (lawyer 0, the account lawyer, is in Costa Rica). */
  const lawyerOrder = opts.focus ? ACCOUNT_LAWYER_COUNTRIES : LAWYER_COUNTRIES;
  const lawyerCountry = (i: number): CountryCode => lawyerOrder[i % lawyerOrder.length];
  const lawyers = LAWYERS.slice(0, cfg.lawyers).map((l, i) => {
    const focus0 = i === 0 && opts.focus ? opts.focus : null;
    const id = focus0 ? focus0.lawyerId : `${PLACEHOLDER_PREFIX}prov_${pad(i + 1, 2)}`;
    const email = i === 0 && opts.lawyerEmail
      ? opts.lawyerEmail.toLowerCase().trim()
      : `${slug(l.first)}.${slug(l.last.split(" ")[0])}@example.com`;
    if (!focus0) return { ...l, id, email, name: `${l.first} ${l.last}`, load: 0 };
    // The real lawyer account: their own name and specialties.
    const words = (focus0.lawyerName ?? "").trim().split(/\s+/).filter(Boolean);
    const first = words[0] ?? l.first;
    const last = words.length ? words.slice(1).join(" ") : l.last;
    const areas = focus0.lawyerAreas?.length ? [...focus0.lawyerAreas] : l.areas;
    return { ...l, first, last, areas, id, email, name: last ? `${first} ${last}` : first, load: 0 };
  });
  for (const [i, l] of lawyers.entries()) {
    rng.reseed("lawyer", i);
    add("providers", {
      id: l.id,
      name: l.name,
      email: l.email,
      phone: `+1 202 555 01${pad(10 + i, 2)}`,
      contactPerson: l.name,
      legalAreas: [...new Set(l.areas.map((a) => PROVIDER_AREA[a]))],
      jurisdictions: [lawyerCountry(i)],
      country: lawyerCountry(i),
      timezone: COUNTRIES[lawyerCountry(i)].defaultTimeZone,
      languages: lawyerCountry(i) === "PT" ? ["pt", "en"] : ["es", "en"],
      credentials: lawyerCountry(i) === "CR"
        ? `Colegio de Abogados y Abogadas de Costa Rica, carné PH-${pad(20000 + i * 37, 5)} (placeholder)`
        : `${COUNTRIES[lawyerCountry(i)].lawyerBody.name}, ${COUNTRIES[lawyerCountry(i)].lawyerBody.numberLabel.toLowerCase()} PH-${pad(20000 + i * 37, 5)} (placeholder)`,
      insurance: "Professional liability policy on file (placeholder)",
      slaStatus: "signed",
      notes: "Placeholder lawyer for demos. Not a real person.",
      score: [4.9, 4.7, 4.8, 4.6, 4.8, 4.5][i % 6],
      customFields: { office: l.city, hourlyRateUsd: l.hourly, flatFeeCallUsd: 0, payoutTerms: "Net 15 after client payment" },
      bio: l.bio,
      city: l.city,
      active: true,
      status: "active",
      vettedAt: iso(NOW - (cfg.windowDays + 40) * DAY),
      createdAt: iso(NOW - (cfg.windowDays + 45) * DAY),
      createdBy: admin.email,
      updatedAt: iso(NOW - rng.int(1, 30) * DAY),
      // ROUTING: specialties, languages, regions, capacity, licences, notary, one paused lawyer.
      ...routingProfileFor(i, lawyerCountry(i), l.areas, l.city),
    });
    const morning = rng.pick([["08:00", "12:00"], ["08:30", "12:00"], ["09:00", "12:30"]] as const);
    const afternoon = rng.pick([["13:30", "16:30"], ["14:00", "17:00"], ["13:00", "16:00"]] as const);
    const days: Array<0 | 1 | 2 | 3 | 4 | 5 | 6> = i % 3 === 2 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
    // The last lawyer never saved their hours (the app falls back to defaults).
    if (i === cfg.lawyers - 1 && cfg.lawyers > 2) continue;
    const year = new Date(NOW).getUTCFullYear();
    // One lawyer is on vacation in about two weeks (blackout days).
    const vacation = i === (cfg.lawyers >= 4 ? 2 : 0)
      ? Array.from({ length: 7 }, (_, k) => ymd(today0 + (15 + k) * DAY + 12 * HOUR))
      : i === 0 && opts.focus ? [ymd(today0 + 24 * DAY + 12 * HOUR), ymd(today0 + 25 * DAY + 12 * HOUR)] : []; // account lawyer: a long weekend off
    add(COLLECTIONS.availability, {
      id: l.id,
      providerId: l.id,
      timezone: COUNTRIES[lawyerCountry(i)].defaultTimeZone,
      weekly: days.flatMap((day) => [
        { day, start: morning[0], end: morning[1] },
        ...(i % 2 === 0 || day !== 5 ? [{ day, start: afternoon[0], end: afternoon[1] }] : []),
      ]),
      blackoutDates: [...vacation, `${year}-12-24`, `${year}-12-25`, `${year + 1}-01-01`],
      minLeadHours: [18, 24, 18, 12][i % 4],
      maxCallsPerDay: i === 1 ? 3 : [6, 5, 4, 6][i % 4], // lawyer 2 is fully booked (3 a day)
      specialties: [...l.areas],
      calendarId: null,
      updatedAt: iso(NOW - rng.int(2, 60) * DAY),
    });
  }
  // Account seed: lawyer 0's book is chosen per member (focusMember), never by load.
  const pickable = opts.focus && lawyers.length > 1 ? lawyers.slice(1) : lawyers;
  // COUNTRIES: only a lawyer licensed in the member's country; none there leaves the matter unassigned.
  const lawyerFor = (area: Area, country: CountryCode = "CR"): (typeof lawyers)[number] | null => {
    const inCountry = (lawyers.length > 1 ? pickable : lawyers).filter((l) => lawyerCountry(lawyers.indexOf(l)) === country);
    const fallbackCr = country === "CR" && !inCountry.length ? lawyers.filter((l) => lawyerCountry(lawyers.indexOf(l)) === "CR") : [];
    const local = inCountry.length ? inCountry : fallbackCr;
    if (!local.length) return null;
    const cands = local.filter((l) => l.areas.includes(area));
    const pool = cands.length ? cands : local;
    const min = Math.min(...pool.map((l) => l.load));
    const best = pool.filter((l) => l.load === min);
    const l = rng.pick(best);
    l.load++;
    return l;
  };
  const lawyerById = new Map(lawyers.map((l) => [l.id, l]));

  // ── Members ──
  const used = new Set<string>();
  const usedEmails = new Set<string>();
  const members: Member[] = [];
  const pendingIdx = new Set(cfg.members >= 10 ? [cfg.members - 1, cfg.members - 2] : [cfg.members - 1]);
  // Fixed roles at every size, so each state the UI can show exists (SEED.md "Diversity").
  const ROLE = { complete: 0, joined1d: 1, joinedToday: 2, longFull: 3, cancelled: 4, pastDue: 5, cancelPending: 6, noCalls: 7, renewToday: 8, unassigned: 9, missingDoc: 10 } as const;
  // Churn on a steady rhythm (not pure chance) so month-3 retention lands near 80-82%.
  const churn = { old: [0, 0], young: [0, 0] };
  const churnNow = (tenureDays: number) => {
    const bucket = tenureDays >= 90 ? churn.old : churn.young;
    const rate = tenureDays >= 90 ? 0.18 : 0.06;
    bucket[0]++;
    if (bucket[1] < Math.round(bucket[0] * rate)) {
      bucket[1]++;
      return true;
    }
    return false;
  };
  // Coverage: members 1…n walk through every value of each dimension once (in a
  // seeded order), later members draw with plausible weights.
  rng.reseed("perms");
  const perms = {
    household: rng.shuffle(HOUSEHOLDS),
    residency: rng.shuffle(RESIDENCIES),
    property: rng.shuffle(PROPERTIES),
    company: rng.shuffle(COMPANIES),
    vehicle: rng.shuffle(VEHICLES),
    employees: rng.shuffle(EMPLOYEES),
    province: rng.shuffle(PROVINCES),
    pets: rng.shuffle(PETS.map((_, k) => k)),
  };
  // COUNTRIES: an own stream, so spreading members across countries keeps every other draw as it was.
  const crng = new Rng(opts.seed * 17 + 5);
  crng.reseed("country-perm");
  // Fixed order: the first lawyers' countries come first, so in the demo they have members with calls.
  const countryPerm: CountryCode[] = ["ES", "MX", "CO", "PA", "PT"];
  const cover = <T>(values: readonly T[], weights: ReadonlyArray<readonly [T, number]>, slot: number): T =>
    slot >= 0 && slot < values.length ? values[slot] : rng.weighted(weights);
  // CSM load: the first CSM carries the most members; a third CSM (new hire) has none yet.
  const emptyCsm = csms.length >= 3 ? csms[2].email : null;
  const csmPool = csms.filter((c) => c.email !== emptyCsm);
  const csmFor = () => (csmPool.length === 1 || rng.chance(opts.focus?.csmShare ?? 0.65) ? csmPool[0].email : rng.pick(csmPool.slice(1)).email);
  const bgWeights: Array<[Background, number]> = BACKGROUNDS.map((b) => [b, b.key === "anglo" ? 30 : b.key === "hispanic" ? 10 : 4]);

  for (let i = 0; i < cfg.members; i++) {
    rng.reseed("member", i);
    const slot = i - 1; // member 0 is the fully completed showcase profile
    const spec = COVER_PEOPLE[i];
    const bg = BACKGROUNDS.find((b) => b.key === spec?.bg) ?? rng.weighted(bgWeights);
    let first = "";
    let last = "";
    let gender: Gender = "x";
    if (spec?.name) ({ first, last, gender } = spec.name);
    else {
      for (let t = 0; t < 200; t++) {
        [first, gender] = rng.pick(bg.firsts);
        last = rng.pick(bg.lasts);
        const full = `${first} ${last}`;
        if (!used.has(full) && !BLOCKED_NAMES.has(full)) break;
      }
    }
    if (i === 0 && opts.focus?.memberName?.first) ({ first, last } = { first: opts.focus.memberName.first, last: opts.focus.memberName.last ?? "" });
    const fullName = last ? `${first} ${last}` : first;
    used.add(fullName);
    const alias = i === 0 && !!opts.memberEmail;
    let local = last ? `${slug(first)}.${slug(last)}` : slug(first);
    for (let n = 2; usedEmails.has(local); n++) local = `${last ? `${slug(first)}.${slug(last)}` : slug(first)}${n}`;
    usedEmails.add(local);
    const email = alias ? opts.memberEmail!.toLowerCase().trim() : `${local}@example.com`;
    const id = i === 0 && opts.focus ? opts.focus.memberId : alias ? email.replace(/[@.]/g, "_") : `${PLACEHOLDER_PREFIX}cli_${pad(i + 1)}`;
    const nationality = spec?.nat ?? rng.pick(bg.nationalities);
    const second = spec?.dual ?? (rng.chance(0.12) ? rng.pick(NATIONALITIES.filter((n) => n !== nationality)) : undefined);
    const language = spec?.lang ?? (rng.chance(0.85) ? bg.languages[bg.languages.length - 1] === "en" ? "en" : bg.languages[0] : rng.pick(LANGUAGES));
    // UK numbers in Ofcom's drama range (07700 900xxx); everyone else +1 555-01xx.
    const phone = nationality === "UK"
      ? `+44 7700 900${pad(100 + i % 900, 3)}`
      : `+1 ${rng.pick(nationality === "CA" ? CA_AREA : US_AREA)} 555 01${pad(i % 100, 2)}`;

    // Situation (coverage first, then weights).
    const residency: Residency = i === 0 ? "pensionado" : cover(perms.residency, RESIDENCY_WEIGHTS, slot);
    const property: PropertyKind = i === 0 ? "house" : cover(perms.property, PROPERTY_WEIGHTS, slot);
    const companyKind: CompanyKind = i === 0 ? "one_sa" : cover(perms.company, COMPANY_WEIGHTS, slot);
    const vehicle: VehicleKind = i === 0 ? "local" : cover(perms.vehicle, VEHICLE_WEIGHTS, slot);
    const employees: EmployeeKind = i === 0 ? "domestic" : cover(perms.employees, EMPLOYEE_WEIGHTS, slot);
    const household: Household = cover(perms.household, HOUSEHOLDS.map((h) => [h, h === "married" ? 40 : h === "single" ? 15 : 9] as [Household, number]), i);
    const province = cover(perms.province, PROVINCES.map((p) => [p, p === "Guanacaste" || p === "San José" ? 25 : 10] as [(typeof PROVINCES)[number], number]), i);
    const crPlace = rng.pick(PLACES[province]);
    // Fixed roles stay in Costa Rica (the unassigned one is in a country with fewer lawyers);
    // then one member per other country, then weighted.
    crng.reseed("country", i);
    const country: CountryCode = i === ROLE.unassigned ? "PT" : i <= 10 ? "CR"
      : i - 11 < countryPerm.length ? countryPerm[i - 11] : crng.weighted(COUNTRY_WEIGHTS);
    const away = country === "CR" ? null : crng.pick(COUNTRY_PLACES[country]);
    const loc: Loc = away ? { place: away.place, province: away.region } : { place: crPlace, province };
    const persona: Persona = residency === "pensionado" ? "retiree"
      : residency === "digital_nomad" ? "remote"
      : ["in_process", "refused", "temporary"].includes(residency) ? "applicant"
      : ["one_sa", "multiple_sa", "srl"].includes(companyKind) && (employees === "small_business" || property === "airbnb_rental") ? "business"
      : property !== "none" ? "owner" : "retiree";
    const resident = ["pensionado", "rentista", "inversionista", "permanent", "temporary", "expired"].includes(residency);

    // Join date: more recent joins (growth); fixed roles keep every state present.
    let activatedAt = NOW - Math.round(Math.max(0.25, cfg.windowDays * (1 - Math.sqrt(rng.next()))) * DAY);
    const monthsBack = (anchor: number, n: number) => addMonths(anchor, -n);
    const maxMonths = Math.max(2, Math.floor((cfg.windowDays - 10) / 30.4));
    if (i === ROLE.complete) activatedAt = NOW - Math.min(48, cfg.windowDays - 5) * DAY;
    if (i === ROLE.joined1d) activatedAt = NOW - Math.round(1.2 * DAY);
    if (i === ROLE.joinedToday) activatedAt = Math.max(today0 + 5 * MIN, NOW - 3 * HOUR);
    if (i === ROLE.longFull) activatedAt = monthsBack(NOW - 20 * DAY, Math.min(4, maxMonths));
    if (i === ROLE.cancelled) activatedAt = monthsBack(NOW - 10 * DAY, Math.min(3, maxMonths));
    if (i === ROLE.pastDue) activatedAt = monthsBack(NOW - 4 * DAY, 2);
    if (i === ROLE.cancelPending) activatedAt = monthsBack(NOW + 9 * DAY, 2);
    if (i === ROLE.noCalls) activatedAt = monthsBack(NOW - 12 * DAY, Math.min(3, maxMonths));
    const renewAt = Math.max(NOW + 5 * MIN, Math.min(NOW + 3 * HOUR, today0 + DAY - MIN));
    if (i === ROLE.renewToday) activatedAt = monthsBack(renewAt, 2);
    if (i === ROLE.unassigned) activatedAt = NOW - 3 * DAY;
    if (pendingIdx.has(i)) activatedAt = NOW - (rng.int(1, 3) - 0.5) * DAY;
    const joinedDaysAgo = (NOW - activatedAt) / DAY;

    // Age 28-82, consistent with the residency category.
    let age = residency === "digital_nomad" ? rng.int(28, 48) : residency === "pensionado" ? rng.int(58, 82)
      : residency === "rentista" ? rng.int(45, 78) : rng.int(33, 74);
    // The age range ends are always present: the first nomad is 28, the first pensionado 82.
    if (residency === "digital_nomad" && !members.some((m) => m.situation.residency === "digital_nomad")) age = 28;
    if (residency === "pensionado" && i > 0 && !members.slice(1).some((m) => m.situation.residency === "pensionado")) age = 82;
    const dob = `${new Date(NOW).getUTCFullYear() - age}-${pad(rng.int(1, 12), 2)}-${pad(rng.int(1, 28), 2)}`;
    const residencyExpiresAt = residency === "expired" ? ymd(NOW - rng.int(10, 90) * DAY)
      : resident ? ymd(NOW + rng.int(45, 700) * DAY) : undefined;
    const kids = household === "blended" ? [rng.int(6, 12), rng.int(13, 17)] : ["married", "same_sex_married", "unmarried_partners", "divorced"].includes(household) && rng.chance(0.3) ? [rng.int(1, 17)] : [];
    const companies = companyKind === "none" ? [] : companyKind === "multiple_sa"
      ? [1, 2, 3].map((k) => ({ type: "S.A.", id: `PH-3-101-${pad(rng.int(100000, 999999), 6)}`, status: k === 3 ? "dormant" : "active" }))
      : [{
        type: companyKind === "srl" ? "S.R.L." : companyKind === "foreign_llc" ? "LLC (foreign, owns Costa Rica property)" : "S.A.",
        id: companyKind === "foreign_llc" ? `PH-LLC-${pad(rng.int(1000, 9999), 4)}` : `PH-3-10${companyKind === "srl" ? 2 : 1}-${pad(rng.int(100000, 999999), 6)}`,
        status: companyKind === "dormant_sa" ? "dormant" : companyKind === "delinquent_sa" ? "corporation tax overdue" : "active",
      }];
    const profile: Doc = {
      fullName,
      email,
      phone,
      nationality,
      ...(second ? { secondNationality: second } : {}),
      dateOfBirth: dob,
      ...(rng.chance(0.9) || i < 20 ? { pronouns: PRONOUNS[gender] } : {}),
      preferredLanguage: language,
      ...(i > 0 && (i <= ACCESSIBILITY.length || rng.chance(0.12)) ? { accessibilityNotes: ACCESSIBILITY[(i - 1) % ACCESSIBILITY.length] } : {}),
      maritalStatus: MARITAL[household],
      householdType: household,
      dependents: kids.length,
      ...(kids.length ? { dependentsDetail: kids.map((a) => ({ relation: "child", age: a })) } : {}),
      ...(rng.chance(0.3) || household === "widowed" ? { adultChildrenAbroad: rng.int(1, 3) } : {}),
      ...(household === "blended" || rng.chance(0.06) ? { elderlyParentInCare: true } : {}),
      pets: [...PETS[cover(perms.pets, PETS.map((_, k) => [k, k === 0 ? 40 : 12] as [number, number]), slot)]],
      residencyStatus: residency === "tourist_overstay_risk" ? "tourist" : residency === "in_process" ? "applying" : residency,
      ...(residency === "tourist_overstay_risk" ? { overstayRisk: true } : {}),
      ...(residencyExpiresAt ? { residencyExpiresAt } : {}),
      ...(resident ? { dimexNumber: `PH-DIMEX-${pad(rng.int(100000, 999999), 6)}` } : {}),
      ownsProperty: property !== "none",
      ...(property !== "none" ? { propertyLocation: `${loc.place}, ${loc.province}`, propertyType: property, propertyLabel: PROPERTY_LABEL[property] } : {}),
      hasCompany: companies.length > 0,
      ...(companies.length ? { companyType: companies[0].type, companyId: companies[0].id, companies } : {}),
      ownsVehicle: vehicle !== "none",
      ...(vehicle !== "none" ? { vehicleType: vehicle } : {}),
      hasEmployees: employees !== "none",
      ...(employees !== "none" ? { employeeType: employees } : {}),
    };
    // Recent joiners (and a few others) have not finished their profile yet; the
    // member who joined today has only filled in their email.
    if (i === ROLE.joinedToday) {
      for (const k of Object.keys(profile)) if (k !== "email") delete profile[k];
    } else if (i !== ROLE.complete && (joinedDaysAgo < 7 || rng.chance(0.08))) {
      for (const k of rng.shuffle(["dateOfBirth", "maritalStatus", "dependents", "residencyStatus", "phone", "ownsVehicle"]).slice(0, rng.int(3, 5))) {
        delete profile[k];
      }
    }
    const legacyAnswers: Record<string, unknown> = {
      country: "CR",
      residencyStatus: resident ? "resident" : residency === "in_process" ? "applying" : residency === "refused" ? "unsure" : "visitor",
      ...(resident && residencyExpiresAt ? { residencyExpiresAt } : {}),
      ...(!resident && ["tourist", "tourist_overstay_risk", "digital_nomad"].includes(residency)
        ? { lastEntryDate: ymd(activatedAt - (residency === "tourist_overstay_risk" ? 168 : rng.int(15, 150)) * DAY) } : {}),
      ownsProperty: property !== "none",
      ...(property !== "none" ? { propertyLocation: loc.province } : {}),
      companyType: companyKind === "srl" ? "SRL" : companyKind === "none" ? "none" : companyKind === "foreign_llc" ? "unsure" : "SA",
      ...(companyKind === "none" ? { hasCompany: false } : companyKind === "foreign_llc" ? {} : { hasCompany: true }),
      ownsVehicle: vehicle !== "none",
      hasEmployees: employees !== "none",
    };
    const rawAnswers = country === "CR" ? legacyAnswers : {
      country,
      ...seedCountryAnswers(country, {
        residency, resident, expires: residencyExpiresAt,
        entry: typeof legacyAnswers.lastEntryDate === "string" ? legacyAnswers.lastEntryDate : undefined,
        property, company: companyKind, vehicle, employees, place: loc.place,
      }),
    };
    const answers: CheckAnswers = normalizeAnswers(rawAnswers).answers!;
    if (country !== "CR") {
      // The profile speaks the member's country: residency value, country answers, time zone.
      if (profile.residencyStatus !== undefined) profile.residencyStatus = answers.residencyStatus ?? profile.residencyStatus;
      delete profile.dimexNumber;
    }
    if (Object.keys(profile).length > 1) {
      profile.legalCountry = country;
      profile[COUNTRY_ANSWERS_FIELD] = Object.fromEntries(Object.entries(answers).filter(([k]) => k !== "country"));
      profile.timezone = COUNTRIES[country].defaultTimeZone;
    }

    // Membership status
    let status: Membership["status"] = "active";
    let cancelAt: number | undefined;
    const monthsIn = Math.floor(joinedDaysAgo / 30.4);
    if (pendingIdx.has(i)) status = "pending";
    else if (i === ROLE.cancelled) {
      status = "cancelled";
      cancelAt = addMonths(activatedAt, Math.max(1, monthsIn - 1));
    } else if (i === ROLE.pastDue) status = "past_due";
    else if (i > 10 && monthsIn >= 2 && churnNow(joinedDaysAgo)) {
      status = "cancelled";
      cancelAt = addMonths(activatedAt, rng.int(1, monthsIn - 1));
    } else if (i > 10 && monthsIn >= 1 && rng.chance(0.07)) status = "past_due";

    const periods: number[] = [];
    for (let p = activatedAt; p <= NOW; p = addMonths(p, 1)) periods.push(p);
    let periodStart: number;
    let periodEnd: number;
    const m: Membership & Doc = {
      id: `${PLACEHOLDER_PREFIX}mem_${pad(i + 1)}`,
      clientId: id,
      plan: PLAN_STANDARD.id,
      status,
      country,
      periodStart: "",
      periodEnd: "",
      minutesIncluded: PLAN_STANDARD.minutesIncluded,
      minutesUsed: 0,
      callsIncluded: PLAN_STANDARD.callsIncluded,
      callsUsed: 0,
      csmEmail: i === 0 && opts.focus ? csmPool[0].email : csmFor(),
      paymentRef: "manual",
      createdAt: iso(activatedAt - rng.int(5, 30) * MIN),
      updatedAt: iso(NOW - rng.int(1, 72) * HOUR),
    };
    if (status === "pending") {
      periodStart = activatedAt;
      periodEnd = addMonths(activatedAt, 1);
      periods.length = 0;
    } else if (status === "cancelled") {
      const c = periods.findIndex((p) => p >= cancelAt!);
      const idx = c < 0 ? periods.length - 1 : c;
      cancelAt = periods[idx];
      periods.length = idx; // paid periods before the cancel
      periodStart = periods[periods.length - 1];
      periodEnd = cancelAt;
      const reasonKey = rng.weighted([["got_what_needed", 30], ["not_used", 25], ["not_worth_cost", 20], ["leaving_country", 15], ["service_issue", 5], ["other", 5]] as const);
      Object.assign(m, {
        cancelledAt: iso(cancelAt),
        cancelAtPeriodEnd: true,
        cancelRequestedAt: iso(cancelAt - rng.int(4, 20) * DAY),
        cancelReason: CANCEL_REASONS[reasonKey],
        cancelReasonKey: reasonKey,
      });
    } else if (status === "past_due") {
      const due = periods[periods.length - 1];
      periods.length = periods.length - 1;
      periodStart = periods[periods.length - 1];
      periodEnd = due;
      m.pastDueSince = iso(due);
      m.dunningStage = Math.floor((NOW - due) / DAY) >= 7 ? "paused" : Math.floor((NOW - due) / DAY) >= 3 ? "d3" : "d0";
    } else {
      periodStart = periods[periods.length - 1];
      periodEnd = addMonths(periodStart, 1);
      if (i === ROLE.cancelPending || (i > 10 && monthsIn >= 1 && rng.chance(0.05))) {
        const reasonKey = rng.pick(["not_used", "not_worth_cost", "leaving_country"] as const);
        Object.assign(m, {
          cancelAtPeriodEnd: true,
          cancelRequestedAt: iso(NOW - rng.int(1, 5) * DAY),
          cancelReason: CANCEL_REASONS[reasonKey],
          cancelReasonKey: reasonKey,
        });
      }
    }
    m.periodStart = iso(periodStart);
    m.periodEnd = iso(periodEnd);
    // Renews today, whatever month-end arithmetic did to the anniversary.
    if (i === ROLE.renewToday && status === "active") m.periodEnd = iso(renewAt);
    if (status !== "pending") {
      m.activatedAt = iso(activatedAt);
      m.activationPaidAt = iso(activatedAt);
    }
    const member: Member = {
      i, id, first, last, email, phone, persona, loc, country, profile, answers,
      csm: m.csmEmail as string,
      status, activatedAt, periods, membership: m, cancelAt,
      aiConsent: i === ROLE.complete || rng.chance(0.65),
      situation: { background: bg.key, residency, property, company: companyKind, vehicle, employees, household, language, age, nationalities: second ? [nationality, second] : [nationality], province },
    };
    if (status !== "pending" && rng.chance(0.04)) member.recordingWithdrawnAt = activatedAt + rng.int(3, 20) * DAY;
    members.push(member);
  }
  const aliasClientId = opts.memberEmail || opts.focus ? members[0].id : null;
  // Account seed: which members' matters all go to lawyer 0 (own stream, so the rest of the story keeps its draws).
  const frng = new Rng(opts.seed * 31 + 1);
  const crShare = Math.max(0.05, members.filter((m) => m.country === "CR").length / Math.max(1, members.length));
  const focusMember = (mem: Member): boolean => {
    if (!opts.focus || mem.i === ROLE.unassigned || mem.country !== "CR") return false;
    if (mem.i === 0) return true;
    frng.reseed("focus", mem.i);
    // Only Costa Rica members can go to the (Costa Rica) account lawyer, so their share is scaled up.
    return frng.chance(Math.min(1, (opts.focus.lawyerShare ?? 0.4) / crShare));
  };
  for (const mem of members) add(COLLECTIONS.memberships, mem.membership);

  // ── Leads (free check) and funnel ──
  const SOURCES: Array<[string | null, number]> = [["google", 35], ["facebook", 20], ["expat-forum", 15], ["newsletter", 10], ["referral", 10], [null, 10]];
  const funnel = (step: string, anonId: string, atMs: number, extra: Doc = {}) => {
    add(COLLECTIONS.funnelEvents, { id: `${PLACEHOLDER_PREFIX}${step}_${anonId}`, step, anonId, at: iso(Math.min(atMs, NOW)), ...extra });
  };
  let leadN = 0;
  let anonN = 0;
  const newAnon = () => `ph_anon_${pad(++anonN, 5)}`;
  const leadDoc = (email: string, name: string | undefined, answers: CheckAnswers, createdAt: number, extra: Partial<Lead> = {}): Lead & Doc => {
    const id = `${PLACEHOLDER_PREFIX}lead_${pad(++leadN, 4)}`;
    const findings = evaluateCheck(answers, new Date(createdAt)).map(({ ruleId, title, dueAt, area, confidence, dueText }) => ({ ruleId, title, area, ...(dueAt ? { dueAt } : {}), ...(confidence ? { confidence } : {}), ...(dueText ? { dueText } : {}) }));
    return add(COLLECTIONS.leads, {
      id,
      email,
      ...(name ? { name } : {}),
      country: answers.country,
      answers: answers as unknown as Lead["answers"],
      findings,
      source: "deadline_check",
      createdAt: iso(createdAt),
      ...extra,
    });
  };
  for (const mem of members) {
    rng.reseed("members-1", mem.i);
    const src = rng.weighted(SOURCES);
    const anon = newAnon();
    const fromCheck = mem.i === 0 || rng.chance(0.7);
    const joinAt = mem.activatedAt;
    if (fromCheck) {
      const leadAt = joinAt - rng.int(1, 12 * 24) * HOUR;
      const lead = leadDoc(mem.email, `${mem.first} ${mem.last}`, mem.answers, leadAt,
        mem.status === "pending" ? {} : { convertedClientId: mem.id, convertedAt: iso(joinAt) });
      mem.leadId = lead.id;
      mem.membership.sourceLeadId = lead.id;
      const s = src ? { source: src } : {};
      funnel("check_started", anon, leadAt - 6 * MIN, s);
      funnel("check_completed", anon, leadAt - MIN, s);
      funnel("check_email_given", anon, leadAt, { ...s, leadId: lead.id });
    }
    funnel("join_started", anon, joinAt - rng.int(4, 20) * MIN, src ? { source: src } : {});
    if (mem.status !== "pending") funnel("join_paid", anon, joinAt, { clientId: mem.id, ...(src ? { source: src } : {}) });
    (mem as Member & { anon: string; src: string | null }).anon = anon;
    (mem as Member & { anon: string; src: string | null }).src = src;
  }
  // Visitors who took the check and did not join (≈ 5-10% conversion overall).
  const checkMembers = members.filter((m) => m.leadId).length;
  const extraLeads = checkMembers * cfg.leadsPerCheckMember;
  for (let k = 0; k < extraLeads; k++) {
    rng.reseed("lead", k);
    const lbg = rng.weighted(bgWeights);
    const first = rng.pick(lbg.firsts)[0];
    const last = rng.pick(lbg.lasts);
    const createdAt = NOW - Math.round(cfg.windowDays * (1 - Math.sqrt(rng.next())) * DAY);
    const owns = rng.chance(0.5);
    const company = rng.weighted([["SA", 25], ["SRL", 10], ["none", 55], ["unsure", 10]] as const);
    const res = rng.weighted([["resident", 30], ["applying", 20], ["visitor", 40], ["unsure", 10]] as const);
    const legacyLead: Record<string, unknown> = {
      country: "CR",
      residencyStatus: res,
      ...(res === "resident" ? { residencyExpiresAt: ymd(createdAt + rng.int(30, 600) * DAY) } : {}),
      ...(res === "visitor" ? { lastEntryDate: ymd(createdAt - rng.int(5, 170) * DAY) } : {}),
      ownsProperty: owns,
      ...(owns ? { propertyLocation: rng.pick(PROVINCES) } : {}),
      companyType: company,
      ...(company === "SA" || company === "SRL" ? { hasCompany: true } : company === "none" ? { hasCompany: false } : {}),
      ownsVehicle: rng.chance(0.5),
      hasEmployees: rng.chance(0.2),
    };
    // COUNTRIES: leads come from all six countries (own stream, the draws above are unchanged).
    crng.reseed("lead-country", k);
    const leadCountry: CountryCode = crng.weighted(COUNTRY_WEIGHTS);
    const answers: CheckAnswers = normalizeAnswers(leadCountry === "CR" ? legacyLead : {
      country: leadCountry,
      ...seedCountryAnswers(leadCountry, {
        residency: res === "resident" ? "temporary" : res === "applying" ? "in_process" : res === "visitor" ? "tourist" : "refused",
        resident: res === "resident",
        expires: typeof legacyLead.residencyExpiresAt === "string" ? legacyLead.residencyExpiresAt : undefined,
        entry: typeof legacyLead.lastEntryDate === "string" ? legacyLead.lastEntryDate : undefined,
        property: owns ? "house" : "none",
        company: company === "SA" || company === "SRL" ? "one_sa" : "none",
        vehicle: legacyLead.ownsVehicle ? "local" : "none",
        employees: legacyLead.hasEmployees ? "domestic" : "none",
        place: crng.pick(COUNTRY_PLACES[leadCountry]).place,
      }),
    }).answers!;
    const email = `${slug(first)}.${slug(last)}.${pad(k + 1, 4)}@example.com`;
    const lead = leadDoc(email, rng.chance(0.5) ? `${first} ${last}` : undefined, answers, createdAt);
    const anon = newAnon();
    const src = rng.weighted(SOURCES);
    const s = src ? { source: src } : {};
    funnel("check_started", anon, createdAt - 7 * MIN, s);
    funnel("check_completed", anon, createdAt - MIN, s);
    funnel("check_email_given", anon, createdAt, { ...s, leadId: lead.id });
    if (rng.chance(0.06)) funnel("join_started", anon, createdAt + rng.int(1, 72) * HOUR, s); // abandoned join
  }
  // Visitors who started the check but left before the email step.
  for (let k = 0; k < Math.round(extraLeads * 0.6); k++) {
    rng.reseed("visit", k);
    const anon = newAnon();
    const t = NOW - Math.round(cfg.windowDays * (1 - Math.sqrt(rng.next())) * DAY);
    const s: Doc = {};
    const src = rng.weighted(SOURCES);
    if (src) s.source = src;
    funnel("check_started", anon, t, s);
    if (rng.chance(0.4)) funnel("check_completed", anon, t + 5 * MIN, s);
  }

  // ── Matters ──
  const mattersBy = new Map<string, MatterRec[]>();
  for (const mem of members) {
    rng.reseed("members-2", mem.i);
    if (mem.status === "pending") continue;
    const n = mem.i === ROLE.longFull ? 5 : mem.i === 0 ? (opts.focus ? 4 : 2) : rng.weighted([[1, 55], [2, 35], [3, 10]] as const);
    const toFocus = focusMember(mem);
    // Persona areas plus what the member's situation implies.
    const areas: Area[] = [...new Set<Area>([
      ...PERSONA_AREAS[mem.persona],
      ...(mem.situation.vehicle !== "none" ? ["vehicle" as const] : []),
      ...(mem.situation.employees !== "none" ? ["labor" as const] : []),
      ...(mem.situation.property === "inherited" || mem.situation.household === "widowed" ? ["family_estate" as const] : []),
      ...(mem.situation.company !== "none" ? ["corporate" as const] : []),
    ])];
    if (mem.i === ROLE.longFull) areas.splice(0, areas.length, "corporate", "real_estate", "tax", "family_estate", "labor", "vehicle", "immigration");
    const recs: MatterRec[] = [];
    const usedTitles = new Set<string>();
    const end = mem.cancelAt ?? NOW;
    for (let j = 0; j < n; j++) {
      const area: Area = mem.i === ROLE.longFull ? areas[j] : j === 0 ? (rng.chance(0.7) ? areas[0] : areas[1]) : rng.pick(areas);
      const options = SCRIPTS[area].filter((s) => !usedTitles.has(s.title));
      const script = rng.pick(options.length ? options : SCRIPTS[area]);
      usedTitles.add(script.title);
      // The first matter opens right after joining (never in the future, so re-runs keep its id).
      const openedAt = j === 0 ? Math.min(mem.activatedAt + rng.int(1, 30) * HOUR, Math.max(mem.activatedAt + MIN, NOW - 10 * MIN)) : mem.activatedAt + Math.round(rng.next() * (end - mem.activatedAt));
      if (openedAt > NOW) continue;
      // One member waits for a lawyer to be assigned (Needs attention → Unassigned).
      const lawyer = mem.i === ROLE.unassigned ? null : toFocus ? lawyers[0] : lawyerFor(area, mem.country);
      const commercial = !!script.opportunity && rng.chance(0.5);
      const vars = { country: mem.country, loc: mem.loc.place, L: lawyer?.first ?? "your lawyer", M: mem.first };
      const id = `${PLACEHOLDER_PREFIX}mat_${pad(mem.i + 1)}_${j + 1}`;
      const doc: Doc = {
        id,
        clientId: mem.id,
        title: fill(script.title, vars),
        area,
        country: mem.country,
        stage: "intake",
        stageEnteredAt: iso(openedAt),
        ...(lawyer ? { assignedProviderId: lawyer.id } : {}),
        openedAt: iso(openedAt),
      };
      recs.push({ doc: add(COLLECTIONS.matters, doc), script, area, commercial, openedAt });
    }
    mattersBy.set(mem.id, recs);
  }

  // ── CSM tasks (always through the real TASK_RULES builder) ──
  const memberById = new Map(members.map((m) => [m.id, m]));
  const tasks = new Map<string, CsmTask & Doc>();
  const closeTask = (t: CsmTask & Doc, outcome?: string) => {
    const created = Date.parse(t.createdAt);
    const hours = TASK_RULES[Object.keys(TASK_RULES).find((k) => TASK_RULES[k].type === t.type) ?? "membership.activated"].dueInHours;
    t.status = "done";
    t.outcome = outcome ?? rng.pick(OUTCOMES[t.type]);
    t.closedAt = at(created + rng.int(1, Math.max(2, hours + 6)) * HOUR);
  };
  const mkTask = (name: string, payload: EventPayload, eventAt: number, mode: "auto" | "open" | "done" = "auto", outcome?: string) => {
    const owner = payload.ownerEmail ?? memberById.get(payload.clientId)?.csm;
    const t = buildTask(name, payload, new Date(Math.min(eventAt, NOW)), owner) as (CsmTask & Doc) | null;
    if (!t) return null;
    if (!t.id.startsWith(PLACEHOLDER_PREFIX)) t.id = `${PLACEHOLDER_PREFIX}${t.id}`; // login-alias member
    const existing = tasks.get(t.id);
    if (existing) return existing;
    const due = Date.parse(t.dueAt);
    if (mode === "done") closeTask(t, outcome);
    else if (mode === "auto") {
      if (due < NOW - DAY) {
        const r = rng.next();
        if (r < 0.95) closeTask(t, outcome);
        else if (r < 0.98) {
          t.status = "cancelled";
          t.closedAt = at(due);
        }
      }
    }
    tasks.set(t.id, t);
    return t;
  };

  // ── Consultations ──
  const busy = new Set<string>();
  const takeSlot = (pid: string, t: number) => {
    let x = t;
    while (busy.has(`${pid}|${x}`)) x += 20 * MIN;
    busy.add(`${pid}|${x}`);
    return x;
  };
  const bizTime = (from: number, to: number): number | null => {
    if (to <= from) return null;
    for (let k = 0; k < 30; k++) {
      const d0 = crMidnight(new Date(from + rng.next() * (to - from)));
      const dow = crDow(d0 + 12 * HOUR);
      if (dow === 0 || dow === 6) continue;
      const t = crAt(d0, rng.int(8, 15), rng.pick([0, 20, 40]));
      if (t >= from && t <= to) return t;
    }
    return null;
  };
  const conCount = new Map<string, number>();
  const consultations: Doc[] = [];
  const ratings: Array<{ c: Doc; mem: Member; score: number; comment?: string; at: number }> = [];
  const RATING_COMMENTS: Record<number, string[]> = {
    5: ["Very clear, exactly what I needed.", "Great call, I finally understand the process.", "Excellent, very patient with my questions."],
    4: ["Helpful. Would have liked a written checklist.", "Good call, a bit rushed at the end."],
    3: ["OK, but I still have open questions."],
    2: ["The call started late and felt short."],
    1: ["The lawyer did not seem to have read my profile."],
  };
  const makeCon = (mem: Member, rec: MatterRec, t: number, status: "completed" | "no_show" | "cancelled" | "booked" | "in_progress", today = false, minutes?: number): Doc => {
    const n = (conCount.get(mem.id) ?? 0) + 1;
    conCount.set(mem.id, n);
    const id = `${PLACEHOLDER_PREFIX}con_${pad(mem.i + 1)}_${pad(n, 2)}`;
    const lawyer = lawyerById.get(String(rec.doc.assignedProviderId))!;
    const scheduled = takeSlot(lawyer.id, t);
    const vars = { country: mem.country, loc: mem.loc.place, L: lawyer.first, M: mem.first };
    const withdrawn = mem.recordingWithdrawnAt !== undefined && mem.recordingWithdrawnAt < scheduled;
    const recording = withdrawn ? "declined" : status === "booked" && rng.chance(0.15) ? "pending" : rng.weighted([["granted", 85], ["declined", 15]] as const);
    const createdAt = Math.min(scheduled - 2 * HOUR, Math.max(mem.activatedAt + HOUR, scheduled - rng.int(1, 7) * DAY));
    const c: Doc = {
      id,
      clientId: mem.id,
      matterId: rec.doc.id,
      providerId: lawyer.id,
      scheduledAt: iso(scheduled),
      durationMin: PLAN_STANDARD.callLengthMin,
      status,
      question: fill(rec.script.question, vars),
      consent: recording === "pending"
        ? { recording }
        : { recording, at: iso(createdAt), by: "client", where: withdrawn ? "privacy_page" : "booking" },
      bookedBy: mem.email,
      meetUrl: meetUrlFor(id),
      createdAt: iso(createdAt),
    };
    if (status === "completed") {
      const ended = scheduled + (minutes ?? rng.pick([20, 20, 20, 18, 15])) * MIN;
      c.endedAt = iso(ended);
      c.minutesUsed = Math.round((ended - scheduled) / MIN);
      c.chargedAt = iso(ended);
      c.remindersSent = ["24h", "1h"];
      if (recording === "granted") {
        c.transcript = rec.script.dialogue.map((l) => fill(l, vars)).join("\n");
        c.transcriptSource = "meet_transcript";
        c.transcriptFetchedAt = iso(ended + 12 * MIN);
        c.transcriptFetchAttempts = 1;
      }
      const delay = rng.chance(0.86) ? rng.int(1, 20) : rng.int(26, 60);
      const confirmedAt = ended + delay * HOUR;
      const steps = rec.script.steps.map((s, k) => ({ ...s, dueAt: iso(ended + (rec.script.dueInDays[k] ?? 14) * DAY) }));
      if (today || confirmedAt > NOW || (NOW - ended < 30 * HOUR && rng.chance(0.4))) {
        c.summary = { text: rec.script.summary, status: "suggested" };
        c.suggestedNextSteps = steps;
      } else {
        c.summary = { text: rec.script.summary, status: "confirmed", confirmedAt: iso(confirmedAt) };
      }
      if (ended < NOW - 12 * HOUR && rng.chance(0.6)) {
        const score = rng.weighted([[5, 55], [4, 30], [3, 10], [2, 4], [1, 1]] as const);
        const comment = rng.chance(0.5) ? rng.pick(RATING_COMMENTS[score]) : undefined;
        const ratedAt = ended + rng.int(1, 30) * HOUR;
        c.rating = { score, ...(comment ? { comment } : {}), at: at(ratedAt) };
        ratings.push({ c, mem, score, comment, at: Math.min(ratedAt, NOW) });
      }
      if (rng.chance(0.08)) {
        c.previousScheduledAt = iso(scheduled - rng.int(1, 3) * DAY);
        c.rescheduledAt = iso(createdAt + HOUR);
        c.rescheduledBy = mem.email;
      }
    } else if (status === "no_show") {
      c.noShowAt = iso(scheduled + 15 * MIN);
      c.noShowMarkedBy = lawyer.email;
      c.remindersSent = ["24h", "1h"];
      if (rng.chance(0.5)) c.restoredAt = iso(scheduled + rng.int(2, 30) * HOUR);
    } else if (status === "cancelled") {
      c.cancelledAt = iso(Math.max(createdAt + HOUR, scheduled - rng.int(2, 48) * HOUR));
      c.cancelledBy = mem.email;
    } else {
      const hoursAway = (scheduled - NOW) / HOUR;
      c.remindersSent = hoursAway <= 1 ? ["24h", "1h"] : hoursAway <= 24 ? ["24h"] : [];
    }
    consultations.push(add(COLLECTIONS.consultations, c));
    // TASK_RULES consultation.booked: profile check before the call.
    mkTask("consultation.booked", { clientId: mem.id, matterId: String(rec.doc.id), sourceId: id, detail: `${mem.first} ${mem.last}` }, createdAt,
      status !== "booked" ? "auto" : createdAt + 30 * HOUR < NOW && rng.chance(0.85) ? "done" : "open");
    return c;
  };
  const matterAt = (recs: MatterRec[], t: number) =>
    [...recs].filter((r) => r.openedAt <= t).sort((a, b) => b.openedAt - a.openedAt)[0] ?? recs[0];

  for (const mem of members) {
    rng.reseed("members-3", mem.i);
    const recs = mattersBy.get(mem.id) ?? [];
    // No calls at all for months (and none possible without a lawyer).
    if (!recs.length || mem.i === ROLE.noCalls || mem.i === ROLE.unassigned) continue;
    // COUNTRIES: a member whose country has no placeholder lawyer has no calls yet.
    if (!recs.some((r) => r.doc.assignedProviderId)) continue;
    mem.periods.forEach((start, p) => {
      // (Account seed: history stops before today, so the lawyer's day is only the scripted one.)
      const end = Math.min(addMonths(start, 1), opts.focus ? Math.min(NOW - 3 * HOUR, today0) : NOW - 3 * HOUR, mem.cancelAt ?? Infinity);
      if (mem.i === ROLE.longFull && p === mem.periods.length - 1) {
        // Used every call and all 60 minutes this period.
        const span = (end - start - 4 * HOUR) / 3;
        for (let k = 0; k < PLAN_STANDARD.callsIncluded; k++) {
          const t = bizTime(start + 2 * HOUR + k * span, start + 2 * HOUR + (k + 1) * span) ?? start + 2 * HOUR + k * span;
          makeCon(mem, recs[k % recs.length], t, "completed", false, PLAN_STANDARD.callLengthMin);
        }
        return;
      }
      if (p === mem.periods.length - 1 && mem.i === ROLE.pastDue) {
        const t = bizTime(start + 2 * HOUR, end);
        if (t !== null) makeCon(mem, recs[0], t, "no_show");
      }
      if (p === mem.periods.length - 1 && mem.i === ROLE.cancelPending) {
        const t = bizTime(start + 2 * HOUR, end);
        if (t !== null) makeCon(mem, recs[0], t, "cancelled");
      }
      const n = p === 0 ? rng.weighted([[1, 50], [2, 25], [0, 15], [3, 10]] as const) : rng.weighted([[0, 35], [1, 35], [2, 20], [3, 10]] as const);
      let done = 0;
      for (let k = 0; k < n; k++) {
        const t = bizTime(Math.max(start + 2 * HOUR, recs[0].openedAt + HOUR), end);
        if (t === null) continue;
        let status = rng.weighted([["completed", 88], ["no_show", 4], ["cancelled", 8]] as const);
        if (status === "completed" && done >= PLAN_STANDARD.callsIncluded) status = "cancelled";
        if (status === "completed") done++;
        makeCon(mem, matterAt(recs, t), t, status);
      }
    });
  }
  // Today: every lawyer has calls (morning ones finished and waiting for the summary).
  const activeMembers = members.filter((m) => m.status === "active" && (mattersBy.get(m.id) ?? []).some((r) => r.doc.assignedProviderId) && m.i !== ROLE.noCalls && m.i !== ROLE.unassigned && m.i !== ROLE.longFull);
  /** Completed calls in the member's current period (a fourth one is never added). */
  const usedThisPeriod = (mem: Member) => consultations.filter((c) => c.clientId === mem.id && c.status === "completed" &&
    String(c.scheduledAt) >= String(mem.membership.periodStart) && String(c.scheduledAt) < String(mem.membership.periodEnd)).length;
  const todayUsed = new Set<string>();
  const todayHours = [8, 9, 10, 11, 13, 14, 15, 16];
  /**
   * Account seed: lawyer 0's day, relative to now in Costa Rica: a call done
   * this morning waiting for the summary to be confirmed (member 0 when
   * possible), a no-show candidate, one in progress, and three booked later
   * (recording consent pending, granted, declined).
   */
  const focusToday = (l: (typeof lawyers)[number]) => {
    rng.reseed("today-focus");
    const open = (m: Member) => (mattersBy.get(m.id) ?? []).find((r) => r.doc.assignedProviderId === l.id);
    const pool = activeMembers.filter((m) => !todayUsed.has(m.id) && usedThisPeriod(m) < PLAN_STANDARD.callsIncluded - 1 && open(m));
    const first = pool.find((m) => m.i === 0);
    const live = pool.find((m) => m.i === ROLE.joined1d);
    const rest = rng.shuffle(pool.filter((m) => m !== first && m !== live));
    const STORY: Array<{ off: number; status: "completed" | "booked" | "in_progress"; consent: "granted" | "pending" | "declined"; who?: Member }> = [
      { off: -150, status: "completed", consent: "granted", who: first },
      { off: -45, status: "booked", consent: "granted" }, // no-show candidate: started 45 minutes ago, nobody joined
      { off: -7, status: "in_progress", consent: "granted", who: live },
      { off: 50, status: "booked", consent: "pending" },
      { off: 110, status: "booked", consent: "granted" },
      { off: 170, status: "booked", consent: "declined" },
    ];
    for (const s of STORY) {
      const mem = s.who ?? rest.shift();
      if (!mem) break;
      todayUsed.add(mem.id);
      const t = Math.min(Math.max(NOW + s.off * MIN, today0 + 5 * MIN), today0 + DAY - 25 * MIN);
      const c = makeCon(mem, open(mem)!, Math.round(t / (5 * MIN)) * 5 * MIN, s.status, true);
      if (s.consent === "pending") {
        c.consent = { recording: "pending" };
      } else {
        c.consent = { recording: s.consent, at: c.createdAt, by: "client", where: "booking" };
      }
      if (s.status === "completed" && !c.transcript) {
        const rec = open(mem)!;
        c.transcript = rec.script.dialogue.map((x) => fill(x, { country: mem.country, loc: mem.loc.place, L: l.first, M: mem.first })).join("\n");
        c.transcriptSource = "meet_transcript";
        c.transcriptFetchedAt = iso(Date.parse(String(c.endedAt)) + 12 * MIN);
        c.transcriptFetchAttempts = 1;
      }
    }
  };
  for (const [li, l] of lawyers.entries()) {
    rng.reseed("today", li);
    if (li === 0 && opts.focus) {
      focusToday(l);
      continue;
    }
    const want = li === 0 ? 3 : 2;
    const mine = rng.shuffle(activeMembers.filter((m) => !todayUsed.has(m.id) && usedThisPeriod(m) < PLAN_STANDARD.callsIncluded && (mattersBy.get(m.id) ?? []).some((r) => r.doc.assignedProviderId === l.id && !r.doc.closedAt)));
    if (li === 0 && aliasClientId && !mine.some((m) => m.id === aliasClientId)) {
      const a = activeMembers.find((m) => m.id === aliasClientId);
      if (a && !todayUsed.has(a.id)) mine.unshift(a);
    }
    const hours = rng.shuffle(todayHours).slice(0, want).sort((a, b) => a - b);
    mine.slice(0, want).forEach((mem, k) => {
      todayUsed.add(mem.id);
      const rec = (mattersBy.get(mem.id) ?? []).find((r) => r.doc.assignedProviderId === l.id) ?? mattersBy.get(mem.id)![0];
      const t = crAt(today0, hours[k], rng.pick([0, 20, 40]));
      makeCon(mem, rec, t, t + 25 * MIN < NOW ? "completed" : "booked", true);
    });
  }
  // Upcoming bookings in the next 14 days.
  for (const mem of activeMembers) {
    rng.reseed("upcoming", mem.i);
    if (todayUsed.has(mem.id) && mem.id !== aliasClientId) continue;
    if (mem.i === ROLE.noCalls || mem.i === ROLE.unassigned || mem.i === ROLE.longFull) continue;
    if (!(mem.id === aliasClientId || mem.i === 0 || rng.chance(0.35))) continue;
    const t = bizTime(NOW + 3 * HOUR, Math.min(NOW + 14 * DAY, Date.parse(String(mem.membership.periodEnd)) + 10 * DAY));
    if (t === null) continue;
    const recs = mattersBy.get(mem.id)!;
    makeCon(mem, recs.find((r) => !r.doc.closedAt) ?? recs[0], t, "booked");
  }
  // A call happening right now (the newest member's first call).
  {
    const mem = members[ROLE.joined1d];
    const recs = mattersBy.get(mem.id) ?? [];
    // (Account seed: already on lawyer 0's day when it is theirs.)
    if (recs.length && mem.status === "active" && !(opts.focus && todayUsed.has(mem.id))) makeCon(mem, recs[0], NOW - 7 * MIN, "in_progress");
  }
  // A fully booked lawyer: every slot of the next three working days is taken.
  if (lawyers.length > 1) {
    rng.reseed("fully-booked");
    const l = lawyers[1];
    const theirs = activeMembers.filter((m) => m.i !== ROLE.longFull && (mattersBy.get(m.id) ?? []).some((r) => r.doc.assignedProviderId === l.id));
    let day = today0 + DAY;
    let filled = 0;
    for (let k = 0; theirs.length && filled < 3; k++, day += DAY) {
      const dow = crDow(day + 12 * HOUR);
      if (dow === 0 || dow === 6) continue;
      filled++;
      [9, 11, 14].forEach((h, n) => {
        const mem = theirs[(filled * 3 + n) % theirs.length];
        const rec = (mattersBy.get(mem.id) ?? []).find((r) => r.doc.assignedProviderId === l.id)!;
        makeCon(mem, rec, crAt(day, h), "booked");
      });
    }
  }
  // Coverage: consent pending/declined and a suggested summary always exist.
  rng.reseed("consult-cover");
  {
    const booked = consultations.filter((c) => c.status === "booked");
    if (booked.length && !booked.some((c) => (c.consent as Doc).recording === "pending")) booked[booked.length - 1].consent = { recording: "pending" };
    const done = consultations.filter((c) => c.status === "completed").sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    if (!done.some((c) => (c.consent as Doc).recording === "declined")) {
      const c = done.find((x) => (x.consent as Doc).recording === "granted");
      if (c) {
        c.consent = { recording: "declined", at: c.createdAt, by: "client", where: "booking" };
        for (const k of ["transcript", "transcriptSource", "transcriptFetchedAt", "transcriptFetchAttempts"]) delete c[k];
      }
    }
    if (!done.some((c) => (c.summary as Doc | undefined)?.status === "suggested") && done.length) {
      const c = done[done.length - 1];
      const rec = mattersBy.get(String(c.clientId))!.find((r) => r.doc.id === c.matterId)!;
      c.summary = { text: rec.script.summary, status: "suggested" };
      c.suggestedNextSteps = rec.script.steps.map((s, k) => ({ ...s, dueAt: iso(Date.parse(String(c.endedAt)) + (rec.script.dueInDays[k] ?? 14) * DAY) }));
    }
  }
  // Minutes and calls used this period.
  for (const mem of members) {
    rng.reseed("members-4", mem.i);
    const m = mem.membership;
    const used = consultations.filter((c) => c.clientId === mem.id && c.status === "completed" &&
      String(c.scheduledAt) >= String(m.periodStart) && String(c.scheduledAt) < String(m.periodEnd));
    m.minutesUsed = used.reduce((s, c) => s + Number(c.minutesUsed ?? 0), 0);
    m.callsUsed = used.length;
  }

  // ── Handoffs → opportunities → quotes ──
  const handoffs: Doc[] = [];
  const oppByMatter = new Map<string, Opportunity & Doc>();
  const quotesBy = new Map<string, Doc[]>();
  const wonQuotes: Array<{ q: Doc; mem: Member; lawyer: (typeof lawyers)[number]; acceptedAt: number }> = [];
  let hofN = 0;
  const LOST = [
    "Member decided to wait until next year.",
    "Member chose a lawyer a friend recommended.",
    "Price higher than expected; member will revisit.",
    "Matter resolved without paid work.",
  ];
  // Both stored spellings appear (staff flow vs. member flow); schemas/quoteStatus.ts reads both.
  let spelling = 0;
  const buildQuote = (mem: Member, rec: MatterRec, o: Opportunity & Doc, lawyer: (typeof lawyers)[number], sentAt: number, specIn?: MatterScript["opportunity"]): Doc => {
    const spec = specIn ?? rec.script.opportunity ?? SCRIPTS.corporate[0].opportunity!;
    const qid = `${PLACEHOLDER_PREFIX}q_${pad(mem.i + 1)}_${String(rec.doc.id).split("_").pop()}`;
    const price = (o.valueCents ?? 100000) / 100;
    const weights = spec.lines.map((_, k) => (k === 0 ? 3 : 1));
    const wsum = weights.reduce((s, w) => s + w, 0);
    const lineItems = spec.lines.map((label, k) => ({
      lineId: `${qid}_l${k + 1}`,
      label,
      amount: dollars((price * weights[k]) / wsum / 1.25),
      marginPct: 25,
      marginMode: "pct",
      marginFlat: null,
      currency: "USD",
      providerId: lawyer.id,
      notes: null,
      isOptional: false,
    }));
    const costSubtotal = dollars(lineItems.reduce((s, l) => s + l.amount, 0));
    const total = dollars(lineItems.reduce((s, l) => s + lineClientPrice(l), 0));
    return {
      id: qid,
      quoteId: qid,
      clientId: mem.id,
      matterId: rec.doc.id,
      title: o.title,
      lineItems,
      lineGroups: null,
      currency: "USD",
      total,
      costSubtotal,
      earnings: dollars(total - costSubtotal),
      serviceType: rec.area,
      legalArea: rec.area,
      defaultMarginPct: 25,
      scopeSummary: `${o.title}: ${spec.lines.join("; ")}. Fees in US dollars; government fees and taxes are paid separately.`,
      role: "required",
      optionGroupId: null,
      providerIds: [lawyer.id],
      providerSnapshots: [{ providerId: lawyer.id, name: lawyer.name }],
      status: spelling++ % 2 ? "sent_to_client" : "sent",
      approvers: [admin.email],
      approvals: [{ by: admin.email, status: "approved", at: iso(sentAt - 2 * HOUR) }],
      comments: [],
      changeLog: [
        { at: iso(sentAt - 6 * HOUR), by: mem.csm, type: "created", summary: `Quote "${o.title}" created` },
        { at: iso(sentAt), by: mem.csm, type: "sent_to_client", summary: "Sent to member" },
      ],
      clientVisible: true,
      sentAt: iso(sentAt),
      sentToClientAt: iso(sentAt),
      clientAcceptedAt: null,
      clientAcceptedBy: null,
      createdAt: iso(sentAt - 6 * HOUR),
      updatedAt: iso(sentAt),
      ...stamp,
    };
  };

  for (const c of consultations) {
    rng.reseed("after-call", String(c.id));
    const summary = c.summary as { status: string; confirmedAt?: string } | undefined;
    if (c.status !== "completed" || summary?.status !== "confirmed" || !rng.chance(0.8)) continue;
    const mem = memberById.get(String(c.clientId))!;
    const rec = mattersBy.get(mem.id)!.find((r) => r.doc.id === c.matterId)!;
    const lawyer = lawyerById.get(String(c.providerId))!;
    const approvedAt = Date.parse(summary.confirmedAt!);
    const id = `${PLACEHOLDER_PREFIX}hof_${pad(++hofN, 4)}`;
    const vars = { country: mem.country, loc: mem.loc.place, L: lawyer.first, M: mem.first };
    const h: Doc = {
      id,
      consultationId: c.id,
      clientId: mem.id,
      matterId: rec.doc.id,
      providerId: lawyer.id,
      legalNextSteps: rec.script.steps.map((s, k) => ({ what: fill(s.what, vars), who: s.who, dueAt: iso(approvedAt + (rec.script.dueInDays[k] ?? 14) * DAY) })),
      approvedAt: iso(approvedAt),
      csmTaskIds: [] as string[],
    };
    const wantsOpp = rec.commercial && !oppByMatter.has(String(rec.doc.id));
    if (wantsOpp) h.commercialNotes = rec.script.opportunity!.note;
    c.handoffId = id;
    handoffs.push(add(COLLECTIONS.handoffs, h));
    const ids = h.csmTaskIds as string[];
    const t1 = mkTask("handoff.approved", { clientId: mem.id, matterId: String(rec.doc.id), sourceId: id, detail: `${mem.first} ${mem.last}` }, approvedAt);
    if (t1) ids.push(t1.id);
    if (!wantsOpp) continue;

    // Opportunity from the handoff, through the same builder the live hook uses.
    const o = opportunityFromHandoff(h, { ownerEmail: mem.csm, area: rec.area, now: new Date(approvedAt) }) as (Opportunity & Doc) | null;
    if (!o) continue;
    o.id = `${PLACEHOLDER_PREFIX}${o.id}`;
    const spec = rec.script.opportunity!;
    o.title = fill(spec.title, vars);
    o.valueCents = Math.round(rng.int(spec.min / 50, spec.max / 50) * 50) * 100;
    o.providerId = lawyer.id;
    const age = (NOW - approvedAt) / DAY;
    let stage: Opportunity["stage"] = age < 3 ? "identified"
      : age < 12 ? rng.weighted([["quoted", 60], ["negotiating", 40]] as const)
      : rng.weighted([["quoted", 20], ["negotiating", 15], ["won", 40], ["lost", 25]] as const);
    const proposal = mkTask("handoff.opportunity", { clientId: mem.id, matterId: String(rec.doc.id), sourceId: id, detail: `${o.title} (${mem.first} ${mem.last})` }, approvedAt,
      stage === "identified" ? "open" : "done", "Proposal prepared and sent to the member.");
    if (proposal) ids.push(proposal.id);
    let sentAt = approvedAt + rng.int(20, 72) * HOUR;
    if (stage !== "identified" && sentAt > NOW - HOUR) stage = "identified";
    sentAt = Math.min(sentAt, NOW - HOUR);
    if (stage !== "identified") {
      const q = buildQuote(mem, rec, o, lawyer, sentAt);
      o.quoteId = String(q.id);
      if (stage === "won") {
        const acceptedAt = sentAt + rng.int(2, 10) * DAY;
        if (acceptedAt > NOW) stage = "negotiating";
        else {
          Object.assign(q, { status: q.status === "sent_to_client" ? "client_accepted" : "accepted", clientAcceptedAt: iso(acceptedAt), acceptedAt: iso(acceptedAt), clientAcceptedBy: mem.email, updatedAt: iso(acceptedAt) });
          (q.changeLog as Doc[]).push({ at: iso(acceptedAt), by: mem.email, type: "client_accepted", summary: "Accepted by the member" });
          o.outcome = `Member accepted the quote "${o.title}".`;
          o.closedAt = iso(acceptedAt);
          o.valueCents = Math.round(Number(q.total) * 100);
          wonQuotes.push({ q, mem, lawyer, acceptedAt });
        }
      }
      if (stage === "lost") {
        const lostAt = sentAt + rng.int(5, 20) * DAY;
        if (lostAt > NOW) stage = "quoted";
        else {
          Object.assign(q, { status: "declined", declinedAt: iso(lostAt), updatedAt: iso(lostAt) });
          o.outcome = rng.pick(LOST);
          o.closedAt = iso(lostAt);
        }
      }
      if (stage === "negotiating") (q.comments as Doc[]).push({ id: `${q.id}_c1`, by: mem.email, body: "Could the fee be split into two payments?", at: iso(sentAt + 2 * DAY) });
      (quotesBy.get(mem.id) ?? quotesBy.set(mem.id, []).get(mem.id)!).push(q);
    }
    o.stage = stage;
    o.updatedAt = iso(Math.min(NOW, Date.parse(String(o.closedAt ?? iso(sentAt)))));
    if (stage === "identified") o.nextAction = { what: TASK_RULES["handoff.opportunity"].title, dueAt: iso(approvedAt + 48 * HOUR) };
    else if (stage === "quoted") o.nextAction = { what: "Follow up on the proposal", dueAt: iso(sentAt + 5 * DAY) };
    else if (stage === "negotiating") o.nextAction = { what: "Agree the payment schedule with the member", dueAt: iso(Math.max(NOW + DAY, sentAt + 7 * DAY)) };
    else delete o.nextAction;
    oppByMatter.set(String(rec.doc.id), add(COLLECTIONS.opportunities, o));
  }
  // A few opportunities that start from an obligation or a CSM conversation.
  let oppN = 0;
  // At least one obligation-sourced and one manual opportunity at every size.
  const oppEligible = members.filter((m) => m.status !== "pending" && m.status !== "cancelled");
  const oblForced = oppEligible.find((m) => m.situation.company !== "none");
  const manualForced = oppEligible.find((m) => m !== oblForced && (mattersBy.get(m.id) ?? []).length > 0);
  for (const mem of members) {
    rng.reseed("members-5", mem.i);
    if (mem.status === "pending" || mem.status === "cancelled") continue;
    const recs = mattersBy.get(mem.id) ?? [];
    if (mem.situation.company !== "none" && (rng.chance(0.12) || mem === oblForced)) {
      const created = Math.max(mem.activatedAt + DAY, NOW - rng.int(1, 20) * DAY);
      add(COLLECTIONS.opportunities, {
        id: `${PLACEHOLDER_PREFIX}opp_obl_${pad(++oppN, 3)}`,
        clientId: mem.id,
        source: { kind: "obligation", id: `${PLACEHOLDER_PREFIX}obl_${pad(mem.i + 1)}_${COMPANY_RULE[mem.country]}` },
        title: localize("Annual corporation tax and RTBF filing", mem.country),
        area: "corporate",
        stage: "identified",
        valueCents: rng.int(7, 12) * 5000,
        ownerEmail: mem.csm,
        nextAction: { what: "Offer the annual filing package", dueAt: iso(Math.max(created + 3 * DAY, NOW - DAY)) },
        createdAt: iso(created),
        updatedAt: iso(created),
      } as Opportunity & Doc);
    } else if (recs.length && (rng.chance(0.04) || mem === manualForced)) {
      const created = Math.max(mem.activatedAt + DAY, NOW - rng.int(1, 30) * DAY);
      add(COLLECTIONS.opportunities, {
        id: `${PLACEHOLDER_PREFIX}opp_man_${pad(++oppN, 3)}`,
        clientId: mem.id,
        matterId: recs[0].doc.id,
        source: { kind: "manual" },
        title: "Property purchase next year (title study and closing)",
        area: "real_estate",
        stage: "identified",
        valueCents: rng.int(30, 60) * 5000,
        ownerEmail: mem.csm,
        nextAction: { what: "Check in about the purchase timeline", dueAt: iso(created + 30 * DAY) },
        createdAt: iso(created),
        updatedAt: iso(created),
      } as Opportunity & Doc);
    }
  }

  // Coverage: one opportunity at a given stage on a free matter (quote, acceptance, settlement via wonQuotes).
  const coverOpp = (mem: Member, rec: MatterRec, stage: Opportunity["stage"], id: string, created: number, acceptDays = 4, lostDays = 9) => {
    const lawyer = lawyerById.get(String(rec.doc.assignedProviderId))!;
    const con = consultations.find((c) => c.matterId === rec.doc.id && c.status === "completed");
    const spec = rec.script.opportunity ?? SCRIPTS[rec.area].find((s) => s.opportunity)?.opportunity ?? SCRIPTS.corporate[0].opportunity!;
    const vars = { country: mem.country, loc: mem.loc.place, L: lawyer.first, M: mem.first };
    const o = {
      id,
      clientId: mem.id,
      matterId: rec.doc.id,
      source: con ? { kind: "consultation", id: con.id } : { kind: "manual" },
      title: fill(spec.title, vars),
      area: rec.area,
      stage,
      valueCents: Math.round(rng.int(spec.min / 50, spec.max / 50) * 50) * 100,
      providerId: lawyer.id,
      ownerEmail: mem.csm,
      createdAt: iso(created),
      updatedAt: iso(created),
    } as unknown as Opportunity & Doc;
    if (stage !== "identified") {
      const sentAt = created + 2 * DAY;
      const q = buildQuote(mem, rec, o, lawyer, sentAt, spec);
      o.quoteId = String(q.id);
      if (stage === "won") {
        const acceptedAt = sentAt + acceptDays * DAY;
        Object.assign(q, { status: q.status === "sent_to_client" ? "client_accepted" : "accepted", clientAcceptedAt: iso(acceptedAt), acceptedAt: iso(acceptedAt), clientAcceptedBy: mem.email, updatedAt: iso(acceptedAt) });
        Object.assign(o, { outcome: `Member accepted the quote "${o.title}".`, closedAt: iso(acceptedAt), valueCents: Math.round(Number(q.total) * 100) });
        wonQuotes.push({ q, mem, lawyer, acceptedAt });
      } else if (stage === "lost") {
        const lostAt = sentAt + lostDays * DAY;
        Object.assign(q, { status: "declined", declinedAt: iso(lostAt), updatedAt: iso(lostAt) });
        Object.assign(o, { outcome: rng.pick(LOST), closedAt: iso(lostAt) });
      } else {
        if (stage === "negotiating") (q.comments as Doc[]).push({ id: `${q.id}_c1`, by: mem.email, body: "¿Podemos pagar en dos partes?", at: iso(sentAt + 2 * DAY) });
        o.nextAction = { what: stage === "quoted" ? "Follow up on the proposal" : "Agree the payment schedule with the member", dueAt: iso(NOW + rng.int(1, 6) * DAY) };
      }
      (quotesBy.get(mem.id) ?? quotesBy.set(mem.id, []).get(mem.id)!).push(q);
    } else o.nextAction = { what: TASK_RULES["handoff.opportunity"].title, dueAt: iso(NOW + DAY) };
    o.updatedAt = String(o.closedAt ?? iso(created + 2 * DAY));
    oppByMatter.set(String(rec.doc.id), add(COLLECTIONS.opportunities, o));
  };
  // Coverage: every opportunity stage, and one opportunity that starts from a consultation.
  rng.reseed("opp-cover");
  {
    const opps = collections[COLLECTIONS.opportunities] ?? [];
    const spare = members
      .filter((m) => m.status === "active" && m.i !== ROLE.unassigned)
      .flatMap((m) => (mattersBy.get(m.id) ?? []).filter((r) => !oppByMatter.has(String(r.doc.id)) && r.doc.assignedProviderId).map((rec) => ({ mem: m, rec })))
      // Matters with a completed call first, so a consultation-sourced opportunity is possible.
      .sort((a, b) => Number(consultations.some((c) => c.matterId === b.rec.doc.id && c.status === "completed")) - Number(consultations.some((c) => c.matterId === a.rec.doc.id && c.status === "completed")));
    const needs: Opportunity["stage"][] = (["identified", "quoted", "negotiating", "won", "lost"] as const).filter((s) => !opps.some((o) => o.stage === s));
    if (!opps.some((o) => (o.source as Doc).kind === "consultation") && !needs.includes("quoted")) needs.push("quoted");
    // Two won quotes at least, so both stored spellings (accepted / client_accepted) appear.
    while (opps.filter((o) => o.stage === "won").length + needs.filter((s) => s === "won").length < 2) needs.push("won");
    let k = 0;
    for (const stage of needs) {
      const pick = spare[k++];
      if (!pick) break;
      const { mem, rec } = pick;
      coverOpp(mem, rec, stage, `${PLACEHOLDER_PREFIX}opp_cov_${stage}_${k}`, Math.min(NOW - 25 * DAY, Math.max(rec.openedAt + DAY, NOW - 40 * DAY)));
    }
  }
  // Account seed: member 0 sees every money state; lawyer 0 has fee history across the window.
  if (opts.focus) {
    rng.reseed("focus-opps");
    const l0 = lawyers[0].id;
    const free = (m: Member) => (mattersBy.get(m.id) ?? [])
      .filter((r) => !oppByMatter.has(String(r.doc.id)) && r.doc.assignedProviderId === l0)
      .sort((a, b) => a.openedAt - b.openedAt);
    const m0 = members[0];
    // [stage, quote created days ago]: accepted with a balance still due, declined, under discussion, waiting to be accepted.
    const plan0: Array<[Opportunity["stage"], number]> = [["won", 14], ["lost", 30], ["negotiating", 9], ["quoted", 5]];
    for (const [stage, days] of plan0) {
      if ([...oppByMatter.values()].some((o) => o.clientId === m0.id && o.stage === stage)) continue;
      const rec = free(m0)[0];
      if (!rec) break;
      const created = Math.max(NOW - days * DAY, rec.openedAt + DAY);
      if (created + 7 * DAY > NOW && (stage === "won" || stage === "lost")) continue;
      coverOpp(m0, rec, stage, `${PLACEHOLDER_PREFIX}opp_acc_${stage}`, created, 4, 9);
    }
    // Lawyer 0: accepted legal work spread over the window (paid, pending and upcoming payouts).
    const AGES = [170, 150, 128, 105, 84, 62, 45, 30, 18, 9].filter((d) => d < cfg.windowDays - 5);
    const usedM = new Set<string>();
    AGES.forEach((age, k) => {
      const created = NOW - age * DAY;
      const pick = members
        .filter((m) => m !== m0 && (m.status === "active" || m.status === "past_due") && !usedM.has(m.id) && m.activatedAt < created - DAY)
        .flatMap((m) => free(m).map((rec) => ({ mem: m, rec })))
        .find((p) => p.rec.openedAt < created - DAY);
      if (!pick) return;
      usedM.add(pick.mem.id);
      coverOpp(pick.mem, pick.rec, "won", `${PLACEHOLDER_PREFIX}opp_fee_${pad(k + 1, 2)}`, created, rng.int(2, 6), 9);
    });
  }

  // ── Matter stages and next steps, consistent with calls and opportunities ──
  const stageAt = (doc: Doc, stage: string, t: number) => {
    doc.stage = stage;
    doc.stageEnteredAt = iso(Math.min(t, NOW));
  };
  for (const mem of members) {
    rng.reseed("members-6", mem.i);
    for (const rec of mattersBy.get(mem.id) ?? []) {
      const d = rec.doc;
      const cons = consultations.filter((c) => c.matterId === d.id && c.status === "completed").sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
      const hofs = handoffs.filter((h) => h.matterId === d.id);
      const o = oppByMatter.get(String(d.id));
      const age = (NOW - rec.openedAt) / DAY;
      if (o && o.stage !== "identified") {
        const q = (quotesBy.get(mem.id) ?? []).find((x) => x.id === o.quoteId)!;
        const sent = Date.parse(String(q.sentAt));
        if (o.stage === "won") {
          const acc = Date.parse(String(q.clientAcceptedAt));
          if (NOW - acc > 75 * DAY) {
            stageAt(d, "closed", acc + rng.int(40, 70) * DAY);
            d.closedAt = d.stageEnteredAt;
          } else if (NOW - acc > 10 * DAY) stageAt(d, "filing", acc + rng.int(3, 8) * DAY);
          else stageAt(d, "quote_accepted", acc);
        } else if (o.stage === "lost") {
          stageAt(d, "closed", Date.parse(String(o.closedAt)));
          d.closedAt = d.stageEnteredAt;
        } else stageAt(d, "quote_sent", sent);
      } else if (cons.length) {
        const lastH = hofs.length ? Date.parse(String(hofs[hofs.length - 1].approvedAt)) : 0;
        if (lastH && NOW - lastH > 21 * DAY && rng.chance(0.75)) {
          stageAt(d, "closed", lastH + rng.int(7, 20) * DAY);
          d.closedAt = d.stageEnteredAt;
        } else stageAt(d, "legal_review", Date.parse(String(cons[cons.length - 1].scheduledAt)));
      } else if (age > 30 && rng.chance(0.6)) {
        stageAt(d, "closed", rec.openedAt + rng.int(10, 25) * DAY); // answered by email, no call needed
        d.closedAt = d.stageEnteredAt;
      } else if (age > 4) stageAt(d, "scoping", Math.max(rec.openedAt + rng.int(1, 3) * DAY, NOW - rng.int(2, 12) * DAY));
      if (mem.cancelAt && !d.closedAt) {
        stageAt(d, "closed", mem.cancelAt);
        d.closedAt = d.stageEnteredAt;
      }
      if (!d.closedAt) {
        const vars = { country: mem.country, loc: mem.loc.place, L: lawyerById.get(String(d.assignedProviderId))?.first ?? "your lawyer", M: mem.first };
        const base = Date.parse(String(d.stageEnteredAt));
        const step = d.stage === "quote_sent"
          ? { what: "Review and answer the proposal", who: "client" as const }
          : d.stage === "quote_accepted" || d.stage === "filing"
          ? { what: `${vars.L} to file and confirm the registry entry`, who: "lawyer" as const }
          : d.stage === "intake" || d.stage === "scoping"
          ? { what: "Book your first call about this matter", who: "client" as const }
          : { what: fill(rec.script.nextStep.what, vars), who: rec.script.nextStep.who };
        // Most next steps are ahead; about one in ten is late (Needs attention).
        const dueAt = rng.chance(0.9) ? Math.max(base + rng.int(5, 12) * DAY, NOW + rng.int(2, 14) * DAY) : NOW - rng.int(1, 6) * DAY;
        d.nextStep = { ...step, dueAt: iso(dueAt) };
      }
    }
  }

  // Coverage: next steps owned by the member, the lawyer and the ILP team.
  {
    const open = (collections[COLLECTIONS.matters] ?? []).filter((d) => !d.closedAt && d.nextStep);
    if (!open.some((d) => (d.nextStep as Doc).who === "ilp")) {
      const d = open.find((x) => x.stage === "legal_review" || x.stage === "scoping");
      if (d) d.nextStep = { what: "ILP to book the Migración appointment and send the confirmation", who: "ilp", dueAt: iso(NOW + 5 * DAY) };
    }
  }

  // ── Finance: settlements, invoices and the ledger for won quotes ──
  let invN = 0;
  for (const { q, mem, lawyer, acceptedAt } of wonQuotes) {
    rng.reseed("finance", String(q.id));
    const total = Number(q.total);
    const cost = Number(q.costSubtotal);
    const secondDue = acceptedAt + 30 * DAY;
    const secondIn = secondDue < NOW && rng.chance(0.85);
    const clientPayments = [
      { id: `${q.id}_cp1`, date: iso(acceptedAt + 2 * DAY), amount: dollars(total / 2), percent: null, method: "wire", note: "50% deposit", received: true },
      { id: `${q.id}_cp2`, date: iso(secondDue), amount: dollars(total / 2), percent: null, method: secondIn ? "card" : null, note: "Balance on completion", received: secondIn },
    ].map((p) => ({ ...p, date: p.received ? at(Date.parse(p.date)) : p.date }));
    const providerPayments = [
      { id: `${q.id}_pp1`, providerId: lawyer.id, providerName: lawyer.name, date: at(acceptedAt + 9 * DAY), amount: dollars(cost / 2), paid: acceptedAt + 9 * DAY < NOW, note: "Advance on fees" },
      { id: `${q.id}_pp2`, providerId: lawyer.id, providerName: lawyer.name, date: iso(secondDue + 15 * DAY), amount: dollars(cost / 2), paid: secondIn && secondDue + 15 * DAY < NOW, note: "Balance, net 15 after client payment" },
    ];
    add("quoteSettlements", {
      id: String(q.id),
      quoteId: String(q.id),
      clientId: mem.id,
      providerIds: [lawyer.id],
      clientPayments,
      providerPayments,
      extraCharges: [],
      updatedAt: at(acceptedAt + 9 * DAY),
      updatedBy: admin.email,
    });
    const received = clientPayments.filter((p) => p.received);
    const paidSum = received.reduce((s, p) => s + p.amount, 0);
    const n = ++invN;
    add("invoices", {
      id: `${PLACEHOLDER_PREFIX}inv_${pad(n, 4)}`,
      invoiceId: `${PLACEHOLDER_PREFIX}inv_${pad(n, 4)}`,
      invoiceNumber: `PH-INV-${pad(n, 4)}-PH`, // no trailing digits: never shifts the real INV- sequence
      clientId: mem.id,
      clientName: `${mem.first} ${mem.last}`,
      clientEmail: mem.email,
      quoteId: q.id,
      date: iso(acceptedAt + DAY),
      dueDate: iso(acceptedAt + 16 * DAY),
      terms: "50% on acceptance, balance on completion",
      poNumber: null,
      lineItems: (q.lineItems as Array<Doc>).map((l, k) => {
        const rate = lineClientPrice(l);
        return { id: `${q.id}_il${k + 1}`, description: String(l.label), qty: 1, rate, discount: 0, amount: rate };
      }),
      discount: 0,
      subtotal: total,
      total,
      payments: received.map((p) => ({ id: p.id, date: p.date, amount: p.amount, method: p.method, note: p.note, received: true })),
      notes: "Placeholder invoice (seed data).",
      status: paidSum >= total - 0.01 ? "paid" : paidSum > 0 ? "partially_paid" : "sent",
      sentAt: iso(acceptedAt + DAY),
      sentToEmail: mem.email,
      createdBy: admin.email,
      createdAt: iso(acceptedAt + DAY),
      updatedAt: at(acceptedAt + 40 * DAY),
    });
  }
  const LEDGER: Array<[string, string, string, number, string, number?]> = [
    ["expense", "software", "CRM, email and video tooling", 420, "monthly"],
    ["expense", "payroll", "Customer success (part-time contractor)", 2400, "monthly"],
    ["expense", "banking fees", "Card processing and wire fees", 95, "monthly"],
    ["expense", "professional services", "Accounting (Costa Rica and US)", 650, "quarterly"],
    ["expense", "office", "Co-working desk, Escazú", 230, "monthly"],
    ["investment", "ads", "Search ads: free deadline check", 900, "monthly", 1450],
    ["investment", "content", "Legal update articles (writer + lawyer review)", 600, "monthly", 300],
    ["investment", "events", "Expat community meetup, Tamarindo", 750, "none", 1600],
    ["income", "referral fee", "Insurance broker referral fees", 280, "none"],
    ["income", "commission", "Relocation partner commission", 400, "none"],
  ];
  LEDGER.forEach(([kind, category, label, amount, recurrence, ret], k) => {
    const start = NOW - rng.int(Math.round(cfg.windowDays * 0.5), cfg.windowDays) * DAY;
    add("financeLedger", {
      id: `${PLACEHOLDER_PREFIX}led_${pad(k + 1, 3)}`,
      kind,
      category,
      label,
      amount,
      currency: "USD",
      date: iso(start),
      recurrence,
      endDate: null,
      returnAmount: kind === "investment" ? ret ?? 0 : 0,
      quoteId: null,
      note: "Placeholder ledger entry (seed data).",
    });
  });

  // ── Obligations from the Costa Rica catalog ──
  const obligationsBy = new Map<string, Doc[]>();
  for (const mem of members) {
    rng.reseed("members-7", mem.i);
    if (mem.status === "pending") continue;
    const list: Doc[] = [];
    const nowAnswers: CheckAnswers = { ...mem.answers };
    for (const f of evaluateCheck(nowAnswers, now)) {
      const key = f.ruleId.toLowerCase();
      const due = Date.parse(f.dueAt ?? "");
      const monthly = /CCSS|PILA|CSS_MONTHLY|CONTRIB|_MONTHLY/.test(f.ruleId);
      const status = mem.status === "cancelled" ? "upcoming"
        : monthly ? rng.weighted([["upcoming", 40], ["handled", 60]] as const)
        : rng.weighted([["upcoming", 78], ["asked", 15], ["dismissed", 7]] as const);
      list.push(add(COLLECTIONS.obligations, { id: `${PLACEHOLDER_PREFIX}obl_${pad(mem.i + 1)}_${key}`, clientId: mem.id, country: mem.country, ruleId: f.ruleId, title: f.title, ...(f.dueAt ? { dueAt: f.dueAt } : {}), ...(f.dueText ? { dueText: f.dueText } : {}), ...(f.confidence ? { confidence: f.confidence } : {}), status }));
      // Last year's occurrence of an annual rule, already handled.
      if (Number.isFinite(due) && due - 365 * DAY > mem.activatedAt && due - 365 * DAY < NOW && !key.includes("ccss")) {
        list.push(add(COLLECTIONS.obligations, { id: `${PLACEHOLDER_PREFIX}obl_${pad(mem.i + 1)}_${key}_prev`, clientId: mem.id, country: mem.country, ruleId: f.ruleId, title: f.title, dueAt: iso(due - 365 * DAY), status: "handled" }));
      }
    }
    obligationsBy.set(mem.id, list);
  }
  // Coverage: every obligation status appears.
  rng.reseed("obligation-cover");
  {
    const all = collections[COLLECTIONS.obligations] ?? [];
    for (const status of ["upcoming", "asked", "handled", "dismissed"]) {
      if (all.some((o) => o.status === status)) continue;
      const o = all.find((x) => x.status === "upcoming" && all.filter((y) => y.status === "upcoming").length > 1);
      if (o) o.status = status;
    }
    // Account member: one obligation already sent to the lawyer ("Ask my lawyer"), the rest upcoming.
    if (opts.focus) {
      const mine = all.filter((x) => x.clientId === members[0].id && x.status === "upcoming");
      if (mine.length > 1 && !all.some((x) => x.clientId === members[0].id && x.status === "asked")) mine[mine.length - 1].status = "asked";
    }
  }

  // ── Membership tasks, feedback, consents ──
  const monthlySlots: Array<{ mem: Member; t: number }> = [];
  // The first answered months take every score 0-10 once, so the full range always exists.
  rng.reseed("monthly-queue");
  const coverScores = rng.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const addMonthly = (mem: Member, t: number, score: number) => {
    const month = iso(t).slice(0, 7);
    const fid = `${PLACEHOLDER_PREFIX}fb_m_${pad(mem.i + 1)}_${month}`;
    if ((collections[COLLECTIONS.feedback] ?? []).some((f) => f.id === fid)) return false; // one answer per month
    add(COLLECTIONS.feedback, {
      id: fid, clientId: mem.id, kind: "monthly", score, month, at: iso(t),
      ...(score <= 6 ? { comment: rng.pick(["Hard to get a call slot this month.", "Not sure I'm using it enough.", "Took a while to hear back.", "No me quedó claro el siguiente paso."]) } : score >= 9 && rng.chance(0.4) ? { comment: rng.pick(["Peace of mind for our house.", "The deadline reminders alone are worth it.", "Mariana is fantastic.", "Super útil 🙌"]) } : {}),
    });
    if (score <= 6) mkTask("feedback.low_score", { clientId: mem.id, sourceId: fid, dedupeKey: fid, detail: `monthly score ${score}/10` }, t);
    return true;
  };
  for (const mem of members) {
    rng.reseed("members-8", mem.i);
    const m = mem.membership;
    if (mem.status !== "pending") {
      mkTask("membership.activated", { clientId: mem.id, sourceId: m.id, detail: `${mem.first} ${mem.last}` }, mem.activatedAt,
        NOW - mem.activatedAt > 2 * DAY ? "done" : "open");
      // COUNTRIES: no placeholder lawyer licensed in the member's country yet (or none matched, the unassigned role).
      if (mem.i === ROLE.unassigned || !lawyers.some((_, k) => lawyerCountry(k) === mem.country)) {
        mkTask("member.unassigned_country", {
          clientId: mem.id,
          sourceId: mem.id,
          sourceKind: "membership",
          dedupeKey: `${mem.id}_country_${mem.country}`,
          detail: `unassigned member in ${COUNTRIES[mem.country].name} (${mem.first} ${mem.last})`,
        }, mem.activatedAt + HOUR, "open");
      }
    }
    // DEADLINES: some members still have deadlines without a date a week after adding them.
    if (mem.status === "active" && mem.i % 7 === 3 && NOW - mem.activatedAt > 8 * DAY) {
      mkTask("obligation.needs_date_7d", {
        clientId: mem.id,
        sourceId: `${mem.id}_needs_date`,
        sourceKind: "obligation",
        detail: `${mem.first} ${mem.last}`,
      }, mem.activatedAt + 8 * DAY, "auto");
    }
    if (mem.status === "past_due") {
      mkTask("membership.past_due", { clientId: mem.id, sourceId: m.id, dedupeKey: `${m.id}_${String(m.pastDueSince).slice(0, 10)}`, detail: `${mem.first} ${mem.last}` },
        Date.parse(String(m.pastDueSince)), "open");
    }
    if (m.cancelAtPeriodEnd) {
      const reqAt = Date.parse(String(m.cancelRequestedAt));
      mkTask("membership.cancel_requested", { clientId: mem.id, sourceId: m.id, dedupeKey: `${m.id}_${String(m.periodEnd).slice(0, 10)}`, detail: `${mem.first} ${mem.last}: ${m.cancelReason}` },
        reqAt, mem.status === "cancelled" ? "done" : "open", mem.status === "cancelled" ? "Save call held; member confirmed the cancellation." : undefined);
      add(COLLECTIONS.feedback, {
        id: `${PLACEHOLDER_PREFIX}fb_cxl_${pad(mem.i + 1)}`,
        clientId: mem.id,
        kind: "cancel",
        comment: m.cancelReason,
        reasonKey: m.cancelReasonKey,
        membershipId: m.id,
        at: iso(reqAt),
      });
    }
    // Monthly 0-10 question: about half answer; NPS lands around +40.
    if (mem.status !== "pending") {
      const end = mem.cancelAt ?? NOW;
      for (let k = 1; ; k++) {
        const t = addMonths(mem.activatedAt, k) + rng.int(1, 4) * DAY;
        if (t > end) break;
        if (coverScores.length && mem.status !== "cancelled") {
          if (addMonthly(mem, t, coverScores[coverScores.length - 1])) coverScores.pop();
          continue;
        }
        if (!rng.chance(opts.size === "demo" ? 0.6 : 0.45)) {
          monthlySlots.push({ mem, t });
          continue;
        }
        addMonthly(mem, t, opts.size === "demo" ? rng.pick([9, 10, 10]) : rng.weighted([[10, 30], [9, 25], [8, 15], [7, 12], [6, 7], [5, 5], [4, 3], [3, 2], [2, 1], [1, 1], [0, 1]] as const));
      }
    }
    // Consents: terms + privacy at join, optional marketing, AI notice, recording.
    const cons = (kind: ConsentKind, granted: boolean, t: number, source: string, extra: Doc = {}) => {
      const n = (conCount.get(`cns_${mem.id}`) ?? 0) + 1;
      conCount.set(`cns_${mem.id}`, n);
      add(COLLECTIONS.consents, {
        id: `${PLACEHOLDER_PREFIX}cns_${pad(mem.i + 1)}_${pad(n, 2)}`,
        clientId: mem.id,
        email: mem.email,
        kind,
        granted,
        version: kind === "terms" ? LEGAL_VERSIONS.terms : kind === "privacy" || kind === "marketing_email" ? LEGAL_VERSIONS.privacy : LEGAL_VERSIONS.recording,
        source,
        at: iso(Math.min(t, NOW)),
        ...extra,
      });
    };
    const joinAt = mem.activatedAt - 3 * MIN;
    cons("terms", true, joinAt, "join");
    cons("privacy", true, joinAt, "join");
    cons("marketing_email", rng.chance(0.6), joinAt, "join");
    if (mem.aiConsent && mem.status !== "pending") cons("ai_assistant", true, mem.activatedAt + rng.int(1, 20) * DAY, rng.pick(["lily", "settings"]));
    if (mem.recordingWithdrawnAt && mem.recordingWithdrawnAt < NOW) cons("recording", false, mem.recordingWithdrawnAt, "privacy_page");
  }
  // Every monthly score 0-10 appears at least once (unanswered months take the missing ones).
  rng.reseed("monthly-cover");
  {
    const have = new Set((collections[COLLECTIONS.feedback] ?? []).filter((f) => f.kind === "monthly").map((f) => Number(f.score)));
    const slots = rng.shuffle(monthlySlots);
    for (let s = 0; s <= 10; s++) {
      while (!have.has(s) && slots.length) {
        const slot = slots.pop()!;
        if (addMonthly(slot.mem, slot.t, s)) have.add(s);
      }
    }
    // Keep NPS plausible (≥ +30) after covering the low scores, using more unanswered months.
    const nps = () => {
      const m = (collections[COLLECTIONS.feedback] ?? []).filter((f) => f.kind === "monthly").map((f) => Number(f.score));
      return ((m.filter((x) => x >= 9).length - m.filter((x) => x <= 6).length) / Math.max(1, m.length)) * 100;
    };
    while (nps() < 30 && slots.length) {
      const slot = slots.pop()!;
      addMonthly(slot.mem, slot.t, rng.chance(0.6) ? 10 : 9);
    }
  }
  for (const c of consultations) {
    rng.reseed("after-call", String(c.id));
    const consent = c.consent as { recording: string; at?: string };
    if (consent.recording === "pending" || !consent.at) continue;
    const mem = memberById.get(String(c.clientId))!;
    const n = (conCount.get(`cns_${mem.id}`) ?? 0) + 1;
    conCount.set(`cns_${mem.id}`, n);
    add(COLLECTIONS.consents, {
      id: `${PLACEHOLDER_PREFIX}cns_${pad(mem.i + 1)}_${pad(n, 2)}`,
      clientId: mem.id,
      email: mem.email,
      kind: "recording",
      granted: consent.recording === "granted",
      version: LEGAL_VERSIONS.recording,
      source: "booking",
      consultationId: c.id,
      at: consent.at,
    });
  }
  // Every post-call score 1-5 appears at least once.
  rng.reseed("rating-cover");
  for (const score of [1, 2, 3, 4, 5] as const) {
    if (ratings.some((r) => r.score === score)) continue;
    const c = consultations.find((x) => x.status === "completed" && !x.rating && Date.parse(String(x.endedAt)) < NOW - 12 * HOUR);
    if (!c) break;
    const ratedAt = Math.min(NOW, Date.parse(String(c.endedAt)) + 5 * HOUR);
    const comment = rng.pick(RATING_COMMENTS[score]);
    c.rating = { score, comment, at: iso(ratedAt) };
    ratings.push({ c, mem: memberById.get(String(c.clientId))!, score, comment, at: ratedAt });
  }
  // Post-call ratings → member_feedback (+ low-score follow-ups).
  for (const r of ratings) {
    rng.reseed("rating", String(r.c.id));
    const fid = `${PLACEHOLDER_PREFIX}fb_c_${String(r.c.id).replace(PLACEHOLDER_PREFIX, "")}`;
    add(COLLECTIONS.feedback, {
      id: fid, clientId: r.mem.id, kind: "post_call", consultationId: r.c.id, providerId: r.c.providerId, score: r.score,
      ...(r.comment ? { comment: r.comment } : {}), at: iso(r.at),
    });
    if (r.score <= 2) mkTask("feedback.low_score", { clientId: r.mem.id, sourceId: String(r.c.id), sourceKind: "consultation", dedupeKey: fid, detail: `rated a call ${r.score}/5` }, r.at);
  }

  // ── ROUTING: reviews and hidden ratings, "Why this lawyer", two coverage gaps ──
  rng.reseed("routing");
  {
    const { reviews, summaries } = reviewsAndRatings(ratings.map((r) => ({ c: r.c, score: r.score, comment: r.comment, at: iso(r.at) })), lawyers.map((l) => l.id), iso(NOW));
    for (const r of reviews) add(COLLECTIONS.reviews, r);
    for (const r of summaries) add(COLLECTIONS.lawyerRatings, r);
    const ratingOf = new Map(summaries.map((r) => [String(r.providerId), { ratingScore: Number(r.ratingScore), reviewCount: Number(r.reviewCount) }]));
    const providerDocs = collections.providers ?? [];
    const forRouting = lawyers.map((l, i) => seedLawyerForRouting(providerDocs.find((p) => p.id === l.id)!, i, ratingOf.get(l.id), l.load, NOW));
    const langsOf = (mem: Member) => (mem.situation.language === "es" ? ["es"] : ["en"]);
    // "Why this lawyer" on each member's first matter.
    for (const mem of members) {
      const first = mattersBy.get(mem.id)?.[0];
      if (!first) continue;
      first.doc.routing = seedDecision(
        { country: mem.country, area: first.area, region: mem.loc.province, memberName: `${mem.first} ${mem.last}`, languages: langsOf(mem) },
        forRouting,
        typeof first.doc.assignedProviderId === "string" ? first.doc.assignedProviderId : null,
        mem.csm,
        iso(first.openedAt),
      );
    }
    // Two members ask about something no seed lawyer covers: the no-match path.
    const waiting = members.filter((m) => m.status === "active" && m.i !== 0 && m.i !== ROLE.unassigned).slice(0, 2);
    waiting.forEach((mem, k) => {
      const g = GAP_SPECIALTIES[k];
      const spec = DEFAULT_SPECIALTIES.find((x) => x.id === g.specialtyId)!;
      const openedAt = NOW - (k === 0 ? 2 : 1) * DAY - 3 * HOUR;
      const matterId = `${PLACEHOLDER_PREFIX}mat_${pad(mem.i + 1)}_gap`;
      const decision = seedDecision({ country: mem.country, area: spec.group, region: mem.loc.province, memberName: `${mem.first} ${mem.last}`, languages: langsOf(mem) }, forRouting, null, mem.csm, iso(openedAt));
      decision.request.specialtyId = spec.id;
      decision.noMatchReason = `No active lawyer in ${COUNTRIES[mem.country].name} covers ${spec.label.toLowerCase()}.`;
      add(COLLECTIONS.matters, {
        id: matterId, clientId: mem.id, title: g.title, area: spec.group, specialtyId: spec.id, country: mem.country, stage: "intake",
        stageEnteredAt: iso(openedAt), openedAt: iso(openedAt), question: fill(g.question, { country: mem.country, loc: mem.loc.place, L: "your lawyer", M: mem.first }),
        nextStep: { what: "We are arranging your lawyer", who: "ilp" }, nextStepSetAt: iso(openedAt), routing: decision,
      });
      const gapId = `${PLACEHOLDER_PREFIX}gap_${mem.id.replace(PLACEHOLDER_PREFIX, "")}_${matterId.replace(PLACEHOLDER_PREFIX, "")}`;
      const detail = `${COUNTRIES[mem.country].name} · ${spec.label} · ${mem.first} ${mem.last}`;
      const task = mkTask("routing.no_match", { clientId: mem.id, matterId, sourceId: matterId, sourceKind: "manual", dedupeKey: gapId, ownerEmail: admin.email, detail }, openedAt + 5 * MIN, "open");
      let salesId: string | undefined;
      let salesTaskId: string | undefined;
      if (k === 0) {
        salesId = `${PLACEHOLDER_PREFIX}con_sales_${pad(mem.i + 1)}`;
        const start = crAt(crMidnight(new Date(NOW + DAY)), 10, 0);
        add(COLLECTIONS.consultations, salesCallDoc(salesId, mem.id, matterId, iso(start), meetUrlFor(salesId), iso(openedAt + 5 * MIN), spec.label, mem.country));
      } else {
        salesTaskId = mkTask("sales.call_unscheduled", { clientId: mem.id, matterId, sourceId: gapId, dedupeKey: gapId, ownerEmail: SEED_SALES_EMAIL, detail: `${mem.first} ${mem.last}` }, openedAt + 6 * MIN, "open")?.id;
      }
      add(COLLECTIONS.routingGaps, {
        id: gapId, clientId: mem.id, matterId, country: mem.country, area: spec.group, specialtyId: spec.id, status: "open", reason: decision.noMatchReason,
        createdAt: iso(openedAt), updatedAt: iso(NOW - 30 * MIN), attempts: 3 + k, clientNotifiedAt: iso(openedAt + 5 * MIN),
        ...(task ? { taskId: task.id } : {}), ...(salesId ? { salesConsultationId: salesId } : {}), ...(salesTaskId ? { salesTaskId } : {}),
      });
      add(COLLECTIONS.staffNotifications, {
        id: `${PLACEHOLDER_PREFIX}ntf_${gapId.replace(PLACEHOLDER_PREFIX, "")}`, kind: "routing.no_match",
        title: `Missing specialty for an assignment: ${detail}`,
        body: `${decision.noMatchReason} The member was told we are arranging their lawyer, and a short call with the sales team is being set up.`,
        link: `/dashboard/members/${encodeURIComponent(mem.id)}`, clientId: mem.id, matterId, createdAt: iso(openedAt + 5 * MIN),
        readBy: k === 0 ? [] : [mem.csm],
      });
    });
  }

  // ── Privacy requests (one export done, one deletion in review, …) ──
  // Every kind and every status at every size (large adds two more completed ones).
  const PR = [["export", "completed"], ["delete", "in_review"], ["access", "received"], ["rectify", "completed"], ["restrict", "refused"], ["export", "completed"], ["access", "completed"]] as const;
  const prMembers = rng.shuffle(members.filter((m) => m.status !== "pending" && m.i > 0)).slice(0, opts.size === "large" ? 7 : 5);
  prMembers.forEach((mem, k) => {
    const [kind, status] = PR[k];
    const created = kind === "delete" && mem.cancelAt ? Math.min(NOW - 2 * DAY, mem.cancelAt + 5 * DAY) : NOW - rng.int(3, 40) * DAY;
    const id = `${PLACEHOLDER_PREFIX}prq_${pad(k + 1, 3)}`;
    const dueAt = created + 14 * DAY;
    add(COLLECTIONS.privacyRequests, {
      id, clientId: mem.id, email: mem.email, kind, status,
      note: kind === "delete" ? "Member asked to delete their data after cancelling." : kind === "rectify" ? "Correct date of birth."
        : kind === "restrict" ? "Restriction refused: the data is needed for an open legal matter; explained to the member." : undefined,
      dueAt: iso(dueAt), createdAt: iso(created),
      ...(status === "completed" ? { completedAt: iso(created + rng.int(1, 6) * DAY), updatedBy: admin.email } : {}),
    });
    mkTask("privacy.request_received", { clientId: mem.id, sourceId: id, ownerEmail: admin.email, detail: `${kind} request`, dueAt: iso(Math.min(created + 24 * HOUR, dueAt)) }, created,
      status === "completed" ? "done" : "open");
  });

  // ── Member documents (metadata; files only with --with-files) ──
  const files: SeedData["files"] = [];
  const DOCS: Array<[string, string, string, (m: Member) => boolean]> = [
    ["identity", "passport-scan.pdf", "application/pdf", () => true],
    ["residency", "birth-certificate-apostilled.pdf", "application/pdf", (m) => m.persona === "retiree" || m.persona === "applicant"],
    ["residency", "pension-letter.pdf", "application/pdf", (m) => m.persona === "retiree"],
    ["property", "property-deed-escritura.pdf", "application/pdf", (m) => m.profile.ownsProperty === true],
    ["property", "cadastral-plan.jpg", "image/jpeg", (m) => m.profile.ownsProperty === true],
    ["company", "personeria-juridica.pdf", "application/pdf", (m) => m.profile.hasCompany === true],
    ["vehicle", "vehicle-title.pdf", "application/pdf", (m) => m.profile.ownsVehicle === true],
    ["tax", "rental-income-2025.pdf", "application/pdf", (m) => m.persona === "business" || m.persona === "owner"],
  ];
  for (const mem of members) {
    rng.reseed("members-9", mem.i);
    if (mem.status === "pending") continue;
    const recs = mattersBy.get(mem.id) ?? [];
    const eligible = DOCS.filter((d) => d[3](mem));
    let n = Math.min(eligible.length, rng.int(0, 4));
    if (opts.focus && mem.i === 0) n = Math.min(eligible.length, 6); // account member: a full documents list
    rng.shuffle(eligible).slice(0, n).forEach(([category, name, type], k) => {
      // With real files every placeholder is a tiny PDF.
      const contentType = opts.withFiles ? "application/pdf" : type;
      const fileName = opts.withFiles ? name.replace(/\.\w+$/, ".pdf") : name;
      const id = `${PLACEHOLDER_PREFIX}doc_${pad(mem.i + 1)}_${k + 1}`;
      const objectName = `members/${mem.id}/${id}`;
      const uploadedAt = Math.min(NOW - HOUR, mem.activatedAt + rng.int(1, 40) * DAY);
      add("member_documents", {
        id, clientId: mem.id,
        ...(recs.length ? { matterId: rng.pick(recs).doc.id } : {}),
        category, fileName, contentType,
        size: rng.int(80, 2400) * 1024,
        uploadedAt: iso(uploadedAt),
        uploadedBy: rng.chance(0.8) ? mem.email : mem.csm,
        ...(opts.withFiles ? { storage: "gcs", objectName } : { storage: "none", placeholderNoFile: true }),
      });
      if (opts.withFiles) files.push({ clientId: mem.id, docId: id, objectName, fileName });
    });
  }

  // Both stored spellings for "with the member" and "accepted" (schemas/quoteStatus.ts reads both).
  {
    const all = [...quotesBy.values()].flat();
    for (const [a, b] of [["sent", "sent_to_client"], ["accepted", "client_accepted"]] as const) {
      const group = all.filter((q) => q.status === a || q.status === b);
      if (group.length >= 2 && !group.some((q) => q.status === a)) group[0].status = a;
      if (group.length >= 2 && !group.some((q) => q.status === b)) group[0].status = b;
    }
  }
  // Staff-side quotes still in preparation (never shown to the member): every internal status.
  rng.reseed("internal-quotes");
  {
    const who = [0, ROLE.longFull, ROLE.renewToday, ROLE.missingDoc].map((i) => members[i]).filter((m) => m && m.status === "active");
    (["draft", "pending_approval", "changes_requested", "approved"] as const).forEach((status, k) => {
      const mem = who[k % Math.max(1, who.length)];
      const rec = mem ? (mattersBy.get(mem.id) ?? []).find((r) => r.doc.assignedProviderId) : undefined;
      if (!mem || !rec) return;
      const lawyer = lawyerById.get(String(rec.doc.assignedProviderId))!;
      const spec = rec.script.opportunity ?? SCRIPTS[rec.area].find((s) => s.opportunity)?.opportunity ?? SCRIPTS.corporate[0].opportunity!;
      const q = buildQuote(mem, rec, { title: `${fill(spec.title, { country: mem.country, loc: mem.loc.place, L: lawyer.first, M: mem.first })} (draft)`, valueCents: spec.min * 100 } as unknown as Opportunity & Doc, lawyer, NOW - (k + 1) * DAY, spec);
      const qid = `${String(q.id)}_int${k + 1}`;
      Object.assign(q, {
        id: qid, quoteId: qid, status, clientVisible: false, sentAt: null, sentToClientAt: null,
        approvals: status === "approved" ? q.approvals : [],
        comments: status === "changes_requested" ? [{ id: `${qid}_c1`, by: admin.email, body: "Split the government fees into their own line, please.", at: iso(NOW - DAY) }] : [],
        changeLog: [(q.changeLog as Doc[])[0]],
      });
      (quotesBy.get(mem.id) ?? quotesBy.set(mem.id, []).get(mem.id)!).push(q);
    });
  }

  // ── Client records (person doc with the embedded arrays the portals read) ──
  const clients: Doc[] = [];
  for (const mem of members) {
    rng.reseed("members-10", mem.i);
    const m = mem.membership;
    const recs = mattersBy.get(mem.id) ?? [];
    const primary = recs.find((r) => !r.doc.closedAt) ?? recs[0];
    const lawyer = primary ? lawyerById.get(String(primary.doc.assignedProviderId)) : undefined;
    const vars = { country: mem.country, loc: mem.loc.place, L: lawyer?.first ?? "your lawyer", M: mem.first };
    // Charges: activation + each paid month (+ the unpaid month when past due) + accepted legal work.
    const charges: Doc[] = [];
    if (mem.status !== "pending") {
      charges.push({ id: `${PLACEHOLDER_PREFIX}ch_${pad(mem.i + 1)}_act`, label: "Activation fee", amountMinor: PLAN_STANDARD.activationCents, currency: "USD", status: "paid", createdAt: iso(mem.activatedAt), paidAt: iso(mem.activatedAt) });
      if (mem.i === ROLE.longFull) {
        charges.push({ id: `${PLACEHOLDER_PREFIX}ch_${pad(mem.i + 1)}_dup`, label: "Activation fee (duplicate, voided)", amountMinor: PLAN_STANDARD.activationCents, currency: "USD", status: "void", createdAt: iso(mem.activatedAt + 10 * MIN) });
      }
      mem.periods.forEach((p, k) => charges.push({ id: `${PLACEHOLDER_PREFIX}ch_${pad(mem.i + 1)}_m${k + 1}`, label: `Membership, month ${k + 1}`, amountMinor: PLAN_STANDARD.monthlyCents, currency: "USD", status: "paid", createdAt: iso(p), paidAt: iso(p) }));
      if (mem.status === "past_due") {
        charges.push({ id: `${PLACEHOLDER_PREFIX}ch_${pad(mem.i + 1)}_m${mem.periods.length + 1}`, label: `Membership, month ${mem.periods.length + 1}`, amountMinor: PLAN_STANDARD.monthlyCents, currency: "USD", status: "pending", createdAt: String(m.pastDueSince), dueDate: String(m.pastDueSince) });
      }
    } else {
      charges.push({ id: `${PLACEHOLDER_PREFIX}ch_${pad(mem.i + 1)}_act`, label: "Activation fee + first month", amountMinor: PLAN_STANDARD.activationCents + PLAN_STANDARD.monthlyCents, currency: "USD", status: "pending", createdAt: iso(mem.activatedAt), dueDate: iso(mem.activatedAt + DAY) });
    }
    for (const w of wonQuotes.filter((x) => x.mem.id === mem.id)) {
      const s = (collections.quoteSettlements ?? []).find((d) => d.id === w.q.id)!;
      charges.push({
        id: `${PLACEHOLDER_PREFIX}ch_${String(w.q.id).replace(PLACEHOLDER_PREFIX, "")}`,
        label: `Legal work: ${w.q.title}`,
        amountMinor: Math.round(Number(w.q.total) * 100),
        currency: "USD",
        status: (s.clientPayments as Doc[]).every((p) => p.received) ? "paid" : "pending",
        payments: (s.clientPayments as Doc[]).filter((p) => p.received).map((p) => ({ amount: p.amount, date: p.date, received: true })),
        createdAt: iso(w.acceptedAt),
        dueDate: iso(w.acceptedAt + 30 * DAY),
      });
    }
    // Missing document → pendingActions (the daily sweep turns them into tasks).
    const pendingActions: Doc[] = [];
    if (mem.i === ROLE.missingDoc && mem.status === "active") {
      pendingActions.push({ id: `${PLACEHOLDER_PREFIX}pa_${pad(mem.i + 1)}`, label: "Upload apostilled birth certificate", dueAt: iso(NOW - 6 * DAY) });
    } else if (mem.status === "active" && rng.chance(0.12)) {
      pendingActions.push({ id: `${PLACEHOLDER_PREFIX}pa_${pad(mem.i + 1)}`, label: rng.pick(["Upload apostilled birth certificate", "Upload passport copy (scan)", "Upload the property deed (escritura)", "Upload the CCSS certificate"]), dueAt: iso(NOW - rng.int(-3, 9) * DAY) });
    }
    // Messages: team ↔ member, and the AI assistant (labelled AI in the portal).
    const statusComments: Doc[] = [];
    const commentCount = mem.status === "pending" ? 0 : mem.i === 0 ? 3 : rng.int(1, 4);
    for (let k = 0; k < commentCount; k++) {
      const t = Math.min(NOW - HOUR, mem.activatedAt + (k + 1) * rng.int(2, 9) * DAY);
      const team = k % 2 === 0;
      statusComments.push({
        id: `${PLACEHOLDER_PREFIX}cmt_${pad(mem.i + 1)}_${k + 1}`,
        author: team ? mem.csm : mem.email,
        authorType: team ? "staff" : "client",
        body: mem.i === 0 && k === 1
          ? "Thank you so much, this is exactly what I needed! 🙏🌴"
          : mem.situation.language === "es"
          ? fill(team ? TEAM_MESSAGES_ES[Math.min(k, TEAM_MESSAGES_ES.length - 1)] : rng.pick(MEMBER_MESSAGES_ES), vars)
          : fill(team ? TEAM_MESSAGES[Math.min(k, TEAM_MESSAGES.length - 1)] : rng.pick(MEMBER_MESSAGES), vars),
        createdAt: iso(t),
      });
    }
    const statusChatThread: Doc[] = [];
    if (mem.aiConsent && mem.status !== "pending" && rng.chance(0.55)) {
      for (const [q, a] of rng.shuffle(LILY).slice(0, rng.int(1, 3))) {
        const t = Math.min(NOW - 2 * HOUR, mem.activatedAt + rng.int(2, 60) * DAY);
        statusChatThread.push({ role: "user", content: q, createdAt: iso(t) }, { role: "assistant", content: a, createdAt: iso(t + 8000), aiGenerated: true });
      }
    }
    if (opts.focus && mem.i === 0) {
      // Account member: the long, realistic thread (team, lawyer, member in English and Spanish, AI replies).
      statusComments.length = 0;
      statusChatThread.length = 0;
      const l0 = lawyers[0];
      FOCUS_THREAD.forEach(([who, daysAgo, text], k) => {
        const t = Math.min(NOW - 10 * MIN, Math.max(mem.activatedAt + HOUR, NOW - daysAgo * DAY)) + (who === "ai" ? 9000 : 0);
        const body = fill(text, { ...vars, L: l0.first });
        if (who === "ask" || who === "ai") {
          statusChatThread.push({ role: who === "ai" ? "assistant" : "user", content: body, createdAt: iso(t), ...(who === "ai" ? { aiGenerated: true } : {}) });
        } else {
          statusComments.push({
            id: `${PLACEHOLDER_PREFIX}cmt_${pad(mem.i + 1)}_${pad(k + 1, 2)}`,
            author: who === "csm" ? mem.csm : who === "lawyer" ? l0.email : mem.email,
            authorType: who === "member" ? "client" : "staff",
            body,
            createdAt: iso(t),
          });
        }
      });
    }
    const noteTexts = mem.i === 0 ? [LONG_NOTE, CSM_NOTES[0]] : mem.i === ROLE.joined1d ? [SHORT_NOTES[0]] : mem.i === ROLE.missingDoc ? [SHORT_NOTES[1], SHORT_NOTES[2]]
      : rng.shuffle(CSM_NOTES).slice(0, rng.int(1, 3));
    const notes = mem.status === "pending" ? [] : noteTexts.map((n, k) => ({
      text: fill(n, vars), author: mem.csm, createdAt: iso(Math.min(NOW - HOUR, mem.activatedAt + (k + 1) * rng.int(1, 12) * HOUR)),
    }));
    const activityLog: Doc[] = [
      { type: "membership_started", actor: "system", timestamp: iso(mem.activatedAt), note: mem.status === "pending" ? "Join started, payment pending." : "Membership activated." },
      ...recs.map((r) => ({ type: "stage_changed", actor: lawyerById.get(String(r.doc.assignedProviderId))?.email ?? mem.csm, timestamp: String(r.doc.stageEnteredAt), note: `${r.doc.title}: ${r.doc.stage}` })),
      ...notes.map((n) => ({ type: "note_added", actor: n.author, timestamp: n.createdAt })),
    ].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const stageRatings = primary && rng.chance(0.25)
      ? [{ stage: String(primary.doc.stage), rating: rng.weighted([[5, 60], [4, 30], [3, 10]] as const), createdAt: iso(Math.min(NOW - HOUR, Date.parse(String(primary.doc.stageEnteredAt)) + DAY)) }]
      : [];
    const client: Doc = {
      id: mem.id,
      name: mem.first,
      surname: mem.last,
      ...mem.profile,
      email: mem.email,
      clientFields: { ...mem.profile },
      jurisdiction: COUNTRIES[mem.country].name,
      country: mem.country,
      legalCountry: mem.country,
      persona: fill(PERSONA_LABEL[mem.persona], vars),
      legalArea: primary?.area ?? "",
      legalMatter: primary ? String(primary.doc.title) : "",
      stage: primary ? String(primary.doc.stage) : "intake",
      stageEnteredAt: primary ? String(primary.doc.stageEnteredAt) : iso(mem.activatedAt),
      ...(lawyer ? { assignedProviderId: lawyer.id } : {}),
      membershipStatus: mem.status,
      ...(mem.status !== "pending" ? { memberSince: iso(mem.activatedAt) } : {}),
      csmEmail: mem.csm,
      source: mem.leadId ? "deadline_check" : rng.pick(["join", "referral"]),
      ...(mem.leadId ? { leadId: mem.leadId } : {}),
      funnelAnonId: (mem as Member & { anon: string }).anon,
      ...((mem as Member & { src: string | null }).src ? { funnelSource: (mem as Member & { src: string | null }).src } : {}),
      emailOptOut: false,
      charges,
      quotes: quotesBy.get(mem.id) ?? [],
      notes,
      activityLog,
      statusComments,
      statusChatThread,
      pendingActions,
      stageRatings,
      journey: primary ? [{ stage: "intake", enteredAt: iso(primary.openedAt) }, ...(primary.doc.stage !== "intake" ? [{ stage: String(primary.doc.stage), enteredAt: String(primary.doc.stageEnteredAt) }] : [])] : [],
      consultations: [],
      conversations: [],
      deadlines: {},
      createdAt: iso(mem.activatedAt - 10 * MIN),
      updatedAt: iso(NOW - rng.int(1, 96) * HOUR),
      ...(mem.id === aliasClientId ? { placeholderAlias: true } : {}),
      placeholderMeta: { ...mem.situation },
    };
    clients.push(add(COLLECTIONS.clients, client));
  }

  // ── Tasks the daily sweep would raise (same pure rules as jobs/taskRuleSweep.ts) ──
  const sweep = [
    ...renewalEvents(members.map((m) => m.membership), now),
    ...unansweredQuoteEvents(clients, now),
    ...missingDocumentEvents(clients, now),
  ];
  for (const [name, payload] of sweep) {
    rng.reseed("sweep", name, String(payload.sourceId ?? payload.clientId));
    const rule = TASK_RULES[name];
    let eventAt = NOW - rng.int(1, 30) * HOUR;
    if (name === "quote.unanswered_5d") {
      const q = (clients.find((c) => c.id === payload.clientId)?.quotes as Doc[]).find((x) => x.id === payload.sourceId);
      eventAt = Date.parse(String(q?.sentAt)) + 5 * DAY;
    }
    if (name === "document.missing_3d") {
      const pa = (clients.find((c) => c.id === payload.clientId)?.pendingActions as Doc[]).find((x) => x.id === payload.sourceId);
      eventAt = Date.parse(String(pa?.dueAt)) + 3 * DAY;
    }
    if (eventAt + rule.dueInHours * HOUR < NOW - 6 * DAY) eventAt = NOW - rng.int(1, 5) * DAY; // keep the queue current
    mkTask(name, payload, eventAt, "open");
  }
  // One Meet-link failure that the CSM handled.
  const failed = consultations.find((c) => c.status === "completed" && Date.parse(String(c.scheduledAt)) < NOW - 10 * DAY);
  if (failed) {
    const t = mkTask("call.link_failed", { clientId: String(failed.clientId), sourceId: String(failed.id), dedupeKey: `${failed.id}_${failed.scheduledAt}`, detail: "calendar invite failed" },
      Date.parse(String(failed.createdAt)), "done", "Sent the Meet link to the member and the lawyer by email.");
    if (t) failed.calendarError = null;
  }
  // Manual tasks (source "manual"), and every status incl. cancelled and overdue.
  rng.reseed("task-cover");
  {
    const a = members[0];
    const b = members[Math.min(ROLE.missingDoc, members.length - 1)];
    const manual: Array<CsmTask & Doc> = [
      { id: `${PLACEHOLDER_PREFIX}task_manual_001`, clientId: a.id, ownerEmail: a.csm, type: "follow_up", title: "Call back about the spouse's residency question", dueAt: iso(NOW + DAY), status: "open", source: { kind: "manual" }, createdAt: iso(NOW - 2 * HOUR) },
      { id: `${PLACEHOLDER_PREFIX}task_manual_002`, clientId: b.id, ownerEmail: b.csm, type: "follow_up", title: "Send the Spanish glossary of registry terms", dueAt: iso(NOW - 8 * DAY), status: "done", outcome: "Sent by email; member said it helped.", source: { kind: "manual" }, createdAt: iso(NOW - 10 * DAY), closedAt: iso(NOW - 9 * DAY) },
      { id: `${PLACEHOLDER_PREFIX}task_manual_003`, clientId: b.id, ownerEmail: b.csm, type: "follow_up", title: "Chase the bank letter", dueAt: iso(NOW - 2 * DAY), status: "open", source: { kind: "manual" }, createdAt: iso(NOW - 5 * DAY) },
    ];
    for (const t of manual) tasks.set(t.id, t);
    const list = [...tasks.values()];
    if (!list.some((t) => t.status === "cancelled")) {
      const t = list.find((x) => x.status === "done" && x.type === "follow_up");
      if (t) {
        t.status = "cancelled";
        delete t.outcome;
      }
    }
  }
  for (const t of [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) add(COLLECTIONS.csmTasks, t);

  // ── Audit log (logins and key actions) ──
  let audN = 0;
  const audit = (actor: { uid: string; email: string; role: string }, action: string, target: string, t: number, meta: Doc = {}) => {
    if (t > NOW) return;
    add(COLLECTIONS.auditLog, { id: `${PLACEHOLDER_PREFIX}aud_${pad(++audN, 6)}`, actor, action, target, meta, at: iso(t) });
  };
  for (const mem of members) {
    rng.reseed("members-11", mem.i);
    const actor = { uid: mem.id, email: mem.email, role: "client" };
    audit({ uid: "system", email: "system", role: "system" }, mem.status === "pending" ? "membership.join_started" : "membership.activated", `memberships/${mem.membership.id}`, mem.activatedAt, { paymentRef: "manual" });
    const logins = Math.min(8, 1 + Math.round(((mem.cancelAt ?? NOW) - mem.activatedAt) / (12 * DAY)));
    for (let k = 0; k < logins; k++) {
      audit(actor, "auth.login", `client:${mem.email}`, mem.activatedAt + Math.round(rng.next() * ((mem.cancelAt ?? NOW) - mem.activatedAt)), { portal: "client", via: k === 0 ? "join" : "otp" });
    }
  }
  for (const d of collections.member_documents ?? []) {
    const byStaff = staff.some((s) => s.email === d.uploadedBy);
    audit({ uid: String(d.uploadedBy), email: String(d.uploadedBy), role: byStaff ? "staff" : "client" }, "document.upload", `clients/${d.clientId}`, Date.parse(String(d.uploadedAt)), { docId: d.id, category: d.category });
  }
  for (const h of handoffs) {
    rng.reseed("hof-audit", String(h.id));
    const l = lawyerById.get(String(h.providerId))!;
    audit({ uid: l.id, email: l.email, role: "lawyer" }, "handoff.created", `handoffs/${h.id}`, Date.parse(String(h.approvedAt)), { consultationId: h.consultationId });
  }
  for (const t of tasks.values()) {
    if (t.status === "done" && t.closedAt) audit({ uid: String(t.ownerEmail), email: String(t.ownerEmail), role: "csm" }, "csm_task.closed", `csm_tasks/${t.id}`, Date.parse(t.closedAt), { type: t.type });
  }
  for (const s of staff) {
    rng.reseed("staff", s.email);
    for (let d = Math.min(cfg.windowDays, 120); d >= 0; d -= rng.int(1, 3)) {
      audit({ uid: s.email, email: s.email, role: s.role }, "auth.login", `staff:${s.email}`, crAt(today0 - d * DAY, rng.int(7, 10), rng.int(0, 59)), { portal: "staff" });
    }
  }
  for (const l of lawyers) {
    rng.reseed("lawyer-login", l.id);
    for (let d = Math.min(cfg.windowDays, 120); d >= 0; d -= rng.int(3, 8)) {
      audit({ uid: l.id, email: l.email, role: "lawyer" }, "auth.login", `lawyer:${l.email}`, crAt(today0 - d * DAY, rng.int(7, 9), rng.int(0, 59)), { portal: "lawyer" });
    }
  }

  // ── Subcollections: legacy pricing requests and lawyer RFQs on a few members ──
  const subcollections: SeedData["subcollections"] = [];
  const rfqMembers = members.filter((m) => (quotesBy.get(m.id) ?? []).length).slice(0, opts.size === "demo" ? 2 : 4);
  rfqMembers.forEach((mem, k) => {
    const q = quotesBy.get(mem.id)![0];
    const lawyer = lawyerById.get((q.providerIds as string[])[0])!;
    const created = Date.parse(String(q.createdAt)) - 2 * DAY;
    subcollections.push({
      path: `clients/${mem.id}/pricing_requests`,
      docs: [{
        id: `${PLACEHOLDER_PREFIX}prq_${pad(k + 1, 2)}`, requestId: `${PLACEHOLDER_PREFIX}prq_${pad(k + 1, 2)}`, clientId: mem.id, index: 1,
        originLabel: `${mem.loc.place}, Costa Rica`, destinationLabel: "", originNotes: "", destinationNotes: "",
        options: [{ optionId: `${PLACEHOLDER_PREFIX}opt_${k + 1}`, index: 1, serviceType: String(q.legalArea), serviceLine: String(q.title), items: (q.lineItems as Doc[]).map((l) => String(l.label)) }],
        status: "sent", createdAt: iso(created), createdBy: mem.csm, sentAt: iso(created + 3 * HOUR), sentBy: mem.csm, updatedAt: iso(created + 3 * HOUR), ...stamp,
      }],
    });
    subcollections.push({
      path: `clients/${mem.id}/quoteRequests`,
      docs: [{
        id: `${PLACEHOLDER_PREFIX}rfq_${pad(k + 1, 2)}`, requestId: `${PLACEHOLDER_PREFIX}rfq_${pad(k + 1, 2)}`,
        providerId: lawyer.id, providerName: lawyer.name, providerEmail: lawyer.email,
        status: "responded", sentAt: iso(created + 3 * HOUR), expiresAt: iso(created + 7 * DAY),
        providerResponse: { price: Number(q.costSubtotal), currency: "USD", timeline: "3-6 weeks", notes: "Includes registry fees estimate; government taxes separate.", respondedAt: iso(created + DAY) },
        operatorOverride: null, reviewedAt: iso(created + 30 * HOUR), reviewedBy: mem.csm, ...stamp,
      }],
    });
  });

  // ── Config / catalog entries (written only where the collection is empty, see SEED.md) ──
  // Account seed: the staff account's queue holds every task type (open, overdue and due
  // today), and it owns most opportunities (every fifth stays with a colleague).
  if (opts.focus) {
    const me = csmPool[0].email;
    const tasks = collections[COLLECTIONS.csmTasks] ?? [];
    const TYPES: CsmTask["type"][] = ["onboarding", "follow_up", "missing_document", "proposal", "renewal", "escalation", "privacy"];
    for (const type of TYPES) {
      if (tasks.some((t) => t.status === "open" && t.ownerEmail === me && t.type === type)) continue;
      const t = tasks.find((x) => x.status === "open" && x.type === type);
      if (t) t.ownerEmail = me;
    }
    (collections[COLLECTIONS.opportunities] ?? []).forEach((o, k) => {
      if (k % 5 !== 4) o.ownerEmail = me;
    });
  }

  const cfgAt = iso(NOW - (cfg.windowDays + 20) * DAY);
  const config: Record<string, Doc[]> = {
    quote_service_types: [
      ["residency", "Residency filing", "🛂"], ["closing", "Property closing", "🏠"], ["corporate", "Corporate upkeep", "🏢"],
      ["tax", "Tax filing", "🧾"], ["vehicle", "Vehicle paperwork", "🚗"], ["estate", "Wills and estates", "📜"],
    ].map(([k, label, icon]) => ({ id: `${PLACEHOLDER_PREFIX}svc_${k}`, serviceTypeId: `${PLACEHOLDER_PREFIX}svc_${k}`, label, icon, createdBy: admin.email, createdAt: cfgAt, updatedAt: null })),
    quote_labels: [["fees", "Lawyer fees"], ["gov", "Government fees"], ["translation", "Translations"], ["optional", "Optional extras"]]
      .map(([k, label]) => ({ id: `${PLACEHOLDER_PREFIX}lbl_${k}`, labelId: `${PLACEHOLDER_PREFIX}lbl_${k}`, label, icon: null, createdBy: admin.email, createdAt: cfgAt, updatedAt: null })),
    quote_line_templates: Object.entries(SCRIPTS).flatMap(([area, list]) => list.filter((s) => s.opportunity).slice(0, 1).map((s) => ({
      id: `${PLACEHOLDER_PREFIX}qlt_${area}`, templateId: `${PLACEHOLDER_PREFIX}qlt_${area}`,
      name: s.opportunity!.title.replace(/\{loc\}/g, "Costa Rica"), description: `Standard lines for ${area.replace("_", " ")} work.`,
      currency: "USD", lines: s.opportunity!.lines, isDefault: false, createdBy: admin.email, createdAt: cfgAt, updatedAt: null,
    }))),
    quote_templates: [
      { id: `${PLACEHOLDER_PREFIX}qt_standard`, templateId: `${PLACEHOLDER_PREFIX}qt_standard`, name: "Standard legal work proposal", description: "Scope, fees, timeline and acceptance.", category: "general",
        blocks: [{ id: "intro", type: "html", html: "<p>Thank you for trusting ILP. This proposal describes the work your lawyer will do.</p>", data: null }, { id: "accept", type: "accept", html: null, data: null }],
        jurisdictions: ["Costa Rica"], legalAreas: ["corporate", "real_estate", "immigration"], createdBy: admin.email, createdAt: cfgAt, updatedAt: null },
    ],
    vendors: [
      ["Traducciones Oficiales PH", "Ana Brenes", "translations", ["other"]], ["Topografía del Pacífico PH", "Luis Mena", "surveys", ["real_estate"]],
      ["Agencia Aduanal PH", "Carlos Rojas", "customs", ["other"]], ["Notaría Express PH", "Paula Soto", "notary", ["notary"]],
    ].map(([company, contact, k, areas]) => ({
      id: `${PLACEHOLDER_PREFIX}ven_${k}`, companyName: company, contactName: contact, email: `${k}.vendor@example.com`, phone: `+1 202 555 01${pad(40 + String(k).length, 2)}`,
      legalAreas: areas, jurisdictions: ["CR"], languages: ["es", "en"], notes: "Placeholder vendor (seed data).", active: true, createdAt: cfgAt, updatedAt: cfgAt,
    })),
    posts: [
      { id: `${PLACEHOLDER_PREFIX}post_marchamo`, title: "Marchamo season: what foreign owners should check", slug: "ph-marchamo-season-checklist", kind: "article", status: "draft", author: admin.name, bodyHtml: "<p>Draft (placeholder). The marchamo is usually paid between November and December 31…</p>", createdAt: cfgAt, updatedAt: cfgAt },
      { id: `${PLACEHOLDER_PREFIX}post_rtbf`, title: "The RTBF beneficial-owner filing in plain English", slug: "ph-rtbf-plain-english", kind: "article", status: "draft", author: admin.name, bodyHtml: "<p>Draft (placeholder). Most Costa Rican companies file each April…</p>", createdAt: cfgAt, updatedAt: cfgAt },
    ],
    updates: [
      { id: `${PLACEHOLDER_PREFIX}upd_ccss`, title: "CCSS minimum contribution update (placeholder)", country: "CR", status: "draft", author: admin.email, version: 1, source: "Placeholder", body: "Draft placeholder update for the staff review queue.", createdAt: cfgAt },
    ],
  };
  for (const list of Object.values(config)) for (const d of list) Object.assign(d, stamp);

  return { batch, now: now.toISOString(), aliasClientId, collections, config, subcollections, files };
}

/** Counts per collection (business data, config, subcollections). */
export function countDocs(data: SeedData): Array<[string, number]> {
  const rows: Array<[string, number]> = Object.entries(data.collections).map(([k, v]) => [k, v.length]);
  for (const [k, v] of Object.entries(data.config)) rows.push([`${k} (config)`, v.length]);
  const subs = new Map<string, number>();
  for (const s of data.subcollections) {
    const key = `clients/*/${s.path.split("/").pop()}`;
    subs.set(key, (subs.get(key) ?? 0) + s.docs.length);
  }
  for (const [k, v] of subs) rows.push([k, v]);
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Counts per diversity / lifecycle category (dry-run "diversity report" and tests). */
export function diversityReport(data: SeedData): Array<[string, Record<string, number>]> {
  const C = data.collections;
  const tally = (list: Doc[] | undefined, key: (d: Doc) => unknown | unknown[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const d of list ?? []) {
      const v = key(d);
      for (const x of Array.isArray(v) ? v : [v]) {
        if (x === undefined || x === null || x === "") continue;
        out[String(x)] = (out[String(x)] ?? 0) + 1;
      }
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  };
  const meta = (d: Doc) => (d.placeholderMeta ?? {}) as Record<string, unknown>;
  const ageBucket = (d: Doc) => {
    const a = Number(meta(d).age);
    return Number.isFinite(a) && a > 0 ? `${Math.floor(a / 10) * 10}s` : "not given";
  };
  const nameShape = (d: Doc) => {
    const n = `${d.name ?? ""} ${d.surname ?? ""}`.trim();
    const tags: string[] = [];
    if (!String(d.surname ?? "")) tags.push("single name");
    if (n.length >= 30) tags.push("very long");
    if (n.length <= 6) tags.push("very short");
    if (/[^\x00-\x7F]/.test(n)) tags.push("diacritics");
    if (n.includes("'")) tags.push("apostrophe");
    if (/-/.test(n)) tags.push("hyphen");
    if (String(d.surname ?? "").trim().split(/\s+/).length > 1) tags.push("multi-part surname");
    return tags.length ? tags : ["plain"];
  };
  const clients = C.clients;
  return [
    ["background", tally(clients, (d) => meta(d).background)],
    ["name shape", tally(clients, nameShape)],
    ["nationality (incl. second)", tally(clients, (d) => meta(d).nationalities as string[])],
    ["dual citizens", tally(clients, (d) => ((meta(d).nationalities as string[]).length > 1 ? "dual" : "single"))],
    ["preferred language", tally(clients, (d) => meta(d).language)],
    ["pronouns", tally(clients, (d) => d.pronouns ?? "not stated")],
    ["age", tally(clients, ageBucket)],
    ["accessibility notes", tally(clients, (d) => (d.accessibilityNotes ? "yes" : "none"))],
    ["household", tally(clients, (d) => meta(d).household)],
    ["household extras", tally(clients, (d) => [d.dependents ? "dependents" : null, d.adultChildrenAbroad ? "adult children abroad" : null, d.elderlyParentInCare ? "elderly parent in care" : null, Array.isArray(d.pets) && d.pets.length ? "pets" : null])],
    ["residency", tally(clients, (d) => meta(d).residency)],
    ["property", tally(clients, (d) => meta(d).property)],
    ["company", tally(clients, (d) => meta(d).company)],
    ["vehicle", tally(clients, (d) => meta(d).vehicle)],
    ["employees", tally(clients, (d) => meta(d).employees)],
    ["province (where they live or own)", tally(clients, (d) => meta(d).province)],
    ["membership status", tally(C.memberships, (d) => (d.cancelAtPeriodEnd && d.status === "active" ? "active (cancel at period end)" : d.status))],
    ["matter area", tally(C.matters, (d) => d.area)],
    ["matter stage", tally(C.matters, (d) => d.stage)],
    ["next step owner", tally(C.matters, (d) => (d.nextStep as Doc | undefined)?.who)],
    ["consultation status", tally(C.consultations, (d) => d.status)],
    ["recording consent", tally(C.consultations, (d) => (d.consent as Doc).recording)],
    ["summary", tally(C.consultations, (d) => (d.summary as Doc | undefined)?.status)],
    ["opportunity stage", tally(C.opportunities, (d) => d.stage)],
    ["opportunity source", tally(C.opportunities, (d) => (d.source as Doc).kind)],
    ["quote status (stored)", tally(clients, (d) => ((d.quotes as Doc[]) ?? []).map((q) => q.status))],
    ["charge status", tally(clients, (d) => ((d.charges as Doc[]) ?? []).map((c) => c.status))],
    ["csm task type", tally(C.csm_tasks, (d) => d.type)],
    ["csm task status", tally(C.csm_tasks, (d) => (d.status === "open" && String(d.dueAt) < data.now ? "open (overdue)" : d.status))],
    ["csm task source", tally(C.csm_tasks, (d) => (d.source as Doc).kind)],
    ["csm task owner", tally(C.csm_tasks.filter((t) => t.status === "open"), (d) => d.ownerEmail)],
    ["obligation status", tally(C.obligations, (d) => d.status)],
    ["privacy request", tally(C.privacy_requests, (d) => `${d.kind} / ${d.status}`)],
    ["feedback", tally(C.member_feedback, (d) => (d.kind === "cancel" ? "cancel" : `${d.kind} ${d.score}`))],
    ["consent kind", tally(C.consents, (d) => `${d.kind} ${d.granted ? "granted" : "declined"}`)],
    ["funnel step", tally(C.funnel_events, (d) => d.step)],
  ];
}

/** Ready-share of active members (for the summary and tests). */
export function readyShare(data: SeedData): number {
  const active = new Set((data.collections.memberships ?? []).filter((m) => m.status === "active").map((m) => m.clientId));
  const list = (data.collections.clients ?? []).filter((c) => active.has(c.id));
  return list.filter((c) => profileCompleteness(c).consultationReady).length / Math.max(1, list.length);
}
