/**
 * assignmentRouter.ts — admin client→lawyer assignment, Uber-style.
 *
 * REL: assignment goes through API/members/assignment.ts. Assignment is:
 *   • manual — staff pick an active lawyer licensed in the member's country;
 *              open matters and upcoming calls follow (a call moves when the
 *              new lawyer is free at that time, else it is cancelled)
 *   • auto   — each unassigned member with a running membership is routed
 *              like booking (country, specialty, load); nobody licensed in
 *              the country → the CSM task, never a lawyer from elsewhere
 *
 * The "constant client loop queue" is the pool of unassigned clients. Auto
 * assignment drains it.
 *
 * Routes (all requireDashboardAuth):
 *   GET  /api/dashboard/assignment/queue
 *   POST /api/dashboard/clients/:id/assign
 *   POST /api/dashboard/assignment/auto
 */

import type { Express, Request, Response } from "express";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import { LIST_SCHEMAS } from "../../schemas/listSchemas.ts";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import getAll from "../../db/getAll.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { isProviderBookable } from "../providers/applyLogic.ts";
import { assignBlock, assignMember } from "../members/assignment.ts";
import { flagUnassignedCountry, routeNewLawyer } from "../calls/callService.ts";
import { currentMembership } from "../members/service.ts";
import {
  buildClientSummary,
  fetchAllClientsWithIds,
} from "./clientHelpers.ts";

/** A provider's numeric score, defaulting to 0 when unrated. */
function scoreOf(p: Record<string, unknown>): number {
  const s = p.score;
  const n = typeof s === "number" ? s : parseFloat(String(s ?? ""));
  return Number.isFinite(n) ? n : 0;
}

/** Active providers sorted by score descending (Uber-style priority). */
async function rankedProviders(): Promise<Array<Record<string, unknown>>> {
  const all = await getAll("providers").catch(() => []);
  return all
    .filter((p) => isProviderBookable(p))
    .sort((a, b) => scoreOf(b) - scoreOf(a));
}

export default function assignmentRouter(app: Express) {
  log("Assignment router initialized.");

  app.get(
    "/api/dashboard/assignment/queue",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const all = await fetchAllClientsWithIds();
      const unassigned = all
        .filter(({ data }) => !data.assignedProviderId)
        .map(({ docId, data }) => buildClientSummary(docId, data, true));

      const providers = await rankedProviders();
      if (isListRequest(req)) {
        type Summary = (typeof unassigned)[number];
        const spec: ListSpec<Summary> = {
          sorts: { name: (c) => `${c.name ?? ""} ${c.surname ?? ""}`.trim().toLowerCase(), lastUpdated: (c) => String(c.lastUpdated ?? "") },
          defaultSort: "lastUpdated",
          defaultDir: "desc",
          search: (c) => [c.name, c.surname, c.email, c.legalArea, c.jurisdiction],
          schema: LIST_SCHEMAS.assignmentQueue,
        };
        return respondList(req, res, spec, (p) => ({
          produce: pageProducer(pageRows(unassigned, p, spec)),
          meta: {
            unassignedCount: unassigned.length,
            providers: providers.map((p) => ({
              id: p.id,
              name: p.name ?? null,
              email: p.email ?? null,
              score: scoreOf(p),
              legalAreas: p.legalAreas ?? [],
              jurisdictions: p.jurisdictions ?? [],
            })),
          },
        }));
      }

      res.json({
        unassigned,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name ?? null,
          email: p.email ?? null,
          score: scoreOf(p),
          legalAreas: p.legalAreas ?? [],
          jurisdictions: p.jurisdictions ?? [],
        })),
        unassignedCount: unassigned.length,
      });
    })
  );

  app.post(
    "/api/dashboard/clients/:id/assign",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { providerId } = req.body ?? {};
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";

      if (!providerId || typeof providerId !== "string") {
        return res.status(400).json({ error: "providerId is required." });
      }
      // REL: only an active lawyer licensed in the member's country (and never a
      // seed lawyer for a real member). Matters and upcoming calls follow
      // (members/assignment.ts: a call moves when the new lawyer is free at that
      // time, else it is cancelled and the member asked to rebook).
      const block = await assignBlock(id, providerId);
      if (block) return res.status(block.status).json({ error: block.error });
      const r = await assignMember(id, providerId, { email: actor, role: "staff" }, { reason: "Your ILP team changed your lawyer" });
      log(`[assignment] ${actor} assigned ${id} to ${providerId}`);
      res.json({ success: true, id, providerId, previous: r.previous, matters: r.matters, moved: r.moved, cancelled: r.cancelled });
    })
  );

  app.post(
    "/api/dashboard/assignment/auto",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";

      const all = await fetchAllClientsWithIds();
      const unassigned = all.filter(({ data }) => !data.assignedProviderId);
      const assignments: Array<{ clientId: string; providerId: string }> = [];
      const skipped: Array<{ clientId: string; reason: string }> = [];

      for (const { docId } of unassigned) {
        // REL: members only (free accounts and leads have no lawyer), routed
        // like booking: licensed in the member's country, specialty, load.
        const m = await currentMembership(docId).catch(() => null);
        if (!m || (m.status !== "active" && m.status !== "past_due")) {
          skipped.push({ clientId: docId, reason: "no active membership" });
          continue;
        }
        const pick = await routeNewLawyer(docId);
        if (!pick) {
          await flagUnassignedCountry(docId);
          skipped.push({ clientId: docId, reason: "no active lawyer licensed in the member's country" });
          continue;
        }
        await assignMember(docId, pick, { email: actor, role: "staff" }, { auto: true, reason: "Matched by country and specialty" });
        assignments.push({ clientId: docId, providerId: pick });
      }

      log(`[assignment] ${actor} auto-assigned ${assignments.length} clients`);
      res.json({
        success: true,
        assigned: assignments.length,
        assignments,
        skipped,
      });
    })
  );
}