/**
 * financeAggregate.ts — pure financial aggregation over quote documents.
 *
 * No IO. Every function here takes plain objects and returns plain objects, so
 * the whole money layer is testable without Firestore.
 *
 * Money semantics come straight from quotesRouter.ts:
 *
 *   costSubtotal  Σ line.amount        what ILP pays providers
 *   total         Σ line clientPrice   what the client is charged
 *   earnings      total − costSubtotal  gross margin
 *
 * Three guards decide whether a figure is trustworthy:
 *
 *   1. Currency. Quotes carry their own `currency`. Summing USD and CRC gives a
 *      meaningless number, so a base currency is chosen and everything else is
 *      counted in `skipped.currency` instead of being folded in.
 *   2. Exclusive options. A quote with role 'exclusive' is one of several
 *      alternatives for the SAME deal, grouped by `optionGroupId`. Only one
 *      member of each group survives: the accepted one when the client has
 *      chosen, otherwise the largest.
 *   3. Zero-total quotes. A draft with no priced lines yet is not a $0 deal, it
 *      is an absence of data, so it never reaches an average.
 */

import { isQuoteAccepted, isQuoteAwaitingClient, isQuoteClientFacing } from "../../schemas/quoteStatus.ts";

// ── Input shape ──────────────────────────────────────────────────────────────

/** A quote document joined with the route/stage facts of its client. */
export interface FinanceQuote {
  quoteId: string;
  clientId: string;
  title?: string | null;
  status?: string | null;
  role?: string | null;
  optionGroupId?: string | null;
  currency?: string | null;
  /** What the client is charged. */
  total?: number | null;
  /** What ILP pays providers. */
  costSubtotal?: number | null;
  /** Gross margin. Recomputed when absent or inconsistent. */
  earnings?: number | null;
  createdAt?: string | null;
  sentToClientAt?: string | null;
  clientAcceptedAt?: string | null;
  serviceType?: string | null;
  legalArea?: string | null;
  providerIds?: string[] | null;
  providerSnapshots?: Array<{ providerId?: string; name?: string }> | null;
  /** Joined from the parent client. */
  jurisdiction?: string | null;
  pipelineStage?: string | null;
  clientName?: string | null;
}

// ── Output shapes ────────────────────────────────────────────────────────────

export interface MoneyStats {
  /** Number of quotes behind these figures. Never present a figure without it. */
  n: number;
  revenue: number;
  cost: number;
  margin: number;
  /** Gross margin as a percentage of revenue. Null when revenue is 0. */
  marginPct: number | null;
  avgDealSize: number | null;
}

export interface FinanceBucket extends MoneyStats {
  key: string;
  label: string;
}

export interface FinancePeriod extends MoneyStats {
  /** `YYYY-MM`. */
  month: string;
}

export interface FinanceTotals {
  /** Accepted by the client. The only figures that are real money. */
  won: MoneyStats;
  /** Approved or sent, not yet accepted. Weighted by nothing: raw face value. */
  openPipeline: MoneyStats;
  /** Still internal: draft, pending approval, changes requested. */
  draft: MoneyStats;
  /** Every quote that survived the guards, whatever its status. */
  all: MoneyStats;
}

export interface FinanceMetrics {
  baseCurrency: string;
  generatedAt: string;
  totals: FinanceTotals;
  /** Won quotes ÷ quotes that ever reached the client, as a percentage. */
  winRate: { sentOrBeyond: number; won: number; pct: number | null };
  /** Median days from first send to client acceptance, over won quotes. */
  cycleDays: { n: number; median: number | null };
  byMonth: FinancePeriod[];
  byRoute: FinanceBucket[];
  byService: FinanceBucket[];
  byProvider: FinanceBucket[];
  byStage: FinanceBucket[];
  /** Quotes excluded, and why. Surfaced so a low total can be explained. */
  skipped: {
    currency: number;
    zeroTotal: number;
    exclusiveAlternates: number;
    currencies: Record<string, number>;
  };
  /** Won quotes whose cost is missing, so their margin is unknowable. */
  marginUnknown: number;
}

// ── Status vocabulary ────────────────────────────────────────────────────────

/** Terminal: the client said yes. */
const WON_STATUS = "client_accepted";

