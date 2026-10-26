/**
 * financeLedgerRouter.ts — settlements on accepted quotes, and the money ledger.
 *
 *   GET    /api/dashboard/finance/ledger                 the whole report
 *   PUT    /api/dashboard/finance/settlements/:quoteId   payments on one quote
 *   POST   /api/dashboard/finance/ledger/entries         add expense/income/investment
 *   PUT    /api/dashboard/finance/ledger/entries/:id     edit one
 *   DELETE /api/dashboard/finance/ledger/entries/:id     remove one
 *
 * Two collections, both flat and both new, so nothing existing changes shape:
 *
 *   quoteSettlements/{quoteId}   payments received, provider bills, extra charges
 *   financeLedger/{entryId}      spending and earning outside any single quote
 *
 * A settlement never stores a total. Contract value and provider cost are read
 * from the accepted quote every time the report is built, so editing a quote
 * can never leave a stale figure behind in a second place.
 *
 * The arithmetic all lives in financeLedger.ts. This file only reads, writes,
 * and validates.
 *
 * ILP tailoring: IRP's move-taxonomy endpoints (modalities/packing/cargo) are
 * relocation-specific and dropped. Audit uses ILP's auditLog instead of IRP's
 * recordStaffAction, and quotes join on `clientId` (not `consultationId`).
 */

import type { Application, Request, Response } from "express";
import log from "../../helper/log.ts";
import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import remove from "../../db/delete.ts";
import auditLog from "../../helper/auditLog.ts";
import { FINANCE_ADMIN } from "./financeAuth.ts";
import { fetchAcceptedQuotes, invalidateFinanceCache } from "./financeQuoteSource.ts";
import {
  buildLedgerReport,
  DEFAULT_LEDGER_CATEGORIES,
  type LedgerEntry,
  type LedgerKind,
  type QuoteSettlementInput,
  type Recurrence,
} from "./financeLedger.ts";

const SETTLEMENTS = "quoteSettlements";
const LEDGER = "financeLedger";

const KINDS: LedgerKind[] = ["expense", "income", "investment"];
const RECURRENCES: Recurrence[] = [
  "none",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];

// ── Validation ───────────────────────────────────────────────────────────────
//
// Everything below rejects rather than coerces. A payment silently saved as 0
// because the field arrived as "1,200.00" is worse than an error message.

function positiveNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function optionalNumber(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return positiveNumber(v);
}

function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanId(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  return s || fallback;
}

/** `line` is only used to make an error message point at the offending row. */
function parseClientPayments(raw: unknown, errors: string[]): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p: any, i) => {
    const amount = optionalNumber(p?.amount);
    const percent = optionalNumber(p?.percent);
    if (amount === null) errors.push(`clientPayments[${i}].amount is not a number`);
    if (percent === null) errors.push(`clientPayments[${i}].percent is not a number`);
    if (amount === undefined && percent === undefined) {
      errors.push(`clientPayments[${i}] needs an amount or a percent`);
    }
    return {
      id: cleanId(p?.id, `cp-${Date.now()}-${i}`),
      date: isoDateOrNull(p?.date),
      amount: amount ?? null,
      percent: percent ?? null,
      method: typeof p?.method === "string" ? p.method.slice(0, 120) : null,
      note: typeof p?.note === "string" ? p.note.slice(0, 500) : null,
      // Default true: a row typed into the payments table is normally money
      // that already arrived. Scheduling is the deliberate, explicit case.
      received: p?.received !== false,
    };
  });
}

function parseProviderPayments(raw: unknown, errors: string[]): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p: any, i) => {
    const amount = optionalNumber(p?.amount);
    if (amount === null) errors.push(`providerPayments[${i}].amount is not a number`);
    return {
      id: cleanId(p?.id, `pp-${Date.now()}-${i}`),
      providerId: typeof p?.providerId === "string" ? p.providerId : null,
      providerName: typeof p?.providerName === "string" ? p.providerName.slice(0, 200) : null,
      date: isoDateOrNull(p?.date),
      amount: amount ?? null,
      // Default false: an unpaid bill is the safe assumption, because counting
      // it as paid would overstate how much cash has left the business.
      paid: p?.paid === true,
      note: typeof p?.note === "string" ? p.note.slice(0, 500) : null,
    };
  });
}

function parseExtraCharges(raw: unknown, errors: string[]): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e: any, i) => {
    const amount = optionalNumber(e?.amount);
    const cost = optionalNumber(e?.cost);
    if (amount === null) errors.push(`extraCharges[${i}].amount is not a number`);
    if (cost === null) errors.push(`extraCharges[${i}].cost is not a number`);
    return {
      id: cleanId(e?.id, `ex-${Date.now()}-${i}`),
      date: isoDateOrNull(e?.date),
      amount: amount ?? 0,
      // 0 by default: an extra charge is pure margin unless a cost is stated.
      cost: cost ?? 0,
      description: typeof e?.description === "string" ? e.description.slice(0, 500) : null,
      collected: e?.collected === true,
    };
  });
}

