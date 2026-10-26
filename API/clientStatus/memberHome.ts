/**
 * API/clientStatus/memberHome.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Member home routes for the client portal (W4). Every route is scoped to the
 * session's clientId (staff previewing pass ?clientId=, per W1). Responses go
 * through the router's CLIENT_HIDDEN_FIELDS strip as well as forClient().
 *
 *   GET   /api/client-status/me/home                    overview bundle
 *   GET   /api/client-status/me/slots?matterId=         bookable 20-min slots
 *   POST  /api/client-status/me/consultations           { scheduledAt, question, matterId?, recordingConsent? } (P3: Meet link, emails)
 *   (P3 cancel / reschedule / consent / join routes live in API/calls/callsRouter.ts)
 *   POST  /api/client-status/me/obligations/:id/ask     "Ask my lawyer" → question for the next call
 *   PATCH /api/client-status/me/profile                 { values: { field: value } } (PROFILE_FIELDS only)
 *   GET   /api/client-status/me/documents               metadata list
 *   POST  /api/client-status/me/documents               raw file body + ?matterId&category&fileName (or legacy JSON dataBase64)
 *   GET   /api/client-status/me/documents/:id/file      download (audited; private bucket, see helper/storage.ts)
 *   GET   /api/client-status/me/money                   balance, charges, quotes (no cost/margin)
 *   POST  /api/client-status/me/quotes/:id/accept       { fullName, consent: true }
 *   GET   /api/client-status/me/messages                team + AI thread
 *   POST  /api/client-status/me/messages                { body } → team
 *   POST  /api/client-status/me/lily                    { message } → AI assistant
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import { type AuthedRequest, requireClientAuth } from "../../helper/auth/session.ts";
import {
  COLLECTIONS,
  type ConsentRecord,
  type Consultation,
  type Matter,
  type Obligation,
  PLAN_STANDARD,
  PROFILE_FIELDS,
  PROFILE_SECTIONS,
} from "../../schemas/contracts.ts";
import {
  clientView,
  createRecord,
  findRecords,
  forClient,
  getRecord,
  memberBundle,
  nowIso,
  profileRecord,
  updateRecord,
  withDefaults,
} from "../members/service.ts";
import { emitEvent, onRecordUpdated } from "../members/events.ts";
import {
  ensureStageConfig,
  getClientVisibleStageDetails,
  resolveClientDisplayStage,
} from "../dashboard/automation/stageConfig.ts";
import { chatWithLily } from "../chatbot/services/lilyChatEngine.ts";
import { aiAssistantAllowed } from "../privacy/privacyRouter.ts";
import { AI_CONSENT_REQUIRED, bookingRecordingConsent } from "../privacy/policy.ts";
import { syncOpportunitiesForQuote } from "../opportunities/opportunitiesRouter.ts";
import auditLog from "../../helper/auditLog.ts";
import {
  auditDocumentDownload,
  DOCUMENTS_COLLECTION,
  documentMeta,
  rawDocumentBody,
  readMemberDocument,
  safeFileName,
  sendDocument,
  storeMemberDocument,
  uploadBytes,
} from "../../helper/storage.ts";
import { attachMeeting, type CallRecord, peopleFor, routeLawyer, sendBookingEmails, slotsFor } from "../calls/callService.ts";
import { canChange } from "../calls/callLogic.ts";
import {
  bookingCapacity,
  coerceProfileValue,
  mergeThread,
  moneyView,
  nextStepFor,
} from "./memberLogic.ts";

const CLIENTS = "clients";
const DOCUMENTS = DOCUMENTS_COLLECTION;
export const DOCUMENT_CATEGORIES = [
  "identity",
  "residency",
  "property",
  "company",
  "vehicle",
  "tax",
  "other",
] as const;

const EDITABLE_PROFILE_KEYS = new Set(
  PROFILE_SECTIONS.flatMap((s) => PROFILE_FIELDS[s]).filter((k) => k !== "email"),
);

type Doc = Record<string, unknown>;

function clientIdOf(req: Request, res: Response): string | null {
  const id = (req as AuthedRequest).clientId;
  if (!id) {
    res.status(400).json({ error: "No member selected for this session." });
    return null;
  }
  return id;
}

const isStaff = (req: Request) => !!(req as AuthedRequest).isIrpStaff;
const actor = (req: Request) => String((req as AuthedRequest).clientUser ?? "");

function memberName(doc: Doc | null): string {
  const n = [doc?.name, doc?.surname].filter((x) => typeof x === "string" && x).join(" ");
  return n || "You";
}

async function providerName(id?: string): Promise<string | null> {
  if (!id) return null;
  const p = await get("providers", id).catch(() => null) as Doc | null;
  return typeof p?.name === "string" ? p.name : null;
}

/** Upcoming consultations still counting against this month's allowance. */
function upcoming(cons: Consultation[]): Consultation[] {
  return cons.filter((c) => c.status === "booked" || c.status === "in_progress");
}

