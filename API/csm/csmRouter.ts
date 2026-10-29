/**
 * API/csm/csmRouter.ts — the Customer Success Manager portal API (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Every route needs a dashboard session (the /csm portal signs in with the
 * same email code as staff; the role comes from CSM_EMAILS / ADMIN_EMAILS on
 * every request). A CSM sees only their own book; staff and admins pass
 * ?csm=<email> to open any CSM's view. ?unassigned=1 adds members with no
 * CSM yet. See book.ts for the rules.
 *
 *   GET  /api/csm/me                         who is viewing whose book, the CSM list (staff)
 *   GET  /api/csm/today                      queue (overdue first), new members, at risk
 *   GET  /api/csm/book                       book rows with health (list contract: ?limit, ?q, f.*, NDJSON)
 *   GET  /api/csm/onboarding                 new members to consultation-ready and a first call
 *   GET  /api/csm/calls                      upcoming (readiness), wrap-up, no-shows
 *   GET  /api/csm/risk                       renewals in 7 days, payment failed, cancel requested, low scores, inactive
 *   GET  /api/csm/deadlines                  open deadlines across the book (60 days, or no date)
 *   GET  /api/csm/quotes                     open quotes and opportunities
 *   GET  /api/csm/messages                   member messages and uploads, unanswered first
 *   GET  /api/csm/kpis                       My KPIs
 *   GET  /api/csm/playbooks                  playbooks with their email
 *   PUT  /api/csm/playbooks/:id              { subject, paragraphs[] } edit the email (CSM or admin)
 *   POST /api/csm/playbooks/:id/reset        back to the default email
 *   GET  /api/csm/members/:clientId          health, contacts and scope for the member page
 *   POST /api/csm/members/:clientId/contacts { channel, direction?, reached?, summary, at?, taskId?, closeTask? }
 *   POST /api/csm/members/:clientId/email    { playbookId } send a playbook email (email classes respected)
 *   POST /api/csm/members/:clientId/tasks    { title, dueAt, type? } a task you own
 *   POST /api/csm/members/:clientId/take     put an unassigned member in your book
 *   POST /api/csm/tasks/:id/close            { outcome, status? } (outcome required for done)
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import auditLog from "../../helper/auditLog.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { createRecord, findRecords, getRecord, updateRecord } from "../../db/records.ts";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import { LIST_SCHEMAS } from "../../schemas/listSchemas.ts";
import { DOCUMENTS_COLLECTION } from "../../helper/storage.ts";
import { isPlaceholderDoc, isPlaceholderId, PLACEHOLDER_PREFIX } from "../../helper/placeholder.ts";
import {
  COLLECTIONS,
  CSM_CONTACT_CHANNELS,
  type CsmContact,
  type CsmContactChannel,
  type CsmTask,
  type CsmTaskType,
  type Membership,
  type Opportunity,
} from "../../schemas/contracts.ts";
import { latestMembershipPerClient } from "../dashboard/staffHome/compute.ts";
import { emailPrefsOf, isSuppressed, mayEmail, sendOnce, siteUrl, memberContact } from "../retention/mailer.ts";
import { onRecordUpdated } from "../members/events.ts";
import { type BookData, CSM_SCOPE_DENIED, type CsmScope, loadBook, loadConsultations, memberAccess, scopeOf, tasksOwnedBy } from "./book.ts";
import {
  type BookRow,
  bookRows,
  callsView,
  deadlinesView,
  kpisView,
  messagesView,
  onboardingView,
  quotesView,
  riskView,
  todayView,
} from "./compute.ts";
import { isPlaybookId, loadPlaybook, loadPlaybooks, renderPlaybookEmail, resetPlaybookEmail, savePlaybookEmail, validatePlaybookEmail } from "./playbooks.ts";

type Doc = Record<string, unknown>;

const BOOK_SPEC: ListSpec<BookRow> = {
  sorts: {
    healthScore: (r) => r.healthScore,
    name: (r) => r.name.toLowerCase(),
    completeness: (r) => r.completeness,
    daysSinceContact: (r) => (r.daysSinceContact === null ? 9999 : r.daysSinceContact),
    openTasks: (r) => r.openTasks,
    periodEnd: (r) => r.periodEnd ?? "",
    activatedAt: (r) => r.activatedAt ?? "",
  },
  defaultSort: "healthScore",
  defaultDir: "asc",
  filters: {
    band: (r, v) => r.healthBand === v,
    status: (r, v) => r.status === v,
    excludePlaceholder: (r, v) => v !== "1" || !r.placeholder,
  },
  search: (r) => [r.name, r.email, r.clientId],
  id: (r) => r.clientId,
  schema: LIST_SCHEMAS.csmBook,
};

const TASK_TYPES: CsmTaskType[] = ["onboarding", "follow_up", "missing_document", "proposal", "renewal", "escalation"];

/** Resolve the scope or answer 403. */
function scoped(req: Request, res: Response): CsmScope | null {
  const s = scopeOf(req);
  if (!s.ok) {
    res.status(s.status).json({ error: s.error, code: s.code });
    return null;
  }
  return s.scope;
}

