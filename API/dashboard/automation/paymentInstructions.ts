/**
 * paymentInstructions.ts — shared renderers for the client-facing payment copy.
 *
 * Three surfaces read the same bank data and the accepted quote's
 * `paymentSchedule`, but show different slices:
 *   • the engagement-agreement email (full narrative copy),
 *   • the contract PDF last page (schedule table + next payment + details),
 *   • the finance invoice (schedule table with paid/pending per segment).
 *
 * Everything takes plain, already-resolved inputs so the HTML and pdfmake
 * renderers stay presentation-only. Legacy quotes without a `paymentSchedule`
 * (or with an empty one) render no payment section at all.
 */

import type { BankInfoConfig } from "./bankInfo.ts";
import { DEFAULT_BANK_INFO } from "./bankInfo.ts";

/** One resolved installment: its share, label, and agreed-total-derived amount. */
export interface ResolvedSegment {
  index0: number;
  index1: number;
  percent: number;
  label: string;
  amount: number;
}

export interface PaymentScheduleContext {
  currency: string;
  total: number;
  /** Ordered percents (e.g. [35, 65]); sums to 100. */
  schedule: number[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n: number, currency: string): string {
  const amount = Number.isFinite(n) ? n : 0;
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Resolve a raw schedule into labeled segments with amounts. */
export function resolveSchedule(ctx: PaymentScheduleContext): ResolvedSegment[] {
  const schedule = Array.isArray(ctx.schedule) ? ctx.schedule : [];
  const total = Number.isFinite(ctx.total) ? ctx.total : 0;
  return schedule
    .map((p, i) => (typeof p === "number" && Number.isFinite(p) ? p : Number.NaN))
    .filter((p) => !Number.isNaN(p))
    .map((p, i) => ({
      index0: i,
      index1: i + 1,
      percent: p,
      label: i === 0 ? "Reservation (initial payment)" : "Installment",
      amount: round2(total * (p / 100)),
    }));
}

/** Percent (must exist) and amount of the first / reservation segment. */
export function reservationSegment(ctx: PaymentScheduleContext): ResolvedSegment | null {
  return resolveSchedule(ctx)[0] ?? null;
}

/**
 * The two sentences describing what is due now and what remains, for example:
 * "To complete the initial 35% deposit of USD 3,500.00, please pay the amount
 * below. The remaining 65% balance is due upon completion of the engagement."
 */
export function depositNarrative(ctx: PaymentScheduleContext): string | null {
  const first = reservationSegment(ctx);
  if (!first) return null;
  const restPct = round2(100 - first.percent);
  const amount = money(first.amount, ctx.currency);
  return (
    `To move forward, please complete the initial ${first.percent}% deposit of ${amount}. ` +
    `The remaining ${restPct}% balance will be due upon completion of the engagement.`
  );
}

/** Plain-text bank details block (no account digits are split or altered). */
export function bankDetailsText(bank: BankInfoConfig): string {
  const b = bank.beneficiary;
  const r = bank.receivingBank;
  const lines: string[] = [];

  lines.push("Beneficiary");
  lines.push(`Beneficiary Name: ${b.name}`);
  lines.push(`Account Number: ${b.accountNumber}`);
  lines.push(`Account Type: ${b.accountType}`);
  lines.push(`Beneficiary Address: ${b.address.join(", ")}`);

  lines.push("");
  lines.push("Receiving Bank Details");
  lines.push(`Bank Name: ${r.name}`);
  lines.push(`ABA Routing Number: ${r.abaRoutingNumber}`);
  if (r.swiftBic) lines.push(`SWIFT / BIC Code: ${r.swiftBic}`);
  lines.push(`Bank Address: ${r.address.join(", ")}`);
  if (r.partnerNote) lines.push(r.partnerNote);

  if (bank.domesticNote) {
    lines.push("");
    lines.push(bank.domesticNote);
  }
  if (bank.localChargesNote) {
    lines.push("");
    lines.push(bank.localChargesNote);
  }
  if (bank.receiptNote) {
    lines.push("");
    lines.push(bank.receiptNote);
  }

  return lines.join("\n");
}

/**
 * Build the bank-details block for pdfmake. Returns `undefined` when there is
 * nothing to render (so callers can omit the section cleanly).
 */
export function bankDetailsPdfBankRows(bank: BankInfoConfig): Array<[string, string]> {
  const b = bank.beneficiary;
  const r = bank.receivingBank;
  const rows: Array<[string, string]> = [
    ["Beneficiary Name", b.name],
    ["Account Number", b.accountNumber],
    ["Account Type", b.accountType],
    ["Beneficiary Address", b.address.join(", ")],
    ["Bank Name", r.name],
    ["ABA Routing Number", r.abaRoutingNumber],
  ];
  if (r.swiftBic) rows.push(["SWIFT / BIC Code", r.swiftBic]);
  rows.push(["Bank Address", r.address.join(", ")]);
  return rows;
}

/** Whether a resolved schedule is non-empty (legacy quotes have none). */
export function hasSchedule(ctx: PaymentScheduleContext): boolean {
  return resolveSchedule(ctx).length > 0;
}

/**
 * "Next expected payment" pointer — the first segment not yet covered when we
 * walk the received total cumulatively through the schedule. Returns the segment
 * or null when everything is paid.
 */
export function nextExpectedSegment(
  ctx: PaymentScheduleContext,
  received: number,
): ResolvedSegment | null {
  const segments = resolveSchedule(ctx);
  let covered = Number.isFinite(received) ? received : 0;
  for (const seg of segments) {
    if (covered < seg.amount - 0.005) return seg;
    covered -= seg.amount;
  }
  return null;
}

/** Per-segment paid/pending state for the finance invoice table. */
export interface SegmentPaymentState {
  segment: ResolvedSegment;
  paid: number;
  pending: number;
  status: "paid" | "partial" | "due";
}

/** Walk received total across the schedule, returning paid/pending per segment. */
export function segmentPaymentStates(
  ctx: PaymentScheduleContext,
  received: number,
): SegmentPaymentState[] {
  const segments = resolveSchedule(ctx);
  let remaining = Number.isFinite(received) ? received : 0;
  return segments.map((seg) => {
    const paid = Math.min(seg.amount, Math.max(0, remaining));
    remaining -= paid;
    const pending = round2(seg.amount - paid);
    const status: SegmentPaymentState["status"] = paid >= seg.amount - 0.005
      ? "paid"
      : paid > 0
      ? "partial"
      : "due";
    return { segment: seg, paid: round2(paid), pending, status };
  });
}

/** Re-export the default config for callers that want a safe fallback. */
export { DEFAULT_BANK_INFO };
export type { BankInfoConfig };