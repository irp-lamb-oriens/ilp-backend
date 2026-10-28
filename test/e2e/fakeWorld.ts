/**
 * test/e2e/fakeWorld.ts — the outside world for end-to-end tests.
 * ──────────────────────────────────────────────────────────────────────────
 * Everything the server reaches over the network goes through `fetch`, so the
 * fakes sit there: one `fetch` replacement answers
 *   - the Google OAuth token endpoint (any assertion gets a token),
 *   - Firestore REST (documents, merge/replace PATCH, create with
 *     ?documentId=, delete, runQuery, list, commit) from an in-memory store,
 *   - Google Calendar (events insert/get/patch/delete, freeBusy) and the Drive
 *     export of a Meet transcript,
 *   - the LLM (OpenRouter chat completions) with a fixed JSON suggestion.
 * Anything else fails loudly. A fixed clock replaces `Date` (new Date() and
 * Date.now()); `advance()` moves it. Nothing here touches the network.
 *
 * Works under Deno and under Node with the Deno shim (same code path as prod:
 * db/*.ts → helper/firestore/firestoreService.ts → fetchWithAuth → fetch).
 */

import { fromFirestoreFields } from "../../helper/firestore/fromFirestoreValue.ts";
import { toFirestoreDocument } from "../../helper/firestore/toFirestoreValue.ts";

type Doc = Record<string, unknown>;

export const PROJECT_ID = "ilp-e2e";
const FS_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const CAL_ROOT = "https://www.googleapis.com/calendar/v3";

export interface CalendarEventRec {
  id: string;
  start: string;
  end: string;
  attendees: string[];
  meetUrl: string;
  deleted?: boolean;
  attachments?: Array<{ fileId: string; title: string; mimeType: string }>;
}

export interface FakeWorld {
  /** collection → id → stored plain document */
  db: Map<string, Map<string, Doc>>;
  calendar: Map<string, CalendarEventRec>;
  /** Drive file id → text (Meet transcripts). */
  drive: Map<string, string>;
  /** When true, Calendar event creation answers 500 (Meet link failure path). */
  failCalendar: boolean;
  /** Every request the fake answered, for assertions ("no transcript fetched"). */
  requests: Array<{ method: string; url: string }>;
  now(): Date;
  setNow(iso: string): void;
  advance(ms: number): void;
  /** Plain copy of a collection's documents (with id). Loosely typed for assertions. */
  // deno-lint-ignore no-explicit-any
  all(collection: string): Array<Record<string, any>>;
  // deno-lint-ignore no-explicit-any
  doc(collection: string, id: string): Record<string, any> | null;
  put(collection: string, id: string, data: Doc): void;
  /** Queued emails (email_queue), newest last. */
  // deno-lint-ignore no-explicit-any
  emails(): Array<Record<string, any>>;
  /** Restore the real fetch and Date. */
  restore(): void;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Read a dotted field path ("a.b") from a document. */
function readPath(doc: Doc, path: string): unknown {
  if (path === "__name__") return doc.__id;
  let cur: unknown = doc;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Doc)[p.replace(/^`|`$/g, "")];
  }
  return cur;
}

