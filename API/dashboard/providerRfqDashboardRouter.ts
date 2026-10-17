/**
 * providerRfqDashboardRouter.ts — DASHBOARD-side view of a client's RFQ
 * ("Sondeo") provider responses. Powers the per-client "Providers" tab.
 *
 * The provider-FACING flow (send + token-gated respond) lives in
 * API/provider/providerQuoteRouter.ts. This router is purely additive and
 * dashboard-authenticated; it lets an operator:
 *   • LIST every quoteRequest for a client, enriched with the provider's
 *     quality score (for the deterministic best-option calc) and any operator
 *     rate override (the editable "field-map").
 *   • SET an operator rate override per response (vendor-submitted value is kept
 *     separately, so the UI can show "vendor said X → changed to Y").
 *   • SET the expected-margin default (per client, default 20%).
 *
 * Firestore:
 *   clients/{id}                              — stores rfqExpectedMarginPct
 *   clients/{id}/quoteRequests/{requestId}    — the RFQ docs (unchanged
 *                                                shape + additive fields:
 *                                                operatorOverride, reviewedAt)
 *
 * Routes (all validateUser("staff")):
 *   GET   /api/dashboard/clients/:id/quote-requests
 *   PATCH /api/dashboard/clients/:id/quote-requests/:requestId
 *   PATCH /api/dashboard/clients/:id/rfq-expected-margin
 *   POST  /api/dashboard/rfq/translate-edit
 *   POST  /api/dashboard/rfq/translate-fields
 *
 * Backward compatible: reads tolerate missing additive fields; nothing here
 * mutates the provider-facing flow.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import patch from "../../db/patch.ts";
import log from "../../helper/log.ts";
import { callLLMWithFallback, type LlmRequest } from "../chatbot/intelligence/llm.ts";
import type { SessionUser } from "../../helper/auth/types.ts";

const DEFAULT_MARGIN_PCT = 20;

/** RFQ personalization placeholders the backend fills per-recipient at send. */
const RFQ_PLACEHOLDERS = ["{{providerName}}", "{{submitUrl}}"] as const;

/** Count occurrences of every RFQ placeholder in a string. */
function placeholderCounts(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ph of RFQ_PLACEHOLDERS) {
    out[ph] = (s.match(new RegExp(ph.replace(/[{}]/g, "\\$&"), "g")) ?? []).length;
  }
  return out;
}

/** True when both strings carry the SAME count of every placeholder. */
function placeholdersPreserved(before: string, after: string): boolean {
  const a = placeholderCounts(before);
  const b = placeholderCounts(after);
  return RFQ_PLACEHOLDERS.every((ph) => a[ph] === b[ph]);
}

function requestsPath(clientId: string): string {
  return `clients/${clientId}/quoteRequests`;
}

/** Clamp + sanitise a margin percentage into [0, 95]. */
function normaliseMargin(raw: unknown): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) return DEFAULT_MARGIN_PCT;
  return Math.max(0, Math.min(95, Math.round(n * 100) / 100));
}

