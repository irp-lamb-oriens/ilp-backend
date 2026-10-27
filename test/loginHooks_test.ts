import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { loginHooks } from "../helper/auth/loginHooks.ts";
import { registerSessionHooks } from "../helper/auth/sessionHooks.ts";

/**
 * loginHooks + session hooks against a fake Express req/res: a successful
 * verify-otp keeps `token` and `expiresAt` in the JSON body (Bearer auth) and
 * sets no cookie unless AUTH_COOKIES=true; a failure sets nothing.
 * Audit writes are fire-and-forget (they fail quietly without Firestore).
 *
 * Run: deno test --allow-env test/loginHooks_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;

function fakeRes() {
  const headers: Record<string, unknown> = {};
  let sent: unknown;
  let resolveSent: () => void;
  const done = new Promise<void>((r) => (resolveSent = r));
  const res: Any = {
    statusCode: 200,
    status(n: number) { this.statusCode = n; return this; },
    getHeader: (k: string) => headers[k.toLowerCase()],
    setHeader: (k: string, v: unknown) => { headers[k.toLowerCase()] = v; return res; },
    json(b: unknown) { sent = b; resolveSent(); return this; },
  };
  return { res, headers, done, body: () => sent };
}

Deno.test({
  name: "lawyer login returns token + 12 h expiresAt and sets no cookie (Bearer default)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.delete("AUTH_COOKIES");
    registerSessionHooks();
    const req: Any = { method: "POST", path: "/api/provider/auth/verify-otp", body: { email: "Lawyer@x.com" }, headers: {} };
    const f = fakeRes();
    loginHooks(req, f.res, () => {});
    f.res.json({ success: true, token: "tok123", email: "lawyer@x.com", expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() });
    await f.done;
    const body = f.body() as Any;
    assertEquals(body.token, "tok123");
    const hours = (new Date(body.expiresAt).getTime() - Date.now()) / 3600_000;
    assertEquals(hours > 11.9 && hours <= 12, true);
    assertEquals(f.headers["set-cookie"], undefined);
  },
});

Deno.test({
  name: "AUTH_COOKIES=true also sets the HttpOnly cookie; client sessions last 7 days",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("AUTH_COOKIES", "true");
    Deno.env.set("COOKIE_INSECURE", "false");
    registerSessionHooks();
    const req: Any = { method: "POST", path: "/api/client-status/auth/verify-otp", body: { email: "m@x.com" }, headers: {} };
    const f = fakeRes();
    loginHooks(req, f.res, () => {});
    f.res.json({ success: true, token: "ctok", email: "m@x.com" });
    await f.done;
    const body = f.body() as Any;
    Deno.env.delete("AUTH_COOKIES");
    assertEquals(body.token, "ctok");
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86400_000;
    assertEquals(days > 6.99 && days <= 7, true);
    const cookies = f.headers["set-cookie"] as string[];
    assertEquals(cookies.length, 1);
    assertEquals(cookies[0].startsWith("ilp_client_session=ctok; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age="), true);
  },
});

Deno.test({
  name: "failed verify sets no cookie and passes the error through",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const req: Any = { method: "POST", path: "/api/client-status/auth/verify-otp", body: { email: "a@b.c" }, headers: {} };
    const f = fakeRes();
    loginHooks(req, f.res, () => {});
    f.res.status(401).json({ error: "Invalid verification code." });
    await f.done;
    assertEquals(f.headers["set-cookie"], undefined);
    assertEquals((f.body() as Any).error, "Invalid verification code.");
  },
});

Deno.test("other routes are untouched", () => {
  const req: Any = { method: "POST", path: "/api/leads", body: {}, headers: {} };
  const f = fakeRes();
  const original = f.res.json;
  let called = false;
  loginHooks(req, f.res, () => (called = true));
  assertEquals(called, true);
  assertEquals(f.res.json, original);
});
