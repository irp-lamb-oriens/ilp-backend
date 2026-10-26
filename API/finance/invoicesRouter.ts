import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import { FINANCE_ADMIN } from "./financeAuth.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import remove from "../../db/delete.ts";
import log from "../../helper/log.ts";
import auditLog, { auditFrom } from "../../helper/auditLog.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

/**
 * ILP legal-billing invoices.
 *
 * Ported from IRP-funnel's finance/invoicesRouter, tailored to ILP:
 * - Company identity is International Legal Partner (not Relocation Partner).
 * - Quote/relocation coupling (quoteBillableLines, moveTaxonomy, pdfmake PDF
 *   generation) is dropped. ILP invoices are quote-agnostic legal billing
 *   against a client.
 * - Auth: admin dashboard sessions only (FINANCE_ADMIN), then validateUser("staff").
 * - Audit uses ILP's auditLog instead of IRP's recordStaffAction.
 * - Email uses ILP's enqueueEmail (Firestore queue) instead of IRP's
 *   sendAndLogEmail + getMailConfigPack.
 *
 * Routes:
 *   GET    /api/finance/invoices                 list all invoices
 *   GET    /api/finance/invoices/:id             one invoice
 *   POST   /api/finance/invoices                 create one
 *   PUT    /api/finance/invoices/:id             edit an invoice
 *   POST   /api/finance/invoices/:id/payment     record payments
 *   POST   /api/finance/invoices/:id/paid        mark paid in full / reopen
 *   POST   /api/finance/invoices/:id/send        email the invoice
 *   DELETE /api/finance/invoices/:id             delete a draft
 */

const INVOICES = "invoices";

interface LineItem {
  id: string;
  description: string;
  qty: number;
  rate: number;
  discount: number;
  amount: number;
}

interface Payment {
  id: string;
  date: string | null;
  amount: number;
  method: string | null;
  note: string | null;
  received: boolean;
}

