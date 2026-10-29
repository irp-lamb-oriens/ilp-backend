/**
 * providerQuotesRouter.ts — the lawyer's quote editor, provider-scoped.
 *
 * Mirrors the staff quotesRouter (server/API/dashboard/quotesRouter.ts) but
 * gates every route with requireProviderAuth and the assignedProviderId
 * isolation check, so a lawyer can only read/write quotes on their own
 * assigned clients. Reuses the exported quote helpers so the two routers
 * never drift.
 *
 * Routes (all under /api/provider/clients/:id/quotes):
 *   GET    /                                  list
 *   GET    /:quoteId                          get one
 *   POST   /                                  create
 *   PATCH  /:quoteId                          update
 *   POST   /:quoteId/duplicate                duplicate into a new draft
 *   POST   /:quoteId/generate-description     AI scope description
 *   DELETE /:quoteId                          delete
 *   POST   /:quoteId/submit-for-approval      submit
 *   POST   /:quoteId/approve                  approve (approver-gated)
 *   POST   /:quoteId/request-changes          request changes (approver-gated)
 *   POST   /:quoteId/comments                 add comment
 *   PATCH  /:quoteId/comments/:commentId/resolve
 *   POST   /:quoteId/send-to-client           403: staff send quotes (REL)
 *   GET    /:quoteId/contract-pdf             signed agreement PDF
 */

import { isQuoteAccepted } from "../../schemas/quoteStatus.ts";
import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import { requireProviderAuth } from "../../helper/auth/session.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import {
  nanoId,
  normalizePaymentSchedule,
  computeQuoteMath,
  normalizeLineItems,
  normalizeLineGroups,
  flattenLineGroups,
  makeChangeEntry,
  VALID_STATUSES,
  readQuotes,
  writeQuotes,
  findQuote,
  buildQuoteDescriptionInput,
  hashQuoteDescriptionInput,
  generateQuoteClientDescription,
  quotePendingApprovalEmail,
} from "../dashboard/quotesRouter.ts";
import { buildContractSnapshot } from "../dashboard/contractSnapshot.ts";
import { resolveQuoteTemplateBlocks } from "../dashboard/contractTemplate.ts";
import { buildContractPdfBuffer, contractFileName } from "../dashboard/contractPdf.ts";
import { loadQuoteApprovers, isQuoteApprover } from "../dashboard/automation/quoteApprovers.ts";
import { mergeLawyerLineGroups, mergeLawyerLineItems } from "./lawyerView.ts";

/** REL: statuses in which the lawyer may still edit or delete their fee quote. */
const LAWYER_EDITABLE_STATUSES = new Set(["draft", "changes_requested"]);

/** REL: stamp the lawyer on every fee line (and on grouped lines when `groups`). */
function ownLines(items: any[] | null, providerId: string, groups = false): any {
  if (!Array.isArray(items)) return items;
  if (groups) return items.map((g) => ({ ...g, lineItems: ownLines(g?.lineItems ?? [], providerId) }));
  return items.map((li) => ({ ...li, providerId }));
}

/** Margin a new lawyer-created line starts with; staff set the real one. */
const DEFAULT_MARGIN_PCT = 20;

const CLIENTS_COLLECTION = "clients";

function providerIdOf(req: Request): string {
  return (req as Request & { providerId?: string }).providerId ?? "";
}

function providerEmailOf(req: Request): string {
  return (req as Request & { providerUser?: string }).providerUser ?? "";
}

/** Load the client doc and enforce the assigned-provider isolation check. */
async function requireAssignedClient(req: Request, res: Response): Promise<any | null> {
  const providerId = providerIdOf(req);
  const { id } = req.params;
  const doc = await get(CLIENTS_COLLECTION, id);
  if (!doc) {
    res.status(404).json({ error: "Client not found." });
    return null;
  }
  if (doc.assignedProviderId !== providerId) {
    res.status(403).json({ error: "This client is not assigned to you." });
    return null;
  }
  return doc;
}

