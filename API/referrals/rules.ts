/**
 * API/referrals/rules.ts — what one sale earns under a rule. Pure.
 */
import type { CommissionRule, SaleEvent } from "./types.ts";
import { ReferralError } from "./links.ts";

export const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

export function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

export type RuleInput = Pick<CommissionRule, "name" | "brand" | "base" | "percent" | "amountCents" | "include" | "durationMonths" | "holdDays">;

export function validateRule(r: RuleInput): void {
  if (!r.name?.trim()) throw new ReferralError(400, "Give the rule a name.");
  if (!["payment", "first_sale", "active_member"].includes(r.base)) throw new ReferralError(400, "Pick what the commission is paid on.");
  if (r.amountCents === undefined && r.percent === undefined) throw new ReferralError(400, "Set an amount or a percent.");
  if (r.amountCents !== undefined && (!Number.isInteger(r.amountCents) || r.amountCents <= 0 || r.amountCents > 10_000_000)) {
    throw new ReferralError(400, "The amount must be a positive number of cents.");
  }
  if (r.percent !== undefined && !(r.percent > 0 && r.percent <= 100)) throw new ReferralError(400, "The percent must be between 0 and 100.");
  if (!Number.isInteger(r.holdDays) || r.holdDays < 0 || r.holdDays > 365) throw new ReferralError(400, "Hold days must be 0-365.");
  if (r.durationMonths !== undefined && (!Number.isInteger(r.durationMonths) || r.durationMonths < 1 || r.durationMonths > 240)) {
    throw new ReferralError(400, "Duration must be 1-240 months, or empty for no end.");
  }
  if (!["all", "exclude_activation"].includes(r.include)) throw new ReferralError(400, "Invalid include setting.");
}

export interface SaleContext {
  firstPaidAt: string;
  isFirstPayment: boolean;
}

export type Earning =
  | { amountCents: number; approvableAt: string; reason: "earned" }
  | { amountCents: 0; reason: string };

export function computeEarning(rule: CommissionRule, sale: SaleEvent, ctx: SaleContext): Earning {
  if (rule.brand !== sale.brand) return { amountCents: 0, reason: "brand_mismatch" };
  if (!(sale.amountCents > 0)) return { amountCents: 0, reason: "no_amount" };
  if (rule.durationMonths !== undefined && Date.parse(sale.paidAt) >= Date.parse(addMonthsIso(ctx.firstPaidAt, rule.durationMonths))) {
    return { amountCents: 0, reason: "duration_ended" };
  }
  if (rule.base === "first_sale" && !ctx.isFirstPayment) return { amountCents: 0, reason: "not_first_sale" };
  // Membership rules never earn on one-off sales (ILP: quoted legal work stays out of commissions).
  if (rule.base === "active_member" && sale.kind === "one_time") return { amountCents: 0, reason: "not_membership" };

  const countable = rule.include === "exclude_activation"
    ? Math.max(0, sale.amountCents - (sale.activationCents ?? 0))
    : sale.amountCents;
  const amount = rule.amountCents !== undefined
    ? Math.min(rule.amountCents, countable)
    : Math.floor((countable * (rule.percent ?? 0)) / 100);
  if (amount <= 0) return { amountCents: 0, reason: "zero_after_rule" };
  return { amountCents: amount, approvableAt: addDays(sale.paidAt, rule.holdDays), reason: "earned" };
}

/** Starting points offered in the dashboard "New rule" form. */
export const RULE_PRESETS: Array<RuleInput & { key: string; description: string }> = [
  {
    key: "ilp_monthly_30",
    description: "US$30 every month the member pays (activation fee not counted).",
    name: "ILP: US$30 per paid month",
    brand: "ilp",
    base: "active_member",
    amountCents: 3000,
    include: "exclude_activation",
    holdDays: 30,
  },
  {
    key: "ilp_first_month",
    description: "The member's first month in full (US$79.99), once.",
    name: "ILP: first month in full",
    brand: "ilp",
    base: "first_sale",
    amountCents: 7999,
    include: "exclude_activation",
    holdDays: 30,
  },
  {
    key: "half",
    description: "Half of every payment the customer makes.",
    name: "50% of every payment",
    brand: "irp",
    base: "payment",
    percent: 50,
    include: "all",
    holdDays: 30,
  },
  {
    key: "first_sale_20",
    description: "20% of the customer's first payment only.",
    name: "20% of the first sale",
    brand: "irp",
    base: "first_sale",
    percent: 20,
    include: "all",
    holdDays: 30,
  },
];