async function rowsFor(scope: CsmScope): Promise<{ book: BookData; rows: BookRow[] }> {
  const book = await loadBook(scope);
  return { book, rows: bookRows(book) };
}

const actor = (scope: CsmScope) => ({ uid: scope.viewer, email: scope.viewer, role: scope.role });

async function csmList(): Promise<string[]> {
  const fromEnv = (Deno.env.get("CSM_EMAILS") ?? "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"));
  const live = await Promise.all((["active", "past_due", "pending"] as const).map((status) => findRecords<Membership>(COLLECTIONS.memberships, { status }).catch(() => [] as Membership[])));
  const named = live.flat().map((m) => String(m.csmEmail ?? "").trim().toLowerCase()).filter((e) => e.includes("@"));
  return [...new Set([...fromEnv, ...named])].sort();
}

/** Member gate for /api/csm/members/:clientId routes. */
async function memberGate(req: Request, res: Response): Promise<{ scope: CsmScope; memberCsm: string | null } | null> {
  const scope = scoped(req, res);
  if (!scope) return null;
  const access = await memberAccess(req, req.params.clientId);
  if (!access.allowed) {
    res.status(403).json({ error: CSM_SCOPE_DENIED, code: "csm_scope" });
    return null;
  }
  return { scope, memberCsm: access.memberCsm };
}

/** The member's CSM for bookkeeping on contacts (current membership). */
async function currentCsm(clientId: string): Promise<string> {
  const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId }).catch(() => []);
  return String(latestMembershipPerClient(ms)[0]?.csmEmail ?? "").trim().toLowerCase();
}

/** Pure: check a contact body. Exported for tests. */
export function parseContact(body: unknown, now = new Date()): { ok: true; value: Pick<CsmContact, "channel" | "direction" | "reached" | "summary" | "at"> & { taskId?: string; closeTask?: string } } | { ok: false; error: string } {
  const b = (body ?? {}) as Doc;
  const channel = String(b.channel ?? "") as CsmContactChannel;
  if (!CSM_CONTACT_CHANNELS.includes(channel)) return { ok: false, error: "Choose how you were in touch: call, video, email, WhatsApp, message or in person." };
  const summary = String(b.summary ?? "").trim();
  if (summary.length < 3) return { ok: false, error: "Write one line on what happened." };
  if (summary.length > 2000) return { ok: false, error: "Keep the summary under 2,000 characters." };
  const at = typeof b.at === "string" && !Number.isNaN(Date.parse(b.at)) ? new Date(b.at).toISOString() : now.toISOString();
  if (Date.parse(at) > now.getTime() + 5 * 60_000) return { ok: false, error: "The contact time cannot be in the future." };
  const closeTask = typeof b.closeTask === "string" ? b.closeTask.trim() : "";
  return {
    ok: true,
    value: {
      channel,
      direction: b.direction === "inbound" ? "inbound" : "outbound",
      reached: b.reached !== false,
      summary,
      at,
      ...(typeof b.taskId === "string" && b.taskId ? { taskId: b.taskId } : {}),
      ...(closeTask ? { closeTask } : {}),
    },
  };
}

