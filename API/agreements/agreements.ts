/**
 * API/agreements/agreements.ts
 * ──────────────────────────────────────────────────────────────────────────
 * AGREEMENT: each member signs the Membership Agreement at join by typing
 * their name. Two steps:
 *
 *   signAgreement      at POST /api/payments/join: stores the signature record
 *                      (`agreements/agr_<membershipId>`): name typed, time,
 *                      version, IP, browser, fingerprint of the text shown.
 *   finalizeAgreement  when the membership activates (first payment): builds
 *                      the signed PDF, files it under the member's Documents
 *                      (member_documents, downloadable in /status) and emails
 *                      the member where to find it. Idempotent; never throws.
 *
 *   GET /api/agreements/membership   public: the text the join form shows.
 *
 * Signing is enforced when AGREEMENT_REQUIRED=true (set it in production once
 * the site that sends `signature` is live): a join without a signature is
 * then refused. Without the flag, a signature is recorded whenever it is sent.
 */
import type { Express, Request, Response } from "express";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import auditLog from "../../helper/auditLog.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { memberEmailLayout } from "../../helper/emailTemplates.ts";
import { DOCUMENTS_COLLECTION, storeMemberDocument } from "../../helper/storage.ts";
import { AGREEMENT_VERSION, agreementPlainText, agreementSections, agreementTitle } from "./agreementText.ts";
import { agreementPdf } from "./agreementPdf.ts";

type Doc = Record<string, unknown>;

export const AGREEMENTS = "agreements";
export const AGREEMENT_FILE_NAME = "ILP membership agreement (signed).pdf";
export const SIGNATURE_ERROR = "Type your full name to sign the membership agreement.";

export const siteUrl = () => (Deno.env.get("PUBLIC_SITE_URL") || Deno.env.get("FRONTEND_URL") || "http://localhost:3000").replace(/\/$/, "");
export const agreementRequired = () => Deno.env.get("AGREEMENT_REQUIRED") === "true";
export const agreementIdFor = (membershipId: string) => `agr_${membershipId}`.replace(/[^A-Za-z0-9_-]/g, "_");

export interface AgreementRecord {
  id: string;
  clientId: string;
  membershipId: string;
  email: string;
  fullName: string;
  country?: string;
  signature: string;
  version: string;
  textSha256: string;
  signedAt: string;
  ip?: string;
  userAgent?: string;
  documentId?: string;
  pdfSha256?: string;
  finalizedAt?: string;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The signature a join body carries: `signature` (the typed name) and, when
 * sent, `agreementVersion` (must be the current one). Pure.
 */
export function parseSignature(body: Doc, required = agreementRequired()): { signature: string | null } | { error: string } {
  const raw = typeof body.signature === "string" ? body.signature.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (!raw) return required ? { error: SIGNATURE_ERROR } : { signature: null };
  if (raw.length < 3 || !/\p{L}/u.test(raw)) return { error: SIGNATURE_ERROR };
  if (body.agreementVersion !== undefined && body.agreementVersion !== AGREEMENT_VERSION) {
    return { error: "The membership agreement changed. Reload this page, read it again and sign." };
  }
  return { signature: raw };
}

export interface AgreementDeps {
  get: (collection: string, id: string) => Promise<Doc | null>;
  put: (collection: string, id: string, data: Doc) => Promise<unknown>;
  storePdf: (clientId: string, docId: string, bytes: Uint8Array) => Promise<{ ok: true; fields: Doc; size: number; contentType: string } | { ok: false; status: number; error: string }>;
  buildPdf: typeof agreementPdf;
  email: (msg: { to: string; subject: string; html: string; text: string }, key: string) => Promise<unknown>;
  audit: (entry: { actor: { uid: string; email: string; role: string }; action: string; target: string; meta?: Doc }) => Promise<unknown>;
  now: () => string;
}

export const defaultDeps: AgreementDeps = {
  get: (c, id) => get(c, id).catch(() => null) as Promise<Doc | null>,
  put,
  storePdf: storeMemberDocument,
  buildPdf: agreementPdf,
  email: (m, k) => enqueueEmail(m, k),
  audit: auditLog,
  now: () => new Date().toISOString(),
};

/** Record the signature given at join. A retried join re-signs (the newest signature before payment counts). */
export async function signAgreement(
  input: { clientId: string; membershipId: string; email: string; fullName: string; country?: string; signature: string; ip?: string; userAgent?: string },
  deps: AgreementDeps = defaultDeps,
): Promise<AgreementRecord> {
  const id = agreementIdFor(input.membershipId);
  const existing = await deps.get(AGREEMENTS, id) as AgreementRecord | null;
  if (existing?.finalizedAt) return existing; // already active and filed: never rewritten
  const rec: AgreementRecord = {
    id,
    clientId: input.clientId,
    membershipId: input.membershipId,
    email: input.email,
    fullName: input.fullName,
    ...(input.country ? { country: input.country } : {}),
    signature: input.signature,
    version: AGREEMENT_VERSION,
    textSha256: await sha256Hex(agreementPlainText(siteUrl())),
    signedAt: deps.now(),
    ...(input.ip ? { ip: input.ip.slice(0, 64) } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 300) } : {}),
  };
  await deps.put(AGREEMENTS, id, rec as unknown as Doc);
  await deps.audit({
    actor: { uid: input.clientId, email: input.email, role: "client" },
    action: "agreement.signed",
    target: `${AGREEMENTS}/${id}`,
    meta: { version: rec.version, textSha256: rec.textSha256 },
  });
  return rec;
}

