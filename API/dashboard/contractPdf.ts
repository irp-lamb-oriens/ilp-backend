/**
 * contractPdf.ts — render the signed engagement agreement as a PDF.
 *
 * The header (logo + company block) and the pdfmake setup are the same ones the
 * finance invoice uses, so a bank comparing the two documents sees one company.
 * The body is built from the contract snapshot. The proposal's HTML structure
 * survives (headings, emphasis, lists, tables) but none of its CSS does, so the
 * document reads as an agreement rather than as a marketing page.
 */

import { LOGO_BASE64 } from "../finance/logoBase64.ts";
import { htmlToPdfNodes } from "./contractHtml.ts";
import type { ContractSnapshot } from "./contractSnapshot.ts";
import type { BankInfoConfig } from "./automation/bankInfo.ts";
import { DEFAULT_BANK_INFO, ensureBankInfo } from "./automation/bankInfo.ts";
import {
  depositNarrative,
  bankDetailsPdfBankRows,
  type PaymentScheduleContext,
} from "./automation/paymentInstructions.ts";

// pdfmake is a CommonJS module; Deno interops via the npm: specifier. The
// browser build wires up the vfs font bundle and still exposes getBuffer().
import pdfMake from "pdfmake";
import pdfFonts from "pdfmake-fonts";

pdfMake.vfs = pdfFonts.vfs;

/** Same identity block the invoice PDF prints. */
const COMPANY = {
  name: "International Legal Partner LLC",
  address: "Miami Florida 33130, U.S.A",
  email: "finance@internationallegalpartner.com",
  website: "www.internationallegalpartner.com",
};

/** How each accepted service is described in the "Included as" column. */
const ROLE_LABEL: Record<string, string> = {
  required: "Package selected by client",
  optional: "Add-on selected by client",
  fixed: "Always included",
  line: "Selected",
};

