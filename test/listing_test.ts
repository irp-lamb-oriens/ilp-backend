import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  buildStructuredQuery,
  decodeCursor,
  encodeCursor,
  firestorePages,
  isListRequest,
  type ListParams,
  ListParamError,
  type ListProducer,
  type ListSpec,
  matchesQuery,
  MAX_LIMIT,
  pageRows,
  parseListParams,
  queryTokens,
  respondList,
  searchTokens,
  sendList,
  withFallback,
} from "../helper/listing.ts";
import { NATIVE, nativeCombo } from "../db/recordLists.ts";
import { recordSearchTokens } from "../db/records.ts";

/**
 * LISTS: shared pagination, search and NDJSON streaming (helper/listing.ts).
 * No Firestore: a fake runQuery answers structured queries over arrays.
 *
 * Run: deno test --allow-env --allow-read test/listing_test.ts
 */

Deno.env.set("SERVICE_ACCOUNT_KEY", JSON.stringify({ project_id: "ilp-test" }));

type Row = { id: string; name: string; at: string; providerId: string; status: string; searchTokens?: string[] };

const NAMES = ["Robert Hayes", "Ana Peñas", "Laura Núñez", "Tomás Brenes", "Ana Solís", "Mark Tully", "Grace Lindqvist"];
const ROWS: Row[] = NAMES.map((name, i) => ({
  id: `r${i}`,
  name,
  at: `2026-10-${String(10 + (i % 4)).padStart(2, "0")}`, // repeated keys: the id breaks ties
  providerId: i % 2 ? "prov_b" : "prov_a",
  status: i % 3 ? "open" : "done",
}));
for (const r of ROWS) r.searchTokens = searchTokens(r.name);

const SPEC: ListSpec<Row> = {
  sorts: { at: (r) => r.at, name: (r) => r.name },
  defaultSort: "at",
  filters: { status: (r, v) => r.status === v },
  search: (r) => [r.name],
};

const params = (q: Record<string, unknown> = {}) => parseListParams(q, SPEC);

function drain(rows: Row[], q: Record<string, unknown>): Row[] {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: ReturnType<typeof pageRows<Row>> = pageRows(rows, params({ ...q, ...(cursor ? { cursor } : {}) }), SPEC);
    out.push(...page.items);
    if (!page.hasMore) return out;
    cursor = page.nextCursor;
  }
  throw new Error("did not finish");
}

Deno.test("cursor round-trip keeps sort, direction, key and id (unicode too)", () => {
  const c = { s: "name", d: "desc" as const, k: "Núñez, Laura", id: "r2" };
  assertEquals(decodeCursor(encodeCursor(c)), c);
  const n = { s: "at", d: "asc" as const, k: 42, id: "x" };
  assertEquals(decodeCursor(encodeCursor(n)), n);
  let threw = false;
  try {
    decodeCursor("not-a-cursor");
  } catch (e) {
    threw = e instanceof ListParamError;
  }
  assert(threw, "a garbage cursor is a 400, not a crash");
  threw = false;
  try {
    params({ sort: "name", cursor: encodeCursor({ s: "at", d: "asc", k: "", id: "r1" }) });
  } catch (e) {
    threw = e instanceof ListParamError;
  }
  assert(threw, "a cursor from another sort is refused");
});

Deno.test("limit: default 25, capped at 100, junk falls back", () => {
  assertEquals(params().limit, 25);
  assertEquals(params({ limit: "500" }).limit, MAX_LIMIT);
  assertEquals(params({ limit: "0" }).limit, 25);
  assertEquals(params({ limit: "abc" }).limit, 25);
  assertEquals(params({ limit: "7" }).limit, 7);
  let threw = false;
  try {
    params({ sort: "password" });
  } catch (e) {
    threw = e instanceof ListParamError;
  }
  assert(threw, "sorts are allow-listed");
  assertEquals(params({ owner: "x", status: "open" }).filters, { status: "open" }, "filters are allow-listed");
});

Deno.test("search tokens: accent-free word prefixes, AND across words", () => {
  const t = searchTokens("Ana Peñas", "ana@correo.cr");
  for (const want of ["a", "an", "ana", "p", "pe", "pen", "penas", "correo", "cr"]) assert(t.includes(want), want);
  assertEquals(queryTokens("  Peñ   AN pen "), ["pen", "an"]);
  assert(matchesQuery(["Ana Peñas"], queryTokens("pen an")));
  assert(!matchesQuery(["Ana Peñas"], queryTokens("pen laura")));
  assert(matchesQuery(["Laura Núñez"], queryTokens("NUÑ")));
  assertEquals(drain(ROWS, { q: "ana", limit: "1" }).map((r) => r.name).sort(), ["Ana Peñas", "Ana Solís"]);
  const h = recordSearchTokens("handoffs", { legalNextSteps: [{ what: "Renew DIMEX card" }, { what: "Sign deed" }] });
  assert(h.includes("dimex") && h.includes("deed"), "nested next steps are searchable");
});

