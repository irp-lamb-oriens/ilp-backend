/**
 * API/clientStatus/clientStatusRouter.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Client Status portal (Phase 1 — Segment A): OTP auth + project hub payload
 * + charges + comments + stage ratings + quotes + quote acceptance + details.
 *
 * Ported from IRP-funnel's `clientStatusRouter.ts`, retargeted to ILP's legal
 * taxonomy and data model:
 *   • Project doc lives in the `clients` collection, doc id === the
 *     email-normalized project id (email with `@`/`.` replaced by `_`).
 *   • Quotes, charges, comments, and stage ratings are stored ON the client
 *     doc (ILP's flat-doc pattern) rather than subcollections.
 *   • OTP/session primitives come from `helper/auth/` (Phase 0.1).
 *   • Stage config comes from `automation/stageConfig.ts` (Phase 0.6).
 *
 * LILY CHAT:      POST /api/client-status/project/:id/lily
 *                 GET  /api/client-status/project/:id/lily/history
 * COMMENTS:       POST / PATCH / DELETE .../comment[/:commentId]
 * STAGE RATINGS:  POST .../stage-rating
 * QUOTES:         GET .../quotes, POST .../accept-quote
 * DETAILS:        PATCH .../details
 */

import { isQuoteAccepted, isQuoteAwaitingClient, quoteKey } from "../../schemas/quoteStatus.ts";
import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import { stripFields } from "../../db/records.ts";
import { CLIENT_HIDDEN_FIELDS } from "../../schemas/contracts.ts";
import { registerMemberHomeRoutes } from "./memberHome.ts";
import { sendClientSignInCode } from "./signInCode.ts";
import { normalizeQuote } from "./memberLogic.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import {
  verifyOtp,
  generateSessionToken,
  emailToDocId,
} from "../../helper/auth/otp.ts";
import { requireClientAuth } from "../../helper/auth/session.ts";
import {
  ensureStageConfig,
  getStageLabel,
  getClientVisibleStageIds,
  getClientVisibleStageLabels,
  getClientVisibleStageDetails,
  resolveClientDisplayStage,
} from "../dashboard/automation/stageConfig.ts";
import { ensureFieldConfig, getFieldConfigSync } from "../dashboard/automation/fieldConfig.ts";
import type { FieldDef } from "../dashboard/automation/fieldDefaults.ts";
import { chatWithLily } from "../chatbot/services/lilyChatEngine.ts";
import { aiAssistantAllowed } from "../privacy/privacyRouter.ts";
import { AI_CONSENT_REQUIRED } from "../privacy/policy.ts";
import { memberEmailLayout } from "../../helper/emailTemplates.ts";
import { syncOpportunitiesForQuote } from "../opportunities/opportunitiesRouter.ts";
import {
  countryCodeFromName,
  prioritiesForCountry,
  priorityById,
} from "../countries/countryCatalog.ts";

const CLIENTS_COLLECTION = "clients";
const OTP_COLLECTION = "client_status_otps";
const SESSION_COLLECTION = "client_status_sessions";

const ALLOWED_DOMAIN = "internationallegalpartner.com";

// ── Types ────────────────────────────────────────────────────────────────────

interface StatusComment {
  id: string;
  author: string;
  authorType: "client" | "staff";
  body: string;
  stage?: string;
  createdAt: string;
  editedAt?: string;
  editHistory?: Array<{ body: string; editedAt: string; editedBy: string }>;
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
}

interface StageRating {
  rating: 1 | 2 | 3 | 4 | 5;
  note?: string;
  timestamp: string;
  ratedBy: string;
}

interface StatusChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Reconstruct the principal email from an email-normalized project id. */
function resolvePrincipalEmail(doc: Record<string, unknown>, projectId: string): string {
  const drip = doc.dripEmail;
  if (typeof drip === "string" && drip.includes("@")) return drip.toLowerCase().trim();
  const direct = doc.email;
  if (typeof direct === "string" && direct.includes("@")) {
    return direct.toLowerCase().trim();
  }
  const dotted = projectId.replace(/_/g, ".");
  const parts = dotted.split(".");
  if (parts.length >= 2) {
    const tld = parts.pop();
    const dom = parts.pop();
    const user = parts.join(".");
    return `${user}@${dom}.${tld}`.toLowerCase().trim();
  }
  return dotted.toLowerCase().trim();
}

