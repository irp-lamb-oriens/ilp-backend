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
 *   PATCH  /api/member/obligations/:id           { status: "asked" | "dismissed" }, or the Deadlines fields
 *                                                 (userDueAt, status upcoming|handled, remind, dismissed, notes)
 *
 * Lawyer (requireProviderAuth; scoped to providerId; LAWYER_HIDDEN_FIELDS stripped):
 *   GET    /api/lawyer/consultations             ?from=&to= (ISO)
 *
 * LISTS: every list route above also answers the paged contract of
 * helper/listing.ts (?limit, ?cursor, ?sort, ?dir, ?q, filters, NDJSON with
 * ?stream=1) and keeps its old response when none of those is sent. The
 * session's scope (clientId for members, providerId for lawyers) is always
 * part of the query, so no cursor or filter can reach another account's rows.
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
  chargeableMinutes,
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
import { parseDeadlinePatch } from "./deadlines.ts";
import { recordingWithdrawn } from "../privacy/policy.ts";
import auditLog from "../../helper/auditLog.ts";
import { JOIN_OPENS_MIN } from "../calls/callLogic.ts";
import { recordingStillAllowed } from "../calls/callService.ts";
import { isListRequest, type ListSpec, mapProducer, respondList } from "../../helper/listing.ts";
import { pageRecords, rangeFilters, recordSpec } from "../../db/recordLists.ts";
import type { RecordCollection } from "../../db/records.ts";
import { ensureStageConfig } from "../dashboard/automation/stageConfig.ts";
import get from "../../db/get.ts";
import { clientName } from "../provider/lawyerHomeRoutes.ts";
import { fieldValue, LIST_SCHEMAS, type ListSchema } from "../../schemas/listSchemas.ts";

/** FILTERS: the field schema of each record list (schemas/listSchemas.ts). */
const SLUG_SCHEMA: Record<string, ListSchema> = {
  leads: LIST_SCHEMAS.recordLeads,
  memberships: LIST_SCHEMAS.recordMemberships,
  matters: LIST_SCHEMAS.staffMatters,
  consultations: LIST_SCHEMAS.recordConsultations,
  handoffs: LIST_SCHEMAS.recordHandoffs,
  "csm-tasks": LIST_SCHEMAS.recordTasks,
  obligations: LIST_SCHEMAS.recordObligations,
};

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

type Rec = Record<string, unknown> & { id: string };

/** LISTS: sorts per slug (first one is the default, with its direction). */
const SLUG_SORTS: Record<string, { sorts: string[]; dir: "asc" | "desc" }> = {
  leads: { sorts: ["createdAt", "name", "email"], dir: "desc" },
  memberships: { sorts: ["createdAt", "periodEnd", "status"], dir: "desc" },
  matters: { sorts: ["stageEnteredAt", "openedAt", "title"], dir: "asc" },
  consultations: { sorts: ["scheduledAt", "status"], dir: "asc" },
  handoffs: { sorts: ["approvedAt"], dir: "desc" },
  "csm-tasks": { sorts: ["dueAt", "createdAt", "title"], dir: "asc" },
  obligations: { sorts: ["dueAt", "title"], dir: "asc" },
};

/** Equality filters per slug. Matters keep country in memory: older matters have none (read as CR). */
const slugEqKeys = (slug: string) => FILTER_KEYS.filter((k) => !(slug === "matters" && k === "country")).concat(slug === "matters" ? ["stage", "area"] : []);

function slugSpec(slug: string, dir?: "asc" | "desc"): ListSpec<Rec> {
  const cfg = SLUG_SORTS[slug];
  const base = recordSpec<Rec>(SLUG_TO_COLLECTION[slug as keyof typeof SLUG_TO_COLLECTION] as RecordCollection, {
    sorts: cfg.sorts,
    defaultSort: cfg.sorts[0],
    defaultDir: dir ?? cfg.dir,
    eqFilters: slugEqKeys(slug),
    filters: {
      ...rangeFilters<Rec>(cfg.sorts[0]),
      ...(slug === "matters" ? { country: (r: Rec, v: string) => String(r.country ?? "CR") === v } : {}),
    },
  });
  return {
    ...base,
    schema: SLUG_SCHEMA[slug],
    read: (r, f) => (f.type === "country" ? r[f.key] ?? "CR" : fieldValue(r, f)),
  };
}

