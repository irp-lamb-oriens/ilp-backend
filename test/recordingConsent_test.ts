import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { bookingRecordingConsent, memberRecordingChoice, recordingAllowedFor, recordingWithdrawn } from "../API/privacy/policy.ts";
import type { ConsentRecord } from "../schemas/contracts.ts";

const rec = (at: string, granted: boolean, consultationId?: string): ConsentRecord =>
  ({ id: `c_${at}`, clientId: "cl1", email: "a@b.c", kind: "recording", granted, version: "v", source: "privacy_page", at, ...(consultationId ? { consultationId } : {}) }) as ConsentRecord;

Deno.test("member-level choice ignores per-call records", () => {
  const rows = [rec("2026-10-01T00:00:00Z", false), rec("2026-10-02T00:00:00Z", true, "cons_1")];
  assertEquals(memberRecordingChoice(rows)?.granted, false);
  assertEquals(recordingWithdrawn(rows), true);
  assertEquals(recordingWithdrawn([]), false);
});

Deno.test("booking defaults to declined after a withdrawal; an explicit answer wins", () => {
  const withdrawn = [rec("2026-10-01T00:00:00Z", true), rec("2026-10-05T00:00:00Z", false)];
  assertEquals(bookingRecordingConsent(undefined, withdrawn), "declined");
  assertEquals(bookingRecordingConsent("granted", withdrawn), "granted");
  assertEquals(bookingRecordingConsent(undefined, []), "pending");
  assertEquals(bookingRecordingConsent("maybe", [rec("2026-10-01T00:00:00Z", true)]), "pending");
});

Deno.test("transcript fetch skipped when the member withdrew after the call's grant", () => {
  const call = { consent: { recording: "granted", at: "2026-10-03T00:00:00Z" } };
  assertEquals(recordingAllowedFor(call, []), true);
  assertEquals(recordingAllowedFor(call, [rec("2026-10-04T00:00:00Z", false)]), false);
  // A fresh per-call grant after an older withdrawal is honoured.
  assertEquals(recordingAllowedFor(call, [rec("2026-10-01T00:00:00Z", false)]), true);
  assertEquals(recordingAllowedFor({ consent: { recording: "declined" } }, []), false);
  assertEquals(recordingAllowedFor({ consent: { recording: "granted" } }, [rec("2026-10-01T00:00:00Z", false)]), false);
});