function decodeValue(v: unknown): unknown {
  return fromFirestoreFields({ x: v }).x;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matches(doc: Doc, filter: Doc | undefined): boolean {
  if (!filter) return true;
  if (filter.compositeFilter) {
    const cf = filter.compositeFilter as { op: string; filters: Doc[] };
    return cf.op === "OR" ? cf.filters.some((f) => matches(doc, f)) : cf.filters.every((f) => matches(doc, f));
  }
  if (filter.fieldFilter) {
    const ff = filter.fieldFilter as { field: { fieldPath: string }; op: string; value: unknown };
    const have = readPath(doc, ff.field.fieldPath);
    const want = decodeValue(ff.value);
    switch (ff.op) {
      case "EQUAL": return JSON.stringify(have) === JSON.stringify(want);
      case "NOT_EQUAL": return have !== undefined && JSON.stringify(have) !== JSON.stringify(want);
      case "LESS_THAN": return have !== undefined && cmp(have, want) < 0;
      case "LESS_THAN_OR_EQUAL": return have !== undefined && cmp(have, want) <= 0;
      case "GREATER_THAN": return have !== undefined && cmp(have, want) > 0;
      case "GREATER_THAN_OR_EQUAL": return have !== undefined && cmp(have, want) >= 0;
      case "ARRAY_CONTAINS": return Array.isArray(have) && have.some((x) => JSON.stringify(x) === JSON.stringify(want));
      case "IN": return Array.isArray(want) && want.some((x) => JSON.stringify(x) === JSON.stringify(have));
      default: throw new Error(`fake firestore: unsupported op ${ff.op}`);
    }
  }
  if (filter.unaryFilter) {
    const uf = filter.unaryFilter as { field: { fieldPath: string }; op: string };
    const have = readPath(doc, uf.field.fieldPath);
    if (uf.op === "IS_NULL") return have === null;
    if (uf.op === "IS_NOT_NULL") return have !== null && have !== undefined;
  }
  return true;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export function installFakeWorld(startIso: string, opts: { suggestion?: { summary: string; nextSteps: Doc[] } } = {}): FakeWorld {
  const RealDate = Date;
  const realFetch = globalThis.fetch;
  let nowMs = RealDate.parse(startIso);

  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(nowMs);
      else super(...(args as [string]));
    }
    static override now() {
      return nowMs;
    }
  }
  (globalThis as unknown as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;

  const db = new Map<string, Map<string, Doc>>();
  const coll = (name: string) => {
    let c = db.get(name);
    if (!c) db.set(name, (c = new Map()));
    return c;
  };
  const calendar = new Map<string, CalendarEventRec>();
  const drive = new Map<string, string>();
  const requests: FakeWorld["requests"] = [];
  let autoId = 0;
  let evId = 0;

  const encodeDoc = (collection: string, id: string, data: Doc) => ({
    name: `projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`,
    ...toFirestoreDocument(data),
  });

  const world: FakeWorld = {
    db,
    calendar,
    drive,
    failCalendar: false,
    requests,
    now: () => new RealDate(nowMs),
    setNow: (iso) => void (nowMs = RealDate.parse(iso)),
    advance: (ms) => void (nowMs += ms),
    all: (collection) => [...coll(collection).entries()].map(([id, d]) => ({ ...clone(d), id })),
    doc: (collection, id) => {
      const d = coll(collection).get(id);
      return d ? { ...clone(d), id } : null;
    },
    put: (collection, id, data) => void coll(collection).set(id, clone(data)),
    emails: () => world.all("email_queue").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    restore: () => {
      globalThis.fetch = realFetch;
      (globalThis as unknown as { Date: DateConstructor }).Date = RealDate;
    },
  };

  async function firestore(method: string, url: URL, body: Doc | null): Promise<Response> {
    const rest = decodeURIComponent(url.pathname).replace(`/v1/projects/${PROJECT_ID}/databases/(default)/documents`, "");
    // documents:runQuery
    if (rest === ":runQuery") {
      const sq = (body?.structuredQuery ?? {}) as Doc;
      const from = (sq.from as Array<{ collectionId: string }>)[0].collectionId;
      let rows = [...coll(from).entries()].map(([id, d]) => ({ ...clone(d), __id: id })) as Doc[];
      rows = rows.filter((d) => matches(d, sq.where as Doc | undefined));
      const order = (sq.orderBy as Array<{ field: { fieldPath: string }; direction?: string }> | undefined) ?? [];
      if (order.length) {
        rows = rows.filter((d) => order.every((o) => o.field.fieldPath === "__name__" || readPath(d, o.field.fieldPath) !== undefined));
        rows.sort((a, b) => {
          for (const o of order) {
            const c = cmp(readPath(a, o.field.fieldPath), readPath(b, o.field.fieldPath));
            if (c) return o.direction === "DESCENDING" ? -c : c;
          }
          return 0;
        });
        const startAt = sq.startAt as { values: unknown[]; before?: boolean } | undefined;
        if (startAt) {
          const keys = startAt.values.map((v, i) => {
            const x = decodeValue(v);
            return order[i]?.field.fieldPath === "__name__" ? String(x).split("/").pop() : x;
          });
          const idx = rows.findIndex((r) => {
            for (let i = 0; i < keys.length; i++) {
              const c = cmp(readPath(r, order[i].field.fieldPath), keys[i]);
              const dc = order[i].direction === "DESCENDING" ? -c : c;
              if (dc !== 0) return dc > 0;
            }
            return startAt.before !== false;
          });
          rows = idx < 0 ? [] : rows.slice(idx);
        }
      }
      if (typeof sq.limit === "number") rows = rows.slice(0, sq.limit);
      if (!rows.length) return json(200, [{ readTime: new RealDate(nowMs).toISOString() }]);
      return json(200, rows.map((r) => {
        const { __id, ...data } = r;
        return { document: encodeDoc(from, String(__id), data) };
      }));
    }
    if (rest === ":commit") {
      for (const w of (body?.writes ?? []) as Doc[]) {
        const upd = w.update as { name: string; fields?: Doc };
        const parts = upd.name.split("/documents/")[1].split("/").map(decodeURIComponent);
        const [collection, id] = [parts[0], parts[1]];
        const existing = coll(collection).get(id);
        if ((w.currentDocument as Doc | undefined)?.exists === true && !existing) return json(404, { error: { status: "NOT_FOUND" } });
        const next = clone(existing ?? {}) as Doc;
        const data = fromFirestoreFields(upd.fields ?? {});
        for (const path of ((w.updateMask as { fieldPaths: string[] } | undefined)?.fieldPaths ?? [])) {
          const keys = path.split(".").map((k) => k.replace(/^`|`$/g, ""));
          let src: unknown = data;
          for (const k of keys) src = (src as Doc | undefined)?.[k];
          let node = next;
          for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Doc;
          if (src === undefined) delete node[keys[keys.length - 1]];
          else node[keys[keys.length - 1]] = src;
        }
        for (const t of ((w.updateTransforms ?? []) as Doc[])) {
          const field = String(t.fieldPath).replace(/`/g, "");
          const arr = Array.isArray(next[field]) ? (next[field] as unknown[]) : [];
          if (t.appendMissingElements) {
            for (const v of ((t.appendMissingElements as { values: unknown[] }).values)) {
              const x = decodeValue(v);
              if (!arr.some((y) => JSON.stringify(y) === JSON.stringify(x))) arr.push(x);
            }
          }
          if (t.removeAllFromArray) {
            const rm = (t.removeAllFromArray as { values: unknown[] }).values.map((v) => JSON.stringify(decodeValue(v)));
            next[field] = arr.filter((y) => !rm.includes(JSON.stringify(y)));
            continue;
          }
          next[field] = arr;
        }
        coll(collection).set(id, next);
      }
      return json(200, { writeResults: [] });
    }
    const segs = rest.replace(/^\//, "").split("/");
    if (segs.length === 1) {
      const collection = segs[0];
      if (method === "GET") {
        return json(200, { documents: [...coll(collection).entries()].map(([id, d]) => encodeDoc(collection, id, d)) });
      }
      if (method === "POST") {
        const wanted = url.searchParams.get("documentId");
        const id = wanted ?? `auto${String(++autoId).padStart(6, "0")}`;
        if (wanted && coll(collection).has(id)) return json(409, { error: { status: "ALREADY_EXISTS", message: "Document already exists" } });
        const data = fromFirestoreFields(((body ?? {}) as Doc).fields as Doc ?? {});
        coll(collection).set(id, data);
        return json(200, encodeDoc(collection, id, data));
      }
    }
    if (segs.length === 2) {
      const [collection, id] = segs;
      const existing = coll(collection).get(id);
      if (method === "GET") return existing ? json(200, encodeDoc(collection, id, existing)) : json(404, { error: { status: "NOT_FOUND" } });
      if (method === "DELETE") {
        if (!existing) return json(404, { error: { status: "NOT_FOUND" } });
        coll(collection).delete(id);
        return json(200, {});
      }
      if (method === "PATCH") {
        if (url.searchParams.get("currentDocument.exists") === "false" && existing) {
          return json(409, { error: { status: "ALREADY_EXISTS" } });
        }
        const data = fromFirestoreFields(((body ?? {}) as Doc).fields as Doc ?? {});
        const mask = url.searchParams.getAll("updateMask.fieldPaths");
        let next: Doc;
        if (mask.length) {
          next = clone(existing ?? {}) as Doc;
          for (const raw of mask) {
            const k = raw.replace(/^`|`$/g, "").replace(/\\`/g, "`").replace(/\\\\/g, "\\");
            if (k in data) next[k] = data[k];
            else delete next[k];
          }
        } else {
          next = data;
        }
        coll(collection).set(id, next);
        return json(200, encodeDoc(collection, id, next));
      }
    }
    return json(400, { error: { message: `fake firestore: unsupported ${method} ${url.pathname}` } });
  }

  function calendarApi(method: string, url: URL, body: Doc | null): Response {
    const path = decodeURIComponent(url.pathname);
    if (path.endsWith("/freeBusy")) {
      const items = ((body?.items ?? []) as Array<{ id: string }>);
      return json(200, { calendars: Object.fromEntries(items.map((i) => [i.id, { busy: [] }])) });
    }
    const m = /\/calendars\/[^/]+\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return json(404, {});
    const id = m[1];
    if (!id && method === "POST") {
      if (world.failCalendar) return json(500, { error: { message: "fake calendar outage" } });
      const eid = `ev${++evId}`;
      const b = body as { start: { dateTime: string }; end: { dateTime: string }; attendees?: Array<{ email: string }> };
      const rec: CalendarEventRec = {
        id: eid,
        start: b.start.dateTime,
        end: b.end.dateTime,
        attendees: (b.attendees ?? []).map((a) => a.email),
        meetUrl: `https://meet.google.com/fak-e${String(evId).padStart(3, "0")}-xyz`,
      };
      calendar.set(eid, rec);
      return json(200, { id: eid, hangoutLink: rec.meetUrl, htmlLink: `https://calendar.google.com/${eid}` });
    }
    if (!id) return json(200, { items: [] });
    const rec = calendar.get(id);
    if (!rec || rec.deleted) return json(404, {});
    if (method === "GET") {
      return json(200, { id, hangoutLink: rec.meetUrl, attachments: rec.attachments ?? [], description: "" });
    }
    if (method === "DELETE") {
      rec.deleted = true;
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH" || method === "PUT") {
      const b = body as { start?: { dateTime: string }; end?: { dateTime: string } };
      if (b.start) rec.start = b.start.dateTime;
      if (b.end) rec.end = b.end.dateTime;
      return json(200, { id, hangoutLink: rec.meetUrl });
    }
    return json(400, {});
  }

  const fakeFetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url: string }).url);
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ method, url: href });
    const url = new URL(href);
    const raw = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null;
    const body = raw && raw.trim().startsWith("{") ? JSON.parse(raw) as Doc : null;
    if (href.startsWith("https://oauth2.googleapis.com/token")) return json(200, { access_token: "fake-token", expires_in: 3600 });
    if (href.startsWith(FS_ROOT)) return firestore(method, url, body);
    if (href.startsWith(CAL_ROOT)) return calendarApi(method, url, body);
    if (href.startsWith("https://www.googleapis.com/drive/v3/files/")) {
      const fileId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      const text = drive.get(fileId);
      return text ? new Response(text, { status: 200 }) : json(404, {});
    }
    if (href.startsWith("https://openrouter.ai/")) {
      const s = opts.suggestion ?? { summary: "Discussed the question.", nextSteps: [{ what: "Send the documents", who: "client", dueInDays: 7 }] };
      return json(200, { choices: [{ message: { content: JSON.stringify(s) } }], usage: {} });
    }
    throw new Error(`fake world: no network in tests (${method} ${href})`);
  };
  globalThis.fetch = fakeFetch as typeof fetch;
  return world;
}

/** An RSA key in a service-account JSON, so the real token code can sign. */
export async function fakeServiceAccount(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ project_id: PROJECT_ID, client_email: "e2e@ilp-e2e.iam.gserviceaccount.com", private_key: pem, token_uri: "https://oauth2.googleapis.com/token" });
}

/** Env the server reads in tests (service account, calendar, manual payments, roles). Returns the key. */
export async function useFakeEnv(extra: Record<string, string> = {}): Promise<void> {
  const env: Record<string, string> = {
    SERVICE_ACCOUNT_KEY: Deno.env.get("SERVICE_ACCOUNT_KEY")?.includes(PROJECT_ID) ? Deno.env.get("SERVICE_ACCOUNT_KEY")! : await fakeServiceAccount(),
    CALENDAR_ID: "calls@internationallegalpartner.com",
    GOOGLE_SUBJECT_EMAIL: "calls@internationallegalpartner.com",
    PAYMENTS_MODE: "manual",
    FRONTEND_URL: "https://app.e2e-ilp.io",
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
}

