/**
 * pricingRequestsRouter.ts — Internal "Pricing Requests" per client.
 *
 * A Pricing Request is the INTERNAL, client-matter request an operator authors
 * in the quoting step and sends to the pricing desk so a quote can be produced.
 * It is DISTINCT from the provider-facing `quoteRequests` subcollection (that
 * one blasts external providers — see providerQuoteRouter.ts).
 *
 * Each request is auto-numbered (Request 1, 2, 3…) and carries a legal-area /
 * jurisdiction header + one or more numbered Options (Option 1, 2…). Each option
 * has an AI-drafted (but freely editable) service line + an agnostic bullet list.
 *
 * Firestore path:  clients/{clientId}/pricing_requests/{requestId}
 *
 * Routes (all validateUser("staff")):
 *   GET    /api/dashboard/clients/:id/pricing-requests
 *   POST   /api/dashboard/clients/:id/pricing-requests                 (create draft, auto-numbered)
 *   PATCH  /api/dashboard/clients/:id/pricing-requests/:requestId      (edit header/options while draft)
 *   POST   /api/dashboard/clients/:id/pricing-requests/:requestId/options        (add option; AI-drafts service line)
 *   POST   /api/dashboard/clients/:id/pricing-requests/:requestId/suggest-line   (AI-draft a single service line)
 *   POST   /api/dashboard/clients/:id/pricing-requests/:requestId/send           (finalize + email pricing desk)
 *   DELETE /api/dashboard/clients/:id/pricing-requests/:requestId      (only while draft)
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import validateUser from "../../helper/auth/validateUser.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import del from "../../db/delete.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";
import auditLog, { auditFrom } from "../../helper/auditLog.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { callLLMWithFallback, type LlmRequest } from "../chatbot/intelligence/llm.ts";
import type { SessionUser } from "../../helper/auth/types.ts";
import { withLegalFooter } from "../../helper/emailTemplates.ts"; // COMMS-P1

// ── Helpers ───────────────────────────────────────────────────────────────────

function nanoId(size = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

/** Built-in legal-area → label (mirrors the frontend). */
const LEGAL_AREA_LABELS: Record<string, string> = {
  immigration: "Immigration",
  corporate: "Corporate",
  real_estate: "Real Estate",
  notary: "Notary",
  family_estate: "Family & Estate",
  litigation: "Litigation",
  compliance: "Compliance",
  other: "Other",
};

function firstNonEmpty(...vals: unknown[]): string {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = (typeof v === "string" ? v : String(v)).trim();
    if (s && s.toLowerCase() !== "undefined" && s.toLowerCase() !== "null") return s;
  }
  return "";
}

function field(doc: Record<string, unknown> | null, key: string): string {
  return firstNonEmpty(doc?.[key]);
}

/** Compose "City, Country" from whatever address parts exist. */
function composeLocation(doc: Record<string, unknown> | null, kind: "origin" | "destination"): string {
  const city = field(doc, `${kind}City`);
  const country = field(doc, `${kind}Country`);
  return [city, country].filter(Boolean).join(", ");
}

/** Merged legal-area labels (built-in ⊕ custom) for the AI vocabulary. */
async function loadLegalAreaLabels(): Promise<string[]> {
  const labels = Object.values(LEGAL_AREA_LABELS);
  try {
    const custom = await getAll("quote_service_types").catch(() => []);
    for (const c of custom) {
      if (c && typeof c.label === "string" && c.label.trim()) labels.push(c.label.trim());
    }
  } catch {
    /* non-fatal — built-ins still available */
  }
  return [...new Set(labels)];
}

/** AI-draft a single service line for a legal matter. */
async function generateServiceLine(input: {
  legalAreaLabels: string[];
  inferredAreaLabel: string | null;
  matterType: string | null;
  jurisdiction: string | null;
  route: string | null;
}): Promise<string> {
  const prompt = `Draft a single concise service line (one sentence, no markdown) describing a legal service for the following matter:

- Legal area: ${input.inferredAreaLabel ?? "unspecified"}
- Matter type: ${input.matterType ?? "unspecified"}
- Jurisdiction: ${input.jurisdiction ?? "unspecified"}
- Route/location: ${input.route ?? "unspecified"}

Available legal-area labels: ${input.legalAreaLabels.join(", ")}

Return ONLY the service line text.`;

  const llmReq: LlmRequest = {
    prompt,
    systemInstruction:
      "You are a legal pricing assistant for International Legal Partner. You draft concise, professional service descriptions. Reply with only the service line text.",
    temperature: 0.3,
  };

  try {
    const res = await callLLMWithFallback(llmReq);
    const line = (res.content ?? "").trim();
    return line || "Legal service (details to be confirmed)";
  } catch (err) {
    log(`[pricingRequests] service-line LLM failed: ${err instanceof Error ? err.message : err}`);
    return "Legal service (details to be confirmed)";
  }
}

