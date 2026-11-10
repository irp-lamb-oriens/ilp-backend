/**
 * API/referrals/types.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Referral partners (influencers, media, experts, teachers, long-standing
 * referrers), their tracked links, who they brought, what each sale earns
 * them and what we have wired them. One module serves every brand:
 * ILP feeds it from its own payment events; IRP, AIVA and El Censo report
 * sales through the ingest API (x-referrals-key) or staff "Record sale".
 *
 * Money is integer cents (USD). Dates are ISO strings (UTC).
 */

export type Brand = "ilp" | "irp" | "aiva" | "censo";
export const BRANDS: readonly Brand[] = ["ilp", "irp", "aiva", "censo"];
export const BRAND_NAMES: Record<Brand, string> = {
  ilp: "International Legal Partner",
  irp: "International Relocation Partner",
  aiva: "AIVA",
  censo: "El Censo",
};

export type PartnerType = "expert" | "teacher" | "media" | "influencer" | "referrer" | "local";
export const PARTNER_TYPES: readonly PartnerType[] = ["expert", "teacher", "media", "influencer", "referrer", "local"];

export type PartnerStatus = "invited" | "active" | "paused" | "closed";
export const PARTNER_STATUSES: readonly PartnerStatus[] = ["invited", "active", "paused", "closed"];

export type PayoutMethod = "wire" | "sinpe" | "wise" | "paypal" | "other";
export const PAYOUT_METHODS: readonly PayoutMethod[] = ["wire", "sinpe", "wise", "paypal", "other"];

/** What the partner sees and staff lists show. The account details themselves are sealed (crypto.ts). */
export interface PayoutDetails {
  method: PayoutMethod;
  holderName: string;
  bankName?: string;
  country?: string;
  currency?: string;
  /** Last 4 characters of the account / IBAN / phone, for display. */
  mask: string;
  /** AES-GCM sealed JSON of the full details (account, IBAN, SWIFT, tax id…). Never sent to a browser except the admin reveal. */
  sealed: string;
  updatedAt: string;
  updatedBy: string;
}

export interface Partner {
  id: string;
  name: string;
  email: string; // normalized lowercase, unique
  type: PartnerType;
  brands: Brand[];
  status: PartnerStatus;
  /** Rule per brand. */
  ruleIds: Partial<Record<Brand, string>>;
  language: "en" | "es";
  payout?: PayoutDetails;
  taxFormStatus: "missing" | "w9" | "w8ben" | "cr_invoice" | "other";
  notes?: string;
  /** Relationship start: drives "since we started" totals. Import moves it earlier. */
  startedAt: string;
  invitedBy: string;
  /** Monthly statement email on/off (partner can turn it off). */
  monthlyEmail: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * base:
 *  - payment: every collected payment earns (initial + renewals), within durationMonths
 *  - first_sale: only the customer's first collected payment on the brand earns
 *  - active_member: a fixed amount per paid membership period; never on one-off sales
 */
export type CommissionBase = "payment" | "first_sale" | "active_member";

export interface CommissionRule {
  id: string;
  name: string;
  brand: Brand;
  base: CommissionBase;
  percent?: number; // 0-100, when amountCents is not set
  amountCents?: number; // fixed per earning event; wins over percent
  include: "all" | "exclude_activation";
  durationMonths?: number; // undefined = forever
  holdDays: number; // pending → approvable after this many days (refund window)
  archived?: boolean;
  createdAt: string;
  createdBy: string;
}

export interface UTM {
  source: string;
  medium: string;
  campaign: string;
  content?: string;
}

export interface ReferralLink {
  id: string;
  partnerId: string;
  brand: Brand;
  code: string; // unique across brands, url-safe
  destination: string;
  utm: UTM;
  url: string; // destination + ref + utm
  clicks: number;
  active: boolean;
  createdAt: string;
  createdBy: string;
}

export type ReferralStatus = "lead" | "customer";

/** One person on one brand, tied to one partner. Id = ref_<brand>_<subjectKey hash>. */
export interface Referral {
  id: string;
  brand: Brand;
  partnerId: string;
  linkId?: string;
  code?: string;
  /** ILP: clientId (email-derived). Other brands: their customer id, or an email hash. */
  subjectKey: string;
  clientId?: string;
  leadId?: string;
  status: ReferralStatus;
  firstSeenAt: string;
  convertedAt?: string;
  via: "link" | "cookie" | "manual" | "ingest";
  assignedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export type CommissionStatus = "pending" | "approved" | "paid" | "reversed";

export interface Commission {
  id: string; // com_<hash(brand|saleRef)>: one per sale
  brand: Brand;
  partnerId: string;
  referralId?: string;
  ruleId?: string;
  clientId?: string;
  saleRef: string;
  saleKind: SaleKind | "import" | "clawback" | "adjustment";
  saleAmountCents: number;
  amountCents: number; // negative for clawbacks / adjustments
  status: CommissionStatus;
  earnedAt: string;
  approvableAt: string;
  approvedAt?: string;
  paidAt?: string;
  payoutId?: string;
  reversedAt?: string;
  reversalReason?: string;
  offsetsId?: string;
  source: "engine" | "import" | "manual";
  note?: string;
  createdAt: string;
}

export interface Payout {
  id: string;
  partnerId: string;
  totalCents: number;
  method: PayoutMethod;
  reference: string; // wire / SINPE / Wise reference
  paidAt: string;
  commissionIds: string[];
  createdBy: string;
  source: "engine" | "import";
  createdAt: string;
}

export type SaleKind = "initial" | "renewal" | "one_time";

export interface SaleEvent {
  brand: Brand;
  saleRef: string; // unique per payment in the brand's system
  clientId: string;
  amountCents: number;
  activationCents?: number;
  kind: SaleKind;
  paidAt: string;
  refCode?: string;
  email?: string;
}
