/**
 * API/providers/applyRouter.ts — partner lawyer applications (T2).
 * Registered from providersRouter.ts, so main.ts is unchanged.
 *
 * Public
 *   POST /api/providers/apply                       the /lawyers/apply form (rate-limited, honeypot)
 * Staff (dashboard session)
 *   GET  /api/dashboard/providers/applications      ?status=open|all  open = pending_review + changes_requested
 *   POST /api/dashboard/providers/:id/review        { action: approve|request_changes|decline, note? }
 *
 * Logic and tests: applyLogic.ts. An application creates a provider with
 * status "pending_review" and active false; only a staff approve activates it.
 */

import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../../helper/asyncHandler.ts";
import auditLog from "../../helper/auditLog.ts";
import log from "../../helper/log.ts";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import { fieldValue, LIST_SCHEMAS } from "../../schemas/listSchemas.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { type AuthedRequest, requireDashboardAuth } from "../../helper/auth/session.ts";
import { COLLECTIONS } from "../../schemas/contracts.ts";
import { consentId } from "../privacy/policy.ts";
import { lawyerApplyEmails } from "./applyEmails.ts";
import { type ApplyDeps, reviewApplication, submitApplication } from "./applyLogic.ts";
import { identify, trackServerStep, visitorFrom } from "../journeys/track.ts"; // JOURNEYS

type Doc = Record<string, unknown>;

const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many applications from this connection. Try again in an hour, or write to ILP." },
  validate: { trustProxy: false },
});

const site = () => (Deno.env.get("FRONTEND_URL") ?? Deno.env.get("PUBLIC_SITE_URL") ?? "http://localhost:3000").replace(/\/$/, "");

/** Provider by email: equality query on the lowercase email (applications always store it lowercase). */
async function findProviderByEmail(email: string): Promise<Doc | null> {
  const hit = (await query("providers", [{ field: "email", op: "EQUAL", value: email }]).catch(() => [])) as Doc[];
  return hit[0] ?? null;
}

export function applyDeps(): ApplyDeps {
  return {
    now: () => new Date(),
    findProviderByEmail,
    getProvider: async (id) => {
      const doc = (await get("providers", id).catch(() => null)) as Doc | null;
      return doc ? { ...doc, id } : null;
    },
    writeProvider: async (id, fields, create) => {
      if (create) await put("providers", id, fields);
      else await patch("providers", id, fields);
    },
    writeAvailability: async (providerId, doc) => {
      await put(COLLECTIONS.availability, providerId, doc as unknown as Doc);
    },
    getTask: async (id) => (await get(COLLECTIONS.csmTasks, id).catch(() => null)) as Doc | null,
    writeTask: async (id, fields, create) => {
      if (create) await put(COLLECTIONS.csmTasks, id, fields);
      else await patch(COLLECTIONS.csmTasks, id, fields);
    },
    writeConsent: async (record) => {
      await put(COLLECTIONS.consents, record.id, record as unknown as Doc);
    },
    audit: (entry) => auditLog(entry).catch((err) => log(`[apply] audit failed: ${err instanceof Error ? err.message : err}`, "error")),
    sendEmail: async (msg, dedupeKey) => {
      // Best effort: the application is saved even if the email cannot be queued.
      await enqueueEmail(msg, dedupeKey.replace(/[^A-Za-z0-9_-]/g, "_")).catch((err) =>
        log(`[apply] email not queued: ${err instanceof Error ? err.message : err}`, "error")
      );
    },
    emails: lawyerApplyEmails,
    urls: { signIn: `${site()}/lawyer`, apply: `${site()}/lawyers/apply` },
    ownerEmail: Deno.env.get("LAWYER_APPLICATIONS_OWNER_EMAIL") || Deno.env.get("DEFAULT_CSM_EMAIL") || undefined,
    consentId,
  };
}

const APPLICATION_FIELDS = ["id", "name", "email", "phone", "website", "legalAreas", "languages", "bio", "status", "reviewNote", "declineReason", "reviewedAt", "reviewedBy", "application", "createdAt", "updatedAt"];

function applicationView(p: Doc): Doc {
  const out: Doc = {};
  for (const k of APPLICATION_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

export default function applyRouter(app: Express) {
  log("Lawyer application router initialized.");

  app.post(
    "/api/providers/apply",
    applyLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const result = await submitApplication(req.body ?? {}, applyDeps(), req.ip);
      if (result.status === 201) log(`[apply] application ${result.body.providerId}${result.body.resubmitted ? " (resubmitted)" : ""}`);
      if (result.status === 201 && typeof result.body.providerId === "string") {
        // JOURNEYS: lawyer funnel (browser sends landing/apply_start; submit is recorded here).
        await identify(visitorFrom(req), { providerId: result.body.providerId });
        await trackServerStep("lawyer_apply_submit", { providerId: result.body.providerId });
      }
      res.status(result.status).json(result.body);
    }),
  );

  app.get(
    "/api/dashboard/providers/applications",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const statuses = req.query.status === "all"
        ? ["pending_review", "changes_requested", "declined"]
        : ["pending_review", "changes_requested"];
      const rows = (await Promise.all(
        statuses.map((s) => query("providers", [{ field: "status", op: "EQUAL", value: s }]).catch(() => [] as Doc[])),
      )).flat() as Doc[];
      const items = rows
        .map(applicationView)
        .sort((a, b) => String((b.application as Doc | undefined)?.submittedAt ?? b.createdAt ?? "").localeCompare(String((a.application as Doc | undefined)?.submittedAt ?? a.createdAt ?? "")));
      if (isListRequest(req)) {
        const submitted = (d: Doc) => String((d.application as Doc | undefined)?.submittedAt ?? d.createdAt ?? "");
        const spec: ListSpec<Doc> = {
          sorts: { submittedAt: submitted, name: (d) => String(d.name ?? "").toLowerCase() },
          defaultSort: "submittedAt",
          defaultDir: "desc",
          filters: { appStatus: (d, v) => d.status === v },
          search: (d) => [d.name, d.email, d.legalAreas, d.jurisdictions, d.firmName],
          id: (d) => String(d.id ?? ""),
          schema: LIST_SCHEMAS.lawyerApplications,
          read: (d, f) => (f.key === "submittedAt" ? submitted(d) : fieldValue(d, f)),
        };
        return respondList(req, res, spec, (p) => ({ produce: pageProducer(pageRows(items, p, spec)) }));
      }
      res.json({ items });
    }),
  );

  app.post(
    "/api/dashboard/providers/:id/review",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const r = req as AuthedRequest;
      const email = r.dashboardUser ?? "staff";
      const result = await reviewApplication(req.params.id, req.body ?? {}, { uid: email, email, role: r.dashboardRole ?? "staff" }, applyDeps());
      if (result.status === 200 && (req.body as Record<string, unknown> | undefined)?.action === "approve") {
        await trackServerStep("lawyer_verified", { providerId: req.params.id }); // JOURNEYS
      }
      res.status(result.status).json(result.body);
    }),
  );
}
