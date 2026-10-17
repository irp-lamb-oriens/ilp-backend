/**
 * bankInfo.ts — centralized admin-configurable bank transfer details used across
 * the client-facing payment documents (engagement-agreement email, contract PDF,
 * and finance invoice).
 *
 * Mirrors the contractRecipients pattern: a singleton doc in `dashboard_config`,
 * a seeded DEFAULT config, a single-flight warm cache, and load/save helpers.
 * Editing the doc in the admin changes the bank details on every future document
 * without a redeploy.
 *
 * The account/routing figures below are placeholders and are meant to be
 * corrected in the admin (no code change) if the bank changes them.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import log from "../../../helper/log.ts";

const COLLECTION = "dashboard_config";
const DOC_ID = "bank_info";
const REFRESH_MS = 5 * 60 * 1000;

/** Beneficiary block shared by domestic and international instructions. */
export interface BankBeneficiary {
  name: string;
  accountNumber: string;
  accountType: string;
  /** One address line per array entry. */
  address: string[];
}

/** Receiving-bank block (domestic + international share most fields). */
export interface BankReceivingBank {
  name: string;
  abaRoutingNumber: string;
  /** SWIFT/BIC for international wires; empty when not applicable. */
  swiftBic: string | null;
  /** One address line per array entry. */
  address: string[];
  /** Optional partner note. */
  partnerNote: string | null;
}

export interface BankInfoConfig {
  beneficiary: BankBeneficiary;
  receivingBank: BankReceivingBank;
  /** Note that domestic wire + ACH go to the same account. */
  domesticNote: string | null;
  /** Note that future local charges must be paid via bank transfer. */
  localChargesNote: string | null;
  /** Closing note asking for a transfer receipt. */
  receiptNote: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** Preserves behavior when no doc exists yet. */
export const DEFAULT_BANK_INFO: BankInfoConfig = {
  beneficiary: {
    name: "INTERNATIONAL LEGAL PARTNER LLC",
    accountNumber: "000000000000",
    accountType: "Checking",
    address: [
      "Miami, FL 33130",
    ],
  },
  receivingBank: {
    name: "Bank name",
    abaRoutingNumber: "000000000",
    swiftBic: null,
    address: [
      "Bank address",
    ],
    partnerNote: null,
  },
  domesticNote:
    "Use these details to send both domestic wires and ACH transfers to our account.",
  localChargesNote:
    "Future local charges must be paid via bank transfer.",
  receiptNote:
    "Once the payment is complete, please send us a copy of the transfer receipt so we can expedite confirmation with our finance department.",
  updatedAt: null,
  updatedBy: null,
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);
}

function normalize(raw: unknown): BankInfoConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const b = (o.beneficiary && typeof o.beneficiary === "object"
    ? o.beneficiary
    : {}) as Record<string, unknown>;
  const r = (o.receivingBank && typeof o.receivingBank === "object"
    ? o.receivingBank
    : {}) as Record<string, unknown>;

  const beneficiary: BankBeneficiary = {
    name: str(b.name) ?? DEFAULT_BANK_INFO.beneficiary.name,
    accountNumber: str(b.accountNumber) ?? DEFAULT_BANK_INFO.beneficiary.accountNumber,
    accountType: str(b.accountType) ?? DEFAULT_BANK_INFO.beneficiary.accountType,
    address: strArray(b.address).length
      ? strArray(b.address)
      : DEFAULT_BANK_INFO.beneficiary.address,
  };

  const receivingBank: BankReceivingBank = {
    name: str(r.name) ?? DEFAULT_BANK_INFO.receivingBank.name,
    abaRoutingNumber: str(r.abaRoutingNumber) ?? DEFAULT_BANK_INFO.receivingBank.abaRoutingNumber,
    swiftBic: str(r.swiftBic) ?? DEFAULT_BANK_INFO.receivingBank.swiftBic,
    address: strArray(r.address).length
      ? strArray(r.address)
      : DEFAULT_BANK_INFO.receivingBank.address,
    partnerNote: r.partnerNote === null ? null : (str(r.partnerNote) ?? DEFAULT_BANK_INFO.receivingBank.partnerNote),
  };

  return {
    beneficiary,
    receivingBank,
    domesticNote: o.domesticNote === null ? null : (str(o.domesticNote) ?? DEFAULT_BANK_INFO.domesticNote),
    localChargesNote: o.localChargesNote === null ? null : (str(o.localChargesNote) ?? DEFAULT_BANK_INFO.localChargesNote),
    receiptNote: o.receiptNote === null ? null : (str(o.receiptNote) ?? DEFAULT_BANK_INFO.receiptNote),
    updatedAt: str(o.updatedAt),
    updatedBy: str(o.updatedBy),
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

let CACHE: BankInfoConfig = { ...DEFAULT_BANK_INFO };
let isWarm = false;
let lastRefresh = 0;
let inflight: Promise<void> | null = null;

/** Pull the singleton doc into the sync cache. Safe to call often; never throws. */
export async function refreshBankInfo(): Promise<void> {
  try {
    const doc = await get(COLLECTION, DOC_ID).catch(() => null);
    CACHE = doc ? normalize(doc) : { ...DEFAULT_BANK_INFO };
    isWarm = true;
    lastRefresh = Date.now();
  } catch {
    // Non-fatal — keep whatever we had (defaults still work).
  }
}

/** Async getter with single-flight memoization. */
export async function ensureBankInfo(): Promise<BankInfoConfig> {
  const fresh = Date.now() - lastRefresh < REFRESH_MS;
  if (isWarm && fresh) return CACHE;
  if (!inflight) {
    inflight = refreshBankInfo().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return CACHE;
}

/** Persist the config + prime the cache immediately. */
export async function saveBankInfo(
  input: Partial<BankInfoConfig>,
  updatedBy?: string,
): Promise<BankInfoConfig> {
  const now = new Date().toISOString();
  const merged: BankInfoConfig = normalize({
    beneficiary: input.beneficiary ?? CACHE.beneficiary,
    receivingBank: input.receivingBank ?? CACHE.receivingBank,
    domesticNote: input.domesticNote === undefined ? CACHE.domesticNote : input.domesticNote,
    localChargesNote: input.localChargesNote === undefined ? CACHE.localChargesNote : input.localChargesNote,
    receiptNote: input.receiptNote === undefined ? CACHE.receiptNote : input.receiptNote,
    updatedAt: now,
    updatedBy: updatedBy ?? CACHE.updatedBy ?? null,
  });
  await put(COLLECTION, DOC_ID, merged as unknown as Record<string, unknown>);
  CACHE = merged;
  isWarm = true;
  lastRefresh = Date.now();
  log(`[bankInfo] config saved by ${updatedBy ?? "unknown"}`);
  return merged;
}

// ── Self-warming: load once on import, then refresh periodically. ─────────────
refreshBankInfo();
setInterval(() => {
  if (Date.now() - lastRefresh >= REFRESH_MS) refreshBankInfo();
}, REFRESH_MS);