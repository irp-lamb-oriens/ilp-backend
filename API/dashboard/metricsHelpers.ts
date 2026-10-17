/**
 * API/dashboard/metricsHelpers.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Dashboard metric aggregations for the ILP CRM: email queue + LLM cost.
 */

import query from "../../db/query.ts";
import getAll from "../../db/getAll.ts";

export interface EmailQueueMetrics {
  pending: number;
  sent: number;
  dead: number;
  total: number;
}

export async function fetchEmailQueueMetrics(): Promise<EmailQueueMetrics> {
  const rows = await query("email_queue", []).catch(() => []);
  const pending = rows.filter((r) => r.status === "pending").length;
  const sent = rows.filter((r) => r.status === "sent").length;
  const dead = rows.filter((r) => r.status === "dead").length;
  return { pending, sent, dead, total: rows.length };
}

export interface LLMCostMetrics {
  totalCostUSD: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export async function fetchLLMCostMetrics(): Promise<LLMCostMetrics> {
  const rows = await getAll("llm_costs").catch(() => []);
  let totalCostUSD = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const r of rows) {
    totalCostUSD += Number(r.costUSD) || 0;
    totalInputTokens += Number(r.inputTokens) || 0;
    totalOutputTokens += Number(r.outputTokens) || 0;
  }
  return {
    totalCostUSD: Math.round(totalCostUSD * 10000) / 10000,
    totalCalls: rows.length,
    totalInputTokens,
    totalOutputTokens,
  };
}