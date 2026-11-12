/**
 * API/behavior/model.ts — BEHAVIOR: heat maps and on-page behavior. Pure.
 *
 * The browser sends ONE summary per page view of a public page (lib/journey/
 * behavior.ts), only with the visitor's measurement consent: where they
 * clicked (as a share of the page's width and height), how far they scrolled,
 * which parts of the page were on screen and for how long, rage clicks, dead
 * clicks, page speed and script errors. Never text typed, never keystrokes,
 * never a recording of the screen, and nothing inside the signed-in portals.
 *
 * The server keeps no per-person row. Each summary is added into a bucket per
 * (day, page, device); only those totals are stored:
 *   behavior_pages/{day}__{pathKey}__{device}   the heat map and element totals
 *   behavior_days/{day}                         one small row per page (overview table)
 */

export const DEVICES = ["phone", "tablet", "desktop"] as const;
export type Device = typeof DEVICES[number];

/** Heat grid: 50 columns across the page, 100 rows down its full height. */
export const GRID_COLS = 50;
export const GRID_ROWS = 100;
export const DWELL_BANDS = 20; // 5% of the page height each
export const SCROLL_BINS = 10; // deepest point reached, by tenth of the page
export const MAX_CLICKS = 60;
export const MAX_CELLS = 2500;
export const MAX_ELEMENTS = 200;

const NOT_PUBLIC = ["/dashboard", "/lawyer", "/status", "/csm", "/partners", "/ui", "/api", "/app", "/r"];

export interface ClickIn {
  /** 0-999: thousandths of the page width / of the full page height. */
  x: number;
  y: number;
  /** A short label of the control: "button: Start the free check", "a: /pricing", "h2". */
  el?: string;
  /** c = click, r = rage click (3+ fast clicks on one spot), d = dead click (nothing happened). */
  k: "c" | "r" | "d";
}

export interface Summary {
  path: string;
  device: Device;
  docH: number;
  activeMs: number;
  maxScroll: number; // 0-100, share of the page seen
  dwell: number[]; // ms on screen per band (DWELL_BANDS)
  clicks: ClickIn[];
  lcp?: number; // ms
  cls?: number; // layout shift × 1000
  inp?: number; // ms
  errors: number;
  /** What happened after the tab was hidden and shown again: more of the same view, not a new one. */
  cont?: boolean;
}

export interface ElementStat {
  label: string;
  c: number;
  r: number;
  d: number;
}

export interface Bucket {
  id: string;
  day: string;
  path: string;
  pathKey: string;
  device: Device;
  views: number;
  activeMs: number;
  /** Views that left within 5 seconds without scrolling past a quarter of the page. */
  quick: number;
  scrollSum: number;
  scroll: number[]; // SCROLL_BINS: views whose deepest point fell in each tenth
  dwell: number[]; // DWELL_BANDS: ms on screen
  cells: Record<string, number>; // "col_row" → clicks
  rageCells: Record<string, number>;
  deadCells: Record<string, number>;
  elements: Record<string, ElementStat>;
  clicks: number;
  rage: number;
  dead: number;
  errors: number;
  docHSum: number;
  lcpSum: number;
  lcpN: number;
  lcpSlow: number; // views with LCP over 4 s
  clsSum: number;
  clsN: number;
  inpSum: number;
  inpN: number;
  updatedAt?: string;
}

