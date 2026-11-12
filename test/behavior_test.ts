// deno-lint-ignore no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { addSummary, cellOf, cleanLabel, cleanPath, emptyBucket, heatView, insightsFor, pageView, parseSummary, pathKeyOf, type Summary } from "../API/behavior/model.ts";
import { BEHAVIOR_DAYS, BEHAVIOR_PAGES, type BehaviorIo, BehaviorStore } from "../API/behavior/store.ts";
import { rangeOf } from "../API/behavior/behaviorRouter.ts";

type Doc = Record<string, unknown>;

const view = (over: Partial<Summary> = {}): Summary => ({
  path: "/pricing",
  device: "phone",
  docH: 4000,
  activeMs: 20_000,
  maxScroll: 62,
  dwell: Array.from({ length: 20 }, (_, i) => (i < 12 ? 1000 : 0)),
  clicks: [{ x: 500, y: 100, k: "c", el: "button: Start the free check" }],
  errors: 0,
  ...over,
});

Deno.test("behavior: only public pages, clean labels, bounded summaries", () => {
  assertEquals(cleanPath("/Costa-Rica/?utm=x#top"), "/costa-rica");
  assertEquals(cleanPath("/"), "/");
  for (const p of ["/dashboard", "/status/money", "/lawyer/board", "/partners", "/api/x", "/a b", "/<script>", 5]) assertEquals(cleanPath(p), null, String(p));
  assertEquals(pathKeyOf("/"), "~");
  assertEquals(pathKeyOf("/legal/cookies"), "~legal~cookies");
  assertEquals(cleanLabel("  button:  Start   the free check "), "button: Start the free check");
  assertEquals(cleanLabel("mary@example.com"), undefined);
  assertEquals(cleanLabel("call 88881234"), undefined);

  assertEquals(parseSummary({ path: "/status", device: "phone", docH: 900, activeMs: 1, maxScroll: 1 }), null);
  assertEquals(parseSummary("not json"), null);
  const s = parseSummary(JSON.stringify({
    path: "/check",
    device: "desktop",
    docH: 3200,
    activeMs: 15000,
    maxScroll: 80,
    dwell: [100, "x", -5],
    clicks: [{ x: 10, y: 20, k: "c", el: "a: /pricing" }, { x: 5000, y: 1, k: "c" }, { x: 1, y: 1, k: "z" }, ...Array.from({ length: 100 }, () => ({ x: 1, y: 1, k: "d" }))],
    lcp: 1800,
    cls: 40,
    errors: 999,
    typed: "secret",
  }))!;
  assertEquals([s.path, s.dwell.length, s.dwell[0], s.dwell[1], s.clicks.length, s.lcp, s.errors], ["/check", 20, 100, 0, 58, 1800, 0]);
  assert(!("typed" in s));
});

Deno.test("behavior: heat grid, scroll reach, attention, elements and findings", () => {
  const b = emptyBucket("2026-11-12", "/pricing", "phone");
  for (let i = 0; i < 40; i++) addSummary(b, view());
  for (let i = 0; i < 10; i++) addSummary(b, view({ activeMs: 2000, maxScroll: 10, clicks: [], dwell: Array(20).fill(0) }));
  addSummary(b, view({ clicks: [{ x: 500, y: 100, k: "r", el: "button: Start the free check" }, { x: 900, y: 990, k: "d", el: "h2" }], lcp: 5200, errors: 1 }));
  // A continuation (tab hidden, then shown again) adds time and clicks, never a view.
  const c = emptyBucket("2026-11-12", "/x", "phone");
  addSummary(c, view());
  addSummary(c, view({ cont: true, activeMs: 5000, clicks: [{ x: 1, y: 1, k: "c" }] }));
  assertEquals([c.views, c.activeMs, c.clicks, c.docHSum], [1, 25_000, 2, 4000]);
  assertEquals(parseSummary({ path: "/x", device: "phone", docH: 900, activeMs: 1, maxScroll: 1, cont: true })?.cont, true);
  assertEquals(cellOf(500, 100), "25_10");
  assertEquals(cellOf(999, 999), "49_99");
  assertEquals([b.views, b.clicks, b.rage, b.dead, b.quick, b.cells["25_10"], b.rageCells["25_10"], b.deadCells["45_99"]], [51, 42, 1, 1, 10, 41, 1, 1]);
  const h = heatView(b);
  assertEquals(h.reach[0], 1); // everyone saw the top
  assertEquals(Math.round(h.reach[6] * 100), 80); // 41 of 51 reached 60-70%
  assertEquals(h.reach[9], 0);
  assertEquals(Math.round(h.attention.reduce((s, n) => s + n, 0)), 1);
  assertEquals(h.elements[0], { label: "button: Start the free check", clicks: 41, rage: 1, dead: 0, share: 41 / 42 });
  assertEquals([h.avgDocH, h.lcpMs, h.devices.phone], [4000, 5200, 51]);
  const texts = insightsFor(h, h.reach).map((i) => i.text).join(" | ");
  assert(texts.includes("4 s"), texts);
  assertEquals(insightsFor(pageView({ ...emptyBucketRow(), views: 3 }))[0].tone, "info");
});

