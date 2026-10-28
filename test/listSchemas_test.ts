import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type ListSpec, ListParamError, pageRows, parseListParams, respondList, sendList } from "../helper/listing.ts";
import {
  decodeFilter,
  defineListSchema,
  encodeFilter,
  facetCounts,
  filterParams,
  type FilterValue,
  LIST_SCHEMAS,
  ListSchemaError,
  NONE,
  parseFilterParams,
  readFilterParams,
} from "../schemas/listSchemas.ts";
import { MEMBERS_SPEC, LAWYERS_SPEC, TIMELINE_SPEC } from "../API/dashboard/staffHome/staffHomeRouter.ts";

/**
 * FILTERS: the shared field schema (schemas/listSchemas.ts) and how
 * helper/listing.ts validates and applies it.
 *
 * Run: deno test --allow-env --allow-read test/listSchemas_test.ts
 */

Deno.env.set("SERVICE_ACCOUNT_KEY", JSON.stringify({ project_id: "ilp-test" }));

type Row = { id: string; name: string; stage: string; value: number; due?: string; areas: string[]; ready: boolean; owner?: string };

const SCHEMA = defineListSchema({
  id: "test",
  fields: [
    { key: "name", label: "Name", type: "text", searchable: true, sortable: true },
    { key: "stage", label: "Stage", type: "enum", serverParam: "stage" },
    { key: "value", label: "Value", type: "number", unit: "cents" },
    { key: "due", label: "Due", type: "date" },
    { key: "areas", label: "Areas", type: "multi-enum" },
    { key: "ready", label: "Ready", type: "boolean" },
    { key: "owner", label: "Owner", type: "person" },
  ],
});

const ROWS: Row[] = [
  { id: "a", name: "Ana Peñas", stage: "intake", value: 12000, due: "2026-10-30", areas: ["immigration"], ready: true, owner: "lu@ilp.cr" },
  { id: "b", name: "Robert Hayes", stage: "review", value: 50000, due: "2026-11-15", areas: ["property", "tax"], ready: false },
  { id: "c", name: "Laura Núñez", stage: "intake", value: 80000, areas: ["company"], ready: true, owner: "mo@ilp.cr" },
  { id: "d", name: "Grace Lindqvist", stage: "closing", value: 3000, due: "2026-10-01", areas: ["property"], ready: false, owner: "lu@ilp.cr" },
];

const SPEC: ListSpec<Row> = { sorts: { name: (r) => r.name }, defaultSort: "name", filters: { stage: (r, v) => r.stage === v }, schema: SCHEMA };

const ids = (q: Record<string, unknown>) => pageRows(ROWS, parseListParams(q, SPEC), SPEC).items.map((r) => r.id);

Deno.test("schema: a bad definition is refused", () => {
  assertThrows(() => defineListSchema({ id: "x", fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "A", type: "text" }] }), ListSchemaError);
  assertThrows(() => defineListSchema({ id: "x", fields: [{ key: "a", label: "A", type: "boolean", operators: ["range"] }] }), ListSchemaError);
  assertThrows(() => defineListSchema({ id: "x", fields: [{ key: "bad key", label: "A", type: "text" }] }), ListSchemaError);
  assertEquals(SCHEMA.fields.find((f) => f.key === "stage")?.operators, ["in", "eq"], "default operators per type");
});

Deno.test("validation: unknown field and unknown or misfit operator are 400s", async () => {
  assertThrows(() => parseListParams({ "f.nope": "eq:1" }, SPEC), ListParamError, "Unknown filter");
  assertThrows(() => parseListParams({ "f.stage": "like:in" }, SPEC), ListParamError, "operator");
  assertThrows(() => parseListParams({ "f.ready": "range:1..2" }, SPEC), ListParamError);
  assertThrows(() => parseListParams({ "f.value": "range:a..b" }, SPEC), ListParamError, "numbers");
  assertThrows(() => parseListParams({ "f.due": "before:tomorrow" }, SPEC), ListParamError, "YYYY-MM-DD");
  assertThrows(() => parseListParams({ "f.stage": "in:" }, SPEC), ListParamError);
  const noSchema: ListSpec<Row> = { sorts: { name: (r) => r.name }, defaultSort: "name" };
  assertThrows(() => parseListParams({ "f.stage": "eq:x" }, noSchema), ListParamError, "no filters");
  assertEquals(parseListParams({ stage: "x", other: "ignored" }, SPEC).where, [], "plain params are not schema filters");
  const res = { code: 200, body: undefined as unknown, status(n: number) { res.code = n; return res; }, json(b: unknown) { res.body = b; return res; }, on() { return res; } };
  await respondList({ query: { "f.nope": "eq:1" }, headers: {} } as never, res as never, SPEC, () => {
    throw new Error("build must not run");
  });
  assertEquals(res.code, 400);
});

Deno.test("wire format round-trips, including commas inside values", () => {
  const all: FilterValue[] = [
    { op: "eq", value: "a:b" },
    { op: "in", values: ["x,y", "z"] },
    { op: "range", min: "5" },
    { op: "range", max: "2026-10-01" },
    { op: "contains", value: "peñas" },
    { op: "before", value: "2026-11-01" },
    { op: "after", value: "2026-10-01" },
    { op: "boolean", value: false },
  ];
  for (const f of all) {
    assertEquals(decodeFilter(encodeFilter(f)), f);
  }
});