const int = (v: unknown, min: number, max: number): number | null => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export function pathKeyOf(path: string): string {
  return path === "/" ? "~" : path.replace(/\/+$/, "").replace(/\//g, "~");
}

/** A public page path, cleaned; null for portals, odd characters and long paths. */
export function cleanPath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const p = (v.split(/[?#]/)[0] || "/").toLowerCase().replace(/\/+$/, "") || "/";
  if (!/^\/[a-z0-9\-/]{0,80}$/.test(p)) return null;
  if (NOT_PUBLIC.some((x) => p === x || p.startsWith(`${x}/`))) return null;
  return p;
}

/** Control labels: no digits runs (ids, phones), no @ (emails), short. */
export function cleanLabel(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // deno-lint-ignore no-control-regex
  const t = v.replace(/[\u0000-\u001f<>"'`{}\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t || /@/.test(t) || /\d{5,}/.test(t)) return undefined;
  return t;
}

/** Validate what a browser sent. Anything odd is dropped; a bad summary returns null. */
export function parseSummary(raw: unknown): Summary | null {
  let b = raw;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const path = cleanPath(o.path);
  if (!path) return null;
  if (!DEVICES.includes(o.device as Device)) return null;
  const docH = int(o.docH, 100, 200_000);
  const activeMs = int(o.activeMs, 0, 4 * 3_600_000);
  const maxScroll = int(o.maxScroll, 0, 100);
  if (docH === null || activeMs === null || maxScroll === null) return null;
  const dwellIn = Array.isArray(o.dwell) ? o.dwell : [];
  const dwell = Array.from({ length: DWELL_BANDS }, (_, i) => int(dwellIn[i], 0, 3_600_000) ?? 0);
  const clicks: ClickIn[] = [];
  for (const c of Array.isArray(o.clicks) ? o.clicks.slice(0, MAX_CLICKS) : []) {
    const x = int((c as ClickIn)?.x, 0, 999);
    const y = int((c as ClickIn)?.y, 0, 999);
    const k = (c as ClickIn)?.k;
    if (x === null || y === null || !["c", "r", "d"].includes(k)) continue;
    const el = cleanLabel((c as ClickIn).el);
    clicks.push({ x, y, k, ...(el ? { el } : {}) });
  }
  const lcp = int(o.lcp, 1, 120_000);
  const cls = int(o.cls, 0, 10_000);
  const inp = int(o.inp, 1, 60_000);
  return {
    path,
    device: o.device as Device,
    docH,
    activeMs,
    maxScroll,
    dwell,
    clicks,
    ...(lcp !== null ? { lcp } : {}),
    ...(cls !== null ? { cls } : {}),
    ...(inp !== null ? { inp } : {}),
    errors: int(o.errors, 0, 50) ?? 0,
    ...(o.cont === true ? { cont: true } : {}),
  };
}

export const bucketId = (day: string, path: string, device: Device) => `${day}__${pathKeyOf(path)}__${device}`;

export function emptyBucket(day: string, path: string, device: Device): Bucket {
  return {
    id: bucketId(day, path, device),
    day,
    path,
    pathKey: pathKeyOf(path),
    device,
    views: 0,
    activeMs: 0,
    quick: 0,
    scrollSum: 0,
    scroll: Array(SCROLL_BINS).fill(0),
    dwell: Array(DWELL_BANDS).fill(0),
    cells: {},
    rageCells: {},
    deadCells: {},
    elements: {},
    clicks: 0,
    rage: 0,
    dead: 0,
    errors: 0,
    docHSum: 0,
    lcpSum: 0,
    lcpN: 0,
    lcpSlow: 0,
    clsSum: 0,
    clsN: 0,
    inpSum: 0,
    inpN: 0,
  };
}

export const cellOf = (x: number, y: number) => `${Math.min(GRID_COLS - 1, Math.floor((x / 1000) * GRID_COLS))}_${Math.min(GRID_ROWS - 1, Math.floor((y / 1000) * GRID_ROWS))}`;

const elKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "el";

function bump(map: Record<string, number>, key: string, n = 1, cap = MAX_CELLS) {
  if (key in map) map[key] += n;
  else if (Object.keys(map).length < cap) map[key] = n;
}

/** Add one page view's summary into a bucket (mutates and returns it). */
export function addSummary(b: Bucket, s: Summary): Bucket {
  b.activeMs += s.activeMs;
  if (!s.cont) {
    b.views += 1;
    if (s.activeMs < 5000 && s.maxScroll < 25 && !s.clicks.length) b.quick += 1;
    b.scrollSum += s.maxScroll;
    b.scroll[Math.min(SCROLL_BINS - 1, Math.floor(s.maxScroll / 10))] += 1;
    b.docHSum += s.docH;
  }
  for (let i = 0; i < DWELL_BANDS; i++) b.dwell[i] += s.dwell[i] ?? 0;
  for (const c of s.clicks) {
    const cell = cellOf(c.x, c.y);
    b.clicks += 1;
    bump(b.cells, cell);
    if (c.k === "r") {
      b.rage += 1;
      bump(b.rageCells, cell);
    }
    if (c.k === "d") {
      b.dead += 1;
      bump(b.deadCells, cell);
    }
    if (c.el) {
      const k = elKey(c.el);
      const e = b.elements[k] ?? (Object.keys(b.elements).length < MAX_ELEMENTS ? (b.elements[k] = { label: c.el, c: 0, r: 0, d: 0 }) : null);
      if (e) {
        e.c += 1;
        if (c.k === "r") e.r += 1;
        if (c.k === "d") e.d += 1;
      }
    }
  }
  b.errors += s.errors;
  if (s.lcp !== undefined) {
    b.lcpSum += s.lcp;
    b.lcpN += 1;
    if (s.lcp > 4000) b.lcpSlow += 1;
  }
  if (s.cls !== undefined) {
    b.clsSum += s.cls;
    b.clsN += 1;
  }
  if (s.inp !== undefined) {
    b.inpSum += s.inp;
    b.inpN += 1;
  }
  return b;
}

const NUMS = ["views", "activeMs", "quick", "scrollSum", "clicks", "rage", "dead", "errors", "docHSum", "lcpSum", "lcpN", "lcpSlow", "clsSum", "clsN", "inpSum", "inpN"] as const;

/** into += from. Used to fold memory into the stored bucket, and days into a range. */
export function mergeBucket(into: Bucket, from: Partial<Bucket>): Bucket {
  for (const k of NUMS) into[k] += Number(from[k] ?? 0);
  for (let i = 0; i < SCROLL_BINS; i++) into.scroll[i] += Number(from.scroll?.[i] ?? 0);
  for (let i = 0; i < DWELL_BANDS; i++) into.dwell[i] += Number(from.dwell?.[i] ?? 0);
  for (const m of ["cells", "rageCells", "deadCells"] as const) {
    for (const [k, n] of Object.entries(from[m] ?? {})) bump(into[m], k, Number(n) || 0);
  }
  for (const [k, e] of Object.entries(from.elements ?? {})) {
    const cur = into.elements[k] ?? (Object.keys(into.elements).length < MAX_ELEMENTS ? (into.elements[k] = { label: String(e.label ?? k), c: 0, r: 0, d: 0 }) : null);
    if (cur) {
      cur.c += Number(e.c) || 0;
      cur.r += Number(e.r) || 0;
      cur.d += Number(e.d) || 0;
    }
  }
  return into;
}

/** The small per-page row kept in behavior_days (no grid). */
export interface PageRow {
  path: string;
  views: number;
  activeMs: number;
  quick: number;
  scrollSum: number;
  clicks: number;
  rage: number;
  dead: number;
  errors: number;
  lcpSum: number;
  lcpN: number;
  lcpSlow: number;
  clsSum: number;
  clsN: number;
  inpSum: number;
  inpN: number;
  phone: number;
  tablet: number;
  desktop: number;
}

const ROW_NUMS = ["views", "activeMs", "quick", "scrollSum", "clicks", "rage", "dead", "errors", "lcpSum", "lcpN", "lcpSlow", "clsSum", "clsN", "inpSum", "inpN"] as const;

export function emptyRow(path: string): PageRow {
  return { path, views: 0, activeMs: 0, quick: 0, scrollSum: 0, clicks: 0, rage: 0, dead: 0, errors: 0, lcpSum: 0, lcpN: 0, lcpSlow: 0, clsSum: 0, clsN: 0, inpSum: 0, inpN: 0, phone: 0, tablet: 0, desktop: 0 };
}

export function addToRow(row: PageRow, b: Partial<Bucket> & { device?: Device }): PageRow {
  for (const k of ROW_NUMS) row[k] += Number(b[k] ?? 0);
  if (b.device) row[b.device] += Number(b.views ?? 0);
  return row;
}

export function mergeRow(into: PageRow, from: Partial<PageRow>): PageRow {
  for (const k of [...ROW_NUMS, "phone", "tablet", "desktop"] as const) into[k] += Number(from[k] ?? 0);
  return into;
}

const avg = (sum: number, n: number) => (n ? Math.round(sum / n) : null);

/** What the overview table shows for one page. */
export function pageView(r: PageRow) {
  return {
    path: r.path,
    views: r.views,
    avgActiveMs: avg(r.activeMs, r.views),
    avgScroll: avg(r.scrollSum, r.views),
    quickRate: r.views ? r.quick / r.views : 0,
    clicks: r.clicks,
    rage: r.rage,
    dead: r.dead,
    rageRate: r.views ? r.rage / r.views : 0,
    deadRate: r.clicks ? r.dead / r.clicks : 0,
    errors: r.errors,
    lcpMs: avg(r.lcpSum, r.lcpN),
    slowRate: r.lcpN ? r.lcpSlow / r.lcpN : null,
    cls: r.clsN ? Math.round(r.clsSum / r.clsN) / 1000 : null,
    inpMs: avg(r.inpSum, r.inpN),
    devices: { phone: r.phone, tablet: r.tablet, desktop: r.desktop },
  };
}

/** What the heat map screen shows for one page over a range. */
export function heatView(b: Bucket) {
  let seen = 0;
  // Share of views that reached each tenth of the page (cumulative from the bottom).
  const reach = Array(SCROLL_BINS).fill(0);
  for (let i = SCROLL_BINS - 1; i >= 0; i--) {
    seen += b.scroll[i];
    reach[i] = b.views ? seen / b.views : 0;
  }
  const dwellTotal = b.dwell.reduce((s, n) => s + n, 0);
  const cells = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => {
    const [x, y] = k.split("_").map(Number);
    return [x, y, n] as [number, number, number];
  });
  return {
    ...pageView(addToRow(emptyRow(b.path), b)),
    grid: { cols: GRID_COLS, rows: GRID_ROWS },
    avgDocH: avg(b.docHSum, b.views),
    reach,
    attention: b.dwell.map((n) => (dwellTotal ? n / dwellTotal : 0)),
    cells: cells(b.cells),
    rageCells: cells(b.rageCells),
    deadCells: cells(b.deadCells),
    elements: Object.values(b.elements).sort((a, c) => c.c - a.c).slice(0, 60).map((e) => ({ label: e.label, clicks: e.c, rage: e.r, dead: e.d, share: b.clicks ? e.c / b.clicks : 0 })),
  };
}

/**
 * Plain-language findings for a page, most serious first. Thresholds are
 * conservative and need at least 30 views, so one odd visit says nothing.
 */
export function insightsFor(v: ReturnType<typeof pageView>, reach?: number[]): Array<{ tone: "danger" | "warning" | "info"; text: string }> {
  const out: Array<{ tone: "danger" | "warning" | "info"; text: string }> = [];
  if (v.views < 30) return [{ tone: "info", text: `Only ${v.views} measured views so far. Wait for at least 30 before you act on this page.` }];
  if (v.errors / v.views > 0.02) out.push({ tone: "danger", text: `Script errors on ${Math.round((v.errors / v.views) * 100)}% of views. Something on this page is broken for some visitors.` });
  if (v.rageRate > 0.03) out.push({ tone: "danger", text: `Rage clicks on ${(v.rageRate * 100).toFixed(1)}% of views. Open the Rage clicks layer to see which spot people hammer.` });
  if (v.deadRate > 0.15) out.push({ tone: "warning", text: `${Math.round(v.deadRate * 100)}% of clicks do nothing. People expect something there to be a link or a button.` });
  if (v.lcpMs !== null && v.lcpMs > 4000) out.push({ tone: "warning", text: `The main content takes ${(v.lcpMs / 1000).toFixed(1)} s to appear on average. Over 4 s many visitors leave.` });
  if (v.inpMs !== null && v.inpMs > 500) out.push({ tone: "warning", text: `The page takes ${v.inpMs} ms to react to a tap or click. Over 500 ms feels broken.` });
  if (v.cls !== null && v.cls > 0.25) out.push({ tone: "warning", text: `The layout jumps while loading (shift score ${v.cls}). People tap the wrong thing.` });
  if (v.quickRate > 0.5) out.push({ tone: "warning", text: `${Math.round(v.quickRate * 100)}% of views leave within 5 seconds without scrolling. The top of the page is not holding people.` });
  if (reach && reach[5] < 0.25) out.push({ tone: "info", text: `Only ${Math.round(reach[5] * 100)}% of views reach the middle of the page. Anything important below it is rarely seen.` });
  if (!out.length) out.push({ tone: "info", text: "No problem stands out on this page in this period." });
  return out;
}