function parseLedgerEntry(
  body: any,
  id: string,
  errors: string[],
): LedgerEntry {
  const kind: LedgerKind = KINDS.includes(body?.kind) ? body.kind : "expense";
  if (!KINDS.includes(body?.kind)) {
    errors.push(`kind must be one of ${KINDS.join(", ")}`);
  }

  const amount = positiveNumber(body?.amount);
  if (amount === null) errors.push("amount must be a number of 0 or more");

  const recurrence: Recurrence = RECURRENCES.includes(body?.recurrence)
    ? body.recurrence
    : "none";

  const returnAmount = optionalNumber(body?.returnAmount);
  if (returnAmount === null) errors.push("returnAmount is not a number");
  if (kind !== "investment" && returnAmount) {
    errors.push("returnAmount only applies to an investment");
  }

  return {
    id,
    kind,
    category: typeof body?.category === "string" ? body.category.trim().slice(0, 80) : null,
    label: typeof body?.label === "string" ? body.label.trim().slice(0, 200) : null,

    amount: amount ?? 0,
    currency: (typeof body?.currency === "string" ? body.currency : "USD")
      .toUpperCase()
      .slice(0, 3),
    date: isoDateOrNull(body?.date) ?? new Date().toISOString(),
    recurrence,
    endDate: isoDateOrNull(body?.endDate),
    returnAmount: returnAmount ?? 0,
    quoteId: typeof body?.quoteId === "string" && body.quoteId ? body.quoteId : null,
    note: typeof body?.note === "string" ? body.note.slice(0, 1000) : null,
  };
}

// ── Audit helpers ────────────────────────────────────────────────────────────

/**
 * Who is making the request. `requireDashboardAuth` puts the session email on
 * the request as a plain string, so this is the only correct way to read it.
 */
function actorOf(req: Request): string {
  const user = (req as any).dashboardUser;
  return typeof user === "string" && user ? user : "unknown";
}

/** Build an auditLog actor from the dashboard email string. */
function auditActor(req: Request) {
  const email = actorOf(req);
  return { uid: email, email, role: "staff" };
}

function sumOf<T>(rows: T[], pick: (row: T) => number | null | undefined): number {
  return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
}

/**
 * The fields worth keeping about an entry. Deliberately a subset: the history
 * should stay readable, and a full document copy on every edit would bloat it.
 */
