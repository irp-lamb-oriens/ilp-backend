/**
 * salesReportRouter.ts — read-only monthly sales / payment-funnel report.
 *
 *   GET /api/dashboard/sales-report   (requireDashboardAuth)
 *
 * Reads the sources of payment truth in parallel and delegates all arithmetic
 * to the pure module in salesReport.ts:
 *
 *   - invoices        (top-level `invoices` collection)
 *   - clients         (top-level `clients` collection)
 *   - quotes          (read via financeQuoteSource)
 *   - payment_counters (metrics/payment_counters doc)
 *
 * ILP invoices do not persist `received`, `balanceDue`, `status`, `currency`,
 * `costTotal` or `marginTotal`. The first three are derived from `total` and
 * `payments` exactly as invoicesRouter.decorate does; the money fields default
 * to null (0 in the report) because ILP invoices carry no provider cost.
 *
 * Nothing here writes. The endpoint is safe to call repeatedly and is purely
 * additive: no existing endpoint or document shape changes.
 */

import type { Application, Request, Response } from "express";
import log from "../../helper/log.ts";
import getAll from "../../db/getAll.ts";
import get from "../../db/get.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { fetchAllClientsWithIds } from "../dashboard/clientHelpers.ts";
import { fetchAllQuotes } from "./financeQuoteSource.ts";
import {
  buildSalesReport,
  type ReportClient,
  type ReportCounters,
  type ReportInvoice,
  type ReportQuote,
} from "./salesReport.ts";

const INVOICES = "invoices";
const COUNTERS_COLLECTION = "metrics";
const COUNTERS_DOC = "payment_counters";

function money(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Sum of payments that actually arrived, matching invoicesRouter.decorate. */
function receivedTotal(invoice: Record<string, unknown>): number {
  const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
  return round2(
    payments
      .filter((p: any) => p?.received !== false)
      .reduce((s: number, p: any) => s + money(p?.amount), 0),
  );
}

function balanceDue(invoice: Record<string, unknown>): number {
  return round2(money(invoice.total) - receivedTotal(invoice));
}

function deriveStatus(invoice: Record<string, unknown>): string {
  const total = money(invoice.total);
  const received = receivedTotal(invoice);
  if (total <= 0) return "draft";
  if (received >= total) return "paid";
  if (received > 0) return "partially_paid";
  return invoice.sentAt ? "sent" : "draft";
}

export default function salesReportRouter(app: Application) {
  app.get(
    "/api/dashboard/sales-report",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const [invoiceDocs, clientDocs, quoteDocs, countersDoc] =
          await Promise.all([
            getAll(INVOICES),
            fetchAllClientsWithIds(),
            fetchAllQuotes(),
            get(COUNTERS_COLLECTION, COUNTERS_DOC),
          ]);

        const invoices: ReportInvoice[] = (invoiceDocs ?? [])
          .filter((d: any) => d?.id)
          .map((d: any) => ({
            id: d.id,
            invoiceNumber: d.invoiceNumber ?? null,
            quoteId: d.quoteId ?? null,
            clientId: d.clientId ?? null,
            clientName: d.clientName ?? null,
            total: d.total ?? null,
            received: receivedTotal(d),
            balanceDue: balanceDue(d),
            status: deriveStatus(d),
            createdAt: d.createdAt ?? null,
            date: d.date ?? null,
            sentAt: d.sentAt ?? null,
            payments: Array.isArray(d.payments) ? d.payments : null,
            currency: d.currency ?? null,
            costTotal: d.costTotal ?? null,
            marginTotal: d.marginTotal ?? null,
          }));

        const clients: ReportClient[] = clientDocs.map(
          ({ docId, data }) => ({ docId, data }),
        );

        const quotes: ReportQuote[] = (quoteDocs ?? []).map((q: any) => ({
          quoteId: q.quoteId,
          clientId: q.clientId ?? null,
          createdAt: q.createdAt ?? null,
          clientAcceptedAt: q.clientAcceptedAt ?? null,
          status: q.status ?? null,
          total: q.total ?? null,
          costSubtotal: q.costSubtotal ?? null,
          currency: q.currency ?? null,
          serviceType: q.serviceType ?? null,
          legalArea: q.legalArea ?? null,
          providerSnapshots: q.providerSnapshots ?? null,
        }));

        const counters: ReportCounters = (countersDoc ?? {}) as ReportCounters;

        const report = buildSalesReport({
          invoices,
          clients,
          quotes,
          counters,
        });

        res.json({
          ...report,
          invoicesRead: invoices.length,
          clientsRead: clients.length,
          quotesRead: quotes.length,
        });
      } catch (err: any) {
        log(`[salesReportRouter] GET sales-report: ${err?.message}`);
        res
          .status(500)
          .json({ error: err?.message ?? "Failed to build the sales report" });
      }
    },
  );
}