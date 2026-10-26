import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { AI_CONSENT_REQUIRED, aiAssistantGranted, VERSION_FOR_KIND } from "../API/privacy/policy.ts";
import type { ConsentRecord } from "../schemas/contracts.ts";

/** P7: member Lily questions need a granted, not withdrawn, ai_assistant consent. Run: deno test test/aiConsent_test.ts */

const rec = (kind: ConsentRecord["kind"], granted: boolean, at: string): ConsentRecord => ({
  id: `cns_${kind}_${at}`, clientId: "cli_1", email: "a@b.co", kind, granted, version: VERSION_FOR_KIND[kind], source: "lily", at,
} as ConsentRecord);

Deno.test("ai consent: none, granted, withdrawn, granted again", () => {
  assertEquals(aiAssistantGranted([]), false);
  assertEquals(aiAssistantGranted([rec("terms", true, "2026-10-01T00:00:00Z"), rec("privacy", true, "2026-10-01T00:00:00Z")]), false);
  const granted = rec("ai_assistant", true, "2026-10-02T00:00:00Z");
  assertEquals(aiAssistantGranted([granted]), true);
  const withdrawn = rec("ai_assistant", false, "2026-10-03T00:00:00Z");
  assertEquals(aiAssistantGranted([withdrawn, granted]), false, "newest record wins regardless of order");
  assertEquals(aiAssistantGranted([granted, withdrawn, rec("ai_assistant", true, "2026-10-04T00:00:00Z")]), true);
});

Deno.test("ai consent: the 403 body points the member at Messages", () => {
  assertEquals(AI_CONSENT_REQUIRED.code, "ai_consent_required");
  assertEquals(AI_CONSENT_REQUIRED.where, "/status/messages");
});
