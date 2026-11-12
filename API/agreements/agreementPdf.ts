/**
 * API/agreements/agreementPdf.ts — the signed Membership Agreement as a PDF
 * (pdfmake, same setup as finance/invoicePdf.ts).
 */
import pdfMake from "pdfmake";
import pdfFonts from "pdfmake-fonts";
import { AGREEMENT_VERSION, agreementEntity, agreementEntityAddress, agreementSections, agreementTitle } from "./agreementText.ts";

pdfMake.vfs = pdfFonts.vfs;

const NAVY = "#123b5d";
const STEEL = "#4a5a66";

export interface SignedAgreementView {
  id: string;
  fullName: string;
  email: string;
  country?: string;
  signature: string;
  signedAt: string;
  ip?: string;
  userAgent?: string;
  textSha256: string;
  activatedAt?: string;
  draft: boolean;
}

const when = (iso: string) => `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)} UTC`;

// deno-lint-ignore no-explicit-any
export function agreementPdfDoc(a: SignedAgreementView, site: string): any {
  const sections = agreementSections(site).flatMap((s) => [
    { text: s.heading, style: "h2" },
    ...s.body.map((p) => ({ text: p, style: "p" })),
  ]);
  const row = (k: string, v: string) => [{ text: k, color: STEEL }, { text: v }];
  return {
    pageSize: "LETTER",
    pageMargins: [56, 64, 56, 64],
    info: { title: agreementTitle(), author: agreementEntity(), subject: `Signed by ${a.fullName}` },
    footer: (page: number, pages: number) => ({
      margin: [56, 24, 56, 0],
      columns: [
        { text: `${agreementTitle()} · ${AGREEMENT_VERSION} · ${a.id}`, fontSize: 8, color: STEEL },
        { text: `${page} / ${pages}`, alignment: "right", fontSize: 8, color: STEEL },
      ],
    }),
    content: [
      { text: agreementTitle(), style: "h1" },
      { text: `${agreementEntity()}, ${agreementEntityAddress()}`, color: STEEL, margin: [0, 0, 0, a.draft ? 6 : 16] },
      ...(a.draft ? [{ text: "Draft text, pending review by ILP's counsel.", color: STEEL, italics: true, margin: [0, 0, 0, 16] }] : []),
      ...sections,
      { text: "Signature", style: "h2", margin: [0, 22, 0, 8] },
      {
        table: {
          widths: [150, "*"],
          body: [
            row("Member", a.fullName),
            row("Email", a.email),
            ...(a.country ? [row("Country of the membership", a.country)] : []),
            row("Signed by typing", a.signature),
            row("Signed on", when(a.signedAt)),
            ...(a.activatedAt ? [row("Membership started", when(a.activatedAt))] : []),
            ...(a.ip ? [row("Internet address", a.ip)] : []),
            ...(a.userAgent ? [row("Browser", a.userAgent.slice(0, 160))] : []),
            row("Agreement version", AGREEMENT_VERSION),
            row("Text fingerprint (SHA-256)", a.textSha256),
            row("For ILP", `${agreementEntity()} (accepted electronically)`),
          ],
        },
        layout: "lightHorizontalLines",
        fontSize: 9.5,
      },
    ],
    styles: {
      h1: { fontSize: 20, bold: true, color: NAVY, margin: [0, 0, 0, 4] },
      h2: { fontSize: 12, bold: true, color: NAVY, margin: [0, 12, 0, 4] },
      p: { fontSize: 10, lineHeight: 1.3, margin: [0, 0, 0, 6] },
    },
    defaultStyle: { fontSize: 10 },
  };
}

export async function agreementPdf(a: SignedAgreementView, site: string): Promise<Uint8Array> {
  return new Uint8Array(await pdfMake.createPdf(agreementPdfDoc(a, site)).getBuffer());
}