Deno.test("in-memory pages: every row once, in order, ties broken by id, both directions", () => {
  for (const dir of ["asc", "desc"]) {
    const all = drain(ROWS, { limit: "3", dir, sort: "at" });
    assertEquals(all.length, ROWS.length);
    assertEquals(new Set(all.map((r) => r.id)).size, ROWS.length);
    const keys = all.map((r) => `${r.at}|${r.id}`);
    const sorted = [...keys].sort();
    assertEquals(keys, dir === "asc" ? sorted : sorted.reverse());
  }
  const open = drain(ROWS, { limit: "2", status: "open" });
  assertEquals(open.map((r) => r.id).sort(), ROWS.filter((r) => r.status === "open").map((r) => r.id).sort());
  const first = pageRows(ROWS, params({ limit: "2" }), SPEC);
  assertEquals(first.total, ROWS.length);
  assert(first.hasMore && !!first.nextCursor);
});

// ── A fake Firestore runQuery over arrays ─────────────────────────────────

function val(v: Record<string, unknown>): unknown {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("referenceValue" in v) return String(v.referenceValue).split("/").pop();
  return null;
}

function fakeRun(store: Row[], calls: Record<string, unknown>[] = []) {
  return (_c: string, q: Record<string, unknown>) => {
    calls.push(q);
    const where = q.where as Record<string, unknown> | undefined;
    const leaves = (where?.compositeFilter as { filters: Record<string, unknown>[] } | undefined)?.filters ?? (where ? [where] : []);
    const ok = (r: Row) =>
      leaves.every((l) => {
        const f = l.fieldFilter as { field: { fieldPath: string }; op: string; value: Record<string, unknown> };
        const v = val(f.value);
        const field = (r as unknown as Record<string, unknown>)[f.field.fieldPath];
        return f.op === "EQUAL" ? field === v : Array.isArray(field) && field.includes(v);
      });
    const ob = q.orderBy as { field: { fieldPath: string }; direction: string }[];
    const desc = ob[0].direction === "DESCENDING";
    const key = (r: Row) => `${(r as unknown as Record<string, string>)[ob[0].field.fieldPath]}\u0000${r.id}`;
    let rows = store.filter(ok).sort((a, b) => (key(a) < key(b) ? -1 : 1));
    if (desc) rows.reverse();
    const sa = q.startAt as { values: Record<string, unknown>[] } | undefined;
    if (sa) {
      const k = `${val(sa.values[0])}\u0000${val(sa.values[1])}`;
      rows = rows.filter((r) => (desc ? key(r) < k : key(r) > k));
    }
    return Promise.resolve(rows.slice(0, Number(q.limit)) as unknown as { id: string }[]);
  };
}

async function collect<T>(produce: ListProducer<T>) {
  const it = produce(new AbortController().signal);
  const items: T[] = [];
  let n = await it.next();
  let batches = 0;
  while (!n.done) {
    items.push(...n.value);
    batches++;
    n = await it.next();
  }
  return { items, tail: n.value, batches };
}

const NQ = { collection: "matters", where: { providerId: "prov_a" }, sortField: "at" };

Deno.test("firestore pages: limit+1 detects the next page, the cursor resumes after the last row", async () => {
  const p1 = params({ limit: "2" });
  const a = await collect(firestorePages<Row>(NQ, p1, { run: fakeRun(ROWS) }));
  assertEquals(a.items.length, 2);
  assert(a.tail.hasMore);
  const seen = [...a.items];
  let tail = a.tail;
  while (tail.hasMore) {
    const r = await collect(firestorePages<Row>(NQ, params({ limit: "2", cursor: tail.nextCursor }), { run: fakeRun(ROWS) }));
    seen.push(...r.items);
    tail = r.tail;
  }
  assertEquals(seen.map((r) => r.id), ROWS.filter((r) => r.providerId === "prov_a").sort((x, y) => (`${x.at}${x.id}` < `${y.at}${y.id}` ? -1 : 1)).map((r) => r.id));
});

