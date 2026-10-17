/**
 * financeLedger.ts — settlement and ledger math.
 *
 * Pure, like financeAggregate.ts: plain objects in, plain objects out, no IO,
 * so every rule below is provable in a test script without a database.
 *
 * Two questions this answers that the metrics view cannot:
 *
 *   1. Of the money a won quote promises, how much has actually arrived, how
 *      much do we still owe providers, and what is left over. A quote worth
 *      $17,159 with $4,190 collected and $9,000 already paid to a provider is
 *      not a $17,159 asset, it is a $4,809 hole until the client pays again.
 *   2. Of the margin that survives, what did we spend it on, and did that
 *      spending earn anything back. Ad spend and a membership are not ordinary
 *      costs: they are meant to return more than they take, so they are tracked
 *      with a return figure and judged on it.
 *
 * Sign convention: every `amount` is stored positive. The `kind` of an entry
 * decides which direction it moves money. Nothing in this file negates a number
 * the caller supplied, so a mistyped minus can never silently flip a total.
 */

// ── Settlement: one accepted quote, its payments, and what it owes ───────────

/** A payment received from the client, or expected from them. */
export interface ClientPayment {
  id: string;
  /** ISO date the money moved. Absent means scheduled but not yet received. */
  date?: string | null;
  /**
   * Either an absolute figure or a share of the contract. Percent is how the
   * team actually talks ("they paid the 30% deposit"), so both are accepted and
   * resolved against the contract value at read time.
   */
  amount?: number | null;
  percent?: number | null;
  method?: string | null;
  note?: string | null;
  /** False for a scheduled instalment that has not landed. */
  received?: boolean;
}

/**
 * A client payment with `percent` already resolved to a concrete `amount`
 * against the contract value. This is what the report hands to the UI so the
 * frontend never has to do money arithmetic.
 */
export interface SettledClientPayment {
  id: string;
  date?: string | null;
  /** Resolved value in currency. `percent` has already been applied. */
  amount: number;
  method?: string | null;
  note?: string | null;
  /** False for a scheduled instalment that has not landed. */
  received: boolean;
}

/** Money owed to, or already paid to, a provider for this quote. */
export interface ProviderPayment {
  id: string;
  providerId?: string | null;
  providerName?: string | null;
  date?: string | null;
  amount?: number | null;
  /** False for a bill that is expected but not yet settled. */
  paid?: boolean;
  note?: string | null;
}

/**
 * Something billed to the client after the quote was accepted: a filing fee,
 * extra notarization, a change of scope.
 *
 * `cost` is what ILP pays out for it and defaults to 0, which means the charge
 * is pure margin. That default is deliberate: most after-the-fact charges are
 * pass-through fees the team adds no cost to.
 */
export interface ExtraCharge {
  id: string;
  date?: string | null;
  amount?: number | null;
  cost?: number | null;
  description?: string | null;
  /** False while the charge is agreed but not yet invoiced or collected. */
  collected?: boolean;
}

export interface QuoteSettlementInput {
  quoteId: string;
  clientId?: string | null;
  clientName?: string | null;
  currency?: string | null;
  /** Contract value: what the accepted quote charges the client. */
  contractValue?: number | null;
  /** What the quote expects to pay providers. */
  providerCost?: number | null;
  acceptedAt?: string | null;
  clientPayments?: ClientPayment[] | null;
  providerPayments?: ProviderPayment[] | null;
  extraCharges?: ExtraCharge[] | null;
}

export interface QuoteSettlement {
  quoteId: string;
  clientId: string | null;
  clientName: string | null;
  currency: string;
  acceptedAt: string | null;

  contractValue: number;
  /** Contract plus every extra charge agreed after acceptance. */
  billedTotal: number;
  collected: number;
  /** Collected as a share of billedTotal. Null when nothing is billed. */
  collectedPct: number | null;
  /** Still to be collected from the client. Negative means overpaid. */
  clientOutstanding: number;

  clientPayments: SettledClientPayment[];

