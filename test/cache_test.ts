// deno-lint-ignore no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { cached, clearCache, invalidate } from "../helper/cache.ts";
import { isUpstreamError } from "../helper/errorReporter.ts";
import { FirestoreError } from "../helper/firestore/firestoreService.ts";

Deno.test("cache: one load per TTL, stale on failure, invalidate by prefix", async () => {
  clearCache();
  let n = 0;
  const load = () => Promise.resolve(++n);
  assertEquals(await cached("public:x", 1000, load, 0), 1);
  assertEquals(await cached("public:x", 1000, load, Date.now()), 1);
  const [a, b] = await Promise.all([cached("public:y", 1000, load), cached("public:y", 1000, load)]);
  assertEquals([a, b], [2, 2]);
  // expired + failing load → last good value
  assertEquals(await cached("public:x", 0, () => Promise.reject(new Error("quota"))), 1);
  await assertRejects(() => cached("public:z", 1000, () => Promise.reject(new Error("quota"))));
  invalidate("public:");
  assertEquals(await cached("public:x", 1000, load), 3);
});

Deno.test("database errors are recognised as upstream, never as the visitor's 4xx", () => {
  assertEquals(isUpstreamError(new FirestoreError("query", 429, "updates", "RESOURCE_EXHAUSTED")), true);
  assertEquals(isUpstreamError(Object.assign(new Error("too large"), { status: 413 })), false);
  assertEquals(isUpstreamError(null), false);
});