/** Quote has left the building and is with the client. */
const CLIENT_FACING_STATUSES = new Set(["sent_to_client", WON_STATUS]);

/** Approved internally, or already with the client, but not yet accepted. */
const OPEN_STATUSES = new Set(["approved", "sent_to_client"]);

const DRAFT_STATUSES = new Set([
  "draft",
  "pending_approval",
  "changes_requested",
]);

// ── Small helpers ────────────────────────────────────────────────────────────

function money(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isWon(q: FinanceQuote): boolean {
  return isQuoteAccepted(q); // client_accepted / accepted / clientAcceptedAt (schemas/quoteStatus.ts)
}

/** Earliest date that tells us when this quote's money happened. */
function effectiveDate(q: FinanceQuote): string | null {
  return q.clientAcceptedAt || q.sentToClientAt || q.createdAt || null;
}

function monthOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Stats ────────────────────────────────────────────────────────────────────

function summarize(quotes: FinanceQuote[]): MoneyStats {
  let revenue = 0;
  let cost = 0;
  for (const q of quotes) {
    revenue += money(q.total);
    cost += money(q.costSubtotal);
  }
  revenue = round2(revenue);
  cost = round2(cost);
  const margin = round2(revenue - cost);
  return {
    n: quotes.length,
    revenue,
    cost,
    margin,
    marginPct: revenue > 0 ? round2((margin / revenue) * 100) : null,
    avgDealSize: quotes.length ? round2(revenue / quotes.length) : null,
  };
}

function bucket(
  quotes: FinanceQuote[],
  keyOf: (q: FinanceQuote) => string | null,
  labelOf: (key: string) => string = (k) => k,
): FinanceBucket[] {
  const groups = new Map<string, FinanceQuote[]>();
  for (const q of quotes) {
    const key = keyOf(q);
    if (!key) continue;
    const arr = groups.get(key);
    if (arr) arr.push(q);
    else groups.set(key, [q]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, label: labelOf(key), ...summarize(rows) }))
    .sort((a, b) => b.revenue - a.revenue || a.key.localeCompare(b.key));
}

/**
 * Provider buckets attribute the WHOLE quote to each provider named on it.
 * A quote with three providers therefore appears in three buckets, so these
 * revenue figures deliberately do not sum to the grand total.
 */
