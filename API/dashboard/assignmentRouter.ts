/**
 * assignmentRouter.ts — admin client→lawyer assignment, Uber-style.
 *
 * Lawyers (providers) are prioritized by their `score` (0–5, half-star).
 * Higher-scored lawyers get clients first. Assignment is:
 *   • manual — an admin picks a specific lawyer for a client
 *   • auto   — for each unassigned client, the highest-scored lawyer whose
 *              legalAreas/jurisdictions match the client is chosen
 *
 * The "constant client loop queue" is the pool of unassigned clients. Auto
 * assignment drains it in score-prioritized order.
 *
 * Routes (all requireDashboardAuth):
 *   GET  /api/dashboard/assignment/queue
 *   POST /api/dashboard/clients/:id/assign
 *   POST /api/dashboard/assignment/auto
 */

import type { Express, Request, Response } from "express";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import {
  buildClientSummary,
  fetchAllClientsWithIds,
} from "./clientHelpers.ts";

const CLIENTS_COLLECTION = "clients";

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
    .filter((p) => p?.active !== false)
    .sort((a, b) => scoreOf(b) - scoreOf(a));
}

/** Score a provider against a client's legalArea/jurisdiction. */
function matchScore(
  provider: Record<string, unknown>,
  client: Record<string, unknown>,
): number {
  let score = 0;
  const wantedArea = typeof client.legalArea === "string" ? client.legalArea : null;
  const wantedJurisdiction =
    typeof client.jurisdiction === "string" ? client.jurisdiction.toUpperCase() : null;

  if (
    wantedArea &&
    Array.isArray(provider.legalAreas) &&
    (provider.legalAreas as string[]).includes(wantedArea)
  ) {
    score += 2;
  }
  if (wantedJurisdiction) {
    const tags = Array.isArray(provider.jurisdictions)
      ? (provider.jurisdictions as string[]).map((j) => j.toUpperCase())
      : [];
    if (tags.length === 0 || tags.includes(wantedJurisdiction)) score += 1;
  }
  return score;
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

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const provider = await get("providers", providerId);
      if (!provider) return res.status(404).json({ error: "Provider not found." });

      const nowIso = new Date().toISOString();
      await put(CLIENTS_COLLECTION, id, {
        assignedProviderId: providerId,
        assignedAt: nowIso,
        assignedBy: actor,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          {
            type: "client_assigned",
            providerId,
            actor,
            timestamp: nowIso,
          },
        ],
      });

      log(`[assignment] ${actor} assigned ${id} to ${providerId}`);
      res.json({ success: true, id, providerId });
    })
  );

  app.post(
    "/api/dashboard/assignment/auto",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";

      const all = await fetchAllClientsWithIds();
      const unassigned = all.filter(({ data }) => !data.assignedProviderId);
      const providers = await rankedProviders();

      const assignments: Array<{ clientId: string; providerId: string }> = [];
      const skipped: Array<{ clientId: string; reason: string }> = [];

      for (const { docId, data } of unassigned) {
        if (providers.length === 0) {
          skipped.push({ clientId: docId, reason: "no active providers" });
          continue;
        }

        // Pick the highest-scored provider that matches area/jurisdiction.
        // Fall back to the top-scored provider when nothing matches.
        let best = providers[0];
        let bestMatch = -1;
        for (const p of providers) {
          const m = matchScore(p, data);
          if (m > bestMatch) {
            bestMatch = m;
            best = p;
          }
        }

        const nowIso = new Date().toISOString();
        await put(CLIENTS_COLLECTION, docId, {
          assignedProviderId: String(best.id),
          assignedAt: nowIso,
          assignedBy: actor,
          autoAssigned: true,
          updatedAt: nowIso,
          activityLog: [
            ...(Array.isArray(data.activityLog) ? data.activityLog : []),
            {
              type: "client_assigned",
              providerId: String(best.id),
              actor,
              auto: true,
              timestamp: nowIso,
            },
          ],
        });

        assignments.push({ clientId: docId, providerId: String(best.id) });
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