/**
 * Lily's engine writes the thread with a full-document replace (db/put). Until
 * that is fixed at the source, re-apply the rest of the client doc after a
 * Lily turn so a chat message can never wipe the member's record.
 */
async function chatPreservingDoc(clientId: string, message: string, email: string, staff: boolean) {
  const before = (await get(CLIENTS, clientId)) as Doc | null;
  const { reply } = await chatWithLily(clientId, "status", message, email, staff ? "staff" : "client");
  const after = (await get(CLIENTS, clientId)) as Doc | null;
  if (before && after) {
    const missing = Object.keys(before).filter((k) => !(k in after));
    if (missing.length) {
      const restore: Doc = {};
      for (const k of missing) restore[k] = before[k];
      await patch(CLIENTS, clientId, restore);
      log(`[member-home] restored ${missing.length} client fields after Lily turn on ${clientId}`);
    }
  }
  return reply;
}

export function registerMemberHomeRoutes(app: Express) {
  // ── Overview ─────────────────────────────────────────────────────────────
  app.get(
    "/api/client-status/me/home",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const [bundle] = await Promise.all([memberBundle(id), ensureStageConfig()]);
      if (!bundle.client) return res.status(404).json({ error: "We could not find your membership record." });
      const stages = getClientVisibleStageDetails();
      const lawyers = new Map<string, string | null>();
      for (const m of bundle.matters) {
        if (m.assignedProviderId && !lawyers.has(m.assignedProviderId)) {
          lawyers.set(m.assignedProviderId, await providerName(m.assignedProviderId));
        }
      }
      for (const c of upcoming(bundle.consultations)) {
        if (c.providerId && !lawyers.has(c.providerId)) lawyers.set(c.providerId, await providerName(c.providerId));
      }
      const matters = bundle.matters.map((m) => ({
        id: m.id,
        title: m.title,
        area: m.area,
        stage: resolveClientDisplayStage(m.stage),
        stageEnteredAt: m.stageEnteredAt,
        openedAt: m.openedAt,
        closedAt: m.closedAt,
        lawyerName: m.assignedProviderId ? lawyers.get(m.assignedProviderId) ?? null : null,
        nextStep: nextStepFor(m, bundle.handoffs),
      }));
      // A member without any matter still gets a next step from the latest handoff.
      const general = matters.length ? null : nextStepFor(null, bundle.handoffs);
      const capacity = bookingCapacity(bundle.membership, bundle.consultations);
      const profile = profileRecord(bundle.client);
      const view = clientView(bundle);
      res.json(forClient({
        member: {
          id,
          name: memberName(bundle.client),
          firstName: typeof bundle.client.name === "string" ? bundle.client.name : "",
          email: bundle.client.email ?? null,
        },
        membership: view.membership,
        capacity,
        matters,
        generalNextStep: general,
        stages,
        upcomingCalls: upcoming(bundle.consultations)
          .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
          .map((c) => ({
            id: c.id,
            matterId: c.matterId,
            scheduledAt: c.scheduledAt,
            durationMin: c.durationMin,
            question: c.question,
            lawyerName: lawyers.get(c.providerId) ?? null,
            // P3: the call itself
            status: c.status,
            meetUrl: c.meetUrl ?? null,
            linkPending: !c.meetUrl,
            consent: c.consent ?? { recording: "pending" },
            canChange: canChange(c, new Date(), "member").ok,
          })),
        pastCalls: view.consultations
          .filter((c) => c.status === "completed")
          .slice(0, 5)
          .map((c) => ({ id: c.id, matterId: c.matterId, scheduledAt: c.scheduledAt, minutesUsed: c.minutesUsed, summary: c.summary?.text })),
        obligations: bundle.obligations.filter((o) => o.status === "upcoming" || o.status === "asked"),
        completeness: bundle.completeness,
        profile: Object.fromEntries(
          PROFILE_SECTIONS.flatMap((s) => PROFILE_FIELDS[s]).map((k) => [k, profile[k] ?? null]),
        ),
        pendingQuestions: Array.isArray(bundle.client.pendingQuestions) ? bundle.client.pendingQuestions : [],
      }));
    }),
  );

  // ── Booking (P3: availability, routing, Google Meet) ─────────────────────
  // Slots = the lawyer's weekly windows − blackout dates − booked calls −
  // Google Calendar busy times, with lead time and a daily cap (calls/callLogic.ts).
  // Lawyer = matter's, else client's, else specialty match, else DEFAULT_PROVIDER_ID.

  app.get(
    "/api/client-status/me/slots",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const providerId = await routeLawyer(id, req.query.matterId as string | undefined);
      if (!providerId) return res.json({ slots: [], lawyerName: null, reason: "No lawyer is assigned yet. Your ILP team will set one up and contact you." });
      const slots = await slotsFor(providerId);
      res.json({ slots, lawyerName: await providerName(providerId), lengthMin: PLAN_STANDARD.callLengthMin });
    }),
  );

  app.post(
    "/api/client-status/me/consultations",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const { scheduledAt, question, matterId, recordingConsent } = (req.body ?? {}) as Record<string, unknown>;
      const when = typeof scheduledAt === "string" ? new Date(scheduledAt) : null;
      if (!when || Number.isNaN(when.getTime())) return res.status(400).json({ error: "Pick a time for the call." });
      const q = typeof question === "string" ? question.trim().slice(0, 1000) : "";
      if (!q) return res.status(400).json({ error: "Tell us what you would like to ask." });
      // P7: with no answer on the form, a member who withdrew recording on
      // /status/privacy books with recording declined.
      const consentRows = (await query(COLLECTIONS.consents, [{ field: "clientId", op: "EQUAL", value: id }]).catch(() => [])) as unknown as ConsentRecord[];
      const consent = bookingRecordingConsent(recordingConsent, consentRows);

      const bundle = await memberBundle(id);
      const cap = bookingCapacity(bundle.membership, bundle.consultations);
      if (!cap.canBook) return res.status(409).json({ error: cap.reason, capacity: cap });

      const mId = typeof matterId === "string" && bundle.matters.some((m) => m.id === matterId) ? matterId : undefined;
      const providerId = await routeLawyer(id, mId);
      if (!providerId) return res.status(409).json({ error: "No lawyer is assigned yet. Your ILP team will contact you to set one up." });

      // The slot must be one we offer and still free.
      const iso = when.toISOString();
      const offered = await slotsFor(providerId);
      if (!offered.includes(iso)) return res.status(409).json({ error: "That time was just taken. Please pick another." });

      const pending = Array.isArray(bundle.client?.pendingQuestions) ? bundle.client!.pendingQuestions as string[] : [];
      const fullQuestion = pending.length ? `${q}\n\nAlso on my list:\n- ${pending.join("\n- ")}` : q;
      const record = withDefaults("consultations", {
        clientId: id,
        matterId: mId,
        providerId,
        scheduledAt: iso,
        durationMin: PLAN_STANDARD.callLengthMin,
        question: fullQuestion,
        bookedBy: actor(req),
        consent: consent === "pending"
          ? { recording: "pending" }
          : { recording: consent, at: nowIso(), by: "client", where: recordingConsent === consent ? "booking" : "privacy_page" },
      });
      const created = await createRecord(COLLECTIONS.consultations, record);
      if (pending.length) await patch(CLIENTS, id, { pendingQuestions: [] });
      await emitEvent("consultation.booked", { clientId: id, matterId: mId, sourceId: created.id, detail: memberName(bundle.client) });
      log(`[member-home] consultation ${created.id} booked for ${id} at ${iso}`);
      // Google Meet: never fails the booking. On error the CSM gets a task and the member sees "link coming by email".
      const people = await peopleFor(created as unknown as CallRecord);
      const withMeet = await attachMeeting(created as unknown as CallRecord, people);
      await sendBookingEmails(withMeet, people);
      const after = bookingCapacity(bundle.membership, [...bundle.consultations, created as unknown as Consultation]);
      res.status(201).json(forClient({
        consultation: {
          ...created,
          transcript: undefined,
          meetUrl: withMeet.meetUrl ?? null,
          calendarEventId: undefined,
          calendarError: undefined,
          linkPending: !withMeet.meetUrl,
        },
        capacity: after,
      }));
    }),
  );

  // ── Obligations: "Ask my lawyer" ─────────────────────────────────────────
  app.post(
    "/api/client-status/me/obligations/:oid/ask",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const o = await getRecord<Obligation>(COLLECTIONS.obligations, req.params.oid);
      if (!o || o.clientId !== id) return res.status(404).json({ error: "Not found." });
      const text = `Does this apply to me: ${o.title}?`;
      const after = await updateRecord<Obligation>(COLLECTIONS.obligations, o.id, { status: "asked", askedAt: nowIso() });
      if (after) {
        await onRecordUpdated("obligations", o as unknown as Doc, after as unknown as Doc, { actor: actor(req) });
      }
      // Attach to the next booked call, else keep it for the next booking.
      const cons = await findRecords<Consultation>(COLLECTIONS.consultations, { clientId: id, status: "booked" }, { sortBy: "scheduledAt" });
      const next = cons.find((c) => c.scheduledAt >= nowIso());
      let addedTo: "call" | "list";
      if (next) {
        const q = next.question ? `${next.question}\n- ${text}` : text;
        await updateRecord(COLLECTIONS.consultations, next.id, { question: q });
        addedTo = "call";
      } else {
        const client = (await get(CLIENTS, id)) as Doc | null;
        const list = Array.isArray(client?.pendingQuestions) ? client!.pendingQuestions as string[] : [];
        if (!list.includes(text)) await patch(CLIENTS, id, { pendingQuestions: [...list, text].slice(-10) });
        addedTo = "list";
      }
      res.json(forClient({ obligation: after, addedTo, callAt: next?.scheduledAt ?? null }));
    }),
  );

  // ── Profile ──────────────────────────────────────────────────────────────
  app.patch(
    "/api/client-status/me/profile",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const values = (req.body?.values ?? {}) as Doc;
      const updates: Doc = {};
      for (const [k, v] of Object.entries(values)) {
        if (EDITABLE_PROFILE_KEYS.has(k)) updates[k] = coerceProfileValue(v);
      }
      if (!Object.keys(updates).length) return res.status(400).json({ error: "Nothing to save." });
      const client = (await get(CLIENTS, id)) as Doc | null;
      if (!client) return res.status(404).json({ error: "Not found." });
      const clientFields = { ...((client.clientFields as Doc) ?? {}), ...updates };
      // Top level and clientFields both, so profileRecord() reads the new value
      // whichever place older code wrote it.
      await patch(CLIENTS, id, { ...updates, clientFields, updatedAt: nowIso() });
      const bundle = await memberBundle(id);
      res.json({ completeness: bundle.completeness });
    }),
  );

  // ── Documents (P1: private storage, see helper/storage.ts) ──────────────
  app.get(
    "/api/client-status/me/documents",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const docs = await query(DOCUMENTS, [{ field: "clientId", op: "EQUAL", value: id }]);
      const items = (docs as Doc[])
        .map(documentMeta)
        .sort((a, b) => String(b.uploadedAt ?? "").localeCompare(String(a.uploadedAt ?? "")));
      res.json({ items: forClient(items), categories: DOCUMENT_CATEGORIES });
    }),
  );

  /**
   * Upload one file. Preferred: the raw file as the body (Content-Type = the
   * file's type) with ?matterId=&category=&fileName= in the query (15 MB).
   * Legacy: JSON { matterId, category, fileName, dataBase64 } (smaller files).
   * The stored type comes from the file's bytes (pdf, jpg, png, heic, docx).
   */
  app.post(
    "/api/client-status/me/documents",
    requireClientAuth,
    rawDocumentBody,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const isJson = !(req.body instanceof Uint8Array);
      const input = (isJson ? req.body ?? {} : req.query ?? {}) as Record<string, unknown>;
      const { matterId, category, fileName } = input;
      const bytes = uploadBytes(req.body);
      if (!bytes) return res.status(400).json({ error: "Choose a file to upload." });
      const cat = DOCUMENT_CATEGORIES.includes(category as typeof DOCUMENT_CATEGORIES[number]) ? String(category) : "other";
      let mId: string | undefined;
      if (typeof matterId === "string" && matterId) {
        const m = await getRecord<Matter>(COLLECTIONS.matters, matterId);
        if (!m || m.clientId !== id) return res.status(404).json({ error: "Matter not found." });
        mId = m.id;
      }
      const docId = `doc_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`;
      const stored = await storeMemberDocument(id, docId, bytes);
      if (!stored.ok) return res.status(stored.status).json({ error: stored.error });
      const meta = {
        id: docId,
        clientId: id,
        ...(mId ? { matterId: mId } : {}),
        category: cat,
        fileName: safeFileName(fileName, stored.contentType),
        contentType: stored.contentType,
        size: stored.size,
        uploadedAt: nowIso(),
        uploadedBy: actor(req),
      };
      await put(DOCUMENTS, docId, { ...meta, ...stored.fields });
      auditLog({
        actor: { uid: actor(req), email: actor(req), role: isStaff(req) ? "staff" : "client" },
        action: "document.upload",
        target: `clients/${id}`,
        meta: { docId, category: cat, size: stored.size, storage: stored.fields.storage },
      }).catch(() => {});
      log(`[member-home] document ${docId} (${cat}, ${stored.size} B, ${stored.fields.storage}) uploaded for ${id}`);
      res.status(201).json(forClient(meta));
    }),
  );

  app.get(
    "/api/client-status/me/documents/:docId/file",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const d = (await get(DOCUMENTS, req.params.docId)) as Doc | null;
      if (!d || d.clientId !== id) return res.status(404).json({ error: "Not found." });
      const bytes = await readMemberDocument(d);
      if (!bytes) return res.status(404).json({ error: "Not found." });
      await auditDocumentDownload(
        { email: actor(req), role: isStaff(req) ? "staff" : "client" },
        { ...d, id: req.params.docId },
        isStaff(req) ? "staff" : "member",
      );
      sendDocument(res, d, bytes);
    }),
  );

  // ── Money ────────────────────────────────────────────────────────────────
  app.get(
    "/api/client-status/me/money",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const doc = (await get(CLIENTS, id)) as Doc | null;
      if (!doc) return res.status(404).json({ error: "Not found." });
      res.json(forClient(moneyView(doc)));
    }),
  );

  app.post(
    "/api/client-status/me/quotes/:qid/accept",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      if (isStaff(req)) return res.status(403).json({ error: "Only the member can accept a proposal." });
      const fullName = String(req.body?.fullName ?? "").trim();
      if (req.body?.consent !== true) return res.status(400).json({ error: "Please confirm you agree to the proposal." });
      if (!fullName) return res.status(400).json({ error: "Type your full name to accept." });
      const doc = (await get(CLIENTS, id)) as Doc | null;
      if (!doc) return res.status(404).json({ error: "Not found." });
      const quotes = Array.isArray(doc.quotes) ? doc.quotes as Doc[] : [];
      const target = quotes.find((q) => q.id === req.params.qid);
      if (!target) return res.status(404).json({ error: "Proposal not found." });
      if (target.status === "accepted") return res.status(409).json({ error: "You already accepted this proposal." });
      if (!["sent", "received"].includes(String(target.status))) {
        return res.status(409).json({ error: "This proposal can no longer be accepted. Ask your team for an update." });
      }
      const at = nowIso();
      const email = actor(req);
      const view = moneyView({ quotes: [target] }).quotes[0];
      const updated = quotes.map((q) =>
        q.id === target.id
          ? { ...q, status: "accepted", acceptedAt: at, acceptedBy: email, typedFullName: fullName, consent: true, consentAt: at }
          : q
      );
      const charges = Array.isArray(doc.charges) ? doc.charges as Doc[] : [];
      const charge = view?.totalCents
        ? [{ id: `ch_quote_${target.id}`, label: view.title, amountMinor: view.totalCents, currency: view.currency, status: "pending", createdAt: at, quoteId: target.id }]
        : [];
      await patch(CLIENTS, id, {
        quotes: updated,
        charges: [...charges.filter((c) => c.id !== `ch_quote_${target.id}`), ...charge],
        quoteAcceptance: { quoteId: target.id, acceptedAt: at, acceptedBy: email, typedFullName: fullName, consent: true, consentAt: at },
        ...(doc.stage === "quote_sent" ? { stage: "quote_accepted", stageEnteredAt: at } : {}),
        updatedAt: at,
      });
      log(`[member-home] quote ${target.id} accepted by ${email} on ${id}`);
      // P5/P7: linked opportunities move to won now, not on the next staff read (never throws).
      await syncOpportunitiesForQuote(id, String(target.id));
      res.json(forClient(moneyView({ ...doc, quotes: updated, charges: [...charges, ...charge] })));
    }),
  );

  // ── Messages ─────────────────────────────────────────────────────────────
  app.get(
    "/api/client-status/me/messages",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const doc = (await get(CLIENTS, id)) as Doc | null;
      if (!doc) return res.status(404).json({ error: "Not found." });
      res.json({ items: mergeThread(doc, memberName(doc)) });
    }),
  );

  app.post(
    "/api/client-status/me/messages",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const body = String(req.body?.body ?? "").trim().slice(0, 4000);
      if (!body) return res.status(400).json({ error: "Write a message first." });
      const doc = (await get(CLIENTS, id)) as Doc | null;
      if (!doc) return res.status(404).json({ error: "Not found." });
      const existing = Array.isArray(doc.statusComments) ? doc.statusComments as Doc[] : [];
      const comment = {
        id: `cmt_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`,
        author: actor(req),
        authorType: isStaff(req) ? "staff" : "client",
        body,
        createdAt: nowIso(),
      };
      await patch(CLIENTS, id, { statusComments: [...existing, comment] });
      res.status(201).json({ items: mergeThread({ ...doc, statusComments: [...existing, comment] }, memberName(doc)) });
    }),
  );

  app.post(
    "/api/client-status/me/lily",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const message = String(req.body?.message ?? "").trim().slice(0, 2000);
      if (!message) return res.status(400).json({ error: "Write a question first." });
      // P7: members need a granted, not withdrawn, ai_assistant consent.
      if (!isStaff(req) && !(await aiAssistantAllowed(id))) return res.status(403).json(AI_CONSENT_REQUIRED);
      await chatPreservingDoc(id, message, actor(req), isStaff(req));
      const doc = (await get(CLIENTS, id)) as Doc | null;
      res.json({ items: mergeThread(doc ?? {}, memberName(doc)) });
    }),
  );
}
