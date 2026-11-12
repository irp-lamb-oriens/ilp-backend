// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { cachedSession, clearSessionCache, forgetSession, sessionCacheStats } from "../helper/auth/sessionCache.ts";
import { clearReceipts, idempotency, receiptStats, validKey } from "../helper/idempotency.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const on = { enabled: true, ttlMs: 1000 };

Deno.test("session cache: one read per session per window; changes and misses are never served stale", async () => {
  clearSessionCache();
  let reads = 0;
  let stored: Record<string, unknown> | null = { email: "a@example.com", expiresAt: "2999-01-01T00:00:00.000Z" };
  const load = () => {
    reads++;
    return Promise.resolve(stored ? { ...stored } : null);
  };
  const first = await cachedSession("dashboard_sessions", "t1", load, { ...on, now: 0 });
  (first as Any).email = "changed by the caller";
  const second = await cachedSession("dashboard_sessions", "t1", load, { ...on, now: 500 });
  assertEquals([reads, second?.email], [1, "a@example.com"]);
  await cachedSession("dashboard_sessions", "t1", load, { ...on, now: 1500 }); // older than the window
  assertEquals(reads, 2);

  forgetSession("dashboard_sessions", "t1"); // sign-out forgets at once
  stored = null;
  assertEquals(await cachedSession("dashboard_sessions", "t1", load, { ...on, now: 1600 }), null);
  await cachedSession("dashboard_sessions", "t1", load, { ...on, now: 1700 }); // a missing session is not remembered
  assertEquals(reads, 4);

  stored = { used: false };
  await cachedSession("download_tickets", "x", load, { ...on, now: 0 });
  await cachedSession("download_tickets", "x", load, { ...on, now: 1 }); // tickets are always read
  await cachedSession("dashboard_sessions", "t2", load, { enabled: false }); // not armed: always read
  await cachedSession("dashboard_sessions", "t2", load, { enabled: false });
  assertEquals(reads, 8);
  assertEquals(sessionCacheStats().hits, 1);
});

function fakeReq(method: string, path: string, headers: Record<string, string>) {
  return { method, originalUrl: path, url: path, headers, ip: "1.1.1.1" } as Any;
}

function fakeRes() {
  const handlers: Record<string, Array<() => void>> = {};
  const res: Any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    sent: undefined as unknown,
    ended: false,
    setHeader(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
    },
    getHeader: (k: string) => res.headers[k.toLowerCase()],
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    send(body?: unknown) {
      res.sent = body;
      res.end();
      return res;
    },
    json(body: unknown) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(JSON.stringify(body));
    },
    end() {
      res.ended = true;
      for (const fn of handlers.finish ?? []) fn();
    },
    on(ev: string, fn: () => void) {
      (handlers[ev] ??= []).push(fn);
    },
    emit(ev: string) {
      for (const fn of handlers[ev] ?? []) fn();
    },
  };
  return res;
}

const KEY = "k_0123456789abcdef";
const text = (v: unknown) => (typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array));

Deno.test("write receipts: the same key runs once and replays the first answer", async () => {
  clearReceipts();
  const mw = idempotency();
  let runs = 0;
  const handler = (res: Any) => {
    runs++;
    res.status(201).json({ id: "note_1", n: runs });
  };
  const h = { authorization: "Bearer tok_a", "idempotency-key": KEY };

  const r1 = fakeRes();
  await mw(fakeReq("POST", "/api/x/notes?a=1", h), r1, () => handler(r1));
  const r2 = fakeRes();
  await mw(fakeReq("POST", "/api/x/notes?a=2", h), r2, () => handler(r2));
  assertEquals([runs, r2.statusCode, text(r2.sent), r2.headers["idempotency-replayed"]], [1, 201, '{"id":"note_1","n":1}', "true"]);
  assertEquals(r1.headers["x-ilp-sync"], "1");

  // Another session, another path, another method or no key: each runs for real.
  for (
    const [m, p, hh] of [
      ["POST", "/api/x/notes", { authorization: "Bearer tok_b", "idempotency-key": KEY }],
      ["POST", "/api/x/other", h],
      ["PUT", "/api/x/notes", h],
      ["POST", "/api/x/notes", { authorization: "Bearer tok_a" }],
      ["POST", "/api/x/notes", { authorization: "Bearer tok_a", "idempotency-key": "short" }],
    ] as Array<[string, string, Record<string, string>]>
  ) {
    const r = fakeRes();
    await mw(fakeReq(m, p, hh), r, () => handler(r));
  }
  assertEquals(runs, 6);
  assertEquals(receiptStats().replays, 1);
  assertEquals([validKey(KEY), validKey("bad key with spaces!")], [true, false]);
});

Deno.test("write receipts: no second run while the first is in flight; failures are retried for real", async () => {
  clearReceipts();
  const mw = idempotency();
  const h = { authorization: "Bearer tok_a", "idempotency-key": KEY };
  let runs = 0;

  const slow = fakeRes();
  await mw(fakeReq("PATCH", "/api/me/profile", h), slow, () => void runs++); // still running
  const dup = fakeRes();
  await mw(fakeReq("PATCH", "/api/me/profile", h), dup, () => void runs++);
  assertEquals([runs, dup.statusCode, JSON.parse(dup.sent).code, dup.headers["retry-after"]], [1, 409, "request_in_progress", "1"]);

  slow.status(503).json({ error: "down" }); // the first one failed: forget it
  const again = fakeRes();
  await mw(fakeReq("PATCH", "/api/me/profile", h), again, () => {
    runs++;
    again.json({ ok: true });
  });
  assertEquals([runs, again.headers["idempotency-replayed"]], [2, undefined]);

  // A dropped connection (close without finish) is also forgotten.
  const h2 = { ...h, "idempotency-key": KEY + "_2" };
  const cut = fakeRes();
  await mw(fakeReq("DELETE", "/api/me/x", h2), cut, () => void runs++);
  cut.emit("close");
  const retry = fakeRes();
  await mw(fakeReq("DELETE", "/api/me/x", h2), retry, () => {
    runs++;
    retry.status(204).end();
  });
  const replay = fakeRes();
  await mw(fakeReq("DELETE", "/api/me/x", h2), replay, () => void runs++);
  assertEquals([runs, replay.statusCode, replay.ended, replay.headers["idempotency-replayed"]], [4, 204, true, "true"]);

  // A final 4xx is an answer too: the same bad change is not run again.
  const h3 = { ...h, "idempotency-key": KEY + "_3" };
  const bad = fakeRes();
  await mw(fakeReq("POST", "/api/me/y", h3), bad, () => bad.status(400).json({ error: "Name is required" }));
  const bad2 = fakeRes();
  await mw(fakeReq("POST", "/api/me/y", h3), bad2, () => void runs++);
  assertEquals([runs, bad2.statusCode], [4, 400]);
});
