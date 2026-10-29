/**
 * API/calls/callsRouter.ts — the call itself (P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Lawyer (requireProviderAuth; /api/provider/* responses pass the lawyer
 * field strip from lawyerView.ts):
 *   GET   /api/provider/availability                         own settings (defaults when none saved)
 *   PUT   /api/provider/availability                         { weekly, blackoutDates, minLeadHours, maxCallsPerDay, specialties, calendarId? }
 *   POST  /api/provider/consultations/:id/no-show            member didn't join (after 10 min) → no_show, call used
 *   POST  /api/provider/consultations/:id/meet-transcript    pull the Meet transcript, then draft a suggested summary
 *   POST  /api/provider/consultations/:id/upload-recording   { fileName, contentType, dataBase64 } → transcribe → suggested summary
 *
 * Staff (requireDashboardAuth; staff, csm, admin):
 *   GET   /api/dashboard/availability/:providerId
 *   PUT   /api/dashboard/availability/:providerId
 *   GET   /api/dashboard/consultations/:id/slots             open slots for a reschedule
 *   POST  /api/dashboard/consultations/:id/cancel            { reason? }  any time
 *   POST  /api/dashboard/consultations/:id/reschedule        { scheduledAt }  any time
 *   POST  /api/dashboard/consultations/:id/restore-call      give back a charged call (no-show)
 *   POST  /api/dashboard/consultations/:id/retry-calendar    create the Meet event again, email the link
 *
 * Member (requireClientAuth; scoped to the session's clientId):
 *   GET   /api/client-status/me/consultations/:id/slots      open slots for a reschedule
 *   POST  /api/client-status/me/consultations/:id/cancel     up to 24 h before
 *   POST  /api/client-status/me/consultations/:id/reschedule { scheduledAt } up to 24 h before
 *   POST  /api/client-status/me/consultations/:id/consent    { recording: "granted" | "declined", where?: "join" | "booking" }
 *   GET   /api/client-status/me/consultations/:id/join       { meetUrl, open, consent } for the join screen
 *
 * Rules are in callLogic.ts; I/O in callService.ts.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { type AuthedRequest, requireClientAuth, requireDashboardAuth, requireProviderAuth } from "../../helper/auth/session.ts";
import { COLLECTIONS } from "../../schemas/contracts.ts";
import { getRecord } from "../members/service.ts";
import { transcribeAudio } from "../chatbot/intelligence/transcription.ts";
import { draftSuggestion } from "../provider/lawyerHomeRoutes.ts";
import { canChange, joinOpen, noShowCheck } from "./callLogic.ts";
import { afterNoShow } from "../retention/closingLoops.ts"; // COMMS-P4
import {
  attachMeeting,
  type CallRecord,
  cancelCall,
  loadAvailability,
  markNoShow,
  pullMeetTranscript,
  recordingStillAllowed,
  moveCallIfFree,
  restoreCallOnce,
  saveAvailability,
  sendBookingEmails,
  setConsent,
  slotsFor,
} from "./callService.ts";
import { RECORDING_WITHDRAWN_MESSAGE } from "../privacy/policy.ts";

const MAX_AUDIO_BYTES = 7 * 1024 * 1024; // the JSON body limit on upload routes is 10 MB (base64 adds a third)

const pidOf = (req: Request) => (req as AuthedRequest).providerId ?? "";
const lawyerEmail = (req: Request) => String((req as AuthedRequest).providerUser ?? "");
const staffEmail = (req: Request) => String((req as AuthedRequest).dashboardUser ?? "");
const memberEmail = (req: Request) => String((req as AuthedRequest).clientUser ?? "");

/** Shape a consultation for the member: no transcript, no unconfirmed summary, no internals. */
function forMember(c: CallRecord) {
  return {
    id: c.id,
    matterId: c.matterId,
    scheduledAt: c.scheduledAt,
    durationMin: c.durationMin,
    status: c.status,
    question: c.question,
    consent: c.consent,
    meetUrl: c.meetUrl ?? null,
    linkPending: !c.meetUrl,
  };
}

/** Staff and lawyer view: everything but internals. */
function forStaff(c: CallRecord) {
  return { ...c, transcript: undefined, hasTranscript: !!c.transcript };
}