/** Company identity used on every invoice header and email. */
const COMPANY = {
  name: "International Legal Partner LLC",
  address: "Miami Florida 33130, U.S.A",
  email: "finance@internationallegalpartner.com",
  website: "www.internationallegalpartner.com",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function actorOf(req: Request): string {
  const user = (req as Request & { sessionUser?: SessionUser }).sessionUser;
  return user?.uid ?? "unknown";
}

function money(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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

function positiveNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function optionalNumber(v: unknown): number | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return positiveNumber(v);
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function receivedTotal(invoice: Record<string, unknown>): number {
  const payments = Array.isArray(invoice.payments)
    ? (invoice.payments as Payment[])
    : [];
  return round2(
    payments
      .filter((p) => p.received !== false)
      .reduce((s, p) => s + money(p.amount), 0),
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

function parseLineItems(raw: unknown, errors: string[]): LineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((li: Record<string, unknown>, i) => {
    const qty = optionalNumber(li?.qty);
    const rate = optionalNumber(li?.rate);
    const discount = optionalNumber(li?.discount);
    if (qty === null) errors.push(`lineItems[${i}].qty is not a number`);
    if (rate === null) errors.push(`lineItems[${i}].rate is not a number`);
    if (discount === null) errors.push(`lineItems[${i}].discount is not a number`);
    const q = qty ?? 1;
    const r = rate ?? 0;
    const d = discount ?? 0;
    return {
      id: cleanId(li?.id, `li-${Date.now()}-${i}`),
      description: typeof li?.description === "string" ? li.description.slice(0, 2000) : "",
      qty: q,
      rate: r,
      discount: d,
      amount: round2(q * r - d),
    };
  });
}

async function nextInvoiceNumber(): Promise<number> {
  const docs = await getAll(INVOICES);
  let max = 0;
  for (const d of docs ?? []) {
    const match = /(\d+)\s*$/.exec(String(d?.invoiceNumber ?? ""));
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

const MANUAL_SETTLEMENT_NOTE = "Marked paid in full from the dashboard";

function parsePayments(raw: unknown, errors: string[]): Payment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p: Record<string, unknown>, i) => {
    const amount = optionalNumber(p?.amount);
    if (amount === null) errors.push(`payments[${i}].amount is not a number`);
    return {
      id: cleanId(p?.id, `pay-${Date.now()}-${i}`),
      date: isoDateOrNull(p?.date),
      amount: amount ?? 0,
      method: typeof p?.method === "string" ? p.method.slice(0, 120) : null,
      note: typeof p?.note === "string" ? p.note.slice(0, 500) : null,
      received: p?.received !== false,
    };
  });
}

function decorate(doc: Record<string, unknown>, id: string): Record<string, unknown> {
  return {
    ...doc,
    id,
    received: receivedTotal(doc),
    balanceDue: balanceDue(doc),
    status: deriveStatus(doc),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export default function invoicesRouter(app: Express) {
  log("Finance invoices router initialized.");

  /** List all invoices, newest first. */
  app.get(
    "/api/finance/invoices",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (_req: Request, res: Response) => {
      const docs = await getAll(INVOICES);
      const invoices = (docs ?? [])
        .filter((d) => d?.id)
        .map((d) => decorate(d, d.id))
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
      res.json({ invoices });
    })
  );

  /** Fetch one invoice. */
  app.get(
    "/api/finance/invoices/:id",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An invoice id is required" });
      const doc = await get(INVOICES, id);
      if (!doc) return res.status(404).json({ error: "Invoice not found" });
      res.json({ invoice: decorate(doc, id) });
    })
  );

  /**
   * Create a quote-agnostic invoice against a client.
   *
   * Body: {
   *   clientId, clientName?, clientEmail?, lineItems, discount?,
   *   notes?, dueDate?, terms?, poNumber?
   * }
   */
  app.post(
    "/api/finance/invoices",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const actor = actorOf(req);
      const body = req.body ?? {};

      const clientId = typeof body.clientId === "string" && body.clientId.trim()
        ? body.clientId.trim()
        : null;
      if (!clientId) {
        return res.status(400).json({ error: "A clientId is required" });
      }

      const errors: string[] = [];
      const lineItems = parseLineItems(body.lineItems, errors);
      if (errors.length) return res.status(400).json({ error: errors.join("; ") });
      if (!lineItems.length) {
        return res.status(400).json({ error: "At least one line item is required" });
      }

      const subtotal = round2(lineItems.reduce((s, li) => s + li.amount, 0));
      const discount = money(body.discount);
      const total = round2(subtotal - discount);

      const invoiceNumber = `INV-${String(await nextInvoiceNumber()).padStart(6, "0")}`;
      const invoiceId = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const invoice = {
        invoiceId,
        invoiceNumber,
        clientId,
        clientName: typeof body.clientName === "string" && body.clientName
          ? body.clientName
          : "",
        clientEmail: typeof body.clientEmail === "string" ? body.clientEmail : "",
        date: isoDateOrNull(body.date) ?? now,
        dueDate: isoDateOrNull(body.dueDate),
        terms: typeof body.terms === "string" && body.terms ? body.terms : "Due on receipt",
        poNumber: typeof body.poNumber === "string" && body.poNumber ? body.poNumber : null,
        lineItems,
        discount,
        subtotal,
        total,
        payments: [],
        notes: typeof body.notes === "string" ? body.notes : null,
        status: "draft",
        sentAt: null,
        sentToEmail: null,
        createdBy: actor,
        createdAt: now,
        updatedAt: null,
      };

      await put(INVOICES, invoiceId, invoice);

      await auditLog({
        actor: auditFrom((req as Request & { sessionUser?: SessionUser }).sessionUser),
        action: "finance.invoice.created",
        target: `invoices/${invoiceId}`,
        meta: { invoiceNumber, total, lineItemCount: lineItems.length, clientId },
      });

      res.json({ ok: true, invoice: decorate(invoice, invoiceId) });
    })
  );

  /** Edit an invoice (line items, dates, terms, notes). */
  app.put(
    "/api/finance/invoices/:id",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An invoice id is required" });
      const actor = actorOf(req);

      const existing = await get(INVOICES, id);
      if (!existing) return res.status(404).json({ error: "Invoice not found" });

      const errors: string[] = [];
      const lineItems = parseLineItems(req.body?.lineItems, errors);
      if (errors.length) return res.status(400).json({ error: errors.join("; ") });

      const subtotal = round2(lineItems.reduce((s, li) => s + li.amount, 0));
      const discount = money(req.body?.discount);
      const total = round2(subtotal - discount);

      const updated = {
        ...existing,
        lineItems: lineItems.length ? lineItems : existing.lineItems,
        discount,
        subtotal,
        total,
        date: isoDateOrNull(req.body?.date) ?? existing.date,
        dueDate: isoDateOrNull(req.body?.dueDate) ?? existing.dueDate,
        terms: typeof req.body?.terms === "string" ? req.body.terms : existing.terms,
        poNumber: typeof req.body?.poNumber === "string" ? req.body.poNumber : existing.poNumber,
        notes: typeof req.body?.notes === "string" ? req.body.notes : existing.notes,
        clientName: typeof req.body?.clientName === "string" ? req.body.clientName : existing.clientName,
        clientEmail: typeof req.body?.clientEmail === "string" ? req.body.clientEmail : existing.clientEmail,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };

      await put(INVOICES, id, updated);

      await auditLog({
        actor: auditFrom((req as Request & { sessionUser?: SessionUser }).sessionUser),
        action: "finance.invoice.updated",
        target: `invoices/${id}`,
        meta: { invoiceNumber: existing.invoiceNumber ?? id, total },
      });

      res.json({ ok: true, invoice: decorate(updated, id) });
    })
  );

  /** Record payments against an invoice. */
  app.post(
    "/api/finance/invoices/:id/payment",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An invoice id is required" });
      const actor = actorOf(req);

      const existing = await get(INVOICES, id);
      if (!existing) return res.status(404).json({ error: "Invoice not found" });

      const errors: string[] = [];
      const payments = parsePayments(req.body?.payments, errors);
      if (errors.length) return res.status(400).json({ error: errors.join("; ") });

      const updated = {
        ...existing,
        payments,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };

      await put(INVOICES, id, updated);

      await auditLog({
        actor: auditFrom((req as Request & { sessionUser?: SessionUser }).sessionUser),
        action: "finance.invoice.payment",
        target: `invoices/${id}`,
        meta: {
          invoiceNumber: existing.invoiceNumber ?? id,
          receivedTotal: receivedTotal(updated),
          balanceDue: balanceDue(updated),
        },
      });

      res.json({ ok: true, invoice: decorate(updated, id) });
    })
  );

  /** Mark an invoice paid in full, or reopen it. */
  app.post(
    "/api/finance/invoices/:id/paid",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An invoice id is required" });
      if (typeof req.body?.paid !== "boolean") {
        return res.status(400).json({ error: "paid must be true or false" });
      }
      const paid = req.body.paid as boolean;
      const actor = actorOf(req);

      const existing = await get(INVOICES, id);
      if (!existing) return res.status(404).json({ error: "Invoice not found" });

      const current = Array.isArray(existing.payments)
        ? (existing.payments as Payment[])
        : [];
      let payments: Payment[];

      if (paid) {
        const outstanding = balanceDue(existing);
        if (outstanding <= 0) {
          return res.json({ ok: true, invoice: decorate(existing, id) });
        }
        payments = [
          ...current,
          {
            id: `settle-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            date: isoDateOrNull(req.body?.date) ?? new Date().toISOString(),
            amount: outstanding,
            method: typeof req.body?.method === "string" && req.body.method
              ? req.body.method.slice(0, 120)
              : "manual",
            note: MANUAL_SETTLEMENT_NOTE,
            received: true,
          },
        ];
      } else {
        payments = current.filter((p) => p?.note !== MANUAL_SETTLEMENT_NOTE);
        if (payments.length === current.length && current.length > 0) {
          return res.status(409).json({
            error:
              "This invoice was settled by recorded payments. Remove those payments to reopen it.",
          });
        }
      }

      const updated = {
        ...existing,
        payments,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };
      await put(INVOICES, id, updated);

      await auditLog({
        actor: auditFrom((req as Request & { sessionUser?: SessionUser }).sessionUser),
        action: paid ? "finance.invoice.marked_paid" : "finance.invoice.marked_unpaid",
        target: `invoices/${id}`,
        meta: {
          invoiceNumber: existing.invoiceNumber ?? id,
          total: money(existing.total),
          receivedTotal: receivedTotal(updated),
          balanceDue: balanceDue(updated),
        },
      });

      res.json({ ok: true, invoice: decorate(updated, id) });
    })
  );

  /** Email the invoice to the client. */
  app.post(
    "/api/finance/invoices/:id/send",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An invoice id is required" });
      const actor = actorOf(req);

      const existing = await get(INVOICES, id);
      if (!existing) return res.status(404).json({ error: "Invoice not found" });

      const recipientEmail = String(req.body?.email || existing.clientEmail || "").trim();
      if (!recipientEmail || !recipientEmail.includes("@")) {
        return res.status(400).json({ error: "A valid recipient email is required" });
      }

      const balance = balanceDue(existing);
      const total = money(existing.total);

      const html = `
        <div style="font-family:'Jost',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fafbfc;border-radius:16px;">
          <div style="text-align:center;margin-bottom:24px;">
            <h1 style="font-size:24px;font-weight:800;color:#0f172a;margin:0 0 4px;">Invoice ${existing.invoiceNumber ?? ""}</h1>
            <p style="font-size:14px;color:#64748b;margin:0;">${existing.clientName || ""}</p>
          </div>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:16px;">
            <p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px;">
              Hi ${existing.clientName || "there"},<br/><br/>
              Please find attached your invoice for <strong>${usd(total)}</strong>.
              ${balance > 0 ? `The balance due is <strong>${usd(balance)}</strong>.` : "This invoice has been fully paid."}
            </p>
            <p style="font-size:13px;color:#64748b;margin:0;">
              If you have any questions, reply to this email or contact us at ${COMPANY.email}.
            </p>
          </div>
          <p style="font-size:11px;color:#94a3b8;text-align:center;margin:0;">
            ${COMPANY.name} - ${COMPANY.address} - ${COMPANY.website}
          </p>
        </div>
      `;

      await enqueueEmail(
        {
          to: recipientEmail,
          subject: `Invoice ${existing.invoiceNumber ?? ""} from ${COMPANY.name}`,
          html,
        },
        `invoice_${id}`,
      );

      const updated = {
        ...existing,
        sentAt: new Date().toISOString(),
        sentToEmail: recipientEmail,
        sentBy: actor,
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
      };
      await put(INVOICES, id, updated);

      await auditLog({
        actor: auditFrom((req as Request & { sessionUser?: SessionUser }).sessionUser),
        action: "finance.invoice.sent",
        target: `invoices/${id}`,
        meta: { invoiceNumber: existing.invoiceNumber ?? id, recipientEmail, balanceDue: balance },
      });

      res.json({ ok: true, invoice: decorate(updated, id) });
    })
  );

  /** Delete a draft invoice. */
  app.delete(
    "/api/finance/invoices/:id",
    ...FINANCE_ADMIN,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "An invoice id is required" });

      const existing = await get(INVOICES, id);
      if (!existing) return res.status(404).json({ error: "Invoice not found" });
      if (existing.sentAt) {
        return res.status(409).json({ error: "A sent invoice cannot be deleted" });
      }

      await remove(INVOICES, id);

      await auditLog({
        actor: auditFrom((req as Request & { sessionUser?: SessionUser }).sessionUser),
        action: "finance.invoice.deleted",
        target: `invoices/${id}`,
        meta: { invoiceNumber: existing.invoiceNumber ?? id },
      });

      res.json({ ok: true });
    })
  );
}