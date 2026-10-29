/**
 * API/dashboard/staffHome/staffHomeRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Staff and CSM home (W6). Builds on W1's /api/staff/* routes; these add the
 * cross-member views the Today page and member page need.
 *
 *   GET  /api/dashboard/staff/summary                         KPI strip + "Needs attention" rail (?excludePlaceholder=1)
 *   GET  /api/dashboard/staff/queue                           ?owner=me|all|<email>&excludePlaceholder=1: open csm_tasks by due date, with member names
 *   GET  /api/dashboard/staff/members                         ?status&csm&ready&country&q&sort&dir&page&pageSize
 *   GET  /api/dashboard/staff/members/:clientId/timeline      consultations, handoffs, tasks, quotes, notes, audit
 *   POST /api/dashboard/staff/members/:clientId/assign-lawyer { providerId, matterId? }
 *   POST /api/dashboard/staff/handoffs/:id/proposal-task      { title?, dueAt? } (idempotent per handoff)
 *   GET  /api/dashboard/staff/lawyers                         capacity per lawyer
 *
 * LISTS: queue, members, timeline and lawyers also answer the paged contract
 * of helper/listing.ts (?limit, ?cursor, ?sort, ?dir, ?q, filters, NDJSON);
 * without those params they keep their old response.
 *
 * Registered from dashboardRouter.ts, so main.ts is unchanged. Every route is
 * staff-only (requireDashboardAuth); writes are audited.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../../helper/asyncHandler.ts";
import log from "../../../helper/log.ts";
import get from "../../../db/get.ts";
import getAll from "../../../db/getAll.ts";
import patch from "../../../db/patch.ts";
import query from "../../../db/query.ts";
import auditLog from "../../../helper/auditLog.ts";
import { isPlaceholderDoc } from "../../../helper/placeholder.ts";
import { type AuthedRequest, requireDashboardAuth } from "../../../helper/auth/session.ts";
import { createRecord, findRecords, getRecord, updateRecord } from "../../../db/records.ts";
import {
  COLLECTIONS,
  SALES_TEAM_ID,
  type Consultation,
  type CsmContact,
  type CsmTask,
  type Handoff,
  type Matter,
  type Membership,
  type Obligation,
  TASK_RULES,
} from "../../../schemas/contracts.ts";
import {
  buildTimeline,
  displayName,
  computeAttention,
  computeKpis,
  DAY_MS,
  filterMembers,
  type MemberQuery,
  type MemberRow,
  memberRows,
  type TimelineEntry,
} from "./compute.ts";
import { isListRequest, type ListSpec, mapProducer, pageProducer, pageRows, respondList } from "../../../helper/listing.ts";
import { pageRecords, recordSpec } from "../../../db/recordLists.ts";
import { fieldValue, LIST_SCHEMAS } from "../../../schemas/listSchemas.ts";
import { lawyerFacts } from "../../routing/service.ts"; // ROUTING
import { noReviewsSummary, ratingLabel, ratingsByProvider } from "../../routing/ratings.ts"; // ROUTING
import { loadSpecialties } from "../../routing/specialties.ts"; // ROUTING
import { CSM_SCOPE_DENIED, memberAccess } from "../../csm/book.ts"; // COMMS-P3

// ── LISTS: paged specs (helper/listing.ts) ──────────────────────────────────

type TaskRec = CsmTask & Doc & { id: string };

const QUEUE_SPEC: ListSpec<TaskRec> = {
  ...recordSpec<TaskRec>(COLLECTIONS.csmTasks, {
    sorts: ["dueAt", "createdAt", "title"],
    defaultSort: "dueAt",
    eqFilters: ["type", "clientId"],
    filters: {
      excludePlaceholder: (t, v) => v !== "1" || !isPlaceholderDoc(t),
      overdue: (t, v) => v !== "1" || t.dueAt < new Date().toISOString(),
    },
  }),
  schema: LIST_SCHEMAS.staffQueue,
  read: (t, f) =>
    f.key === "overdue" ? t.dueAt < new Date().toISOString() : f.key === "placeholder" ? isPlaceholderDoc(t) : fieldValue(t, f),
};

export const MEMBERS_SPEC: ListSpec<MemberRow> = {
  sorts: {
    name: (r) => r.name.toLowerCase(),
    joined: (r) => r.activatedAt ?? "",
    completeness: (r) => r.completeness,
    renewal: (r) => r.periodEnd ?? "",
  },
  defaultSort: "name",
  filters: {
    status: (r, v) => r.status === v,
    csm: (r, v) => (v === "none" ? !r.csmEmail : (r.csmEmail ?? "").toLowerCase() === v.toLowerCase()),
    country: (r, v) => r.country === v,
    ready: (r, v) => (v === "ready" ? r.consultationReady : v === "not_ready" ? !r.consultationReady : true),
    excludePlaceholder: (r, v) => v !== "1" || !r.placeholder,
  },
  search: (r) => [r.name, r.email, r.clientId],
  id: (r) => r.clientId,
  schema: LIST_SCHEMAS.staffMembers,
};

export const TIMELINE_SPEC: ListSpec<TimelineEntry> = {
  sorts: { at: (e) => e.at },
  defaultSort: "at",
  defaultDir: "desc",
  filters: { kind: (e, v) => e.kind === v },
  search: (e) => [e.title, e.body, e.actor],
  schema: LIST_SCHEMAS.staffTimeline,
};

interface CapacityRow {
  id: string;
  name: string;
  email: string;
  legalAreas: unknown[];
  openMatters: number;
  agingMatters: number;
  callsNext7d: number;
  // ROUTING (staff only)
  specialties: string[];
  specialtyLabels: string[];
  countries: string[];
  ratingScore: number;
  reviewCount: number;
  ratingStatus: string;
  ratingLabel: string;
  routingStatus: string;
  bookable: boolean;
}

export const LAWYERS_SPEC: ListSpec<CapacityRow> = {
  sorts: { openMatters: (r) => r.openMatters, name: (r) => r.name.toLowerCase(), callsNext7d: (r) => r.callsNext7d, agingMatters: (r) => r.agingMatters, ratingScore: (r) => r.ratingScore },
  defaultSort: "openMatters",
  defaultDir: "desc",
  filters: {
    area: (r, v) => r.legalAreas.map(String).includes(v),
    specialty: (r, v) => r.specialties.includes(v),
    country: (r, v) => r.countries.includes(v),
  },
  search: (r) => [r.name, r.email, r.legalAreas, r.specialtyLabels],
  schema: LIST_SCHEMAS.staffLawyers,
};

type Doc = Record<string, unknown>;

const actorOf = (req: Request) => {
  const r = req as AuthedRequest;
  const email = r.dashboardUser ?? "staff";
  return { uid: email, email, role: r.dashboardRole ?? "staff" };
};

/** Client docs for a set of ids, fetched one by one (bounded by member count, no full scan). */
async function clientsById(ids: Iterable<string>): Promise<Map<string, Doc>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const docs = await Promise.all(unique.map((id) => get(COLLECTIONS.clients, id).catch(() => null)));
  const out = new Map<string, Doc>();
  unique.forEach((id, i) => {
    const d = docs[i];
    if (d) out.set(id, { ...(d as Doc), id });
  });
  return out;
}

