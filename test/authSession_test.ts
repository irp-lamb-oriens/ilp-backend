import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { CLIENT_SESSION_MAX_AGE_MS, nextClientExpiry, SESSION_TTL_MS } from "../helper/auth/cookies.ts";
import { requireClientAuth, requireDashboardAuth, requireProviderAuth } from "../helper/auth/session.ts";

/**
 * Session lifetimes and the no-credential path.
 * - A request with no Bearer, no legacy header and no cookie is a 401 without
 *   any Firestore read; `?token=` is never a credential. (Bearer lookups are
 *   covered in authBearer_test.ts against an in-memory store.)
 * - Lifetimes: staff/lawyer 12 h, client 7 d sliding, capped at 30 d.
 *
 * Run: deno test --allow-env test/authSession_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;
const H = 3600_000;

function call(mw: Any, req: Any): Promise<{ status: number; next: boolean }> {
  return new Promise((resolve) => {
    const res: Any = {
      statusCode: 200,
      status(n: number) { this.statusCode = n; return this; },
      json() { resolve({ status: this.statusCode, next: false }); return this; },
      getHeader: () => undefined,
      setHeader: () => {},
    };
    mw(req, res, () => resolve({ status: 200, next: true }));
  });
}

Deno.test("no credential (only ?token= or a cookie with AUTH_COOKIES unset) is a 401", async () => {
  Deno.env.delete("AUTH_COOKIES");
  const base = { query: { token: "q" }, path: "/x", method: "GET" };
  const cookie = "ilp_staff_session=t; ilp_lawyer_session=t; ilp_client_session=t";
  assertEquals((await call(requireDashboardAuth, { ...base, headers: { cookie } })).status, 401);
  assertEquals((await call(requireProviderAuth, { ...base, headers: { cookie } })).status, 401);
  assertEquals((await call(requireClientAuth, { ...base, headers: { cookie } })).status, 401);
});

Deno.test("lifetimes: staff and lawyer 12 h, client 7 d", () => {
  assertEquals(SESSION_TTL_MS.staff, 12 * H);
  assertEquals(SESSION_TTL_MS.lawyer, 12 * H);
  assertEquals(SESSION_TTL_MS.client, 7 * 24 * H);
});

Deno.test("client sessions slide at most once an hour", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const created = new Date(now - 2 * 24 * H).toISOString();
  // Refreshed 10 minutes ago: nothing to do.
  assertEquals(nextClientExpiry({ createdAt: created, expiresAt: new Date(now + 7 * 24 * H - 10 * 60_000).toISOString() }, now), null);
  // Refreshed 2 h ago: push to now + 7 d.
  assertEquals(
    nextClientExpiry({ createdAt: created, expiresAt: new Date(now + 7 * 24 * H - 2 * H).toISOString() }, now),
    new Date(now + 7 * 24 * H).toISOString(),
  );
});

Deno.test("client sessions never slide past 30 days from login", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const created = now - 29 * 24 * H;
  const r = nextClientExpiry({ createdAt: new Date(created).toISOString(), expiresAt: new Date(now + 2 * H).toISOString() }, now);
  assertEquals(r, new Date(created + CLIENT_SESSION_MAX_AGE_MS).toISOString());
  // Already at the cap: no change.
  assertEquals(nextClientExpiry({ createdAt: new Date(created).toISOString(), expiresAt: r }, now), null);
});