function toNumberOrNull(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

export default function providerRfqDashboardRouter(app: Express) {
  log("Provider RFQ dashboard router initialized.");

  // ── GET list of quote requests (enriched) ───────────────────────────────────
  app.get(
    "/api/dashboard/clients/:id/quote-requests",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const [requests, providers, client] = await Promise.all([
        getAll(requestsPath(id)),
        getAll("providers").catch(() => []),
        get("clients", id).catch(() => null),
      ]);

      const scoreById = new Map<string, number | null>();
      for (const p of providers) {
        const pid = String(p.id ?? "");
        if (pid) scoreById.set(pid, typeof p.score === "number" ? p.score : null);
      }

      const enriched = requests
        .map((r) => ({
          requestId: r.requestId,
          providerId: r.providerId,
          providerName: r.providerName,
          providerEmail: r.providerEmail,
          status: r.status,
          sentAt: r.sentAt ?? null,
          expiresAt: r.expiresAt ?? null,
          providerResponse: (r.providerResponse ?? null) as Record<string, unknown> | null,
          operatorOverride: r.operatorOverride ?? null,
          reviewedAt: r.reviewedAt ?? null,
          reviewedBy: r.reviewedBy ?? null,
          providerScore: scoreById.has(String(r.providerId))
            ? scoreById.get(String(r.providerId))
            : null,
        }))
        .sort((a, b) => String(b.sentAt ?? "").localeCompare(String(a.sentAt ?? "")));

      // A response that has a price but hasn't been reviewed by an operator.
      const pendingReviewCount = enriched.filter(
        (r) => r.providerResponse && r.providerResponse.price != null && !r.reviewedAt,
      ).length;

      const expectedMarginPct =
        client && typeof client.rfqExpectedMarginPct === "number"
          ? client.rfqExpectedMarginPct
          : DEFAULT_MARGIN_PCT;

      res.json({ quoteRequests: enriched, expectedMarginPct, pendingReviewCount });
    }),
  );

  // ── PATCH an operator rate override on one response (the field-map) ──────────
  app.patch(
    "/api/dashboard/clients/:id/quote-requests/:requestId",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id, requestId } = req.params;
      const actor = (req as Request & { sessionUser?: SessionUser }).sessionUser?.uid ?? "unknown";
      const now = new Date().toISOString();

      const existing = await get(requestsPath(id), requestId);
      if (!existing) return res.status(404).json({ error: "Quote request not found." });

      const body = req.body ?? {};
      const updates: Record<string, unknown> = {};

      // Operator override rate/currency/notes. Passing `clearOverride: true`
      // removes the operator value (falls back to the vendor-submitted one).
      if (body.clearOverride === true) {
        updates.operatorOverride = null;
      } else if ("price" in body || "currency" in body || "notes" in body) {
        const prev = (existing.operatorOverride ?? {}) as Record<string, unknown>;
        updates.operatorOverride = {
          price: "price" in body ? toNumberOrNull(body.price) : prev.price ?? null,
          currency: "currency" in body
            ? String(body.currency ?? "").trim() || null
            : prev.currency ?? null,
          notes: "notes" in body ? String(body.notes ?? "") : prev.notes ?? "",
          overriddenBy: actor,
          overriddenAt: now,
        };
      }

      // Mark reviewed (clears the pending badge for this response).
      if (body.markReviewed === true) {
        updates.reviewedAt = now;
        updates.reviewedBy = actor;
      } else if (body.markReviewed === false) {
        updates.reviewedAt = null;
        updates.reviewedBy = null;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No recognised fields to update." });
      }

      await patch(requestsPath(id), requestId, updates);
      log(`[providerRfqDashboard] ${id}/${requestId} updated by ${actor}`);
      res.json({ success: true, requestId, updated: Object.keys(updates) });
    }),
  );

  // ── PATCH the per-client expected margin (default 20%) ───────────────────────
  app.patch(
    "/api/dashboard/clients/:id/rfq-expected-margin",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as Request & { sessionUser?: SessionUser }).sessionUser?.uid ?? "unknown";

      const existing = await get("clients", id);
      if (!existing) return res.status(404).json({ error: "Client not found." });

      const rfqExpectedMarginPct = normaliseMargin(req.body?.expectedMarginPct);
      await patch("clients", id, { rfqExpectedMarginPct });
      log(`[providerRfqDashboard] ${id} expected margin → ${rfqExpectedMarginPct}% by ${actor}`);
      res.json({ success: true, expectedMarginPct: rfqExpectedMarginPct });
    }),
  );

  // ── POST translate an EDITED RFQ email into another language ─────────────────
  app.post(
    "/api/dashboard/rfq/translate-edit",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const bodyHtml = String(req.body?.bodyHtml ?? "");
      const subject = String(req.body?.subject ?? "");
      const targetLangName = String(req.body?.targetLangName ?? "").trim();

      if (!bodyHtml.trim() && !subject.trim()) {
        return res.status(400).json({ error: "Nothing to translate." });
      }
      if (!targetLangName) {
        return res.status(400).json({ error: "Missing target language." });
      }

      const prompt = `Translate the SUBJECT and HTML BODY of the email below into ${targetLangName}.

STRICT RULES:
- Translate ONLY human-readable text. Preserve ALL HTML tags, attributes, inline styles and structure exactly.
- NEVER translate, remove, or reformat the placeholders {{providerName}} and {{submitUrl}} — keep them verbatim and in place.
- Keep proper nouns, email addresses, URLs and numbers unchanged.
- Do not add, remove, or reorder content.

Return ONLY a JSON object: { "subject": "<translated subject>", "bodyHtml": "<translated html>" }
No markdown, no commentary.

SUBJECT:
${subject}

HTML BODY:
${bodyHtml}`;

      const llmReq: LlmRequest = {
        prompt,
        systemInstruction:
          "You are a professional localization engine for International Legal Partner. You translate HTML emails while preserving markup and templating placeholders. Reply only with a JSON object.",
        temperature: 0.1,
      };

      let translatedSubject = subject;
      let translatedBody = bodyHtml;
      let translated = false;

      try {
        const llmRes = await callLLMWithFallback(llmReq);
        const jsonText = (llmRes.content ?? "").replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(jsonText);
        const outSubject = typeof parsed.subject === "string" ? parsed.subject : subject;
        const outBody = typeof parsed.bodyHtml === "string" ? parsed.bodyHtml : bodyHtml;

        if (
          placeholdersPreserved(subject, outSubject) &&
          placeholdersPreserved(bodyHtml, outBody)
        ) {
          translatedSubject = outSubject;
          translatedBody = outBody;
          translated = true;
        } else {
          log(`[providerRfqDashboard] translate-edit dropped a placeholder — falling back`);
        }
      } catch (llmErr) {
        log(`[providerRfqDashboard] translate-edit LLM failed: ${llmErr instanceof Error ? llmErr.message : llmErr}`);
      }

      res.json({ translated, subject: translatedSubject, bodyHtml: translatedBody });
    }),
  );

  // ── POST translate the RFQ template FIELDS into the selected language ─────────
  app.post(
    "/api/dashboard/rfq/translate-fields",
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const src = (req.body?.fields ?? {}) as Record<string, unknown>;
      const targetLangName = String(req.body?.targetLangName ?? "").trim();

      const legalArea = String(src.legalArea ?? "");
      const jurisdiction = String(src.jurisdiction ?? "");
      const matterType = String(src.matterType ?? "");
      const documents = Array.isArray(src.documents)
        ? (src.documents as unknown[]).map((x) => String(x ?? ""))
        : [];
      const notes = String(src.notes ?? "");

      const original = { legalArea, jurisdiction, matterType, documents, notes };

      if (!targetLangName) {
        return res.status(400).json({ error: "Missing target language." });
      }

      const hasContent =
        legalArea.trim() ||
        jurisdiction.trim() ||
        matterType.trim() ||
        notes.trim() ||
        documents.some((x) => x.trim());
      if (!hasContent) {
        return res.json({ translated: false, fields: original });
      }

      const prompt = `Translate the human-readable VALUES of the following legal RFQ fields into ${targetLangName}.

STRICT RULES:
- Translate ONLY natural-language text. Keep technical codes, legal terms of art, abbreviations, proper nouns and numbers verbatim (e.g. "immigration", "corporate", "real_estate", "notary").
- Preserve the array length and order of "documents". Translate each entry's text but keep any leading labels like "Document #1:" / "Documento #1:" appropriately localized.
- Do not add, remove, merge or reorder fields.
- If a value is already in ${targetLangName}, return it unchanged.

Return ONLY a JSON object with EXACTLY these keys:
{ "legalArea": "", "jurisdiction": "", "matterType": "", "documents": [], "notes": "" }
No markdown, no commentary.

FIELDS (JSON):
${JSON.stringify(original)}`;

      const llmReq: LlmRequest = {
        prompt,
        systemInstruction:
          "You are a professional localization engine for International Legal Partner. You translate short legal form values while preserving technical codes and JSON structure. Reply only with a JSON object.",
        temperature: 0.1,
      };

      let fields = original;
      let translated = false;

      try {
        const llmRes = await callLLMWithFallback(llmReq);
        const jsonText = (llmRes.content ?? "").replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(jsonText);

        const outDocuments = Array.isArray(parsed.documents)
          ? parsed.documents.map((x: unknown) => String(x ?? ""))
          : documents;

        if (outDocuments.length === documents.length) {
          fields = {
            legalArea: typeof parsed.legalArea === "string" ? parsed.legalArea : legalArea,
            jurisdiction: typeof parsed.jurisdiction === "string" ? parsed.jurisdiction : jurisdiction,
            matterType: typeof parsed.matterType === "string" ? parsed.matterType : matterType,
            documents: outDocuments,
            notes: typeof parsed.notes === "string" ? parsed.notes : notes,
          };
          translated = true;
        } else {
          log(`[providerRfqDashboard] translate-fields document-count mismatch — falling back`);
        }
      } catch (llmErr) {
        log(`[providerRfqDashboard] translate-fields LLM failed: ${llmErr instanceof Error ? llmErr.message : llmErr}`);
      }

      res.json({ translated, fields });
    }),
  );
}