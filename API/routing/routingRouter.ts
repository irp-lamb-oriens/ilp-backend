/**
 * API/routing/routingRouter.ts — routes for routing, profiles, specialties,
 * ratings and the staff bell (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * Lawyer (requireProviderAuth; responses pass stripProviderResponses, so no
 * rating or routing field can leave):
 *   GET  /api/provider/profile                 own routing profile + specialty list
 *   PUT  /api/provider/profile                 save own profile (LAWYER_PROFILE_FIELDS only)
 *
 * Staff (requireDashboardAuth; audited writes):
 *   GET   /api/dashboard/routing/specialties                 every specialty + lawyers per specialty
 *   POST  /api/dashboard/routing/specialties                 { label, group, countries?, description? }
 *   PATCH /api/dashboard/routing/specialties/:id             { label?, group?, countries?, description?, active? }
 *   POST  /api/dashboard/routing/specialties/:id/merge       { into }
 *   GET   /api/dashboard/routing/lawyers/:id/profile         profile, hidden rating, latest reviews
 *   PUT   /api/dashboard/routing/lawyers/:id/profile         save any field incl. licences and verification
 *   GET   /api/dashboard/routing/coverage                    country × specialty matrix + open gaps
 *   GET   /api/dashboard/routing/members/:id                 decision ("Why this lawyer"), gap, sales call
 *   POST  /api/dashboard/routing/members/:id/reroute         { matterId? } run the router now
 *   POST  /api/dashboard/routing/members/:id/override        { providerId, note?, matterId? }
 *   POST  /api/dashboard/routing/sweep                       retry every open gap now
 *   GET   /api/dashboard/routing/sales-hours                 sales team weekly hours
 *   PUT   /api/dashboard/routing/sales-hours                 save them (normalizeAvailability)
 *   GET   /api/dashboard/notifications                       the bell: latest + unread count
 *   POST  /api/dashboard/notifications/read                  { ids?: string[] } (none = all)
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import auditLog from "../../helper/auditLog.ts";
import { type AuthedRequest, requireDashboardAuth, requireProviderAuth } from "../../helper/auth/session.ts";
import { findRecords, getRecord } from "../../db/records.ts";
import {
  COLLECTIONS,
  type Consultation,
  COUNTRY_CODES,
  type LawyerReview,
  type Matter,
  type RoutingDecision,
  type RoutingGap,
  SALES_TEAM_ID,
} from "../../schemas/contracts.ts";
import { normalizeAvailability } from "../calls/callLogic.ts";
import { assignBlock, assignMember } from "../members/assignment.ts";
import { isProviderBookable } from "../providers/applyLogic.ts";
import { createSpecialty, loadSpecialties, mergeSpecialty, updateSpecialty } from "./specialties.ts";
import { profileOf, saveProfile } from "./profile.ts";
import { ratingFor, ratingLabel } from "./ratings.ts";
import { markRead, notificationsFor } from "./notifications.ts";
import { lawyerFacts, openGapFor, rerouteOpenGaps, rerouteSoon, routeAndAssign, salesAvailability, salesEmails, saveDecision } from "./service.ts";

type Doc = Record<string, unknown>;
const staffEmail = (req: Request) => String((req as AuthedRequest).dashboardUser ?? "staff");
const staffActor = (req: Request) => ({ email: staffEmail(req), role: "staff" as const });
const providerIdOf = (req: Request) => String((req as AuthedRequest).providerId ?? "");
const providerEmailOf = (req: Request) => String((req as AuthedRequest).providerUser ?? "");

export default function routingRouter(app: Express) {
  // ── Lawyer: own profile ────────────────────────────────────────────────
  app.get(
    "/api/provider/profile",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = providerIdOf(req);
      const p = id ? ((await get("providers", id).catch(() => null)) as Doc | null) : null;
      if (!p) return res.status(404).json({ error: "We could not find your lawyer profile." });
      const specialties = await loadSpecialties();
      res.json({
        profile: profileOf({ ...p, id }, specialties),
        name: p.name ?? null,
        specialties: specialties.filter((s) => s.active),
        canTakeCalls: isProviderBookable(p),
      });
    }),
  );

  app.put(
    "/api/provider/profile",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = providerIdOf(req);
      if (!id) return res.status(401).json({ error: "No lawyer identity on this session." });
      const r = await saveProfile(id, req.body, { email: providerEmailOf(req) || id, role: "lawyer" });
      if (r.status === 200) rerouteSoon(`profile of ${id}`);
      res.status(r.status).json(r.body);
    }),
  );

  // ── Staff: specialties ─────────────────────────────────────────────────
  app.get(
    "/api/dashboard/routing/specialties",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const [specialties, providers] = await Promise.all([loadSpecialties(), getAll("providers").catch(() => []) as Promise<Doc[]>]);
      const counts: Record<string, number> = {};
      for (const p of providers) {
        if (!isProviderBookable(p)) continue;
        for (const id of Array.isArray(p.specialties) ? (p.specialties as string[]) : []) counts[id] = (counts[id] ?? 0) + 1;
      }
      res.json({ items: specialties.map((s) => ({ ...s, lawyers: counts[s.id] ?? 0 })) });
    }),
  );

  app.post(
    "/api/dashboard/routing/specialties",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const r = await createSpecialty((req.body ?? {}) as Doc, staffActor(req));
      if (r.status < 300) rerouteSoon("new specialty");
      res.status(r.status).json(r.body);
    }),
  );

  app.patch(
    "/api/dashboard/routing/specialties/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const r = await updateSpecialty(String(req.params.id), (req.body ?? {}) as Doc, staffActor(req));
      if (r.status < 300) rerouteSoon("specialty change");
      res.status(r.status).json(r.body);
    }),
  );

  app.post(
    "/api/dashboard/routing/specialties/:id/merge",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const r = await mergeSpecialty(String(req.params.id), String(req.body?.into ?? ""), staffActor(req));
      if (r.status < 300) rerouteSoon("specialty merge");
      res.status(r.status).json(r.body);
    }),
  );

  // ── Staff: lawyer profiles and hidden ratings ──────────────────────────
  app.get(
    "/api/dashboard/routing/lawyers/:id/profile",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const p = (await get("providers", id).catch(() => null)) as Doc | null;
      if (!p) return res.status(404).json({ error: "Lawyer not found." });
      const [specialties, rating, reviews, availability] = await Promise.all([
        loadSpecialties(),
        ratingFor(id),
        query(COLLECTIONS.reviews, [{ field: "providerId", op: "EQUAL", value: id }]).catch(() => []) as Promise<unknown[]>,
        get(COLLECTIONS.availability, id).catch(() => null) as Promise<Doc | null>,
      ]);
      const facts = lawyerFacts({ ...p, id }, availability, specialties);
      res.json({
        id,
        name: p.name ?? null,
        email: p.email ?? null,
        bookable: facts.bookable,
        verifiedCountries: facts.verifiedCountries,
        profile: profileOf({ ...p, id }, specialties),
        specialties,
        rating: { ...rating, label: ratingLabel(rating) },
        reviews: (reviews as LawyerReview[]).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 10),
      });
    }),
  );

  app.put(
    "/api/dashboard/routing/lawyers/:id/profile",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const r = await saveProfile(String(req.params.id), req.body, { email: staffEmail(req), role: "staff" });
      if (r.status === 200) rerouteSoon(`staff edit of ${req.params.id}`);
      res.status(r.status).json(r.body);
    }),
  );

  // ── Staff: coverage matrix ─────────────────────────────────────────────
  app.get(
    "/api/dashboard/routing/coverage",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const [specialties, providers, availability, gaps] = await Promise.all([
        loadSpecialties(),
        getAll("providers").catch(() => []) as Promise<Doc[]>,
        getAll(COLLECTIONS.availability).catch(() => []) as Promise<Doc[]>,
        query(COLLECTIONS.routingGaps, [{ field: "status", op: "EQUAL", value: "open" }]).catch(() => []) as Promise<unknown[]>,
      ]);
      const availBy = new Map(availability.map((a) => [String(a.providerId ?? a.id), a]));
      const active = specialties.filter((s) => s.active);
      // cells[country][specialtyId] = lawyers who take it exactly; areaOnly = lawyers covering only its area.
      const cells: Record<string, Record<string, { exact: number; areaOnly: number }>> = {};
      for (const c of COUNTRY_CODES) cells[c] = Object.fromEntries(active.map((s) => [s.id, { exact: 0, areaOnly: 0 }]));
      for (const p of providers) {
        const id = String(p.id ?? "");
        if (!id || id === SALES_TEAM_ID) continue;
        const f = lawyerFacts({ ...p, id }, availBy.get(id) ?? null, specialties);
        if (!f.bookable || f.routingStatus !== "active" || f.placeholder) continue;
        for (const c of f.verifiedCountries) {
          for (const s of active) {
            if (s.countries.length && !s.countries.includes(c)) continue;
            if (f.specialties.includes(s.id)) cells[c][s.id].exact++;
            else if (f.areas.includes(s.group)) cells[c][s.id].areaOnly++;
          }
        }
      }
      res.json({
        countries: COUNTRY_CODES,
        specialties: active,
        cells,
        gaps: (gaps as RoutingGap[]).filter((g) => !g.placeholder).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        placeholderGaps: (gaps as RoutingGap[]).filter((g) => g.placeholder).length,
      });
    }),
  );

  // ── Staff: one member's routing ────────────────────────────────────────
  app.get(
    "/api/dashboard/routing/members/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = String(req.params.id);
      const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
      if (!client) return res.status(404).json({ error: "Member not found." });
      const matters = await findRecords<Matter>(COLLECTIONS.matters, { clientId }, { sortBy: "openedAt", desc: true });
      const withDecision = matters.filter((m) => m.routing).sort((a, b) => String(b.routing!.at).localeCompare(String(a.routing!.at)));
      const decision: RoutingDecision | null = withDecision[0]?.routing ?? (client.routing as RoutingDecision | undefined) ?? null;
      const assignedId = typeof client.assignedProviderId === "string" ? client.assignedProviderId : null;
      const assigned = assignedId ? ((await get("providers", assignedId).catch(() => null)) as Doc | null) : null;
      const sales = (await findRecords<Consultation>(COLLECTIONS.consultations, { clientId, providerId: SALES_TEAM_ID }).catch(() => [] as Consultation[]))
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
      res.json({
        assigned: assignedId ? { id: assignedId, name: assigned?.name ?? assignedId, bookable: isProviderBookable(assigned) } : null,
        decision,
        decisionMatterId: withDecision[0]?.id ?? null,
        gap: await openGapFor(clientId, null),
        salesCalls: sales.slice(0, 3).map((c) => ({ id: c.id, scheduledAt: c.scheduledAt, status: c.status, meetUrl: c.meetUrl ?? null, salesEmail: c.salesEmail ?? null })),
        salesEmails: salesEmails(),
      });
    }),
  );

  app.post(
    "/api/dashboard/routing/members/:id/reroute",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = String(req.params.id);
      if (!(await get(COLLECTIONS.clients, clientId).catch(() => null))) return res.status(404).json({ error: "Member not found." });
      const matterId = typeof req.body?.matterId === "string" && req.body.matterId ? String(req.body.matterId) : undefined;
      const r = await routeAndAssign(clientId, { matterId, trigger: "reroute", actor: staffActor(req) });
      res.json({ providerId: r.providerId, decision: r.decision, gap: r.gap ?? null });
    }),
  );

  app.post(
    "/api/dashboard/routing/members/:id/override",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = String(req.params.id);
      const providerId = String(req.body?.providerId ?? "").trim();
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 300) : "";
      if (!providerId) return res.status(400).json({ error: "Choose a lawyer." });
      const block = await assignBlock(clientId, providerId);
      if (block) return res.status(block.status).json({ error: block.error });
      const actor = staffActor(req);
      const matters = await findRecords<Matter>(COLLECTIONS.matters, { clientId }, { sortBy: "openedAt", desc: true });
      const matterId = typeof req.body?.matterId === "string" ? req.body.matterId : undefined;
      const matter = (matterId ? matters.find((m) => m.id === matterId) : matters.find((m) => !m.closedAt)) ?? null;
      const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
      const prev: RoutingDecision | null = matter?.routing ?? (client?.routing as RoutingDecision | undefined) ?? null;
      const result = await assignMember(clientId, providerId, actor, { reason: note || "Staff override" });
      const decision: RoutingDecision = {
        ...(prev ?? {
          rulesVersion: "manual",
          request: { country: "CR", area: null, specialtyId: null, languages: [], timezone: "America/Costa_Rica", urgencyDays: null, clientType: "individual", region: null, previousProviderId: null },
          candidates: [],
          rejected: [],
        }),
        at: new Date().toISOString(),
        trigger: "override",
        providerId,
        overriddenBy: actor.email,
        ...(note ? { overrideNote: note } : {}),
      };
      delete (decision as Partial<RoutingDecision>).noMatchReason;
      await saveDecision(clientId, matter, decision, actor);
      await auditLog({ actor: { uid: actor.email, email: actor.email, role: "staff" }, action: "routing.override", target: `clients/${clientId}`, meta: { providerId, previous: prev?.providerId ?? null, note: note || null } }).catch(() => undefined);
      // A staff choice closes an open gap the same way an automatic match does.
      const gap = await openGapFor(clientId, null);
      if (gap) {
        const at = new Date().toISOString();
        await put(COLLECTIONS.routingGaps, gap.id, { status: "resolved", resolvedAt: at, resolvedProviderId: providerId, updatedAt: at, resolvedBy: actor.email });
      }
      res.json({ ok: true, providerId, matters: result.matters, moved: result.moved, cancelled: result.cancelled, decision });
    }),
  );

  app.post(
    "/api/dashboard/routing/sweep",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await rerouteOpenGaps("sweep"));
    }),
  );

  // ── Staff: sales hours ─────────────────────────────────────────────────
  app.get(
    "/api/dashboard/routing/sales-hours",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ...(await salesAvailability()), salesEmails: salesEmails() });
    }),
  );

  app.put(
    "/api/dashboard/routing/sales-hours",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const norm = normalizeAvailability(req.body, SALES_TEAM_ID, new Date(), "America/Costa_Rica");
      if ("error" in norm) return res.status(400).json({ error: norm.error });
      await put(COLLECTIONS.availability, SALES_TEAM_ID, norm.value as unknown as Doc);
      const actor = staffActor(req);
      await auditLog({ actor: { uid: actor.email, email: actor.email, role: "staff" }, action: "availability.updated", target: `${COLLECTIONS.availability}/${SALES_TEAM_ID}`, meta: { windows: norm.value.weekly.length, sales: true } }).catch(() => undefined);
      res.json({ ...norm.value, isDefault: false, salesEmails: salesEmails() });
    }),
  );

  // ── Staff: the bell ────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/notifications",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await notificationsFor(staffEmail(req)));
    }),
  );

  app.post(
    "/api/dashboard/notifications/read",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
      res.json({ marked: await markRead(staffEmail(req), ids) });
    }),
  );
}

/** Used by tests: a matter's stored decision. */
export async function storedDecision(matterId: string): Promise<RoutingDecision | null> {
  return (await getRecord<Matter>(COLLECTIONS.matters, matterId))?.routing ?? null;
}