/** Build the AI input for a service-line suggestion from the client doc. */
function buildServiceLineInput(
  client: Record<string, unknown> | null,
  legalAreaLabels: string[],
) {
  const insights = (client?.transcriptInsights ?? {}) as Record<string, unknown>;
  const inferredKey = typeof insights?.legalArea === "string" ? insights.legalArea : "";
  const inferredLabel = inferredKey && LEGAL_AREA_LABELS[inferredKey]
    ? LEGAL_AREA_LABELS[inferredKey]
    : null;
  const origin = composeLocation(client, "origin");
  const destination = composeLocation(client, "destination");
  const route = origin && destination ? `${origin} → ${destination}` : origin || destination || null;
  return {
    legalAreaLabels,
    inferredAreaLabel: inferredLabel,
    matterType: field(client, "matterType") || null,
    jurisdiction: field(client, "jurisdiction") || null,
    route,
  };
}

/** Normalize a single option payload into the stored shape. */
function normalizeOption(raw: unknown, index: number): Record<string, unknown> {
  const rec = (raw ?? {}) as Record<string, unknown>;
  return {
    optionId: rec?.optionId || nanoId(10),
    index,
    serviceType: typeof rec?.serviceType === "string" && rec.serviceType.trim()
      ? rec.serviceType.trim()
      : null,
    serviceLine: typeof rec?.serviceLine === "string" ? rec.serviceLine.trim() : "",
    items: Array.isArray(rec?.items)
      ? (rec.items as unknown[]).map((s) => String(s ?? "").trim()).filter(Boolean)
      : [],
  };
}

