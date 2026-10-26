import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import getAll from "../../db/getAll.ts";
import { sendEmailTransport } from "../../config/integrations.ts";
import {
  issueOtp,
  verifyOtp,
  generateSessionToken,
  isAllowedDomain,
  emailToDocId,
} from "../../helper/auth/otp.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { transcribeAudio } from "../chatbot/intelligence/transcription.ts";
import { createCalendarEvent, fetchMeetNotes } from "../../helper/calendar.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { resolveEmailCc, resolveEmailBcc } from "./automation/recipientRules.ts";
import { renderLegalEmail, legalEmailTypes } from "./automation/renderLegalEmail.ts";

import {
  buildClientSummary,
  computeStage,
  fetchAllClientsWithIds,
  getStageIds,
  getStageLabels,
  resolveClientEmail,
} from "./clientHelpers.ts";
import { ensureStageConfig, isValidStage } from "./automation/stageConfig.ts";
import { ensureFieldConfig, getFieldConfigSync } from "./automation/fieldConfig.ts";
import { extractClientFieldsServer } from "./extractClientFieldsServer.ts";
import { fetchEmailQueueMetrics, fetchLLMCostMetrics } from "./metricsHelpers.ts";
import { aggregateActivity } from "./activityMetrics.ts";
import { handleBugReport } from "./bugReportHandler.ts";
import {
  handleAddPendingAction,
  handleResolvePendingAction,
  addPendingAction,
} from "./pendingActions.ts";
import {
  createSuggestions,
  buildSuggestionActivityEntries,
  handleDismissEmailSuggestion,
} from "./emailSuggestions.ts";
import { getActionsForStage, getActionByKey } from "./actions/registry.ts";
import staffHomeRouter from "./staffHome/staffHomeRouter.ts";

const CLIENTS_COLLECTION = "clients";

const NOTE_GHOST_ADMIN_EMAILS = [
  "luisarmando@internationallegalpartner.com",
  "pablo@internationallegalpartner.com",
];

function viewerIsNoteAdmin(req: Request): boolean {
  const actor = (req as Request & { dashboardUser?: string }).dashboardUser;
  return typeof actor === "string" && NOTE_GHOST_ADMIN_EMAILS.includes(actor);
}

/** Build the interpolation data dict for a legal email (preview + trigger). */
function buildLegalEmailData(
  doc: Record<string, unknown>,
  id: string,
  clientEmail: string,
): Record<string, unknown> {
  const consultations = Array.isArray(doc.consultations)
    ? (doc.consultations as Record<string, unknown>[])
    : [];
  const base: Record<string, unknown> = consultations.length > 0
    ? { ...consultations[consultations.length - 1] }
    : { ...doc };

  for (const key of [
    "dripEmail", "legalArea", "legalMatter", "jurisdiction", "name", "surname",
    "notes", "transcript", "transcriptInsights", "stage",
  ]) {
    if (base[key] === undefined && doc[key] !== undefined) base[key] = doc[key];
  }
  base.email = base.email || clientEmail;
  const DASHBOARD_URL = Deno.env.get("DASHBOARD_URL") || "https://internationallegalpartner.netlify.app";
  base.statusPageUrl = `${DASHBOARD_URL}/status/${id}`;
  return base;
}

export { requireDashboardAuth };

