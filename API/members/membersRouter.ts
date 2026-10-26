/**
 * API/members/membersRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REST routes for the member-loop records in schemas/contracts.ts.
 *
 * Staff (requireDashboardAuth):
 *   GET    /api/staff/members/:clientId          member bundle (profile, membership, matters, …)
 *   GET    /api/staff/today                      my open csm_tasks + attention counts
 *   POST   /api/staff/csm-tasks/:id/close        { outcome } (required)
 *   GET    /api/staff/:slug                      list, equality filters via query string
 *   GET    /api/staff/:slug/:id
 *   POST   /api/staff/:slug
 *   PATCH  /api/staff/:slug/:id
 *     slug ∈ leads | memberships | matters | consultations | handoffs | csm-tasks | obligations
 *
 * Client (requireClientAuth; scoped to the session's clientId):
 *   GET    /api/member/home                      client-safe bundle
 *   GET    /api/member/:slug                     memberships | matters | consultations | handoffs | obligations
 *   PATCH  /api/member/obligations/:id           { status: "asked" | "dismissed" }
 *
 * Lawyer (requireProviderAuth; scoped to providerId; LAWYER_HIDDEN_FIELDS stripped):
 *   GET    /api/lawyer/consultations             ?from=&to= (ISO)
 *   GET    /api/lawyer/matters
 *   GET    /api/lawyer/handoffs
 *   GET    /api/lawyer/members/:clientId         brief data for a member the lawyer works with
 *   PATCH  /api/lawyer/consultations/:id         consent, status (in_progress | completed only), minutesUsed, transcript, summary, endedAt
 *   POST   /api/lawyer/handoffs                  { consultationId, legalNextSteps[], commercialNotes? }
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import query from "../../db/query.ts";
import {
  type AuthedRequest,
  requireClientAuth,
  requireDashboardAuth,
  requireProviderAuth,
} from "../../helper/auth/session.ts";
import {
  COLLECTIONS,
  type ConsentRecord,
  type Consultation,
  type CsmTask,
  type Handoff,
  type LegalNextStep,
  type Matter,
  type Obligation,
} from "../../schemas/contracts.ts";
import {
  chargeConsultation,
  clientView,
  createRecord,
  findRecords,
  forClient,
  forLawyer,
  getRecord,
  isSlug,
  lawyerCanSee,
  lawyerStatusError,
  memberBundle,
  missingFields,
  nowIso,
  SLUG_TO_COLLECTION,
  updateRecord,
  withDefaults,
} from "./service.ts";
import { onRecordCreated, onRecordUpdated } from "./events.ts";
import { recordingWithdrawn } from "../privacy/policy.ts";

/** Query-string keys accepted as equality filters on staff lists. */
const FILTER_KEYS = [
  "clientId",
  "matterId",
  "providerId",
  "assignedProviderId",
  "consultationId",
  "ownerEmail",
  "status",
  "type",
  "country",
  "email",
];

