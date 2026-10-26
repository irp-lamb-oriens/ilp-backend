import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  deepHealth,
  errorHandler,
  parseSentryDsn,
  registerHealthRoutes,
  resetErrorThrottle,
  sentryEvent,
  shouldReport,
} from "../helper/errorReporter.ts";

/**
 * P1 error reporting and deep health. Firestore and Sentry are not reached
 * (no service account in tests): writes fail quietly, which is the contract.
 *
 * Run: deno test --allow-env test/errorReporter_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;

function fakeRes() {
  const out: Any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  let done: () => void;
  out.sent = new Promise<void>((r) => (done = r));
  out.status = (n: number) => { out.statusCode = n; return out; };
  out.json = (b: unknown) => { out.body = b; done(); return out; };
  out.setHeader = (k: string, v: string) => { out.headers[k.toLowerCase()] = v; };
  return out;
}

Deno.test("Sentry DSN → store endpoint and public key", () => {
  assertEquals(parseSentryDsn("https://abc123@o42.ingest.sentry.io/777"), {
    url: "https://o42.ingest.sentry.io/api/777/store/",
    key: "abc123",
  });
  assertEquals(parseSentryDsn("https://k@sentry.example.com/sub/9"), { url: "https://sentry.example.com/sub/api/9/store/", key: "k" });
  assertEquals(parseSentryDsn(undefined), null);
  assertEquals(parseSentryDsn("not a url"), null);
});

Deno.test("Sentry event carries route, actor, message and stack, nothing from the request body", () => {
  const ev = sentryEvent({ name: "TypeError", message: "x is undefined", stack: "at a" }, { route: "GET /api/x", actor: "a@b.c" }, "e".repeat(32), "2026-10-26T00:00:00Z");
  assertEquals((ev.exception as Any).values[0], { type: "TypeError", value: "x is undefined" });
  assertEquals((ev.tags as Any).route, "GET /api/x");
  assertEquals((ev.user as Any).email, "a@b.c");
  assertEquals((ev.extra as Any).stack, "at a");
});

Deno.test("throttle: same error once a minute, 60 reports a minute at most", () => {
  resetErrorThrottle();
  const t = 1_000_000;
  assertEquals(shouldReport("r|boom", t), true);
  assertEquals(shouldReport("r|boom", t + 1000), false);
  assertEquals(shouldReport("r|boom", t + 61_000), true);
  resetErrorThrottle();
  let sent = 0;
  for (let i = 0; i < 100; i++) if (shouldReport(`k${i}`, t)) sent++;
  assertEquals(sent, 60);
  resetErrorThrottle();
});

Deno.test("error handler: 500 with an error id; body-parser 413 passes through unreported", async () => {
  resetErrorThrottle();
  const req: Any = { method: "GET", path: "/api/x/1", route: { path: "/api/x/:id" }, headers: {}, dashboardUser: "s@ilp.test" };
  const r1 = fakeRes();
  errorHandler(new Error("boom"), req, r1, () => {});
  await r1.sent;
  assertEquals(r1.statusCode, 500);
  assertEquals(r1.body.error, "Internal server error.");
  assertEquals(/^[0-9a-f]{32}$/.test(r1.body.errorId), true);

  const r2 = fakeRes();
  errorHandler(Object.assign(new Error("request entity too large"), { status: 413, type: "entity.too.large" }), req, r2, () => {});
  await r2.sent;
  assertEquals(r2.statusCode, 413);
  assertEquals(r2.body, { error: "That upload is too large." });
});

Deno.test("deep health: ok needs Firestore and email; reports cron and services", async () => {
  Deno.env.set("SMTP_HOST", "smtp.test");
  Deno.env.set("SMTP_USER", "u");
  Deno.env.set("SMTP_PASS", "p");
  Deno.env.set("CRON_RUNNER_ENABLED", "true");
  Deno.env.set("RENDER_EXTERNAL_URL", "https://api.example.com");
  const good = await deepHealth(() => Promise.resolve({ ok: true, ms: 3 }));
  assertEquals(good.ok, true);
  assertEquals(good.cron.enabled, true);
  const bad = await deepHealth(() => Promise.resolve({ ok: false, ms: 5000, error: "timeout" }));
  assertEquals(bad.ok, false);
  Deno.env.delete("SMTP_PASS");
  assertEquals((await deepHealth(() => Promise.resolve({ ok: true, ms: 1 }))).email.configured, false);
  for (const k of ["SMTP_HOST", "SMTP_USER", "CRON_RUNNER_ENABLED", "RENDER_EXTERNAL_URL"]) Deno.env.delete(k);
});

Deno.test("/health/deep: 404 without HEALTH_TOKEN, 401 on a wrong token", async () => {
  const routes: Record<string, Any> = {};
  const app: Any = { get: (p: string, h: Any) => (routes[p] = h) };
  registerHealthRoutes(app);
  Deno.env.delete("HEALTH_TOKEN");
  const r1 = fakeRes();
  await routes["/health/deep"]({ headers: {} }, r1);
  assertEquals(r1.statusCode, 404);
  Deno.env.set("HEALTH_TOKEN", "s3cret");
  const r2 = fakeRes();
  await routes["/health/deep"]({ headers: { "x-health-token": "nope" } }, r2);
  assertEquals(r2.statusCode, 401);
  Deno.env.delete("HEALTH_TOKEN");
});
