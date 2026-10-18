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
import query from "../../db/query.ts";
import { requireClientAuth } from "../../helper/auth/session.ts";
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

/** The org domain that counts as "staff". */
const STAFF_DOMAIN = "internationallegalpartner.com";

function isStaff(req: Request): boolean {
  return !!(req as AuthedRequest).isIrpStaff ||
    viewerEmail(req).split("@")[1] === STAFF_DOMAIN;
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

export default function portalRouter(app: Express): void {
  // ── Matters ────────────────────────────────────────────────────────────────
  app.get(
    "/api/portal/matters",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const email = viewerEmail(req);
      const staff = isStaff(req);

      const docs: FirestoreDocument[] = await getAll(CLIENTS_COLLECTION).catch(() => []);
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

      const docs: FirestoreDocument[] = await getAll(CLIENTS_COLLECTION).catch(() => []);
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