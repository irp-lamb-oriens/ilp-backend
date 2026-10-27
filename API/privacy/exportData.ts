/**
 * API/privacy/exportData.ts — the member's data export (right of access and
 * portability, P6).
 *
 * `buildExport` is pure: it shapes records already loaded into a JSON
 * document the member can keep. It never includes commercial notes, margins,
 * fees, internal ranks, staff notes, raw file bytes or bucket paths
 * (EXPORT_HIDDEN_FIELDS, EXPORT_CLIENT_INTERNAL_KEYS). Handoffs carry only the
 * lawyer-approved legal next steps. Documents are listed with a download link
 * that goes through the member's own authenticated, audited route.
 *
 * `loadExportBundle` reads everything for one member (I/O).
 */

import get from "../../db/get.ts";
import query from "../../db/query.ts";
import { stripFields } from "../../db/records.ts";
import { mergeThread } from "../clientStatus/memberLogic.ts";
import { COLLECTIONS } from "../../schemas/contracts.ts";
import { EXPORT_CLIENT_INTERNAL_KEYS, EXPORT_HIDDEN_FIELDS, LEGAL_VERSIONS } from "./policy.ts";

type Doc = Record<string, unknown>;

export interface ExportBundle {
  client: Doc | null;
  memberships: Doc[];
  matters: Doc[];
  consultations: Doc[];
  handoffs: Doc[];
  obligations: Doc[];
  documents: Doc[];
  feedback: Doc[];
  leads: Doc[];
  consents: Doc[];
  privacyRequests: Doc[];
  invoices: Doc[];
}

export const EXPORT_FORMAT = "ilp-member-export/1";

const byDate = (key: string) => (a: Doc, b: Doc) => String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
const hide = <T>(v: T): T => stripFields(v, EXPORT_HIDDEN_FIELDS);

function profileOf(client: Doc | null): Doc | null {
  if (!client) return null;
  const out: Doc = {};
  for (const [k, v] of Object.entries(client)) if (!EXPORT_CLIENT_INTERNAL_KEYS.includes(k)) out[k] = v;
  return hide(out);
}

/** Pure: the export document. `documentUrl(id)` builds the member's own download link. */
export function buildExport(
  b: ExportBundle,
  opts: { now: Date; documentUrl: (docId: string) => string; memberName?: string },
): Doc {
  const messages = b.client ? mergeThread(b.client, opts.memberName ?? "You") : [];
  return {
    format: EXPORT_FORMAT,
    generatedAt: opts.now.toISOString(),
    about: [
      "This file holds the personal data International Legal Partner (ILP) keeps about you in its member systems.",
      "Not included: internal staff notes, commercial notes and pricing margins, which are ILP business records; security logs, available on request; copies held by Stripe, Google, your lawyer or email providers (see the Privacy Policy).",
      "Documents are listed with their file name and API link. To download a file, sign in and use the Documents section of your ILP account (the link alone does not sign you in).",
    ],
    policyVersion: LEGAL_VERSIONS.privacy,
    profile: profileOf(b.client),
    memberships: hide(b.memberships.map(({ csmEmail: _c, ...m }) => m)).sort(byDate("createdAt")),
    matters: hide(b.matters).sort(byDate("openedAt")),
    consultations: hide(b.consultations).sort(byDate("scheduledAt")),
    // Only what the lawyer approved for the member. Never commercialNotes or task ids.
    legalNextSteps: b.handoffs
      .map((h) => ({
        handoffId: h.id,
        consultationId: h.consultationId,
        matterId: h.matterId,
        approvedAt: h.approvedAt,
        legalNextSteps: hide(Array.isArray(h.legalNextSteps) ? h.legalNextSteps : []),
      }))
      .sort(byDate("approvedAt")),
    obligations: hide(b.obligations).sort(byDate("dueAt")),
    documents: b.documents
      .map((d) => ({
        id: d.id,
        fileName: d.fileName,
        category: d.category,
        matterId: d.matterId,
        contentType: d.contentType,
        size: d.size,
        uploadedAt: d.uploadedAt,
        downloadUrl: opts.documentUrl(String(d.id)),
      }))
      .sort(byDate("uploadedAt")),
    messages,
    feedback: hide(b.feedback).sort(byDate("at")),
    freeCheck: hide(b.leads).sort(byDate("createdAt")),
    consents: hide(b.consents).sort(byDate("at")),
    privacyRequests: hide(b.privacyRequests).sort(byDate("createdAt")),
    invoices: b.invoices
      .map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt ?? i.createdAt, status: i.status, total: i.total, currency: i.currency }))
      .sort(byDate("issuedAt")),
  };
}

async function byField(collection: string, field: string, value: string): Promise<Doc[]> {
  if (!value) return [];
  const rows = await query(collection, [{ field, op: "EQUAL", value }]).catch(() => []);
  return rows as unknown as Doc[];
}

function uniqueById(rows: Doc[]): Doc[] {
  const seen = new Map<string, Doc>();
  for (const r of rows) seen.set(String(r.id ?? JSON.stringify(r)), r);
  return [...seen.values()];
}

/** Read everything for one member. Missing collections read as empty. */
export async function loadExportBundle(clientId: string, email: string): Promise<ExportBundle> {
  const client = ((await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null);
  const mail = (email || String(client?.email ?? "")).trim().toLowerCase();
  const withId = (rows: Doc[]) => rows.map((r) => ({ ...r, id: r.id ?? r._id }));
  const [memberships, matters, consultations, handoffs, obligations, documents, feedback, leadsConv, leadsMail, consentsC, consentsE, requests, invoices] =
    await Promise.all([
      byField(COLLECTIONS.memberships, "clientId", clientId),
      byField(COLLECTIONS.matters, "clientId", clientId),
      byField(COLLECTIONS.consultations, "clientId", clientId),
      byField(COLLECTIONS.handoffs, "clientId", clientId),
      byField(COLLECTIONS.obligations, "clientId", clientId),
      byField("member_documents", "clientId", clientId),
      byField(COLLECTIONS.feedback, "clientId", clientId),
      byField(COLLECTIONS.leads, "convertedClientId", clientId),
      byField(COLLECTIONS.leads, "email", mail),
      byField(COLLECTIONS.consents, "clientId", clientId),
      byField(COLLECTIONS.consents, "email", mail),
      byField(COLLECTIONS.privacyRequests, "clientId", clientId),
      byField("invoices", "clientId", clientId),
    ]);
  return {
    client: client ? { ...client, id: clientId } : null,
    memberships: withId(memberships),
    matters: withId(matters),
    consultations: withId(consultations),
    handoffs: withId(handoffs),
    obligations: withId(obligations),
    documents: withId(documents),
    feedback: withId(feedback),
    leads: uniqueById(withId([...leadsConv, ...leadsMail])),
    consents: uniqueById(withId([...consentsC, ...consentsE])),
    privacyRequests: withId(requests),
    invoices: withId(invoices),
  };
}
