/**
 * activator-agent.ts — proactive follow-up nudges from pending actions.
 * Reads the client doc's pendingActions and suggests a nudge when unresolved
 * high-priority actions exist.
 */

import get from "../../../db/get.ts";
import type { ActivatorAgentResponse } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

export async function runActivatorAgent(
  clientId: string,
): Promise<ActivatorAgentResponse> {
  const doc = await get(CLIENTS_COLLECTION, clientId).catch(() => null);
  if (!doc) return { shouldNudge: false, nudge: "", resolvedActionIds: [] };

  const actions = Array.isArray(doc.pendingActions)
    ? (doc.pendingActions as Array<Record<string, unknown>>)
    : [];

  const pending = actions.filter((a) => a?.status === "pending");
  if (pending.length === 0) {
    return { shouldNudge: false, nudge: "", resolvedActionIds: [] };
  }

  const high = pending.filter((a) => a?.priority === "high");
  const source = high.length > 0 ? high : pending;
  const top = source[0];
  const title = typeof top?.title === "string" ? top.title : "a pending follow-up";

  return {
    shouldNudge: true,
    nudge: `Heads up — you have ${pending.length} pending follow-up${pending.length > 1 ? "s" : ""}. First: "${title}".`,
    resolvedActionIds: [],
  };
}