Deno.test("scoping: a lawyer cannot page into another lawyer's rows, even with their cursor", async () => {
  const theirs = ROWS.find((r) => r.providerId === "prov_b")!;
  const forged = encodeCursor({ s: "at", d: "asc", k: "", id: theirs.id });
  const calls: Record<string, unknown>[] = [];
  const r = await collect(firestorePages<Row>(NQ, params({ limit: "50", cursor: forged }), { run: fakeRun(ROWS, calls) }));
  assert(r.items.every((x) => x.providerId === "prov_a"));
  assertEquals(r.items.length, ROWS.filter((x) => x.providerId === "prov_a").length);
  const q = buildStructuredQuery(NQ, "asc", decodeCursor(forged), 10);
  assert(JSON.stringify(q.where).includes("prov_a"), "the scope filter is always in the query");
  assert(JSON.stringify(q.startAt).includes("documents/matters/"), "the cursor is a __name__ reference");
  assertEquals(calls.length, 1);
});

Deno.test("firestore pages: first search word goes to Firestore, the rest filter in memory across batches", async () => {
  const store: Row[] = Array.from({ length: 120 }, (_, i) => {
    const name = i % 7 === 0 ? `Anabel Peñas ${i}` : `Anabel Ortiz ${i}`;
    return { id: `x${String(i).padStart(3, "0")}`, name, at: "2026-10-01", providerId: "prov_a", status: "open", searchTokens: searchTokens(name) };
  });
  const calls: Record<string, unknown>[] = [];
  const p = params({ limit: "5", q: "anabel pe" });
  const r = await collect(firestorePages<Row>(NQ, p, { run: fakeRun(store, calls), batchSize: 20 }));
  assertEquals(r.items.length, 5);
  assert(r.items.every((x) => x.name.startsWith("Anabel Peñas")));
  assert(JSON.stringify(calls[0].where).includes("\"anabel\""), "the longest word is the array-contains token");
  assert(r.batches >= 2, "matches arrive batch by batch");
  const want = store.filter((x) => x.name.startsWith("Anabel Peñas")).length;
  let total = r.items.length;
  let tail = r.tail;
  while (tail.hasMore) {
    const n = await collect(firestorePages<Row>(NQ, params({ limit: "5", q: "anabel pe", cursor: tail.nextCursor }), { run: fakeRun(store), batchSize: 20 }));
    total += n.items.length;
    tail = n.tail;
  }
  assertEquals(total, want);
});

Deno.test("missing index falls back to the in-memory page", async () => {
  const failing: ListProducer<Row> = async function* () {
    throw Object.assign(new Error("Firestore query failed (400): FAILED_PRECONDITION: The query requires an index"), { status: 400 });
  };
  let fell = false;
  const r = await collect(withFallback(failing, () => async function* () {
    yield [ROWS[0]];
    return { nextCursor: null, hasMore: false };
  }, () => (fell = true)));
  assert(fell);
  assertEquals(r.items, [ROWS[0]]);
});

Deno.test("every native combo has a composite index in firestore.indexes.json", async () => {
  const json = JSON.parse(await Deno.readTextFile(new URL("../firestore.indexes.json", import.meta.url))) as {
    indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] }[];
  };
  const sig = (col: string, f: { fieldPath: string; order?: string; arrayConfig?: string }[]) =>
    col + ":" + f.filter((x) => x.fieldPath !== "__name__").map((x) => `${x.fieldPath}/${x.order ?? x.arrayConfig}`).sort().join(",");
  const have = new Set(json.indexes.map((i) => sig(i.collectionGroup, i.fields)));
  for (const [col, cfg] of Object.entries(NATIVE)) {
    for (const c of cfg!.combos) {
      if (!c.eq.length && !c.q) continue; // single-field order: automatic index
      const fields = [
        ...c.eq.map((e) => ({ fieldPath: e, order: "ASCENDING" })),
        ...(c.q ? [{ fieldPath: "searchTokens", arrayConfig: "CONTAINS" }] : []),
        { fieldPath: cfg!.sortField, order: c.dir === "desc" ? "DESCENDING" : "ASCENDING" },
      ];
      assert(have.has(sig(col, fields)), `missing index ${sig(col, fields)}`);
    }
  }
  assert(nativeCombo("consultations", "scheduledAt", "asc", ["providerId"], true));
  assertEquals(nativeCombo("consultations", "scheduledAt", "desc", ["providerId"], false), null, "other directions page in memory");
});

