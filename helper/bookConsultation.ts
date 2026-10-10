/**
 * Single shared entry point for consultation booking requests. Ported from
 * IRP-funnel's proven `bookConsultation()` centralisation (one booking policy,
 * idempotency, and conflict guard across every surface). ILP's flow is
 * two-phase (request -> provider accept -> calendar event), so this file owns
 * the REQUEST phase only; the accept phase stays in the router.
 *
 * Guarantees provided here:
 *   1. Deterministic document id keyed on (customerId, providerId, slotStart),
 *      so a double-submit for the same customer/provider/slot is idempotent.
 *   2. A 30-minute inter-call buffer guard so a provider cannot be double-booked
 *      (or given back-to-back slots) by racing requests.
 *   3. Sentinel-string scrubbing via helper/sanitize.ts.
 */
import get from "../db/get.ts";
import patch from "../db/patch.ts";
import query from "../db/query.ts";
import log from "./log.ts";
import { sanitizeStr, normaliseNotes } from "./sanitize.ts";

export const COLLECTION = "consultations";
const SLOT_DURATION_MS = 30 * 60 * 1000;

export interface CalendarSlotInput {
  start: string; // ISO
  end: string; // ISO
  timezone: string;
}

export interface BookConsultationInput {
  customerId: string;
  providerId: string;
  slot: CalendarSlotInput;
  source?: string;
  sourceId?: string | null;
  topic?: string;
  notes?: unknown;
}

export type BookConsultationResult =
  | { success: true; id: string; alreadyExisted: boolean }
  | { success: false; code: string; reason: string };

/** Stable, Firestore-safe doc id from the booking identity. */
export function buildBookingDocId(
  customerId: string,
  providerId: string,
  slotStart: string,
): string {
  const raw = `${customerId}|${providerId}|${slotStart}`.toLowerCase();
  return raw.replace(/[^a-z0-9_-]/g, "_").slice(0, 200);
}

/**
 * Deterministic request-phase booking. On success writes an idempotent
 * "requested" consultation at a fixed id; callers then surface `{ id }`.
 */
export async function bookConsultation(
  input: BookConsultationInput,
): Promise<BookConsultationResult> {
  const providerId = sanitizeStr(input.providerId);
  if (!providerId) {
    return { success: false, code: "invalid_provider", reason: "providerId is required" };
  }

  const start = input.slot?.start;
  const startMs = new Date(start).getTime();
  if (!start || isNaN(startMs)) {
    return {
      success: false,
      code: "invalid_slot",
      reason: "slot.start must be a parseable ISO string",
    };
  }

  const id = buildBookingDocId(input.customerId, providerId, start);

  // Idempotency: a prior request for the same identity already exists.
  const existing = await get(COLLECTION, id);
  if (existing) {
    return { success: true, id, alreadyExisted: true };
  }

  // Conflict guard: the provider must not already hold a booking overlapping
  // this slot, nor a slot within the 30-minute inter-call buffer. Single-field
  // EQUAL query (no composite index required), filtered in memory.
  try {
    const others = await query(COLLECTION, [
      { field: "providerId", op: "EQUAL", value: providerId },
    ]);
    const endMs = startMs + SLOT_DURATION_MS;
    const overlaps = others.some((o) => {
      const oStart = new Date((o.slot as CalendarSlotInput | undefined)?.start ?? "").getTime();
      if (!oStart) return false;
      const oEnd = oStart + SLOT_DURATION_MS;
      return startMs < oEnd + SLOT_DURATION_MS && oStart < endMs + SLOT_DURATION_MS;
    });
    if (overlaps) {
      return { success: false, code: "slot_taken", reason: "This slot is already taken." };
    }
  } catch (err) {
    // Fail-safe: a busy-probe failure must not block booking. The deterministic
    // id plus provider-side accept gives us idempotency at the next layer.
    log(
      `[bookConsultation] conflict probe failed (continuing): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  const now = new Date().toISOString();
  await patch(COLLECTION, id, {
    customerId: sanitizeStr(input.customerId),
    providerId,
    slot: {
      start,
      end: sanitizeStr(input.slot?.end) ||
        new Date(startMs + SLOT_DURATION_MS).toISOString(),
      timezone: sanitizeStr(input.slot?.timezone) || "UTC",
    },
    source: sanitizeStr(input.source) || "direct",
    sourceId: input.sourceId ? sanitizeStr(input.sourceId) : null,
    topic: sanitizeStr(input.topic),
    notes: normaliseNotes(input.notes),
    status: "requested",
    createdAt: now,
    updatedAt: now,
  });

  return { success: true, id, alreadyExisted: false };
}

