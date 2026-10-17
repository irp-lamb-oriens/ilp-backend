/**
 * invoicePdf.ts — build the pdfmake document + buffer for an invoice.
 *
 * Kept separate from invoicesRouter.ts so the router only carries HTTP logic
 * and this file only carries the rendering. The logo is imported from
 * logoBase64.ts.
 *
 * ILP adaptation: invoices are quote-agnostic legal billing, so the IRP
 * payment-schedule reconciliation table and quote `overallDescription` /
 * `groupDescription` fields are dropped. The PDF renders the ILP invoice shape
 * (lineItems with description/qty/rate/discount/amount, notes, terms, poNumber,
 * dueDate, date, clientName, invoiceNumber, total, received, balanceDue).
 */

import { LOGO_BASE64 } from "./logoBase64.ts";

// pdfmake is a CommonJS module; Deno interops via the npm: specifier.
// We use the browser build (build/pdfmake.js) because it wires the vfs font
// bundle up for us and still exposes getBuffer() for server-side rendering.
import pdfMake from "pdfmake";
// the vfs (font) bundle is a separate file.
import pdfFonts from "pdfmake-fonts";

pdfMake.vfs = pdfFonts.vfs;

const COMPANY = {
  name: "International Legal Partner LLC",
  address: "Miami Florida 33130, U.S.A",
  email: "finance@internationallegalpartner.com",
  website: "www.internationallegalpartner.com",
};

function money(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function receivedTotal(invoice: Record<string, unknown>): number {
  const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
  return round2(
    payments
      .filter((p) => (p as Record<string, unknown>).received !== false)
      .reduce((s, p) => s + money((p as Record<string, unknown>).amount), 0),
  );
}

function balanceDue(invoice: Record<string, unknown>): number {
  return round2(money(invoice.total) - receivedTotal(invoice));
}

/** Build the pdfmake document definition for an invoice. */
export function buildPdfDoc(invoice: Record<string, unknown>): unknown {
  const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
  const total = money(invoice.total);
  const received = receivedTotal(invoice);
  const balance = balanceDue(invoice);

  const tableBody: unknown[] = [
    [
      { text: "#", style: "th" },
      { text: "Item & Description", style: "th" },
      { text: "Qty", style: "th", alignment: "right" },
      { text: "Rate", style: "th", alignment: "right" },
      { text: "Discount", style: "th", alignment: "right" },
      { text: "Amount", style: "th", alignment: "right" },
    ],
  ];

  lines.forEach((li: Record<string, unknown>, idx: number) => {
    tableBody.push([
      { text: String(idx + 1), style: "td" },
      { text: String(li.description || ""), style: "td" },
      { text: String(li.qty ?? 1), style: "td", alignment: "right" },
      { text: usd(money(li.rate)), style: "td", alignment: "right" },
      { text: usd(money(li.discount)), style: "td", alignment: "right" },
      { text: usd(money(li.amount)), style: "td", alignment: "right" },
    ]);
  });

  const notes = typeof invoice.notes === "string" && invoice.notes.trim()
    ? invoice.notes.trim()
    : "";

  return {
    pageSize: "A4",
    pageMargins: [48, 48, 48, 48],
    content: [
      {
        columns: [
          { image: LOGO_BASE64, fit: [140, 60] },
          {
            width: "*",
            stack: [
              { text: COMPANY.name, style: "companyName" },
              { text: COMPANY.address, style: "companyMeta" },
              { text: COMPANY.email, style: "companyMeta" },
              { text: COMPANY.website, style: "companyMeta" },
            ],
            alignment: "right",
          },
        ],
        margin: [0, 0, 0, 24],
      },
      {
        columns: [
          {
            stack: [
              { text: "INVOICE", style: "title" },
              { text: `# ${invoice.invoiceNumber ?? ""}`, style: "subtitle" },
            ],
          },
          {
            stack: [
              { text: "Balance due", style: "balanceLabel" },
              { text: usd(balance), style: "balanceValue" },
            ],
            alignment: "right",
          },
        ],
        margin: [0, 0, 0, 20],
      },
      {
        columns: [
          {
            width: "50%",
            stack: [
              { text: "INVOICE DATE", style: "metaLabel" },
              { text: shortDate(invoice.date as string), style: "metaValue" },
              { text: "TERMS", style: "metaLabel" },
              { text: invoice.terms || "Due on receipt", style: "metaValue" },
            ],
          },
          {
            width: "50%",
            stack: [
              { text: "BILL TO", style: "metaLabel" },
              { text: invoice.clientName || "--", style: "metaValue" },
              { text: "DUE DATE", style: "metaLabel" },
              { text: shortDate(invoice.dueDate as string), style: "metaValue" },
              { text: "PO NUMBER", style: "metaLabel" },
              { text: invoice.poNumber || "--", style: "metaValue" },
            ],
          },
        ],
        margin: [0, 0, 0, 24],
      },
      {
        table: {
          headerRows: 1,
          widths: [24, "*", 44, 70, 70, 80],
          body: tableBody,
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => "#e2e8f0",
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
        margin: [0, 0, 0, 16],
      },
      {
        columns: [
          { width: "*", text: "" },
          {
            width: 260,
            stack: [
              { text: `Total: ${usd(total)}`, style: "totalRow" },
              { text: `Payment received (-): ${usd(received)}`, style: "totalRow" },
              { text: `Balance due: ${usd(balance)}`, style: "balanceRow" },
            ],
          },
        ],
        margin: [0, 0, 0, 24],
      },
      ...(notes
        ? [
            { text: "Notes", style: "sectionLabel" },
            { text: notes, style: "body" },
            { text: "", margin: [0, 0, 0, 12] },
          ]
        : []),
    ],
    styles: {
      companyName: { fontSize: 16, bold: true, color: "#0f172a", margin: [0, 0, 0, 2] },
      companyMeta: { fontSize: 9, color: "#64748b", margin: [0, 0, 0, 1] },
      title: { fontSize: 28, bold: true, color: "#0f172a", margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 13, color: "#64748b" },
      balanceLabel: { fontSize: 10, color: "#64748b", margin: [0, 0, 0, 2] },
      balanceValue: { fontSize: 24, bold: true, color: "#0f172a" },
      metaLabel: { fontSize: 8, bold: true, color: "#94a3b8", margin: [0, 0, 1, 0] },
      metaValue: { fontSize: 11, color: "#334155", margin: [0, 0, 8, 0] },
      th: { fontSize: 9, bold: true, color: "#64748b", fillColor: "#f8fafc" },
      td: { fontSize: 10, color: "#334155" },
      totalRow: { fontSize: 11, color: "#334155", margin: [0, 0, 0, 4] },
      balanceRow: { fontSize: 13, bold: true, color: "#0f172a", margin: [0, 0, 0, 0] },
      sectionLabel: { fontSize: 10, bold: true, color: "#0f172a", margin: [0, 0, 6, 0] },
      body: { fontSize: 9, color: "#475569", lineHeight: 1.5 },
    },
  };
}

/** Generate the PDF buffer for an invoice. */
export async function buildPdfBuffer(
  invoice: Record<string, unknown>,
): Promise<Uint8Array> {
  const doc = buildPdfDoc(invoice);
  const buffer = await pdfMake.createPdf(doc).getBuffer();
  return new Uint8Array(buffer);
}