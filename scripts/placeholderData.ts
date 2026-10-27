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
} from "../schemas/contracts.ts";
import { buildTask, type EventPayload } from "../API/members/events.ts";
import { opportunityFromHandoff } from "../API/opportunities/logic.ts";
import { type CheckAnswers, evaluateCheck } from "../API/leads/deadlineCheck.ts";
import { lineClientPrice } from "../API/dashboard/quotePricing.ts";
import { LEGAL_VERSIONS } from "../API/privacy/policy.ts";
import { CANCEL_REASONS } from "../API/payments/cancel.ts";
import { missingDocumentEvents, renewalEvents, unansweredQuoteEvents } from "../jobs/taskRuleSweep.ts";
import { PLACEHOLDER_PREFIX } from "../helper/placeholder.ts";

export type Doc = Record<string, unknown>;
export type SeedSize = "demo" | "pilot" | "large";

export const SIZES: Record<SeedSize, { members: number; lawyers: number; staff: number; windowDays: number; leadsPerCheckMember: number }> = {
  demo: { members: 15, lawyers: 3, staff: 2, windowDays: 120, leadsPerCheckMember: 6 },
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

const FIRST = [
  "Robert", "Linda", "James", "Patricia", "Michael", "Barbara", "David", "Susan", "Richard", "Karen",
  "Thomas", "Nancy", "Mark", "Deborah", "Steven", "Carol", "Paul", "Sandra", "Kenneth", "Donna",
  "Brian", "Sharon", "Gary", "Cynthia", "Jeffrey", "Kathleen", "Scott", "Diane", "Gregory", "Janet",
  "Douglas", "Laurie", "Randall", "Brenda", "Wayne", "Teresa", "Dennis", "Heather", "Craig", "Melissa",
  "Todd", "Amy", "Bruce", "Lori", "Keith", "Rachel", "Derek", "Megan", "Trevor", "Colleen",
  "Priya", "Wei", "Andre", "Marisol", "Kenji", "Aisha", "Glenn", "Marjorie", "Russell", "Yvonne",
] as const;
const LAST = [
  "Whitaker", "Lindqvist", "Hollis", "Brennan", "Kowalski", "Delgado", "Fairbanks", "Thornton", "McAllister", "Pruitt",
  "Gallagher", "Okafor", "Haverford", "Castellano", "Brandt", "Ellison", "Rasmussen", "Van Dorn", "Chandler", "Petrakis",
  "Abernathy", "Sorensen", "Yamada", "Kessler", "Holloway", "Prescott", "Dempsey", "Langford", "Whitcomb", "Marchetti",
  "Byrne", "Lachance", "Tremblay", "Bouchard", "Gagnon", "Fitzgerald", "Rinaldi", "Stroud", "Ashby", "Calloway",
  "Mercer", "Quinlan", "Halvorsen", "Pendleton", "Ostrowski", "Delacroix", "Winslow", "Garrity", "Lundgren", "Beaumont",
] as const;
/** Combinations that could read as a public figure; never generated. */
const BLOCKED_NAMES = new Set([
  "Michael Thornton", "Paul Ellison", "James Holloway", "Mark Kessler", "David Brennan", "Robert Mercer",
  "Thomas Kessler", "Steven Rinaldi", "Gary Gallagher", "Kenneth Fairbanks", "Richard Gagnon",
]);

const US_AREA = ["503", "612", "415", "512", "720", "206", "305", "216", "919", "480", "602", "828", "941", "571"] as const;
const CA_AREA = ["604", "416", "647", "902", "403", "613", "250"] as const;

export const LOCATIONS = [
  { place: "Nosara", province: "Guanacaste" },
  { place: "Tamarindo", province: "Guanacaste" },
  { place: "Playas del Coco", province: "Guanacaste" },
  { place: "Escazú", province: "San José" },
  { place: "Santa Ana", province: "San José" },
  { place: "San José", province: "San José" },
  { place: "Atenas", province: "Alajuela" },
  { place: "Grecia", province: "Alajuela" },
  { place: "Heredia", province: "Heredia" },
  { place: "Puerto Viejo", province: "Limón" },
  { place: "Dominical", province: "Puntarenas" },
  { place: "Ojochal", province: "Puntarenas" },
  { place: "Jacó", province: "Puntarenas" },
] as const;
type Loc = (typeof LOCATIONS)[number];

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
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
const dollars = (n: number) => Math.round(n * 100) / 100;

/** Fake Meet link in Google's xxx-xxxx-xxx shape, stable per id. */
export function meetUrlFor(id: string): string {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const letters = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + ((h >>> (i % 4) * 8) + i * 7) % 26)).join("");
  return `https://meet.google.com/${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

type Persona = "retiree" | "remote" | "owner" | "business" | "applicant";
const PERSONAS: Array<[Persona, number]> = [["retiree", 30], ["remote", 20], ["owner", 20], ["business", 15], ["applicant", 15]];
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

  const lawyers = LAWYERS.slice(0, cfg.lawyers).map((l, i) => {
    const id = `${PLACEHOLDER_PREFIX}prov_${pad(i + 1, 2)}`;
    const email = i === 0 && opts.lawyerEmail
      ? opts.lawyerEmail.toLowerCase().trim()
      : `${slug(l.first)}.${slug(l.last.split(" ")[0])}@example.com`;
    return { ...l, id, email, name: `${l.first} ${l.last}`, load: 0 };
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
      jurisdictions: ["Costa Rica"],
      languages: ["es", "en"],
      credentials: `Colegio de Abogados y Abogadas de Costa Rica, carné PH-${pad(20000 + i * 37, 5)} (placeholder)`,
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
    });
    const morning = rng.pick([["08:00", "12:00"], ["08:30", "12:00"], ["09:00", "12:30"]] as const);
    const afternoon = rng.pick([["13:30", "16:30"], ["14:00", "17:00"], ["13:00", "16:00"]] as const);
    const days: Array<0 | 1 | 2 | 3 | 4 | 5 | 6> = i % 3 === 2 ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
    add(COLLECTIONS.availability, {
      id: l.id,
      providerId: l.id,
      timezone: "America/Costa_Rica",
      weekly: days.flatMap((day) => [
        { day, start: morning[0], end: morning[1] },
        ...(i % 2 === 0 || day !== 5 ? [{ day, start: afternoon[0], end: afternoon[1] }] : []),
      ]),
      blackoutDates: [`${new Date(NOW).getUTCFullYear()}-12-24`, `${new Date(NOW).getUTCFullYear()}-12-25`, `${new Date(NOW).getUTCFullYear() + 1}-01-01`],
      minLeadHours: [18, 24, 18, 12][i % 4],
      maxCallsPerDay: [6, 5, 4, 6][i % 4],
      specialties: [...l.areas],
      calendarId: null,
      updatedAt: iso(NOW - rng.int(2, 60) * DAY),
    });
  }
  const lawyerFor = (area: Area): (typeof lawyers)[number] => {
    const cands = lawyers.filter((l) => l.areas.includes(area));
    const pool = cands.length ? cands : lawyers;
    const min = Math.min(...pool.map((l) => l.load));
    const best = pool.filter((l) => l.load === min);
    const l = rng.pick(best);
    l.load++;
    return l;
  };
  const lawyerById = new Map(lawyers.map((l) => [l.id, l]));

  // ── Members ──
  const used = new Set<string>();
  const members: Member[] = [];
  const pendingIdx = new Set(cfg.members >= 30 ? [cfg.members - 1, cfg.members - 2] : [cfg.members - 1]);
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
  for (let i = 0; i < cfg.members; i++) {
    rng.reseed("member", i);
    let first = "";
    let last = "";
    for (let t = 0; t < 200; t++) {
      first = rng.pick(FIRST);
      last = rng.pick(LAST);
      const full = `${first} ${last}`;
      if (!used.has(full) && !BLOCKED_NAMES.has(full)) break;
    }
    used.add(`${first} ${last}`);
    const alias = i === 0 && !!opts.memberEmail;
    const email = alias ? opts.memberEmail!.toLowerCase().trim() : `${slug(first)}.${slug(last)}@example.com`;
    const id = alias ? email.replace(/[@.]/g, "_") : `${PLACEHOLDER_PREFIX}cli_${pad(i + 1)}`;
    const ca = rng.chance(0.2);
    const phone = `+1 ${rng.pick(ca ? CA_AREA : US_AREA)} 555 01${pad(i % 100, 2)}`;
    const persona = i === 0 ? "owner" : rng.weighted(PERSONAS);
    const loc = rng.pick(LOCATIONS);

    // Join date: more recent joins (growth); a few fixed ones keep the demo lively.
    let joinedDaysAgo = cfg.windowDays * (1 - Math.sqrt(rng.next()));
    if (i === 0) joinedDaysAgo = Math.min(48, cfg.windowDays - 5);
    if (i === 1) joinedDaysAgo = 1.2;
    if (i === 2) joinedDaysAgo = 0.3;
    if (i === 3) joinedDaysAgo = Math.min(cfg.windowDays - 2, 150);
    if (pendingIdx.has(i)) joinedDaysAgo = rng.int(1, 3) - 0.5;
    joinedDaysAgo = Math.max(0.25, Math.min(cfg.windowDays, joinedDaysAgo));
    const activatedAt = NOW - Math.round(joinedDaysAgo * DAY);

    // Profile
    const retiree = persona === "retiree";
    const age = retiree ? rng.int(60, 75) : persona === "remote" ? rng.int(40, 52) : rng.int(45, 70);
    const dob = `${new Date(NOW).getUTCFullYear() - age}-${pad(rng.int(1, 12), 2)}-${pad(rng.int(1, 28), 2)}`;
    const residencyStatus = persona === "retiree" ? rng.weighted([["pensionado", 70], ["rentista", 15], ["permanent", 15]] as const)
      : persona === "remote" ? rng.weighted([["digital_nomad", 70], ["tourist", 30]] as const)
      : persona === "applicant" ? rng.weighted([["applying", 70], ["rentista", 15], ["inversionista", 15]] as const)
      : rng.weighted([["tourist", 50], ["inversionista", 25], ["permanent", 25]] as const);
    const resident = ["pensionado", "rentista", "permanent", "inversionista"].includes(residencyStatus);
    const ownsProperty = persona === "owner" || persona === "business" || (persona === "retiree" ? rng.chance(0.6) : rng.chance(0.25));
    const company = persona === "business" ? rng.pick(["S.A.", "S.R.L."] as const)
      : persona === "owner" ? (rng.chance(0.55) ? "S.A." : null)
      : rng.chance(0.15) ? "S.A." : null;
    const ownsVehicle = persona === "remote" ? rng.chance(0.35) : rng.chance(0.6);
    const hasEmployees = (persona === "owner" || persona === "business") ? rng.chance(0.45) : rng.chance(0.15);
    const residencyExpiresAt = resident ? ymd(NOW + rng.int(45, 700) * DAY) : undefined;
    const profile: Doc = {
      fullName: `${first} ${last}`,
      email,
      phone,
      nationality: ca ? "CA" : "US",
      dateOfBirth: dob,
      maritalStatus: rng.weighted([["married", 55], ["single", 15], ["divorced", 15], ["widowed", 10], ["partnered", 5]] as const),
      dependents: rng.weighted([[0, 70], [1, 15], [2, 15]] as const),
      residencyStatus,
      ...(residencyExpiresAt ? { residencyExpiresAt } : {}),
      ...(resident ? { dimexNumber: `PH-DIMEX-${pad(rng.int(100000, 999999), 6)}` } : {}),
      ownsProperty,
      ...(ownsProperty ? { propertyLocation: `${loc.place}, ${loc.province}` } : {}),
      hasCompany: !!company,
      ...(company ? { companyType: company, companyId: `PH-3-10${company === "S.A." ? 1 : 2}-${pad(rng.int(100000, 999999), 6)}` } : {}),
      ownsVehicle,
      hasEmployees,
    };
    // Recent joiners (and a few others) have not finished their profile yet.
    if (joinedDaysAgo < 7 || rng.chance(0.08)) {
      for (const k of rng.shuffle(["dateOfBirth", "maritalStatus", "dependents", "residencyStatus", "phone", "ownsVehicle"]).slice(0, rng.int(3, 5))) {
        delete profile[k];
      }
    }
    const answers: CheckAnswers = {
      country: "CR",
      residencyStatus: resident ? "resident" : residencyStatus === "applying" ? "applying" : "visitor",
      ...(resident && residencyExpiresAt ? { residencyExpiresAt } : {}),
      ...(!resident && residencyStatus !== "applying" ? { lastEntryDate: ymd(activatedAt - rng.int(15, 150) * DAY) } : {}),
      ownsProperty,
      ...(ownsProperty ? { propertyLocation: loc.province } : {}),
      companyType: company === "S.A." ? "SA" : company === "S.R.L." ? "SRL" : "none",
      hasCompany: !!company,
      ownsVehicle,
      hasEmployees,
    };

    // Membership status
    let status: Membership["status"] = "active";
    let cancelAt: number | undefined;
    const monthsIn = Math.floor(joinedDaysAgo / 30.4);
    if (pendingIdx.has(i)) status = "pending";
    else if (i > 3 && monthsIn >= 2 && churnNow(joinedDaysAgo)) {
      status = "cancelled";
      cancelAt = addMonths(activatedAt, rng.int(1, monthsIn - 1));
    } else if (i > 3 && monthsIn >= 1 && rng.chance(0.07)) status = "past_due";

    const periods: number[] = [];
    for (let p = activatedAt; p <= NOW; p = addMonths(p, 1)) periods.push(p);
    let periodStart: number;
    let periodEnd: number;
    const m: Membership & Doc = {
      id: `${PLACEHOLDER_PREFIX}mem_${pad(i + 1)}`,
      clientId: id,
      plan: PLAN_STANDARD.id,
      status,
      country: "CR",
      periodStart: "",
      periodEnd: "",
      minutesIncluded: PLAN_STANDARD.minutesIncluded,
      minutesUsed: 0,
      callsIncluded: PLAN_STANDARD.callsIncluded,
      callsUsed: 0,
      csmEmail: csms[i % csms.length].email,
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
      if (i > 3 && monthsIn >= 1 && rng.chance(0.05)) {
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
    if (status !== "pending") {
      m.activatedAt = iso(activatedAt);
      m.activationPaidAt = iso(activatedAt);
    }
    const member: Member = {
      i, id, first, last, email, phone, persona, loc, profile, answers,
      csm: m.csmEmail as string,
      status, activatedAt, periods, membership: m, cancelAt,
      aiConsent: rng.chance(0.65),
    };
    if (status !== "pending" && rng.chance(0.04)) member.recordingWithdrawnAt = activatedAt + rng.int(3, 20) * DAY;
    members.push(member);
  }
  const aliasClientId = opts.memberEmail ? members[0].id : null;
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
    const findings = evaluateCheck(answers, new Date(createdAt)).map(({ ruleId, title, dueAt, area }) => ({ ruleId, title, dueAt, area }));
    return add(COLLECTIONS.leads, {
      id,
      email,
      ...(name ? { name } : {}),
      country: "CR" as const,
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
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const createdAt = NOW - Math.round(cfg.windowDays * (1 - Math.sqrt(rng.next())) * DAY);
    const owns = rng.chance(0.5);
    const company = rng.weighted([["SA", 25], ["SRL", 10], ["none", 55], ["unsure", 10]] as const);
    const res = rng.weighted([["resident", 30], ["applying", 20], ["visitor", 40], ["unsure", 10]] as const);
    const answers: CheckAnswers = {
      country: "CR",
      residencyStatus: res,
      ...(res === "resident" ? { residencyExpiresAt: ymd(createdAt + rng.int(30, 600) * DAY) } : {}),
      ...(res === "visitor" ? { lastEntryDate: ymd(createdAt - rng.int(5, 170) * DAY) } : {}),
      ownsProperty: owns,
      ...(owns ? { propertyLocation: rng.pick(LOCATIONS).province } : {}),
      companyType: company,
      ...(company === "SA" || company === "SRL" ? { hasCompany: true } : company === "none" ? { hasCompany: false } : {}),
      ownsVehicle: rng.chance(0.5),
      hasEmployees: rng.chance(0.2),
    };
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
    const n = mem.i === 0 ? 2 : rng.weighted([[1, 55], [2, 35], [3, 10]] as const);
    const areas = PERSONA_AREAS[mem.persona];
    const recs: MatterRec[] = [];
    const usedTitles = new Set<string>();
    const end = mem.cancelAt ?? NOW;
    for (let j = 0; j < n; j++) {
      const area: Area = j === 0 ? (rng.chance(0.7) ? areas[0] : areas[1]) : rng.pick(areas);
      const options = SCRIPTS[area].filter((s) => !usedTitles.has(s.title));
      const script = rng.pick(options.length ? options : SCRIPTS[area]);
      usedTitles.add(script.title);
      const openedAt = j === 0 ? mem.activatedAt + rng.int(1, 30) * HOUR : mem.activatedAt + Math.round(rng.next() * (end - mem.activatedAt));
      if (openedAt > NOW) continue;
      const lawyer = lawyerFor(area);
      const commercial = !!script.opportunity && rng.chance(0.5);
      const vars = { loc: mem.loc.place, L: lawyer.first, M: mem.first };
      const id = `${PLACEHOLDER_PREFIX}mat_${pad(mem.i + 1)}_${j + 1}`;
      const doc: Doc = {
        id,
        clientId: mem.id,
        title: fill(script.title, vars),
        area,
        country: "CR",
        stage: "intake",
        stageEnteredAt: iso(openedAt),
        assignedProviderId: lawyer.id,
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
  const makeCon = (mem: Member, rec: MatterRec, t: number, status: "completed" | "no_show" | "cancelled" | "booked", today = false): Doc => {
    const n = (conCount.get(mem.id) ?? 0) + 1;
    conCount.set(mem.id, n);
    const id = `${PLACEHOLDER_PREFIX}con_${pad(mem.i + 1)}_${pad(n, 2)}`;
    const lawyer = lawyerById.get(String(rec.doc.assignedProviderId))!;
    const scheduled = takeSlot(lawyer.id, t);
    const vars = { loc: mem.loc.place, L: lawyer.first, M: mem.first };
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
      const ended = scheduled + rng.pick([20, 20, 20, 18, 15]) * MIN;
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
    if (!recs.length) continue;
    mem.periods.forEach((start, p) => {
      const end = Math.min(addMonths(start, 1), NOW - 3 * HOUR, mem.cancelAt ?? Infinity);
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
  const activeMembers = members.filter((m) => m.status === "active" && (mattersBy.get(m.id)?.length ?? 0) > 0);
  const todayUsed = new Set<string>();
  const todayHours = [8, 9, 10, 11, 13, 14, 15, 16];
  for (const [li, l] of lawyers.entries()) {
    rng.reseed("today", li);
    const want = li === 0 ? 3 : 2;
    const mine = rng.shuffle(activeMembers.filter((m) => !todayUsed.has(m.id) && (mattersBy.get(m.id) ?? []).some((r) => r.doc.assignedProviderId === l.id && !r.doc.closedAt)));
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
    if (!(mem.id === aliasClientId || mem.i === 0 || rng.chance(0.35))) continue;
    const t = bizTime(NOW + 3 * HOUR, Math.min(NOW + 14 * DAY, Date.parse(String(mem.membership.periodEnd)) + 10 * DAY));
    if (t === null) continue;
    const recs = mattersBy.get(mem.id)!;
    makeCon(mem, recs.find((r) => !r.doc.closedAt) ?? recs[0], t, "booked");
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
  const buildQuote = (mem: Member, rec: MatterRec, o: Opportunity & Doc, lawyer: (typeof lawyers)[number], sentAt: number): Doc => {
    const spec = rec.script.opportunity!;
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
      status: "sent",
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
    const vars = { loc: mem.loc.place, L: lawyer.first, M: mem.first };
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
          Object.assign(q, { status: "accepted", clientAcceptedAt: iso(acceptedAt), acceptedAt: iso(acceptedAt), clientAcceptedBy: mem.email, updatedAt: iso(acceptedAt) });
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
  for (const mem of members) {
    rng.reseed("members-5", mem.i);
    if (mem.status === "pending" || mem.status === "cancelled") continue;
    const recs = mattersBy.get(mem.id) ?? [];
    if (mem.profile.hasCompany && rng.chance(0.12)) {
      const created = Math.max(mem.activatedAt + DAY, NOW - rng.int(1, 20) * DAY);
      add(COLLECTIONS.opportunities, {
        id: `${PLACEHOLDER_PREFIX}opp_obl_${pad(++oppN, 3)}`,
        clientId: mem.id,
        source: { kind: "obligation", id: `${PLACEHOLDER_PREFIX}obl_${pad(mem.i + 1)}_corporation_tax` },
        title: "Annual corporation tax and RTBF filing",
        area: "corporate",
        stage: "identified",
        valueCents: rng.int(7, 12) * 5000,
        ownerEmail: mem.csm,
        nextAction: { what: "Offer the annual filing package", dueAt: iso(Math.max(created + 3 * DAY, NOW - DAY)) },
        createdAt: iso(created),
        updatedAt: iso(created),
      } as Opportunity & Doc);
    } else if (recs.length && rng.chance(0.04)) {
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
        const vars = { loc: mem.loc.place, L: lawyerById.get(String(d.assignedProviderId))!.first, M: mem.first };
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
    if (mem.profile.residencyExpiresAt) nowAnswers.residencyExpiresAt = String(mem.profile.residencyExpiresAt);
    for (const f of evaluateCheck(nowAnswers, now)) {
      const key = f.ruleId.replace(/^CR_CHECK_/, "").toLowerCase();
      const due = Date.parse(f.dueAt ?? "");
      const monthly = f.ruleId === "CR_CHECK_CCSS_MEMBER" || f.ruleId === "CR_CHECK_EMPLOYER_CCSS";
      const status = mem.status === "cancelled" ? "upcoming"
        : monthly ? rng.weighted([["upcoming", 40], ["handled", 60]] as const)
        : rng.weighted([["upcoming", 78], ["asked", 15], ["dismissed", 7]] as const);
      list.push(add(COLLECTIONS.obligations, { id: `${PLACEHOLDER_PREFIX}obl_${pad(mem.i + 1)}_${key}`, clientId: mem.id, country: "CR", ruleId: f.ruleId, title: f.title, dueAt: f.dueAt, status }));
      // Last year's occurrence of an annual rule, already handled.
      if (Number.isFinite(due) && due - 365 * DAY > mem.activatedAt && due - 365 * DAY < NOW && !key.includes("ccss")) {
        list.push(add(COLLECTIONS.obligations, { id: `${PLACEHOLDER_PREFIX}obl_${pad(mem.i + 1)}_${key}_prev`, clientId: mem.id, country: "CR", ruleId: f.ruleId, title: f.title, dueAt: iso(due - 365 * DAY), status: "handled" }));
      }
    }
    obligationsBy.set(mem.id, list);
  }

  // ── Membership tasks, feedback, consents ──
  for (const mem of members) {
    rng.reseed("members-8", mem.i);
    const m = mem.membership;
    if (mem.status !== "pending") {
      mkTask("membership.activated", { clientId: mem.id, sourceId: m.id, detail: `${mem.first} ${mem.last}` }, mem.activatedAt,
        NOW - mem.activatedAt > 2 * DAY ? "done" : "open");
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
        if (!rng.chance(0.45)) continue;
        const score = rng.weighted([[10, 30], [9, 25], [8, 15], [7, 12], [6, 7], [5, 5], [4, 3], [3, 2], [1, 1]] as const);
        const month = iso(t).slice(0, 7);
        const fid = `${PLACEHOLDER_PREFIX}fb_m_${pad(mem.i + 1)}_${month}`;
        if ((collections[COLLECTIONS.feedback] ?? []).some((f) => f.id === fid)) continue; // one answer per month
        add(COLLECTIONS.feedback, {
          id: fid, clientId: mem.id, kind: "monthly", score, month, at: iso(t),
          ...(score <= 6 ? { comment: rng.pick(["Hard to get a call slot this month.", "Not sure I'm using it enough.", "Took a while to hear back."]) } : score >= 9 && rng.chance(0.4) ? { comment: rng.pick(["Peace of mind for our house.", "The deadline reminders alone are worth it.", "Mariana is fantastic."]) } : {}),
        });
        if (score <= 6) mkTask("feedback.low_score", { clientId: mem.id, sourceId: fid, dedupeKey: fid, detail: `monthly score ${score}/10` }, t);
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

  // ── Privacy requests (one export done, one deletion in review, …) ──
  const prMembers = rng.shuffle(members.filter((m) => m.status !== "pending" && m.i > 0)).slice(0, opts.size === "demo" ? 2 : opts.size === "pilot" ? 3 : 5);
  prMembers.forEach((mem, k) => {
    const kind = (["export", "delete", "access", "rectify", "export"] as const)[k];
    const status = (["completed", "in_review", "received", "completed", "completed"] as const)[k];
    const created = kind === "delete" && mem.cancelAt ? Math.min(NOW - 2 * DAY, mem.cancelAt + 5 * DAY) : NOW - rng.int(3, 40) * DAY;
    const id = `${PLACEHOLDER_PREFIX}prq_${pad(k + 1, 3)}`;
    const dueAt = created + 14 * DAY;
    add(COLLECTIONS.privacyRequests, {
      id, clientId: mem.id, email: mem.email, kind, status,
      note: kind === "delete" ? "Member asked to delete their data after cancelling." : kind === "rectify" ? "Correct date of birth." : undefined,
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
    const n = Math.min(eligible.length, rng.int(0, 4));
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

  // ── Client records (person doc with the embedded arrays the portals read) ──
  const clients: Doc[] = [];
  for (const mem of members) {
    rng.reseed("members-10", mem.i);
    const m = mem.membership;
    const recs = mattersBy.get(mem.id) ?? [];
    const primary = recs.find((r) => !r.doc.closedAt) ?? recs[0];
    const lawyer = primary ? lawyerById.get(String(primary.doc.assignedProviderId)) : undefined;
    const vars = { loc: mem.loc.place, L: lawyer?.first ?? "your lawyer", M: mem.first };
    // Charges: activation + each paid month (+ the unpaid month when past due) + accepted legal work.
    const charges: Doc[] = [];
    if (mem.status !== "pending") {
      charges.push({ id: `${PLACEHOLDER_PREFIX}ch_${pad(mem.i + 1)}_act`, label: "Activation fee", amountMinor: PLAN_STANDARD.activationCents, currency: "USD", status: "paid", createdAt: iso(mem.activatedAt), paidAt: iso(mem.activatedAt) });
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
    if (mem.status === "active" && rng.chance(0.12)) {
      pendingActions.push({ id: `${PLACEHOLDER_PREFIX}pa_${pad(mem.i + 1)}`, label: rng.pick(["Upload apostilled birth certificate", "Upload passport copy (scan)", "Upload the property deed (escritura)", "Upload the CCSS certificate"]), dueAt: iso(NOW - rng.int(-3, 9) * DAY) });
    }
    // Messages: team ↔ member, and the AI assistant (labelled AI in the portal).
    const statusComments: Doc[] = [];
    const commentCount = mem.status === "pending" ? 0 : rng.int(1, 4);
    for (let k = 0; k < commentCount; k++) {
      const t = Math.min(NOW - HOUR, mem.activatedAt + (k + 1) * rng.int(2, 9) * DAY);
      const team = k % 2 === 0;
      statusComments.push({
        id: `${PLACEHOLDER_PREFIX}cmt_${pad(mem.i + 1)}_${k + 1}`,
        author: team ? mem.csm : mem.email,
        authorType: team ? "staff" : "client",
        body: fill(team ? TEAM_MESSAGES[Math.min(k, TEAM_MESSAGES.length - 1)] : rng.pick(MEMBER_MESSAGES), vars),
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
    const notes = mem.status === "pending" ? [] : rng.shuffle(CSM_NOTES).slice(0, rng.int(1, 3)).map((n, k) => ({
      text: fill(n, vars), author: mem.csm, createdAt: iso(Math.min(NOW - HOUR, mem.activatedAt + (k + 1) * rng.int(1, 12) * DAY)),
    }));
    const activityLog: Doc[] = [
      { type: "membership_started", actor: "system", timestamp: iso(mem.activatedAt), note: mem.status === "pending" ? "Join started, payment pending." : "Membership activated." },
      ...recs.map((r) => ({ type: "stage_changed", actor: lawyerById.get(String(r.doc.assignedProviderId))!.email, timestamp: String(r.doc.stageEnteredAt), note: `${r.doc.title}: ${r.doc.stage}` })),
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
      jurisdiction: "Costa Rica",
      country: "CR",
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

/** Ready-share of active members (for the summary and tests). */
export function readyShare(data: SeedData): number {
  const active = new Set((data.collections.memberships ?? []).filter((m) => m.status === "active").map((m) => m.clientId));
  const list = (data.collections.clients ?? []).filter((c) => active.has(c.id));
  return list.filter((c) => profileCompleteness(c).consultationReady).length / Math.max(1, list.length);
}
