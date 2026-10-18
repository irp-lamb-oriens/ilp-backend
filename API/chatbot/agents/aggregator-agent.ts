/**
 * aggregator-agent.ts — merges parallel agent outputs into a single reply.
 * Deterministic: prefers a grounded knowledge answer, else the conversational
 * reply; appends non-duplicate sources.
 */

import type { AggregatorAgentResponse } from "./types.ts";

export function runAggregatorAgent(
  outputs: Array<{ id: string; text: string; priority: number }>,
): AggregatorAgentResponse {
  const sorted = [...outputs].sort((a, b) => b.priority - a.priority);
  const primary = sorted[0]?.text ?? "";
  const seen = new Set<string>();
  const sources: string[] = [];

  for (const o of sorted) {
    const t = (o.text ?? "").trim();
    if (!t || t === primary) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    sources.push(`${o.id}: ${t}`);
  }

  return {
    mergedReply: primary,
    sources,
  };
}