  /** Quoted provider cost plus the cost of any extra charge. */
  providerCost: number;
  providerPaid: number;
  /** Provider money still to go out. Negative means overpaid. */
  providerOutstanding: number;

  /** billedTotal − providerCost. The margin if everyone pays in full. */
  expectedMargin: number;
  expectedMarginPct: number | null;
  /** collected − providerPaid. What this quote has actually put in the bank. */
  netCash: number;

  /** True when the client owes nothing and no provider bill is outstanding. */
  fullySettled: boolean;
}

// ── Ledger: money moving for reasons other than a single quote ───────────────

export type LedgerKind = "expense" | "income" | "investment";

export type Recurrence =
  | "none"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  /** Free-form, seeded from DEFAULT_LEDGER_CATEGORIES but never limited to it. */
  category?: string | null;
  label?: string | null;
  amount?: number | null;
  currency?: string | null;
  /** ISO date the money moved, or the first occurrence when recurring. */
  date?: string | null;
  recurrence?: Recurrence | null;
  /** When a recurring entry has stopped. Absent means still running. */
  endDate?: string | null;
  /**
   * Money this entry has earned back. Only meaningful for `investment`, where
   * it drives ROI. Left at 0 an investment simply reads as not yet returned.
   */
  returnAmount?: number | null;
  /**
   * Charge this against one quote's margin instead of the general pool. Used
   * for spending that exists only because of a specific deal.
   */
  quoteId?: string | null;
  note?: string | null;
}

/**
 * Starting categories. Seeds, not a schema: the API accepts any string, and
 * these exist so a new install is not an empty dropdown.
 */
export const DEFAULT_LEDGER_CATEGORIES: Record<LedgerKind, string[]> = {
  expense: [
    "payroll",
    "software",
    "office",
    "banking fees",
    "taxes",
    "travel",
    "professional services",
  ],
  income: ["referral fee", "commission", "interest", "other income"],
  investment: [
    "ads",
    "membership",
    "events",
    "content",
    "training",
    "equipment",
  ],
};

export interface CategoryRollup {
  kind: LedgerKind;
  category: string;
  n: number;
  amount: number;
  /** Only ever non-zero for investment categories. */
  returned: number;
  /** returned − amount for investments; null otherwise. */
  netReturn: number | null;
  /** Return as a percentage of what went in. Null when nothing went in. */
  roiPct: number | null;
}

export interface LedgerPeriod {
  /** `YYYY-MM`. */
  month: string;
  expense: number;
  income: number;
  investment: number;
  investmentReturn: number;
  /** income + investmentReturn − expense − investment. */
  net: number;
}

export interface FinanceLedgerReport {
  baseCurrency: string;
  generatedAt: string;

  settlements: QuoteSettlement[];
  settlementTotals: {
    n: number;
    contractValue: number;
    billedTotal: number;
    collected: number;
    clientOutstanding: number;
    providerCost: number;
    providerPaid: number;
    providerOutstanding: number;
    expectedMargin: number;
    netCash: number;
    fullySettled: number;
  };

  totals: {
    expense: number;
    income: number;
    investment: number;
    investmentReturn: number;
    /** What the recurring entries commit us to every month from here on. */
    recurringMonthly: number;
  };

  reinvestable: {
    realisedMargin: number;
    spent: number;
    remaining: number;
  };

