/**
 * quoteTemplatesRouter.ts — CRUD for reusable Quote Document Templates.
 *
 * A QuoteTemplate is a named collection of QuoteBlocks that can be applied
 * to any quote, giving it a proposal document layout.
 *
 * Firestore: quote_templates/{templateId}  (top-level collection)
 *
 * Routes
 * ──────
 *   GET    /api/dashboard/quote-templates              list all (newest first)
 *   GET    /api/dashboard/quote-templates/:templateId  get one
 *   POST   /api/dashboard/quote-templates              create
 *   PATCH  /api/dashboard/quote-templates/:templateId  partial update
 *   DELETE /api/dashboard/quote-templates/:templateId  delete
 *   GET    /api/template/:templateId                   public-safe subset
 *   PATCH  /api/dashboard/clients/:id/proposal-blocks-override
 *   POST   /api/dashboard/clients/:id/infer-template
 *
 * Auth: dashboard routes require requireDashboardAuth; the public template
 * read is unauthenticated so the status page can render proposals.
 */

import type { Express, Request, Response } from "express";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";
import patch from "../../db/patch.ts";
import remove from "../../db/delete.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";
import { callLLMWithFallback } from "../chatbot/intelligence/llm.ts";
import type { LlmRequest } from "../chatbot/intelligence/llm.ts";
import { loadQuoteTemplateMap, resolveTemplateFromMap } from "./quoteTemplateMapRouter.ts";

const COLLECTION = "quote_templates";
const CLIENTS_COLLECTION = "clients";
const DEFAULT_TEMPLATE_ID = "ilp-standard-proposal";

// ── Helpers ───────────────────────────────────────────────────────────────────

function nanoId(size = 14): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

/** Validate and normalise a blocks array from the request body. */
function normaliseBlocks(raw: any[]): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b) => ({
    id: typeof b.id === "string" && b.id ? b.id : nanoId(10),
    type: String(b.type || "html"),
    html: typeof b.html === "string" ? b.html : null,
    data: b.data && typeof b.data === "object" ? b.data : null,
    ...(typeof b.section === "string" && b.section.trim()
      ? { section: b.section.trim() }
      : {}),
  }));
}

// ── Rule-based template matcher ────────────────────────────────────────────────

/**
 * Deterministic rule engine: picks the best templateId using the client's
 * jurisdiction + legal area. Returns null when rules can't produce a confident
 * single match (LLM fallback will handle it).
 */
function ruleMatchTemplate(
  client: Record<string, any>,
  templates: any[],
): string | null {
  const jurisdiction = (client.jurisdiction ?? "").toLowerCase().trim();
  const legalArea = (client.legalArea ?? "").toLowerCase().trim();

  const forJurisdiction = templates.filter((t) => {
    if (!Array.isArray(t.jurisdictions) || t.jurisdictions.length === 0) return false;
    return t.jurisdictions.some(
      (c: string) => c.toLowerCase().includes(jurisdiction) || jurisdiction.includes(c.toLowerCase()),
    );
  });

  if (forJurisdiction.length === 0) return null;

  // Narrow by legal area when a template declares one.
  if (legalArea) {
    const forArea = forJurisdiction.filter((t) => {
      if (!Array.isArray(t.legalAreas) || t.legalAreas.length === 0) return true;
      return t.legalAreas.some(
        (a: string) => a.toLowerCase().includes(legalArea) || legalArea.includes(a.toLowerCase()),
      );
    });
    if (forArea.length > 0) return forArea[0].templateId;
  }

  return forJurisdiction[0].templateId;
}