const CLIENT_SLUGS = new Set(["memberships", "matters", "consultations", "handoffs", "obligations"]);

/** Fields a lawyer may change on their own consultation. */
/** REL: every staff write to a member record is audited (who, which record, which fields; not the values). */
function staffAudit(req: Request, action: string, target: string, meta: Record<string, unknown>) {
  const email = String((req as AuthedRequest).dashboardUser ?? "unknown");
  return auditLog({ actor: { uid: email, email, role: (req as AuthedRequest).dashboardRole ?? "staff" }, action, target, meta }).catch(() => {});
}

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
      if (isListRequest(req)) {
        const spec = slugSpec(slug);
        // Pipeline header: open matters per stage and past the stage time limit, once with the first page.
        let meta: Record<string, unknown> | undefined;
        if (slug === "matters" && !req.query.cursor) {
          const country = typeof req.query.country === "string" ? req.query.country : "";
          const [all, stages] = await Promise.all([findRecords<Matter>(COLLECTIONS.matters), ensureStageConfig().catch(() => [])]);
          const sla = new Map(stages.map((st) => [st.id, st.slaDays ?? 14]));
          const open = all.filter((m) => !m.closedAt && (!country || (m.country ?? "CR") === country));
          const byStage: Record<string, number> = {};
          for (const m of open) byStage[m.stage] = (byStage[m.stage] ?? 0) + 1;
          const now = Date.now();
          const late = open.filter((m) => now - Date.parse(m.stageEnteredAt) > (sla.get(m.stage) ?? 14) * 86400000).length;
          meta = { byStage, openTotal: open.length, late };
        }
        return respondList(req, res, spec, (p) => ({
          // BOARDS: matter cards show the member's name; looked up per streamed batch only.
          produce: slug === "matters"
            ? mapProducer(pageRecords<Rec>(COLLECTIONS.matters, {}, p, spec, slugEqKeys(slug)), async (items) => {
              const ids = [...new Set(items.map((m) => String(m.clientId ?? "")).filter(Boolean))];
              const docs = await Promise.all(ids.map((id) => get(COLLECTIONS.clients, id).catch(() => null)));
              const names = new Map(ids.map((id, i) => [id, clientName(docs[i] as Record<string, unknown> | null, "")]));
              return items.map((m) => ({ ...m, memberName: names.get(String(m.clientId ?? "")) || undefined }));
            })
            : pageRecords<Rec>(SLUG_TO_COLLECTION[slug] as RecordCollection, {}, p, spec, slugEqKeys(slug)),
          meta,
        }));
      }
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
      // REL: a new matter follows the member's lawyer unless staff name one.
      if (slug === "matters" && !body.assignedProviderId) {
        const client = await get(COLLECTIONS.clients, String(body.clientId)).catch(() => null);
        if (typeof client?.assignedProviderId === "string" && client.assignedProviderId) body.assignedProviderId = client.assignedProviderId;
      }
      const record = await createRecord(SLUG_TO_COLLECTION[slug], withDefaults(slug, body));
      await onRecordCreated(slug, record, { actor: (req as AuthedRequest).dashboardUser });
      void staffAudit(req, "record.created", `${SLUG_TO_COLLECTION[slug]}/${record.id}`, { clientId: body.clientId, fields: Object.keys(body) });
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
      void staffAudit(req, "record.updated", `${SLUG_TO_COLLECTION[slug]}/${id}`, { clientId: before.clientId, fields: Object.keys(fields) });
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
      const clientSafe = (items: Record<string, unknown>[]) =>
        forClient(slug === "consultations"
          ? items.map((c) => ({
            ...c,
            transcript: undefined,
            summary: (c.summary as Consultation["summary"])?.status === "confirmed" ? c.summary : undefined,
          }))
          : items);
      if (isListRequest(req)) {
        const spec = slugSpec(slug, slug === "consultations" || slug === "handoffs" ? "desc" : undefined);
        // The member's own records only: clientId is the fixed scope, whatever the query says.
        return respondList(req, res, spec, (p) => ({
          produce: mapProducer(pageRecords<Rec>(SLUG_TO_COLLECTION[slug] as RecordCollection, { clientId: id }, p, spec, slugEqKeys(slug)), clientSafe),
        }));
      }
      const items = await findRecords<Record<string, unknown>>(SLUG_TO_COLLECTION[slug], { clientId: id }, {
        sortBy: SORT_KEY[slug],
      });
      res.json({ items: clientSafe(items) });
    }),
  );

  app.patch(
    "/api/member/obligations/:id",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = memberId(req, res);
      if (!id) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = body.status;
      const o = await getRecord<Obligation>(COLLECTIONS.obligations, req.params.id);
      if (!o || o.clientId !== id) return res.status(404).json({ error: "Not found." });
      let fields: Record<string, unknown>;
      if (Object.keys(body).length === 1 && status === "asked") {
        fields = { status, askedAt: nowIso() };
      } else if (Object.keys(body).length === 1 && status === "dismissed") {
        // Older callers: "dismissed" is the Deadlines page's Remove (dismissedAt, undo restores it).
        fields = { status, askedAt: nowIso(), dismissedAt: nowIso() };
      } else {
        // DEADLINES: the same fields as PATCH /api/client-status/me/deadlines/:id.
        const parsed = parseDeadlinePatch(body, o);
        if ("error" in parsed) return res.status(400).json({ error: parsed.error });
        fields = parsed as Record<string, unknown>;
      }
      const after = await updateRecord<Obligation>(COLLECTIONS.obligations, o.id, fields);
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
      if (isListRequest(req)) {
        const spec = slugSpec("consultations");
        return respondList(req, res, spec, (p) => ({
          produce: mapProducer(pageRecords<Rec>(COLLECTIONS.consultations, { providerId: pid }, p, spec, ["status", "clientId", "matterId"]), (items) => forLawyer(items)),
        }));
      }
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
      if (isListRequest(req)) {
        const spec = slugSpec("matters");
        return respondList(req, res, spec, (p) => ({
          produce: mapProducer(pageRecords<Rec>(COLLECTIONS.matters, { assignedProviderId: pid }, p, spec, ["stage", "clientId", "area"]), (items) => forLawyer(items)),
        }));
      }
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
      if (isListRequest(req)) {
        const spec = slugSpec("handoffs");
        return respondList(req, res, spec, (p) => ({
          produce: mapProducer(pageRecords<Rec>(COLLECTIONS.handoffs, { providerId: pid }, p, spec, ["clientId", "matterId"]), (items) =>
            forLawyer(items).map((h) => ({ ...h, csmTaskIds: undefined }))),
        }));
      }
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
      // REL: a call cannot start or be completed (and charged) before its time.
      if ((fields.status === "in_progress" || fields.status === "completed") && fields.status !== before.status &&
        Date.now() < Date.parse(before.scheduledAt) - JOIN_OPENS_MIN * 60_000) {
        return res.status(409).json({ error: "This call has not started yet." });
      }
      // REL: minutes are whole numbers between 0 and the booked length.
      if (fields.minutesUsed !== undefined) {
        const n = Number(fields.minutesUsed);
        if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "minutesUsed must be a number of minutes." });
        fields.minutesUsed = chargeableMinutes({ minutesUsed: n, durationMin: before.durationMin });
      }
      if (fields.endedAt !== undefined && (typeof fields.endedAt !== "string" || Number.isNaN(Date.parse(fields.endedAt)))) {
        return res.status(400).json({ error: "endedAt must be a date." });
      }
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
      // REL: a transcript is stored only with recording consent (granted on the call, not withdrawn since).
      if (fields.transcript !== undefined) {
        if (typeof fields.transcript !== "string") return res.status(400).json({ error: "transcript must be text." });
        const consentNow = (fields.consent as Consultation["consent"] | undefined) ?? before.consent;
        if (!(await recordingStillAllowed({ clientId: before.clientId, consent: consentNow }))) {
          return res.status(409).json({ error: "The member did not agree to recording, so no transcript can be stored. Write the summary yourself." });
        }
        fields.transcript = fields.transcript.slice(0, 200_000);
        fields.transcriptSource = "pasted";
      }
      if (fields.summary !== undefined) {
        const s = (fields.summary && typeof fields.summary === "object" ? fields.summary : {}) as Record<string, unknown>;
        const text = typeof s.text === "string" ? s.text.trim().slice(0, 5000) : "";
        if (!text) return res.status(400).json({ error: "The summary needs some text." });
        if (s.status !== "suggested" && s.status !== "confirmed") return res.status(400).json({ error: "summary.status must be suggested or confirmed." });
        if (before.summary?.status === "confirmed" && s.status === "suggested") {
          return res.status(409).json({ error: "This summary is already confirmed." });
        }
        fields.summary = { text, status: s.status, confirmedAt: s.status === "confirmed" ? (before.summary?.confirmedAt ?? nowIso()) : undefined };
      }
      if (fields.status === "completed" && !fields.endedAt && !before.endedAt) fields.endedAt = nowIso();
      const after = await updateRecord<Consultation>(COLLECTIONS.consultations, before.id, fields);
      if (after) {
        await onRecordUpdated("consultations", before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, { actor: (req as AuthedRequest).providerUser });
        await chargeConsultation(after);
        const changed = Object.keys(fields).filter((k) => k !== "transcript");
        if (fields.transcript !== undefined) changed.push("transcript");
        void auditLog({
          actor: { uid: pid, email: String((req as AuthedRequest).providerUser ?? ""), role: "lawyer" },
          action: (fields.summary as { status?: string } | undefined)?.status === "confirmed" && before.summary?.status !== "confirmed"
            ? "consultation.summary_confirmed"
            : "consultation.updated",
          target: `consultations/${before.id}`,
          meta: { clientId: before.clientId, fields: changed, status: after.status },
        }).catch(() => {});
      }
      const fresh = await getRecord<Consultation>(COLLECTIONS.consultations, before.id);
      res.json(forLawyer(fresh ?? after));
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
      // REL: the lawyer's judgment goes to the member only once they confirmed it.
      if (c.status !== "completed" || c.summary?.status !== "confirmed") {
        return res.status(409).json({ error: "Confirm the summary and complete the call before handing off." });
      }
      const steps = Array.isArray(req.body?.legalNextSteps) ? req.body.legalNextSteps as LegalNextStep[] : [];
      const cleanSteps = steps
        .filter((s) => s && typeof s.what === "string" && s.what.trim())
        .slice(0, 10)
        .map((s) => ({
          what: s.what.trim().slice(0, 500),
          who: (s.who === "lawyer" || s.who === "ilp" ? s.who : "client") as LegalNextStep["who"],
          dueAt: typeof s.dueAt === "string" && !Number.isNaN(Date.parse(s.dueAt)) ? new Date(s.dueAt).toISOString() : undefined,
        }));
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
      if (c.matterId) await updateRecord(COLLECTIONS.matters, c.matterId, { nextStep: cleanSteps[0], nextStepSetAt: handoff.approvedAt });
      const taskIds = await onRecordCreated("handoffs", handoff, { actor: (req as AuthedRequest).providerUser });
      void auditLog({
        actor: { uid: pid, email: String((req as AuthedRequest).providerUser ?? ""), role: "lawyer" },
        action: "handoff.created",
        target: `handoffs/${handoff.id}`,
        meta: { clientId: c.clientId, consultationId, steps: cleanSteps.length },
      }).catch(() => {});
      res.status(201).json(forLawyer({ ...handoff, csmTaskIds: undefined, createdTaskCount: taskIds.length }));
    }),
  );
}