  byCategory: CategoryRollup[];
  byMonth: LedgerPeriod[];
  /** Entries in another currency, listed rather than converted. */
  skippedCurrency: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function money(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function pctOf(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return round2((part / whole) * 100);
}

function monthOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A payment's value in currency. `percent` is resolved against the contract,
 * which is why the contract value has to be passed in rather than read later.
 */
function paymentValue(p: ClientPayment, contractValue: number): number {
  if (typeof p.amount === "number" && Number.isFinite(p.amount)) {
    return p.amount;
  }
  if (typeof p.percent === "number" && Number.isFinite(p.percent)) {
    return (p.percent / 100) * contractValue;
  }
  return 0;
}

/** How many times a recurrence repeats in a month, for the monthly commitment. */
function monthlyFactor(r: Recurrence | null | undefined): number {
  switch (r) {
    case "weekly":
      return 52 / 12;
    case "monthly":
      return 1;
    case "quarterly":
      return 1 / 3;
    case "yearly":
      return 1 / 12;
    default:
      return 0;
  }
}

/** True when a recurring entry has not been stopped before `asOf`. */
function stillRunning(e: LedgerEntry, asOf: Date): boolean {
  if (!e.endDate) return true;
  const end = new Date(e.endDate);
  return Number.isNaN(end.getTime()) ? true : end.getTime() >= asOf.getTime();
}

// ── Settlement ───────────────────────────────────────────────────────────────

/**
 * Resolve one quote's settlement.
 *
 * Only payments marked received count as collected, and only provider bills
 * marked paid count as paid. A scheduled instalment is a plan, not cash.
 */
export function settleQuote(input: QuoteSettlementInput): QuoteSettlement {
  const contractValue = money(input.contractValue);
  const extras = input.extraCharges ?? [];
  const clientPayments = input.clientPayments ?? [];
  const providerPayments = input.providerPayments ?? [];

  const extraBilled = extras.reduce((s, e) => s + money(e.amount), 0);
  const extraCost = extras.reduce((s, e) => s + money(e.cost), 0);

  const billedTotal = round2(contractValue + extraBilled);
  const providerCost = round2(money(input.providerCost) + extraCost);

  const settledPayments: SettledClientPayment[] = clientPayments.map((p) => ({
    id: p.id,
    date: p.date ?? null,
    amount: round2(paymentValue(p, contractValue)),
    method: p.method ?? null,
    note: p.note ?? null,
    received: p.received !== false,
  }));

  const collected = round2(
    settledPayments
      .filter((p) => p.received)
      .reduce((s, p) => s + p.amount, 0),
  );

  const providerPaid = round2(
    providerPayments
      .filter((p) => p.paid === true)
      .reduce((s, p) => s + money(p.amount), 0),
  );

  const clientOutstanding = round2(billedTotal - collected);
  const providerOutstanding = round2(providerCost - providerPaid);
  const expectedMargin = round2(billedTotal - providerCost);

  return {
    quoteId: input.quoteId,
    clientId: input.clientId ?? null,
    clientName: input.clientName ?? null,
    currency: (input.currency ?? "USD").toUpperCase(),
    acceptedAt: input.acceptedAt ?? null,

    contractValue: round2(contractValue),
    billedTotal,
    collected,
    collectedPct: pctOf(collected, billedTotal),
    clientOutstanding,

    clientPayments: settledPayments,

    providerCost,
    providerPaid,
    providerOutstanding,

    expectedMargin,
    expectedMarginPct: pctOf(expectedMargin, billedTotal),
    netCash: round2(collected - providerPaid),

    fullySettled: clientOutstanding <= 0 && providerOutstanding <= 0,
  };
}

// ── Report ───────────────────────────────────────────────────────────────────

export interface LedgerReportOptions {
  baseCurrency?: string;
  /** Reference date for "is this recurring entry still running". */
  asOf?: Date;
}

/**
 * Roll settlements and ledger entries into one report.
 *
 * Entries in a currency other than the base are counted in `skippedCurrency`
 * and left out, the same rule financeAggregate applies, so the two views can
 * never disagree about what a total includes.
 */
export function buildLedgerReport(
  settlementInputs: QuoteSettlementInput[],
  entries: LedgerEntry[],
  options: LedgerReportOptions = {},
): FinanceLedgerReport {
  const baseCurrency = (options.baseCurrency ?? "USD").toUpperCase();
  const asOf = options.asOf ?? new Date();

  const settlements = settlementInputs
    .filter((s) => (s.currency ?? "USD").toUpperCase() === baseCurrency)
    .map(settleQuote);

  const settlementTotals = settlements.reduce(
    (acc, s) => ({
      n: acc.n + 1,
      contractValue: acc.contractValue + s.contractValue,
      billedTotal: acc.billedTotal + s.billedTotal,
      collected: acc.collected + s.collected,
      clientOutstanding: acc.clientOutstanding + s.clientOutstanding,
      providerCost: acc.providerCost + s.providerCost,
      providerPaid: acc.providerPaid + s.providerPaid,
      providerOutstanding: acc.providerOutstanding + s.providerOutstanding,
      expectedMargin: acc.expectedMargin + s.expectedMargin,
      netCash: acc.netCash + s.netCash,
      fullySettled: acc.fullySettled + (s.fullySettled ? 1 : 0),
    }),
    {
      n: 0,
      contractValue: 0,
      billedTotal: 0,
      collected: 0,
      clientOutstanding: 0,
      providerCost: 0,
      providerPaid: 0,
      providerOutstanding: 0,
      expectedMargin: 0,
      netCash: 0,
      fullySettled: 0,
    },
  );
  for (const k of Object.keys(settlementTotals) as Array<
    keyof typeof settlementTotals
  >) {
    settlementTotals[k] = round2(settlementTotals[k]);
  }

  let skippedCurrency = 0;
  const usable: LedgerEntry[] = [];
  for (const e of entries) {
    if ((e.currency ?? baseCurrency).toUpperCase() !== baseCurrency) {
      skippedCurrency++;
      continue;
    }
    usable.push(e);
  }

  const totals = { expense: 0, income: 0, investment: 0, investmentReturn: 0 };
  const catMap = new Map<string, CategoryRollup>();
  const monthMap = new Map<string, LedgerPeriod>();
  let recurringMonthly = 0;

  for (const e of usable) {
    const amount = money(e.amount);
    const returned = e.kind === "investment" ? money(e.returnAmount) : 0;

    totals[e.kind] += amount;
    totals.investmentReturn += returned;

    if (e.recurrence && e.recurrence !== "none" && stillRunning(e, asOf)) {
      const perMonth = amount * monthlyFactor(e.recurrence);
      recurringMonthly += e.kind === "income" ? -perMonth : perMonth;
    }

    const category = (e.category ?? "uncategorised").trim() || "uncategorised";
    const catKey = `${e.kind}::${category}`;
    const cat = catMap.get(catKey) ?? {
      kind: e.kind,
      category,
      n: 0,
      amount: 0,
      returned: 0,
      netReturn: null,
      roiPct: null,
    };
    cat.n++;
    cat.amount += amount;
    cat.returned += returned;
    catMap.set(catKey, cat);

    const month = monthOf(e.date);
    if (month) {
      const p = monthMap.get(month) ?? {
        month,
        expense: 0,
        income: 0,
        investment: 0,
        investmentReturn: 0,
        net: 0,
      };
      p[e.kind] += amount;
      p.investmentReturn += returned;
      monthMap.set(month, p);
    }
  }

  const byCategory = [...catMap.values()]
    .map((c) => ({
      ...c,
      amount: round2(c.amount),
      returned: round2(c.returned),
      netReturn: c.kind === "investment" ? round2(c.returned - c.amount) : null,
      roiPct: c.kind === "investment" ? pctOf(c.returned - c.amount, c.amount) : null,
    }))
    .sort((a, b) => b.amount - a.amount);

  const byMonth = [...monthMap.values()]
    .map((p) => ({
      month: p.month,
      expense: round2(p.expense),
      income: round2(p.income),
      investment: round2(p.investment),
      investmentReturn: round2(p.investmentReturn),
      net: round2(p.income + p.investmentReturn - p.expense - p.investment),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const realisedMargin = settlementTotals.netCash;
  const spent = round2(totals.expense + totals.investment);

  return {
    baseCurrency,
    generatedAt: new Date().toISOString(),
    settlements,
    settlementTotals,
    totals: {
      expense: round2(totals.expense),
      income: round2(totals.income),
      investment: round2(totals.investment),
      investmentReturn: round2(totals.investmentReturn),
      recurringMonthly: round2(recurringMonthly),
    },
    reinvestable: {
      realisedMargin,
      spent,
      remaining: round2(realisedMargin + totals.income + totals.investmentReturn - spent),
    },
    byCategory,
    byMonth,
    skippedCurrency,
  };
}