// ── Default Template Builder ──────────────────────────────────────────────────
// Called once by the auto-bootstrap on first GET of the list.
// Tokens like {{client.fullName}} are substituted at render-time by BlockRenderer.
function buildDefaultTemplate(): Record<string, any> {
  return {
    templateId: DEFAULT_TEMPLATE_ID,
    name: "ILP Standard Proposal",
    description: "Default ILP proposal template — banner + intro + quote table + T&Cs + acceptance CTA. Merge fields are substituted at render-time from the client data.",
    category: "standard",
    isDefault: true,
    order: 0,
    jurisdictions: [],
    legalAreas: [],
    createdBy: "system",
    createdAt: new Date().toISOString(),
    updatedAt: null,
    blocks: [
      {
        id: "ilp-std-banner",
        type: "banner",
        html: `<div style="background:linear-gradient(135deg,#0f172a 0%,#123b5d 60%,#0d3140 100%);padding:52px 48px 44px;border-radius:0;text-align:center;color:#fff;">
<h1 style="font-family:'Jost',sans-serif;font-size:2rem;font-weight:900;letter-spacing:-0.03em;color:#fff;margin:0 0 10px;">Your Legal Services Proposal</h1>
<p style="font-size:1.05rem;color:rgba(255,255,255,0.75);margin:0;font-weight:400;">Prepared personally for <strong style="color:#02b5bb;">{{client.fullName}}</strong></p>
</div>`,
        data: null,
      },
      {
        id: "ilp-std-intro",
        type: "html",
        html: `<div style="padding:40px 48px 32px;background:#fff;">
<h2 style="font-family:'Jost',sans-serif;font-size:1.45rem;font-weight:800;color:#0f172a;letter-spacing:-0.02em;margin:0 0 14px;">Dear {{client.fullName}},</h2>
<p style="font-size:1rem;line-height:1.75;color:#334155;margin:0 0 20px;">Thank you for trusting <strong>International Legal Partner</strong> with your matter. Below you will find the complete service breakdown, pricing, and acceptance form for your engagement.</p>
<table style="width:100%;border-collapse:collapse;font-family:'Jost',sans-serif;font-size:0.92rem;">
  <tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#64748b;font-weight:700;width:38%;border-bottom:1px solid #f1f5f9;">Jurisdiction</td><td style="padding:10px 14px;color:#0f172a;border-bottom:1px solid #f1f5f9;">{{matter.jurisdiction}}</td></tr>
  <tr><td style="padding:10px 14px;color:#64748b;font-weight:700;border-bottom:1px solid #f1f5f9;">Legal Area</td><td style="padding:10px 14px;color:#0f172a;border-bottom:1px solid #f1f5f9;">{{matter.legalArea}}</td></tr>
  <tr style="background:#f8fafc;"><td style="padding:10px 14px;color:#64748b;font-weight:700;">Matter</td><td style="padding:10px 14px;color:#0f172a;">{{matter.legalMatter}}</td></tr>
</table>
</div>`,
        data: null,
      },
      {
        id: "ilp-std-quotetable",
        type: "quoteTable",
        html: null,
        data: null,
      },
      {
        id: "ilp-std-terms",
        type: "accordion",
        html: `<div style="padding:32px 48px;background:#f8fafc;border-top:2px solid #e2e8f0;">
<h3 style="font-family:'Jost',sans-serif;font-size:1.05rem;font-weight:800;color:#0f172a;margin:0 0 20px;letter-spacing:-0.01em;">Terms & Conditions</h3>
<div style="display:flex;flex-direction:column;gap:14px;font-size:0.88rem;line-height:1.7;color:#475569;">
  <div><strong style="color:#0f172a;">1. Payment Terms.</strong> A reservation payment is required to confirm engagement. The remaining balance is due per the payment schedule. All prices are quoted in the currency indicated per line item.</div>
  <div><strong style="color:#0f172a;">2. Scope.</strong> This proposal covers the services listed above. Any additional services requested after acceptance will be quoted separately and require written approval.</div>
  <div><strong style="color:#0f172a;">3. Confidentiality.</strong> All information shared in connection with this matter is held in confidence in accordance with applicable professional obligations.</div>
  <div><strong style="color:#0f172a;">4. Changes & Cancellations.</strong> Changes to scope may affect pricing. Cancellations after acceptance are subject to the terms stated in the engagement agreement.</div>
</div>
</div>`,
        data: null,
      },
      {
        id: "ilp-std-accept",
        type: "accept",
        html: null,
        data: null,
      },
    ],
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export default function quoteTemplatesRouter(app: Express) {
  app.get(
    "/api/dashboard/quote-templates",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const templates = await getAll(COLLECTION);

        const hasDefault = templates.some((t: any) => t.templateId === DEFAULT_TEMPLATE_ID);
        if (!hasDefault) {
          try {
            const defaultDoc = buildDefaultTemplate();
            await put(COLLECTION, DEFAULT_TEMPLATE_ID, defaultDoc);
            templates.unshift(defaultDoc as unknown as (typeof templates)[number]);
            log(`[quoteTemplatesRouter] Auto-seeded default template "${DEFAULT_TEMPLATE_ID}"`);
          } catch (seedErr: any) {
            log(`[quoteTemplatesRouter] Auto-seed skipped: ${seedErr?.message}`);
          }
        }

        templates.sort((a: any, b: any) => {
          const aPin = a.isDefault ? 0 : 1;
          const bPin = b.isDefault ? 0 : 1;
          if (aPin !== bPin) return aPin - bPin;
          const aOrd = typeof a.order === "number" ? a.order : 9999;
          const bOrd = typeof b.order === "number" ? b.order : 9999;
          if (aOrd !== bOrd) return aOrd - bOrd;
          return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
        });

        res.json({ templates });
      } catch (err: any) {
        log(`[quoteTemplatesRouter] list: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to list templates" });
      }
    },
  );

  app.get(
    "/api/dashboard/quote-templates/:templateId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { templateId } = req.params;
      try {
        const template = await get(COLLECTION, templateId);
        if (!template) return res.status(404).json({ error: "Template not found." });
        res.json(template);
      } catch (err: any) {
        log(`[quoteTemplatesRouter] get ${templateId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to fetch template" });
      }
    },
  );

  app.post(
    "/api/dashboard/quote-templates",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const actor = (req as any).dashboardUser ?? "unknown";
      const now = new Date().toISOString();

      const {
        name,
        description = null,
        category = null,
        blocks = [],
        jurisdictions = [],
        legalAreas = [],
      } = req.body ?? {};

      if (!name?.trim()) {
        return res.status(400).json({ error: "name is required." });
      }

      const templateId = nanoId(14);
      const doc = {
        templateId,
        name: String(name).trim(),
        description: description?.trim() || null,
        category: category?.trim() || null,
        blocks: normaliseBlocks(blocks),
        jurisdictions: Array.isArray(jurisdictions) ? jurisdictions : [],
        legalAreas: Array.isArray(legalAreas) ? legalAreas : [],
        createdBy: actor,
        createdAt: now,
        updatedAt: null,
      };

      try {
        await put(COLLECTION, templateId, doc);
        log(`[quoteTemplatesRouter] Created ${templateId} ("${doc.name}") by ${actor}`);
        res.status(201).json({ success: true, template: doc });
      } catch (err: any) {
        log(`[quoteTemplatesRouter] create: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to create template" });
      }
    },
  );

  app.patch(
    "/api/dashboard/quote-templates/:templateId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { templateId } = req.params;
      const now = new Date().toISOString();

      try {
        const existing = await get(COLLECTION, templateId);
        if (!existing) return res.status(404).json({ error: "Template not found." });

        const updates: Record<string, any> = { updatedAt: now };
        const changed: string[] = [];

        for (const key of ["name", "description", "category"] as const) {
          if (key in (req.body ?? {})) {
            updates[key] = req.body[key]?.trim() || null;
            changed.push(key);
          }
        }
        if ("blocks" in (req.body ?? {})) {
          updates.blocks = normaliseBlocks(req.body.blocks ?? []);
          changed.push("blocks");
        }
        if ("jurisdictions" in (req.body ?? {})) {
          updates.jurisdictions = Array.isArray(req.body.jurisdictions) ? req.body.jurisdictions : [];
          changed.push("jurisdictions");
        }
        if ("legalAreas" in (req.body ?? {})) {
          updates.legalAreas = Array.isArray(req.body.legalAreas) ? req.body.legalAreas : [];
          changed.push("legalAreas");
        }

        if ("name" in updates && !updates.name) {
          return res.status(400).json({ error: "name cannot be empty." });
        }

        await patch(COLLECTION, templateId, updates);
        log(`[quoteTemplatesRouter] Updated ${templateId}: [${changed.join(", ")}]`);
        res.json({ success: true, templateId, updatedFields: changed });
      } catch (err: any) {
        log(`[quoteTemplatesRouter] patch ${templateId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to update template" });
      }
    },
  );

  app.delete(
    "/api/dashboard/quote-templates/:templateId",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { templateId } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      try {
        await remove(COLLECTION, templateId);
        log(`[quoteTemplatesRouter] Deleted ${templateId} by ${actor}`);
        res.json({ success: true, templateId });
      } catch (err: any) {
        log(`[quoteTemplatesRouter] delete ${templateId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to delete template" });
      }
    },
  );

  // ── PUBLIC: GET /api/template/:templateId ─────────────────────────────────
  app.get(
    "/api/template/:templateId",
    async (req: Request, res: Response) => {
      const { templateId } = req.params;
      try {
        const template = await get(COLLECTION, templateId);
        if (!template) {
          const fallback = await get(COLLECTION, DEFAULT_TEMPLATE_ID);
          if (!fallback) return res.status(404).json({ error: "Template not found." });
          return res.json({
            templateId: fallback.templateId,
            name: fallback.name,
            blocks: fallback.blocks ?? [],
          });
        }
        res.json({
          templateId: template.templateId,
          name: template.name,
          blocks: template.blocks ?? [],
        });
      } catch (err: any) {
        log(`[quoteTemplatesRouter] public-get ${templateId}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to fetch template" });
      }
    },
  );

  // ── PATCH /api/dashboard/clients/:id/proposal-blocks-override ─────────────
  app.patch(
    "/api/dashboard/clients/:id/proposal-blocks-override",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";
      const templateId = typeof req.body?.templateId === "string" ? req.body.templateId.trim() : "";
      const blocksRaw = req.body?.blocks;

      if (!templateId) return res.status(400).json({ error: "templateId is required." });
      if (blocksRaw !== null && !Array.isArray(blocksRaw)) {
        return res.status(400).json({ error: "blocks must be an array of QuoteBlocks, or null to reset." });
      }

      try {
        const client = await get(CLIENTS_COLLECTION, id);
        if (!client) return res.status(404).json({ error: "Client not found." });

        const existing: Record<string, any> =
          client.proposalOverrides &&
          typeof client.proposalOverrides === "object" &&
          !Array.isArray(client.proposalOverrides)
            ? { ...client.proposalOverrides }
            : {};

        const now = new Date().toISOString();

        if (blocksRaw === null) {
          delete existing[templateId];
          await patch(CLIENTS_COLLECTION, id, { proposalOverrides: existing });
          log(`[quoteTemplatesRouter] proposal-override CLEARED for ${id} / ${templateId} by ${actor}`);
          return res.json({ success: true, templateId, cleared: true, proposalOverrides: existing });
        }

        existing[templateId] = {
          blocks: normaliseBlocks(blocksRaw),
          updatedAt: now,
          updatedBy: actor,
        };
        await patch(CLIENTS_COLLECTION, id, { proposalOverrides: existing });
        log(`[quoteTemplatesRouter] proposal-override SAVED for ${id} / ${templateId} (${existing[templateId].blocks.length} blocks) by ${actor}`);
        return res.json({
          success: true,
          templateId,
          cleared: false,
          override: existing[templateId],
          proposalOverrides: existing,
        });
      } catch (err: any) {
        log(`[quoteTemplatesRouter] proposal-blocks-override ${id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to save proposal override" });
      }
    },
  );

  // ── POST /api/dashboard/clients/:id/infer-template ────────────────────────
  app.post(
    "/api/dashboard/clients/:id/infer-template",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id } = req.params;
      const actor = (req as any).dashboardUser ?? "unknown";

      try {
        const [client, templates] = await Promise.all([
          get(CLIENTS_COLLECTION, id),
          getAll(COLLECTION),
        ]);

        if (!client) return res.status(404).json({ error: "Client not found." });

        const overrideId =
          typeof req.body?.overrideTemplateId === "string"
            ? req.body.overrideTemplateId.trim()
            : "";
        if (overrideId) {
          await patch(CLIENTS_COLLECTION, id, {
            selectedQuoteTemplateId: overrideId,
            selectedQuoteTemplateSource: "manual",
          });
          const tpl = templates.find((t: any) => t.templateId === overrideId);
          log(`[quoteTemplatesRouter] infer-template ${id} → ${overrideId} (manual override) by ${actor}`);
          return res.json({
            templateId: overrideId,
            name: tpl?.name ?? overrideId,
            source: "manual",
            reasoning: "Manually selected by staff.",
          });
        }

        try {
          const map = await loadQuoteTemplateMap();
          const mapMatch = resolveTemplateFromMap(client, map);
          if (mapMatch) {
            await patch(CLIENTS_COLLECTION, id, {
              selectedQuoteTemplateId: mapMatch.templateId,
              selectedQuoteTemplateSource: "auto",
            });
            const tpl = templates.find((t: any) => t.templateId === mapMatch.templateId);
            log(`[quoteTemplatesRouter] infer-template ${id} → ${mapMatch.templateId} (map rule ${mapMatch.ruleId}) by ${actor}`);
            return res.json({
              templateId: mapMatch.templateId,
              name: tpl?.name ?? mapMatch.templateId,
              source: "map",
              reasoning: `Matched jurisdiction mapping rule for ${client.jurisdiction ?? "?"}.`,
            });
          }
        } catch (mapErr: any) {
          log(`[quoteTemplatesRouter] infer-template map resolve failed for ${id}: ${mapErr?.message}`);
        }

        const ruleMatch = ruleMatchTemplate(client, templates);
        if (ruleMatch) {
          const tpl = templates.find((t: any) => t.templateId === ruleMatch);
          await patch(CLIENTS_COLLECTION, id, {
            selectedQuoteTemplateId: ruleMatch,
            selectedQuoteTemplateSource: "auto",
          });
          log(`[quoteTemplatesRouter] infer-template ${id} → ${ruleMatch} (rules) by ${actor}`);
          return res.json({
            templateId: ruleMatch,
            name: tpl?.name ?? ruleMatch,
            source: "rules",
            reasoning: `Matched by jurisdiction (${client.jurisdiction ?? "?"}) and legal area (${client.legalArea ?? "unknown"})`,
          });
        }

        const templateList = templates
          .filter((t: any) => !t.isDefault)
          .map((t: any) => `- ${t.templateId}: "${t.name}" [jurisdictions: ${(t.jurisdictions ?? []).join(", ") || "any"}, legalAreas: ${(t.legalAreas ?? []).join(", ") || "any"}, category: ${t.category ?? "general"}]`)
          .join("\n");

        const prompt = `You are a legal services specialist AI. Given a client's matter overview, select the SINGLE most appropriate proposal template ID from the list below.

CLIENT OVERVIEW:
- Jurisdiction: ${client.jurisdiction ?? "?"}
- Legal area: ${client.legalArea ?? "?"}
- Matter: ${client.legalMatter ?? "?"}

AVAILABLE TEMPLATES:
${templateList}
- ${DEFAULT_TEMPLATE_ID}: "ILP Standard Proposal" [jurisdictions: any, legalAreas: any, category: standard] (default fallback)

Return ONLY a JSON object: { "templateId": "<id>", "reasoning": "<1 sentence>" }
No markdown, no extra text.`;

        let inferredId = DEFAULT_TEMPLATE_ID;
        let reasoning = "Defaulted to general ILP Standard Proposal template.";

        try {
          const llmReq: LlmRequest = {
            prompt,
            systemInstruction: "You are a template selection assistant for International Legal Partner. Reply only with a JSON object.",
          };
          const llmRes = await callLLMWithFallback(llmReq);
          const jsonText = (llmRes.content ?? "").replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(jsonText);
          const validIds = new Set(templates.map((t: any) => t.templateId));
          validIds.add(DEFAULT_TEMPLATE_ID);
          if (parsed.templateId && validIds.has(parsed.templateId)) {
            inferredId = parsed.templateId;
            reasoning = parsed.reasoning ?? reasoning;
          }
        } catch (llmErr: any) {
          log(`[quoteTemplatesRouter] infer-template LLM failed for ${id}: ${llmErr?.message}`);
        }

        await patch(CLIENTS_COLLECTION, id, {
          selectedQuoteTemplateId: inferredId,
          selectedQuoteTemplateSource: "auto",
        });

        const tpl = templates.find((t: any) => t.templateId === inferredId);
        log(`[quoteTemplatesRouter] infer-template ${id} → ${inferredId} (llm/default) by ${actor}`);
        res.json({
          templateId: inferredId,
          name: tpl?.name ?? inferredId,
          source: inferredId === DEFAULT_TEMPLATE_ID ? "default" : "llm",
          reasoning,
        });
      } catch (err: any) {
        log(`[quoteTemplatesRouter] infer-template ${id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to infer template" });
      }
    },
  );
}