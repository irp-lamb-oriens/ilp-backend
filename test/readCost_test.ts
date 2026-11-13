/**
 * test/readCost_test.ts — the read-cost fixes (Firestore quota, 2026-11-13).
 *
 * Every portal reads only its own documents, the staff figures are computed
 * once per TTL, and every read is counted. These run against the in-memory
 * Firestore (test/e2e/fakeWorld.ts) and assert on the number of documents
 * read, the unit Firestore bills.
 */
// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { collectionKey, metered } from "../helper/firestore/readMeter.ts";

const NOW = "2026-11-10T15:00:00.000Z";
let world: FakeWorld;

/** Documents read by `fn` (cache off, so every read reaches the database). */
async function readsOf<T>(fn: () => Promise<T>): Promise<{ result: T; reads: number; by: Map<string, number> }> {
  let reads = 0;
  let by = new Map<string, number>();
  const result = await metered("test", fn, (s) => {
    reads = s.total;
    by = s.byCollection;
  });
  return { result, reads, by };
}

Deno.test("readCost 0: setup", async () => {
  await useFakeEnv({ DB_CACHE: "off", READ_LOG_MIN: "1000000" });
  world = installFakeWorld(NOW);
  // 100 members' obligations; only 3 of them are ours.
  for (let i = 0; i < 100; i++) {
    for (const status of ["upcoming", "done", "asked"]) {
      world.put("obligations", `o_${i}_${status}`, { id: `o_${i}_${status}`, clientId: `c_${i}`, status, dueAt: "2026-12-01" });
    }
  }
});

Deno.test("readMeter: collection keys hide document ids", () => {
  assertEquals(collectionKey("clients"), "clients");
  assertEquals(collectionKey("clients/abc/pricing_requests"), "clients/*/pricing_requests");
});

Deno.test("findForClients: reads only these clients' documents, with status filters", async () => {
  const { findForClients } = await import("../db/records.ts");
  const mine = ["c_1", "c_2", "c_3"];
  const all = await readsOf(() => findForClients<{ clientId: string; status: string }>("obligations", mine));
  assertEquals(all.result.length, 9);
  assertEquals(all.reads, 9); // not 300
  const open = await readsOf(() => findForClients<{ status: string }>("obligations", mine, { where: { status: ["upcoming", "asked"] } }));
  assertEquals(open.result.length, 6);
  assertEquals(open.reads, 6);
  assert(open.result.every((o) => o.status !== "done"));
});

Deno.test("findForClients: more ids than one IN allows are split (30, or 15 with a two-value IN)", async () => {
  const { findForClients } = await import("../db/records.ts");
  const ids = Array.from({ length: 70 }, (_, i) => `c_${i}`);
  const r = await readsOf(() => findForClients<{ status: string }>("obligations", ids, { where: { status: ["upcoming", "asked"] } }));
  assertEquals(r.result.length, 140);
  const before = world.requests.length;
  await findForClients("obligations", ids, { where: { status: ["upcoming", "asked"] } });
  assertEquals(world.requests.length - before, 5); // ceil(70 / 15)
  assertEquals((await findForClients("obligations", [])).length, 0);
});

Deno.test("countDocuments: a number for one read, placeholders subtracted when excluded", async () => {
  const { countDocuments } = await import("../helper/firestore/firestoreService.ts");
  const { excludingPlaceholders } = await import("../helper/placeholderScope.ts");
  world.put("obligations", "ph_x", { id: "ph_x", clientId: "ph_c", status: "upcoming", placeholder: true });
  const r = await readsOf(() => countDocuments("obligations", [{ field: "status", op: "EQUAL", value: "upcoming" }]));
  assertEquals(r.result, 101);
  assertEquals(r.reads, 1);
  assertEquals(await excludingPlaceholders(() => countDocuments("obligations", [{ field: "status", op: "EQUAL", value: "upcoming" }])), 100);
});

Deno.test("summary: computed once per TTL for everyone, stored, refresh recomputes", async () => {
  const { summary, _resetSummaries, summaryDocId } = await import("../helper/summaries.ts");
  _resetSummaries();
  let computed = 0;
  const compute = () => Promise.resolve({ n: ++computed });
  const [a, b] = await Promise.all([summary("k:test", compute), summary("k:test", compute)]);
  assertEquals([a.data.n, b.data.n, computed], [1, 1, 1]);
  assertEquals((await summary("k:test", compute)).data.n, 1);
  // Another instance (memory empty) reads the stored snapshot: one document read, no recompute.
  _resetSummaries();
  const other = await readsOf(() => summary("k:test", compute));
  assertEquals([other.result.data.n, computed, other.reads], [1, 1, 1]);
  assert(world.doc("dashboard_summaries", summaryDocId("k:test")));
  assertEquals((await summary("k:test", compute, { refresh: true })).data.n, 2);
  // Past the TTL: recomputed.
  assertEquals((await summary("k:test", compute, { now: Date.now() + 11 * 60_000 })).data.n, 3);
});

Deno.test("CSM book: reads the book's documents, not the company's", async () => {
  const { loadBook } = await import("../API/csm/book.ts");
  const csm = "csm@internationallegalpartner.com";
  for (let i = 0; i < 3; i++) {
    world.put("memberships", `m_${i}`, { id: `m_${i}`, clientId: `c_${i}`, status: "active", csmEmail: csm, createdAt: NOW, periodEnd: "2026-12-10T00:00:00Z" });
    world.put("clients", `c_${i}`, { id: `c_${i}`, name: `Member ${i}` });
  }
  const r = await readsOf(() => loadBook({ viewer: csm, role: "csm", csm, includeUnassigned: false }, Date.parse(NOW)));
  assertEquals(r.result.memberships.length, 3);
  assertEquals(r.result.obligations.length, 6); // upcoming + asked of c_0..c_2
  assertEquals(r.by.get("obligations"), 6); // never the other 97 members' 291
});

Deno.test("readCost z: teardown", () => {
  world.restore();
});