function emptyBucketRow() {
  return { path: "/x", views: 0, activeMs: 0, quick: 0, scrollSum: 0, clicks: 0, rage: 0, dead: 0, errors: 0, lcpSum: 0, lcpN: 0, lcpSlow: 0, clsSum: 0, clsN: 0, inpSum: 0, inpN: 0, phone: 0, tablet: 0, desktop: 0 };
}

Deno.test("behavior: thousands of views cost a handful of database operations; reads merge days and devices", async () => {
  const db = new Map<string, Doc>();
  let reads = 0, writes = 0, failNext = false;
  const io: BehaviorIo = {
    get: (c, id) => {
      reads++;
      return Promise.resolve(db.get(`${c}/${id}`) ?? null);
    },
    put: (c, id, data) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("quota"));
      }
      writes++;
      db.set(`${c}/${id}`, JSON.parse(JSON.stringify(data)));
      return Promise.resolve();
    },
    query: (c, filters) =>
      Promise.resolve([...db.entries()].filter(([k]) => k.startsWith(`${c}/`)).map(([, v]) => v).filter((d) =>
        filters.every((f) => f.op === "EQUAL" ? d[f.field] === f.value : f.op === "GREATER_THAN_OR_EQUAL" ? String(d[f.field]) >= String(f.value) : String(d[f.field]) <= String(f.value))
      )),
  };
  let clock = new Date("2026-11-11T12:00:00Z");
  const store = new BehaviorStore(io, () => clock);
  for (let i = 0; i < 3000; i++) store.ingest(view({ device: i % 3 ? "phone" : "desktop" }));
  for (let i = 0; i < 500; i++) store.ingest(view({ path: "/" }));
  assertEquals(store.buffered(), 3);
  assertEquals(await store.flush(), 3);
  assertEquals([reads, writes], [4, 4]); // 3 buckets + 1 day row

  clock = new Date("2026-11-12T12:00:00Z");
  for (let i = 0; i < 10; i++) store.ingest(view());
  failNext = true; // a failed write keeps the measurements for the next flush
  assertEquals(await store.flush(), 0);
  assertEquals(store.buffered(), 1);
  assertEquals(await store.flush(), 1);

  const pages = await store.pages("2026-11-01", "2026-11-30");
  assertEquals(pages.map((p) => [p.path, p.views, p.phone, p.desktop]), [["/pricing", 3010, 2010, 1000], ["/", 500, 500, 0]]);
  assertEquals((await store.pages("2026-11-12", "2026-11-12"))[0].views, 10);
  const all = await store.page("/pricing", "2026-11-01", "2026-11-30");
  const phone = await store.page("/pricing", "2026-11-01", "2026-11-30", "phone");
  assertEquals([all.views, phone.views, all.cells["25_10"]], [3010, 2010, 3010]);
  assert(db.has(`${BEHAVIOR_PAGES}/2026-11-11__~pricing__phone`) && db.has(`${BEHAVIOR_DAYS}/2026-11-12`));
  assert(!JSON.stringify([...db.values()]).includes("visitor"));
});

Deno.test("behavior: date range defaults to 28 days and is capped", () => {
  const now = new Date("2026-11-12T10:00:00Z");
  assertEquals(rangeOf({}, now), { from: "2026-10-16", to: "2026-11-12" });
  assertEquals(rangeOf({ from: "2026-11-01", to: "2027-01-01" }, now), { from: "2026-11-01", to: "2026-11-12" });
  assertEquals(rangeOf({ from: "2020-01-01", to: "2026-11-12" }, now).from, "2025-10-09");
  assertEquals(rangeOf({ from: "x", to: "y" }, now).to, "2026-11-12");
});
