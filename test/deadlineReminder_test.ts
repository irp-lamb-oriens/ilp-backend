import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  daysUntil,
  currentBucket,
} from "../jobs/deadlineReminderSweep.ts";

/**
 * Unit tests for the deadline reminder threshold logic. These are pure
 * functions with no Firestore or network dependency.
 *
 * Semantics: `currentBucket` returns the smallest offset `o` where
 * `daysUntil(deadline) <= o`, i.e. the most recently crossed reminder
 * threshold. A 0 (due today) offset is always included.
 *
 * Run: deno test --allow-env test/deadlineReminder_test.ts
 */

Deno.test("daysUntil returns whole days, negative when past", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  assertEquals(daysUntil("2026-10-26", now), 0);
  assertEquals(daysUntil("2026-10-27", now), 1);
  assertEquals(daysUntil("2026-10-25", now), -1);
  assertEquals(daysUntil("2026-11-25", now), 30);
});

Deno.test("daysUntil returns NaN for invalid dates", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  assertEquals(Number.isNaN(daysUntil("not-a-date", now)), true);
  assertEquals(Number.isNaN(daysUntil("", now)), true);
});

Deno.test("currentBucket returns the most recently crossed threshold", () => {
  const offsets = [180, 120, 90, 60, 30];
  assertEquals(currentBucket(offsets, 180), 180);
  assertEquals(currentBucket(offsets, 150), 180);
  assertEquals(currentBucket(offsets, 120), 120);
  assertEquals(currentBucket(offsets, 30), 30);
  assertEquals(currentBucket(offsets, 0), 0);
});

Deno.test("currentBucket always includes a due-today (0) bucket", () => {
  assertEquals(currentBucket([60, 30], 0), 0);
  assertEquals(currentBucket([60, 30], 1), 30);
});

Deno.test("currentBucket returns null when past or before first bucket", () => {
  const offsets = [180, 120, 90, 60, 30];
  assertEquals(currentBucket(offsets, -1), null);
  assertEquals(currentBucket(offsets, 200), null);
});

Deno.test("currentBucket dedupes and sorts offsets", () => {
  // Deduped to [0, 30, 90, 180]; first offset where 100 <= o is 180.
  assertEquals(currentBucket([30, 180, 30, 90], 100), 180);
  assertEquals(currentBucket([30, 180, 30, 90], 0), 0);
});
