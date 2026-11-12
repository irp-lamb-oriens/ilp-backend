import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import get from "../db/get.ts";
import getAll from "../db/getAll.ts";
import query from "../db/query.ts";
import { isPlaceholderDoc } from "../helper/placeholder.ts";
import {
  applyPlaceholderScope,
  excludingPlaceholders,
  includingPlaceholders,
  isPlaceholderRecord,
  placeholderExcluded,
  placeholderScope,
  wantsExclusion,
} from "../helper/placeholderScope.ts";
import { firestorePages, type ListParams } from "../helper/listing.ts";
import { cached, clearCache } from "../helper/cache.ts";
import { fetchAllQuotes, invalidateFinanceCache } from "../API/finance/financeQuoteSource.ts";

/**
 * "Exclude placeholder data" on every staff screen (helper/placeholderScope.ts).
 * Run: deno test --allow-env --allow-read test/placeholderScope_test.ts
 */

const T0 = "2026-11-12T15:00:00.000Z";

function seed(world: ReturnType<typeof installFakeWorld>) {
  world.put("matters", "mat_real_1", { id: "mat_real_1", clientId: "c_real", stage: "intake", createdAt: "2026-11-01T00:00:00.000Z" });
  world.put("matters", "mat_real_2", { id: "mat_real_2", clientId: "c_real", stage: "scoping", createdAt: "2026-11-02T00:00:00.000Z" });
  for (let i = 0; i < 7; i++) {
    world.put("matters", `ph_mat_${i}`, { id: `ph_mat_${i}`, clientId: "ph_c", stage: "intake", placeholder: true, createdAt: `2026-10-${10 + i}T00:00:00.000Z` });
  }
  world.put("clients", "c_real", {
    email: "real@mailbox-e2e.io",
    placeholderAccountBatch: "ph-acct-7",
    quotes: [{ quoteId: "q_real", total: 100 }, { quoteId: "ph_q_1", total: 900, placeholder: true }],
    notes: [{ id: "ph_n_1", placeholder: true, text: "example" }],
  });
  world.put("clients", "c_plain", { email: "plain@mailbox-e2e.io", quotes: [{ quoteId: "q_plain", placeholder: true }] });
  world.put("clients", "ph_c", { email: "ph@example.com", placeholder: true, quotes: [{ quoteId: "ph_q_2", total: 5 }] });
}

Deno.test("scope: the same test as isPlaceholderDoc", () => {
  const samples = [null, 1, {}, { id: "ph_x" }, { id: "x" }, { placeholder: true }, { placeholder: "true" }, { isPlaceholder: true }, { id: 7, placeholder: false }];
  for (const s of samples) assertEquals(isPlaceholderRecord(s), isPlaceholderDoc(s), JSON.stringify(s));
});

Deno.test("scope: GET only, by query parameter or header", () => {
  assertEquals(wantsExclusion({ method: "GET", query: { excludePlaceholder: "1" }, headers: {} }), true);
  assertEquals(wantsExclusion({ method: "GET", query: { excludePlaceholder: "true" }, headers: {} }), true);
  assertEquals(wantsExclusion({ method: "GET", query: {}, headers: { "x-ilp-exclude-placeholder": "1" } }), true);
  assertEquals(wantsExclusion({ method: "GET", query: { excludePlaceholder: "0" }, headers: {} }), false);
  assertEquals(wantsExclusion({ method: "GET", query: {}, headers: {} }), false);
  // A request about one placeholder record shows it, whatever the choice.
  assertEquals(wantsExclusion({ method: "GET", path: "/staff/members/ph_cli_001", query: { excludePlaceholder: "1" }, headers: {} }), false);
  assertEquals(wantsExclusion({ method: "GET", path: "/staff/members/alpha_ph_x", query: { excludePlaceholder: "1" }, headers: {} }), true);
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    assertEquals(wantsExclusion({ method, query: { excludePlaceholder: "1" }, headers: { "x-ilp-exclude-placeholder": "1" } }), false, method);
  }
});

Deno.test("scope: the middleware covers the whole request, awaits included, and nothing after it", async () => {
  const seen: boolean[] = [];
  const mw = placeholderScope();
  // deno-lint-ignore no-explicit-any
  const run = (req: any) => new Promise<void>((done) => mw(req, {} as any, async () => {
    seen.push(placeholderExcluded());
    await new Promise((r) => setTimeout(r, 1));
    seen.push(placeholderExcluded());
    done();
  }));
  await run({ method: "GET", query: { excludePlaceholder: "1" }, headers: {} });
  await run({ method: "GET", query: {}, headers: {} });
  await run({ method: "POST", query: { excludePlaceholder: "1" }, headers: {} });
  assertEquals(seen, [true, true, false, false, false, false]);
  assertEquals(placeholderExcluded(), false, "nothing leaks out of a request");
});