export default function callsRouter(app: Express) {
  log("Calls router initialized (P3).");

  // ── Lawyer: availability ─────────────────────────────────────────────────
  app.get(
    "/api/provider/availability",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = pidOf(req);
      if (!pid) return res.status(401).json({ error: "No lawyer profile on this session." });
      res.json(await loadAvailability(pid));
    }),
  );

  app.put(
    "/api/provider/availability",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = pidOf(req);
      if (!pid) return res.status(401).json({ error: "No lawyer profile on this session." });
      const r = await saveAvailability(pid, req.body, { email: lawyerEmail(req), role: "lawyer" });
      if ("error" in r) return res.status(400).json({ error: r.error });
      res.json({ ...r.value, isDefault: false });
    }),
  );

  // ── Staff: availability for any lawyer ───────────────────────────────────
  app.get(
    "/api/dashboard/availability/:providerId",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await loadAvailability(req.params.providerId));
    }),
  );

  app.put(
    "/api/dashboard/availability/:providerId",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const r = await saveAvailability(req.params.providerId, req.body, { email: staffEmail(req), role: "staff" });
      if ("error" in r) return res.status(400).json({ error: r.error });
      res.json({ ...r.value, isDefault: false });
    }),
  );

  // ── Lawyer: after the call ───────────────────────────────────────────────
  async function ownCall(req: Request, res: Response): Promise<CallRecord | null> {
    const c = await getRecord<CallRecord>(COLLECTIONS.consultations, req.params.id);
    if (!c || !pidOf(req) || c.providerId !== pidOf(req)) {
      res.status(404).json({ error: "Consultation not found." });
      return null;
    }
    return c;
  }

  app.post(
    "/api/provider/consultations/:id/no-show",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await ownCall(req, res);
      if (!c) return;
      const ok = noShowCheck(c, new Date());
      if (!ok.ok) return res.status(409).json({ error: ok.reason });
      const { call, already, membership } = await markNoShow(c, { email: lawyerEmail(req), role: "lawyer" });
      if (already) return res.status(409).json({ error: "This call is already marked as a no-show." });
      // COMMS-P4: member email (minutes, rebooking), lawyer confirmation, CSM task and bell.
      await afterNoShow(call, membership);
      res.json({ id: call.id, status: call.status, noShowAt: (call as unknown as Record<string, unknown>).noShowAt ?? null });
    }),
  );

  app.post(
    "/api/provider/consultations/:id/meet-transcript",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await ownCall(req, res);
      if (!c) return;
      if (c.consent?.recording !== "granted") {
        return res.status(409).json({ error: "The member did not agree to recording. Write the summary yourself." });
      }
      if (c.summary?.status === "confirmed") return res.status(409).json({ error: "Summary already confirmed." });
      let r: Awaited<ReturnType<typeof pullMeetTranscript>>;
      try {
        r = await pullMeetTranscript(c);
      } catch (err) {
        log(`[calls] meet transcript for ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
        return res.status(502).json({ status: "error", error: "Google did not return the transcript. Paste it or upload the recording instead." });
      }
      if (r.status !== "fetched" || !r.text) return res.json({ status: r.status, message: r.message });
      const draft = await draftSuggestion(c.id, r.text);
      res.json({ status: "fetched", source: r.source, transcript: r.text, ...(draft ?? { summary: null, suggestedNextSteps: [] }) });
    }),
  );

  app.post(
    "/api/provider/consultations/:id/upload-recording",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await ownCall(req, res);
      if (!c) return;
      if (c.consent?.recording !== "granted") {
        return res.status(409).json({ error: "The member did not agree to recording, so no recording can be stored or transcribed." });
      }
      if (!(await recordingStillAllowed(c))) {
        return res.status(409).json({ error: RECORDING_WITHDRAWN_MESSAGE });
      }
      const b64 = typeof req.body?.dataBase64 === "string" ? req.body.dataBase64.replace(/^data:[^,]*,/, "") : "";
      if (!b64) return res.status(400).json({ error: "Choose an audio file." });
      let bytes: Uint8Array;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return res.status(400).json({ error: "That file could not be read." });
      }
      if (bytes.length > MAX_AUDIO_BYTES) return res.status(413).json({ error: "The recording is over 7 MB. Upload a shorter or compressed file, or paste the transcript." });
      const name = String(req.body?.fileName || req.body?.contentType || "audio.webm");
      let transcript: string;
      try {
        transcript = await transcribeAudio(bytes, name);
      } catch (err) {
        log(`[calls] transcription for ${c.id} failed: ${err instanceof Error ? err.message : err}`, "error");
        return res.status(502).json({ error: "Transcription failed. Paste the transcript or write the summary yourself." });
      }
      // The audio itself is not stored: only its transcript, like Meet's own.
      const draft = await draftSuggestion(c.id, transcript, { saveTranscript: true, transcriptSource: "upload" });
      res.json({ status: "fetched", source: "upload", transcript, ...(draft ?? { summary: null, suggestedNextSteps: [] }) });
    }),
  );

  // ── Staff: cancel, reschedule, restore, retry the Meet link ──────────────
  async function anyCall(req: Request, res: Response): Promise<CallRecord | null> {
    const c = await getRecord<CallRecord>(COLLECTIONS.consultations, req.params.id);
    if (!c) {
      res.status(404).json({ error: "Consultation not found." });
      return null;
    }
    return c;
  }

  app.get(
    "/api/dashboard/consultations/:id/slots",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await anyCall(req, res);
      if (!c) return;
      res.json({ slots: await slotsFor(c.providerId, new Date(), c.id) });
    }),
  );

  app.post(
    "/api/dashboard/consultations/:id/cancel",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await anyCall(req, res);
      if (!c) return;
      const ok = canChange(c, new Date(), "staff");
      if (!ok.ok) return res.status(409).json({ error: ok.reason });
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
      res.json(forStaff(await cancelCall(c, { email: staffEmail(req), role: "staff" }, reason)));
    }),
  );

  app.post(
    "/api/dashboard/consultations/:id/reschedule",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await anyCall(req, res);
      if (!c) return;
      const ok = canChange(c, new Date(), "staff");
      if (!ok.ok) return res.status(409).json({ error: ok.reason });
      const iso = parseIso(req.body?.scheduledAt);
      if (!iso) return res.status(400).json({ error: "Pick a new time." });
      // Staff may place a call outside the offered slots (they talked to both sides).
      const force = req.body?.force === true;
      const moved = await moveCallIfFree(c, iso, { email: staffEmail(req), role: "staff" }, { force });
      if (!moved) return res.status(409).json({ error: "That time is not open for this lawyer. Pass force: true to book it anyway." });
      res.json(forStaff(moved));
    }),
  );

  app.post(
    "/api/dashboard/consultations/:id/restore-call",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await anyCall(req, res);
      if (!c) return;
      if (!c.chargedAt) return res.status(409).json({ error: "This call was not charged, so there is nothing to restore." });
      if (c.restoredAt) return res.status(409).json({ error: "This call was already restored." });
      const { restored, membership } = await restoreCallOnce(c, { email: staffEmail(req), role: "staff" });
      if (!restored) return res.status(409).json({ error: "This call was already restored." });
      res.json({ restored: true, membership });
    }),
  );

  app.post(
    "/api/dashboard/consultations/:id/retry-calendar",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await anyCall(req, res);
      if (!c) return;
      if (c.status !== "booked") return res.status(409).json({ error: "Only a booked call needs a link." });
      if (c.meetUrl) return res.json({ ...forStaff(c), unchanged: true });
      const after = await attachMeeting(c);
      if (after.meetUrl) await sendBookingEmails(after);
      res.json(forStaff(after));
    }),
  );

  // ── Member: change, consent, join ────────────────────────────────────────
  async function memberCall(req: Request, res: Response): Promise<CallRecord | null> {
    const clientId = (req as AuthedRequest).clientId;
    const c = await getRecord<CallRecord>(COLLECTIONS.consultations, req.params.id);
    if (!clientId || !c || c.clientId !== clientId) {
      res.status(404).json({ error: "We could not find that call." });
      return null;
    }
    return c;
  }
  const memberActor = (req: Request) => ({
    email: memberEmail(req),
    role: ((req as AuthedRequest).isIrpStaff ? "staff" : "client") as "staff" | "client",
  });

  app.get(
    "/api/client-status/me/consultations/:id/slots",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await memberCall(req, res);
      if (!c) return;
      res.json({ slots: await slotsFor(c.providerId, new Date(), c.id) });
    }),
  );

  app.post(
    "/api/client-status/me/consultations/:id/cancel",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await memberCall(req, res);
      if (!c) return;
      const actor = memberActor(req);
      const ok = canChange(c, new Date(), actor.role === "staff" ? "staff" : "member");
      if (!ok.ok) return res.status(409).json({ error: ok.reason });
      res.json({ consultation: forMember(await cancelCall(c, actor, typeof req.body?.reason === "string" ? req.body.reason : undefined)) });
    }),
  );

  app.post(
    "/api/client-status/me/consultations/:id/reschedule",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await memberCall(req, res);
      if (!c) return;
      const actor = memberActor(req);
      const ok = canChange(c, new Date(), actor.role === "staff" ? "staff" : "member");
      if (!ok.ok) return res.status(409).json({ error: ok.reason });
      const iso = parseIso(req.body?.scheduledAt);
      if (!iso) return res.status(400).json({ error: "Pick a new time." });
      const moved = await moveCallIfFree(c, iso, actor);
      if (!moved) return res.status(409).json({ error: "That time was just taken. Please pick another." });
      res.json({ consultation: forMember(moved) });
    }),
  );

  app.post(
    "/api/client-status/me/consultations/:id/consent",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await memberCall(req, res);
      if (!c) return;
      const recording = req.body?.recording;
      if (recording !== "granted" && recording !== "declined") return res.status(400).json({ error: "Choose yes or no." });
      if (c.status !== "booked" && c.status !== "in_progress") return res.status(409).json({ error: "This call is over." });
      const where = req.body?.where === "join" ? "join" : "booking";
      res.json({ consultation: forMember(await setConsent(c, recording, memberActor(req), where)) });
    }),
  );

  app.get(
    "/api/client-status/me/consultations/:id/join",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await memberCall(req, res);
      if (!c) return;
      res.json({ ...forMember(c), open: joinOpen(c, new Date()) });
    }),
  );
}

function parseIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