/** On activation: build and file the signed PDF, email the member. Idempotent; never throws. */
export async function finalizeAgreement(membershipId: string, activatedAt?: string, deps: AgreementDeps = defaultDeps): Promise<AgreementRecord | null> {
  try {
    const id = agreementIdFor(membershipId);
    const rec = await deps.get(AGREEMENTS, id) as AgreementRecord | null;
    if (!rec) return null; // joined before agreements, or without a signature
    if (rec.finalizedAt) return rec;
    const site = siteUrl();
    const bytes = await deps.buildPdf({
      id,
      fullName: rec.fullName,
      email: rec.email,
      country: rec.country,
      signature: rec.signature,
      signedAt: rec.signedAt,
      ip: rec.ip,
      userAgent: rec.userAgent,
      textSha256: rec.textSha256,
      activatedAt,
      draft: /draft/i.test(rec.version),
    }, site);
    const docId = `doc_${id}`;
    const stored = await deps.storePdf(rec.clientId, docId, bytes);
    if (!stored.ok) {
      log(`[agreements] ${id}: PDF not stored (${stored.error})`, "error");
      return rec;
    }
    const now = deps.now();
    await deps.put(DOCUMENTS_COLLECTION, docId, {
      id: docId,
      clientId: rec.clientId,
      category: "other",
      kind: "membership_agreement",
      fileName: AGREEMENT_FILE_NAME,
      contentType: stored.contentType,
      size: stored.size,
      uploadedAt: now,
      uploadedBy: "ILP",
      ...stored.fields,
    });
    const done: AgreementRecord = { ...rec, documentId: docId, pdfSha256: await sha256Hex(bytes), finalizedAt: now };
    await deps.put(AGREEMENTS, id, done as unknown as Doc);
    await deps.audit({
      actor: { uid: "system", email: "system", role: "system" },
      action: "agreement.filed",
      target: `${AGREEMENTS}/${id}`,
      meta: { documentId: docId, pdfSha256: done.pdfSha256, size: stored.size },
    });
    const mail = memberEmailLayout({
      subject: "Your signed ILP membership agreement",
      firstName: rec.fullName.split(/\s+/)[0],
      paragraphs: [
        "Thank you for joining ILP. The membership agreement you signed is saved in your ILP home, under Profile and documents. You can download it there at any time.",
        "It says what your membership includes, what it costs, that it renews every month until you cancel, and how to cancel online.",
      ],
      cta: { label: "Open my documents", url: `${site}/status/profile` },
    });
    await deps.email({ to: rec.email, subject: mail.subject, html: mail.html, text: mail.text }, `agreement_${id}`)
      .catch((err) => log(`[agreements] email not queued for ${id}: ${err}`, "error"));
    return done;
  } catch (err) {
    log(`[agreements] finalize ${membershipId} failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

export default function agreementsRouter(app: Express) {
  log("Agreements router initialized.");
  app.get("/api/agreements/membership", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      title: agreementTitle(),
      version: AGREEMENT_VERSION,
      draft: /draft/i.test(AGREEMENT_VERSION),
      sections: agreementSections(siteUrl()),
      required: agreementRequired(),
    });
  });
}