export default function csmRouter(app: Express): void {
  log("CSM router initialized.");

  app.get("/api/csm/me", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const canSwitch = scope.role !== "csm";
    res.json({ viewer: scope.viewer, role: scope.role, csm: scope.csm, canSwitch, csms: canSwitch ? await csmList() : [scope.viewer] });
  }));

  app.get("/api/csm/today", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { book, rows } = await rowsFor(scope);
    res.json({ csm: scope.csm, ...todayView(rows, book.openTasks, scope.csm, new Date(), book.clients) });
  }));

  app.get("/api/csm/book", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { rows } = await rowsFor(scope);
    const counts = { at_risk: 0, watch: 0, healthy: 0, ended: 0 } as Record<string, number>;
    for (const r of rows) counts[r.healthBand] = (counts[r.healthBand] ?? 0) + 1;
    if (isListRequest(req)) {
      return respondList(req, res, BOOK_SPEC, (p) => ({ produce: pageProducer(pageRows(rows, p, BOOK_SPEC)), meta: { csm: scope.csm, bands: counts } }));
    }
    res.json({ csm: scope.csm, items: rows.sort((a, b) => a.healthScore - b.healthScore), bands: counts });
  }));

  app.get("/api/csm/onboarding", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { rows } = await rowsFor(scope);
    const consultations = await loadConsultations(new Set(rows.map((r) => r.clientId)));
    res.json({ csm: scope.csm, items: onboardingView(rows, consultations) });
  }));

  app.get("/api/csm/calls", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { rows } = await rowsFor(scope);
    const consultations = await loadConsultations(new Set(rows.map((r) => r.clientId)));
    const view = callsView(rows, consultations);
    const ids = [...new Set([...view.upcoming, ...view.wrapUp, ...view.noShows].map((c) => c.providerId))];
    const docs = await Promise.all(ids.map((id) => get("providers", id).catch(() => null)));
    const lawyers = Object.fromEntries(ids.map((id, i) => [id, String((docs[i] as Doc | null)?.name ?? (id === "ilp_sales" ? "ILP sales team" : "Lawyer"))]));
    res.json({ csm: scope.csm, ...view, lawyers });
  }));

  app.get("/api/csm/risk", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { book, rows } = await rowsFor(scope);
    res.json({ csm: scope.csm, ...riskView(rows, book.memberships, book.feedback) });
  }));

  app.get("/api/csm/deadlines", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { book, rows } = await rowsFor(scope);
    res.json({ csm: scope.csm, items: deadlinesView(rows, book.obligations) });
  }));

  app.get("/api/csm/quotes", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { book, rows } = await rowsFor(scope);
    const opps = (await getAll(COLLECTIONS.opportunities).catch(() => [])) as unknown as Opportunity[];
    res.json({ csm: scope.csm, ...quotesView(rows, book.clients, opps) });
  }));

  app.get("/api/csm/messages", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { book, rows } = await rowsFor(scope);
    const docs = (await Promise.all(rows.map((r) => query(DOCUMENTS_COLLECTION, [{ field: "clientId", op: "EQUAL", value: r.clientId }]).catch(() => [])))).flat() as Doc[];
    res.json({ csm: scope.csm, items: messagesView(rows, book.clients, docs) });
  }));

  app.get("/api/csm/kpis", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const { book, rows } = await rowsFor(scope);
    const owned = await tasksOwnedBy(scope.csm);
    res.json({ csm: scope.csm, ...kpisView({ rows, memberships: book.memberships, contacts: book.contacts, ownedTasks: owned }) });
  }));

  // ── Playbooks ────────────────────────────────────────────────────────────
  app.get("/api/csm/playbooks", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    res.json({ items: await loadPlaybooks(), canEdit: scope.role === "csm" || scope.role === "admin" });
  }));

  app.put("/api/csm/playbooks/:id", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    if (scope.role === "staff") return res.status(403).json({ error: "Only CSMs and admins can change playbook emails.", code: "role_denied" });
    if (!isPlaybookId(req.params.id)) return res.status(404).json({ error: "Playbook not found." });
    const v = validatePlaybookEmail(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const p = await savePlaybookEmail(req.params.id, v.email, scope.viewer);
    await auditLog({ actor: actor(scope), action: "csm.playbook_edited", target: `${COLLECTIONS.csmPlaybooks}/${req.params.id}`, meta: {} }).catch(() => undefined);
    res.json(p);
  }));

  app.post("/api/csm/playbooks/:id/reset", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    if (scope.role === "staff") return res.status(403).json({ error: "Only CSMs and admins can change playbook emails.", code: "role_denied" });
    if (!isPlaybookId(req.params.id)) return res.status(404).json({ error: "Playbook not found." });
    const p = await resetPlaybookEmail(req.params.id, scope.viewer);
    await auditLog({ actor: actor(scope), action: "csm.playbook_reset", target: `${COLLECTIONS.csmPlaybooks}/${req.params.id}`, meta: {} }).catch(() => undefined);
    res.json(p);
  }));

  // ── One member ───────────────────────────────────────────────────────────
  app.get("/api/csm/members/:clientId", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const gate = await memberGate(req, res);
    if (!gate) return;
    const { clientId } = req.params;
    const memberCsm = gate.memberCsm ?? await currentCsm(clientId);
    const book = await loadBook({ ...gate.scope, csm: memberCsm || gate.scope.csm, includeUnassigned: !memberCsm });
    const row = bookRows(book).find((r) => r.clientId === clientId) ?? null;
    if (!row && !(await get(COLLECTIONS.clients, clientId).catch(() => null))) return res.status(404).json({ error: "Member not found." });
    const contacts = ((await query(COLLECTIONS.csmContacts, [{ field: "clientId", op: "EQUAL", value: clientId }]).catch(() => [])) as unknown as CsmContact[])
      .sort((a, b) => b.at.localeCompare(a.at));
    const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
    const prefs = emailPrefsOf(client);
    res.json({
      clientId,
      csmEmail: memberCsm || null,
      mine: memberCsm === gate.scope.viewer,
      health: row?.health ?? null,
      row,
      contacts: contacts.slice(0, 50),
      email: { optOut: prefs.optOut, marketingConsent: prefs.marketingConsent },
      playbooks: (await loadPlaybooks()).map((p) => ({ id: p.id, title: p.title, emailClass: p.emailClass, subject: p.email.subject })),
    });
  }));

  app.post("/api/csm/members/:clientId/contacts", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const gate = await memberGate(req, res);
    if (!gate) return;
    const { clientId } = req.params;
    const parsed = parseContact(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { closeTask, ...v } = parsed.value;
    if (closeTask && !v.taskId) return res.status(400).json({ error: "Pick the task to close." });
    let task: CsmTask | null = null;
    if (v.taskId) {
      task = await getRecord<CsmTask>(COLLECTIONS.csmTasks, v.taskId);
      if (!task || task.clientId !== clientId) return res.status(404).json({ error: "Task not found for this member." });
    }
    const placeholder = isPlaceholderId(clientId) || isPlaceholderDoc(await get(COLLECTIONS.clients, clientId).catch(() => null));
    const id = `${placeholder ? PLACEHOLDER_PREFIX : ""}ctc_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
    const bookCsm = await currentCsm(clientId);
    const contact: CsmContact = {
      id,
      clientId,
      csmEmail: gate.scope.viewer,
      ...(bookCsm ? { bookCsmEmail: bookCsm } : {}),
      ...v,
      createdAt: new Date().toISOString(),
      ...(placeholder ? { placeholder: true } : {}),
    };
    await put(COLLECTIONS.csmContacts, id, contact as unknown as Doc);
    let closed: CsmTask | null = null;
    if (task && closeTask && task.status === "open") {
      closed = await updateRecord<CsmTask>(COLLECTIONS.csmTasks, task.id, { status: "done", outcome: closeTask, closedAt: new Date().toISOString(), closedBy: gate.scope.viewer });
    }
    await auditLog({ actor: actor(gate.scope), action: "csm.contact_logged", target: `clients/${clientId}`, meta: { contactId: id, channel: v.channel, reached: v.reached, taskClosed: !!closed } }).catch(() => undefined);
    res.status(201).json({ contact, task: closed });
  }));

  app.post("/api/csm/members/:clientId/email", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const gate = await memberGate(req, res);
    if (!gate) return;
    const { clientId } = req.params;
    const id = req.body?.playbookId;
    if (!isPlaybookId(id)) return res.status(400).json({ error: "Choose a playbook email to send." });
    const pb = await loadPlaybook(id);
    const to = await memberContact(clientId);
    if (!to) return res.status(404).json({ error: "This member has no email address on file." });
    // COMMS-P1 classes: transactional always; service stops at the reminder unsubscribe; marketing also needs consent.
    const suppressed = pb.emailClass === "marketing" && await isSuppressed(to.email);
    if (!mayEmail({ optOut: to.optOut, marketingConsent: to.marketingConsent, suppressed }, pb.emailClass)) {
      return res.status(409).json({
        error: to.optOut
          ? "This member turned off ILP emails with the unsubscribe link. Call or message them instead, or ask them to turn emails back on."
          : "This member has not agreed to marketing emails, so this email cannot be sent.",
        blocked: to.optOut ? "opted_out" : "no_marketing_consent",
        emailClass: pb.emailClass,
      });
    }
    const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId }).catch(() => []);
    const m = latestMembershipPerClient(ms)[0];
    const periodEnd = m?.periodEnd ? new Date(m.periodEnd).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Costa_Rica" }) : undefined;
    const mail = renderPlaybookEmail(pb, { firstName: to.firstName, csmEmail: gate.scope.viewer, periodEnd, siteUrl: siteUrl() });
    // Once per member, playbook and Costa Rica day: a double click never sends twice.
    const day = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
    const sent = await sendOnce(`csm_playbook_${id}_${clientId}_${day}`, to, mail, { kind: pb.emailClass });
    if (!sent && !to.placeholder) return res.status(409).json({ error: "This email was already sent to this member today.", blocked: "already_sent" });
    const now = new Date().toISOString();
    const bookCsm = await currentCsm(clientId);
    const contactId = `${to.placeholder ? PLACEHOLDER_PREFIX : ""}ctc_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
    const contact: CsmContact = {
      id: contactId,
      clientId,
      csmEmail: gate.scope.viewer,
      ...(bookCsm ? { bookCsmEmail: bookCsm } : {}),
      channel: "email",
      direction: "outbound",
      reached: true,
      summary: `Sent the "${pb.title}" email: ${mail.subject}`,
      at: now,
      playbookId: id,
      createdAt: now,
      ...(to.placeholder ? { placeholder: true } : {}),
    };
    await put(COLLECTIONS.csmContacts, contactId, contact as unknown as Doc);
    await auditLog({ actor: actor(gate.scope), action: "csm.playbook_email", target: `clients/${clientId}`, meta: { playbookId: id, emailClass: pb.emailClass, queued: sent } }).catch(() => undefined);
    res.json({ sent, placeholder: !!to.placeholder, emailClass: pb.emailClass, subject: mail.subject, contact });
  }));

  app.post("/api/csm/members/:clientId/tasks", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const gate = await memberGate(req, res);
    if (!gate) return;
    const { clientId } = req.params;
    const title = String(req.body?.title ?? "").trim();
    const dueAt = String(req.body?.dueAt ?? "");
    const type = TASK_TYPES.includes(req.body?.type) ? (req.body.type as CsmTaskType) : "follow_up";
    if (title.length < 3 || title.length > 200) return res.status(400).json({ error: "Write what needs doing, in up to 200 characters." });
    if (Number.isNaN(Date.parse(dueAt))) return res.status(400).json({ error: "Pick a due date." });
    const task = await createRecord<CsmTask>(COLLECTIONS.csmTasks, {
      id: `task_manual_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`,
      clientId,
      ownerEmail: gate.scope.viewer,
      type,
      title,
      dueAt: new Date(dueAt).toISOString(),
      status: "open",
      source: { kind: "manual" },
      createdAt: new Date().toISOString(),
    });
    await auditLog({ actor: actor(gate.scope), action: "csm.task_created", target: `${COLLECTIONS.csmTasks}/${task.id}`, meta: { clientId } }).catch(() => undefined);
    res.status(201).json(task);
  }));

  app.post("/api/csm/members/:clientId/take", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const gate = await memberGate(req, res);
    if (!gate) return;
    const { clientId } = req.params;
    const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId });
    const m = latestMembershipPerClient(ms)[0];
    if (!m) return res.status(404).json({ error: "This person has no membership." });
    if (m.csmEmail && gate.scope.role === "csm") return res.status(409).json({ error: "This member already has a CSM." });
    const to = gate.scope.role === "csm" ? gate.scope.viewer : String(req.body?.csmEmail ?? gate.scope.csm).trim().toLowerCase();
    if (!to.includes("@")) return res.status(400).json({ error: "Name the CSM to give this member to." });
    const before = { ...m };
    const after = await updateRecord<Membership>(COLLECTIONS.memberships, m.id, { csmEmail: to, updatedAt: new Date().toISOString() });
    if (after) await onRecordUpdated("memberships", before, after, { actor: gate.scope.viewer });
    await auditLog({ actor: actor(gate.scope), action: "csm.member_taken", target: `memberships/${m.id}`, meta: { from: m.csmEmail ?? null, to } }).catch(() => undefined);
    res.json({ membershipId: m.id, csmEmail: to });
  }));

  app.post("/api/csm/tasks/:id/close", requireDashboardAuth, asyncHandler(async (req: Request, res: Response) => {
    const scope = scoped(req, res);
    if (!scope) return;
    const task = await getRecord<CsmTask>(COLLECTIONS.csmTasks, req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found." });
    const access = await memberAccess(req, task.clientId);
    const ownsIt = String(task.ownerEmail ?? "").toLowerCase() === scope.viewer;
    if (!access.allowed && !ownsIt) return res.status(403).json({ error: CSM_SCOPE_DENIED, code: "csm_scope" });
    if (task.status !== "open") return res.status(409).json({ error: "This task is already closed." });
    const status = req.body?.status === "cancelled" ? "cancelled" : "done";
    const outcome = String(req.body?.outcome ?? "").trim();
    if (status === "done" && !outcome) return res.status(400).json({ error: "Write the outcome in one line before closing the task." });
    const updated = await updateRecord<CsmTask>(COLLECTIONS.csmTasks, task.id, { status, outcome: outcome || undefined, closedAt: new Date().toISOString(), closedBy: scope.viewer });
    await auditLog({ actor: actor(scope), action: "csm.task_closed", target: `${COLLECTIONS.csmTasks}/${task.id}`, meta: { status } }).catch(() => undefined);
    res.json(updated);
  }));
}