function entrySnapshot(entry: LedgerEntry): Record<string, unknown> {
  return {
    kind: entry.kind,
    category: entry.category,
    label: entry.label,
    amount: entry.amount,
    currency: entry.currency,
    date: entry.date,
    recurrence: entry.recurrence,
    returnAmount: entry.returnAmount,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export default function financeLedgerRouter(app: Application) {
  /**
   * The report. Accepted quotes are the spine: every one of them appears, with
   * or without a settlement document, so a quote nobody has recorded a payment
   * against shows up as fully outstanding instead of being invisible.
   */
  app.get(
    "/api/dashboard/finance/ledger",
    ...FINANCE_ADMIN,
    async (req: Request, res: Response) => {
      try {
        const baseCurrency =
          typeof req.query.currency === "string" && req.query.currency
            ? req.query.currency
            : "USD";

        const [accepted, settlementDocs, entryDocs] = await Promise.all([
          fetchAcceptedQuotes(),
          getAll(SETTLEMENTS),
          getAll(LEDGER),
        ]);

        const byQuote = new Map<string, any>();
        for (const d of settlementDocs) {
          if (d?.id) byQuote.set(d.id, d);
        }

        const inputs: QuoteSettlementInput[] = accepted.map((q: any) => {
          const s = byQuote.get(q.quoteId) ?? {};
          return {
            quoteId: q.quoteId,
            clientId: q.clientId,
            clientName: q.clientName,
            currency: q.currency,
            // Always from the quote, never from the settlement document.
            contractValue: q.total,
            providerCost: q.costSubtotal,
            acceptedAt: q.clientAcceptedAt,
            clientPayments: Array.isArray(s.clientPayments) ? s.clientPayments : [],
            providerPayments: Array.isArray(s.providerPayments) ? s.providerPayments : [],
            extraCharges: Array.isArray(s.extraCharges) ? s.extraCharges : [],
          };
        });

        const entries: LedgerEntry[] = entryDocs
          .filter((d) => d?.id)
          .map((d) => ({ ...d, id: d.id }) as LedgerEntry);

        const report = buildLedgerReport(inputs, entries, { baseCurrency });

        // The editor needs the rows exactly as they were saved, not just the
        // derived totals, so reopening a quote shows what was typed rather than
        // an empty form.
        const rawSettlements: Record<string, unknown> = {};
        for (const [quoteId, doc] of byQuote) {
          rawSettlements[quoteId] = {
            clientPayments: doc.clientPayments ?? [],
            providerPayments: doc.providerPayments ?? [],
            extraCharges: doc.extraCharges ?? [],
          };
        }

        res.json({
          ...report,
          entries,
          rawSettlements,
          categories: DEFAULT_LEDGER_CATEGORIES,
          acceptedQuotesRead: accepted.length,
        });
      } catch (err: any) {
        log(`[financeLedgerRouter] GET ledger: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to build the ledger" });
      }
    },
  );

  /** Replace the payment rows of one accepted quote. */
  app.put(
    "/api/dashboard/finance/settlements/:quoteId",
    ...FINANCE_ADMIN,
    async (req: Request, res: Response) => {
      const quoteId = String(req.params.quoteId ?? "").trim();
      if (!quoteId) {
        return res.status(400).json({ error: "A quote id is required" });
      }

      const actor = actorOf(req);

      const errors: string[] = [];
      const doc = {
        quoteId,
        clientId:
          typeof req.body?.clientId === "string" ? req.body.clientId : null,
        clientPayments: parseClientPayments(req.body?.clientPayments, errors),
        providerPayments: parseProviderPayments(req.body?.providerPayments, errors),
        extraCharges: parseExtraCharges(req.body?.extraCharges, errors),
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };

      if (errors.length) return res.status(400).json({ error: errors.join("; ") });

      try {
        await put(SETTLEMENTS, quoteId, doc);
        // The report joins settlements against the cached quote read, so a
        // stale cache would show the operator their old numbers on reload.
        invalidateFinanceCache();

        await auditLog({
          actor: auditActor(req),
          action: "finance.settlement.updated",
          target: `quoteSettlements/${quoteId}`,
          meta: {
            clientId: doc.clientId,
            clientPaymentCount: doc.clientPayments.length,
            providerPaymentCount: doc.providerPayments.length,
            extraChargeCount: doc.extraCharges.length,
            receivedTotal: sumOf(doc.clientPayments, (p) => (p.received ? p.amount : 0)),
            providerPaidTotal: sumOf(doc.providerPayments, (p) => (p.paid ? p.amount : 0)),
          },
        });

        res.json({ ok: true, settlement: doc });
      } catch (err: any) {
        log(`[financeLedgerRouter] PUT settlement ${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to save the settlement" });
      }
    },
  );

  app.post(
    "/api/dashboard/finance/ledger/entries",
    ...FINANCE_ADMIN,
    async (req: Request, res: Response) => {
      const id = `le-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const actor = actorOf(req);
      const errors: string[] = [];
      const entry = parseLedgerEntry(req.body, id, errors);
      if (errors.length) return res.status(400).json({ error: errors.join("; ") });

      try {
        await put(LEDGER, id, {
          ...entry,
          createdAt: new Date().toISOString(),
          createdBy: actor,
        });

        await auditLog({
          actor: auditActor(req),
          action: "finance.ledger_entry.created",
          target: `financeLedger/${id}`,
          meta: entrySnapshot(entry),
        });

        res.json({ ok: true, entry });
      } catch (err: any) {
        log(`[financeLedgerRouter] POST entry: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to save the entry" });
      }
    },
  );

  app.put(
    "/api/dashboard/finance/ledger/entries/:id",
    ...FINANCE_ADMIN,
    async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An entry id is required" });

      const actor = actorOf(req);
      const errors: string[] = [];
      const entry = parseLedgerEntry(req.body, id, errors);
      if (errors.length) return res.status(400).json({ error: errors.join("; ") });

      try {
        await put(LEDGER, id, {
          ...entry,
          updatedAt: new Date().toISOString(),
          updatedBy: actor,
        });

        await auditLog({
          actor: auditActor(req),
          action: "finance.ledger_entry.updated",
          target: `financeLedger/${id}`,
          meta: entrySnapshot(entry),
        });

        res.json({ ok: true, entry });
      } catch (err: any) {
        log(`[financeLedgerRouter] PUT entry ${id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to save the entry" });
      }
    },
  );

  app.delete(
    "/api/dashboard/finance/ledger/entries/:id",
    ...FINANCE_ADMIN,
    async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An entry id is required" });

      try {
        // Read before deleting: once the document is gone, the history is the
        // only place left that says what the deleted entry actually was.
        const existing = (await getAll(LEDGER)).find((d: any) => d?.id === id);

        await remove(LEDGER, id);

        await auditLog({
          actor: auditActor(req),
          action: "finance.ledger_entry.deleted",
          target: `financeLedger/${id}`,
          meta: existing ? entrySnapshot(existing as unknown as LedgerEntry) : {},
        });

        res.json({ ok: true });
      } catch (err: any) {
        log(`[financeLedgerRouter] DELETE entry ${id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to delete the entry" });
      }
    },
  );
}