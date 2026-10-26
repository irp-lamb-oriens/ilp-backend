/**
 * API/countries/countryCatalog.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Country legal-priority catalog: the reference data of what ILP can track
 * per country. This is the "what can I monitor" menu the user personalizes.
 *
 * Each priority is a stable record the user attaches a real date to. The
 * deadline is the user's recorded date; `reminderOffsetsDays` are the ILP
 * service reminders fired before that date (not legal grace periods).
 *
 * This is reference data, not a live legal rule. Dates, amounts and
 * procedures must be validated by a qualified professional per jurisdiction
 * before any customer-facing deadline is treated as authoritative.
 */

export type PriorityCategory =
  | "Residency"
  | "Tax"
  | "Property"
  | "Corporate"
  | "Social security";

export interface LegalPriority {
  /** Stable id, e.g. "CR_RESIDENCY_DIMEX". */
  id: string;
  /** ISO alpha-2 country code, e.g. "CR". */
  country: string;
  category: PriorityCategory;
  title: string;
  description: string;
  /** What date the user records to drive this priority. */
  dateFieldLabel: string;
  dateFieldHint?: string;
  /** ILP reminder offsets in days before the recorded date. */
  reminderOffsetsDays: number[];
}

const RESIDENCY_OFFSETS = [180, 120, 90, 60, 30];
const TAX_OFFSETS = [60, 30, 15, 7, 1];
const PROPERTY_OFFSETS = [60, 30, 15, 7, 1];
const CORPORATE_OFFSETS = [60, 30, 15, 7, 1];

