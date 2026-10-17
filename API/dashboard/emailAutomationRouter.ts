/**
 * emailAutomationRouter.ts — CRUD + preview for the Stage Email Automation engine.
 *
 * One dashboard section ("Automations") configures, for every pipeline stage,
 * WHICH email fires, under WHICH condition, and whether it AUTO-sends or is left
 * as an operator SUGGESTION. It also edits the email TEMPLATES themselves
 * (subject + body), overriding the hardcoded defaults per email type.
 *
 * Routes (all dashboard-auth gated):
 *   GET    /api/dashboard/automation/rules
 *   POST   /api/dashboard/automation/rules                 (create/replace)
 *   PATCH  /api/dashboard/automation/rules/:id             (partial update)
 *   DELETE /api/dashboard/automation/rules/:id
 *   GET    /api/dashboard/automation/templates             (registry ⊕ overrides)
 *   PUT    /api/dashboard/automation/templates/:emailType  (upsert override)
 *   DELETE /api/dashboard/automation/templates/:emailType  (revert to hardcoded)
 *   POST   /api/dashboard/automation/templates/:emailType/preview
 *   GET    /api/dashboard/automation/meta                  (stages + email types + enums)
 *   GET    /api/dashboard/client-offer
 *   PUT    /api/dashboard/client-offer
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import {
  listRules,
  upsertRule,
  deleteRule,
  listTemplateOverridesFromDb,
  upsertTemplate,
  deleteTemplate,
  refreshRules,
  ensureSeeded,
} from "./automation/store.ts";
import { ruleId } from "./automation/defaults.ts";
import { STAGE_EMAIL_TRIGGERS } from "./emailSuggestions.ts";
import { ensureStageConfig, getStageConfigSync } from "./automation/stageConfig.ts";
import { RULE_CONDITIONS, RULE_MODES } from "./automation/types.ts";
import type { StageEmailRule, EmailTemplateOverride } from "./automation/types.ts";
import { interpolate } from "./automation/templateRender.ts";
import {
  ensureClientOfferConfig,
  saveClientOfferConfig,
  type ClientOfferConfig,
} from "./automation/clientOffer.ts";

/** The legal-pipeline email type registry (label + category). */
const EMAIL_TYPE_REGISTRY: Record<string, { label: string; category: "sales" | "ops" | "followup" }> = {
  scoping_intro: { label: "Scoping intro", category: "sales" },
  legal_review_update: { label: "Legal review update", category: "ops" },
  quote_ready: { label: "Quote ready", category: "sales" },
  quote_accepted_confirmation: { label: "Quote accepted confirmation", category: "sales" },
  filing_started: { label: "Filing started", category: "ops" },
  matter_closed: { label: "Matter closed", category: "followup" },
};

/** Union of every stage we know about, so the editor can offer a dropdown. */
function knownStages(rules: StageEmailRule[]): string[] {
  const set = new Set<string>();
  for (const k of Object.keys(STAGE_EMAIL_TRIGGERS)) set.add(k);
  for (const r of rules) set.add(r.triggerStage);
  for (const s of getStageConfigSync()) set.add(s.id);
  return Array.from(set).sort();
}

/** Sample data for template previews (field-agnostic placeholders). */
const PREVIEW_SAMPLE: Record<string, any> = {
  name: "Jordan Rivera",
  firstName: "Jordan",
  email: "jordan@example.com",
  legalArea: "immigration",
  legalMatter: "residency_visa",
  jurisdiction: "Costa Rica",
  statusPageUrl: "https://example.com/status/preview_doc",
};

