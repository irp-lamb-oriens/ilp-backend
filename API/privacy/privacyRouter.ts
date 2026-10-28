/**
 * API/privacy/privacyRouter.ts — consents, data rights, CSP reports (P6).
 * Registered from main.ts with one line: `privacyRouter(app)`.
 *
 * Public
 *   POST /api/csp-report                         CSP violation reports (cspReport.ts)
 *   GET  /api/privacy/versions                   current legal document versions
 *   POST /api/privacy/consents/join              { joinToken, consents:[{kind, granted}] }
 *                                                legacy: POST /api/payments/join now records these itself
 *                                                (P7); idempotent, so a second call writes nothing
 * Member (client session; a staff session may read but never decide for a member)
 *   GET  /api/privacy/me                         current consents, requests, versions
 *   POST /api/privacy/me/consents                { kind, granted, source, version?, consultationId? }
 *   GET  /api/privacy/me/export                  JSON download of the member's data (exportData.ts)
 *   POST /api/privacy/me/requests                { kind: access|rectify|delete|restrict, note? }
 * Staff (dashboard session, admin role)
 *   GET  /api/dashboard/privacy/requests?status=open|all
 *   POST /api/dashboard/privacy/requests/:id/status   { status: in_review|completed|refused, note? }
 *   GET  /api/dashboard/privacy/requests/:id/plan     dry run of the deletion matrix
 *   POST /api/dashboard/privacy/requests/:id/erase    { confirmEmail } runs the deletion (kind delete)
 *   GET  /api/dashboard/privacy/members/:clientId/export
 *   GET  /api/dashboard/privacy/members/:clientId/consents
 *
 * Every write is in audit_log (privacy.*). A request opens a CSM task
 * (owner PRIVACY_OWNER_EMAIL, else DEFAULT_CSM_EMAIL) and sends the member an
 * acknowledgement email with the response date.
 */

import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../../helper/asyncHandler.ts";
import auditLog from "../../helper/auditLog.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import query from "../../db/query.ts";
import { type AuthedRequest, requireClientAuth, requireDashboardAuth } from "../../helper/auth/session.ts";
import { requireStaffRole } from "../../helper/auth/roles.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { memberEmailLayout } from "../../helper/emailTemplates.ts";
import { sanitizeStr } from "../../helper/sanitize.ts";
import { apiUrl, siteUrl } from "../retention/mailer.ts";
import { readJoinSession } from "../payments/membership.ts";
import { emitEvent, taskIdFor } from "../members/events.ts";
import {
  COLLECTIONS,
  type ConsentRecord,
  type PrivacyRequest,
  type PrivacyRequestKind,
} from "../../schemas/contracts.ts";
import {
  businessDaysFrom,
  consentId,
  ERASURE_MANUAL_STEPS,
  type JoinConsents,
  joinConsentsToWrite,
  LEGAL_VERSIONS,
  aiAssistantGranted,
  latestConsents,
  parseConsentInput,
  parseJoinConsents,
  privacyRequestId,
  privacyTaskEvent,
  REQUEST_LABEL,
  responseDays,
  VERSION_FOR_KIND,
  WITHDRAWABLE,
} from "./policy.ts";
import { buildExport, loadExportBundle } from "./exportData.ts";
import { erasureBlocker, firestoreStore, planErasure, runErasure, subjectFor } from "./erasure.ts";
import { registerCspReport } from "./cspReport.ts";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import { fieldValue, LIST_SCHEMAS } from "../../schemas/listSchemas.ts";

type Doc = Record<string, unknown>;
const env = (k: string) => Deno.env.get(k);
const nowIso = () => new Date().toISOString();

// ─── Helpers ──────────────────────────────────────────────────────────────

export async function writeConsent(c: Omit<ConsentRecord, "id" | "at"> & { consultationId?: string }): Promise<ConsentRecord> {
  const rec = { ...c, id: consentId(), at: nowIso() } as ConsentRecord & { consultationId?: string };
  if (!rec.consultationId) delete rec.consultationId;
  if (!rec.clientId) delete rec.clientId;
  await put(COLLECTIONS.consents, rec.id, rec as unknown as Doc);
  return rec;
}

async function consentsOf(clientId: string): Promise<ConsentRecord[]> {
  const rows = await query(COLLECTIONS.consents, [{ field: "clientId", op: "EQUAL", value: clientId }]).catch(() => []);
  return rows as unknown as ConsentRecord[];
}

