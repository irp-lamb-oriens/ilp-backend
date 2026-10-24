/**
 * API/countries/countriesRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Country legal-priority catalog + user-personalized deadlines.
 *
 * The catalog (what ILP can track per country) is public reference data. The
 * user's deadlines are private, stored on their own `profiles` doc under
 * `deadlines`, keyed by priority id. A user records a real date for each
 * priority they care about; ILP turns that date into reminders.
 */
import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import auditLog, { auditFrom } from "../../helper/auditLog.ts";
import type { SessionUser } from "../../helper/auth/types.ts";
import {
  SUPPORTED_COUNTRIES,
  prioritiesForCountry,
  priorityById,
} from "./countryCatalog.ts";

const PROFILE_PREFIX = "profile_";

/** Validate an ISO date (YYYY-MM-DD) and return a normalized copy or null. */
function normalizeDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

export default (app: Express) => {
  log("Countries router initialized.");

  // ── Public catalog ────────────────────────────────────────────────────────

  app.get(
    "/api/countries",
    asyncHandler(async (_req: Request, res: Response) => {
      res.status(200).json({ countries: SUPPORTED_COUNTRIES });
    }),
  );

  app.get(
    "/api/countries/:code/priorities",
    asyncHandler(async (req: Request, res: Response) => {
      const code = String(req.params.code ?? "").toUpperCase();
      const priorities = prioritiesForCountry(code);
      if (priorities.length === 0) {
        return res.status(404).json({ error: "No priorities for this country." });
      }
      res.status(200).json({ country: code, priorities });
    }),
  );

  // ── User deadlines (private) ──────────────────────────────────────────────

  // Read the current user's deadlines, merged with the catalog so the client
  // can render every priority with its recorded date (or empty).
  app.get(
    "/api/countries/me/deadlines",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const profile = await get("profiles", `${PROFILE_PREFIX}${user.uid}`);
      const deadlines = (profile?.deadlines as Record<string, unknown>) ?? {};
      res.status(200).json({ deadlines });
    }),
  );

  // Upsert a single deadline for a priority. Body: { priorityId, date, note? }.
  app.put(
    "/api/countries/me/deadlines/:priorityId",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const priorityId = String(req.params.priorityId ?? "");
      const priority = priorityById(priorityId);
      if (!priority) {
        return res.status(404).json({ error: "Unknown priority." });
      }

      const date = normalizeDate(req.body?.date);
      if (!date) {
        return res.status(400).json({ error: "date must be a valid YYYY-MM-DD." });
      }

      const note = typeof req.body?.note === "string" ? req.body.note.trim() : undefined;
      const id = `${PROFILE_PREFIX}${user.uid}`;
      const existing = await get("profiles", id);
      const deadlines = (existing?.deadlines as Record<string, unknown>) ?? {};

      const now = new Date().toISOString();
      const nextDeadlines = {
        ...deadlines,
        [priorityId]: {
          priorityId,
          date,
          ...(note ? { note } : {}),
          updatedAt: now,
        },
      };

      await patch("profiles", id, { deadlines: nextDeadlines, updatedAt: now });

      await auditLog({
        actor: auditFrom(user),
        action: "deadline.upserted",
        target: `profiles/${id}`,
        meta: { priorityId, date },
      });

      res.status(200).json({ ok: true, deadline: nextDeadlines[priorityId] });
    }),
  );

  // Remove a deadline for a priority.
  app.delete(
    "/api/countries/me/deadlines/:priorityId",
    validateUser("customer"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const priorityId = String(req.params.priorityId ?? "");
      const id = `${PROFILE_PREFIX}${user.uid}`;
      const existing = await get("profiles", id);
      const deadlines = (existing?.deadlines as Record<string, unknown>) ?? {};

      if (!(priorityId in deadlines)) {
        return res.status(404).json({ error: "No deadline recorded for this priority." });
      }

      const nextDeadlines = { ...deadlines };
      delete nextDeadlines[priorityId];

      await patch("profiles", id, {
        deadlines: nextDeadlines,
        updatedAt: new Date().toISOString(),
      });

      await auditLog({
        actor: auditFrom(user),
        action: "deadline.removed",
        target: `profiles/${id}`,
        meta: { priorityId },
      });

      res.status(200).json({ ok: true });
    }),
  );
};