/** May this signed-in address see this project? */
function clientMayAccessProject(
  doc: Record<string, unknown>,
  projectId: string,
  email: string,
): boolean {
  const normalized = String(email ?? "").toLowerCase().trim();
  if (!normalized) return false;
  if (normalized.split("@")[1] === ALLOWED_DOMAIN) return true;
  if (resolvePrincipalEmail(doc, projectId) === normalized) return true;
  const consultations = Array.isArray(doc.consultations) ? doc.consultations : [];
  return consultations.some(
    (c) => {
      const ce = (c as Record<string, unknown>)?.email;
      return typeof ce === "string" && ce.toLowerCase().trim() === normalized;
    },
  );
}

/** The set of emails permitted to score stages (the principal only). */
function getRatingWhitelist(doc: Record<string, unknown>, projectId: string): string[] {
  return [resolvePrincipalEmail(doc, projectId)];
}

/** Resolve the project's jurisdiction from the latest consultation or root. */
function resolvePrincipalJurisdiction(doc: Record<string, unknown>): string | null {
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  const latest = (cons[cons.length - 1] ?? {}) as Record<string, unknown>;
  const v = latest.jurisdiction !== undefined ? latest.jurisdiction : doc.jurisdiction;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Validate an ISO date (YYYY-MM-DD) and return a normalized copy or null. */
function normalizeDeadlineDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return s;
}

function newCommentId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 16; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const COMMENT_MUTATION_WINDOW_MS = 15 * 60 * 1000;
function withinEditWindow(c: StatusComment): boolean {
  const t = Date.parse(c.createdAt);
  return Number.isFinite(t) && Date.now() - t <= COMMENT_MUTATION_WINDOW_MS;
}

/** Index of the latest consultation entry (where consultation-scoped values live). */
function latestConsultationIndex(doc: Record<string, unknown>): number {
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  return Math.max(0, cons.length - 1);
}

/** Read a registry field's current value off the client doc, honoring scope. */
function readFieldValue(doc: Record<string, unknown>, f: FieldDef): unknown {
  if (f.scope === "root") return doc[f.id];
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  const last = (cons[cons.length - 1] ?? {}) as Record<string, unknown>;
  return last[f.id] !== undefined ? last[f.id] : doc[f.id];
}

/** Coerce an incoming client-submitted value to the field's declared type. */
function coerceFieldValue(v: unknown, type: string): unknown {
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") return v === true || v === "true" || v === "yes" || v === "1";
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}

const CLIENT_SCALAR_TYPES: ReadonlySet<string> = new Set([
  "string", "text", "number", "boolean", "date", "datetime", "enum", "email",
]);