export default (app: Express) => {
  log("Dashboard router initialized.");
  staffHomeRouter(app);

  // ══════════════════════════════════════════════════════════════════════════
  //  AUTH ROUTES (kept from ILP)
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/auth/request-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email } = req.body;
      if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "Email is required." });
      }
      if (!isAllowedDomain(email)) {
        return res.status(403).json({ error: "Access restricted to ILP team members." });
      }

      const normalizedEmail = email.trim().toLowerCase();
      const issued = await issueOtp("dashboard_otps", emailToDocId(normalizedEmail), normalizedEmail);
      if (!issued.ok) return res.status(issued.status).json({ error: issued.error });
      const code = issued.code;

      try {
        await sendEmailTransport({
          to: email,
          subject: "Your ILP Dashboard Login Code",
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
            <h1 style="color:#123b5d;font-size:24px;margin:0">ILP Dashboard</h1>
            <p style="color:#4a5a66;font-size:14px;margin-top:8px">Secure Login Code</p>
            <div style="background:#eff7fb;border-radius:12px;padding:32px;text-align:center">
              <p style="color:#202a33;font-size:16px;margin:0 0 16px">Your verification code is:</p>
              <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#123b5d;font-family:monospace;padding:16px;background:white;border-radius:8px;display:inline-block">${code}</div>
              <p style="color:#7a8a96;font-size:13px;margin-top:16px">This code expires in 10 minutes.</p>
            </div>
          </div>`,
        });
        log(`[dashboard] OTP sent to ${email}`);
      } catch (err) {
        log(`[dashboard] Failed to send OTP email: ${err instanceof Error ? err.message : err}`);
        return res.status(500).json({ error: "Failed to send verification code." });
      }

      res.json({ success: true, message: "Verification code sent to your email." });
    })
  );

  app.post(
    "/api/dashboard/auth/verify-otp",
    asyncHandler(async (req: Request, res: Response) => {
      const { email, code } = req.body;
      if (!email || !code) return res.status(400).json({ error: "Email and code are required." });

      const normalizedEmail = String(email).trim().toLowerCase();
      if (!isAllowedDomain(normalizedEmail)) {
        return res.status(403).json({ error: "Access restricted to ILP team members." });
      }
      const check = await verifyOtp("dashboard_otps", emailToDocId(normalizedEmail), code);
      if (!check.ok) return res.status(check.status).json({ error: check.error });

      const token = generateSessionToken();
      const sessionExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await put("dashboard_sessions", token, {
        email: normalizedEmail,
        createdAt: new Date().toISOString(),
        expiresAt: sessionExpiry.toISOString(),
      });

      log(`[dashboard] Session created for ${email}`);
      res.json({ success: true, token, email: normalizedEmail, expiresAt: sessionExpiry.toISOString() });
    })
  );

  app.get(
    "/api/dashboard/auth/check",
    requireDashboardAuth,
    (req: Request, res: Response) => {
      res.json({
        authenticated: true,
        email: (req as Request & { dashboardUser?: string }).dashboardUser,
        role: (req as Request & { dashboardRole?: string }).dashboardRole ?? "staff",
      });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  VOICE TRANSCRIPTION
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/voice-transcribe",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { audioBase64 } = req.body;
      if (!audioBase64 || typeof audioBase64 !== "string") {
        return res.status(400).json({ error: "audioBase64 is required." });
      }
      try {
        const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
        const transcript = await transcribeAudio(bytes);
        res.json({ transcript });
      } catch (err) {
        log(`[voice-transcribe] error: ${err instanceof Error ? err.message : err}`);
        return res.status(502).json({ error: "Transcription failed" });
      }
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  CLIENT-FIELD EXTRACTION
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/extract-client-fields",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { transcript } = req.body;
      if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
        return res.status(400).json({ error: "transcript is required." });
      }
      try {
        const fields = await extractClientFieldsServer(transcript);
        res.json({ fields });
      } catch (err) {
        log(`[extract-client-fields] error: ${err instanceof Error ? err.message : err}`);
        return res.status(502).json({ error: "Extraction failed" });
      }
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  MANUAL CLIENT CREATION
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/clients/manual",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const {
        name, surname, email, phone,
        legalArea, legalMatter, jurisdiction,
        notes, voiceTranscript, customFields,
      } = req.body;

      if (!email || typeof email !== "string" || !email.includes("@")) {
        return res.status(400).json({ error: "A valid email is required." });
      }

      const docId = emailToDocId(email);
      const existing = await get(CLIENTS_COLLECTION, docId);
      if (existing) {
        return res.status(409).json({ error: `A client with email ${email} already exists.` });
      }

      const now = new Date().toISOString();
      const createdBy = (req as Request & { dashboardUser?: string }).dashboardUser ?? "staff";

      const notesArray: Array<Record<string, unknown>> = [];
      if (notes?.trim()) {
        notesArray.push({ text: notes.trim(), author: createdBy, createdAt: now });
      }
      if (voiceTranscript?.trim()) {
        notesArray.push({
          text: `[Voice note transcript]\n${voiceTranscript.trim()}`,
          author: createdBy,
          createdAt: now,
          isVoiceTranscript: true,
        });
      }

      const newDoc: Record<string, unknown> = {
        dripEmail: email,
        stage: "intake",
        createdAt: now,
        updatedAt: now,
        source: "manual_intake",
        createdBy,
        name: name?.trim() || "",
        surname: surname?.trim() || "",
        phone: phone?.trim() || "",
        legalArea: legalArea?.trim() || "",
        legalMatter: legalMatter?.trim() || "",
        jurisdiction: jurisdiction?.trim() || "",
        notes: notesArray,
        activityLog: [{
          type: "manual_intake",
          actor: createdBy,
          timestamp: now,
          note: "Client added manually via CRM dashboard.",
        }],
        consultations: [{
          email,
          name: name?.trim() || "",
          surname: surname?.trim() || "",
          phone: phone?.trim() || "",
          legalArea: legalArea?.trim() || "",
          legalMatter: legalMatter?.trim() || "",
          jurisdiction: jurisdiction?.trim() || "",
          source: "manual_intake",
          timestamp: now,
        }],
      };

      if (customFields && typeof customFields === "object" && Object.keys(customFields).length > 0) {
        newDoc.customFields = customFields;
      }
      if (voiceTranscript?.trim()) {
        newDoc.transcript = voiceTranscript.trim();
      }

      await put(CLIENTS_COLLECTION, docId, newDoc);
      log(`[dashboard] Manual client created: ${docId} by ${createdBy}`);

      res.status(201).json({ success: true, docId });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  CLIENT ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/dashboard/clients",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const isAdmin = viewerIsNoteAdmin(req);
      await ensureStageConfig();
      const docs = await fetchAllClientsWithIds();
      const clients = docs.map(({ docId, data }) => buildClientSummary(docId, data, isAdmin));
      clients.sort((a, b) => {
        const da = a.lastUpdated ? new Date(a.lastUpdated as string).getTime() : 0;
        const db = b.lastUpdated ? new Date(b.lastUpdated as string).getTime() : 0;
        return db - da;
      });
      res.json({ clients, stages: getStageIds(), stageLabels: getStageLabels(), total: clients.length });
    })
  );

  app.get(
    "/api/dashboard/clients/:id/conversations",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const clientEmail = resolveClientEmail(doc, id);
      const threads = await query("ilp_chatbot_threads", []).catch(() => []);
      const matching = threads
        .filter((t) => {
          const snap = t.formContextSnapshot as Record<string, unknown> | undefined;
          return snap?.email === clientEmail;
        })
        .sort((a, b) =>
          String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
        );

      const statusChatThread = Array.isArray(doc.statusChatThread)
        ? doc.statusChatThread
        : [];

      res.json({ success: true, conversations: matching, statusChatThread, email: clientEmail });
    })
  );

  app.get(
    "/api/dashboard/clients/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const doc = await get(CLIENTS_COLLECTION, req.params.id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      res.json(buildClientSummary(req.params.id, doc, viewerIsNoteAdmin(req)));
    })
  );

  app.patch(
    "/api/dashboard/clients/:id/stage",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { stage } = req.body;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      if (!stage) return res.status(400).json({ error: "Invalid stage." });

      await ensureStageConfig();
      if (!isValidStage(stage)) return res.status(400).json({ error: "Invalid stage." });

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const previousStage = computeStage(doc);
      const nowIso = new Date().toISOString();

      const newSuggestions = createSuggestions(stage, actor, nowIso);
      const activityEntries: Array<Record<string, unknown>> = [
        { type: "stage_change", from: previousStage, to: stage, actor, timestamp: nowIso },
        ...buildSuggestionActivityEntries(newSuggestions, nowIso),
      ];

      const updatePayload: Record<string, unknown> = {
        stage,
        stageEnteredAt: nowIso,
        updatedAt: nowIso,
        activityLog: [...(Array.isArray(doc.activityLog) ? doc.activityLog : []), ...activityEntries],
      };

      if (newSuggestions.length > 0) {
        const existingPending = (Array.isArray(doc.pendingEmailSuggestions) ? doc.pendingEmailSuggestions : [])
          .filter((s) => (s as Record<string, unknown>).status === "pending");
        updatePayload.pendingEmailSuggestions = [...existingPending, ...newSuggestions];
      }

      await put(CLIENTS_COLLECTION, id, updatePayload);
      log(`[dashboard] ${actor} moved ${id} from ${previousStage} to ${stage}`);
      res.json({ success: true, stage, previousStage, emailSuggestions: newSuggestions.length });
    })
  );

  app.delete(
    "/api/dashboard/clients/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const nowIso = new Date().toISOString();
      await put(CLIENTS_COLLECTION, id, {
        archived: true,
        archivedAt: nowIso,
        archivedBy: actor,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "client_archived", actor, timestamp: nowIso },
        ],
      });

      log(`[dashboard] ${actor} archived client ${id}`);
      res.json({ success: true, archived: true, id });
    })
  );

  app.patch(
    "/api/dashboard/clients/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const updates = req.body;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const changes: string[] = [];
      const updatePayload: Record<string, unknown> = {};
      for (const key of ["customFields", "stage", "dripEnabled", "rankIndex"]) {
        if (updates[key] !== undefined) { updatePayload[key] = updates[key]; changes.push(key); }
      }
      if (updates.customFields) {
        updatePayload.customFields = { ...(doc.customFields as Record<string, unknown> ?? {}), ...updates.customFields };
      }

      if (changes.length > 0) {
        updatePayload.updatedAt = new Date().toISOString();
        updatePayload.activityLog = [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "field_update", fields: changes, actor, timestamp: new Date().toISOString() },
        ];
        await put(CLIENTS_COLLECTION, id, updatePayload);
      }
      res.json({ success: true, updated: changes });
    })
  );

  app.patch(
    "/api/dashboard/clients/:id/field",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { field, value } = req.body;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      if (!field || typeof field !== "string") {
        return res.status(400).json({ error: "field is required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      await ensureFieldConfig();
      const fieldDef = getFieldConfigSync().find((f) => f.id === field);
      if (!fieldDef) return res.status(400).json({ error: "Unknown field." });

      const updatePayload: Record<string, unknown> = {};
      if (fieldDef.scope === "root") {
        updatePayload[field] = value;
      } else {
        const cons = Array.isArray(doc.consultations) ? [...(doc.consultations as Record<string, unknown>[])] : [];
        const lastIdx = Math.max(0, cons.length - 1);
        cons[lastIdx] = { ...(cons[lastIdx] ?? {}), [field]: value };
        updatePayload.consultations = cons;
      }
      updatePayload.updatedAt = new Date().toISOString();
      updatePayload.activityLog = [
        ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
        { type: "field_update", fields: [field], actor, timestamp: new Date().toISOString() },
      ];

      await put(CLIENTS_COLLECTION, id, updatePayload);
      res.json({ success: true, field, value });
    })
  );

  app.post(
    "/api/dashboard/clients/:id/undo-last",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const logArr = Array.isArray(doc.activityLog) ? [...(doc.activityLog as Record<string, unknown>[])] : [];
      const last = logArr.pop();
      if (!last) return res.status(400).json({ error: "No activity to undo." });

      await put(CLIENTS_COLLECTION, id, {
        activityLog: logArr,
        updatedAt: new Date().toISOString(),
      });
      log(`[dashboard] ${actor} undid last activity on ${id}`);
      res.json({ success: true, undone: last });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  NOTES
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/clients/:id/notes",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { text, recipients } = req.body;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      if (!text || typeof text !== "string") return res.status(400).json({ error: "Note text is required." });

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const cleanRecipients: string[] = Array.isArray(recipients)
        ? [...new Set(recipients.filter((e: unknown) => typeof e === "string" && e.includes("@")).map((e: string) => e.trim().toLowerCase()))]
        : [];

      const nowIso = new Date().toISOString();
      const note: Record<string, unknown> = { text: text.trim(), author: actor, createdAt: nowIso };
      const noteActivity: Record<string, unknown> = { type: "note_added", actor, timestamp: nowIso };
      if (cleanRecipients.length > 0) {
        note.recipients = cleanRecipients;
        noteActivity.recipients = cleanRecipients;
      }

      await put(CLIENTS_COLLECTION, id, {
        notes: [...(Array.isArray(doc.notes) ? doc.notes : []), note],
        activityLog: [...(Array.isArray(doc.activityLog) ? doc.activityLog : []), noteActivity],
        updatedAt: nowIso,
      });

      if (cleanRecipients.length > 0) {
        const clientName = (doc.name || resolveClientEmail(doc, id)) as string;
        const preview = text.trim().length > 140 ? `${text.trim().slice(0, 140)}…` : text.trim();
        void addPendingAction(id, {
          type: "note_mention",
          tab: "notes",
          title: `📝 ${actor} addressed a note to you — ${clientName}`,
          priority: "normal",
          assignedTo: cleanRecipients,
          triggeredBy: actor,
          meta: { noteCreatedAt: nowIso, body: preview, fullBody: text.trim(), from: actor, clientName },
        }).catch((err) => log(`[dashboard] note in-app notify failed: ${err}`));
      }

      res.json({ success: true, note });
    })
  );

  app.patch(
    "/api/dashboard/clients/:id/notes/:noteId",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, noteId } = req.params;
      const { text } = req.body;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "Note text is required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const notes = Array.isArray(doc.notes) ? (doc.notes as Record<string, unknown>[]) : [];
      const idx = notes.findIndex((n) => n && n.createdAt === noteId);
      if (idx === -1) return res.status(404).json({ error: "Note not found." });
      if (notes[idx].deletedAt) return res.status(409).json({ error: "Cannot edit a deleted note." });

      const nowIso = new Date().toISOString();
      const previousText = notes[idx].text;
      const updatedNote = { ...notes[idx], text: text.trim(), editedAt: nowIso, editedBy: actor };
      const nextNotes = notes.slice();
      nextNotes[idx] = updatedNote;

      await put(CLIENTS_COLLECTION, id, {
        notes: nextNotes,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "note_edited", actor, timestamp: nowIso, noteCreatedAt: noteId, previousText, newText: text.trim() },
        ],
      });

      res.json({ success: true, note: updatedNote });
    })
  );

  app.delete(
    "/api/dashboard/clients/:id/notes/:noteId",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, noteId } = req.params;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const notes = Array.isArray(doc.notes) ? (doc.notes as Record<string, unknown>[]) : [];
      const idx = notes.findIndex((n) => n && n.createdAt === noteId);
      if (idx === -1) return res.status(404).json({ error: "Note not found." });
      if (notes[idx].deletedAt) return res.json({ success: true, note: notes[idx] });

      const nowIso = new Date().toISOString();
      const deletedNote = { ...notes[idx], deletedAt: nowIso, deletedBy: actor };
      const nextNotes = notes.slice();
      nextNotes[idx] = deletedNote;

      await put(CLIENTS_COLLECTION, id, {
        notes: nextNotes,
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "note_deleted", actor, timestamp: nowIso, noteCreatedAt: noteId, noteText: notes[idx].text },
        ],
      });

      res.json({ success: true, note: deletedNote });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  ACTIONS
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/dashboard/clients/:id/actions",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const doc = await get(CLIENTS_COLLECTION, req.params.id);
      if (!doc) return res.status(404).json({ error: "Client not found." });
      const stage = computeStage(doc);
      res.json({ actions: getActionsForStage(stage), stage });
    })
  );

  app.post(
    "/api/dashboard/clients/:id/actions/:actionKey",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, actionKey } = req.params;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      const action = getActionByKey(actionKey);
      if (!action) return res.status(404).json({ error: "Unknown action." });

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      // ── Admin action-permissions gate ──────────────────────────────────────
      // `dashboard_config/action_permissions` is { permissions: Record<email, Record<actionKey, boolean>> }.
      // An explicit false for (actor, actionKey) blocks execution; absence = allow.
      const permDoc = await get("dashboard_config", "action_permissions").catch(() => null);
      const perms = (permDoc?.permissions ?? {}) as Record<string, Record<string, boolean>>;
      const actorKey = typeof actor === "string" ? actor : "";
      if (actorKey && perms[actorKey] && perms[actorKey][actionKey] === false) {
        return res.status(403).json({ error: `You do not have permission to run "${actionKey}".` });
      }

      const nowIso = new Date().toISOString();
      const clientArgs = (req.body?.args ?? {}) as Record<string, unknown>;
      const stage = computeStage(doc);

      let result: { success: boolean; message?: string; data?: Record<string, unknown> } | null = null;
      if (action.handler) {
        try {
          result = await action.handler({ clientId: id, clientDoc: doc, stage, actor, args: clientArgs });
        } catch (err) {
          log(`[dashboard] action ${actionKey} failed on ${id}: ${err instanceof Error ? err.message : err}`);
          await put(CLIENTS_COLLECTION, id, {
            activityLog: [
              ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
              { type: "action_executed", actionKey, actor, timestamp: nowIso, success: false, error: err instanceof Error ? err.message : String(err) },
            ],
          });
          return res.status(500).json({ error: `Action failed: ${err instanceof Error ? err.message : err}` });
        }
      }

      await put(CLIENTS_COLLECTION, id, {
        updatedAt: nowIso,
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "action_executed", actionKey, actor, timestamp: nowIso, success: result?.success ?? true, result },
        ],
      });

      log(`[dashboard] ${actor} executed action ${actionKey} on ${id}`);
      res.json({ success: true, actionKey, result });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  PENDING ACTIONS
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/clients/:id/pending-action",
    requireDashboardAuth,
    asyncHandler(handleAddPendingAction)
  );

  app.patch(
    "/api/dashboard/clients/:id/pending-action/:actionId/resolve",
    requireDashboardAuth,
    asyncHandler(handleResolvePendingAction)
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  EMAIL SUGGESTIONS
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/clients/:id/dismiss-email-suggestion",
    requireDashboardAuth,
    asyncHandler(handleDismissEmailSuggestion)
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  EMAIL QUEUE
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/dashboard/pending-emails",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await query("email_queue", [{ field: "status", op: "EQUAL", value: "pending" }]).catch(() => []);
      res.json({ pending: rows });
    })
  );

  app.get(
    "/api/admin/email-queue/status",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const metrics = await fetchEmailQueueMetrics();
      res.json(metrics);
    })
  );

  app.post(
    "/api/dashboard/email-queue/:queueId/cancel",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { queueId } = req.params;
      const doc = await get("email_queue", queueId);
      if (!doc) return res.status(404).json({ error: "Queue item not found." });
      await patch("email_queue", queueId, { status: "cancelled", cancelledAt: new Date().toISOString() });
      res.json({ success: true });
    })
  );

  app.post(
    "/api/dashboard/email-queue/:queueId/send-now",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { queueId } = req.params;
      const doc = await get("email_queue", queueId);
      if (!doc) return res.status(404).json({ error: "Queue item not found." });

      try {
        await sendEmailTransport({
          to: doc.to as string,
          subject: doc.subject as string,
          html: doc.html as string,
          text: doc.text as string | undefined,
        });
        await patch("email_queue", queueId, { status: "sent", sentAt: new Date().toISOString() });
        res.json({ success: true });
      } catch (err) {
        log(`[dashboard] send-now failed for ${queueId}: ${err instanceof Error ? err.message : err}`);
        return res.status(502).json({ error: "Send failed" });
      }
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  CONFIG READS
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/dashboard/stages",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      await ensureStageConfig();
      res.json({ stages: getStageIds(), stageLabels: getStageLabels() });
    })
  );

  app.get(
    "/api/dashboard/email-types",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      await Promise.resolve();
      res.json({
        emailTypes: [
          { id: "scoping_intro", label: "Scoping intro" },
          { id: "legal_review_update", label: "Legal review update" },
          { id: "quote_ready", label: "Quote ready" },
          { id: "quote_accepted_confirmation", label: "Quote accepted confirmation" },
          { id: "filing_started", label: "Filing started" },
          { id: "matter_closed", label: "Matter closed" },
          { id: "filing_deadline_reminder", label: "Filing deadline reminder" },
        ],
      });
    })
  );

  app.post(
    "/api/dashboard/bug-report",
    requireDashboardAuth,
    asyncHandler(handleBugReport)
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  ADMIN
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/admin/access-config",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const doc = await get("dashboard_config", "access_config");
      res.json(doc ?? { views: {}, collaborators: [] });
    })
  );

  app.put(
    "/api/admin/access-config",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      await put("dashboard_config", "access_config", {
        ...(req.body ?? {}),
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
      });
      res.json({ success: true });
    })
  );

  app.get(
    "/api/admin/user-activity",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await getAll("audit_log").catch(() => []);
      res.json({ activity: rows });
    })
  );

  app.get(
    "/api/admin/action-permissions",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const doc = await get("dashboard_config", "action_permissions");
      res.json(doc ?? { permissions: {} });
    })
  );

  app.put(
    "/api/admin/action-permissions",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      await put("dashboard_config", "action_permissions", {
        permissions: req.body?.permissions ?? {},
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
      });
      res.json({ success: true });
    })
  );

  app.get(
    "/api/admin/collaborators",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const doc = await get("dashboard_config", "collaborators");
      res.json(doc ?? { collaborators: [] });
    })
  );

  app.put(
    "/api/admin/collaborators",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      await put("dashboard_config", "collaborators", {
        collaborators: req.body?.collaborators ?? [],
        updatedBy: actor,
        updatedAt: new Date().toISOString(),
      });
      res.json({ success: true });
    })
  );

  app.get(
    "/api/admin/sessions",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const rows = await getAll("dashboard_sessions").catch(() => []);
      res.json({ sessions: rows });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  METRICS
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/dashboard/metrics",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const [clientDocs, email, llm] = await Promise.all([
        fetchAllClientsWithIds(),
        fetchEmailQueueMetrics(),
        fetchLLMCostMetrics(),
      ]);

      await ensureStageConfig();
      const stageIds = getStageIds();
      const stageLabels = getStageLabels();

      const stageCounts: Record<string, number> = {};
      for (const stage of stageIds) stageCounts[stage] = 0;

      let totalClients = 0;
      const monthlyLeads: Record<string, number> = {};
      const sourceBreakdown: Record<string, number> = {};
      const jurisdictionBreakdown: Record<string, number> = {};

      for (const { data } of clientDocs) {
        totalClients++;
        const stage = computeStage(data);
        stageCounts[stage] = (stageCounts[stage] || 0) + 1;

        const consultations = Array.isArray(data.consultations) ? data.consultations : [];
        const latest = (consultations[consultations.length - 1] ?? {}) as Record<string, unknown>;
        const firstTs =
          (consultations[0] as Record<string, unknown> | undefined)?.timestamp ??
          data.createdAt;
        if (typeof firstTs === "string" && firstTs) {
          const month = firstTs.substring(0, 7);
          monthlyLeads[month] = (monthlyLeads[month] || 0) + 1;
        }

        const source = (latest.source ?? data.source ?? "unknown") as string;
        sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;

        const jurisdiction = (latest.jurisdiction ?? data.jurisdiction ?? "") as string;
        if (jurisdiction) {
          jurisdictionBreakdown[jurisdiction] = (jurisdictionBreakdown[jurisdiction] || 0) + 1;
        }
      }

      // Stage satisfaction: average client rating per stage, from each client's
      // `stageRatings` map. Emitted in canonical stage order.
      const perStage: Array<{
        stage: string;
        label: string;
        average: number;
        count: number;
      }> = [];
      let ratingsSum = 0;
      let ratingsCount = 0;
      for (const stage of stageIds) {
        let sum = 0;
        let count = 0;
        for (const { data } of clientDocs) {
          const ratings = (data.stageRatings ?? {}) as Record<string, Record<string, unknown>>;
          const r = ratings[stage];
          const rating = Number(r?.rating);
          if (Number.isFinite(rating) && rating >= 1 && rating <= 5) {
            sum += rating;
            count++;
          }
        }
        perStage.push({
          stage,
          label: stageLabels.find((s) => s.id === stage)?.label ?? stage,
          average: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
          count,
        });
        ratingsSum += sum;
        ratingsCount += count;
      }

      const activity = aggregateActivity(clientDocs);

      // Deadline follow-up loop state (1.5): aggregate over the active loops so
      // the dashboard can surface how many follow-ups are live / urgent / overdue.
      let followupActive = 0;
      let followupOverdue = 0;
      let followupUrgent = 0;
      for (const { data } of clientDocs) {
        const f = (data.deadlineFollowup ?? {}) as Record<string, unknown>;
        if (!f || f.status !== "active") continue;
        followupActive++;
        const deadlineStr = typeof f.deadline === "string" && f.deadline
          ? f.deadline
          : (typeof data.filingDeadline === "string" ? data.filingDeadline : null);
        if (!deadlineStr) continue;
        const dl = new Date(deadlineStr).getTime();
        if (Number.isNaN(dl)) continue;
        const daysOut = (dl - Date.now()) / 86_400_000;
        if (daysOut <= 0) followupOverdue++;
        else if (daysOut <= 7) followupUrgent++;
      }

      res.json({
        pipeline: { stageCounts, stageLabels, total: totalClients },
        emailQueue: email,
        llmCosts: llm,
        monthlyLeads,
        sourceBreakdown,
        jurisdictionBreakdown,
        deadlineFollowup: {
          active: followupActive,
          overdue: followupOverdue,
          urgent: followupUrgent,
        },
        stageRatings: {
          perStage,
          globalAverage: ratingsCount > 0 ? Math.round((ratingsSum / ratingsCount) * 100) / 100 : 0,
          totalRatings: ratingsCount,
        },
        activity,
      });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  BI GENERIC COLLECTION ROUTE
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/dashboard/bi/:collection",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { collection } = req.params;
      const ALLOWED_COLLECTIONS = [
        "clients",
        "ilp_chatbot_threads",
        "email_queue",
        "llm_costs",
        "consultations",
      ];

      if (!ALLOWED_COLLECTIONS.includes(collection)) {
        return res.status(400).json({
          error: `Collection not allowed. Must be one of: ${ALLOWED_COLLECTIONS.join(", ")}`,
          allowed: ALLOWED_COLLECTIONS,
        });
      }

      const rows = await getAll(collection).catch(() => []);
      res.json({ success: true, collection, count: rows.length, documents: rows });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  ATTENDEES / RESCHEDULE
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/clients/:id/attendees",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { attendees } = req.body;
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const clean = Array.isArray(attendees)
        ? attendees.filter((e: unknown) => typeof e === "string" && e.includes("@"))
        : [];

      await put(CLIENTS_COLLECTION, id, {
        attendees: clean,
        updatedAt: new Date().toISOString(),
      });
      res.json({ success: true, attendees: clean });
    })
  );

  app.post(
    "/api/dashboard/clients/:id/reschedule",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { slot } = req.body;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";
      if (!slot?.start || !slot?.end) {
        return res.status(400).json({ error: "slot.start and slot.end are required." });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const event = await createCalendarEvent({
        slot: { start: slot.start, end: slot.end, timezone: slot.timezone ?? "America/Costa_Rica" },
        title: `Consultation: ${doc.name ?? "Client"}`,
      });

      await put(CLIENTS_COLLECTION, id, {
        scheduling: [slot.start],
        lastCalendarEvent: { eventId: event.eventId, htmlLink: event.htmlLink },
        updatedAt: new Date().toISOString(),
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          { type: "rescheduled", actor, timestamp: new Date().toISOString(), slot: slot.start },
        ],
      });

      res.json({ success: true, eventId: event.eventId, htmlLink: event.htmlLink });
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  EXTRACT INSIGHTS
  // ══════════════════════════════════════════════════════════════════════════

  app.post(
    "/api/dashboard/clients/:id/extract-insights",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const transcript = typeof doc.transcript === "string" ? doc.transcript : "";
      if (!transcript) return res.status(400).json({ error: "No transcript available." });

      try {
        const fields = await extractClientFieldsServer(transcript);
        await put(CLIENTS_COLLECTION, id, {
          transcriptInsights: fields,
          updatedAt: new Date().toISOString(),
        });
        res.json({ success: true, insights: fields });
      } catch (err) {
        log(`[extract-insights] error: ${err instanceof Error ? err.message : err}`);
        return res.status(502).json({ error: "Extraction failed" });
      }
    })
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  EMAILS TAB — PREVIEW / TRIGGER / SENT READ / MEET-NOTES SYNC
  // ══════════════════════════════════════════════════════════════════════════

  app.get(
    "/api/dashboard/clients/:id/email-preview",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const emailType = typeof req.query.type === "string" ? req.query.type.trim() : "";

      if (!emailType || !legalEmailTypes().includes(emailType)) {
        return res.status(400).json({
          error: `Invalid or missing email type. Must be one of: ${legalEmailTypes().join(", ")}`,
        });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const clientEmail = resolveClientEmail(doc, id);
      const data = buildLegalEmailData(doc, id, clientEmail);
      const { subject, bodyHtml } = renderLegalEmail(emailType, data);

      res.json({
        success: true,
        emailType,
        subject,
        bodyHtml,
        context: data,
        clientEmail,
        note: "Preview only — not sent. Call POST /trigger-email to dispatch.",
      });
    })
  );

  app.post(
    "/api/dashboard/clients/:id/trigger-email",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const { emailType, editMeta, suggestionId } = req.body ?? {};
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";

      if (!emailType || !legalEmailTypes().includes(emailType)) {
        return res.status(400).json({
          error: "Invalid email type.",
          validTypes: legalEmailTypes(),
        });
      }

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const clientEmail = resolveClientEmail(doc, id);
      const data = buildLegalEmailData(doc, id, clientEmail);
      const { subject, bodyHtml } = renderLegalEmail(emailType, data);

      const cc = resolveEmailCc(emailType);
      const bcc = resolveEmailBcc(emailType);

      await enqueueEmail(
        { to: clientEmail, subject, html: bodyHtml, cc, bcc },
        `${id}__${emailType}__${Date.now()}`,
      );

      const nowIso = new Date().toISOString();
      const activityEntry: Record<string, unknown> = {
        type: "email_triggered",
        emailType,
        actor,
        timestamp: nowIso,
      };
      if (editMeta && typeof editMeta === "object") {
        activityEntry.emailEdited = true;
        activityEntry.editedBy = (editMeta as Record<string, unknown>).editedBy || actor;
        activityEntry.editedAt = (editMeta as Record<string, unknown>).editedAt || nowIso;
      }
      if (suggestionId) activityEntry.resolvedSuggestionId = suggestionId;

      const payload: Record<string, unknown> = {
        activityLog: [
          ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
          activityEntry,
        ],
      };

      const existingSuggestions = Array.isArray(doc.pendingEmailSuggestions)
        ? (doc.pendingEmailSuggestions as Array<Record<string, unknown>>)
        : [];
      if (existingSuggestions.length > 0) {
        const updated = existingSuggestions.filter(
          (s) =>
            !(s?.status === "pending" &&
              (s.suggestionId === suggestionId || (!suggestionId && s.emailType === emailType))),
        );
        if (updated.length !== existingSuggestions.length) {
          payload.pendingEmailSuggestions = updated;
        }
      }

      await put(CLIENTS_COLLECTION, id, payload);
      log(`[dashboard] ${actor} triggered ${emailType} for ${id}`);
      res.json({ success: true, emailType, clientEmail });
    })
  );

  app.get(
    "/api/dashboard/sent-emails/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "").trim();
      if (!id) return res.status(400).json({ error: "Missing sent-email id" });
      const doc = await get("email_queue", id);
      if (!doc) return res.status(404).json({ error: "Sent email not found" });
      res.json({ id, ...doc });
    })
  );

  app.post(
    "/api/dashboard/clients/:id/sync-meet-notes",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as Request & { dashboardUser?: string }).dashboardUser ?? "system";

      const doc = await get(CLIENTS_COLLECTION, id);
      if (!doc) return res.status(404).json({ error: "Client not found." });

      const cal = (doc.lastCalendarEvent ?? {}) as Record<string, unknown>;
      const eventId = typeof cal.eventId === "string" ? cal.eventId : undefined;
      if (!eventId) {
        return res.status(400).json({
          error: "no_calendar_event",
          message: "This client has no calendar event linkage saved.",
        });
      }

      log(`[dashboard] ${actor} requested sync-meet-notes for ${id} (event ${eventId})`);

      try {
        // P3: prefer the Meet transcript / Gemini notes Doc attached to the
        // event (read through Drive), then the event description as before.
        const fetched = await fetchMeetNotes(eventId, { allowDescription: true });
        if (fetched.status !== "fetched") {
          return res.json({
            success: false,
            status: "not_ready",
            message: fetched.message,
          });
        }
        const description = fetched.text;

        const fields = await extractClientFieldsServer(description);
        const nowIso = new Date().toISOString();
        const notes = { fetched: true, fetchedAt: nowIso, eventId, text: description, fields, source: fetched.source };

        await put(CLIENTS_COLLECTION, id, {
          lastCalendarEvent: { ...cal, notes },
          ...(fields as Record<string, unknown>),
          updatedAt: nowIso,
          activityLog: [
            ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
            { type: "meet_notes_synced", eventId, actor, timestamp: nowIso, source: "manual_sync" },
          ],
        });

        res.json({
          success: true,
          status: "fetched",
          eventId,
          source: fetched.source,
          textLength: description.length,
          fields,
        });
      } catch (err) {
        log(`[dashboard] sync-meet-notes error ${id}: ${err instanceof Error ? err.message : err}`);
        return res.status(500).json({
          error: "fetch_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
};