Deno.test("filter → query: single eq on a serverParam field uses the index param, the rest go out as f.*", () => {
  const p = filterParams(SCHEMA, {
    stage: { op: "in", values: ["intake"] },
    value: { op: "range", min: "10000" },
    ready: { op: "boolean", value: true },
    name: { op: "contains", value: "" },
  });
  assertEquals(p, { stage: "intake", "f.value": "range:10000..", "f.ready": "is:1" }, "empty filters are left out");
  assertEquals(filterParams(SCHEMA, { stage: { op: "in", values: ["intake", "review"] } }), { "f.stage": "in:intake,review" });
  const back = readFilterParams(SCHEMA, new URLSearchParams({ stage: "intake", "f.value": "range:10000..", "f.ready": "is:1", "f.due": "before:junk" }));
  assertEquals(back, { stage: { op: "eq", value: "intake" }, value: { op: "range", min: "10000" }, ready: { op: "boolean", value: true } }, "bad URL values are dropped");
});

Deno.test("applied in memory: every operator", () => {
  assertEquals(ids({ "f.stage": "in:intake,closing" }), ["a", "d", "c"]);
  assertEquals(ids({ "f.value": "range:10000..60000" }), ["a", "b"]);
  assertEquals(ids({ "f.due": "before:2026-10-30" }), ["d"], "rows without a date never match a date filter");
  assertEquals(ids({ "f.due": "after:2026-10-30" }), ["a", "b"], "after is on or after the day");
  assertEquals(ids({ "f.due": "range:2026-10-01..2026-10-30" }), ["a", "d"], "range ends are inclusive by day");
  assertEquals(ids({ "f.areas": "in:tax" }), ["b"], "multi-enum: any value matches");
  assertEquals(ids({ "f.ready": "is:0" }), ["d", "b"]);
  assertEquals(ids({ "f.name": "has:nunez" }), ["c"], "contains ignores accents and case");
  assertEquals(ids({ "f.owner": `in:${NONE}` }), ["b"], "__none matches a blank value");
  assertEquals(ids({ "f.owner": "eq:LU@ilp.cr", "f.ready": "is:1" }), ["a"], "filters AND together");
  assertEquals(ids({ q: "rob" }), ["b"], "search falls back to the schema's searchable fields");
});

Deno.test("meta: the first page carries the schema with option counts; later pages do not", async () => {
  const facets = facetCounts(SCHEMA, ROWS);
  assertEquals(facets.stage, { intake: 2, review: 1, closing: 1 });
  assertEquals(facets.areas.property, 2);
  assertEquals(facets.owner[NONE], 1);
  assertEquals(facets.ready, { "1": 2, "0": 2 });
  const fake = () => {
    const res = {
      body: undefined as Record<string, unknown> | undefined,
      code: 200,
      status(n: number) {
        res.code = n;
        return res;
      },
      json(b: Record<string, unknown>) {
        res.body = b;
        return res;
      },
      on() {
        return res;
      },
    };
    return res;
  };
  const run = async (query: Record<string, unknown>) => {
    const res = fake();
    await respondList({ query, headers: {} } as never, res as never, SPEC, (p) => ({
      produce: async function* () {
        const page = pageRows(ROWS, p, SPEC);
        yield page.items;
        return { nextCursor: page.nextCursor, hasMore: page.hasMore, total: page.total };
      },
      meta: { extra: 1 },
    }));
    return res.body!;
  };
  const first = await run({ limit: "2" });
  const schema = first.schema as { id: string; fields: Array<{ key: string; options?: Array<{ value: string; count: number }> }> };
  assertEquals(schema.id, "test");
  assertEquals(first.extra, 1, "the route's own meta stays");
  const stage = schema.fields.find((f) => f.key === "stage")!;
  assertEquals(stage.options?.find((o) => o.value === "intake")?.count, 2, "learned values with counts");
  assert(!("path" in schema.fields[0]), "paths stay on the server");
  const next = await run({ limit: "2", cursor: first.nextCursor });
  assert(!("schema" in next), "only the first page carries the schema");
  // sendList still accepts a plain meta object.
  const res = fake();
  await sendList({ query: { limit: "1" }, headers: {} } as never, res as never, async function* () {
    yield [ROWS[0]];
    return { nextCursor: null, hasMore: false };
  }, { plain: true });
  assertEquals(res.body?.plain, true);
});

Deno.test("every server list schema: unique keys, sort keys the route accepts", () => {
  for (const [name, schema] of Object.entries(LIST_SCHEMAS)) {
    assertEquals(new Set(schema.fields.map((f) => f.key)).size, schema.fields.length, name);
    assert(parseFilterParams(schema, {}).length === 0);
  }
  const check = (schema: (typeof LIST_SCHEMAS)[keyof typeof LIST_SCHEMAS], spec: ListSpec<never>) => {
    for (const f of schema.fields) {
      if (!f.sortable) continue;
      const key = typeof f.sortable === "string" ? f.sortable : f.key;
      assert(key in spec.sorts, `${schema.id}: sort "${key}" is not accepted by the route`);
    }
    assertEquals(spec.schema?.id, schema.id);
  };
  check(LIST_SCHEMAS.staffMembers, MEMBERS_SPEC as never);
  check(LIST_SCHEMAS.staffLawyers, LAWYERS_SPEC as never);
  check(LIST_SCHEMAS.staffTimeline, TIMELINE_SPEC as never);
});

Deno.test("the browser copy of listSchemas.ts is byte-identical", async () => {
  const here = await Deno.readTextFile(new URL("../schemas/listSchemas.ts", import.meta.url));
  let there: string | null = null;
  try {
    there = await Deno.readTextFile(new URL("../../frontend/src/lib/listSchemas.ts", import.meta.url));
  } catch {
    there = null; // frontend not checked out next to the server
  }
  if (there !== null) assertEquals(there, here);
});
