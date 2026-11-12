// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { cacheable, cachedRead, clearReadCache, invalidateCollection, readCacheStats } from "../helper/firestore/readCache.ts";

const on = { enabled: true, ttlMs: 1000 };

Deno.test("read cache: one database call per question until a write or the TTL", async () => {
  clearReadCache();
  let calls = 0;
  const load = () => Promise.resolve([{ id: "a", n: ++calls, tags: ["x"] }]);
  const first = await cachedRead("clients", "list", load, { ...on, now: 0 });
  first[0].tags.push("changed by the caller"); // callers get their own copy
  first.push({ id: "b", n: 0, tags: [] });
  const second = await cachedRead("clients", "list", load, on);
  assertEquals([calls, second.length, second[0].tags], [1, 1, ["x"]]);
  await cachedRead("clients", "q:{status:active}", load, on); // another question: its own call
  assertEquals(calls, 2);

  invalidateCollection("matters"); // a write elsewhere changes nothing here
  await cachedRead("clients", "list", load, on);
  assertEquals(calls, 2);
  invalidateCollection("clients"); // a write here clears every question about clients
  await cachedRead("clients", "list", load, on);
  await cachedRead("clients", "q:{status:active}", load, on);
  assertEquals(calls, 4);

  await cachedRead("clients", "list", load, { ...on, now: Date.now() + 5000 }); // older than the TTL
  assertEquals(calls, 5);
});

Deno.test("read cache: concurrent reads share one call; a write during a read is never cached over", async () => {
  clearReadCache();
  let calls = 0;
  let release: (v: Array<{ id: string }>) => void = () => {};
  const slow = () => {
    calls++;
    return new Promise<Array<{ id: string }>>((r) => (release = r));
  };
  const a = cachedRead("providers", "list", slow, on);
  const b = cachedRead("providers", "list", slow, on);
  invalidateCollection("providers"); // someone writes while the read is in flight
  release([{ id: "old" }]);
  assertEquals([(await a)[0].id, (await b)[0].id, calls], ["old", "old", 1]);
  await cachedRead("providers", "list", () => Promise.resolve([{ id: "new" }]), on);
  assertEquals((await cachedRead("providers", "list", slow, on))[0].id, "new");
  assertEquals(readCacheStats().shared, 1);
});

Deno.test("read cache: never holds sign-in, session, ticket, claim, event or log collections; off means off", async () => {
  clearReadCache();
  for (const c of ["dashboard_otps", "partner_sessions", "client_status_sessions", "join_sessions", "download_tickets", "call_slots", "journey_events", "audit_log", "email_queue", "error_log"]) assert(!cacheable(c), c);
  for (const c of ["clients", "memberships", "notifications", "staff_notifications", "consultations", "referral_partners"]) assert(cacheable(c), c);
  let calls = 0;
  const load = () => Promise.resolve([{ id: String(++calls) }]);
  await cachedRead("dashboard_sessions", "list", load, on);
  await cachedRead("dashboard_sessions", "list", load, on);
  await cachedRead("clients", "list", load, { enabled: false });
  await cachedRead("clients", "list", load, { enabled: false });
  assertEquals(calls, 4);
  const big = () => Promise.resolve(Array.from({ length: 5001 }, (_, i) => ({ id: String(i) })));
  await cachedRead("matters", "list", big, on);
  assertEquals(readCacheStats().entries, 0); // too large to hold
});
