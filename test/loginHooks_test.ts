import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { loginHooks } from "../helper/auth/loginHooks.ts";
import { registerSessionHooks } from "../helper/auth/sessionHooks.ts";

/**
 * loginHooks + session hooks against a fake Express req/res: a successful
 * lawyer verify-otp keeps the JSON body (token included, for header clients)
 * and sets the HttpOnly lawyer cookie; a failure sets nothing.
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
  name: "lawyer login sets the HttpOnly cookie and keeps the token in the body",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    Deno.env.set("COOKIE_INSECURE", "false");
    registerSessionHooks();
    const req: Any = { method: "POST", path: "/api/provider/auth/verify-otp", body: { email: "Lawyer@x.com" }, headers: {} };
    const f = fakeRes();
    loginHooks(req, f.res, () => {});
    f.res.json({ success: true, token: "tok123", email: "lawyer@x.com", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    await f.done;
    assertEquals((f.body() as Any).token, "tok123");
    const cookies = f.headers["set-cookie"] as string[];
    assertEquals(cookies.length, 1);
    assertEquals(cookies[0].startsWith("ilp_lawyer_session=tok123; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age="), true);
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
