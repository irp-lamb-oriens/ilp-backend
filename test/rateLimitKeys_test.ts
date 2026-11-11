import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { hasOwnLimiter, sessionBucketKey, sessionTokenOf, usesSessionBucket } from "../helper/rateLimitKeys.ts";

/** QA round 3: signed-in portal traffic gets a per-session bucket; public abuse-prone routes never do. Run: deno test test/rateLimitKeys_test.ts */

const req = (url: string, headers: Record<string, string> = {}) => ({ originalUrl: url, headers }) as never;
const tok = "a".repeat(64);

Deno.test("rate-limit keys: sessions get their own bucket on portal routes", () => {
  assert(usesSessionBucket(req("/api/staff/today", { authorization: `Bearer ${tok}` })));
  assert(usesSessionBucket(req("/api/provider/today", { "x-provider-token": tok })));
  assert(usesSessionBucket(req("/api/client-status/me/home", { cookie: `x=1; ilp_client_session=${tok}` })));
  assert(usesSessionBucket(req("/api/dashboard/auth/check", { authorization: `Bearer ${tok}` })), "session check on every page load");
  assert(!usesSessionBucket(req("/api/staff/today")), "no token: per-IP");
  assert(!usesSessionBucket(req("/api/staff/today", { authorization: "Bearer short" })), "junk token: per-IP");
});

Deno.test("rate-limit keys: codes, chatbot, forms and beacons stay per-IP even with a token", () => {
  for (const url of [
    "/api/dashboard/auth/verify-otp", "/api/provider/auth/request-otp", "/api/client-status/auth/verify-otp",
    "/api/chatbot/message", "/api/leads", "/api/journey/event", "/api/csp-report", "/api/providers/apply",
    "/api/privacy/consents/join", "/api/payments/join",
  ]) assert(!usesSessionBucket(req(url, { authorization: `Bearer ${tok}` })), url);
});

Deno.test("rate-limit keys: the key is a hash, one per token", () => {
  const k1 = sessionBucketKey(req("/api/x", { authorization: `Bearer ${tok}` }));
  const k2 = sessionBucketKey(req("/api/x", { authorization: `Bearer ${"b".repeat(64)}` }));
  assertNotEquals(k1, k2);
  assert(!k1.includes(tok));
  assertEquals(sessionTokenOf(req("/api/x")), "");
});

Deno.test("beacons skip the shared per-IP bucket; sign-in does not", () => {
  const post = (url: string) => ({ originalUrl: url, headers: {}, method: "POST" }) as never;
  for (const url of ["/api/csp-report", "/api/journey/events", "/api/analytics/funnel"]) assert(hasOwnLimiter(post(url)), url);
  for (const url of ["/api/dashboard/auth/verify-otp", "/api/provider/auth/request-otp", "/api/chatbot", "/api/journey/assign", "/api/journey/c/x"]) {
    assert(!hasOwnLimiter(post(url)), url);
  }
  assert(!hasOwnLimiter(req("/api/analytics/funnel")), "staff GET keeps the shared bucket");
});
