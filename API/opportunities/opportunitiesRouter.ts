/**
 * API/opportunities/opportunitiesRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Opportunities pipeline (P5). Staff only: every route needs a staff session
 * (requireDashboardAuth). Lawyers and clients have no route here, so they
 * never see an opportunity's value. Writes are audited.
 *
 *   GET   /api/dashboard/opportunities            ?stage&owner=me|<email>&area&clientId&matterId&q&open=1
 *   GET   /api/dashboard/opportunities/summary    same filters (stage ignored): count and value by stage,
 *                                                 win rate, days to close, legal GMV vs platform revenue
 *   GET   /api/dashboard/opportunities/:id
 *   POST  /api/dashboard/opportunities            { clientId, source{kind,id?}, title, area, valueCents?, … }
 *   PATCH /api/dashboard/opportunities/:id        { title?, area?, valueCents?, nextAction?, ownerEmail?, providerId?, matterId? }
 *   POST  /api/dashboard/opportunities/:id/stage  { stage, outcome? }  (won/lost need outcome)
 *   POST  /api/dashboard/opportunities/:id/quote  { quoteId }          (link a quote on the member; identified → quoted)
 *   POST  /api/dashboard/opportunities/backfill   admin: one opportunity per existing handoff with commercial notes
 *
 * Quote acceptance: GET routes reconcile linked quotes, so an opportunity whose
 * quote the member accepted shows (and is stored) as won. Accept handlers can
 * also call `syncOpportunitiesForQuote(clientId, quoteId)` to do it at once.
 *
 * Registered from main.ts (one line). Paths live under /api/dashboard/ because
 * /api/staff/:slug is W1's generic CRUD and answers 404 for unknown slugs.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import auditLog from "../../helper/auditLog.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import { type AuthedRequest, requireDashboardAuth } from "../../helper/auth/session.ts";
import { requireStaffRole } from "../../helper/auth/roles.ts";
import { findRecords } from "../../db/records.ts";
import { COLLECTIONS, type Handoff, type Opportunity } from "../../schemas/contracts.ts";
import { displayName, isQuoteAccepted, quoteCents, quoteIdOf } from "../dashboard/staffHome/compute.ts";
import {
  applyEdit,
  buildOpportunity,
  EDITABLE_FIELDS,
  filterOpportunities,
  findQuote,
  isClosed,
  type ListFilter,
  linkQuote,
  moveStage,
  OpportunityError,
  opportunityIdForHandoff,
  reconcileWithQuote,
  summarize,
} from "./logic.ts";
import { createOpportunityFromHandoff, getOpportunity, listOpportunities, memberCsm, saveOpportunity } from "./store.ts";

type Doc = Record<string, unknown>;

const actorOf = (req: Request) => {
  const r = req as AuthedRequest;
  const email = r.dashboardUser ?? "staff";
  return { uid: email, email, role: r.dashboardRole ?? "staff" };
};

const SYSTEM = { uid: "system", email: "system", role: "system" };

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

/** Bring linked opportunities in step with their quotes; stores and audits what changed. */
async function reconcile(items: Opportunity[], clients: Map<string, Doc>): Promise<Opportunity[]> {
  const now = new Date();
  return await Promise.all(items.map(async (o) => {
    if (!o.quoteId || isClosed(o.stage)) return o;
    const next = reconcileWithQuote(o, findQuote(clients.get(o.clientId), o.quoteId), now);
    if (!next) return o;
    try {
      await saveOpportunity(next);
      await auditLog({ actor: SYSTEM, action: "opportunity.quote_sync", target: `opportunities/${o.id}`, meta: { from: o.stage, to: next.stage, quoteId: o.quoteId } });
    } catch (err) {
      log(`[opportunities] reconcile ${o.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
    return next;
  }));
}

/** Move every open opportunity linked to this quote to won once the member accepts it. Never throws. */
export async function syncOpportunitiesForQuote(clientId: string, quoteId: string): Promise<number> {
  try {
    const items = (await listOpportunities({ clientId })).filter((o) => o.quoteId === quoteId && !isClosed(o.stage));
    if (!items.length) return 0;
    const clients = await clientsById([clientId]);
    const out = await reconcile(items, clients);
    return out.filter((o, i) => o !== items[i]).length;
  } catch (err) {
    log(`[opportunities] sync for quote ${quoteId} failed: ${err instanceof Error ? err.message : err}`, "error");
    return 0;
  }
}

function filterFrom(req: Request): ListFilter {
  const q = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]).trim() : "");
  const me = (req as AuthedRequest).dashboardUser ?? "";
  const owner = q("owner");
  return {
    stage: q("stage") || undefined,
    ownerEmail: owner === "me" ? me : owner && owner !== "all" ? owner : undefined,
    area: q("area") || undefined,
    clientId: q("clientId") || undefined,
    matterId: q("matterId") || undefined,
    q: q("q") || undefined,
    includeClosed: q("open") === "1" ? false : true,
  };
}

/** Staff row: the record plus member name and the linked quote's state. */
function row(o: Opportunity, clients: Map<string, Doc>) {
  const client = clients.get(o.clientId);
  const quote = o.quoteId ? findQuote(client, o.quoteId) : undefined;
  return {
    ...o,
    memberName: displayName(client ?? null, "Member"),
    quote: quote
      ? {
        id: quoteIdOf(quote),
        title: typeof quote.title === "string" ? quote.title : "",
        status: typeof quote.status === "string" ? quote.status : "",
        totalCents: quoteCents(quote),
        accepted: isQuoteAccepted(quote),
      }
      : null,
  };
}

function fail(res: Response, err: unknown) {
  if (err instanceof OpportunityError) return res.status(err.status).json({ error: err.message });
  throw err;
}

async function loadFiltered(req: Request) {
  const f = filterFrom(req);
  const base = await listOpportunities({ clientId: f.clientId, ownerEmail: f.ownerEmail });
  const clients = await clientsById(base.map((o) => o.clientId));
  const items = await reconcile(base, clients);
  const names = new Map([...clients].map(([id, c]) => [id, displayName(c, "")]));
  return { f, items, clients, names };
}

export default function opportunitiesRouter(app: Express) {
  log("Opportunities router initialized.");

  app.get(
    "/api/dashboard/opportunities",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { f, items, clients, names } = await loadFiltered(req);
      const list = filterOpportunities(items, f, names);
      const owners = [...new Set(items.map((o) => o.ownerEmail).filter(Boolean))].sort();
      const areas = [...new Set(items.map((o) => o.area).filter(Boolean))].sort();
      res.json({ items: list.map((o) => row(o, clients)), owners, areas });
    }),
  );

  app.get(
    "/api/dashboard/opportunities/summary",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { f, items, clients, names } = await loadFiltered(req);
      const list = filterOpportunities(items, { ...f, stage: undefined, includeClosed: true }, names);
      const quotes = new Map<string, Doc>();
      for (const o of list) {
        const q = o.quoteId ? findQuote(clients.get(o.clientId), o.quoteId) : undefined;
        if (q && o.quoteId) quotes.set(o.quoteId, q);
      }
      res.json(summarize(list, quotes));
    }),
  );

  app.post(
    "/api/dashboard/opportunities/backfill",
    requireDashboardAuth,
    requireStaffRole("admin"),
    asyncHandler(async (req: Request, res: Response) => {
      const handoffs = await findRecords<Handoff>(COLLECTIONS.handoffs);
      let created = 0;
      for (const h of handoffs) {
        if (!h.commercialNotes?.trim()) continue;
        if (await getOpportunity(opportunityIdForHandoff(h.id))) continue;
        if (await createOpportunityFromHandoff(h as unknown as Doc)) created++;
      }
      await auditLog({ actor: actorOf(req), action: "opportunity.backfill", target: "opportunities", meta: { created } });
      res.json({ created });
    }),
  );

  app.get(
    "/api/dashboard/opportunities/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const o = await getOpportunity(req.params.id);
      if (!o) return res.status(404).json({ error: "Opportunity not found." });
      const clients = await clientsById([o.clientId]);
      const [item] = await reconcile([o], clients);
      res.json(row(item, clients));
    }),
  );

  app.post(
    "/api/dashboard/opportunities",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Doc;
      const actor = actorOf(req);
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      if (clientId && !(await get(COLLECTIONS.clients, clientId))) return res.status(404).json({ error: "Member not found." });
      let opp: Opportunity;
      try {
        opp = buildOpportunity(body, { defaultOwner: (clientId && (await memberCsm(clientId))) || actor.email });
      } catch (err) {
        return fail(res, err);
      }
      (opp as Opportunity & { createdBy?: string }).createdBy = actor.email;
      await saveOpportunity(opp);
      await auditLog({ actor, action: "opportunity.created", target: `opportunities/${opp.id}`, meta: { clientId: opp.clientId, source: opp.source, stage: opp.stage } });
      const clients = await clientsById([opp.clientId]);
      res.status(201).json(row(opp, clients));
    }),
  );

  app.patch(
    "/api/dashboard/opportunities/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const o = await getOpportunity(req.params.id);
      if (!o) return res.status(404).json({ error: "Opportunity not found." });
      let next: Opportunity;
      try {
        next = applyEdit(o, (req.body ?? {}) as Doc);
      } catch (err) {
        return fail(res, err);
      }
      await saveOpportunity(next);
      const changed = Object.keys(req.body ?? {}).filter((k) => (EDITABLE_FIELDS as readonly string[]).includes(k));
      await auditLog({ actor: actorOf(req), action: "opportunity.updated", target: `opportunities/${o.id}`, meta: { fields: changed } });
      const clients = await clientsById([o.clientId]);
      res.json(row(next, clients));
    }),
  );

  app.post(
    "/api/dashboard/opportunities/:id/stage",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const o = await getOpportunity(req.params.id);
      if (!o) return res.status(404).json({ error: "Opportunity not found." });
      let next: Opportunity;
      try {
        next = moveStage(o, req.body?.stage, req.body?.outcome);
      } catch (err) {
        return fail(res, err);
      }
      await saveOpportunity(next);
      await auditLog({ actor: actorOf(req), action: "opportunity.stage", target: `opportunities/${o.id}`, meta: { from: o.stage, to: next.stage, outcome: next.outcome } });
      const clients = await clientsById([o.clientId]);
      res.json(row(next, clients));
    }),
  );

  app.post(
    "/api/dashboard/opportunities/:id/quote",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const o = await getOpportunity(req.params.id);
      if (!o) return res.status(404).json({ error: "Opportunity not found." });
      const quoteId = typeof req.body?.quoteId === "string" ? req.body.quoteId.trim() : "";
      if (!quoteId) return res.status(400).json({ error: "quoteId is required." });
      const clients = await clientsById([o.clientId]);
      const quote = findQuote(clients.get(o.clientId), quoteId);
      if (!quote) return res.status(404).json({ error: "That quote is not on this member." });
      let next: Opportunity;
      try {
        next = linkQuote(o, quote);
      } catch (err) {
        return fail(res, err);
      }
      await saveOpportunity(next);
      await auditLog({ actor: actorOf(req), action: "opportunity.quote_linked", target: `opportunities/${o.id}`, meta: { quoteId, from: o.stage, to: next.stage } });
      res.json(row(next, clients));
    }),
  );
}
