import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { JOIN_CONSENT_ERROR, joinConsentsToWrite, parseJoinConsents, VERSION_FOR_KIND } from "../API/privacy/policy.ts";
import type { ConsentRecord } from "../schemas/contracts.ts";

/** P7: Terms and Privacy consents travel inside POST /api/payments/join. Run: deno test --allow-env test/joinConsents_test.ts */

const yes = (kind: string, granted = true) => ({ kind, granted, version: VERSION_FOR_KIND[kind as keyof typeof VERSION_FOR_KIND] });

Deno.test("join consents: terms and privacy required, marketing optional", () => {
  const ok = parseJoinConsents({ consents: [yes("terms"), yes("privacy")] });
  assert(!("error" in ok));
  assertEquals(ok.terms.granted, true);
  assertEquals(ok.privacy.version, VERSION_FOR_KIND.privacy);
  assertEquals(ok.marketing, undefined);
  assertEquals(ok.terms.source, "join");

  const withMk = parseJoinConsents({ consents: [yes("terms"), yes("privacy"), yes("marketing_email", false)] });
  assert(!("error" in withMk));
  assertEquals(withMk.marketing?.granted, false);

  assertEquals(parseJoinConsents({ consents: [yes("terms")] }), { error: JOIN_CONSENT_ERROR });
  assertEquals(parseJoinConsents({ consents: [yes("terms"), yes("privacy", false)] }), { error: JOIN_CONSENT_ERROR });
  assertEquals(parseJoinConsents({}), { error: JOIN_CONSENT_ERROR });
  // the pre-P6 body (acceptTerms only) no longer joins
  assertEquals(parseJoinConsents({ acceptTerms: true }), { error: JOIN_CONSENT_ERROR });
});

Deno.test("join consents: flat booleans, stale versions and other kinds", () => {
  const flat = parseJoinConsents({ acceptTerms: true, acceptPrivacy: true, marketing: true });
  assert(!("error" in flat));
  assertEquals(flat.marketing?.granted, true);
  assertEquals(flat.terms.version, VERSION_FOR_KIND.terms);

  const stale = parseJoinConsents({ consents: [{ kind: "terms", granted: true, version: "terms-old" }, yes("privacy")] });
  assert("error" in stale && /out of date/.test(stale.error));
  const other = parseJoinConsents({ consents: [yes("terms"), yes("privacy"), yes("ai_assistant")] });
  assertEquals(other, { error: "Unknown consent." });
});

Deno.test("join consents: a retried join or the legacy browser call writes nothing twice", () => {
  const want = parseJoinConsents({ consents: [yes("terms"), yes("privacy"), yes("marketing_email", true)] });
  assert(!("error" in want));
  assertEquals(joinConsentsToWrite(want, []).map((c) => c.kind), ["terms", "privacy", "marketing_email"]);
  const rec = (kind: ConsentRecord["kind"], granted: boolean, at: string, source = "join"): ConsentRecord => ({
    id: `cns_${kind}_${at}`, clientId: "cli_1", email: "a@b.co", kind, granted, version: VERSION_FOR_KIND[kind], source, at,
  } as ConsentRecord);
  const existing = [rec("terms", true, "2026-10-26T10:00:00Z"), rec("privacy", true, "2026-10-26T10:00:00Z"), rec("marketing_email", false, "2026-10-26T10:00:00Z")];
  // marketing answer changed → only marketing is written
  assertEquals(joinConsentsToWrite(want, existing).map((c) => c.kind), ["marketing_email"]);
  // a marketing choice made later on /status/privacy is not a join record → written again on a new join
  const later = [...existing.slice(0, 2), rec("marketing_email", true, "2026-10-27T10:00:00Z", "privacy_page")];
  assertEquals(joinConsentsToWrite(want, later).map((c) => c.kind), ["marketing_email"]);
  assertEquals(joinConsentsToWrite(want, [...existing.slice(0, 2), rec("marketing_email", true, "2026-10-26T10:00:00Z")]), []);
});