export const LEGAL_PRIORITIES: LegalPriority[] = [
  // ── Costa Rica ────────────────────────────────────────────────────────────
  {
    id: "CR_RESIDENCY_DIMEX",
    country: "CR",
    category: "Residency",
    title: "DIMEX renewal",
    description:
      "Your DIMEX card expires on a set schedule. Missing the window can restart your residency from zero.",
    dateFieldLabel: "DIMEX expiry date",
    reminderOffsetsDays: RESIDENCY_OFFSETS,
  },
  {
    id: "CR_SOCIAL_CCSS",
    country: "CR",
    category: "Social security",
    title: "CCSS contributions",
    description:
      "Falling behind on Caja payments can suspend coverage and block renewals.",
    dateFieldLabel: "Next CCSS payment due date",
    reminderOffsetsDays: TAX_OFFSETS,
  },
  {
    id: "CR_PROPERTY_MUNICIPAL",
    country: "CR",
    category: "Property",
    title: "Municipal property tax",
    description:
      "Property tax is local, and the valuation declaration renews every five years.",
    dateFieldLabel: "Next property tax due date",
    reminderOffsetsDays: PROPERTY_OFFSETS,
  },
  {
    id: "CR_CORPORATE_ANNUAL",
    country: "CR",
    category: "Corporate",
    title: "Corporate tax and registry",
    description:
      "Corporate tax, the beneficial-owner registry, and bookkeeping each carry a penalty date.",
    dateFieldLabel: "Next corporate filing due date",
    reminderOffsetsDays: CORPORATE_OFFSETS,
  },

  // ── Panama ────────────────────────────────────────────────────────────────
  {
    id: "PA_CORPORATE_TASA",
    country: "PA",
    category: "Corporate",
    title: "Annual franchise tax (tasa única)",
    description:
      "Every corporation and foundation owes the tasa única each year. Late payment adds surcharges and can suspend the entity.",
    dateFieldLabel: "Tasa única due date",
    reminderOffsetsDays: CORPORATE_OFFSETS,
  },
  {
    id: "PA_AGENT_RECORDS",
    country: "PA",
    category: "Corporate",
    title: "Registered agent and records",
    description:
      "Beneficial-owner details and accounting records must stay with your registered agent.",
    dateFieldLabel: "Records delivery due date",
    reminderOffsetsDays: CORPORATE_OFFSETS,
  },
  {
    id: "PA_RESIDENCY_RENEWAL",
    country: "PA",
    category: "Residency",
    title: "Residency renewal",
    description:
      "Provisional and permanent cards renew on fixed cycles. Missing the window restarts the process.",
    dateFieldLabel: "Residency card expiry date",
    reminderOffsetsDays: RESIDENCY_OFFSETS,
  },
  {
    id: "PA_PROPERTY_TAX",
    country: "PA",
    category: "Property",
    title: "Property tax and exemptions",
    description:
      "Tax exemptions expire. When one does, you get a bill you weren't expecting.",
    dateFieldLabel: "Next property tax installment date",
    reminderOffsetsDays: PROPERTY_OFFSETS,
  },

  // ── Mexico ────────────────────────────────────────────────────────────────
  {
    id: "MX_TAX_SAT",
    country: "MX",
    category: "Tax",
    title: "SAT filings",
    description:
      "Residents and business owners owe the SAT regular reports. Arrears block renewals and other filings.",
    dateFieldLabel: "Next SAT filing due date",
    reminderOffsetsDays: TAX_OFFSETS,
  },
  {
    id: "MX_RESIDENCY_RENEWAL",
    country: "MX",
    category: "Residency",
    title: "Temporary and permanent renewals",
    description:
      "Residency cards renew on a set schedule. Missing the window restarts the process.",
    dateFieldLabel: "Residency card expiry date",
    reminderOffsetsDays: RESIDENCY_OFFSETS,
  },
  {
    id: "MX_PROPERTY_PREDIAL",
    country: "MX",
    category: "Property",
    title: "Predial and local obligations",
    description:
      "Property tax and local duties change from state to state, and a fideicomiso adds a yearly trust fee.",
    dateFieldLabel: "Next predial due date",
    reminderOffsetsDays: PROPERTY_OFFSETS,
  },
  {
    id: "MX_BUSINESS_REGISTRY",
    country: "MX",
    category: "Corporate",
    title: "Corporate and registry duties",
    description:
      "Yearly filings and registry requirements each have their own due date.",
    dateFieldLabel: "Next corporate filing due date",
    reminderOffsetsDays: CORPORATE_OFFSETS,
  },

  // ── Colombia ──────────────────────────────────────────────────────────────
  {
    id: "CO_RESIDENCY_CEDULA",
    country: "CO",
    category: "Residency",
    title: "Cédula de extranjería renewal",
    description:
      "Foreign resident cards expire on a set schedule. Missing the window restarts the process.",
    dateFieldLabel: "Cédula expiry date",
    reminderOffsetsDays: RESIDENCY_OFFSETS,
  },
  {
    id: "CO_TAX_DIAN",
    country: "CO",
    category: "Tax",
    title: "DIAN filings and RUT updates",
    description:
      "Residents and businesses must stay current with DIAN. Arrears block renewals and other filings.",
    dateFieldLabel: "Next DIAN filing due date",
    reminderOffsetsDays: TAX_OFFSETS,
  },
  {
    id: "CO_PROPERTY_PREDIAL",
    country: "CO",
    category: "Property",
    title: "Predial property tax",
    description:
      "Property tax is set by your local area, and the value it reports matters.",
    dateFieldLabel: "Next predial due date",
    reminderOffsetsDays: PROPERTY_OFFSETS,
  },
  {
    id: "CO_CORPORATE_CAMARA",
    country: "CO",
    category: "Corporate",
    title: "Cámara de Comercio renewals",
    description:
      "Your company's yearly registration and bookkeeping duties each have their own due date.",
    dateFieldLabel: "Next Cámara renewal date",
    reminderOffsetsDays: CORPORATE_OFFSETS,
  },

  // ── Spain ─────────────────────────────────────────────────────────────────
  {
    id: "ES_RESIDENCY_TIE",
    country: "ES",
    category: "Residency",
    title: "TIE renewal",
    description:
      "The TIE expires on a set schedule. Missing the window restarts the process.",
    dateFieldLabel: "TIE expiry date",
    reminderOffsetsDays: RESIDENCY_OFFSETS,
  },
  {
    id: "ES_TAX_AEAT",
    country: "ES",
    category: "Tax",
    title: "Modelo filings and the AEAT",
    description:
      "Residents and businesses must stay current with the Agencia Tributaria.",
    dateFieldLabel: "Next modelo filing due date",
    reminderOffsetsDays: TAX_OFFSETS,
  },
  {
    id: "ES_PROPERTY_IBI",
    country: "ES",
    category: "Property",
    title: "IBI property tax",
    description:
      "The IBI is set by your local area and the cadastral value it reports.",
    dateFieldLabel: "Next IBI due date",
    reminderOffsetsDays: PROPERTY_OFFSETS,
  },
  {
    id: "ES_CORPORATE_AUTONOMO",
    country: "ES",
    category: "Corporate",
    title: "Autónomo and mercantile duties",
    description:
      "Self-employment payments, quarterly models, and registry filings each have their own due date.",
    dateFieldLabel: "Next autónomo or filing due date",
    reminderOffsetsDays: CORPORATE_OFFSETS,
  },

  // ── Portugal ──────────────────────────────────────────────────────────────
  {
    id: "PT_RESIDENCY_PERMIT",
    country: "PT",
    category: "Residency",
    title: "Residence permit renewal",
    description:
      "Temporary and permanent permits expire on a set schedule. Missing the window restarts the process.",
    dateFieldLabel: "Residence permit expiry date",
    reminderOffsetsDays: RESIDENCY_OFFSETS,
  },
  {
    id: "PT_TAX_IRS",
    country: "PT",
    category: "Tax",
    title: "IRS filings and the AT",
    description:
      "Residents and businesses must stay current with the Autoridade Tributária.",
    dateFieldLabel: "Next IRS filing due date",
    reminderOffsetsDays: TAX_OFFSETS,
  },
  {
    id: "PT_PROPERTY_IMI",
    country: "PT",
    category: "Property",
    title: "IMI property tax",
    description:
      "The IMI is set by your local area and the cadastral value it reports.",
    dateFieldLabel: "Next IMI due date",
    reminderOffsetsDays: PROPERTY_OFFSETS,
  },
  {
    id: "PT_CORPORATE_SEGURANCA",
    country: "PT",
    category: "Corporate",
    title: "Company and Segurança Social duties",
    description:
      "Yearly accounts, social security payments, and registry filings each have their own due date.",
    dateFieldLabel: "Next company or social security due date",
    reminderOffsetsDays: CORPORATE_OFFSETS,
  },
];