// ── Response framing ──────────────────────────────────────────────────────

function fakeRes() {
  const handlers: Record<string, (() => void)[]> = {};
  const res = {
    writes: [] as string[],
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    code: 200,
    ended: false,
    writableEnded: false,
    status(n: number) {
      res.code = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
    },
    write(chunk: string) {
      res.writes.push(chunk);
      return true;
    },
    end() {
      res.ended = true;
      res.writableEnded = true;
    },
    on(ev: string, fn: () => void) {
      (handlers[ev] ??= []).push(fn);
      return res;
    },
    emit(ev: string) {
      for (const f of handlers[ev] ?? []) f();
    },
  };
  return res;
}

const req = (query: Record<string, unknown>, accept = "") => ({ query, headers: { accept }, params: {} }) as never;

function batches(n: number, counter: { read: number }): ListProducer<Row> {
  return async function* (signal) {
    for (let i = 0; i < n; i++) {
      if (signal.aborted) break;
      counter.read++;
      await new Promise((r) => setTimeout(r, 1));
      yield [ROWS[i % ROWS.length]];
    }
    return { nextCursor: "next", hasMore: true };
  };
}

Deno.test("NDJSON: meta line, one line per item, end line last, searchTokens never sent", async () => {
  const res = fakeRes();
  await sendList(req({ stream: "1" }), res as never, batches(3, { read: 0 }), { counts: { open: 4 } });
  const lines = res.writes.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assertEquals(res.headers["content-type"], "application/x-ndjson; charset=utf-8");
  assertEquals(lines[0], { type: "meta", counts: { open: 4 } });
  assertEquals(lines.slice(1, 4).map((l) => l.type), ["item", "item", "item"]);
  assertEquals(lines[1].item.id, "r0");
  assert(!("searchTokens" in lines[1].item));
  assertEquals(lines[4], { type: "end", nextCursor: "next", hasMore: true });
  assert(res.writes.every((w) => w.endsWith("\n")), "every write ends on a line boundary");
  assert(res.ended);
});

Deno.test("JSON: { items, nextCursor, hasMore } plus meta; no paging params means legacy", async () => {
  const res = fakeRes();
  await sendList(req({ limit: "3" }), res as never, batches(2, { read: 0 }), { owners: ["a"] });
  const body = res.body as Record<string, unknown>;
  assertEquals((body.items as Row[]).length, 2);
  assertEquals(body.nextCursor, "next");
  assertEquals(body.hasMore, true);
  assertEquals(body.owners, ["a"]);
  assert(isListRequest(req({ limit: "3" })));
  assert(isListRequest(req({}, "application/x-ndjson")));
  assert(!isListRequest(req({ owner: "me" })), "old callers keep the old shape");
});

Deno.test("a client disconnect stops reading upstream", async () => {
  const res = fakeRes();
  const counter = { read: 0 };
  const origWrite = res.write;
  res.write = (chunk: string) => {
    origWrite(chunk);
    if (chunk.includes("\"item\"")) res.emit("close"); // the browser goes away after the first batch
    return true;
  };
  await sendList(req({ stream: "1" }), res as never, batches(50, counter));
  assert(counter.read <= 2, `read ${counter.read} batches after the disconnect`);
  assert(!res.writes.join("").includes("\"end\""), "no end line to a closed connection");
});

Deno.test("respondList answers 400 for a bad cursor", async () => {
  const res = fakeRes();
  await respondList(req({ cursor: "%%%" }), res as never, SPEC, () => ({ produce: batches(1, { read: 0 }) }));
  assertEquals(res.code, 400);
});

// Keep the type import used.
export type _P = ListParams;

Deno.test("backfill plan: only records whose tokens differ, re-run is a no-op", async () => {
  const { planSearchTokens } = await import("../scripts/backfillSearchTokens.ts");
  const fresh = { id: "t1", title: "Call Ana about the DIMEX renewal", type: "follow_up", clientId: "c1" };
  const current = { ...fresh, id: "t2", searchTokens: recordSearchTokens("csm_tasks", fresh) };
  const plan = planSearchTokens("csm_tasks", [fresh, current]);
  assertEquals(plan.update.map((u) => u.id), ["t1"]);
  assertEquals(plan.unchanged, 1);
  assert(plan.update[0].searchTokens.includes("dimex"));
  const again = planSearchTokens("csm_tasks", [{ ...fresh, searchTokens: plan.update[0].searchTokens }]);
  assertEquals(again.update.length, 0);
});