function money(n: number, currency: string): string {
  const amount = Number.isFinite(n) ? n : 0;
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function longDate(iso: string | null | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Build the pdfmake document definition for a contract snapshot. */
export function buildContractPdfDoc(snapshot: ContractSnapshot, bank?: BankInfoConfig): any {
  const bankInfo = bank ?? DEFAULT_BANK_INFO;
  const currency = snapshot.currency || "USD";

  const detailRows = snapshot.fields.map((f) => [
    { text: f.label, style: "detailLabel" },
    { text: f.value, style: "detailValue" },
  ]);

  const serviceBody: any[] = [
    [
      { text: "Service", style: "th" },
      { text: "Included as", style: "th" },
      { text: "Amount", style: "th", alignment: "right" },
    ],
  ];
  for (const s of snapshot.services) {
    serviceBody.push([
      { text: s.title, style: "td" },
      { text: ROLE_LABEL[s.role] ?? "Selected", style: "tdRole" },
      { text: money(s.price, currency), style: "td", alignment: "right" },
    ]);
    if (s.description) {
      serviceBody.push([
        { text: s.description, style: "tdMuted", colSpan: 3 },
        {}, {},
      ]);
    }
  }
  if (snapshot.services.length === 0) {
    serviceBody.push([
      { text: snapshot.quoteTitle, style: "td" },
      { text: "Selected", style: "tdRole" },
      { text: money(snapshot.total, currency), style: "td", alignment: "right" },
    ]);
  }

  // The proposal text of this quote's template, rendered as the agreement's
  // terms. Section names become sub-headings so the contract reads in the same
  // order the client read it on the status page.
  const templateContent: any[] = [];
  let lastSection: string | null | undefined;
  for (const block of snapshot.templateText ?? []) {
    const section = block.section ?? null;
    if (section && section !== lastSection) {
      templateContent.push({ text: section, style: "templateSection" });
    }
    lastSection = section;

    const style = block.kind === "heading" ? "templateHeading" : "templateBody";
    // Snapshots written before the HTML pass only carry flat text, so they keep
    // rendering as one paragraph.
    const nodes = block.html ? htmlToPdfNodes(block.html, style) : [];
    if (nodes.length > 0) templateContent.push(...nodes);
    else templateContent.push({ text: block.text, style });
  }

  // ── Payment schedule (last-page section sent to finance) ──────────────────
  const payCtx: PaymentScheduleContext = {
    currency,
    total: snapshot.total,
    schedule: Array.isArray(snapshot.paymentSchedule) ? snapshot.paymentSchedule : [],
  };
  const scheduleRows: any[] = [];
  let firstSchedulePct: number | null = null;
  if (Array.isArray(snapshot.paymentSchedule) && snapshot.paymentSchedule.length > 0) {
    firstSchedulePct = snapshot.paymentSchedule[0] ?? null;
    snapshot.paymentSchedule.forEach((pct: number, i: number) => {
      const amount = Math.round((snapshot.total * (pct / 100)) * 100) / 100;
      scheduleRows.push([
        { text: `${i + 1}`, style: "td", alignment: "center" },
        { text: i === 0 ? "Reservation (initial payment)" : "Installment", style: "td" },
        { text: `${pct}%`, style: "td", alignment: "right" },
        { text: money(amount, currency), style: "td", alignment: "right" },
      ]);
    });
  }

  const narrative = depositNarrative(payCtx);
  const bankRows = bankDetailsPdfBankRows(bankInfo);
  const bankNotes: any[] = [];
  if (bankInfo.domesticNote) bankNotes.push({ text: bankInfo.domesticNote, style: "body", margin: [0, 0, 0, 4] });
  if (bankInfo.localChargesNote) bankNotes.push({ text: bankInfo.localChargesNote, style: "body", margin: [0, 0, 0, 4] });
  if (bankInfo.receiptNote) bankNotes.push({ text: bankInfo.receiptNote, style: "body", margin: [0, 0, 0, 0] });

  const bankSection: any[] = [
    { text: "How to pay", style: "sectionLabel", margin: [0, 14, 0, 8] },
    ...(narrative ? [{ text: narrative, style: "body", margin: [0, 0, 0, 12] }] : []),
    {
      table: {
        widths: [180, "*"],
        body: bankRows.map(([label, value]) => ([
          { text: label, style: "detailLabel", margin: [0, 2, 0, 2] },
          { text: value, style: "detailValue", margin: [0, 2, 0, 2] },
        ])),
      },
      layout: {
        hLineWidth: () => 0.5,
        vLineWidth: () => 0,
        hLineColor: () => "#e2e8f0",
        paddingLeft: () => 0,
        paddingRight: () => 6,
        paddingTop: () => 5,
        paddingBottom: () => 5,
      },
      margin: [0, 0, 0, 12],
    },
    ...bankNotes,
  ];

  const scheduleSection: any[] = scheduleRows.length > 0 && firstSchedulePct !== null
    ? [
        { text: "Payment schedule", style: "sectionLabel", pageBreak: "before" },
        {
          table: {
            headerRows: 1,
            widths: [40, "*", 80, 110],
            body: [
              [
                { text: "#", style: "th", alignment: "center" },
                { text: "Payment", style: "th" },
                { text: "Share", style: "th", alignment: "right" },
                { text: "Amount", style: "th", alignment: "right" },
              ],
              ...scheduleRows,
            ],
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
          margin: [0, 0, 0, 14],
        },
        {
          text:
            `The reservation payment of ${firstSchedulePct}% is due to reserve the services. ` +
            `The remaining balance is due per the installments above.`,
          style: "body",
          margin: [0, 0, 0, 16],
        },
        ...bankSection,
      ]
    : [];

  return {
    pageSize: "A4",
    pageMargins: [48, 48, 48, 56],
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
              { text: "ENGAGEMENT AGREEMENT", style: "title" },
              { text: `Ref. ${snapshot.contractRef}`, style: "subtitle" },
            ],
          },
          {
            stack: [
              { text: "Accepted on", style: "metaLabel" },
              { text: longDate(snapshot.acceptedAt), style: "metaValue" },
            ],
            alignment: "right",
          },
        ],
        margin: [0, 0, 0, 20],
      },
      {
        text:
          `This agreement records the legal services accepted by the client named below from ` +
          `${COMPANY.name}. It was accepted electronically through the client's secure portal, and ` +
          `the name typed at acceptance is recorded as the client's signature.`,
        style: "intro",
      },
      {
        columns: [
          {
            width: "50%",
            stack: [
              { text: "SERVICE PROVIDER", style: "metaLabel" },
              { text: COMPANY.name, style: "metaValue" },
              { text: COMPANY.address, style: "metaValue" },
              { text: COMPANY.email, style: "metaValue" },
            ],
          },
          {
            width: "50%",
            stack: [
              { text: "CLIENT", style: "metaLabel" },
              { text: snapshot.signatureName || "--", style: "metaValue" },
              { text: snapshot.clientEmail || "--", style: "metaValue" },
            ],
          },
        ],
        margin: [0, 0, 0, 22],
      },
      { text: "Client and matter details", style: "sectionLabel" },
      ...(detailRows.length > 0
        ? [{
          table: { widths: [150, "*"], body: detailRows },
          layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0,
            hLineColor: () => "#e2e8f0",
            paddingLeft: () => 0,
            paddingRight: () => 6,
            paddingTop: () => 5,
            paddingBottom: () => 5,
          },
          margin: [0, 0, 0, 22],
        }]
        : [{ text: "No matter details are recorded on this file.", style: "body", margin: [0, 0, 0, 22] }]),
      // The proposal the client read on their status page, carried over as the
      // terms of this agreement. It comes before the priced services so the
      // document reads scope first, then what that scope costs.
      ...(templateContent.length > 0
        ? [
          { text: "Agreed terms and scope", style: "sectionLabel", pageBreak: "before" },
          ...templateContent,
          { text: "", margin: [0, 0, 0, 16] },
        ]
        : []),
      { text: "Services agreed", style: "sectionLabel" },
      ...(snapshot.overallDescription
        ? [{ text: snapshot.overallDescription, style: "overallDescription" }]
        : []),
      {
        table: { headerRows: 1, widths: ["*", 130, 100], body: serviceBody },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => "#e2e8f0",
          paddingLeft: () => 6,
          paddingRight: () => 6,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
        margin: [0, 0, 0, 14],
      },
      {
        columns: [
          { width: "*", text: "" },
          {
            width: 240,
            stack: [{ text: `Agreed total: ${money(snapshot.total, currency)}`, style: "totalRow" }],
          },
        ],
        margin: [0, 0, 0, 28],
      },
      { text: "Client acceptance", style: "sectionLabel" },
      {
        text:
          `The client typed the full legal name below to accept this agreement on ` +
          `${longDate(snapshot.acceptedAt)}. That entry constitutes an electronic signature and a ` +
          `binding commitment to the services and the total stated above.`,
        style: "body",
        margin: [0, 0, 0, 16],
      },
      {
        columns: [
          {
            width: "60%",
            stack: [
              { text: snapshot.signatureName || "--", style: "signature" },
              { canvas: [{ type: "line", x1: 0, y1: 2, x2: 240, y2: 2, lineWidth: 0.8, lineColor: "#94a3b8" }] },
              { text: "Client signature (name entered at acceptance)", style: "signatureCaption" },
            ],
          },
          {
            width: "40%",
            stack: [
              { text: longDate(snapshot.acceptedAt), style: "signature" },
              { canvas: [{ type: "line", x1: 0, y1: 2, x2: 160, y2: 2, lineWidth: 0.8, lineColor: "#94a3b8" }] },
              { text: "Date of acceptance", style: "signatureCaption" },
            ],
          },
        ],
      },
      ...scheduleSection,
    ],
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: `Ref. ${snapshot.contractRef}`, style: "footer" },
        { text: `${currentPage} / ${pageCount}`, style: "footer", alignment: "right" },
      ],
      margin: [48, 12, 48, 0],
    }),
    styles: {
      companyName: { fontSize: 16, bold: true, color: "#0f172a", margin: [0, 0, 0, 2] },
      companyMeta: { fontSize: 9, color: "#64748b", margin: [0, 0, 0, 1] },
      title: { fontSize: 24, bold: true, color: "#0f172a", margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 12, color: "#64748b" },
      intro: { fontSize: 10, color: "#475569", lineHeight: 1.5, margin: [0, 0, 0, 20] },
      metaLabel: { fontSize: 8, bold: true, color: "#94a3b8", margin: [0, 0, 1, 0] },
      metaValue: { fontSize: 11, color: "#334155", margin: [0, 0, 8, 0] },
      sectionLabel: { fontSize: 11, bold: true, color: "#0f172a", margin: [0, 0, 0, 8] },
      detailLabel: { fontSize: 9, bold: true, color: "#64748b" },
      detailValue: { fontSize: 10, color: "#334155" },
      th: { fontSize: 9, bold: true, color: "#64748b", fillColor: "#f8fafc" },
      td: { fontSize: 10, color: "#334155" },
      tdRole: { fontSize: 9, color: "#64748b" },
      tdMuted: { fontSize: 9, color: "#94a3b8", margin: [0, 2, 0, 0] },
      templateSection: { fontSize: 11, bold: true, color: "#0f172a", margin: [0, 10, 0, 6] },
      templateHeading: { fontSize: 10, bold: true, color: "#334155", margin: [0, 8, 0, 3] },
      templateBody: { fontSize: 9, color: "#475569", lineHeight: 1.5, margin: [0, 0, 0, 6] },
      // Structure carried over from the proposal HTML (see contractHtml.ts).
      tplH1: { fontSize: 12, bold: true, color: "#0f172a", margin: [0, 10, 0, 4] },
      tplH2: { fontSize: 11, bold: true, color: "#0f172a", margin: [0, 9, 0, 4] },
      tplH3: { fontSize: 10, bold: true, color: "#334155", margin: [0, 8, 0, 3] },
      tplListItem: { fontSize: 9, color: "#475569", lineHeight: 1.4, margin: [0, 0, 0, 2] },
      tplQuote: { fontSize: 9, italics: true, color: "#64748b", margin: [12, 2, 0, 6] },
      tplTh: { fontSize: 9, bold: true, color: "#64748b" },
      tplTd: { fontSize: 9, color: "#475569" },

      overallDescription: { fontSize: 10, color: "#334155", lineHeight: 1.5, margin: [0, 0, 0, 12] },
      totalRow: { fontSize: 13, bold: true, color: "#0f172a" },
      body: { fontSize: 9, color: "#475569", lineHeight: 1.5 },
      signature: { fontSize: 13, color: "#0f172a", margin: [0, 0, 0, 2] },
      signatureCaption: { fontSize: 8, color: "#94a3b8", margin: [0, 4, 0, 0] },
      footer: { fontSize: 8, color: "#94a3b8" },
    },
  };
}

/** Generate the PDF buffer for a contract snapshot. */
export async function buildContractPdfBuffer(snapshot: ContractSnapshot): Promise<Uint8Array> {
  const bank = await ensureBankInfo();
  const doc = buildContractPdfDoc(snapshot, bank);
  const buffer = await pdfMake.createPdf(doc).getBuffer();
  return new Uint8Array(buffer);
}

/** Download filename for a contract, e.g. `contract-abc123.pdf`. */
export function contractFileName(snapshot: ContractSnapshot): string {
  const ref = String(snapshot.contractRef || "contract").replace(/[^a-zA-Z0-9_-]/g, "");
  return `contract-${ref || "document"}.pdf`;
}