import type { Express, Request, Response } from "express";
import { cached, PUBLIC_LIST_TTL_MS } from "../../helper/cache.ts";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import getAll from "../../db/getAll.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import type { SessionUser } from "../../helper/auth/types.ts";
import applyRouter from "./applyRouter.ts";
import getOne from "../../db/get.ts";
import { pickProviderProfile } from "./selfProfile.ts";

/**
 * Vetted legal partner profiles. Provider-side supply:
 * credentials, country, specialties, language, availability, insurance, SLA.
 */
export default (app: Express) => {
  log("Providers router initialized.");

  // T2: public lawyer application + staff review (applyRouter.ts).
  applyRouter(app);

  // Public: list vetted providers (lean — credentials gated to staff).
  app.get(
    "/api/providers",
    asyncHandler(async (req: Request, res: Response) => {
      const country = (req.query.country as string | undefined)?.toUpperCase();
      const providers = await cached(`public:providers:${country ?? "all"}`, PUBLIC_LIST_TTL_MS, () =>
        country ? query("providers", [{ field: "country", op: "EQUAL", value: country }]) : getAll("providers"));

      const vetted = providers
        .filter((p) => p.status === "vetted")
        .map((p) => ({
          id: p.id,
          name: p.name,
          country: p.country,
          specialties: p.specialties,
          languages: p.languages,
          insurance: p.insurance,
          slaStatus: p.slaStatus,
        }));
      res.status(200).json(vetted);
    })
  );

  // Provider: upsert own profile (create-on-apply or edit).
  app.post(
    "/api/providers/me",
    validateUser("provider"),
    asyncHandler(async (req: Request, res: Response) => {
      const user = (req as Request & { sessionUser?: SessionUser }).sessionUser!;
      const body = req.body as Record<string, unknown>;
      if (!body.name || !body.country) {
        return res.status(400).json({ error: "name and country are required" });
      }

      // Only profile fields a lawyer may set about themselves (QA round 1):
      // the body used to be spread whole into the record, so a caller could
      // write status, score, insurance, slaStatus, notes or commercial fields.
      // A new record starts "pending"; an existing one keeps its status, so
      // a vetted lawyer editing a profile is not taken out of routing.
      const id = `provider_${user.uid}`;
      const existing = (await getOne("providers", id)) as { status?: string } | null;
      await patch("providers", id, {
        ...pickProviderProfile(body),
        uid: user.uid,
        email: user.email,
        status: existing?.status ?? "pending",
        updatedAt: new Date().toISOString(),
      });
      res.status(200).json({ id });
    })
  );

  // Staff: vet/approve a provider and record insurance + SLA status.
  app.patch(
    "/api/providers/:id/vet",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as {
        status?: string;
        insurance?: Record<string, unknown>;
        slaStatus?: string;
      };

      await patch("providers", req.params.id, {
        status: body.status ?? "vetted",
        insurance: body.insurance,
        slaStatus: body.slaStatus,
        vettedAt: new Date().toISOString(),
      });
      res.status(200).json({ ok: true });
    })
  );
};