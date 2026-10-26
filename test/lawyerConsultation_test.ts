import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { lawyerStatusError } from "../API/members/service.ts";

/**
 * P4: PATCH /api/lawyer/consultations/:id status rule. Lawyers move a call to
 * in_progress or completed only; no-show and cancel use API/calls/ routes.
 * Run: deno test --allow-env test/lawyerConsultation_test.ts
 */

Deno.test("lawyer may start and complete a booked call", () => {
  assertEquals(lawyerStatusError("in_progress", "booked"), null);
  assertEquals(lawyerStatusError("completed", "booked"), null);
  assertEquals(lawyerStatusError("completed", "in_progress"), null);
  assertEquals(lawyerStatusError(undefined, "booked"), null);
});

Deno.test("lawyer cannot set no_show, cancelled or unknown statuses here", () => {
  assertEquals(typeof lawyerStatusError("no_show", "booked"), "string");
  assertEquals(typeof lawyerStatusError("cancelled", "booked"), "string");
  assertEquals(typeof lawyerStatusError("booked", "in_progress"), "string");
  assertEquals(typeof lawyerStatusError("whatever", "booked"), "string");
});

Deno.test("closed calls cannot be reopened by the lawyer", () => {
  assertEquals(typeof lawyerStatusError("completed", "no_show"), "string");
  assertEquals(typeof lawyerStatusError("in_progress", "cancelled"), "string");
  assertEquals(typeof lawyerStatusError("in_progress", "completed"), "string");
  // Re-sending the current status is a no-op, not an error.
  assertEquals(lawyerStatusError("completed", "completed"), null);
});
