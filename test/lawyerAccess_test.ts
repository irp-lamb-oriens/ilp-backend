import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { lawyerMaySee } from "../API/members/lawyerAccess.ts";

/**
 * REL: one rule for what a lawyer may read about a member (bundle, briefs,
 * documents). Run: deno test test/lawyerAccess_test.ts
 */

const client = (assignedProviderId?: string) => ({ id: "c1", ...(assignedProviderId ? { assignedProviderId } : {}) });

Deno.test("lawyerMaySee: assigned member, open matter, live call, owed handoff", () => {
  assertEquals(lawyerMaySee("A", client("A"), [], []), true);
  assertEquals(lawyerMaySee("A", client("B"), [{ assignedProviderId: "A" }], []), true, "open matter of theirs");
  assertEquals(lawyerMaySee("A", client("B"), [{ assignedProviderId: "A", closedAt: "2026-10-01T00:00:00Z" }], []), false, "closed matter");
  assertEquals(lawyerMaySee("A", client("B"), [], [{ providerId: "A", status: "booked" }]), true, "booked call");
  assertEquals(lawyerMaySee("A", client("B"), [], [{ providerId: "A", status: "in_progress" }]), true);
  assertEquals(lawyerMaySee("A", client("B"), [], [{ providerId: "A", status: "completed" }]), true, "handoff still owed");
});

Deno.test("lawyerMaySee: after reassignment the previous lawyer is out", () => {
  const calls = [
    { providerId: "A", status: "completed" as const, handoffId: "h1" },
    { providerId: "A", status: "cancelled" as const },
    { providerId: "A", status: "no_show" as const },
  ];
  assertEquals(lawyerMaySee("A", client("B"), [{ assignedProviderId: "B" }], calls), false);
  assertEquals(lawyerMaySee("B", client("B"), [{ assignedProviderId: "B" }], calls), true);
});

Deno.test("lawyerMaySee: no lawyer id, no member", () => {
  assertEquals(lawyerMaySee("", client(""), [], [{ providerId: "", status: "booked" }]), false);
  assertEquals(lawyerMaySee("A", null, [{ assignedProviderId: "A" }], []), false);
});