async function providerNames(ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const docs = await Promise.all(unique.map((id) => get("providers", id).catch(() => null)));
  const out = new Map<string, string>();
  unique.forEach((id, i) => {
    const d = docs[i] as Doc | null;
    out.set(id, (d && (String(d.name ?? "") || String(d.email ?? ""))) || id);
  });
  return out;
}

const qs = (req: Request, k: string): string => (typeof req.query[k] === "string" ? String(req.query[k]) : "");

export default function staffHomeRouter(app: Express): void {
  log("Staff home router initialized.");

  // ── Today: KPI strip + Needs attention ────────────────────────────────────
  app.get(
    "/api/dashboard/staff/summary",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const me = (req as AuthedRequest).dashboardUser ?? "";
      const all = await Promise.all([
        findRecords<Membership>(COLLECTIONS.memberships),
        findRecords<CsmTask>(COLLECTIONS.csmTasks, { status: "open" }),
        findRecords<Handoff>(COLLECTIONS.handoffs),
        findRecords<Matter>(COLLECTIONS.matters),
        findRecords<Obligation>(COLLECTIONS.obligations, { status: "upcoming" }),
        findRecords<Obligation>(COLLECTIONS.obligations, { status: "asked" }),
      ]);
      // Placeholder (seed) data counts by default; ?excludePlaceholder=1 leaves it out.
      const placeholderMembers = all[0].filter((m) => isPlaceholderDoc(m)).length;
      const exclude = qs(req, "excludePlaceholder") === "1";
      const keep = <T>(list: T[]) => (exclude ? list.filter((d) => !isPlaceholderDoc(d)) : list);
      const [memberships, openTasks, handoffs, matters, upcoming, asked] = [
        keep(all[0]), keep(all[1]), keep(all[2]), keep(all[3]), keep(all[4]), keep(all[5]),
      ] as [Membership[], CsmTask[], Handoff[], Matter[], Obligation[], Obligation[]];
      const [clients, consultations] = await Promise.all([
        clientsById(memberships.map((m) => m.clientId)),
        Promise.all(handoffs.map((h) => getRecord<Consultation>(COLLECTIONS.consultations, h.consultationId))),
      ]);
      const kpis = computeKpis({
        memberships,
        clients,
        tasks: openTasks,
        handoffs,
        consultations: consultations.filter((c): c is Consultation => !!c),
        me,
      });
      const attention = computeAttention({ memberships, clients, matters, obligations: [...upcoming, ...asked] });
      res.json({
        me,
        role: (req as AuthedRequest).dashboardRole ?? "staff",
        kpis,
        attention,
        placeholder: { members: placeholderMembers, excluded: exclude },
      });
    }),
  );

  // ── My queue: W1's /api/staff/today plus member names and membership state ─
  app.get(
    "/api/dashboard/staff/queue",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const me = (req as AuthedRequest).dashboardUser ?? "";
      const ownerQ = qs(req, "owner");
      const owner = ownerQ === "all" ? undefined : ownerQ && ownerQ !== "me" ? ownerQ : me;
      if (isListRequest(req)) {
        const scope: Record<string, string> = owner ? { status: "open", ownerEmail: owner } : { status: "open" };
        const enrich = async (batch: TaskRec[]) => {
          const ids = [...new Set(batch.map((t) => t.clientId))];
          const [clients, ms] = await Promise.all([
            clientsById(ids),
            Promise.all(ids.map((id) => findRecords<Membership>(COLLECTIONS.memberships, { clientId: id }, { sortBy: "createdAt", desc: true }))),
          ]);
          const status = new Map(ids.map((id, i) => [id, (ms[i].find((m) => m.status === "active") ?? ms[i][0])?.status ?? null]));
          const now = new Date().toISOString();
          return batch.map((t) => ({
            ...t,
            overdue: t.dueAt < now,
            memberName: displayName(clients.get(t.clientId), t.clientId),
            membershipStatus: status.get(t.clientId) ?? null,
          }));
        };
        // Counts for the page header, once per list (first page only): open tasks are a bounded set.
        let meta: Record<string, unknown> = { owner: owner ?? "all" };
        if (!qs(req, "cursor")) {
          const all = (await findRecords<CsmTask>(COLLECTIONS.csmTasks, scope))
            .filter((t) => qs(req, "excludePlaceholder") !== "1" || !isPlaceholderDoc(t));
          const now = new Date().toISOString();
          meta = {
            ...meta,
            counts: {
              open: all.length,
              overdue: all.filter((t) => t.dueAt < now).length,
              dueToday: all.filter((t) => t.dueAt.slice(0, 10) === now.slice(0, 10)).length,
            },
          };
        }
        return respondList(req, res, QUEUE_SPEC, (p) => ({
          produce: mapProducer(pageRecords<TaskRec>(COLLECTIONS.csmTasks, scope, p, QUEUE_SPEC, ["type", "clientId"]), enrich),
          meta,
        }));
      }
      const found = await findRecords<CsmTask>(COLLECTIONS.csmTasks, { status: "open", ownerEmail: owner }, { sortBy: "dueAt" });
      const tasks = qs(req, "excludePlaceholder") === "1" ? found.filter((t) => !isPlaceholderDoc(t)) : found;
      const ids = [...new Set(tasks.map((t) => t.clientId))];
      const [clients, memberships] = await Promise.all([
        clientsById(ids),
        Promise.all(ids.map((id) => findRecords<Membership>(COLLECTIONS.memberships, { clientId: id }, { sortBy: "createdAt", desc: true }))),
      ]);
      const status = new Map(ids.map((id, i) => {
        const list = memberships[i];
        return [id, (list.find((m) => m.status === "active") ?? list[0])?.status ?? null];
      }));
      const now = new Date().toISOString();
      res.json({
        owner: owner ?? "all",
        tasks: tasks.map((t) => ({
          ...t,
          overdue: t.dueAt < now,
          memberName: displayName(clients.get(t.clientId), t.clientId),
          membershipStatus: status.get(t.clientId) ?? null,
        })),
        counts: {
          open: tasks.length,
          overdue: tasks.filter((t) => t.dueAt < now).length,
          dueToday: tasks.filter((t) => t.dueAt.slice(0, 10) === now.slice(0, 10)).length,
        },
      });
    }),
  );

  // ── Members list (server-side filter + pagination) ────────────────────────
  app.get(
    "/api/dashboard/staff/members",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const [memberships, openTasks] = await Promise.all([
        findRecords<Membership>(COLLECTIONS.memberships),
        findRecords<CsmTask>(COLLECTIONS.csmTasks, { status: "open" }),
      ]);
      const clients = await clientsById(memberships.map((m) => m.clientId));
      const rows = memberRows(memberships, clients, openTasks);
      if (isListRequest(req)) {
        const csms = [...new Set(rows.map((r) => r.csmEmail).filter((e): e is string => !!e))].sort();
        return respondList(req, res, MEMBERS_SPEC, (p) => ({ produce: pageProducer(pageRows(rows, p, MEMBERS_SPEC)), meta: { csms } }));
      }
      const ready = qs(req, "ready");
      const q: MemberQuery = {
        status: qs(req, "status"),
        csm: qs(req, "csm"),
        ready: ready === "ready" || ready === "not_ready" ? ready : "",
        country: qs(req, "country"),
        q: qs(req, "q"),
        sort: (["name", "joined", "completeness", "renewal"].includes(qs(req, "sort")) ? qs(req, "sort") : "name") as MemberQuery["sort"],
        dir: qs(req, "dir") === "desc" ? "desc" : "asc",
        page: Number(qs(req, "page")) || 1,
        pageSize: Number(qs(req, "pageSize")) || 25,
      };
      const csms = [...new Set(rows.map((r) => r.csmEmail).filter((e): e is string => !!e))].sort();
      res.json({ ...filterMembers(rows, q), csms });
    }),
  );

  // ── Member timeline ───────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/staff/members/:clientId/timeline",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId } = req.params;
      // COMMS-P3: a CSM reads only their own members (and unassigned ones).
      if (!(await memberAccess(req, clientId)).allowed) return res.status(403).json({ error: CSM_SCOPE_DENIED, code: "csm_scope" });
      const where = { clientId };
      const [clientDoc, memberships, consultations, handoffs, tasks, contacts] = await Promise.all([
        get(COLLECTIONS.clients, clientId),
        findRecords<Membership>(COLLECTIONS.memberships, where),
        findRecords<Consultation>(COLLECTIONS.consultations, where),
        findRecords<Handoff>(COLLECTIONS.handoffs, where),
        findRecords<CsmTask>(COLLECTIONS.csmTasks, where),
        query(COLLECTIONS.csmContacts, [{ field: "clientId", op: "EQUAL", value: clientId }]).catch(() => []) as Promise<unknown[]>,
      ]);
      if (!clientDoc && !memberships.length) return res.status(404).json({ error: "Member not found." });
      const targets = [`clients/${clientId}`, ...memberships.map((m) => `memberships/${m.id}`)];
      const auditRows = (await Promise.all(
        targets.map((t) => query(COLLECTIONS.auditLog, [{ field: "target", op: "EQUAL", value: t }]).catch(() => [])),
      )).flat() as Doc[];
      const names = await providerNames([...consultations.map((c) => c.providerId), ...handoffs.map((h) => h.providerId)]);
      const items = buildTimeline({
        client: clientDoc ? { ...(clientDoc as Doc), id: clientId } : null,
        memberships,
        consultations,
        handoffs,
        tasks,
        audit: auditRows,
        providerNames: names,
        contacts: contacts as CsmContact[],
      });
      if (isListRequest(req)) {
        return respondList(req, res, TIMELINE_SPEC, (p) => ({ produce: pageProducer(pageRows(items, p, TIMELINE_SPEC)) }));
      }
      res.json({ items: items.slice(0, 200) });
    }),
  );

  // ── Assign a lawyer (client record + open matters) ────────────────────────
  app.post(
    "/api/dashboard/staff/members/:clientId/assign-lawyer",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId } = req.params;
      const providerId = String(req.body?.providerId ?? "").trim();
      const matterId = String(req.body?.matterId ?? "").trim();
      if (!providerId) return res.status(400).json({ error: "providerId is required." });
      const [client, provider] = await Promise.all([get(COLLECTIONS.clients, clientId), get("providers", providerId)]);
      if (!client) return res.status(404).json({ error: "Member not found." });
      if (!provider) return res.status(404).json({ error: "Lawyer not found." });
      const actor = actorOf(req);
      const now = new Date().toISOString();
      await patch(COLLECTIONS.clients, clientId, { assignedProviderId: providerId, assignedAt: now, assignedBy: actor.email });
      const matters = (await findRecords<Matter>(COLLECTIONS.matters, { clientId }))
        .filter((m) => !m.closedAt && (matterId ? m.id === matterId : !m.assignedProviderId));
      await Promise.all(matters.map((m) => updateRecord(COLLECTIONS.matters, m.id, { assignedProviderId: providerId })));
      await auditLog({
        actor,
        action: "staff.assign_lawyer",
        target: `clients/${clientId}`,
        meta: { providerId, matterIds: matters.map((m) => m.id) },
      });
      res.json({ ok: true, providerId, matterIds: matters.map((m) => m.id) });
    }),
  );

  // ── Handoff → proposal task (CSM commercial follow-up) ────────────────────
  app.post(
    "/api/dashboard/staff/handoffs/:id/proposal-task",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const h = await getRecord<Handoff>(COLLECTIONS.handoffs, req.params.id);
      if (!h) return res.status(404).json({ error: "Handoff not found." });
      const existing = (await findRecords<CsmTask>(COLLECTIONS.csmTasks, { clientId: h.clientId, type: "proposal" }))
        .find((t) => t.status === "open" && t.source?.kind === "handoff" && t.source.id === h.id);
      if (existing) return res.status(200).json({ task: existing, created: false });
      const actor = actorOf(req);
      const rule = TASK_RULES["handoff.opportunity"];
      const membership = (await findRecords<Membership>(COLLECTIONS.memberships, { clientId: h.clientId }))
        .find((m) => m.status === "active");
      const title = String(req.body?.title ?? "").trim() || rule.title;
      const dueAt = typeof req.body?.dueAt === "string" && req.body.dueAt
        ? req.body.dueAt
        : new Date(Date.now() + rule.dueInHours * 3_600_000).toISOString();
      const task = await createRecord<Partial<CsmTask>>(COLLECTIONS.csmTasks, {
        id: `task_staff_proposal__${h.id}`.replace(/[^A-Za-z0-9_-]/g, "_"),
        clientId: h.clientId,
        matterId: h.matterId,
        ownerEmail: membership?.csmEmail || actor.email,
        type: "proposal",
        title,
        dueAt,
        status: "open",
        source: { kind: "handoff", id: h.id },
        createdAt: new Date().toISOString(),
      });
      await updateRecord(COLLECTIONS.handoffs, h.id, { csmTaskIds: [...new Set([...(h.csmTaskIds ?? []), task.id])] });
      await auditLog({ actor, action: "staff.proposal_task", target: `clients/${h.clientId}`, meta: { handoffId: h.id, taskId: task.id } });
      res.status(201).json({ task, created: true });
    }),
  );

  // ── Lawyer capacity ───────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/staff/lawyers",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const now = Date.now();
      const in7 = new Date(now + 7 * DAY_MS).toISOString();
      const nowIso = new Date(now).toISOString();
      const [providers, matters, booked, ratings, specialties, availability] = await Promise.all([
        getAll("providers"),
        findRecords<Matter>(COLLECTIONS.matters),
        findRecords<Consultation>(COLLECTIONS.consultations, { status: "booked" }),
        ratingsByProvider(), // ROUTING
        loadSpecialties(), // ROUTING
        getAll(COLLECTIONS.availability).catch(() => []), // ROUTING
      ]);
      const availBy = new Map((availability as Doc[]).map((a) => [String(a.providerId ?? a.id), a]));
      const labelOf = new Map(specialties.map((x) => [x.id, x.label]));
      const open = matters.filter((m) => !m.closedAt && m.stage !== "closed");
      const items = (providers as Doc[])
        .filter((p) => p.active !== false && String(p.id) !== SALES_TEAM_ID)
        .map((p) => {
          const id = String(p.id);
          const mine = open.filter((m) => m.assignedProviderId === id);
          const f = lawyerFacts(p as Doc, availBy.get(id) ?? null, specialties);
          const r = ratings.get(id) ?? noReviewsSummary(id);
          return {
            id,
            name: String(p.name ?? "") || String(p.email ?? id),
            email: String(p.email ?? ""),
            legalAreas: Array.isArray(p.legalAreas) ? p.legalAreas : [],
            openMatters: mine.length,
            agingMatters: mine.filter((m) => now - Date.parse(m.stageEnteredAt) >= 14 * DAY_MS).length,
            callsNext7d: booked.filter((c) => c.providerId === id && c.scheduledAt >= nowIso && c.scheduledAt <= in7).length,
            specialties: f.specialties,
            specialtyLabels: f.specialties.map((x) => labelOf.get(x) ?? x),
            countries: f.countries,
            ratingScore: Number(r.ratingScore),
            reviewCount: Number(r.reviewCount),
            ratingStatus: r.ratingStatus,
            ratingLabel: ratingLabel(r),
            routingStatus: f.routingStatus,
            bookable: f.bookable,
          };
        })
        .sort((a, b) => b.openMatters - a.openMatters);
      const unassignedMatters = open.filter((m) => !m.assignedProviderId).length;
      if (isListRequest(req)) {
        return respondList(req, res, LAWYERS_SPEC, (p) => ({ produce: pageProducer(pageRows(items, p, LAWYERS_SPEC)), meta: { unassignedMatters } }));
      }
      res.json({ items, unassignedMatters });
    }),
  );
}
