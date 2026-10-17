/**
 * salesReport.ts — pure monthly sales / payment-funnel aggregation.
 *
 * No IO. Every function here takes plain objects and returns plain objects, so
 * the whole report is testable without Firestore, matching financeAggregate.ts
 * and financeLedger.ts.
 *
 * The report answers one question three ways, because the same business event
 * is recorded in several places and each reading is legitimate:
 *
 *   "entered"   — leads created, invoices raised, quotes created
 *   "started"   — invoice created, invoice sent, client moved into the
 *                 payment stage
 *   "recorded"  — invoice payments received, client marked paymentConfirmed
 *
 * On top of the counts it carries the MONEY behind each reading: what was
 * invoiced, collected, still outstanding, and the margin/cost on it. Money
 * semantics match financeAggregate.ts / financeLedger.ts:
 *
 *   invoiced    Σ invoice.total        what clients are charged
 *   collected   Σ invoice.received     what actually arrived
 *   outstanding Σ invoice.balanceDue   still owed
 *   margin      Σ invoice.marginTotal  our cut (total − costTotal)
 *   cost        Σ invoice.costTotal    what ILP pays providers
 *
 * Nothing is summed across the three readings: they are exposed side by side so
 * a figure that looks low can be explained rather than silently folded into a
 * single number. Percentages are `null` when the denominator is zero.
 *
 * Segmentation is chronological by year, with a monthly breakdown inside each
 * year, plus cross-cutting buckets (jurisdiction, service, provider, currency,
 * payment method) so the macro picture can be sliced the same way the Finance
 * tab does.
 */

// ── Input shapes ─────────────────────────────────────────────────────────────

/** A payment row on an invoice. `received !== false` means the money arrived. */
export interface ReportInvoicePayment {
  date?: string | null;
  amount?: number | null;
  received?: boolean;
  method?: string | null;
}

/** An invoice document, already decorated with `received` / `balanceDue`. */
export interface ReportInvoice {
  id: string;
  invoiceNumber?: string | null;
  quoteId?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  total?: number | null;
  received?: number | null;
  balanceDue?: number | null;
  status?: string | null;
  createdAt?: string | null;
  date?: string | null;
  sentAt?: string | null;
  payments?: ReportInvoicePayment[] | null;
  currency?: string | null;
  costTotal?: number | null;
  marginTotal?: number | null;
}

/** A client document (raw Firestore shape, not the client summary). */
export interface ReportClient {
  docId: string;
  data: {
    stage?: string | null;
    paymentConfirmed?: boolean;
    paymentConfirmedAt?: string | null;
    paymentAmount?: number | null;
    paymentCurrency?: string | null;
    createdAt?: string | null;
    jurisdiction?: string | null;
    consultations?: Array<{ timestamp?: string | null }> | null;
    activityLog?: Array<{ type?: string; to?: string; timestamp?: string }> | null;
  };
}

/** A quote document joined with its client id. */
export interface ReportQuote {
  quoteId: string;
  clientId?: string | null;
  createdAt?: string | null;
  clientAcceptedAt?: string | null;
  status?: string | null;
  total?: number | null;
  costSubtotal?: number | null;
  currency?: string | null;
  serviceType?: string | null;
  legalArea?: string | null;
  providerSnapshots?: Array<{ providerId?: string; name?: string }> | null;
}

/** The payment_counters document (metrics/payment_counters). */
export interface ReportCounters {
  total?: { count?: number; amount?: number };
  weeks?: Record<string, { count?: number; amount?: number }>;
  months?: Record<string, { count?: number; amount?: number }>;
}

// ── Output shapes ─────────────────────────────────────────────────────────────

/** One month's counts and money across every reading. */
export interface SalesMonth {
  /** `YYYY-MM`. */
  month: string;
  // Counts
  leadsEntered: number;
  invoicesEntered: number;
  quotesEntered: number;
  invoicesStarted: number;
  invoicesSent: number;
  clientsStartedPayment: number;
  invoicePaymentsRecorded: number;
  clientsPaymentConfirmed: number;
  counterBumps: number;
  // Money (invoice-derived)
  invoiced: number;
  collected: number;
  outstanding: number;
  margin: number;
  cost: number;
}