function filtersFrom(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FILTER_KEYS) {
    const v = req.query[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

const SORT_KEY: Record<string, string> = {
  leads: "createdAt",
  memberships: "createdAt",
  matters: "stageEnteredAt",
  consultations: "scheduledAt",
  handoffs: "approvedAt",
  "csm-tasks": "dueAt",
  obligations: "dueAt",
};

const CLIENT_SLUGS = new Set(["memberships", "matters", "consultations", "handoffs", "obligations"]);

/** Fields a lawyer may change on their own consultation. */
const LAWYER_CONSULTATION_FIELDS = ["consent", "status", "minutesUsed", "transcript", "summary", "endedAt"];

export default function membersRouter(app: Express) {
  log("Members router initialized.");

  // ══════════════════════════════════════════════════════════════════════════
  //  STAFF
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/staff/members/:clientId",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const bundle = await memberBundle(req.params.clientId);
      if (!bundle.client && !bundle.membership) return res.status(404).json({ error: "Member not found." });
      res.json(bundle);
    }),
  );

  app.get(
    "/api/staff/today",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const me = (req as AuthedRequest).dashboardUser ?? "";
      const owner = req.query.owner === "all" ? undefined : String(req.query.owner || me);
      const now = nowIso();
      const in14 = new Date(Date.now() + 14 * 86400000).toISOString();
      const [tasks, obligations] = await Promise.all([
        findRecords<CsmTask>(COLLECTIONS.csmTasks, { status: "open", ownerEmail: owner }, { sortBy: "dueAt" }),
        findRecords<Obligation>(COLLECTIONS.obligations, { status: "upcoming" }, { sortBy: "dueAt" }),
      ]);
      res.json({
        owner: owner ?? "all",
        tasks: tasks.map((t) => ({ ...t, overdue: t.dueAt < now })),
        counts: {
          open: tasks.length,
          overdue: tasks.filter((t) => t.dueAt < now).length,
          dueToday: tasks.filter((t) => t.dueAt.slice(0, 10) === now.slice(0, 10)).length,
          obligationsWithin14d: obligations.filter((o) => o.dueAt && o.dueAt >= now && o.dueAt <= in14).length,
        },
      });
    }),
  );

  app.post(
    "/api/staff/csm-tasks/:id/close",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const outcome = String(req.body?.outcome ?? "").trim();
      const status = req.body?.status === "cancelled" ? "cancelled" : "done";
      if (status === "done" && !outcome) return res.status(400).json({ error: "An outcome is required to close a task." });
      const existing = await getRecord<CsmTask>(COLLECTIONS.csmTasks, req.params.id);
      if (!existing) return res.status(404).json({ error: "Task not found." });
      const updated = await updateRecord<CsmTask>(COLLECTIONS.csmTasks, req.params.id, {
        status,
        outcome: outcome || undefined,
        closedAt: nowIso(),
        closedBy: (req as AuthedRequest).dashboardUser,
      });
      res.json(updated);
    }),
  );

  app.get(
    "/api/staff/:slug",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { slug } = req.params;
      if (!isSlug(slug)) return res.status(404).json({ error: "Unknown collection." });
      const limit = Math.min(Number(req.query.limit) || 500, 2000);
      const items = await findRecords(SLUG_TO_COLLECTION[slug], filtersFrom(req), {
        sortBy: SORT_KEY[slug],
        desc: req.query.order === "desc",
        limit,
      });
      res.json({ items });
    }),
  );

  app.get(
    "/api/staff/:slug/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { slug, id } = req.params;
      if (!isSlug(slug)) return res.status(404).json({ error: "Unknown collection." });
      const item = await getRecord(SLUG_TO_COLLECTION[slug], id);
      if (!item) return res.status(404).json({ error: "Not found." });
      res.json(item);
    }),
  );

  app.post(
    "/api/staff/:slug",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { slug } = req.params;
      if (!isSlug(slug)) return res.status(404).json({ error: "Unknown collection." });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const missing = missingFields(slug, body);
      if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(", ")}` });
      const record = await createRecord(SLUG_TO_COLLECTION[slug], withDefaults(slug, body));
      await onRecordCreated(slug, record, { actor: (req as AuthedRequest).dashboardUser });
      res.status(201).json(record);
    }),
  );

  app.patch(
    "/api/staff/:slug/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { slug, id } = req.params;
      if (!isSlug(slug)) return res.status(404).json({ error: "Unknown collection." });
      const before = await getRecord<Record<string, unknown>>(SLUG_TO_COLLECTION[slug], id);
      if (!before) return res.status(404).json({ error: "Not found." });
      const fields = { ...(req.body ?? {}) } as Record<string, unknown>;
      if (slug === "matters" && fields.stage && fields.stage !== before.stage) fields.stageEnteredAt = nowIso();
      if (slug === "memberships") fields.updatedAt = nowIso();
      if (slug === "csm-tasks" && fields.status === "done" && !String(fields.outcome ?? before.outcome ?? "").trim()) {
        return res.status(400).json({ error: "An outcome is required to close a task." });
      }
      const after = await updateRecord<Record<string, unknown>>(SLUG_TO_COLLECTION[slug], id, fields);
      if (after) await onRecordUpdated(slug, before, after, { actor: (req as AuthedRequest).dashboardUser });
      if (slug === "consultations" && after) await chargeConsultation(after as unknown as Consultation);
      res.json(after);
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  CLIENT (member)
  // ══════════════════════════════════════════════════════════════════════════

  const memberId = (req: Request, res: Response): string | null => {
    const id = (req as AuthedRequest).clientId;
    if (!id) {
      res.status(400).json({ error: "No member selected for this session." });
      return null;
    }
    return id;
  };

  app.get(
    "/api/member/home",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = memberId(req, res);
      if (!id) return;
      res.json(clientView(await memberBundle(id)));
    }),
  );

  app.get(
    "/api/member/:slug",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = memberId(req, res);
      if (!id) return;
      const { slug } = req.params;
      if (!isSlug(slug) || !CLIENT_SLUGS.has(slug)) return res.status(404).json({ error: "Unknown collection." });
      const items = await findRecords<Record<string, unknown>>(SLUG_TO_COLLECTION[slug], { clientId: id }, {
        sortBy: SORT_KEY[slug],
      });
      const safe = slug === "consultations"
        ? items.map((c) => ({
          ...c,
          transcript: undefined,
          summary: (c.summary as Consultation["summary"])?.status === "confirmed" ? c.summary : undefined,
        }))
        : items;
      res.json({ items: forClient(safe) });
    }),
  );

  app.patch(
    "/api/member/obligations/:id",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = memberId(req, res);
      if (!id) return;
      const status = req.body?.status;
      if (status !== "asked" && status !== "dismissed") {
        return res.status(400).json({ error: "status must be 'asked' or 'dismissed'." });
      }
      const o = await getRecord<Obligation>(COLLECTIONS.obligations, req.params.id);
      if (!o || o.clientId !== id) return res.status(404).json({ error: "Not found." });
      const after = await updateRecord<Obligation>(COLLECTIONS.obligations, o.id, { status, askedAt: nowIso() });
      if (after) await onRecordUpdated("obligations", o as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, { actor: (req as AuthedRequest).clientUser });
      res.json(forClient(after));
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  LAWYER
  // ══════════════════════════════════════════════════════════════════════════

  const lawyerId = (req: Request, res: Response): string | null => {
    const id = (req as AuthedRequest).providerId;
    if (!id) {
      res.status(403).json({ error: "No lawyer profile for this session." });
      return null;
    }
    return id;
  };

  app.get(
    "/api/lawyer/consultations",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = lawyerId(req, res);
      if (!pid) return;
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      const items = (await findRecords<Consultation>(COLLECTIONS.consultations, { providerId: pid }, {
        sortBy: "scheduledAt",
      })).filter((c) => (!from || c.scheduledAt >= from) && (!to || c.scheduledAt <= to));
      res.json({ items: forLawyer(items) });
    }),
  );

  app.get(
    "/api/lawyer/matters",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = lawyerId(req, res);
      if (!pid) return;
      const items = await findRecords<Matter>(COLLECTIONS.matters, { assignedProviderId: pid }, {
        sortBy: "stageEnteredAt",
      });
      res.json({ items: forLawyer(items) });
    }),
  );

  app.get(
    "/api/lawyer/handoffs",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = lawyerId(req, res);
      if (!pid) return;
      const items = await findRecords<Handoff>(COLLECTIONS.handoffs, { providerId: pid }, {
        sortBy: "approvedAt",
        desc: true,
      });
      res.json({ items: forLawyer(items).map((h) => ({ ...h, csmTaskIds: undefined })) });
    }),
  );

  app.get(
    "/api/lawyer/members/:clientId",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = lawyerId(req, res);
      if (!pid) return;
      const { clientId } = req.params;
      if (!(await lawyerCanSee(pid, clientId))) return res.status(404).json({ error: "Member not found." });
      const b = await memberBundle(clientId);
      res.json(forLawyer({
        ...b,
        tasks: undefined, // CSM workload is not the lawyer's
        consultations: b.consultations.filter((c) => c.providerId === pid),
        handoffs: b.handoffs.filter((h) => h.providerId === pid).map((h) => ({ ...h, csmTaskIds: undefined })),
      }));
    }),
  );

  app.patch(
    "/api/lawyer/consultations/:id",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = lawyerId(req, res);
      if (!pid) return;
      const before = await getRecord<Consultation>(COLLECTIONS.consultations, req.params.id);
      if (!before || before.providerId !== pid) return res.status(404).json({ error: "Not found." });
      const statusError = lawyerStatusError(req.body?.status, before.status);
      if (statusError) return res.status(400).json({ error: statusError });
      const fields: Record<string, unknown> = {};
      for (const k of LAWYER_CONSULTATION_FIELDS) if (req.body?.[k] !== undefined) fields[k] = req.body[k];
      if (fields.consent && typeof fields.consent === "object") {
        const recording = (fields.consent as Record<string, unknown>).recording;
        if (recording !== "granted" && recording !== "declined" && recording !== "pending") {
          return res.status(400).json({ error: "consent.recording must be granted, declined or pending." });
        }
        // P7: a member who withdrew recording on /status/privacy turns it back
        // on themselves (join screen or privacy page), not through the lawyer.
        if (recording === "granted") {
          const rows = (await query(COLLECTIONS.consents, [{ field: "clientId", op: "EQUAL", value: before.clientId }]).catch(() => null)) as ConsentRecord[] | null;
          if (!rows || recordingWithdrawn(rows)) {
            return res.status(409).json({ error: "The member withdrew recording consent. Only the member can turn it back on, from the join screen or their privacy page." });
          }
        }
        fields.consent = { recording, at: nowIso(), by: "lawyer", where: "lawyer_call" };
      }
      if (fields.summary && typeof fields.summary === "object") {
        const s = fields.summary as Record<string, unknown>;
        fields.summary = { ...s, confirmedAt: s.status === "confirmed" ? nowIso() : undefined };
      }
      if (fields.status === "completed" && !fields.endedAt && !before.endedAt) fields.endedAt = nowIso();
      const after = await updateRecord<Consultation>(COLLECTIONS.consultations, before.id, fields);
      if (after) {
        await onRecordUpdated("consultations", before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, { actor: (req as AuthedRequest).providerUser });
        await chargeConsultation(after);
      }
      res.json(forLawyer(after));
    }),
  );

  app.post(
    "/api/lawyer/handoffs",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = lawyerId(req, res);
      if (!pid) return;
      const consultationId = String(req.body?.consultationId ?? "");
      const c = await getRecord<Consultation>(COLLECTIONS.consultations, consultationId);
      if (!c || c.providerId !== pid) return res.status(404).json({ error: "Consultation not found." });
      if (c.handoffId) return res.status(409).json({ error: "This consultation already has a handoff.", handoffId: c.handoffId });
      const steps = Array.isArray(req.body?.legalNextSteps) ? req.body.legalNextSteps as LegalNextStep[] : [];
      const cleanSteps = steps
        .filter((s) => s && typeof s.what === "string" && s.what.trim())
        .map((s) => ({ what: s.what.trim(), who: s.who ?? "client", dueAt: s.dueAt }));
      if (!cleanSteps.length) return res.status(400).json({ error: "At least one next step is required." });
      const handoff = await createRecord<Partial<Handoff>>(COLLECTIONS.handoffs, withDefaults("handoffs", {
        consultationId,
        clientId: c.clientId,
        matterId: c.matterId,
        providerId: pid,
        legalNextSteps: cleanSteps,
        commercialNotes: typeof req.body?.commercialNotes === "string" ? req.body.commercialNotes : undefined,
      }) as Partial<Handoff>);
      await updateRecord(COLLECTIONS.consultations, consultationId, { handoffId: handoff.id });
      if (c.matterId) await updateRecord(COLLECTIONS.matters, c.matterId, { nextStep: cleanSteps[0] });
      const taskIds = await onRecordCreated("handoffs", handoff, { actor: (req as AuthedRequest).providerUser });
      res.status(201).json(forLawyer({ ...handoff, csmTaskIds: undefined, createdTaskCount: taskIds.length }));
    }),
  );
}
