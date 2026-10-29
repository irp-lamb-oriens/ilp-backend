/**
 * API/csm/autoAssign.ts — a CSM for every new member (COMMS-P4).
 * ──────────────────────────────────────────────────────────────────────────
 * On membership activation (payments/membership.ts activateMembership), a
 * membership without a CSM gets one automatically:
 *
 *   pool     CSM_EMAILS (order kept). In production (RENDER_EXTERNAL_URL set)
 *            placeholder CSMs (reserved domains such as @example.com) are
 *            skipped, so a real member never lands in a seed CSM's book.
 *   choice   the CSM with the smallest current book (active and past-due
 *            memberships naming them); ties go round-robin, starting after
 *            the CSM picked last time (csm_assign_state/default.last).
 *   effect   memberships.csmEmail, csmAssignedAt, csmAutoAssigned: true; the
 *            CSM gets the "New member in your book" bell item (notifyEvents.ts).
 *            The onboarding task then names that CSM as owner.
 *
 * CSM_AUTO_ASSIGN=false turns it off (members then wait in "unassigned" as
 * before). Manual reassignment (/api/csm/members/:clientId/take, staff) is
 * unchanged and always wins: a membership that already has a CSM is left alone.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import log from "../../helper/log.ts";
import { isReservedEmail } from "../../helper/placeholder.ts";
import { findRecords, updateRecord } from "../../db/records.ts";
import { COLLECTIONS, type Membership } from "../../schemas/contracts.ts";
import { notifyMembershipCsm } from "./notifyEvents.ts";

const STATE = "csm_assign_state";
const norm = (e: string) => e.trim().toLowerCase();

export const autoAssignEnabled = () => (Deno.env.get("CSM_AUTO_ASSIGN") ?? "true").trim().toLowerCase() !== "false";
const isProduction = () => !!Deno.env.get("RENDER_EXTERNAL_URL");

/** Pure: the CSMs new members can go to. */
export function csmPool(raw: string | undefined, production: boolean): string[] {
  const list = (raw ?? "").split(/[,;\s]+/).map(norm).filter((e) => e.includes("@"));
  return [...new Set(list)].filter((e) => !production || !isReservedEmail(e));
}

/**
 * Pure: the CSM with the smallest book; ties broken round-robin, starting
 * right after `last` in pool order. Null for an empty pool.
 */
export function pickCsm(pool: string[], books: ReadonlyMap<string, number>, last?: string | null): string | null {
  if (!pool.length) return null;
  const min = Math.min(...pool.map((e) => books.get(e) ?? 0));
  const start = last ? (pool.indexOf(norm(last)) + 1) % pool.length : 0;
  for (let i = 0; i < pool.length; i++) {
    const e = pool[(start + i) % pool.length];
    if ((books.get(e) ?? 0) === min) return e;
  }
  return pool[0];
}

/** Current book sizes (active and past-due memberships per CSM). */
export async function bookSizes(): Promise<Map<string, number>> {
  const rows = (await Promise.all((["active", "past_due"] as const).map((status) =>
    findRecords<Membership>(COLLECTIONS.memberships, { status }).catch(() => [] as Membership[])
  ))).flat();
  const out = new Map<string, number>();
  for (const m of rows) {
    const e = norm(String(m.csmEmail ?? ""));
    if (e) out.set(e, (out.get(e) ?? 0) + 1);
  }
  return out;
}

/**
 * Give the membership a CSM when it has none. Returns the CSM, or null
 * (turned off, no pool, already assigned, or an error). Never throws.
 */
export async function autoAssignCsm(m: Membership): Promise<string | null> {
  try {
    if (!autoAssignEnabled() || m.csmEmail) return null;
    const pool = csmPool(Deno.env.get("CSM_EMAILS"), isProduction());
    if (!pool.length) return null;
    const state = (await get(STATE, "default").catch(() => null)) as { last?: string } | null;
    const csm = pickCsm(pool, await bookSizes(), state?.last);
    if (!csm) return null;
    const now = new Date().toISOString();
    const after = await updateRecord<Membership>(COLLECTIONS.memberships, m.id, { csmEmail: csm, csmAssignedAt: now, csmAutoAssigned: true, updatedAt: now });
    await put(STATE, "default", { last: csm, at: now });
    if (after) await notifyMembershipCsm(m as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    log(`[csm] ${m.id} auto-assigned to ${csm}`, "csm");
    return csm;
  } catch (err) {
    log(`[csm] auto-assign ${m.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}
