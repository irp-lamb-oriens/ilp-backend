/**
 * API/countries/countriesRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Country reference data (public, no login). All six countries are open.
 *
 *   GET /api/countries                       every country: name, currency, time zones, licensing bodies
 *   GET /api/countries/:code                 one country plus rule counts by area
 *   GET /api/countries/:code/questions       the situation questions (?stage=check|profile)
 *   GET /api/countries/:code/rules           the obligation rules, for country pages and staff
 *   GET /api/countries/:code/priorities      the trackable priorities (older reminders)
 *
 * The user's actual deadlines are project-scoped and live on the client doc;
 * those endpoints are registered in `clientStatusRouter.ts`.
 */
import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { COUNTRIES, COUNTRY_CODES, toCountryCode } from "../../schemas/contracts.ts";
import { prioritiesForCountry } from "./countryCatalog.ts";
import { questionsFor, rulesetFor } from "./rules/index.ts";
import type { CountryRule } from "./rules/engine.ts";

/** What a page needs to show a rule; conditions and due math stay on the server. */
export function publicRule(r: CountryRule) {
  return {
    id: r.id,
    area: r.area,
    title: r.title,
    meaning: r.meaning,
    dueText: r.dueText,
    authority: r.authority,
    consequence: r.consequence,
    sources: r.sources,
    confidence: r.confidence,
    reviewedByCounsel: r.reviewedByCounsel,
    ...(r.estimatedFromYear ? { estimatedFromYear: r.estimatedFromYear } : {}),
  };
}

export default (app: Express) => {
  log("Countries router initialized.");

  app.get(
    "/api/countries",
    asyncHandler(async (_req: Request, res: Response) => {
      res.status(200).json({ countries: COUNTRY_CODES.map((c) => COUNTRIES[c]) });
    }),
  );

  app.get(
    "/api/countries/:code",
    asyncHandler(async (req: Request, res: Response) => {
      const code = toCountryCode(req.params.code);
      const set = code ? rulesetFor(code) : null;
      if (!code || !set) return res.status(404).json({ error: "Unknown country." });
      const byArea: Record<string, number> = {};
      for (const r of set.rules) byArea[r.area] = (byArea[r.area] ?? 0) + 1;
      res.status(200).json({
        country: COUNTRIES[code],
        researchDate: set.researchDate,
        ruleCount: set.rules.length,
        lowConfidence: set.rules.filter((r) => r.confidence === "low").length,
        byArea,
      });
    }),
  );

  app.get(
    "/api/countries/:code/questions",
    asyncHandler(async (req: Request, res: Response) => {
      const code = toCountryCode(req.params.code);
      if (!code) return res.status(404).json({ error: "Unknown country." });
      const stage = req.query.stage === "check" || req.query.stage === "profile" ? req.query.stage : undefined;
      res.status(200).json({ country: code, questions: questionsFor(code, stage) });
    }),
  );

  app.get(
    "/api/countries/:code/rules",
    asyncHandler(async (req: Request, res: Response) => {
      const code = toCountryCode(req.params.code);
      const set = code ? rulesetFor(code) : null;
      if (!code || !set) return res.status(404).json({ error: "Unknown country." });
      res.status(200).json({ country: code, researchDate: set.researchDate, rules: set.rules.map(publicRule) });
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
