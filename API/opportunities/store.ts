/**
 * API/opportunities/store.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Firestore access for the `opportunities` collection (top-level, keyed by id,
 * each doc stores its own id). Writes replace the whole document so that
 * clearing a field (reopening clears outcome/closedAt) really clears it.
 *
 * `createOpportunityFromHandoff` is the hook API/members/events.ts calls when a
 * handoff gets commercial notes. Its I/O goes through `OpportunityDeps` so the
 * test can run it against an in-memory store.
 */

import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import query, { type QueryFilter } from "../../db/query.ts";
import replace from "../../db/replace.ts";
import log from "../../helper/log.ts";
import { clean, findRecords, getRecord } from "../../db/records.ts";
import { COLLECTIONS, type Matter, type Membership, type Opportunity } from "../../schemas/contracts.ts";
import { opportunityFromHandoff, opportunityIdForHandoff } from "./logic.ts";

type Doc = Record<string, unknown>;
const C = COLLECTIONS.opportunities;

export async function getOpportunity(id: string): Promise<Opportunity | null> {
  const doc = await get(C, id);
  return doc ? ({ ...(doc as Doc), id } as Opportunity) : null;
}

export async function saveOpportunity(opp: Opportunity): Promise<Opportunity> {
  const doc = clean(opp);
  await replace(C, opp.id, doc as unknown as Doc);
  return doc;
}

/**
 * Opportunities matching one equality filter (the most selective given), the
 * rest is filtered in memory by the caller. No filter lists the collection
 * (pilot size: tens to a few hundred records).
 */
export async function listOpportunities(where: { clientId?: string; ownerEmail?: string; stage?: string } = {}): Promise<Opportunity[]> {
  const key = (["clientId", "ownerEmail", "stage"] as const).find((k) => where[k]);
  const docs = key
    ? await query(C, [{ field: key, op: "EQUAL", value: where[key] } as QueryFilter])
    : await getAll(C);
  return (docs as Doc[])
    .filter((d) => d && typeof d.id === "string")
    .map((d) => d as unknown as Opportunity)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

/** The CSM who owns a member: the active membership's csmEmail, then any membership's. */
export async function memberCsm(clientId: string): Promise<string | undefined> {
  try {
    const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId });
    return (ms.find((m) => m.status === "active" && m.csmEmail) ?? ms.find((m) => m.csmEmail))?.csmEmail;
  } catch {
    return undefined;
  }
}

// ─── Handoff hook ─────────────────────────────────────────────────────────

export interface OpportunityDeps {
  getOpportunity: (id: string) => Promise<Opportunity | null>;
  saveOpportunity: (opp: Opportunity) => Promise<unknown>;
  memberCsm: (clientId: string) => Promise<string | undefined>;
  matterArea: (matterId: string) => Promise<string | undefined>;
  defaultOwner: () => string | undefined;
}

export const defaultDeps: OpportunityDeps = {
  getOpportunity,
  saveOpportunity,
  memberCsm,
  matterArea: async (matterId) => (await getRecord<Matter>(COLLECTIONS.matters, matterId).catch(() => null))?.area,
  defaultOwner: () => Deno.env.get("DEFAULT_CSM_EMAIL") || undefined,
};

/**
 * Create the opportunity for a handoff that carries commercial notes: source
 * handoff, title from the notes, stage identified, owner = the membership's
 * CSM (then DEFAULT_CSM_EMAIL). One per handoff (deterministic id), so retries
 * and re-saves are no-ops. Returns the opportunity (new or existing) or null.
 * Never throws: it must not break the handoff write that triggered it.
 */
export async function createOpportunityFromHandoff(handoff: Doc, deps: OpportunityDeps = defaultDeps): Promise<Opportunity | null> {
  try {
    const hid = typeof handoff.id === "string" ? handoff.id : "";
    if (!hid) return null;
    const existing = await deps.getOpportunity(opportunityIdForHandoff(hid));
    if (existing) return existing;
    const clientId = typeof handoff.clientId === "string" ? handoff.clientId : "";
    const matterId = typeof handoff.matterId === "string" ? handoff.matterId : "";
    const [csm, area] = await Promise.all([
      clientId ? deps.memberCsm(clientId) : Promise.resolve(undefined),
      matterId ? deps.matterArea(matterId) : Promise.resolve(undefined),
    ]);
    const opp = opportunityFromHandoff(handoff, { ownerEmail: csm || deps.defaultOwner(), area });
    if (!opp) return null;
    await deps.saveOpportunity(opp);
    log(`[opportunities] ${opp.id} created from handoff ${hid} (${opp.ownerEmail ?? "unassigned"})`);
    return opp;
  } catch (err) {
    log(`[opportunities] from handoff failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}