/** One year's rollup plus its monthly breakdown. */
export interface SalesYear {
  /** `YYYY`. */
  year: string;
  months: SalesMonth[];
  totals: SalesMonth;
}

/** A cross-cutting money bucket (jurisdiction, service, provider, currency, method). */
export interface SalesBucket {
  key: string;
  label: string;
  n: number;
  invoiced: number;
  collected: number;
  outstanding: number;
  margin: number;
}

/** A project completion row, with the source that supplied the date + money. */
export interface ProjectCompletion {
  kind: "quote" | "client" | "invoice";
  id: string;
  label: string;
  /** ISO date the payments were completed, or null when not yet complete. */
  completedAt: string | null;
  /** Human-readable source of the completion signal. */
  source: string;
  /** Money detail (invoice-derived; 0 for non-invoice rows). */
  contractValue: number;
  collected: number;
  outstanding: number;
  margin: number;
}

/** A percentage pair, null when the denominator is zero. */
export interface FunnelPct {
  numerator: number;
  denominator: number;
  pct: number | null;
}

export interface SalesReport {
  generatedAt: string;
  /** Sorted ascending list of every year present across all sources. */
  years: string[];
  byYear: SalesYear[];
  /** Grand totals across every year. */
  totals: SalesMonth;
  /** Funnel percentages, one pair per reading. */
  funnel: {
    startedOfEntered: { invoice: FunnelPct; client: FunnelPct; quote: FunnelPct };
    recordedOfEntered: { invoice: FunnelPct; client: FunnelPct };
    recordedOfStarted: { invoice: FunnelPct; client: FunnelPct };
  };
  /** collected ÷ invoiced, null when nothing was invoiced. */
  collectionRate: FunnelPct;
  /** Cross-cutting money buckets. */
  byJurisdiction: SalesBucket[];
  byService: SalesBucket[];
  byProvider: SalesBucket[];
  byCurrency: SalesBucket[];
  byPaymentMethod: SalesBucket[];
  /** Project completion rows, newest first. */
  projects: ProjectCompletion[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function money(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function monthOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyMonth(month: string): SalesMonth {
  return {
    month,
    leadsEntered: 0,
    invoicesEntered: 0,
    quotesEntered: 0,
    invoicesStarted: 0,
    invoicesSent: 0,
    clientsStartedPayment: 0,
    invoicePaymentsRecorded: 0,
    clientsPaymentConfirmed: 0,
    counterBumps: 0,
    invoiced: 0,
    collected: 0,
    outstanding: 0,
    margin: 0,
    cost: 0,
  };
}

function bump(map: Map<string, SalesMonth>, month: string | null, key: keyof SalesMonth): void {
  if (!month) return;
  const row = map.get(month) ?? emptyMonth(month);
  (row as unknown as Record<string, unknown>)[key] = (row[key] as number) + 1;
  map.set(month, row);
}

function addMoney(
  map: Map<string, SalesMonth>,
  month: string | null,
  key: keyof SalesMonth,
  value: number,
): void {
  if (!month) return;
  const row = map.get(month) ?? emptyMonth(month);
  (row as unknown as Record<string, unknown>)[key] = round2((row[key] as number) + value);
  map.set(month, row);
}

function pct(numerator: number, denominator: number): FunnelPct {
  return {
    numerator: round2(numerator),
    denominator: round2(denominator),
    pct: denominator > 0 ? round2((numerator / denominator) * 100) : null,
  };
}

function sumMonths(months: SalesMonth[]): SalesMonth {
  const total = emptyMonth("total");
  for (const m of months) {
    for (const k of Object.keys(total) as Array<keyof SalesMonth>) {
      if (k === "month") continue;
      (total as unknown as Record<string, unknown>)[k] = round2(
        (total[k] as number) + ((m[k] as number) ?? 0),
      );
    }
  }
  return total;
}

/** The earliest date a lead entered, from the first consultation timestamp. */
function leadEnteredAt(data: ReportClient["data"]): string | null {
  const entries = Array.isArray(data.consultations) ? data.consultations : [];
  const first = entries[0]?.timestamp;
  if (typeof first === "string" && first) return first;
  return data.createdAt ?? null;
}

/** True when a client has ever entered a payment stage. */
function clientStartedPaymentAt(data: ReportClient["data"]): string | null {
  const log = Array.isArray(data.activityLog) ? data.activityLog : [];
  let earliest: string | null = null;
  for (const entry of log) {
    if (entry?.type === "stage_change" && entry?.to === "payment") {
      const ts = entry.timestamp;
      if (typeof ts === "string" && ts && (!earliest || ts < earliest)) earliest = ts;
    }
  }
  return earliest;
}

// ── Bucketing ─────────────────────────────────────────────────────────────────

interface InvoiceFacts {
  jurisdiction: string | null;
  service: string | null;
  providers: string[];
}

/**
 * Join an invoice against its client (jurisdiction) and quote (service,
 * providers) so the money buckets can slice the same way the Finance tab does.
 */
function resolveInvoiceFacts(
  inv: ReportInvoice,
  clientFacts: Map<string, ReportClient["data"]>,
  quoteFacts: Map<string, ReportQuote>,
): InvoiceFacts {
  const client = inv.clientId ? clientFacts.get(inv.clientId) : undefined;
  const jurisdiction = (client?.jurisdiction ?? "").trim() || null;

  const quote = inv.quoteId ? quoteFacts.get(inv.quoteId) : undefined;
  const service = quote?.serviceType?.trim() || quote?.legalArea?.trim() || null;
  const providers: string[] = [];
  for (const s of Array.isArray(quote?.providerSnapshots) ? quote.providerSnapshots : []) {
    if (s?.name) providers.push(s.name);
  }

  return { jurisdiction, service, providers };
}

function bucketInvoices(
  invoices: ReportInvoice[],
  keyOf: (inv: ReportInvoice) => string | null,
  labelOf: (key: string) => string = (k) => k,
): SalesBucket[] {
  const groups = new Map<string, ReportInvoice[]>();
  for (const inv of invoices) {
    const key = keyOf(inv);
    if (!key) continue;
    const arr = groups.get(key);
    if (arr) arr.push(inv);
    else groups.set(key, [inv]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => {
      let invoiced = 0;
      let collected = 0;
      let outstanding = 0;
      let margin = 0;
      for (const r of rows) {
        invoiced += money(r.total);
        collected += money(r.received);
        outstanding += money(r.balanceDue);
        margin += money(r.marginTotal);
      }
      return {
        key,
        label: labelOf(key),
        n: rows.length,
        invoiced: round2(invoiced),
        collected: round2(collected),
        outstanding: round2(outstanding),
        margin: round2(margin),
      };
    })
    .sort((a, b) => b.invoiced - a.invoiced || a.label.localeCompare(b.label));
}

// ── Entry point ───────────────────────────────────────────────────────────────

export interface SalesReportInput {
  invoices: ReportInvoice[];
  clients: ReportClient[];
  quotes: ReportQuote[];
  counters: ReportCounters;
}

export function buildSalesReport(input: SalesReportInput): SalesReport {
  const monthMap = new Map<string, SalesMonth>();

  // Join tables for the money buckets.
  const clientFacts = new Map<string, ReportClient["data"]>();
  for (const c of input.clients) clientFacts.set(c.docId, c.data);
  const quoteFacts = new Map<string, ReportQuote>();
  for (const q of input.quotes) quoteFacts.set(q.quoteId, q);

  // ── Invoices ────────────────────────────────────────────────────────────────
  for (const inv of input.invoices) {
    const m = monthOf(inv.createdAt);
    bump(monthMap, m, "invoicesEntered");
    bump(monthMap, m, "invoicesStarted");
    bump(monthMap, monthOf(inv.sentAt), "invoicesSent");
    addMoney(monthMap, m, "invoiced", money(inv.total));
    addMoney(monthMap, m, "collected", money(inv.received));
    addMoney(monthMap, m, "outstanding", money(inv.balanceDue));
    addMoney(monthMap, m, "margin", money(inv.marginTotal));
    addMoney(monthMap, m, "cost", money(inv.costTotal));
    const payments = Array.isArray(inv.payments) ? inv.payments : [];
    for (const p of payments) {
      if (p.received !== false) {
        bump(monthMap, monthOf(p.date), "invoicePaymentsRecorded");
      }
    }
  }

  // ── Clients ─────────────────────────────────────────────────────────────────
  for (const { data } of input.clients) {
    bump(monthMap, monthOf(leadEnteredAt(data)), "leadsEntered");
    bump(monthMap, monthOf(clientStartedPaymentAt(data)), "clientsStartedPayment");
    if (data.paymentConfirmed) {
      bump(monthMap, monthOf(data.paymentConfirmedAt), "clientsPaymentConfirmed");
    }
  }

  // ── Quotes ──────────────────────────────────────────────────────────────────
  for (const q of input.quotes) {
    bump(monthMap, monthOf(q.createdAt), "quotesEntered");
  }

  // ── Counters ────────────────────────────────────────────────────────────────
  const counterMonths = input.counters.months ?? {};
  for (const [month, bucket] of Object.entries(counterMonths)) {
    const count = bucket?.count ?? 0;
    if (count > 0) {
      const row = monthMap.get(month) ?? emptyMonth(month);
      row.counterBumps += count;
      monthMap.set(month, row);
    }
  }

  // ── Group by year ───────────────────────────────────────────────────────────
  const yearMap = new Map<string, SalesMonth[]>();
  for (const [month, row] of monthMap) {
    const year = month.slice(0, 4);
    const arr = yearMap.get(year) ?? [];
    arr.push(row);
    yearMap.set(year, arr);
  }

  const years = [...yearMap.keys()].sort();
  const byYear: SalesYear[] = years.map((year) => {
    const months = (yearMap.get(year) ?? []).sort((a, b) => a.month.localeCompare(b.month));
    return { year, months, totals: sumMonths(months) };
  });

  const totals = sumMonths([...monthMap.values()]);

  // ── Funnel percentages ──────────────────────────────────────────────────────
  const funnel: SalesReport["funnel"] = {
    startedOfEntered: {
      invoice: pct(totals.invoicesStarted, totals.invoicesEntered),
      client: pct(totals.clientsStartedPayment, totals.leadsEntered),
      quote: pct(totals.quotesEntered, totals.quotesEntered),
    },
    recordedOfEntered: {
      invoice: pct(totals.invoicePaymentsRecorded, totals.invoicesEntered),
      client: pct(totals.clientsPaymentConfirmed, totals.leadsEntered),
    },
    recordedOfStarted: {
      invoice: pct(totals.invoicePaymentsRecorded, totals.invoicesStarted),
      client: pct(totals.clientsPaymentConfirmed, totals.clientsStartedPayment),
    },
  };

  const collectionRate = pct(totals.collected, totals.invoiced);

  // ── Cross-cutting money buckets ─────────────────────────────────────────────
  const byJurisdiction = bucketInvoices(
    input.invoices,
    (inv) => resolveInvoiceFacts(inv, clientFacts, quoteFacts).jurisdiction,
  );
  const byService = bucketInvoices(
    input.invoices,
    (inv) => resolveInvoiceFacts(inv, clientFacts, quoteFacts).service,
  );
  const byProvider = (() => {
    const names = new Map<string, string>();
    const groups = new Map<string, ReportInvoice[]>();
    for (const inv of input.invoices) {
      const facts = resolveInvoiceFacts(inv, clientFacts, quoteFacts);
      for (const name of facts.providers) {
        if (!names.has(name)) names.set(name, name);
        const arr = groups.get(name);
        if (arr) arr.push(inv);
        else groups.set(name, [inv]);
      }
    }
    return [...groups.entries()]
      .map(([key, rows]) => {
        let invoiced = 0;
        let collected = 0;
        let outstanding = 0;
        let margin = 0;
        for (const r of rows) {
          invoiced += money(r.total);
          collected += money(r.received);
          outstanding += money(r.balanceDue);
          margin += money(r.marginTotal);
        }
        return {
          key,
          label: names.get(key) ?? key,
          n: rows.length,
          invoiced: round2(invoiced),
          collected: round2(collected),
          outstanding: round2(outstanding),
          margin: round2(margin),
        };
      })
      .sort((a, b) => b.margin - a.margin || a.label.localeCompare(b.label));
  })();
  const byCurrency = bucketInvoices(
    input.invoices,
    (inv) => (inv.currency ?? "USD").toUpperCase() || null,
  );
  const byPaymentMethod = (() => {
    const groups = new Map<string, { n: number; amount: number }>();
    for (const inv of input.invoices) {
      for (const p of Array.isArray(inv.payments) ? inv.payments : []) {
        if (p.received === false) continue;
        const method = (p.method ?? "unspecified").trim() || "unspecified";
        const g = groups.get(method) ?? { n: 0, amount: 0 };
        g.n += 1;
        g.amount += money(p.amount);
        groups.set(method, g);
      }
    }
    return [...groups.entries()]
      .map(([key, g]) => ({
        key,
        label: key,
        n: g.n,
        invoiced: 0,
        collected: round2(g.amount),
        outstanding: 0,
        margin: 0,
      }))
      .sort((a, b) => b.collected - a.collected || a.label.localeCompare(b.label));
  })();

  // ── Project completion ──────────────────────────────────────────────────────
  const projects: ProjectCompletion[] = [];

  for (const inv of input.invoices) {
    const complete = inv.status === "paid";
    projects.push({
      kind: "invoice",
      id: inv.id,
      label: inv.invoiceNumber || inv.clientName || inv.id,
      completedAt: complete ? (inv.sentAt ?? inv.date ?? inv.createdAt ?? null) : null,
      source: complete ? "invoice status = paid" : "invoice not yet paid",
      contractValue: round2(money(inv.total)),
      collected: round2(money(inv.received)),
      outstanding: round2(money(inv.balanceDue)),
      margin: round2(money(inv.marginTotal)),
    });
  }

  for (const { docId, data } of input.clients) {
    const complete = !!data.paymentConfirmed;
    projects.push({
      kind: "client",
      id: docId,
      label: docId,
      completedAt: complete ? (data.paymentConfirmedAt ?? null) : null,
      source: complete ? "paymentConfirmed" : "payment not confirmed",
      contractValue: 0,
      collected: round2(money(data.paymentAmount)),
      outstanding: 0,
      margin: 0,
    });
  }

  for (const q of input.quotes) {
    const complete = q.status === "client_accepted" || !!q.clientAcceptedAt;
    projects.push({
      kind: "quote",
      id: q.quoteId,
      label: q.quoteId,
      completedAt: complete ? (q.clientAcceptedAt ?? null) : null,
      source: complete ? "quote accepted" : "quote not accepted",
      contractValue: round2(money(q.total)),
      collected: 0,
      outstanding: 0,
      margin: round2(money(q.total) - money(q.costSubtotal)),
    });
  }

  projects.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));

  return {
    generatedAt: new Date().toISOString(),
    years,
    byYear,
    totals,
    funnel,
    collectionRate,
    byJurisdiction,
    byService,
    byProvider,
    byCurrency,
    byPaymentMethod,
    projects,
  };
}