/**
 * API/portal/portalRouter.ts — ILP-native portal list endpoints (R4.3).
 *
 *   GET /api/portal/matters        — the signed-in client's matters (from `clients`)
 *   GET /api/portal/reminders      — the signed-in client's reminders (from `alerts`)
 *   GET /api/portal/consultations  — the signed-in client's consultations
 *
 * All behind `requireClientAuth` (staff bypass via x-dashboard-token, end-customer
 * via x-client-token). Data is derived from the `clients` doc + the `alerts`
 * collection (Phase 1 client-status data model), replacing the hardcoded /app mock
 * arrays.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import getAll from "../../db/getAll.ts";
import get from "../../db/get.ts";
import { emailToDocId } from "../../helper/auth/otp.ts";
import query from "../../db/query.ts";
import { requireClientAuth } from "../../helper/auth/session.ts";
import { isAllowedDomain } from "../../helper/auth/otp.ts";
import { resolveClientEmail } from "../dashboard/clientHelpers.ts";
import type { FirestoreDocument } from "../../db/getAll.ts";

const CLIENTS_COLLECTION = "clients";
const ALERTS_COLLECTION = "alerts";

interface AuthedRequest extends Request {
  clientUser?: string;
  isIrpStaff?: boolean;
}

/** Normalized principal email of the signed-in viewer. */
function viewerEmail(req: Request): string {
  return String((req as AuthedRequest).clientUser ?? "").toLowerCase().trim();
}

/** Staff = the staff domain or DASHBOARD_EXTRA_ALLOWED_EMAILS (isAllowedDomain). */
function isStaff(req: Request): boolean {
  return !!(req as AuthedRequest).isIrpStaff ||
    isAllowedDomain(viewerEmail(req));
}

/** Does the signed-in viewer have access to a given client doc? */
function mayAccess(
  doc: Record<string, unknown>,
  docId: string,
  email: string,
  staff: boolean,
): boolean {
  if (staff) return true;
  if (!email) return false;
  if (resolveClientEmail(doc, docId) === email) return true;
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  return cons.some(
    (c) => {
      const ce = (c as Record<string, unknown>)?.email;
      return typeof ce === "string" && ce.toLowerCase().trim() === email;
    },
  );
}

/** Trim a client doc to the portal-facing matter summary. */
function matterSummary(docId: string, doc: Record<string, unknown>): Record<string, unknown> {
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  const latest = (cons[cons.length - 1] ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (latest[k] !== undefined ? latest[k] : doc[k]) ?? null;
  return {
    id: docId,
    name: pick("name"),
    surname: pick("surname"),
    legalArea: pick("legalArea"),
    legalMatter: pick("legalMatter"),
    jurisdiction: pick("jurisdiction"),
    stage: typeof doc.stage === "string" ? doc.stage : "intake",
    lastUpdated: doc.updatedAt ?? doc.createdAt ?? null,
    archived: doc.archived === true,
  };
}

/**
 * The client docs this viewer may open. A member reads only their own: the doc
 * whose id is their email (projectId) plus any doc carrying their email, never
 * the whole `clients` collection. Staff (bypass) still list everything.
 */
async function viewerClientDocs(email: string, staff: boolean): Promise<FirestoreDocument[]> {
  if (staff) return await getAll(CLIENTS_COLLECTION).catch(() => []);
  if (!email) return [];
  const [own, byEmail, byDrip] = await Promise.all([
    get(CLIENTS_COLLECTION, emailToDocId(email)).catch(() => null),
    query(CLIENTS_COLLECTION, [{ field: "email", op: "EQUAL", value: email }]).catch(() => []),
    query(CLIENTS_COLLECTION, [{ field: "dripEmail", op: "EQUAL", value: email }]).catch(() => []),
  ]);
  const out = new Map<string, FirestoreDocument>();
  if (own) out.set(emailToDocId(email), { ...(own as Record<string, unknown>), id: emailToDocId(email) } as FirestoreDocument);
  for (const d of [...byEmail, ...byDrip]) if (d?.id) out.set(String(d.id), d);
  return [...out.values()];
}

export default function portalRouter(app: Express): void {
  // ── Matters ────────────────────────────────────────────────────────────────
  app.get(
    "/api/portal/matters",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const email = viewerEmail(req);
      const staff = isStaff(req);

      const docs = await viewerClientDocs(email, staff);
      const matters = docs
        .filter((d) => d?.id && mayAccess(d as Record<string, unknown>, String(d.id), email, staff))
        .filter((d) => !(d as Record<string, unknown>).archived)
        .map((d) => matterSummary(String(d.id), d as Record<string, unknown>));

      res.json({ matters, total: matters.length });
    }),
  );

  // ── Reminders (alerts) ──────────────────────────────────────────────────────
  app.get(
    "/api/portal/reminders",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const email = viewerEmail(req);
      const staff = isStaff(req);

      const docs: FirestoreDocument[] = staff
        ? await getAll(ALERTS_COLLECTION).catch(() => [])
        : await query(ALERTS_COLLECTION, [{ field: "email", op: "EQUAL", value: email }]).catch(() => []);

      const reminders = docs.map((d) => ({
        id: d.id,
        title: d.title ?? "",
        description: d.description ?? "",
        deadlineLabel: d.deadlineLabel ?? null,
        status: d.status ?? "scheduled",
        createdAt: d.createdAt ?? null,
      }));

      res.json({ reminders, total: reminders.length });
    }),
  );

  // ── Consultations ───────────────────────────────────────────────────────────
  app.get(
    "/api/portal/consultations",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const email = viewerEmail(req);
      const staff = isStaff(req);

      const docs = await viewerClientDocs(email, staff);
      const consultations: Record<string, unknown>[] = [];

      for (const d of docs) {
        if (!d?.id || !mayAccess(d as Record<string, unknown>, String(d.id), email, staff)) continue;
        const cons = Array.isArray((d as Record<string, unknown>).consultations)
          ? ((d as Record<string, unknown>).consultations as unknown as Record<string, unknown>[])
          : [];
        for (const c of cons) {
          const e = (c as Record<string, unknown>);
          consultations.push({
            clientId: String(d.id),
            timestamp: e.timestamp ?? null,
            legalArea: e.legalArea ?? null,
            legalMatter: e.legalMatter ?? null,
            jurisdiction: e.jurisdiction ?? null,
            source: e.source ?? null,
          });
        }
      }

      consultations.sort((a, b) =>
        String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? ""))
      );

      res.json({ consultations, total: consultations.length });
    }),
  );

  log("Portal router initialized.");
}