/** All supported country codes, in display order. */
export const SUPPORTED_COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "CR", name: "Costa Rica" },
  { code: "PA", name: "Panama" },
  { code: "MX", name: "Mexico" },
  { code: "CO", name: "Colombia" },
  { code: "ES", name: "Spain" },
  { code: "PT", name: "Portugal" },
];

/** Priorities for a single country, in stable order. */
export function prioritiesForCountry(country: string): LegalPriority[] {
  const code = String(country ?? "").trim().toUpperCase();
  return LEGAL_PRIORITIES.filter((p) => p.country === code);
}

/** Look up a single priority by id. */
export function priorityById(id: string): LegalPriority | undefined {
  return LEGAL_PRIORITIES.find((p) => p.id === id);
}

/**
 * Resolve a country code from a free-text jurisdiction value. Client docs
 * store the jurisdiction as a full name ("Costa Rica", "Panama") or an ISO
 * code ("CR", "PA"). Normalize both to the catalog's alpha-2 code.
 */
export function countryCodeFromName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (!s) return null;

  const byName: Record<string, string> = {
    "costa rica": "CR",
    "costa rica (cr)": "CR",
    panama: "PA",
    "panamá": "PA",
    mexico: "MX",
    "méxico": "MX",
    colombia: "CO",
    spain: "ES",
    españa: "ES",
    portugal: "PT",
  };

  if (byName[s]) return byName[s];

  const upper = s.toUpperCase();
  const known = new Set(SUPPORTED_COUNTRIES.map((c) => c.code));
  if (known.has(upper)) return upper;

  return null;
}

// ─── Free deadline check rules ─────────────────────────────────────────────
/**
 * Rules for the public free deadline check (POST /api/leads/deadline-check).
 * Each rule says which answers make it relevant (`when`), how its next date
 * is computed (`due`), and how to explain it in one plain sentence. The route
 * evaluates these generically, so a new country is data only.
 *
 * Wording rules: every title ends in "may require review"; every `meaning`
 * says what this usually means, never what will happen. Reference data, to be
 * validated by a partner lawyer before launch in each country.
 */
export type CheckArea = "immigration" | "property" | "corporate" | "vehicle" | "employment";

export type CheckDue =
  /** Same calendar day every year (month 1-12). */
  | { kind: "annual"; month: number; day: number }
  /** Next of several calendar days each year (e.g. quarterly installments). */
  | { kind: "installments"; dates: Array<[number, number]> }
  /** Last day of the current month. */
  | { kind: "monthEnd" }
  /** A date the visitor gave, shifted by `offsetDays` (negative = before). */
  | { kind: "fromAnswer"; field: string; offsetDays: number };