/** Renumber an options array 1..N (stable order). */
function renumberOptions(options: unknown[]): Record<string, unknown>[] {
  return (Array.isArray(options) ? options : []).map((o, i) => normalizeOption(o, i + 1));
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function pricingRequestsRouter(app: Express) {
  log("Pricing requests router initialized.");
  const base = "/api/dashboard/clients/:id/pricing-requests";

  // ── GET list ────────────────────────────────────────────────────────────
  app.get(
    base,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const requests = await getAll(`clients/${id}/pricing_requests`);
      requests.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      res.json({ requests });
    }),
  );

  // ── POST create draft (auto-numbered, header auto-filled) ─────────────────
  app.post(
    base,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as Request & { sessionUser?: SessionUser }).sessionUser?.uid ?? "unknown";
      const now = new Date().toISOString();

      const client = await get("clients", id).catch(() => null);
      const existing = await getAll(`clients/${id}/pricing_requests`).catch(() => []);
      const nextIndex = existing.reduce((m, r) => Math.max(m, Number(r.index ?? 0)), 0) + 1;

      const requestId = nanoId(14);
      const requestDoc: Record<string, unknown> = {
        requestId,
        clientId: id,
        index: nextIndex,
        originLabel: composeLocation(client, "origin"),
        destinationLabel: composeLocation(client, "destination"),
        originNotes: typeof req.body?.originNotes === "string" ? req.body.originNotes.trim() : "",
        destinationNotes: typeof req.body?.destinationNotes === "string"
          ? req.body.destinationNotes.trim()
          : "",
        options: renumberOptions(req.body?.options ?? []),
        status: "draft",
        createdAt: now,
        createdBy: actor,
        sentAt: null,
        sentBy: null,
        updatedAt: null,
      };
      await put(`clients/${id}/pricing_requests`, requestId, requestDoc);
      log(`[pricingRequests] Request #${nextIndex} (${requestId}) created for ${id} by ${actor}`);
      res.status(201).json({ success: true, request: requestDoc });
    }),
  );

  // ── PATCH edit (header + options) while draft ─────────────────────────────
  app.patch(
    `${base}/:requestId`,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id, requestId } = req.params;
      const now = new Date().toISOString();

      const existing = await get(`clients/${id}/pricing_requests`, requestId);
      if (!existing) return res.status(404).json({ error: "Pricing request not found." });
      if (existing.status === "sent") {
        return res.status(400).json({ error: "A sent pricing request can no longer be edited." });
      }
      const updates: Record<string, unknown> = { updatedAt: now };
      if ("originNotes" in (req.body ?? {})) updates.originNotes = String(req.body.originNotes ?? "").trim();
      if ("destinationNotes" in (req.body ?? {})) {
        updates.destinationNotes = String(req.body.destinationNotes ?? "").trim();
      }
      if ("originLabel" in (req.body ?? {})) updates.originLabel = String(req.body.originLabel ?? "").trim();
      if ("destinationLabel" in (req.body ?? {})) {
        updates.destinationLabel = String(req.body.destinationLabel ?? "").trim();
      }
      if ("options" in (req.body ?? {})) updates.options = renumberOptions(req.body.options);

      await patch(`clients/${id}/pricing_requests`, requestId, updates);
      res.json({ success: true, requestId, request: { ...existing, ...updates } });
    }),
  );

  // ── POST add option (AI-drafts the placeholder service line) ──────────────
  app.post(
    `${base}/:requestId/options`,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id, requestId } = req.params;
      const now = new Date().toISOString();

      const existing = await get(`clients/${id}/pricing_requests`, requestId);
      if (!existing) return res.status(404).json({ error: "Pricing request not found." });
      if (existing.status === "sent") {
        return res.status(400).json({ error: "A sent pricing request can no longer be edited." });
      }
      const client = await get("clients", id).catch(() => null);
      const legalAreaLabels = await loadLegalAreaLabels();
      const serviceLine = await generateServiceLine(
        buildServiceLineInput(client, legalAreaLabels),
      );
      const options = renumberOptions([
        ...(Array.isArray(existing.options) ? existing.options : []),
        { serviceLine, items: [] },
      ]);
      await patch(`clients/${id}/pricing_requests`, requestId, { options, updatedAt: now });
      res.status(201).json({ success: true, options, newOption: options[options.length - 1] });
    }),
  );

  // ── POST suggest a service line (AI) without persisting ───────────────────
  app.post(
    `${base}/:requestId/suggest-line`,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const client = await get("clients", id).catch(() => null);
      const legalAreaLabels = await loadLegalAreaLabels();
      const input = buildServiceLineInput(client, legalAreaLabels);
      const svc = typeof req.body?.serviceType === "string" ? req.body.serviceType.trim() : "";
      if (svc) {
        input.inferredAreaLabel = LEGAL_AREA_LABELS[svc] ??
          (await get("quote_service_types", svc).catch(() => null))?.label ??
          input.inferredAreaLabel;
      }
      const serviceLine = await generateServiceLine(input);
      res.json({ serviceLine });
    }),
  );

  // ── POST send (finalize + email the pricing desk) ─────────────────────────
  app.post(
    `${base}/:requestId/send`,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id, requestId } = req.params;
      const actor = (req as Request & { sessionUser?: SessionUser }).sessionUser?.uid ?? "unknown";
      const now = new Date().toISOString();

      const existing = await get(`clients/${id}/pricing_requests`, requestId);
      if (!existing) return res.status(404).json({ error: "Pricing request not found." });
      if (existing.status === "sent") {
        return res.status(400).json({ error: "This pricing request was already sent." });
      }
      const options = "options" in (req.body ?? {})
        ? renumberOptions(req.body.options)
        : renumberOptions(existing.options as unknown[]);
      const originNotes = "originNotes" in (req.body ?? {})
        ? String(req.body.originNotes ?? "").trim()
        : existing.originNotes ?? "";
      const destinationNotes = "destinationNotes" in (req.body ?? {})
        ? String(req.body.destinationNotes ?? "").trim()
        : existing.destinationNotes ?? "";

      const client = await get("clients", id).catch(() => null);
      const clientName = [field(client, "name"), field(client, "surname")]
        .filter(Boolean).join(" ") || "Client";
      const clientEmail = field(client, "email") || id;

      const sent: Record<string, unknown> = {
        ...existing,
        options,
        originNotes,
        destinationNotes,
        status: "sent",
        sentAt: now,
        sentBy: actor,
        updatedAt: now,
      };
      await patch(`clients/${id}/pricing_requests`, requestId, {
        options,
        originNotes,
        destinationNotes,
        status: "sent",
        sentAt: now,
        sentBy: actor,
        updatedAt: now,
      });

      // ── Compose + send the internal pricing-desk email ────────────────────
      try {
        const esc = (v: unknown) =>
          String(v ?? "").replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">");
        const optionsHtml = options.length
          ? options.map((o) => {
            const items = Array.isArray(o.items) ? (o.items as string[]) : [];
            const bullets = items.length
              ? `<ul style="margin:6px 0 0;padding-left:18px;color:#334155;font-size:13px;">${
                items.map((it) => `<li>${esc(it)}</li>`).join("")
              }</ul>`
              : `<p style="margin:6px 0 0;color:#94a3b8;font-size:12px;font-style:italic;">No line items listed.</p>`;
            return `<div style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <p style="margin:0;font-weight:700;color:#0f172a;font-size:13px;">Option ${o.index} · ${esc(o.serviceLine || "—")}</p>
              <p style="margin:8px 0 0;color:#475569;font-size:12px;">Please quote a complete service including:</p>
              ${bullets}
            </div>`;
          }).join("")
          : `<div style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
              <p style="margin:0;color:#475569;font-size:12px;">No specific options were provided — please quote based on the legal area / jurisdiction and any notes above.</p>
            </div>`;

        const rows: Array<{ label: string; value: string }> = [
          { label: "Client", value: clientName },
          { label: "Email", value: clientEmail },
          {
            label: "Origin",
            value: `${sent.originLabel || "—"}${originNotes ? ` (${esc(originNotes)})` : ""}`,
          },
          {
            label: "Destination",
            value: `${sent.destinationLabel || "—"}${destinationNotes ? ` (${esc(destinationNotes)})` : ""}`,
          },
        ];
        rows.push({ label: "Options", value: String(options.length) });

        const html = `
          <div style="font-family:'Jost',sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#fafbfc;border-radius:16px;">
            <h1 style="font-size:22px;font-weight:800;color:#0f172a;margin:0 0 16px;">Pricing Request #${sent.index} — ${esc(clientName)}</h1>
            <p style="font-size:14px;color:#334155;line-height:1.6;margin:0 0 16px;">
              Operator <strong>${esc(actor)}</strong> has requested a quote for <strong>${esc(clientName)}</strong>
              (<code>${esc(clientEmail)}</code>). The requested service options are below.
            </p>
            <div style="margin-top:14px;">${optionsHtml}</div>
            <table style="width:100%;border-collapse:collapse;margin-top:16px;">
              ${rows.map((r) => `<tr><td style="padding:6px 8px;color:#64748b;font-size:13px;font-weight:600;">${r.label}</td><td style="padding:6px 8px;color:#0f172a;font-size:13px;">${esc(r.value)}</td></tr>`).join("")}
            </table>
          </div>
        `;

        const pricingDeskEmail = Deno.env.get("PRICING_DESK_EMAIL") || "pricing@internationallegalpartner.com";
        const subject = `Pricing Request #${sent.index} — ${clientName}`;
        await enqueueEmail(
          { to: pricingDeskEmail, subject, html: withLegalFooter(html) }, // COMMS-P1: legal footer
          `pricing_request_${requestId}`,
        );
      } catch (emailErr) {
        log(`[pricingRequests] send email failed (non-fatal): ${emailErr instanceof Error ? emailErr.message : emailErr}`);
      }

      await auditLog({
        actor: auditFrom((req as Request & { sessionUser?: SessionUser }).sessionUser),
        action: "pricing_request.sent",
        target: `clients/${id}/pricing_requests/${requestId}`,
        meta: { clientName, clientEmail, requestIndex: sent.index },
      });

      log(`[pricingRequests] Request ${requestId} sent for ${id} by ${actor}`);
      res.json({ success: true, request: sent });
    }),
  );

  // ── DELETE (only while draft) ─────────────────────────────────────────────
  app.delete(
    `${base}/:requestId`,
    validateUser("staff"),
    asyncHandler(async (req: Request, res: Response) => {
      const { id, requestId } = req.params;
      const existing = await get(`clients/${id}/pricing_requests`, requestId);
      if (!existing) return res.status(404).json({ error: "Pricing request not found." });
      if (existing.status === "sent") {
        return res.status(400).json({ error: "A sent pricing request cannot be deleted." });
      }
      await del(`clients/${id}/pricing_requests`, requestId);
      res.json({ success: true, requestId });
    }),
  );
}