/**
 * stageGatesRouter.ts — CRUD + meta for the generic Stage-Gate rule engine.
 *
 * Stage Gates block moving a client INTO a target pipeline stage until a chain
 * of conditions is satisfied. Configured in the dashboard's Automations →
 * Stages section, ALONGSIDE (never replacing) the email-automation rules.
 *
 * Routes (all dashboard-auth gated):
 *   GET    /api/dashboard/stage-gates            (list all gate rules)
 *   POST   /api/dashboard/stage-gates            (create / replace)
 *   PATCH  /api/dashboard/stage-gates/:id        (partial update)
 *   DELETE /api/dashboard/stage-gates/:id
 *   GET    /api/dashboard/stage-gates/meta       (facts + operators + logics)
 */

import type { Express, Request, Response } from "express";
import { requireDashboardAuth } from "../../helper/auth/session.ts";
import log from "../../helper/log.ts";
import {
  listGateRules,
  upsertGateRule,
  deleteGateRule,
  refreshGateRules,
} from "./stageGates/store.ts";
import {
  CURATED_FACTS,
  GATE_LOGICS,
  GATE_OPERATORS,
  VALUELESS_OPERATORS,
  type GateCondition,
  type StageGateRule,
} from "./stageGates/types.ts";

function nanoId(size = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const arr = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(arr).map((b) => chars[b % chars.length]).join("");
}

/** Sanitize a raw conditions array from the client into stored shape. */
function normalizeConditions(raw: any): GateCondition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c: any) => {
      const fact = typeof c?.fact === "string" ? c.fact.trim() : "";
      const operator = GATE_OPERATORS.includes(c?.operator) ? c.operator : "exists";
      if (!fact) return null;
      const cond: GateCondition = { fact, operator };
      if (!VALUELESS_OPERATORS.includes(operator)) {
        cond.value = c?.value ?? "";
      }
      return cond;
    })
    .filter((c): c is GateCondition => !!c);
}

export default function stageGatesRouter(app: Express) {
  // ── Meta ──────────────────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/stage-gates/meta",
    requireDashboardAuth,
    (_req: Request, res: Response) => {
      res.json({
        facts: CURATED_FACTS,
        operators: GATE_OPERATORS,
        valuelessOperators: VALUELESS_OPERATORS,
        logics: GATE_LOGICS,
      });
    },
  );

  // ── List ──────────────────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/stage-gates",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const rules = await listGateRules();
        res.json({ rules });
      } catch (err: any) {
        log(`[stageGates] list: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to list stage gates" });
      }
    },
  );

  // ── Create / replace ───────────────────────────────────────────────────────
  app.post(
    "/api/dashboard/stage-gates",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const b = req.body ?? {};
      if (!b.targetStage || typeof b.targetStage !== "string") {
        return res.status(400).json({ error: "targetStage is required" });
      }
      try {
        const rule: StageGateRule = {
          id: b.id || `gate_${nanoId()}`,
          targetStage: b.targetStage,
          logic: b.logic === "any" ? "any" : "all",
          conditions: normalizeConditions(b.conditions),
          message: typeof b.message === "string" ? b.message.trim() : "",
          enabled: b.enabled !== false,
          label: typeof b.label === "string" && b.label.trim()
            ? b.label.trim()
            : `Gate for ${b.targetStage}`,
          updatedBy: (req as any).dashboardUser ?? b.updatedBy,
        };
        const saved = await upsertGateRule(rule);
        log(`[stageGates] rule upserted: ${saved.id} → ${saved.targetStage} (${saved.conditions.length} cond)`);
        res.json({ rule: saved });
      } catch (err: any) {
        log(`[stageGates] create: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to save stage gate" });
      }
    },
  );

  // ── Partial update ─────────────────────────────────────────────────────────
  app.patch(
    "/api/dashboard/stage-gates/:id",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      const { id } = req.params;
      try {
        const existing = (await listGateRules()).find((r) => r.id === id);
        if (!existing) return res.status(404).json({ error: "Stage gate not found" });
        const b = req.body ?? {};
        const merged: StageGateRule = {
          ...existing,
          id: existing.id,
          targetStage: typeof b.targetStage === "string" && b.targetStage.trim()
            ? b.targetStage.trim()
            : existing.targetStage,
          logic: b.logic === "any" || b.logic === "all" ? b.logic : existing.logic,
          conditions: "conditions" in b ? normalizeConditions(b.conditions) : existing.conditions,
          message: typeof b.message === "string" ? b.message.trim() : existing.message,
          enabled: typeof b.enabled === "boolean" ? b.enabled : existing.enabled,
          label: typeof b.label === "string" && b.label.trim() ? b.label.trim() : existing.label,
          updatedBy: (req as any).dashboardUser ?? existing.updatedBy,
        };
        const saved = await upsertGateRule(merged);
        res.json({ rule: saved });
      } catch (err: any) {
        log(`[stageGates] patch ${id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to update stage gate" });
      }
    },
  );

  // ── Delete ─────────────────────────────────────────────────────────────────
  app.delete(
    "/api/dashboard/stage-gates/:id",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
      try {
        await deleteGateRule(req.params.id);
        await refreshGateRules();
        res.json({ ok: true });
      } catch (err: any) {
        log(`[stageGates] delete ${req.params.id}: ${err?.message}`);
        res.status(500).json({ error: err?.message ?? "Failed to delete stage gate" });
      }
    },
  );
}