export default function providerQuotesRouter(app: Express) {
  log("Provider quotes router initialized.");

  // ── GET list ──────────────────────────────────────────────────────────────
  app.get(
    "/api/provider/clients/:id/quotes",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const quotes = await readQuotes(id);
      quotes.sort((a: any, b: any) => {
        const at = a.createdAt ?? a.requestedAt ?? "";
        const bt = b.createdAt ?? b.requestedAt ?? "";
        return bt.localeCompare(at);
      });
      res.json({ quotes });
    })
  );

  // ── GET one ───────────────────────────────────────────────────────────────
  app.get(
    "/api/provider/clients/:id/quotes/:quoteId",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const quote = findQuote(await readQuotes(id), quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });
      res.json(quote);
    })
  );

  // ── POST create ───────────────────────────────────────────────────────────
  app.post(
    "/api/provider/clients/:id/quotes",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();

      const {
        title,
        lineItems = [],
        lineGroups = null,
        currency = "USD",
        providerIds = [],
        providerSnapshots = [],
        notes = null,
        status = "draft",
        serviceType = null,
        clientDescription = null,
        optionGroupId = null,
        optionLabel = null,
        role = "required",
        templateId = null,
        blocks = null,
        paymentSchedule = null,
      } = req.body ?? {};

      // REL: a lawyer's quote always starts as a draft (a status in the body is
      // ignored); staff price, approve and send it.
      void status;
      const pid = providerIdOf(req);

      const hasScheduleInput = Array.isArray(paymentSchedule) && paymentSchedule.length > 0;
      const normalizedSchedule = hasScheduleInput
        ? normalizePaymentSchedule(paymentSchedule)
        : [35, 65];
      if (hasScheduleInput && normalizedSchedule === null) {
        return res.status(400).json({
          error: "paymentSchedule segments must be positive numbers summing to no more than 100%.",
        });
      }

      // Lawyers enter their fee only; margin fields are never taken from the body.
      // REL: every fee line is this lawyer's (settlements pay each line's provider).
      const normalizedGroups = normalizeLineGroups(
        ownLines(mergeLawyerLineGroups(lineGroups, [], DEFAULT_MARGIN_PCT) as any[], pid, true),
        currency,
      );
      const normalizedLineItems = normalizedGroups
        ? flattenLineGroups(normalizedGroups)
        : normalizeLineItems(ownLines(mergeLawyerLineItems(lineItems, [], DEFAULT_MARGIN_PCT), pid), currency);
      const { costSubtotal, total, earnings } = computeQuoteMath(normalizedLineItems);
      const quoteId = nanoId(14);

      const quoteDoc: Record<string, any> = {
        quoteId,
        clientId: id,
        title: title?.trim() || "New Quote",
        lineItems: normalizedLineItems,
        lineGroups: normalizedGroups,
        currency,
        total,
        costSubtotal,
        earnings,
        serviceType: serviceType || null,
        defaultMarginPct: DEFAULT_MARGIN_PCT,
        clientDescription: clientDescription?.trim() || null,
        optionGroupId: optionGroupId || null,
        optionLabel: optionLabel?.trim() || null,
        role: ["required", "exclusive", "optional"].includes(role) ? role : "required",
        templateId: typeof templateId === "string" ? templateId : null,
        blocks: Array.isArray(blocks) ? blocks : null,
        paymentSchedule: normalizedSchedule,
        providerIds: [pid, ...(Array.isArray(providerIds) ? providerIds.filter((x: unknown) => typeof x === "string" && x !== pid) : [])],
        providerSnapshots: Array.isArray(providerSnapshots) ? providerSnapshots : [],
        notes: notes?.trim() || null,
        status: "draft",
        approvers: await loadQuoteApprovers(),
        approvals: [],
        comments: [],
        changeLog: [makeChangeEntry(actor, "created", `Quote "${title?.trim() || "New Quote"}" created`)],
        clientVisible: false,
        sentToClientAt: null,
        clientToken: null,
        clientAcceptedAt: null,
        clientAcceptedBy: null,
        createdAt: now,
        createdBy: actor,
        updatedAt: null,
        requestedAt: now,
        receivedAt: null,
        requestedBy: actor,
      };

      const quotes = await readQuotes(id);
      await writeQuotes(id, [...quotes, quoteDoc]);
      log(`[providerQuotes] Quote ${quoteId} created for client ${id} by ${actor}`);
      res.status(201).json({ success: true, quote: quoteDoc });
    })
  );

  // ── PATCH update ──────────────────────────────────────────────────────────
  app.patch(
    "/api/provider/clients/:id/quotes/:quoteId",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();

      const quotes = await readQuotes(id);
      const existing = findQuote(quotes, quoteId);
      if (!existing) return res.status(404).json({ error: "Quote not found." });

      // REL: lawyers never set a quote's status (no self-approval, no fake
      // acceptance), and the fee is locked once staff are reviewing or the
      // member has it.
      if ("status" in (req.body ?? {}) && req.body.status !== existing.status) {
        return res.status(400).json({ error: "Lawyers cannot change a quote's status. Submit it for approval instead." });
      }
      if (!LAWYER_EDITABLE_STATUSES.has(String(existing.status ?? "draft"))) {
        return res.status(409).json({ error: "This quote is with the ILP team or the member now. Ask the team to send it back for changes." });
      }
      const pid = providerIdOf(req);
      const updates: Record<string, any> = { updatedAt: now };
      const changedFields: string[] = [];

      const scalarFields = [
        // defaultMarginPct is staff-only; status moves only through submit / staff routes.
        "title", "currency", "notes", "serviceType",
        "clientDescription", "optionGroupId", "optionLabel", "role",
      ];
      for (const key of scalarFields) {
        if (key in (req.body ?? {})) {
          if (key === "status" && !VALID_STATUSES.has(req.body[key])) {
            return res.status(400).json({ error: `Invalid status: ${req.body[key]}` });
          }
          updates[key] = req.body[key] ?? null;
          changedFields.push(key);
        }
      }

      if ("lineGroups" in (req.body ?? {})) {
        const resolvedCurrency = updates.currency ?? existing.currency ?? "USD";
        const margin = typeof existing.defaultMarginPct === "number" ? existing.defaultMarginPct : DEFAULT_MARGIN_PCT;
        const normalizedGroups = normalizeLineGroups(
          ownLines(mergeLawyerLineGroups(req.body.lineGroups, existing.lineItems, margin) as any[], pid, true),
          resolvedCurrency,
        );
        const derivedLineItems = normalizedGroups ? flattenLineGroups(normalizedGroups) : [];
        const math = computeQuoteMath(derivedLineItems);
        updates.lineGroups = normalizedGroups;
        updates.lineItems = derivedLineItems;
        updates.total = math.total;
        updates.costSubtotal = math.costSubtotal;
        updates.earnings = math.earnings;
        changedFields.push("lineGroups");
      } else if ("lineItems" in (req.body ?? {})) {
        const resolvedCurrency = updates.currency ?? existing.currency ?? "USD";
        const margin = typeof existing.defaultMarginPct === "number" ? existing.defaultMarginPct : DEFAULT_MARGIN_PCT;
        const normalizedLineItems = normalizeLineItems(
          ownLines(mergeLawyerLineItems(req.body.lineItems, existing.lineItems, margin), pid),
          resolvedCurrency,
        );
        const math = computeQuoteMath(normalizedLineItems);
        updates.lineItems = normalizedLineItems;
        updates.total = math.total;
        updates.costSubtotal = math.costSubtotal;
        updates.earnings = math.earnings;
        changedFields.push("lineItems");
      }

      if ("providerIds" in (req.body ?? {})) {
        const extra = Array.isArray(req.body.providerIds) ? req.body.providerIds.filter((x: unknown) => typeof x === "string" && x !== pid) : [];
        updates.providerIds = [pid, ...extra];
        changedFields.push("providerIds");
      }
      if ("providerSnapshots" in (req.body ?? {})) {
        updates.providerSnapshots = Array.isArray(req.body.providerSnapshots) ? req.body.providerSnapshots : [];
      }
      if ("templateId" in (req.body ?? {})) {
        updates.templateId = typeof req.body.templateId === "string" ? req.body.templateId : null;
        changedFields.push("templateId");
      }
      if ("blocks" in (req.body ?? {})) {
        updates.blocks = Array.isArray(req.body.blocks) ? req.body.blocks : null;
        changedFields.push("blocks");
      }
      if ("paymentSchedule" in (req.body ?? {})) {
        const raw = req.body.paymentSchedule;
        if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
          updates.paymentSchedule = null;
          changedFields.push("paymentSchedule");
        } else {
          const normalized = normalizePaymentSchedule(raw);
          if (normalized === null) {
            return res.status(400).json({
              error: "paymentSchedule segments must be positive numbers summing to no more than 100%.",
            });
          }
          updates.paymentSchedule = normalized;
          changedFields.push("paymentSchedule");
        }
      }

      if (changedFields.length > 0) {
        const existingLog = Array.isArray(existing.changeLog) ? existing.changeLog : [];
        updates.changeLog = [
          ...existingLog,
          makeChangeEntry(actor, "field_edit", `Updated: ${changedFields.join(", ")}`, {
            addressesCommentId: req.body.addressesCommentId || null,
          }),
        ];
      }

      const nextQuotes = quotes.map((q) =>
        (q?.quoteId ?? q?.id) === quoteId ? { ...q, ...updates } : q
      );
      await writeQuotes(id, nextQuotes);
      log(`[providerQuotes] Quote ${quoteId} updated for ${id} by ${actor}: [${changedFields.join(", ")}]`);
      res.json({ success: true, quoteId, updatedFields: changedFields });
    })
  );

  // ── POST duplicate ────────────────────────────────────────────────────────
  app.post(
    "/api/provider/clients/:id/quotes/:quoteId/duplicate",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();

      const quotes = await readQuotes(id);
      const source = findQuote(quotes, quoteId);
      if (!source) return res.status(404).json({ error: "Quote not found." });

      const newId = nanoId(14);
      const copy: Record<string, any> = {
        ...source,
        quoteId: newId,
        title: `${source.title ?? "Quote"} (copy)`,
        status: "draft",
        approvals: [],
        comments: [],
        clientVisible: false,
        sentToClientAt: null,
        clientToken: null,
        clientAcceptedAt: null,
        clientAcceptedBy: null,
        // REL: the member-flow spellings too, or the copy reads as accepted (schemas/quoteStatus.ts).
        acceptedAt: null,
        acceptedBy: null,
        declinedAt: null,
        sentAt: null,
        typedFullName: null,
        consent: null,
        consentAt: null,
        providerIds: [providerIdOf(req)],
        contractSnapshot: null,
        createdAt: now,
        createdBy: actor,
        updatedAt: null,
        requestedAt: now,
        requestedBy: actor,
        changeLog: [makeChangeEntry(actor, "duplicated", `Duplicated from ${quoteId}`)],
      };

      await writeQuotes(id, [...quotes, copy]);
      log(`[providerQuotes] Quote ${newId} duplicated from ${quoteId} for ${id} by ${actor}`);
      res.status(201).json({ success: true, quote: copy });
    })
  );

  // ── POST generate-description ─────────────────────────────────────────────
  app.post(
    "/api/provider/clients/:id/quotes/:quoteId/generate-description",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const force = req.body?.force === true;

      const quotes = await readQuotes(id);
      const quote = findQuote(quotes, quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });

      const clientDoc = await get(CLIENTS_COLLECTION, id).catch(() => null);
      const input = buildQuoteDescriptionInput(quote, clientDoc);
      const hash = hashQuoteDescriptionInput(input);

      if (!force && quote.clientDescriptionHash === hash &&
          typeof quote.clientDescription === "string" && quote.clientDescription.trim()) {
        return res.json({ clientDescription: quote.clientDescription, cached: true });
      }

      const clientDescription = await generateQuoteClientDescription(input);
      const nextQuotes = quotes.map((q) =>
        (q?.quoteId ?? q?.id) === quoteId
          ? { ...q, clientDescription, clientDescriptionHash: hash, clientDescriptionSource: "ai", updatedAt: new Date().toISOString() }
          : q
      );
      await writeQuotes(id, nextQuotes);
      log(`[providerQuotes] AI description (re)generated for ${id}/${quoteId} by ${actor}`);
      res.json({ clientDescription, cached: false });
    })
  );

  // ── DELETE ────────────────────────────────────────────────────────────────
  app.delete(
    "/api/provider/clients/:id/quotes/:quoteId",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);

      const quotes = await readQuotes(id);
      const target = findQuote(quotes, quoteId);
      if (!target) return res.status(404).json({ error: "Quote not found." });
      if (!LAWYER_EDITABLE_STATUSES.has(String(target.status ?? "draft"))) {
        return res.status(409).json({ error: "Only a draft can be deleted. Ask the ILP team about a quote they are reviewing or sent." });
      }
      const nextQuotes = quotes.filter((q) => (q?.quoteId ?? q?.id) !== quoteId);
      await writeQuotes(id, nextQuotes);
      log(`[providerQuotes] Quote ${quoteId} deleted for client ${id} by ${actor}`);
      res.json({ success: true, quoteId });
    })
  );

  // ── POST submit-for-approval ──────────────────────────────────────────────
  app.post(
    "/api/provider/clients/:id/quotes/:quoteId/submit-for-approval",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();
      const { noteToApprovers } = req.body ?? {};

      const quotes = await readQuotes(id);
      const quote = findQuote(quotes, quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });

      if (!["draft", "changes_requested"].includes(quote.status)) {
        return res.status(400).json({
          error: `Cannot submit for approval from status "${quote.status}". Must be draft or changes_requested.`,
        });
      }

      const approvers = await loadQuoteApprovers();
      const existingLog = Array.isArray(quote.changeLog) ? quote.changeLog : [];
      const nextQuotes = quotes.map((q) =>
        (q?.quoteId ?? q?.id) === quoteId
          ? {
              ...q,
              status: "pending_approval",
              updatedAt: now,
              changeLog: [
                ...existingLog,
                makeChangeEntry(actor, "status_change", `Submitted for approval by ${actor}`, {
                  noteToApprovers: noteToApprovers?.trim() || null,
                }),
              ],
            }
          : q
      );
      await writeQuotes(id, nextQuotes);

      const clientDoc = await get(CLIENTS_COLLECTION, id);
      if (clientDoc) {
        const existingActions = Array.isArray(clientDoc.pendingActions) ? clientDoc.pendingActions : [];
        const newAction = {
          actionId: nanoId(14),
          type: "manual",
          tab: "quotes",
          title: `Approve quote: "${quote.title || "untitled"}"`,
          priority: "high",
          assignedTo: approvers,
          triggeredBy: actor,
          triggeredAt: now,
          status: "pending",
          meta: { quoteId, quoteTitle: quote.title || "", noteToApprovers: noteToApprovers?.trim() || null },
          clientId: id,
        };
        await patch(CLIENTS_COLLECTION, id, { pendingActions: [...existingActions, newAction] });
      }

      try {
        const mail = quotePendingApprovalEmail({ by: "Lawyer", actor, quoteTitle: quote.title || "New Quote", clientId: id, note: noteToApprovers });
        for (const approverEmail of approvers) {
          await enqueueEmail({ to: approverEmail, ...mail }).catch(() => {});
        }
      } catch (emailErr: any) {
        log(`[providerQuotes] Submit email failed (non-fatal): ${emailErr?.message}`);
      }

      log(`[providerQuotes] Quote ${quoteId} submitted for approval by ${actor}`);
      res.json({ success: true, quoteId, status: "pending_approval" });
    })
  );

  // ── POST approve ──────────────────────────────────────────────────────────
  app.post(
    "/api/provider/clients/:id/quotes/:quoteId/approve",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();
      const editsApplied = req.body?.editsApplied === true;

      if (!(await isQuoteApprover(actor))) {
        return res.status(403).json({ error: "Only designated approvers can approve quotes." });
      }

      const quotes = await readQuotes(id);
      const quote = findQuote(quotes, quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });

      if (quote.status !== "pending_approval") {
        return res.status(400).json({ error: `Quote is not pending approval (current: ${quote.status})` });
      }

      const existingApprovals = Array.isArray(quote.approvals) ? quote.approvals : [];
      const existingLog = Array.isArray(quote.changeLog) ? quote.changeLog : [];
      const nextQuotes = quotes.map((q) =>
        (q?.quoteId ?? q?.id) === quoteId
          ? {
              ...q,
              status: "approved",
              updatedAt: now,
              approvals: [
                ...existingApprovals,
                { approverEmail: actor, decision: "approved", decidedAt: now, editsApplied },
              ],
              changeLog: [
                ...existingLog,
                makeChangeEntry(actor, "approved", editsApplied ? `Approved with edits by ${actor}` : `Approved by ${actor}`),
              ],
            }
          : q
      );
      await writeQuotes(id, nextQuotes);

      const clientDoc = await get(CLIENTS_COLLECTION, id);
      if (clientDoc) {
        const actions = (Array.isArray(clientDoc.pendingActions) ? clientDoc.pendingActions : []).map((a: any) =>
          a.status === "pending" && a.meta?.quoteId === quoteId ? { ...a, status: "done" } : a
        );
        await patch(CLIENTS_COLLECTION, id, { pendingActions: actions });
      }

      log(`[providerQuotes] Quote ${quoteId} approved by ${actor}`);
      res.json({ success: true, quoteId, status: "approved" });
    })
  );

  // ── POST request-changes ──────────────────────────────────────────────────
  app.post(
    "/api/provider/clients/:id/quotes/:quoteId/request-changes",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();
      const { comment } = req.body ?? {};

      if (!(await isQuoteApprover(actor))) {
        return res.status(403).json({ error: "Only designated approvers can request changes." });
      }
      if (!comment?.trim()) {
        return res.status(400).json({ error: "A comment explaining the requested changes is required." });
      }

      const quotes = await readQuotes(id);
      const quote = findQuote(quotes, quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });

      if (quote.status !== "pending_approval") {
        return res.status(400).json({ error: `Quote is not pending approval (current: ${quote.status})` });
      }

      const commentId = nanoId(12);
      const newComment = {
        commentId,
        authorEmail: actor,
        text: comment.trim(),
        createdAt: now,
        resolved: false,
        resolvedBy: null,
        resolvedAt: null,
      };
      const existingComments = Array.isArray(quote.comments) ? quote.comments : [];
      const existingLog = Array.isArray(quote.changeLog) ? quote.changeLog : [];

      const nextQuotes = quotes.map((q) =>
        (q?.quoteId ?? q?.id) === quoteId
          ? {
              ...q,
              status: "changes_requested",
              updatedAt: now,
              comments: [...existingComments, newComment],
              changeLog: [
                ...existingLog,
                makeChangeEntry(actor, "changes_requested", `Changes requested by ${actor}: "${comment.trim().slice(0, 80)}"`),
              ],
            }
          : q
      );
      await writeQuotes(id, nextQuotes);

      const clientDoc = await get(CLIENTS_COLLECTION, id);
      if (clientDoc) {
        const actions = (Array.isArray(clientDoc.pendingActions) ? clientDoc.pendingActions : []).map((a: any) =>
          a.status === "pending" && a.meta?.quoteId === quoteId ? { ...a, status: "dismissed" } : a
        );
        await patch(CLIENTS_COLLECTION, id, { pendingActions: actions });
      }

      log(`[providerQuotes] Quote ${quoteId} changes requested by ${actor}`);
      res.json({ success: true, quoteId, status: "changes_requested", commentId });
    })
  );

  // ── POST comments ─────────────────────────────────────────────────────────
  app.post(
    "/api/provider/clients/:id/quotes/:quoteId/comments",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();
      const { text } = req.body ?? {};

      if (!text?.trim()) {
        return res.status(400).json({ error: "Comment text is required." });
      }

      const quotes = await readQuotes(id);
      const quote = findQuote(quotes, quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });

      const commentId = nanoId(12);
      const newComment = {
        commentId,
        authorEmail: actor,
        text: text.trim(),
        createdAt: now,
        resolved: false,
        resolvedBy: null,
        resolvedAt: null,
      };
      const existingComments = Array.isArray(quote.comments) ? quote.comments : [];
      const existingLog = Array.isArray(quote.changeLog) ? quote.changeLog : [];

      const nextQuotes = quotes.map((q) =>
        (q?.quoteId ?? q?.id) === quoteId
          ? {
              ...q,
              comments: [...existingComments, newComment],
              updatedAt: now,
              changeLog: [...existingLog, makeChangeEntry(actor, "comment_added", `Comment added by ${actor}`)],
            }
          : q
      );
      await writeQuotes(id, nextQuotes);

      res.status(201).json({ success: true, comment: newComment });
    })
  );

  // ── PATCH resolve comment ─────────────────────────────────────────────────
  app.patch(
    "/api/provider/clients/:id/quotes/:quoteId/comments/:commentId/resolve",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId, commentId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;
      const actor = providerEmailOf(req);
      const now = new Date().toISOString();

      const quotes = await readQuotes(id);
      const quote = findQuote(quotes, quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });

      const existingComments = Array.isArray(quote.comments) ? quote.comments : [];
      const targetComment = existingComments.find((c: any) => c.commentId === commentId);
      if (!targetComment) return res.status(404).json({ error: "Comment not found." });
      if (targetComment.resolved) return res.status(400).json({ error: "Comment already resolved." });

      const updatedComments = existingComments.map((c: any) =>
        c.commentId === commentId ? { ...c, resolved: true, resolvedBy: actor, resolvedAt: now } : c
      );
      const existingLog = Array.isArray(quote.changeLog) ? quote.changeLog : [];

      const nextQuotes = quotes.map((q) =>
        (q?.quoteId ?? q?.id) === quoteId
          ? {
              ...q,
              comments: updatedComments,
              updatedAt: now,
              changeLog: [...existingLog, makeChangeEntry(actor, "comment_resolved", `Comment ${commentId} resolved by ${actor}`, { addressesCommentId: commentId })],
            }
          : q
      );
      await writeQuotes(id, nextQuotes);

      res.json({ success: true, commentId, resolvedBy: actor, resolvedAt: now });
    })
  );

  // ── POST send-to-client ───────────────────────────────────────────────────
  // REL: quotes reach members only from staff, after ILP's price is set
  // (POST /api/dashboard/clients/:id/quotes/:quoteId/send-to-client).
  app.post(
    "/api/provider/clients/:id/quotes/:quoteId/send-to-client",
    requireProviderAuth,
    (_req: Request, res: Response) => {
      res.status(403).json({ error: "The ILP team sends quotes to members once the price is set." });
    },
  );

  // ── GET contract-pdf ──────────────────────────────────────────────────────
  app.get(
    "/api/provider/clients/:id/quotes/:quoteId/contract-pdf",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const doc = await requireAssignedClient(req, res);
      if (!doc) return;

      const quote = findQuote(await readQuotes(id), quoteId);
      if (!quote) return res.status(404).json({ error: "Quote not found." });
      if (!isQuoteAccepted(quote)) {
        return res.status(400).json({
          error: "A contract exists only once the client has accepted this quote.",
        });
      }

      const clientDoc = await get(CLIENTS_COLLECTION, id).catch(() => null);
      const stored = quote.contractSnapshot;
      const snapshot =
        stored?.contractRef && Array.isArray(stored?.templateText)
          ? stored
          : buildContractSnapshot(
              { ...quote, quoteId, clientId: id },
              clientDoc,
              { templateBlocks: await resolveQuoteTemplateBlocks(quote, clientDoc) },
            );

      const pdf = await buildContractPdfBuffer(snapshot);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${contractFileName(snapshot)}"`);
      res.send(pdf);
    })
  );
}