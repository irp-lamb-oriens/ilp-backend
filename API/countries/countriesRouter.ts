/**
 * API/countries/countriesRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Country legal-priority catalog (public reference data).
 *
 * The catalog describes what ILP can track per country. The user's actual
 * deadlines are project-scoped and live on the client doc; those endpoints
 * are registered in `clientStatusRouter.ts` under the client-status auth
 * flow (the same flow the /status page uses).
 */
import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import {
  SUPPORTED_COUNTRIES,
  prioritiesForCountry,
} from "./countryCatalog.ts";

export default (app: Express) => {
  log("Countries router initialized.");

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
};