Deno.test("scope: lists and queries leave placeholder documents out; one document by id is never hidden", async () => {
  await useFakeEnv();
  const world = installFakeWorld(T0);
  try {
    seed(world);
    assertEquals((await getAll("matters")).length, 9);
    assertEquals((await query("matters", [{ field: "stage", op: "EQUAL", value: "intake" }])).length, 8);
    await excludingPlaceholders(async () => {
      assertEquals((await getAll("matters")).map((m) => m.id).sort(), ["mat_real_1", "mat_real_2"]);
      assertEquals((await query("matters", [{ field: "stage", op: "EQUAL", value: "intake" }])).map((m) => m.id), ["mat_real_1"]);
      assert(await get("matters", "ph_mat_0"), "a direct read still answers");
      // Inside an excluding scope, a count of what is loaded can still see everything.
      assertEquals((await includingPlaceholders(() => getAll("matters"))).length, 9);
    });
    assertEquals((await getAll("matters")).length, 9, "the next reader sees everything again");
  } finally {
    world.restore();
  }
});

Deno.test("scope: example rows the account seed appended to a real document are left out, other documents are untouched", async () => {
  await useFakeEnv();
  const world = installFakeWorld(T0);
  try {
    seed(world);
    const clients = await excludingPlaceholders(() => getAll("clients"));
    assertEquals(clients.map((c) => c.id).sort(), ["c_plain", "c_real"]);
    const real = clients.find((c) => c.id === "c_real")!;
    assertEquals((real.quotes as Array<{ quoteId: string }>).map((q) => q.quoteId), ["q_real"]);
    assertEquals(real.notes, []);
    // No account-seed marker: the document is returned exactly as stored.
    assertEquals((clients.find((c) => c.id === "c_plain")!.quotes as unknown[]).length, 1);
    // The stored document is unchanged.
    assertEquals(world.doc("clients", "c_real")!.quotes.length, 2);
    const same = [{ id: "a" }];
    assert(applyPlaceholderScope(same) === same, "outside a scope nothing is copied");
  } finally {
    world.restore();
  }
});

Deno.test("scope: a cursor page fills up with real rows and ends where the real rows end", async () => {
  await useFakeEnv();
  const world = installFakeWorld(T0);
  try {
    seed(world);
    for (let i = 3; i <= 6; i++) world.put("matters", `mat_real_${i}`, { id: `mat_real_${i}`, clientId: "c_real", stage: "intake", createdAt: `2026-11-0${i}T00:00:00.000Z` });
    const p: ListParams = { limit: 4, cursor: null, sort: "createdAt", dir: "asc", q: "", qTokens: [], filters: {}, where: [], out: {} };
    const read = async (params: ListParams) => {
      const gen = firestorePages<{ id: string }>({ collection: "matters", where: {}, sortField: "createdAt" }, params, { batchSize: 3 })(new AbortController().signal);
      const items: string[] = [];
      for (;;) {
        const step = await gen.next();
        if (step.done) return { items, tail: step.value };
        items.push(...step.value.map((d) => d.id));
      }
    };
    const page1 = await excludingPlaceholders(() => read(p));
    assertEquals(page1.items, ["mat_real_1", "mat_real_2", "mat_real_3", "mat_real_4"], "seven placeholder rows sort first and are skipped");
    assertEquals(page1.tail.hasMore, true);
    const { decodeCursor } = await import("../helper/listing.ts");
    const page2 = await excludingPlaceholders(() => read({ ...p, cursor: decodeCursor(page1.tail.nextCursor!) }));
    assertEquals(page2.items, ["mat_real_5", "mat_real_6"]);
    assertEquals(page2.tail.hasMore, false);
    const everything = await read({ ...p, limit: 100 });
    assertEquals(everything.items.length, 13);
  } finally {
    world.restore();
  }
});

Deno.test("scope: in-memory caches keep one answer per view", async () => {
  await useFakeEnv();
  const world = installFakeWorld(T0);
  try {
    seed(world);
    clearCache();
    invalidateFinanceCache();
    const load = () => getAll("matters").then((l) => l.length);
    assertEquals(await cached("t:matters", 60_000, load), 9);
    assertEquals(await excludingPlaceholders(() => cached("t:matters", 60_000, load)), 2);
    assertEquals(await cached("t:matters", 60_000, load), 9);
    // Finance reads every quote from the client documents and keeps it for 30 s.
    assertEquals((await fetchAllQuotes()).map((q) => q.quoteId).sort(), ["ph_q_1", "ph_q_2", "q_plain", "q_real"]);
    assertEquals((await excludingPlaceholders(() => fetchAllQuotes())).map((q) => q.quoteId).sort(), ["q_plain", "q_real"]);
    assertEquals((await fetchAllQuotes()).length, 4);
  } finally {
    clearCache();
    invalidateFinanceCache();
    world.restore();
  }
});
