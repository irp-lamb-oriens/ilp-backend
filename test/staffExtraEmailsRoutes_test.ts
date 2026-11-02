import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { fakeServiceAccount, type FakeWorld, installFakeWorld } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { emailToDocId, issueOtp } from "../helper/auth/otp.ts";
import { requireClientAuth, requireProviderAuth } from "../helper/auth/session.ts";

/**
 * DASHBOARD_EXTRA_ALLOWED_EMAILS through the real routes and middleware:
 *   - POST /api/dashboard/auth/request-otp and /verify-otp (the /dashboard and
 *     /csm login) refuse an outside address with 403 unless it is listed;
 *   - a listed address gets a staff session with its role from ADMIN_EMAILS;
 *   - the audited staff bypass (session.ts staffDomainOk) follows the same list.
 * Firestore is the in-memory fake (test/e2e/fakeWorld.ts).
 *
 * Run: deno test --allow-env --allow-read test/staffExtraEmailsRoutes_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;
const MERLIN = "merlin@aiexecutions.com";
let world: FakeWorld;
let app: FakeApp;

async function setup() {
  Deno.env.set("SERVICE_ACCOUNT_KEY", await fakeServiceAccount());
  for (const k of ["AUTH_COOKIES", "DASHBOARD_ALLOWED_DOMAIN", "SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) Deno.env.delete(k);
  Deno.env.set("ADMIN_EMAILS", `boss@internationallegalpartner.com,${MERLIN}`);
  world = installFakeWorld("2026-11-02T15:00:00.000Z");
  app = new FakeApp();
  (await import("../API/dashboard/dashboardRouter.ts")).default(app as Any);
}

function staffSession(email: string): string {
  const token = `stf_${email.replace(/\W/g, "_")}`;
  world.put("dashboard_sessions", token, { email, createdAt: world.now().toISOString(), expiresAt: new Date(world.now().getTime() + 3_600_000).toISOString() });
  return token;
}

/** Run one session middleware on a bare request; true when it called next(). */
function passes(mw: (req: Any, res: Any, next: () => void) => Promise<void>, token: string, query: Record<string, string> = {}): Promise<{ next: boolean; req: Any }> {
  const req: Any = { headers: { authorization: `Bearer ${token}` }, query, path: "/x", method: "GET", cookies: {} };
  return new Promise((resolve) => {
    const res: Any = {
      statusCode: 200,
      status(n: number) { this.statusCode = n; return this; },
      json() { resolve({ next: false, req }); return this; },
      getHeader: () => undefined,
      setHeader: () => {},
      cookie() { return this; },
    };
    mw(req, res, () => resolve({ next: true, req }));
  });
}

Deno.test("extra staff emails: request-otp and verify-otp refuse an outside address while the list is empty", async () => {
  await setup();
  try {
    Deno.env.delete("DASHBOARD_EXTRA_ALLOWED_EMAILS");
    const r = await app.call("POST", "/api/dashboard/auth/request-otp", { body: { email: MERLIN } });
    assertEquals(r.status, 403);
    assertEquals(r.body.error, "Access restricted to ILP team members.");
    assertEquals(world.doc("dashboard_otps", emailToDocId(MERLIN)), null, "no code issued");
    const v = await app.call("POST", "/api/dashboard/auth/verify-otp", { body: { email: MERLIN, code: "123456" } });
    assertEquals(v.status, 403);
  } finally {
    world.restore();
  }
});

Deno.test("extra staff emails: a listed address gets a code, signs in, and is admin from ADMIN_EMAILS", async () => {
  await setup();
  try {
    Deno.env.set("DASHBOARD_EXTRA_ALLOWED_EMAILS", `ops@x.io, ${MERLIN.toUpperCase()}`);
    const r = await app.call("POST", "/api/dashboard/auth/request-otp", { body: { email: MERLIN } });
    assert(r.status !== 403, `request-otp not refused (${r.status} ${JSON.stringify(r.body)})`);
    assert(world.doc("dashboard_otps", emailToDocId(MERLIN)), "a code was issued for merlin");
    // Re-issue with a known code (the real one only goes out by email); skip the resend cooldown.
    world.advance(60_000);
    const issued = await issueOtp("dashboard_otps", emailToDocId(MERLIN), MERLIN);
    assert(issued.ok);
    const v = await app.call("POST", "/api/dashboard/auth/verify-otp", { body: { email: ` ${MERLIN} `, code: issued.ok ? issued.code : "" } });
    assertEquals(v.status, 200, JSON.stringify(v.body));
    assertEquals([v.body.email, v.body.role], [MERLIN, "admin"]);
    assert(world.doc("dashboard_sessions", v.body.token), "staff session stored");
    // Another address on the same outside domain is still refused.
    const other = await app.call("POST", "/api/dashboard/auth/request-otp", { body: { email: "someone@aiexecutions.com" } });
    assertEquals(other.status, 403);
  } finally {
    world.restore();
  }
});

Deno.test("extra staff emails: the audited staff bypass (lawyer and member portals) follows the same list", async () => {
  await setup();
  try {
    const tok = staffSession(MERLIN);
    Deno.env.delete("DASHBOARD_EXTRA_ALLOWED_EMAILS");
    assertEquals((await passes(requireProviderAuth as Any, tok)).next, false, "outside address: no lawyer bypass");
    assertEquals((await passes(requireClientAuth as Any, tok, { clientId: "c1" })).next, false, "outside address: no member bypass");
    Deno.env.set("DASHBOARD_EXTRA_ALLOWED_EMAILS", MERLIN);
    const p = await passes(requireProviderAuth as Any, tok);
    assertEquals([p.next, p.req.providerUser], [true, MERLIN]);
    const c = await passes(requireClientAuth as Any, tok, { clientId: "c1" });
    assertEquals([c.next, c.req.isIrpStaff, c.req.clientId], [true, true, "c1"]);
    // The domain itself still works with the list set.
    const ana = staffSession("ana@internationallegalpartner.com");
    assertEquals((await passes(requireProviderAuth as Any, ana)).next, true);
  } finally {
    Deno.env.delete("DASHBOARD_EXTRA_ALLOWED_EMAILS");
    world.restore();
  }
});