function providerBuckets(quotes: FinanceQuote[]): FinanceBucket[] {
  const names = new Map<string, string>();
  const groups = new Map<string, FinanceQuote[]>();
  for (const q of quotes) {
    const snaps = Array.isArray(q.providerSnapshots) ? q.providerSnapshots : [];
    const ids = new Set<string>();
    for (const s of snaps) {
      if (s?.providerId) {
        ids.add(s.providerId);
        if (s.name) names.set(s.providerId, s.name);
      }
    }
    for (const id of Array.isArray(q.providerIds) ? q.providerIds : []) {
      if (id) ids.add(id);
    }
    for (const id of ids) {
      const arr = groups.get(id);
      if (arr) arr.push(q);
      else groups.set(id, [q]);
    }
  }
  return [...groups.entries()]
    .map(([id, rows]) => ({
      key: id,
      label: names.get(id) ?? id,
      ...summarize(rows),
    }))
    .sort((a, b) => b.margin - a.margin || a.label.localeCompare(b.label));
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Collapse each `optionGroupId` of mutually exclusive alternatives down to the
 * single option that represents the deal.
 */
export function collapseExclusiveOptions(
  quotes: FinanceQuote[],
): { kept: FinanceQuote[]; dropped: number } {
  const groups = new Map<string, FinanceQuote[]>();
  const kept: FinanceQuote[] = [];

  for (const q of quotes) {
    if (q.role === "exclusive" && q.optionGroupId) {
      const gkey = `${q.clientId}\u0000${q.optionGroupId}`;
      const arr = groups.get(gkey);
      if (arr) arr.push(q);
      else groups.set(gkey, [q]);
    } else {
      kept.push(q);
    }
  }

  let dropped = 0;
  for (const members of groups.values()) {
    const accepted = members.filter(isWon);
    const winners = accepted.length
      ? accepted
      : [members.reduce((a, b) => (money(b.total) > money(a.total) ? b : a))];
    kept.push(...winners);
    dropped += members.length - winners.length;
  }

  return { kept, dropped };
}

// ── Entry point ──────────────────────────────────────────────────────────────

export interface AggregateOptions {
  /** Only quotes in this currency are summed. Default 'USD'. */
  baseCurrency?: string;
  /** Human labels for stage ids, so the UI needs no second lookup. */
  stageLabels?: Record<string, string>;
  /** Human labels for serviceType keys. */
  serviceLabels?: Record<string, string>;
}

export function aggregateFinance(
  input: FinanceQuote[],
  options: AggregateOptions = {},
): FinanceMetrics {
  const baseCurrency = (options.baseCurrency ?? "USD").toUpperCase();
  const stageLabels = options.stageLabels ?? {};
  const serviceLabels = options.serviceLabels ?? {};

  const skipped = {
    currency: 0,
    zeroTotal: 0,
    exclusiveAlternates: 0,
    currencies: {} as Record<string, number>,
  };

  // Guard 1 — one currency only.
  const sameCurrency: FinanceQuote[] = [];
  for (const q of input) {
    const cur = (q.currency ?? baseCurrency).toUpperCase();
    if (cur !== baseCurrency) {
      skipped.currency++;
      skipped.currencies[cur] = (skipped.currencies[cur] ?? 0) + 1;
      continue;
    }
    sameCurrency.push(q);
  }

  // Guard 2 — a priced quote, not an empty draft.
  const priced = sameCurrency.filter((q) => {
    if (money(q.total) > 0) return true;
    skipped.zeroTotal++;
    return false;
  });

  // Guard 3 — one option per exclusive group.
  const { kept, dropped } = collapseExclusiveOptions(priced);
  skipped.exclusiveAlternates = dropped;

  const won = kept.filter(isWon);
  const open = kept.filter((q) => !isWon(q) && (OPEN_STATUSES.has(q.status ?? "") || isQuoteAwaitingClient(q)));
  const draft = kept.filter((q) => DRAFT_STATUSES.has(q.status ?? ""));

  const clientFacing = kept.filter(
    (q) => CLIENT_FACING_STATUSES.has(q.status ?? "") || isQuoteClientFacing(q) || isWon(q),
  );

  const cycleValues: number[] = [];
  for (const q of won) {
    if (!q.sentToClientAt || !q.clientAcceptedAt) continue;
    const sent = new Date(q.sentToClientAt).getTime();
    const accepted = new Date(q.clientAcceptedAt).getTime();
    if (!Number.isFinite(sent) || !Number.isFinite(accepted)) continue;
    const days = (accepted - sent) / 86_400_000;
    if (days >= 0) cycleValues.push(days);
  }

  const byMonth = [
    ...new Map<string, FinanceQuote[]>(
      (() => {
        const m = new Map<string, FinanceQuote[]>();
        for (const q of won) {
          const month = monthOf(effectiveDate(q));
          if (!month) continue;
          const arr = m.get(month);
          if (arr) arr.push(q);
          else m.set(month, [q]);
        }
        return m;
      })(),
    ).entries(),
  ]
    .map(([month, rows]) => ({ month, ...summarize(rows) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const routeOf = (q: FinanceQuote) => {
    const j = (q.jurisdiction ?? "").trim();
    return j || null;
  };

  return {
    baseCurrency,
    generatedAt: new Date().toISOString(),
    totals: {
      won: summarize(won),
      openPipeline: summarize(open),
      draft: summarize(draft),
      all: summarize(kept),
    },
    winRate: {
      sentOrBeyond: clientFacing.length,
      won: won.length,
      pct: clientFacing.length
        ? round2((won.length / clientFacing.length) * 100)
        : null,
    },
    cycleDays: {
      n: cycleValues.length,
      median: (() => {
        const m = median(cycleValues);
        return m === null ? null : round2(m);
      })(),
    },
    byMonth,
    byRoute: bucket(kept, routeOf),
    byService: bucket(
      kept,
      (q) => q.serviceType || q.legalArea || null,
      (k) => serviceLabels[k] ?? k,
    ),
    byProvider: providerBuckets(kept),
    byStage: bucket(
      kept,
      (q) => q.pipelineStage || null,
      (k) => stageLabels[k] ?? k,
    ),
    skipped,
    marginUnknown: won.filter((q) => money(q.costSubtotal) === 0).length,
  };
}