/**
 * Write the join consents (Terms, Privacy, optional marketing) for a new
 * member, skipping any already recorded with the same answer and version, and
 * mirror the marketing choice on the client. Called inside POST
 * /api/payments/join (P7) and by the legacy /api/privacy/consents/join route.
 */
export async function recordJoinConsents(
  who: { clientId: string; email: string },
  want: JoinConsents,
): Promise<ConsentRecord[]> {
  const todo = joinConsentsToWrite(want, await consentsOf(who.clientId));
  const written: ConsentRecord[] = [];
  for (const c of todo) {
    written.push(await writeConsent({ clientId: who.clientId, email: who.email, kind: c.kind, granted: c.granted, version: c.version, source: c.source }));
  }
  if (!written.length) return written;
  const mk = written.find((w) => w.kind === "marketing_email");
  if (mk) {
    await patch(COLLECTIONS.clients, who.clientId, { marketingEmailConsent: mk.granted, marketingEmailConsentAt: mk.at }).catch(() => undefined);
  }
  await auditLog({
    actor: memberActor(who.clientId, who.email),
    action: "privacy.consents_recorded",
    target: `clients/${who.clientId}`,
    meta: { source: want.terms.source, kinds: written.map((w) => `${w.kind}:${w.granted ? "yes" : "no"}`), versions: written.map((w) => w.version) },
  });
  return written;
}

/** True when the member's newest ai_assistant consent is granted (fails closed on a read error). */
export async function aiAssistantAllowed(clientId: string): Promise<boolean> {
  if (!clientId) return false;
  try {
    const rows = await query(COLLECTIONS.consents, [{ field: "clientId", op: "EQUAL", value: clientId }]);
    return aiAssistantGranted(rows as unknown as ConsentRecord[]);
  } catch {
    return false;
  }
}

async function requestsOf(clientId: string): Promise<PrivacyRequest[]> {
  const rows = await query(COLLECTIONS.privacyRequests, [{ field: "clientId", op: "EQUAL", value: clientId }]).catch(() => []);
  return (rows as unknown as PrivacyRequest[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function member(req: Request) {
  const r = req as AuthedRequest;
  return { clientId: r.clientId ?? "", email: String(r.clientUser ?? "").toLowerCase(), staff: !!r.isIrpStaff };
}

const memberActor = (clientId: string, email: string) => ({ uid: clientId, email, role: "client" });
const staffActor = (req: Request) => {
  const r = req as AuthedRequest;
  return { uid: r.dashboardUser ?? "staff", email: r.dashboardUser ?? "staff", role: r.dashboardRole ?? "staff" };
};

async function memberEmailOf(clientId: string, fallback: string): Promise<{ email: string; firstName?: string; client: Doc | null }> {
  const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
  const email = String(client?.email ?? fallback ?? "").trim().toLowerCase();
  const name = String(client?.name ?? client?.fullName ?? "").trim();
  return { email, firstName: name ? name.split(/\s+/)[0] : undefined, client };
}

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Costa_Rica" });

function sendPrivacyEmail(to: string, firstName: string | undefined, subject: string, paragraphs: string[], key: string): void {
  if (!to) return;
  const mail = memberEmailLayout({
    subject,
    firstName,
    paragraphs,
    cta: { label: "Your data and privacy", url: `${siteUrl()}/status/privacy` },
  });
  enqueueEmail({ to, subject: mail.subject, html: mail.html, text: mail.text }, key.replace(/[^A-Za-z0-9_-]/g, "_"))
    .catch((err) => log(`[privacy] email ${key} not queued: ${err instanceof Error ? err.message : err}`, "error"));
}

/** CSM task for a privacy request: TASK_RULES "privacy.request_received" through emitEvent (idempotent per request). */
async function openPrivacyTask(r: PrivacyRequest): Promise<string | null> {
  const ids = await emitEvent("privacy.request_received", privacyTaskEvent(r, env, new Date(), dayLabel));
  return ids[0] ?? null;
}

async function closePrivacyTask(requestId: string, clientId: string, outcome: string): Promise<void> {
  const id = taskIdFor("privacy.request_received", { clientId, sourceId: requestId });
  const task = await get(COLLECTIONS.csmTasks, id).catch(() => null);
  if (!task || (task as Doc).status !== "open") return;
  await patch(COLLECTIONS.csmTasks, id, { status: "done", outcome, closedAt: nowIso() }).catch(() => undefined);
}

/** Withdrawing recording consent applies to calls not yet held. */
async function declineUpcomingRecordings(clientId: string): Promise<number> {
  const rows = (await query(COLLECTIONS.consultations, [{ field: "clientId", op: "EQUAL", value: clientId }]).catch(() => [])) as Doc[];
  const now = Date.now();
  let n = 0;
  for (const c of rows) {
    if (c.status !== "booked" || Date.parse(String(c.scheduledAt)) < now) continue;
    await patch(COLLECTIONS.consultations, String(c.id), {
      consent: { recording: "declined", at: nowIso(), by: "member", where: "privacy_page" },
    });
    n++;
  }
  return n;
}

const joinLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "Too many requests. Try again in a few minutes." },
});

const exportLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: "You downloaded your data several times this hour. Try again later." },
});

// ─── Routes ───────────────────────────────────────────────────────────────

export default function privacyRouter(app: Express): void {
  registerCspReport(app);

  app.get("/api/privacy/versions", (_req: Request, res: Response) => {
    res.json({ versions: LEGAL_VERSIONS });
  });

  app.post(
    "/api/privacy/consents/join",
    joinLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const token = typeof req.body?.joinToken === "string" ? req.body.joinToken : "";
      const session = await readJoinSession(token);
      if (!session) return res.status(404).json({ error: "This sign-up link has expired. Start again from /join." });
      const want = parseJoinConsents({ consents: Array.isArray(req.body?.consents) ? req.body.consents : [] });
      if ("error" in want) return res.status(400).json({ error: want.error });
      const written = await recordJoinConsents({ clientId: session.clientId, email: session.email }, want);
      res.status(201).json({ recorded: written.length });
    }),
  );

  app.get(
    "/api/privacy/me",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId } = member(req);
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      const [consents, requests] = await Promise.all([consentsOf(clientId), requestsOf(clientId)]);
      const latest = latestConsents(consents);
      res.json({
        versions: LEGAL_VERSIONS,
        consents: Object.fromEntries(
          Object.entries(latest).map(([k, r]) => [k, { granted: r!.granted, at: r!.at, version: r!.version, source: r!.source }]),
        ),
        requests: requests.map((r) => ({ id: r.id, kind: r.kind, status: r.status, dueAt: r.dueAt, createdAt: r.createdAt, completedAt: r.completedAt })),
        responseDays: responseDays(env),
      });
    }),
  );

  app.post(
    "/api/privacy/me/consents",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId, email, staff } = member(req);
      if (staff) return res.status(403).json({ error: "Only the member can give or withdraw consent." });
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      const c = parseConsentInput((req.body ?? {}) as Doc);
      if ("error" in c) return res.status(400).json({ error: c.error });
      if (!c.granted && !WITHDRAWABLE.includes(c.kind)) {
        return res.status(400).json({ error: "To withdraw from the Terms or the Privacy Policy, ask us to delete your account." });
      }
      const rec = await writeConsent({ clientId, email, kind: c.kind, granted: c.granted, version: c.version, source: c.source, consultationId: c.consultationId });
      const updated = c.kind === "recording" && !c.granted && c.source !== "booking" && c.source !== "join_call"
        ? await declineUpcomingRecordings(clientId)
        : 0;
      if (c.kind === "marketing_email") {
        await patch(COLLECTIONS.clients, clientId, { marketingEmailConsent: c.granted, marketingEmailConsentAt: rec.at }).catch(() => undefined);
      }
      await auditLog({
        actor: memberActor(clientId, email),
        action: c.granted ? "privacy.consent_granted" : "privacy.consent_withdrawn",
        target: `clients/${clientId}`,
        meta: { kind: c.kind, version: c.version, source: c.source, consultationId: c.consultationId ?? null, upcomingCallsUpdated: updated },
      });
      res.status(201).json({ consent: { kind: rec.kind, granted: rec.granted, at: rec.at, version: rec.version }, upcomingCallsUpdated: updated });
    }),
  );

  app.get(
    "/api/privacy/me/export",
    requireClientAuth,
    exportLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId, email, staff } = member(req);
      if (staff) return res.status(403).json({ error: "Staff export a member's data from the privacy requests page." });
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      const bundle = await loadExportBundle(clientId, email);
      const now = new Date();
      const name = String(bundle.client?.name ?? "You");
      const body = buildExport(bundle, {
        now,
        memberName: name,
        documentUrl: (id) => `${apiUrl()}/api/client-status/me/documents/${encodeURIComponent(id)}/file`,
      });
      const reqId = privacyRequestId();
      const pr: PrivacyRequest = { id: reqId, clientId, email, kind: "export", status: "completed", dueAt: now.toISOString(), createdAt: now.toISOString(), completedAt: now.toISOString() };
      await put(COLLECTIONS.privacyRequests, reqId, pr as unknown as Doc);
      await auditLog({ actor: memberActor(clientId, email), action: "privacy.export_downloaded", target: `clients/${clientId}`, meta: { requestId: reqId } });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="ilp-my-data-${now.toISOString().slice(0, 10)}.json"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(JSON.stringify(body, null, 2));
    }),
  );

  app.post(
    "/api/privacy/me/requests",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { clientId, email, staff } = member(req);
      if (staff) return res.status(403).json({ error: "Only the member can make a privacy request." });
      if (!clientId) return res.status(400).json({ error: "No member selected for this session." });
      const kind = req.body?.kind as PrivacyRequestKind;
      if (!["access", "rectify", "delete", "restrict"].includes(kind)) return res.status(400).json({ error: "Choose a request type." });
      const note = sanitizeStr(req.body?.note).slice(0, 2000);
      if ((kind === "rectify" || kind === "restrict") && !note) {
        return res.status(400).json({ error: kind === "rectify" ? "Tell us what is wrong and what it should say." : "Tell us which use of your data you object to." });
      }
      const open = (await requestsOf(clientId)).find((r) => r.kind === kind && (r.status === "received" || r.status === "in_review"));
      if (open) return res.json({ request: open, existing: true });

      const now = new Date();
      const dueAt = businessDaysFrom(now, responseDays(env)).toISOString();
      const pr: PrivacyRequest = { id: privacyRequestId(), clientId, email, kind, status: "received", dueAt, createdAt: now.toISOString() };
      if (note) pr.note = note;
      await put(COLLECTIONS.privacyRequests, pr.id, pr as unknown as Doc);
      const taskId = await openPrivacyTask(pr).catch((err) => {
        log(`[privacy] task for ${pr.id} not created: ${err instanceof Error ? err.message : err}`, "error");
        return null;
      });
      await auditLog({ actor: memberActor(clientId, email), action: "privacy.request_created", target: `privacy_requests/${pr.id}`, meta: { kind, dueAt, taskId } });
      const who = await memberEmailOf(clientId, email);
      sendPrivacyEmail(
        who.email || email,
        who.firstName,
        `We received your request: ${REQUEST_LABEL[kind].toLowerCase()}`,
        [
          `We received your request (${REQUEST_LABEL[kind].toLowerCase()}) on ${dayLabel(pr.createdAt)}. Reference: ${pr.id}.`,
          `We will answer by ${dayLabel(dueAt)}. We may ask you to confirm your identity before we act on it.`,
          ...(kind === "delete"
            ? ["Deleting your account ends your membership. Invoices and payment records are kept for as long as the law requires, and proof of your consents is kept with your email replaced by a code."]
            : []),
          "If you did not make this request, reply to this email straight away.",
        ],
        `privacy_ack_${pr.id}`,
      );
      res.status(201).json({ request: pr });
    }),
  );

  // ── Staff ────────────────────────────────────────────────────────────────
  const staffOnly = [requireDashboardAuth, requireStaffRole()];

  app.get(
    "/api/dashboard/privacy/requests",
    ...staffOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const all = req.query.status === "all";
      const rows = (await query(COLLECTIONS.privacyRequests, []).catch(() => [])) as unknown as PrivacyRequest[];
      const nameOf = async (ids: string[]) => {
        const names = new Map<string, string>();
        await Promise.all([...new Set(ids)].map(async (id) => {
          const c = (await get(COLLECTIONS.clients, id).catch(() => null)) as Doc | null;
          names.set(id, c?.erased ? "(deleted member)" : String(c?.name ?? c?.fullName ?? c?.email ?? id));
        }));
        return names;
      };
      if (isListRequest(req)) {
        // LISTS: names are looked up for each streamed chunk only, not for every request on file.
        const spec: ListSpec<PrivacyRequest> = {
          sorts: { dueAt: (r) => r.dueAt, createdAt: (r) => (r as unknown as Doc).createdAt as string },
          defaultSort: "dueAt",
          filters: {
            status: (r, v) => (v === "all" ? true : v === "open" ? r.status === "received" || r.status === "in_review" : r.status === v),
            kind: (r, v) => r.kind === v,
          },
          search: (r) => [r.id, r.kind, r.email, r.clientId],
          schema: LIST_SCHEMAS.privacyRequests,
          read: (r, f) =>
            f.key === "overdue" ? (r.status === "received" || r.status === "in_review") && Date.parse(r.dueAt) < Date.now() : fieldValue(r, f),
        };
        const scoped = all || typeof req.query.status === "string" ? rows : rows.filter((r) => r.status === "received" || r.status === "in_review");
        return respondList(req, res, spec, (p) => ({
          produce: pageProducer(pageRows(scoped, p, spec), async (chunk) => {
            const names = await nameOf(chunk.map((r) => r.clientId));
            const now = Date.now();
            return chunk.map((r) => ({ ...r, memberName: names.get(r.clientId) ?? r.clientId, overdue: (r.status === "received" || r.status === "in_review") && Date.parse(r.dueAt) < now }));
          }),
        }));
      }
      const list = rows
        .filter((r) => all || r.status === "received" || r.status === "in_review")
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
        .slice(0, 300);
      const names = new Map<string, string>();
      await Promise.all([...new Set(list.map((r) => r.clientId))].map(async (id) => {
        const c = (await get(COLLECTIONS.clients, id).catch(() => null)) as Doc | null;
        names.set(id, c?.erased ? "(deleted member)" : String(c?.name ?? c?.fullName ?? c?.email ?? id));
      }));
      const now = Date.now();
      res.json({
        items: list.map((r) => ({ ...r, memberName: names.get(r.clientId) ?? r.clientId, overdue: (r.status === "received" || r.status === "in_review") && Date.parse(r.dueAt) < now })),
      });
    }),
  );

  app.post(
    "/api/dashboard/privacy/requests/:id/status",
    ...staffOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const r = (await get(COLLECTIONS.privacyRequests, id).catch(() => null)) as PrivacyRequest | null;
      if (!r) return res.status(404).json({ error: "Request not found." });
      const status = req.body?.status as PrivacyRequest["status"];
      if (!["in_review", "completed", "refused"].includes(status)) return res.status(400).json({ error: "Unknown status." });
      const note = sanitizeStr(req.body?.note).slice(0, 2000);
      if ((status === "refused" || status === "completed") && !note) {
        return res.status(400).json({ error: "Add a note: what was done, or why the request is refused (the member is told)." });
      }
      if (r.kind === "delete" && status === "completed") {
        return res.status(400).json({ error: "Complete a deletion request with Run deletion." });
      }
      const fields: Doc = { status, staffNote: note || undefined, updatedAt: nowIso(), updatedBy: staffActor(req).email };
      if (status === "completed" || status === "refused") fields.completedAt = nowIso();
      await patch(COLLECTIONS.privacyRequests, id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
      if (status !== "in_review") await closePrivacyTask(id, r.clientId, `${status}: ${note}`);
      await auditLog({ actor: staffActor(req), action: `privacy.request_${status}`, target: `privacy_requests/${id}`, meta: { kind: r.kind, clientId: r.clientId } });
      if (status !== "in_review") {
        const who = await memberEmailOf(r.clientId, r.email);
        sendPrivacyEmail(
          who.email || r.email,
          who.firstName,
          status === "completed" ? "Your privacy request is complete" : "About your privacy request",
          [
            `Your request (${REQUEST_LABEL[r.kind].toLowerCase()}, reference ${r.id}) is ${status === "completed" ? "complete" : "refused"}.`,
            note,
            ...(status === "refused"
              ? ["If you disagree, reply to this email. You can also complain to Costa Rica's data protection agency (PRODHAB) or, if you live in the US, your state's privacy regulator."]
              : []),
          ],
          `privacy_${status}_${r.id}`,
        );
      }
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/dashboard/privacy/requests/:id/plan",
    ...staffOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const r = (await get(COLLECTIONS.privacyRequests, String(req.params.id)).catch(() => null)) as PrivacyRequest | null;
      if (!r) return res.status(404).json({ error: "Request not found." });
      const store = firestoreStore();
      const who = await memberEmailOf(r.clientId, r.email);
      const subject = subjectFor(r.clientId, who.email || r.email, who.client);
      res.json({
        blocker: await erasureBlocker(store, r.clientId),
        lines: await planErasure(store, subject),
        manualSteps: ERASURE_MANUAL_STEPS,
        email: subject.email,
      });
    }),
  );

  app.post(
    "/api/dashboard/privacy/requests/:id/erase",
    ...staffOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      const r = (await get(COLLECTIONS.privacyRequests, id).catch(() => null)) as PrivacyRequest | null;
      if (!r) return res.status(404).json({ error: "Request not found." });
      if (r.kind !== "delete") return res.status(400).json({ error: "Only a deletion request can run a deletion." });
      if (r.status === "completed") return res.status(409).json({ error: "This deletion already ran." });
      const store = firestoreStore();
      const who = await memberEmailOf(r.clientId, r.email);
      const subject = subjectFor(r.clientId, who.email || r.email, who.client);
      const confirm = String(req.body?.confirmEmail ?? "").trim().toLowerCase();
      if (!confirm || confirm !== subject.email) return res.status(400).json({ error: "Type the member's email exactly to confirm." });
      const blocker = await erasureBlocker(store, r.clientId);
      if (blocker) return res.status(409).json({ error: blocker });

      const actor = staffActor(req);
      await auditLog({ actor, action: "privacy.erasure_started", target: `clients/${r.clientId}`, meta: { requestId: id } });
      const result = await runErasure(store, subject);
      const done = nowIso();
      await patch(COLLECTIONS.privacyRequests, id, { status: "completed", completedAt: done, updatedBy: actor.email, erasure: result.lines.map((l) => `${l.collection}:${l.action}:${l.count}`) });
      await closePrivacyTask(id, r.clientId, `Deletion ran: ${result.lines.filter((l) => l.count).map((l) => `${l.collection} ${l.count}`).join(", ")}`);
      await auditLog({ actor, action: "privacy.erasure_completed", target: `clients/${r.clientId}`, meta: { requestId: id, lines: result.lines.map(({ collection, action, count }) => ({ collection, action, count })), filesDeleted: result.filesDeleted, fileErrors: result.fileErrors } });
      // Last message to the address; the email queue copy is purged by the retention job.
      sendPrivacyEmail(
        subject.email,
        undefined,
        "Your ILP account has been deleted",
        [
          `We deleted your ILP account and the personal data in our member systems (reference ${id}).`,
          "We keep invoices and payment records for as long as the law requires, and a record that you consented and asked for deletion, with your email replaced by a code.",
          "Copies held by our providers (for example Stripe and Google) and in our backups expire on their own schedules, described in our Privacy Policy.",
        ],
        `privacy_erased_${id}`,
      );
      res.json({ ok: true, ...result, manualSteps: ERASURE_MANUAL_STEPS });
    }),
  );

  app.get(
    "/api/dashboard/privacy/members/:clientId/export",
    ...staffOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const clientId = String(req.params.clientId);
      const who = await memberEmailOf(clientId, "");
      if (!who.client) return res.status(404).json({ error: "Member not found." });
      const body = buildExport(await loadExportBundle(clientId, who.email), {
        now: new Date(),
        memberName: String(who.client.name ?? "Member"),
        // Staff download route (audited, helper/storage.ts); the member's copy uses their own route.
        documentUrl: (docId) => `${apiUrl()}/api/dashboard/members/${encodeURIComponent(clientId)}/documents/${encodeURIComponent(docId)}/file`,
      });
      await auditLog({ actor: staffActor(req), action: "privacy.export_by_staff", target: `clients/${clientId}`, meta: {} });
      res.setHeader("Content-Disposition", `attachment; filename="ilp-member-data-${clientId}.json"`);
      res.setHeader("Cache-Control", "no-store");
      res.json(body);
    }),
  );

  app.get(
    "/api/dashboard/privacy/members/:clientId/consents",
    ...staffOnly,
    asyncHandler(async (req: Request, res: Response) => {
      const rows = await consentsOf(String(req.params.clientId));
      res.json({ items: rows.sort((a, b) => b.at.localeCompare(a.at)), current: latestConsents(rows), versions: VERSION_FOR_KIND });
    }),
  );
}