/** Build the client-visible field list from the Overview Field Registry. */
function buildClientFields(doc: Record<string, unknown>): Array<{
  id: string;
  label: string;
  valueType: string;
  options?: string[];
  placeholder?: string;
  editable: boolean;
  value: unknown;
}> {
  return getFieldConfigSync()
    .filter(
      (f) =>
        f.active !== false &&
        f.clientVisible === true &&
        CLIENT_SCALAR_TYPES.has(f.valueType),
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((f) => ({
      id: f.id,
      label: f.label,
      valueType: f.valueType,
      ...(f.options ? { options: f.options } : {}),
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      editable: f.clientEditable === true && f.readOnly !== true,
      value: readFieldValue(doc, f) ?? "",
    }));
}

/** Build a safe client-facing summary of the project doc. */
function buildSafeSummary(doc: Record<string, unknown>, projectId: string) {
  const cons = Array.isArray(doc.consultations) ? doc.consultations : [];
  const latest = (cons[cons.length - 1] ?? {}) as Record<string, unknown>;
  const pick = (key: string) => {
    const v = latest[key] !== undefined ? latest[key] : doc[key];
    return v ?? null;
  };
  return {
    id: projectId,
    name: pick("name"),
    surname: pick("surname"),
    email: pick("email") ?? resolvePrincipalEmail(doc, projectId),
    legalArea: pick("legalArea"),
    legalMatter: pick("legalMatter"),
    jurisdiction: pick("jurisdiction"),
    documents: pick("documents"),
    stage: typeof doc.stage === "string" ? doc.stage : "intake",
    statusComments: (Array.isArray(doc.statusComments) ? doc.statusComments : [])
      .filter((c) => !(c as StatusComment).deleted),
    stageRatings: (doc.stageRatings ?? {}) as Record<string, StageRating>,
    quoteAcceptance: doc.quoteAcceptance ?? null,
    lastUpdated: doc.updatedAt ?? null,
    createdAt: doc.createdAt ?? null,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export default (app: Express) => {
  log("Client Status router initialized.");

  // Every client-portal response drops CLIENT_HIDDEN_FIELDS (costs, margins,
  // earnings, commercial notes, priority rank) at any depth, whatever the route.
  app.use("/api/client-status", (_req: Request, res: Response, next: () => void) => {
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => json(stripFields(body, CLIENT_HIDDEN_FIELDS))) as typeof res.json;
    next();
  });

  // A member may only open their own project: the session's clientId, or an
  // address the project lists. Staff (org domain) pass through, audited by W1.
  app.use(
    "/api/client-status/project/:id",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response, next: () => void) => {
      const r = req as Request & { isIrpStaff?: boolean; clientId?: string; clientUser?: string };
      const id = req.params.id;
      if (r.isIrpStaff || r.clientId === id) return next();
      const doc = await get(CLIENTS_COLLECTION, id);
      if (doc && clientMayAccessProject(doc, id, String(r.clientUser ?? ""))) return next();
      res.status(doc ? 403 : 404).json({ error: doc ? "You do not have access to this project." : "Project not found." });
    }),
  );

  registerMemberHomeRoutes(app);

  // ══════════════════════════════════════════════════════════════════════════
  //  AUTH ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/client-status/auth/request-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email, projectId } = req.body ?? {};
      if (!email || !projectId) {
        return res.status(400).json({ error: "Email and Project ID are required." });
      }

      const normalizedEmail = String(email).toLowerCase().trim();

      const doc = await get(CLIENTS_COLLECTION, projectId);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      if (!clientMayAccessProject(doc, projectId, normalizedEmail)) {
        log(`[client-status] Unauthorized OTP request for ${projectId} by ${normalizedEmail}`);
        return res.status(403).json({ error: "Email not authorized for this project." });
      }

      const sent = await sendClientSignInCode(normalizedEmail, projectId);
      if (!sent.ok) return res.status(sent.status).json({ error: sent.error });

      res.json({ success: true, message: "Verification code sent to your email." });
    }),
  );

  app.post(
    "/api/client-status/auth/verify-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email, projectId, code } = req.body ?? {};
      if (!email || !projectId || !code) {
        return res.status(400).json({ error: "Email, Project ID, and code are required." });
      }

      const normalizedEmail = String(email).toLowerCase().trim();
      const otpDocId = `${projectId}__${emailToDocId(normalizedEmail)}`;

      const check = await verifyOtp(OTP_COLLECTION, otpDocId, code);
      if (!check.ok) return res.status(check.status).json({ error: check.error });

      const token = generateSessionToken();
      const sessionExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await put(SESSION_COLLECTION, token, {
        email: normalizedEmail,
        projectId,
        createdAt: new Date().toISOString(),
        expiresAt: sessionExpiry.toISOString(),
      });

      log(`[client-status] Session created for ${normalizedEmail} on project ${projectId}`);
      res.json({ success: true, token, email: normalizedEmail, expiresAt: sessionExpiry.toISOString() });
    }),
  );

  app.get(
    "/api/client-status/auth/check",
    requireClientAuth,
    (req: Request, res: Response) => {
      res.json({
        authenticated: true,
        email: (req as Request & { clientUser?: string }).clientUser,
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  PROJECT HUB PAYLOAD
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/client-status/project/:id",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const email = String((req as Request & { clientUser?: string }).clientUser ?? "").toLowerCase().trim();

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });
      if (!clientMayAccessProject(doc, id, email)) {
        return res.status(403).json({ error: "You do not have access to this project." });
      }

      const safeSummary = buildSafeSummary(doc, id);

      await ensureStageConfig();
      const stages = getClientVisibleStageIds();
      const stageLabels = getClientVisibleStageLabels();
      const stageDetails = getClientVisibleStageDetails();

      await ensureFieldConfig();
      const clientFields = buildClientFields(doc);

      safeSummary.stage = resolveClientDisplayStage(safeSummary.stage);

      const isStaffViewer = email.split("@")[1] === ALLOWED_DOMAIN;
      const viewerIsPrincipal = !isStaffViewer && email === resolvePrincipalEmail(doc, id);

      res.json({
        project: { ...safeSummary, viewerIsPrincipal },
        stages,
        stageLabels,
        stageDetails,
        clientFields,
      });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  CHARGES
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/client-status/project/:id/charges",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const email = String((req as Request & { clientUser?: string }).clientUser ?? "").toLowerCase().trim();

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });
      if (!clientMayAccessProject(doc, id, email)) {
        return res.status(403).json({ error: "You do not have access to this project." });
      }

      const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
      const money = (v: unknown) => {
        const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
        return Number.isFinite(n) ? n : 0;
      };

      const charges = (Array.isArray(doc.charges) ? doc.charges : []).map((c) => {
        const ch = c as Record<string, unknown>;
        const payments = Array.isArray(ch.payments) ? ch.payments : [];
        const received = round2(
          payments
            .filter((p) => (p as Record<string, unknown>)?.received !== false)
            .reduce((s, p) => s + money((p as Record<string, unknown>).amount), 0),
        );
        const total = round2(money(ch.total));
        const balanceDue = round2(total - received);
        return {
          label: ch.label ?? null,
          date: ch.date ?? null,
          dueDate: ch.dueDate ?? null,
          total,
          received,
          balanceDue,
          status: balanceDue <= 0 ? "paid" : received > 0 ? "partially_paid" : "sent",
        };
      });

      const accepted = round2(charges.reduce((s, c) => s + c.total, 0));
      const received = round2(charges.reduce((s, c) => s + c.received, 0));

      res.json({
        charges,
        totals: {
          accepted,
          charged: accepted,
          received,
          balanceDue: round2(charges.reduce((s, c) => s + c.balanceDue, 0)),
        },
      });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  LILY CHAT (status scope)
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/client-status/project/:id/lily",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { message } = req.body ?? {};
      const userEmail = String((req as Request & { clientUser?: string }).clientUser ?? "");
      const isStaff = !!(req as Request & { isIrpStaff?: boolean }).isIrpStaff;

      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message is required." });
      }

      // P7: members need a granted, not withdrawn, ai_assistant consent.
      const sessionClientId = (req as Request & { clientId?: string }).clientId || id;
      if (!isStaff && !(await aiAssistantAllowed(sessionClientId))) {
        return res.status(403).json(AI_CONSENT_REQUIRED);
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      // Phase 6: the full project-scoped Lily engine answers here, grounded in
      // the client doc. The engine persists to `statusChatThread` itself.
      const { reply } = await chatWithLily(
        id,
        "status",
        message.trim(),
        userEmail,
        isStaff ? "staff" : "client",
      );

      log(`[client-status] Lily message on project ${id} by ${userEmail}`);
      res.json({ reply });
    }),
  );

  app.get(
    "/api/client-status/project/:id/lily/history",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });
      const thread = Array.isArray(doc.statusChatThread)
        ? (doc.statusChatThread as StatusChatMessage[])
        : [];
      res.json({ thread });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  COMMENTS
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/client-status/project/:id/comment",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { body, stage, author } = req.body ?? {};
      const userEmail = String((req as Request & { clientUser?: string }).clientUser ?? "");
      const isStaff = !!(req as Request & { isIrpStaff?: boolean }).isIrpStaff;

      if (!body || typeof body !== "string" || !body.trim()) {
        return res.status(400).json({ error: "body is required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      const existing: StatusComment[] = Array.isArray(doc.statusComments)
        ? (doc.statusComments as StatusComment[])
        : [];
      const comment: StatusComment = {
        id: newCommentId(),
        author: author || userEmail,
        authorType: isStaff ? "staff" : "client",
        body: body.trim(),
        ...(stage ? { stage } : {}),
        createdAt: new Date().toISOString(),
      };

      await patch(CLIENTS_COLLECTION, id, { statusComments: [...existing, comment] });
      log(`[client-status] Comment added to project ${id} by ${userEmail}`);
      res.json({ success: true, comment });
    }),
  );

  app.patch(
    "/api/client-status/project/:id/comment/:commentId",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, commentId } = req.params;
      const { body } = req.body ?? {};
      const userEmail = String((req as Request & { clientUser?: string }).clientUser ?? "");

      if (!body || typeof body !== "string" || !body.trim()) {
        return res.status(400).json({ error: "body is required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      const existing: StatusComment[] = Array.isArray(doc.statusComments)
        ? (doc.statusComments as StatusComment[])
        : [];
      const target = existing.find((c) => c.id === commentId);
      if (!target) return res.status(404).json({ error: "Comment not found." });
      if (target.deleted) return res.status(410).json({ error: "This comment was deleted." });
      if (target.author !== userEmail) return res.status(403).json({ error: "Not authorized to edit this comment." });
      if (!withinEditWindow(target)) return res.status(403).json({ error: "The 15-minute edit window has expired." });

      const now = new Date().toISOString();
      const updated = existing.map((c) => {
        if (c.id !== commentId) return c;
        const history = Array.isArray(c.editHistory) ? c.editHistory : [];
        return {
          ...c,
          body: body.trim(),
          editedAt: now,
          editHistory: [...history, { body: c.body, editedAt: now, editedBy: userEmail }],
        };
      });

      await patch(CLIENTS_COLLECTION, id, { statusComments: updated });
      res.json({ success: true, comment: updated.find((c) => c.id === commentId) });
    }),
  );

  app.delete(
    "/api/client-status/project/:id/comment/:commentId",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, commentId } = req.params;
      const userEmail = String((req as Request & { clientUser?: string }).clientUser ?? "");

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      const existing: StatusComment[] = Array.isArray(doc.statusComments)
        ? (doc.statusComments as StatusComment[])
        : [];
      const target = existing.find((c) => c.id === commentId);
      if (!target) return res.status(404).json({ error: "Comment not found." });
      if (target.deleted) return res.json({ success: true, comment: target });
      if (target.author !== userEmail) return res.status(403).json({ error: "Not authorized to delete this comment." });
      if (!withinEditWindow(target)) return res.status(403).json({ error: "The 15-minute delete window has expired." });

      const now = new Date().toISOString();
      const updated = existing.map((c) =>
        c.id === commentId ? { ...c, deleted: true, deletedAt: now, deletedBy: userEmail } : c,
      );
      await patch(CLIENTS_COLLECTION, id, { statusComments: updated });
      res.json({ success: true, comment: updated.find((c) => c.id === commentId) });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  STAGE RATINGS
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/client-status/project/:id/stage-rating",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { stageKey, rating, note } = req.body ?? {};
      const userEmail = String((req as Request & { clientUser?: string }).clientUser ?? "");

      if (!stageKey || typeof stageKey !== "string") {
        return res.status(400).json({ error: "stageKey is required." });
      }
      const ratingNum = Number(rating);
      if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
        return res.status(400).json({ error: "rating must be 1–5." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      const ratingWhitelist = getRatingWhitelist(doc, id);
      if (!ratingWhitelist.includes(userEmail.toLowerCase().trim())) {
        return res.status(403).json({ error: "Only the principal contact on this project can rate stages." });
      }

      const existing: Record<string, StageRating> = (doc.stageRatings ?? {}) as Record<string, StageRating>;
      const stageRating: StageRating = {
        rating: ratingNum as 1 | 2 | 3 | 4 | 5,
        ...(note ? { note: String(note).trim() } : {}),
        timestamp: new Date().toISOString(),
        ratedBy: userEmail,
      };

      await patch(CLIENTS_COLLECTION, id, {
        stageRatings: { ...existing, [stageKey]: stageRating },
      });

      log(`[client-status] Stage rating ${ratingNum}★ on '${stageKey}' by ${userEmail} for project ${id}`);
      res.json({ success: true, stageRating });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  QUOTES (read-only view)
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/client-status/project/:id/quotes",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      const allQuotes = Array.isArray(doc.quotes) ? doc.quotes : [];
      const clientQuotes = allQuotes
        .filter((q) => ["sent", "received", "accepted", "rejected"].includes((q as Record<string, unknown>).status as string))
        .sort((a, b) => {
          const rank: Record<string, number> = { accepted: 0, received: 1, rejected: 2 };
          const ra = rank[(a as Record<string, unknown>).status as string] ?? 9;
          const rb = rank[(b as Record<string, unknown>).status as string] ?? 9;
          if (ra !== rb) return ra - rb;
          return String((b as Record<string, unknown>).createdAt ?? "").localeCompare(String((a as Record<string, unknown>).createdAt ?? ""));
        });

      // Client-safe shape only: title, total, plain scope. Line amounts can be cost.
      res.json({ quotes: clientQuotes.map(normalizeQuote).filter(Boolean) });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  ACCEPT QUOTE — CLIENT ONLY
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/client-status/project/:id/accept-quote",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const userEmail = String((req as Request & { clientUser?: string }).clientUser ?? "").toLowerCase().trim();
      const isStaff = !!(req as Request & { isIrpStaff?: boolean }).isIrpStaff;

      if (isStaff) {
        return res.status(403).json({ error: "Quote acceptance must be performed by the client directly." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      const currentStage = typeof doc.stage === "string" ? doc.stage : "";
      const ACCEPTABLE_STAGES = new Set(["quote_sent", "quote_accepted"]);
      if (!ACCEPTABLE_STAGES.has(currentStage)) {
        if (currentStage === "quote_accepted") {
          return res.status(409).json({ error: "Quote already accepted.", stage: currentStage });
        }
        return res.status(409).json({
          error: `Quote acceptance is not available at the current stage (${getStageLabel(currentStage)}).`,
          stage: currentStage,
        });
      }

      const allQuotes = Array.isArray(doc.quotes) ? doc.quotes : [];
      const receivedQuotes = allQuotes.filter((q) => isQuoteAwaitingClient(q as Record<string, unknown>));

      const { quoteId: _qid, fullName: _fn, consent: _consent } = req.body ?? {};
      const fullName = (typeof _fn === "string" ? _fn : "").trim();
      const consent = _consent === true || _consent === "true";

      if (!consent) return res.status(400).json({ error: "Consent is required to accept this quote." });
      if (!fullName) return res.status(400).json({ error: "Please type your full name to proceed." });

      let quoteId = _qid;
      if (!quoteId) {
        if (receivedQuotes.length === 1) {
          quoteId = quoteKey(receivedQuotes[0] as Record<string, unknown>);
        } else if (receivedQuotes.length === 0) {
          return res.status(409).json({ error: "No received quotes available to accept." });
        } else {
          return res.status(400).json({
            error: "Multiple quotes are available. Please specify quoteId in the request body.",
            availableQuoteIds: receivedQuotes.map((q) => quoteKey(q as Record<string, unknown>)),
          });
        }
      }

      const targetQuote = allQuotes.find((q) => quoteKey(q as Record<string, unknown>) === quoteId) as Record<string, unknown> | undefined;
      if (!targetQuote) return res.status(404).json({ error: `Quote ${quoteId} not found on this project.` });
      if (isQuoteAccepted(targetQuote)) return res.status(409).json({ error: "This quote has already been accepted." });

      const nowIso = new Date().toISOString();
      const newStage = "quote_accepted";

      const updatedQuotes = allQuotes.map((q) =>
        quoteKey(q as Record<string, unknown>) === quoteId
          ? {
              ...(q as Record<string, unknown>),
              status: "accepted",
              acceptedAt: nowIso,
              clientAcceptedAt: nowIso, // staff/finance spelling (schemas/quoteStatus.ts)
              clientAcceptedBy: userEmail,
              acceptedBy: userEmail,
              typedFullName: fullName,
              consent: true,
              consentAt: nowIso,
            }
          : q,
      );

      await patch(CLIENTS_COLLECTION, id, {
        stage: newStage,
        quotes: updatedQuotes,
        quoteAcceptance: {
          quoteId,
          acceptedAt: nowIso,
          acceptedBy: userEmail,
          fromStage: currentStage,
          total: targetQuote.total ?? null,
          currency: targetQuote.currency ?? "USD",
          typedFullName: fullName,
          consent: true,
          consentAt: nowIso,
        },
      });

      log(`[client-status] Quote accepted: project=${id} quote=${quoteId} by=${userEmail}`);
      // P5/P7: linked opportunities move to won now, not on the next staff read (never throws).
      await syncOpportunitiesForQuote(id, String(quoteId));

      // Fire-and-forget confirmation email.
      const clientEmail = resolvePrincipalEmail(doc, id);
      const acceptMail = memberEmailLayout({
        subject: `Quote accepted — ${String(targetQuote.title ?? quoteId)}`,
        paragraphs: ["Thank you for accepting your quote. Your legal team will be in touch to confirm next steps."],
      });
      void enqueueEmail(
        { to: clientEmail, subject: acceptMail.subject, html: acceptMail.html, text: acceptMail.text },
        `quote_accept_${id}_${quoteId}`,
      ).catch((e) => log(`[client-status] Quote acceptance email failed: ${e}`));

      res.json({ success: true, newStage, quoteId, acceptedAt: nowIso });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  DETAILS (client-editable fields)
  // ══════════════════════════════════════════════════════════════════════════

  app.patch(
    "/api/client-status/project/:id/details",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const userEmail = String((req as Request & { clientUser?: string }).clientUser ?? "").toLowerCase().trim();
      const isStaff = !!(req as Request & { isIrpStaff?: boolean }).isIrpStaff;

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });

      if (isStaff) {
        return res.status(403).json({ error: "Staff may not edit client project details via this endpoint." });
      }
      if (userEmail !== resolvePrincipalEmail(doc, id)) {
        return res.status(403).json({ error: "Only the principal contact may edit project details." });
      }

      await ensureFieldConfig();
      const editableRegistry = new Map(
        getFieldConfigSync()
          .filter(
            (f) =>
              f.active !== false &&
              f.clientVisible === true &&
              f.clientEditable === true &&
              f.readOnly !== true &&
              CLIENT_SCALAR_TYPES.has(f.valueType),
          )
          .map((f) => [f.id, f] as const),
      );

      const rootUpdates: Record<string, unknown> = {};
      const consultations = Array.isArray(doc.consultations)
        ? [...(doc.consultations as Record<string, unknown>[])]
        : [];
      const lastIdx = latestConsultationIndex(doc);
      let consultationTouched = false;
      const changedKeys: string[] = [];

      for (const [k, v] of Object.entries(req.body ?? {})) {
        const f = editableRegistry.get(k);
        if (!f) continue;
        const coerced = coerceFieldValue(v, f.valueType);
        if (f.scope === "root") {
          rootUpdates[k] = coerced;
        } else {
          consultations[lastIdx] = { ...(consultations[lastIdx] ?? {}), [k]: coerced };
          consultationTouched = true;
        }
        changedKeys.push(k);
      }

      if (changedKeys.length === 0) {
        return res.status(400).json({ error: "No valid (client-editable) fields provided." });
      }

      const updates: Record<string, unknown> = { ...rootUpdates };
      if (consultationTouched) updates.consultations = consultations;
      await patch(CLIENTS_COLLECTION, id, updates);

      log(`[client-status] Project details updated for ${id} by ${userEmail}: ${changedKeys.join(", ")}`);
      res.json({ success: true, updated: changedKeys });
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  DEADLINES (project-scoped legal priorities)
  // ══════════════════════════════════════════════════════════════════════════

  // Read the project's jurisdiction, its priorities, and the saved deadlines.
  app.get(
    "/api/client-status/project/:id/deadlines",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const email = String((req as Request & { clientUser?: string }).clientUser ?? "").toLowerCase().trim();

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });
      if (!clientMayAccessProject(doc, id, email)) {
        return res.status(403).json({ error: "You do not have access to this project." });
      }

      const jurisdiction = resolvePrincipalJurisdiction(doc);
      const countryCode = countryCodeFromName(jurisdiction);
      const priorities = countryCode ? prioritiesForCountry(countryCode) : [];
      const deadlines = (doc.deadlines ?? {}) as Record<string, unknown>;

      res.json({
        jurisdiction,
        countryCode,
        priorities,
        deadlines,
      });
    }),
  );

  // Upsert a single deadline for a priority. Body: { date, note? }.
  app.put(
    "/api/client-status/project/:id/deadlines/:priorityId",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, priorityId } = req.params;
      const email = String((req as Request & { clientUser?: string }).clientUser ?? "").toLowerCase().trim();

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });
      if (!clientMayAccessProject(doc, id, email)) {
        return res.status(403).json({ error: "You do not have access to this project." });
      }

      const priority = priorityById(priorityId);
      if (!priority) return res.status(404).json({ error: "Unknown priority." });

      const date = normalizeDeadlineDate(req.body?.date);
      if (!date) return res.status(400).json({ error: "date must be a valid YYYY-MM-DD." });

      const note = typeof req.body?.note === "string" ? req.body.note.trim() : undefined;
      const deadlines = (doc.deadlines ?? {}) as Record<string, unknown>;
      const now = new Date().toISOString();

      const nextDeadlines: Record<string, unknown> = {
        ...deadlines,
        [priorityId]: {
          priorityId,
          date,
          ...(note ? { note } : {}),
          updatedAt: now,
        },
      };

      await patch(CLIENTS_COLLECTION, id, { deadlines: nextDeadlines });
      log(`[client-status] Deadline upserted on project ${id}: ${priorityId} by ${email}`);
      res.json({ ok: true, deadline: nextDeadlines[priorityId] });
    }),
  );

  // Remove a deadline for a priority.
  app.delete(
    "/api/client-status/project/:id/deadlines/:priorityId",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, priorityId } = req.params;
      const email = String((req as Request & { clientUser?: string }).clientUser ?? "").toLowerCase().trim();

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Project not found." });
      if (!clientMayAccessProject(doc, id, email)) {
        return res.status(403).json({ error: "You do not have access to this project." });
      }

      const deadlines = (doc.deadlines ?? {}) as Record<string, unknown>;
      if (!(priorityId in deadlines)) {
        return res.status(404).json({ error: "No deadline recorded for this priority." });
      }

      const nextDeadlines: Record<string, unknown> = { ...deadlines };
      delete nextDeadlines[priorityId];

      await patch(CLIENTS_COLLECTION, id, { deadlines: nextDeadlines });
      log(`[client-status] Deadline removed on project ${id}: ${priorityId} by ${email}`);
      res.json({ ok: true });
    }),
  );
};
