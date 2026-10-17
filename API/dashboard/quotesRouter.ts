/**
 * quotesRouter.ts — Rich quotes per client.
 *
 * Phase 1: CRUD with title, line-items, line-groups, notes, changeLog.
 * Phase 2: Approval workflow (submit, approve, request-changes, comments).
 * Phase 3: Client-facing (send-to-client, accept → contract snapshot + PDF).
 *
 * ILP adaptation: quotes live as an ARRAY on the `clients/{id}` doc (see
 * db/models.ts `ClientDoc.quotes`), not as a `consultations/{id}/quotes`
 * subcollection. The client-status portal already reads/writes this array, so
 * this router shares the same shape and stays backward compatible with it.
 *
 * Firestore path: clients/{clientId}  (field `quotes`)
 *
 * Routes
 * ──────
 *   GET    /api/dashboard/clients/:id/quotes
 *   GET    /api/dashboard/clients/:id/quotes/:quoteId
 *   POST   /api/dashboard/clients/:id/quotes
 *   PATCH  /api/dashboard/clients/:id/quotes/:quoteId
 *   DELETE /api/dashboard/clients/:id/quotes/:quoteId
 *   POST   /api/dashboard/clients/:id/quotes/:quoteId/generate-description
 *   POST   /api/dashboard/clients/:id/quotes/:quoteId/submit-for-approval
 *   POST   /api/dashboard/clients/:id/quotes/:quoteId/approve
 *   POST   /api/dashboard/clients/:id/quotes/:quoteId/request-changes
 *   POST   /api/dashboard/clients/:id/quotes/:quoteId/comments
 *   PATCH  /api/dashboard/clients/:id/quotes/:quoteId/comments/:commentId/resolve
 *   POST   /api/dashboard/clients/:id/quotes/:quoteId/send-to-client
 *   GET    /api/dashboard/clients/:id/quotes/:quoteId/contract-pdf
 */

import type { Express, Request, Response } from "express";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { callLLMWithFallback, type LlmRequest } from "../chatbot/intelligence/llm.ts";
import { lineClientPrice } from "./quotePricing.ts";
import { buildContractSnapshot } from "./contractSnapshot.ts";
import { resolveQuoteTemplateBlocks } from "./contractTemplate.ts";
import { buildContractPdfBuffer, contractFileName } from "./contractPdf.ts";
import { loadQuoteApprovers, isQuoteApprover } from "./automation/quoteApprovers.ts";
import { resolveClientEmail } from "./clientHelpers.ts";

const CLIENTS_COLLECTION = "clients";

// ── Helpers ───────────────────────────────────────────────────────────────────

