/**
 * API/calls/slotClaims.ts — one call per lawyer per start time (REL).
 * ──────────────────────────────────────────────────────────────────────────
 * Booking checked "is the slot offered?" and then created the consultation,
 * so two members pressing Book on the same slot both got it. Two layers now:
 *
 * 1. `withLawyerSlots(providerId, fn)`: an in-process lock per lawyer around
 *    re-check + write (db/lock.ts), enough for one server instance;
 * 2. a claim document `call_slots/{providerId}_{start}` created with
 *    "create only" semantics (Firestore answers 409 when it exists), so two
 *    instances cannot both take the same start time.
 *
 * A claim whose call was cancelled or moved is stale and is taken over; a
 * claim with no call yet is honoured for CLAIM_GRACE_MS (the call is being
 * written by the request that claimed it). Cancel and reschedule release
 * the claim of the old time.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import remove from "../../db/delete.ts";
import createIfAbsent from "../../db/create.ts";
import { syncTransaction } from "../../db/lock.ts";
import { COLLECTIONS, type Consultation } from "../../schemas/contracts.ts";
import { getRecord } from "../../db/records.ts";

export const SLOT_CLAIMS = "call_slots";
const CLAIM_GRACE_MS = 2 * 60_000;

export const claimId = (providerId: string, iso: string) => `${providerId}_${iso}`.replace(/[^A-Za-z0-9_-]/g, "_");

/** Does this call still hold that lawyer and start time? Pure. */
export function holdsSlot(c: Pick<Consultation, "providerId" | "scheduledAt" | "status"> | null, providerId: string, iso: string): boolean {
  return !!c && c.providerId === providerId && c.scheduledAt === iso && (c.status === "booked" || c.status === "in_progress");
}

/** Run `fn` while no other request in this process books or moves calls of this lawyer. */
export function withLawyerSlots<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
  return syncTransaction(SLOT_CLAIMS, providerId, fn);
}

/** Claim a start time for a call (id known before the call is written). True when the call may take it. */
export async function claimSlot(providerId: string, iso: string, consultationId: string): Promise<boolean> {
  const id = claimId(providerId, iso);
  const doc = { providerId, scheduledAt: iso, consultationId, claimedAt: new Date().toISOString() };
  if (await createIfAbsent(SLOT_CLAIMS, id, doc)) return true;
  const existing = (await get(SLOT_CLAIMS, id).catch(() => null)) as Record<string, unknown> | null;
  const holderId = typeof existing?.consultationId === "string" ? existing.consultationId : "";
  if (holderId === consultationId) return true;
  const holder = holderId ? await getRecord<Consultation>(COLLECTIONS.consultations, holderId).catch(() => null) : null;
  if (holdsSlot(holder, providerId, iso)) return false;
  const claimedAt = Date.parse(String(existing?.claimedAt ?? ""));
  if (!holder && Number.isFinite(claimedAt) && Date.now() - claimedAt < CLAIM_GRACE_MS) return false;
  await put(SLOT_CLAIMS, id, doc); // stale: the call that held it was cancelled or moved
  return true;
}

/** Free a start time this call held (no-op when another call holds it). Never throws. */
export async function releaseSlot(providerId: string, iso: string, consultationId: string): Promise<void> {
  try {
    const id = claimId(providerId, iso);
    const existing = (await get(SLOT_CLAIMS, id)) as Record<string, unknown> | null;
    if (existing?.consultationId === consultationId) await remove(SLOT_CLAIMS, id);
  } catch {
    // A stale claim is taken over by the next booking anyway.
  }
}