export interface CheckRule {
  id: string;
  country: string;
  area: CheckArea;
  /** Optional link to a LEGAL_PRIORITIES entry the member can track later. */
  priorityId?: string;
  /** Every key must match one of the listed values for the rule to apply. */
  when: Record<string, Array<string | boolean>>;
  due: CheckDue;
  title: string;
  /** "What this usually means", one sentence. */
  meaning: string;
}

export const CHECK_RULES: CheckRule[] = [
  // ── Costa Rica ────────────────────────────────────────────────────────────
  {
    id: "CR_CHECK_DIMEX_RENEWAL",
    country: "CR",
    area: "immigration",
    priorityId: "CR_RESIDENCY_DIMEX",
    when: { residencyStatus: ["resident"] },
    due: { kind: "fromAnswer", field: "residencyExpiresAt", offsetDays: -90 },
    title: "DIMEX renewal may require review",
    meaning:
      "Residency renewals are usually filed in the three months before the card expires, and this is roughly when that window opens.",
  },
  {
    id: "CR_CHECK_CCSS_MEMBER",
    country: "CR",
    area: "immigration",
    priorityId: "CR_SOCIAL_CCSS",
    when: { residencyStatus: ["resident"] },
    due: { kind: "monthEnd" },
    title: "Caja (CCSS) contributions may require review",
    meaning:
      "Residents are generally expected to keep their Caja health insurance current each month, and renewals usually check it.",
  },
  {
    id: "CR_CHECK_VISITOR_STAY",
    country: "CR",
    area: "immigration",
    when: { residencyStatus: ["visitor"] },
    due: { kind: "fromAnswer", field: "lastEntryDate", offsetDays: 180 },
    title: "Your permitted stay may require review",
    meaning:
      "Visitors can usually stay for the number of days stamped in their passport at entry, up to 180; this date assumes the full 180.",
  },
  {
    id: "CR_CHECK_MUNICIPAL_TAX",
    country: "CR",
    area: "property",
    priorityId: "CR_PROPERTY_MUNICIPAL",
    when: { ownsProperty: [true] },
    due: { kind: "installments", dates: [[3, 31], [6, 30], [9, 30], [12, 31]] },
    title: "Municipal property tax may require review",
    meaning:
      "Property tax is paid to the local municipality, usually in quarterly installments or once a year, and this is the next usual installment date.",
  },
  {
    id: "CR_CHECK_CORPORATION_TAX",
    country: "CR",
    area: "corporate",
    priorityId: "CR_CORPORATE_ANNUAL",
    when: { hasCompany: [true] },
    due: { kind: "annual", month: 1, day: 31 },
    title: "Annual corporation tax may require review",
    meaning:
      "Costa Rican corporations, active or not, usually pay the tax on legal entities (personas jurídicas) each January.",
  },
  {
    id: "CR_CHECK_BENEFICIAL_OWNER",
    country: "CR",
    area: "corporate",
    priorityId: "CR_CORPORATE_ANNUAL",
    when: { hasCompany: [true] },
    due: { kind: "annual", month: 4, day: 30 },
    title: "Beneficial-owner declaration may require review",
    meaning:
      "Most corporations file a yearly statement of who ultimately owns them with the Central Bank registry (RTBF), usually during April.",
  },
  {
    id: "CR_CHECK_MARCHAMO",
    country: "CR",
    area: "vehicle",
    when: { ownsVehicle: [true] },
    due: { kind: "annual", month: 12, day: 31 },
    title: "Vehicle circulation permit (marchamo) may require review",
    meaning:
      "The marchamo is renewed every year; payment usually opens in November and closes on December 31.",
  },
  {
    id: "CR_CHECK_AGUINALDO",
    country: "CR",
    area: "employment",
    when: { hasEmployees: [true] },
    due: { kind: "annual", month: 12, day: 20 },
    title: "Year-end bonus (aguinaldo) may require review",
    meaning:
      "Employers, including households with a housekeeper or gardener, usually pay a thirteenth-month bonus by December 20.",
  },
  {
    id: "CR_CHECK_EMPLOYER_CCSS",
    country: "CR",
    area: "employment",
    when: { hasEmployees: [true] },
    due: { kind: "monthEnd" },
    title: "Employer registration and monthly Caja payments may require review",
    meaning:
      "Anyone with employees is usually registered as an employer with the Caja, pays contributions monthly and holds a work-risk policy.",
  },
];

/** Deadline-check rules for one country, in stable order. */
export function checkRulesForCountry(country: string): CheckRule[] {
  const code = String(country ?? "").trim().toUpperCase();
  return CHECK_RULES.filter((r) => r.country === code);
}