function nanoId(size = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

/**
 * Normalize an ordered installment schedule in percent (e.g. [35, 65]).
 * Each value must be a non-negative finite number and the sum must not exceed
 * 100. Returns a clean number[] or null for a legacy/cleared schedule.
 */
function normalizePaymentSchedule(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const nums: number[] = [];
  for (const v of raw) {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(Math.round(n * 100) / 100);
  }
  const sum = nums.reduce((s, n) => s + n, 0);
  if (sum > 100.001) return null;
  return nums;
}

/** Server-side margin math: costSubtotal, client total, earnings. */
function computeQuoteMath(lineItems: any[]): { costSubtotal: number; total: number; earnings: number } {
  if (!Array.isArray(lineItems)) return { costSubtotal: 0, total: 0, earnings: 0 };
  let costSubtotal = 0;
  let total = 0;
  for (const item of lineItems) {
    const cost = typeof item.amount === "number" ? item.amount : parseFloat(item.amount) || 0;
    costSubtotal += cost;
    total += lineClientPrice(item);
  }
  costSubtotal = Math.round(costSubtotal * 100) / 100;
  total = Math.round(total * 100) / 100;
  return { costSubtotal, total, earnings: Math.round((total - costSubtotal) * 100) / 100 };
}

function normalizeLineItems(raw: any[], defaultCurrency = "USD"): any[] {
  return (Array.isArray(raw) ? raw : []).map((item: any) => {
    const mode: "pct" | "flat" = item.marginMode === "flat" ? "flat" : "pct";
    return {
      lineId: item.lineId || nanoId(10),
      label: String(item.label || "").trim(),
      amount: typeof item.amount === "number" ? item.amount : parseFloat(item.amount) || 0,
      marginPct: typeof item.marginPct === "number"
        ? item.marginPct
        : (!isNaN(parseFloat(item.marginPct)) ? parseFloat(item.marginPct) : 20),
      marginMode: mode,
      marginFlat: mode === "flat"
        ? (typeof item.marginFlat === "number" ? item.marginFlat : (parseFloat(item.marginFlat) || 0))
        : null,
      currency: item.currency || defaultCurrency,
      providerId: item.providerId || null,
      notes: item.notes?.trim() || null,
      isOptional: !!item.isOptional,
    };
  });
}

function normalizeLineGroups(raw: any[], defaultCurrency = "USD"): any[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((g: any) => ({
    groupId: g.groupId || nanoId(10),
    title: String(g.title || "").trim() || "Services",
    labelId: typeof g.labelId === "string" && g.labelId.trim() ? g.labelId.trim() : null,
    role: g.role === "optional" ? "optional" : g.role === "fixed" ? "fixed" : "required",
    description: typeof g.description === "string" && g.description.trim() ? g.description.trim() : null,
    lineItems: normalizeLineItems(Array.isArray(g.lineItems) ? g.lineItems : [], defaultCurrency),
  }));
}

function flattenLineGroups(groups: any[]): any[] {
  return (Array.isArray(groups) ? groups : []).flatMap((g: any) =>
    Array.isArray(g.lineItems) ? g.lineItems : []
  );
}

function makeChangeEntry(actor: string, type: string, summary: string, extra: Record<string, any> = {}) {
  return {
    changeId: nanoId(10),
    actor,
    type,
    summary,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

const VALID_STATUSES = new Set([
  "draft",
  "pending_approval",
  "changes_requested",
  "approved",
  "sent_to_client",
  "client_accepted",
]);

/** Read the quotes array off a client doc (empty when absent). */
async function readQuotes(clientId: string): Promise<any[]> {
  const doc = await get(CLIENTS_COLLECTION, clientId);
  return Array.isArray(doc?.quotes) ? doc.quotes : [];
}

/** Persist the quotes array back onto the client doc (merge, not replace). */
async function writeQuotes(clientId: string, quotes: any[]): Promise<void> {
  await patch(CLIENTS_COLLECTION, clientId, { quotes });
}

/** Find a quote by id within the array. */
function findQuote(quotes: any[], quoteId: string): any | undefined {
  return quotes.find((q) => (q?.quoteId ?? q?.id) === quoteId);
}

/** Build the client-safe description input for the AI scope description. */
function buildQuoteDescriptionInput(quote: any, clientDoc: any): Record<string, any> {
  const groupsSrc = Array.isArray(quote.lineGroups) && quote.lineGroups.length > 0
    ? quote.lineGroups
    : [{ title: "", role: "required", lineItems: Array.isArray(quote.lineItems) ? quote.lineItems : [] }];
  const groups = groupsSrc.map((g: any) => ({
    title: String(g.title || "").trim(),
    role: g.role === "optional" ? "optional" : "required",
    lineLabels: (Array.isArray(g.lineItems) ? g.lineItems : [])
      .map((li: any) => String(li.label || "").trim())
      .filter(Boolean),
  }));
  const c = clientDoc ?? {};
  const field = (k: string) => c[k] ?? c?.consultations?.[0]?.[k] ?? "";
  return {
    title: quote.title ?? "",
    jurisdiction: String(field("jurisdiction") || "").trim(),
    legalArea: String(field("legalArea") || "").trim(),
    legalMatter: String(field("legalMatter") || "").trim(),
    groups,
  };
}

/** Deterministic hash of the description input (scope-change detection). */
function hashQuoteDescriptionInput(input: Record<string, any>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) - hash + canonical.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/** Generate the client-facing scope description via the LLM fallback chain. */
async function generateQuoteClientDescription(input: Record<string, any>): Promise<string> {
  const prompt = `Write a concise, client-facing scope description for a legal services quote. Use plain language, no prices. Return only the description text.

Quote title: ${input.title || "Legal services"}
Jurisdiction: ${input.jurisdiction || "—"}
Legal area: ${input.legalArea || "—"}
Matter: ${input.legalMatter || "—"}
Services: ${(input.groups ?? []).map((g: any) => `- ${g.title}: ${g.lineLabels.join(", ")}`).join("\n")}`;
  const req: LlmRequest = {
    prompt,
    systemInstruction: "You are a legal services assistant for International Legal Partner. Write a clear, professional scope description.",
  };
  const res = await callLLMWithFallback(req);
  return (res.content ?? "").trim();
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function quotesRouter(app: Express) {
  // ── GET /api/dashboard/clients/:id/quotes ─────────────────────────────────
  app.get(
    "/api/dashboard/clients/:id/quotes",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id } = req.params;
      try {
        const quotes = await readQuotes(id);
        quotes.sort((a: any, b: any) => {
          const at = a.createdAt ?? a.requestedAt ?? "";
          const bt = b.createdAt ?? b.requestedAt ?? "";
          return bt.localeCompare(at);
        });
        res.json({ quotes });
      } catch (err: any) {
        log(`[quotesRouter] GET quotes ${id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to fetch quotes" });
      }
    },
  );

  // ── GET /api/dashboard/clients/:id/quotes/:quoteId ────────────────────────
  app.get(
    "/api/dashboard/clients/:id/quotes/:quoteId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      try {
        const quote = findQuote(await readQuotes(id), quoteId);
        if (!quote) return res.status(404).json({ error: "Quote not found." });
        res.json(quote);
      } catch (err: any) {
        log(`[quotesRouter] GET quote ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to fetch quote" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/quotes ────────────────────────────────
  app.post(
    "/api/dashboard/clients/:id/quotes",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
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
        defaultMarginPct = 20,
        clientDescription = null,
        optionGroupId = null,
        optionLabel = null,
        role = "required",
        templateId = null,
        blocks = null,
        paymentSchedule = null,
      } = req.body ?? {};

      if (!VALID_STATUSES.has(status)) {
        return res.status(400).json({
          error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(", ")}`,
        });
      }

      const hasScheduleInput = Array.isArray(paymentSchedule) && paymentSchedule.length > 0;
      const normalizedSchedule = hasScheduleInput
        ? normalizePaymentSchedule(paymentSchedule)
        : [35, 65];
      if (hasScheduleInput && normalizedSchedule === null) {
        return res.status(400).json({
          error: "paymentSchedule segments must be positive numbers summing to no more than 100%.",
        });
      }

      const normalizedGroups = normalizeLineGroups(lineGroups, currency);
      const normalizedLineItems = normalizedGroups
        ? flattenLineGroups(normalizedGroups)
        : normalizeLineItems(lineItems, currency);
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
        defaultMarginPct: typeof defaultMarginPct === "number" ? defaultMarginPct : 20,
        clientDescription: clientDescription?.trim() || null,
        optionGroupId: optionGroupId || null,
        optionLabel: optionLabel?.trim() || null,
        role: ["required", "exclusive", "optional"].includes(role) ? role : "required",
        templateId: typeof templateId === "string" ? templateId : null,
        blocks: Array.isArray(blocks) ? blocks : null,
        paymentSchedule: normalizedSchedule,
        providerIds: Array.isArray(providerIds) ? providerIds : [],
        providerSnapshots: Array.isArray(providerSnapshots) ? providerSnapshots : [],
        notes: notes?.trim() || null,
        status,
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

      try {
        const quotes = await readQuotes(id);
        await writeQuotes(id, [...quotes, quoteDoc]);
        log(`[quotesRouter] Quote ${quoteId} created for client ${id} by ${actor}`);
        res.status(201).json({ success: true, quote: quoteDoc });
      } catch (err: any) {
        log(`[quotesRouter] POST quote ${id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to create quote" });
      }
    },
  );

  // ── PATCH /api/dashboard/clients/:id/quotes/:quoteId ─────────────────────
  app.patch(
    "/api/dashboard/clients/:id/quotes/:quoteId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      try {
        const quotes = await readQuotes(id);
        const existing = findQuote(quotes, quoteId);
        if (!existing) return res.status(404).json({ error: "Quote not found." });

        const updates: Record<string, any> = { updatedAt: now };
        const changedFields: string[] = [];

        const scalarFields = [
          "title", "currency", "notes", "status", "serviceType", "defaultMarginPct",
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
          const normalizedGroups = normalizeLineGroups(req.body.lineGroups, resolvedCurrency);
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
          const normalizedLineItems = normalizeLineItems(req.body.lineItems, resolvedCurrency);
          const math = computeQuoteMath(normalizedLineItems);
          updates.lineItems = normalizedLineItems;
          updates.total = math.total;
          updates.costSubtotal = math.costSubtotal;
          updates.earnings = math.earnings;
          changedFields.push("lineItems");
        }

        if ("providerIds" in (req.body ?? {})) {
          updates.providerIds = Array.isArray(req.body.providerIds) ? req.body.providerIds : [];
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
        log(`[quotesRouter] Quote ${quoteId} updated for ${id} by ${actor}: [${changedFields.join(", ")}]`);
        res.json({ success: true, quoteId, updatedFields: changedFields });
      } catch (err: any) {
        log(`[quotesRouter] PATCH quote ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to update quote" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/quotes/:quoteId/generate-description ──
  app.post(
    "/api/dashboard/clients/:id/quotes/:quoteId/generate-description",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const force = req.body?.force === true;
      try {
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
        log(`[quotesRouter] AI description (re)generated for ${id}/${quoteId} by ${actor}`);
        res.json({ clientDescription, cached: false });
      } catch (err: any) {
        log(`[quotesRouter] generate-description ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to generate description" });
      }
    },
  );

  // ── DELETE /api/dashboard/clients/:id/quotes/:quoteId ────────────────────
  app.delete(
    "/api/dashboard/clients/:id/quotes/:quoteId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      try {
        const quotes = await readQuotes(id);
        const nextQuotes = quotes.filter((q) => (q?.quoteId ?? q?.id) !== quoteId);
        await writeQuotes(id, nextQuotes);
        log(`[quotesRouter] Quote ${quoteId} deleted for client ${id} by ${actor}`);
        res.json({ success: true, quoteId });
      } catch (err: any) {
        log(`[quotesRouter] DELETE quote ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to delete quote" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/quotes/:quoteId/submit-for-approval ──
  app.post(
    "/api/dashboard/clients/:id/quotes/:quoteId/submit-for-approval",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();
      const { noteToApprovers } = req.body ?? {};

      try {
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

        // PendingAction on the client doc so the Quotes tab badge lights up.
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

        // Email notification to all approvers (best-effort).
        try {
          const quoteTitle = quote.title || "New Quote";
          const emailBody = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:32px 24px;">
            <h2 style="color:#02b5bb;margin:0 0 8px;">Quote Pending Approval</h2>
            <p style="color:#475569;margin:0 0 12px;">Agent <strong>${actor}</strong> has submitted <strong>"${quoteTitle}"</strong> for client <code>${id}</code>.</p>
            ${noteToApprovers?.trim() ? `<p style="background:#f3f4f6;padding:12px;border-radius:6px;"><strong>Note from requester:</strong><br>${noteToApprovers.trim()}</p>` : ""}
            <p style="color:#94a3b8;font-size:11px;margin-top:24px;">International Legal Partner · Quotes System</p>
          </div>`;
          for (const approverEmail of approvers) {
            await enqueueEmail({
              to: approverEmail,
              subject: `[ILP] Quote pending approval: "${quoteTitle}"`,
              html: emailBody,
            }).catch(() => {});
          }
        } catch (emailErr: any) {
          log(`[quotesRouter] Submit email failed (non-fatal): ${emailErr?.message}`);
        }

        log(`[quotesRouter] Quote ${quoteId} submitted for approval by ${actor}`);
        res.json({ success: true, quoteId, status: "pending_approval" });
      } catch (err: any) {
        log(`[quotesRouter] submit-for-approval ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to submit for approval" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/quotes/:quoteId/approve ──────────────
  app.post(
    "/api/dashboard/clients/:id/quotes/:quoteId/approve",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();
      const editsApplied = req.body?.editsApplied === true;

      if (!(await isQuoteApprover(actor))) {
        return res.status(403).json({ error: "Only designated approvers can approve quotes." });
      }

      try {
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

        // Resolve the PendingAction for this quote.
        const clientDoc = await get(CLIENTS_COLLECTION, id);
        if (clientDoc) {
          const actions = (Array.isArray(clientDoc.pendingActions) ? clientDoc.pendingActions : []).map((a: any) =>
            a.status === "pending" && a.meta?.quoteId === quoteId ? { ...a, status: "done" } : a
          );
          await patch(CLIENTS_COLLECTION, id, { pendingActions: actions });
        }

        log(`[quotesRouter] Quote ${quoteId} approved by ${actor}`);
        res.json({ success: true, quoteId, status: "approved" });
      } catch (err: any) {
        log(`[quotesRouter] approve ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to approve quote" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/quotes/:quoteId/request-changes ──────
  app.post(
    "/api/dashboard/clients/:id/quotes/:quoteId/request-changes",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();
      const { comment } = req.body ?? {};

      if (!(await isQuoteApprover(actor))) {
        return res.status(403).json({ error: "Only designated approvers can request changes." });
      }
      if (!comment?.trim()) {
        return res.status(400).json({ error: "A comment explaining the requested changes is required." });
      }

      try {
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

        log(`[quotesRouter] Quote ${quoteId} changes requested by ${actor}`);
        res.json({ success: true, quoteId, status: "changes_requested", commentId });
      } catch (err: any) {
        log(`[quotesRouter] request-changes ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to request changes" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/quotes/:quoteId/comments ─────────────
  app.post(
    "/api/dashboard/clients/:id/quotes/:quoteId/comments",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();
      const { text } = req.body ?? {};

      if (!text?.trim()) {
        return res.status(400).json({ error: "Comment text is required." });
      }

      try {
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
      } catch (err: any) {
        log(`[quotesRouter] add comment ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to add comment" });
      }
    },
  );

  // ── PATCH /api/dashboard/clients/:id/quotes/:quoteId/comments/:commentId/resolve ──
  app.patch(
    "/api/dashboard/clients/:id/quotes/:quoteId/comments/:commentId/resolve",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId, commentId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      try {
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
      } catch (err: any) {
        log(`[quotesRouter] resolve comment ${id}/${quoteId}/${commentId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to resolve comment" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/quotes/:quoteId/send-to-client ───────
  app.post(
    "/api/dashboard/clients/:id/quotes/:quoteId/send-to-client",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      try {
        const quotes = await readQuotes(id);
        const quote = findQuote(quotes, quoteId);
        if (!quote) return res.status(404).json({ error: "Quote not found." });

        if (quote.status !== "approved") {
          return res.status(400).json({
            error: `Quote must be approved before sending to client (current: ${quote.status}).`,
          });
        }

        const clientToken = quote.clientToken ?? nanoId(32);
        const statusPageUrl = `https://internationallegalpartner.com/status/${id}?quoteToken=${clientToken}`;

        const existingLog = Array.isArray(quote.changeLog) ? quote.changeLog : [];
        const nextQuotes = quotes.map((q) =>
          (q?.quoteId ?? q?.id) === quoteId
            ? {
                ...q,
                clientVisible: true,
                sentToClientAt: now,
                clientToken,
                status: "sent_to_client",
                updatedAt: now,
                changeLog: [...existingLog, makeChangeEntry(actor, "sent_to_client", `Sent to client by ${actor}`)],
              }
            : q
        );
        await writeQuotes(id, nextQuotes);

        const clientDoc = await get(CLIENTS_COLLECTION, id);
        const clientEmail = resolveClientEmail(clientDoc ?? {}, id);
        const clientName = clientDoc?.name ?? "Client";

        if (clientEmail) {
          try {
            const quoteTitle = quote.title || "Quote";
            const emailBody = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#1a1a2e;">
              <div style="background:linear-gradient(135deg,#020d10 0%,#062028 100%);border-radius:14px 14px 0 0;padding:32px 28px 24px;">
                <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(2,181,187,.8);">International Legal Partner</p>
                <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.25;">Your quote is ready</h1>
                <p style="margin:0;font-size:14px;color:rgba(248,250,252,.65);">Hi ${clientName}, your personalized legal services quote has been prepared.</p>
              </div>
              <div style="background:#ffffff;padding:28px 28px 8px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
                <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                  Your quote <strong style="color:#0f172a;">"${quoteTitle}"</strong> is ready for your review in your secure client portal.
                </p>
                <div style="text-align:center;margin:28px 0;">
                  <a href="${statusPageUrl}" style="display:inline-block;background:#02b5bb;color:#020d10;padding:15px 32px;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;">View My Quote</a>
                </div>
              </div>
              <div style="background:#f8fafc;padding:16px 28px;border-radius:0 0 14px 14px;border:1px solid #e2e8f0;border-top:none;">
                <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center;">Questions? Reply to this email. · International Legal Partner</p>
              </div>
            </div>`;
            await enqueueEmail({
              to: clientEmail,
              subject: `Your quote is ready: "${quoteTitle}"`,
              html: emailBody,
            }, `quote_to_client_${id}_${quoteId}`).catch(() => {});
            log(`[quotesRouter] Quote ${quoteId} sent to client ${clientEmail}`);
          } catch (emailErr: any) {
            log(`[quotesRouter] send-to-client email failed (non-fatal): ${emailErr?.message}`);
          }
        }

        res.json({ success: true, quoteId, status: "sent_to_client", clientToken, statusPageUrl });
      } catch (err: any) {
        log(`[quotesRouter] send-to-client ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to send quote to client" });
      }
    },
  );

  // ── GET /api/dashboard/clients/:id/quotes/:quoteId/contract-pdf ──────────
  app.get(
    "/api/dashboard/clients/:id/quotes/:quoteId/contract-pdf",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id, quoteId } = req.params;
      try {
        const quote = findQuote(await readQuotes(id), quoteId);
        if (!quote) return res.status(404).json({ error: "Quote not found." });
        if (!quote.clientAcceptedAt && quote.status !== "client_accepted") {
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
      } catch (err: any) {
        log(`[quotesRouter] contract-pdf ${id}/${quoteId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to build the contract PDF" });
      }
    },
  );
}