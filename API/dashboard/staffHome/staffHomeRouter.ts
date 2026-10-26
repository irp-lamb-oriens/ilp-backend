/**
 * API/dashboard/staffHome/staffHomeRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Staff and CSM home (W6). Builds on W1's /api/staff/* routes; these add the
 * cross-member views the Today page and member page need.
 *
 *   GET  /api/dashboard/staff/summary                         KPI strip + "Needs attention" rail
 *   GET  /api/dashboard/staff/members                         ?status&csm&ready&country&q&sort&dir&page&pageSize
 *   GET  /api/dashboard/staff/members/:clientId/timeline      consultations, handoffs, tasks, quotes, notes, audit
 *   POST /api/dashboard/staff/members/:clientId/assign-lawyer { providerId, matterId? }
 *   POST /api/dashboard/staff/handoffs/:id/proposal-task      { title?, dueAt? } (idempotent per handoff)
 *   GET  /api/dashboard/staff/lawyers                         capacity per lawyer
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
import { type AuthedRequest, requireDashboardAuth } from "../../../helper/auth/session.ts";
import { createRecord, findRecords, getRecord, updateRecord } from "../../../db/records.ts";
import {
  COLLECTIONS,
  type Consultation,
  type CsmTask,
  type Handoff,
  type Matter,
  type Membership,
  type Obligation,
  TASK_RULES,
} from "../../../schemas/contracts.ts";
import {
  buildTimeline,
  computeAttention,
  computeKpis,
  DAY_MS,
  filterMembers,
  type MemberQuery,
  memberRows,
} from "./compute.ts";

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
      const [memberships, openTasks, handoffs, matters, upcoming, asked] = await Promise.all([
        findRecords<Membership>(COLLECTIONS.memberships),
        findRecords<CsmTask>(COLLECTIONS.csmTasks, { status: "open" }),
        findRecords<Handoff>(COLLECTIONS.handoffs),
        findRecords<Matter>(COLLECTIONS.matters),
        findRecords<Obligation>(COLLECTIONS.obligations, { status: "upcoming" }),
        findRecords<Obligation>(COLLECTIONS.obligations, { status: "asked" }),
      ]);
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
      res.json({ me, role: (req as AuthedRequest).dashboardRole ?? "staff", kpis, attention });
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
      const where = { clientId };
      const [clientDoc, memberships, consultations, handoffs, tasks] = await Promise.all([
        get(COLLECTIONS.clients, clientId),
        findRecords<Membership>(COLLECTIONS.memberships, where),
        findRecords<Consultation>(COLLECTIONS.consultations, where),
        findRecords<Handoff>(COLLECTIONS.handoffs, where),
        findRecords<CsmTask>(COLLECTIONS.csmTasks, where),
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
      });
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
    asyncHandler(async (_req: Request, res: Response) => {
      const now = Date.now();
      const in7 = new Date(now + 7 * DAY_MS).toISOString();
      const nowIso = new Date(now).toISOString();
      const [providers, matters, booked] = await Promise.all([
        getAll("providers"),
        findRecords<Matter>(COLLECTIONS.matters),
        findRecords<Consultation>(COLLECTIONS.consultations, { status: "booked" }),
      ]);
      const open = matters.filter((m) => !m.closedAt && m.stage !== "closed");
      const items = (providers as Doc[])
        .filter((p) => p.active !== false)
        .map((p) => {
          const id = String(p.id);
          const mine = open.filter((m) => m.assignedProviderId === id);
          return {
            id,
            name: String(p.name ?? "") || String(p.email ?? id),
            email: String(p.email ?? ""),
            legalAreas: Array.isArray(p.legalAreas) ? p.legalAreas : [],
            openMatters: mine.length,
            agingMatters: mine.filter((m) => now - Date.parse(m.stageEnteredAt) >= 14 * DAY_MS).length,
            callsNext7d: booked.filter((c) => c.providerId === id && c.scheduledAt >= nowIso && c.scheduledAt <= in7).length,
          };
        })
        .sort((a, b) => b.openMatters - a.openMatters);
      res.json({ items, unassignedMatters: open.filter((m) => !m.assignedProviderId).length });
    }),
  );
}