export default function emailAutomationRouter(app: Express): void {
  // ── Rules ────────────────────────────────────────────────────────────────

  app.get(
    "/api/dashboard/automation/rules",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      await ensureSeeded();
      const rules = await listRules();
      res.json({ rules });
    }),
  );

  app.post(
    "/api/dashboard/automation/rules",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const b = req.body ?? {};
      if (!b.triggerStage || !b.emailType) {
        return res.status(400).json({ error: "triggerStage and emailType are required" });
      }
      const rule: StageEmailRule = {
        id: b.id || ruleId(b.triggerStage, b.emailType),
        triggerStage: b.triggerStage,
        emailType: b.emailType,
        condition: RULE_CONDITIONS.includes(b.condition) ? b.condition : "always",
        mode: RULE_MODES.includes(b.mode) ? b.mode : "suggest",
        enabled: b.enabled !== false,
        delayHours: Number.isFinite(+b.delayHours) ? +b.delayHours : 0,
        label: b.label || `${b.triggerStage} → ${b.emailType}`,
        updatedBy: (req as any).dashboardUser ?? b.updatedBy,
      };
      const saved = await upsertRule(rule);
      log(`[automation] rule upserted: ${saved.id} (${saved.mode}/${saved.condition})`);
      res.json({ rule: saved });
    }),
  );

  app.patch(
    "/api/dashboard/automation/rules/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { id } = req.params;
      const existing = (await listRules()).find((r) => r.id === id);
      if (!existing) return res.status(404).json({ error: "rule not found" });
      const b = req.body ?? {};
      const merged: StageEmailRule = {
        ...existing,
        ...b,
        id: existing.id,
        triggerStage: existing.triggerStage,
        emailType: existing.emailType,
        condition: RULE_CONDITIONS.includes(b.condition) ? b.condition : existing.condition,
        mode: RULE_MODES.includes(b.mode) ? b.mode : existing.mode,
        delayHours: Number.isFinite(+b.delayHours) ? +b.delayHours : existing.delayHours,
        updatedBy: (req as any).dashboardUser ?? existing.updatedBy,
      };
      const saved = await upsertRule(merged);
      res.json({ rule: saved });
    }),
  );

  app.delete(
    "/api/dashboard/automation/rules/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      await deleteRule(req.params.id);
      res.json({ ok: true });
    }),
  );

  // ── Templates (hardcoded registry merged with DB overrides) ───────────────

  app.get(
    "/api/dashboard/automation/templates",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const overrides = await listTemplateOverridesFromDb();
      const overrideMap = new Map(overrides.map((o) => [o.emailType, o]));

      const types = new Set<string>([
        ...Object.keys(EMAIL_TYPE_REGISTRY),
        ...overrideMap.keys(),
      ]);

      const templates = Array.from(types).map((emailType) => {
        const o = overrideMap.get(emailType);
        const reg = EMAIL_TYPE_REGISTRY[emailType];
        return {
          emailType,
          label: o?.label || reg?.label || emailType,
          subject: o?.subject || "",
          category: o?.category || reg?.category || "sales",
          enabled: o ? o.enabled !== false : true,
          hasOverride: !!o,
          isCustom: o?.isCustom || !reg,
          bodyHtml: o?.bodyHtml || "",
          bodyDefaulted: !o?.bodyHtml,
        };
      });

      templates.sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
      res.json({ templates });
    }),
  );

  app.put(
    "/api/dashboard/automation/templates/:emailType",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { emailType } = req.params;
      const b = req.body ?? {};
      const reg = EMAIL_TYPE_REGISTRY[emailType];
      const override: EmailTemplateOverride = {
        emailType,
        subject: b.subject ?? "",
        bodyHtml: b.bodyHtml ?? "",
        label: b.label ?? reg?.label ?? emailType,
        category: b.category ?? reg?.category ?? "sales",
        enabled: b.enabled !== false,
        isCustom: !reg,
        updatedBy: (req as any).dashboardUser ?? b.updatedBy,
      };
      const saved = await upsertTemplate(override);
      log(`[automation] template override saved: ${emailType} (enabled=${saved.enabled})`);
      res.json({ template: saved });
    }),
  );

  app.delete(
    "/api/dashboard/automation/templates/:emailType",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      await deleteTemplate(req.params.emailType);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/dashboard/automation/templates/:emailType/preview",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { emailType } = req.params;
      const data = { ...PREVIEW_SAMPLE, ...(req.body?.data || {}) };

      const draftBody = req.body?.bodyHtml;
      let html: string | null;
      if (typeof draftBody === "string" && draftBody.length) {
        html = interpolate(draftBody, data);
      } else {
        const override = (await listTemplateOverridesFromDb()).find(
          (o) => o.emailType === emailType,
        );
        html = override?.bodyHtml ? interpolate(override.bodyHtml, data) : null;
      }
      if (html == null) return res.status(400).json({ error: `No template for ${emailType}` });
      res.json({ html });
    }),
  );

  // ── Meta (stages, email types, enum values for the editor) ────────────────

  app.get(
    "/api/dashboard/automation/meta",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      await ensureSeeded();
      await ensureStageConfig();
      await refreshRules();
      const rules = await listRules();
      res.json({
        stages: knownStages(rules),
        emailTypes: Object.entries(EMAIL_TYPE_REGISTRY).map(([id, v]) => ({
          id,
          label: v.label,
          category: v.category,
        })),
        conditions: RULE_CONDITIONS,
        modes: RULE_MODES,
      });
    }),
  );

  // ── Client offer popup (single global config shown on the /status page) ────

  app.get(
    "/api/dashboard/client-offer",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      const offer = await ensureClientOfferConfig();
      res.json({ offer });
    }),
  );

  app.put(
    "/api/dashboard/client-offer",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const b = (req.body ?? {}) as Partial<ClientOfferConfig>;
      const saved = await saveClientOfferConfig(
        {
          enabled: b.enabled === true,
          title: typeof b.title === "string" ? b.title : "",
          bodyHtml: typeof b.bodyHtml === "string" ? b.bodyHtml : "",
          ctaLabel: typeof b.ctaLabel === "string" ? b.ctaLabel : "",
          ctaUrl: typeof b.ctaUrl === "string" ? b.ctaUrl : "",
        },
        (req as any).dashboardUser,
      );
      res.json({ offer: saved });
    }),
  );
}