import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { requireDashboardAuth } from "../helper/auth/session.ts";
import { sessionStore } from "../helper/auth/sessionStore.ts";
import { staffRoleFor } from "../helper/auth/roles.ts";
import { scopeOf } from "../API/csm/book.ts";

/**
 * AUTH (2026-10-29): who gets into the CSM portal (GET /api/csm/me runs
 * requireDashboardAuth, then scopeOf).
 *   - a dashboard (staff) session is the CSM session: the same token passes;
 *   - a CSM listed in CSM_EMAILS gets role csm and their own book;
 *   - with CSM_EMAILS unset the same person is plain staff: still a valid
 *     session (200, viewing as staff), never a 401 that loops to the login;
 *   - a CSM asking for another CSM's book is 403, not 401;
 *   - no token or an expired one is 401.
 *
 * Run: deno test --allow-env test/csmSession_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;
type Doc = Record<string, unknown>;
const H = 3600_000;
const CARLA = "carla@internationallegalpartner.com";

const sessions = new Map<string, Doc>();
sessionStore.get = ((_c: string, id: string) => Promise.resolve(sessions.get(id) ?? null)) as Any;
sessionStore.put = ((_c: string, id: string, d: Doc) => {
  sessions.set(id, { ...(sessions.get(id) ?? {}), ...d });
  return Promise.resolve();
}) as Any;
sessionStore.patch = sessionStore.put as Any;
sessionStore.remove = ((_c: string, id: string) => Promise.resolve(sessions.delete(id))) as Any;

function seed() {
  sessions.clear();
  sessions.set("carlaTok", { email: CARLA, createdAt: new Date(Date.now() - H).toISOString(), expiresAt: new Date(Date.now() + 11 * H).toISOString() });
  sessions.set("oldTok", { email: CARLA, createdAt: new Date(Date.now() - 30 * H).toISOString(), expiresAt: new Date(Date.now() - H).toISOString() });
}

function call(token: string | null, query: Doc = {}): Promise<{ status: number; next: boolean; req: Any }> {
  const r: Any = { headers: token ? { authorization: `Bearer ${token}` } : {}, query, path: "/api/csm/me", method: "GET" };
  return new Promise((resolve) => {
    const res: Any = {
      statusCode: 200,
      status(n: number) { this.statusCode = n; return this; },
      json() { resolve({ status: this.statusCode, next: false, req: r }); return this; },
      getHeader: () => undefined,
      setHeader: () => {},
    };
    requireDashboardAuth(r, res, () => resolve({ status: 200, next: true, req: r }));
  });
}

Deno.test("CSM in CSM_EMAILS: the dashboard session passes and scopes to their own book", async () => {
  seed();
  Deno.env.delete("AUTH_COOKIES");
  Deno.env.set("CSM_EMAILS", CARLA);
  assertEquals(staffRoleFor(CARLA), "csm");
  const r = await call("carlaTok");
  assertEquals([r.next, r.req.dashboardRole], [true, "csm"]);
  const s = scopeOf(r.req);
  assertEquals(s.ok && s.scope.csm, CARLA);
});

Deno.test("CSM_EMAILS unset: a valid session is staff (200), not 401", async () => {
  seed();
  Deno.env.delete("CSM_EMAILS");
  const r = await call("carlaTok");
  assertEquals([r.next, r.req.dashboardRole], [true, "staff"]);
  assertEquals(scopeOf(r.req).ok, true);
});

Deno.test("another CSM's book is 403; no token or an expired one is 401", async () => {
  seed();
  Deno.env.set("CSM_EMAILS", CARLA);
  const other = await call("carlaTok", { csm: "diego@internationallegalpartner.com" });
  const s = scopeOf(other.req);
  assertEquals(s.ok ? 200 : s.status, 403);
  assertEquals((await call(null)).status, 401);
  assertEquals((await call("oldTok")).status, 401);
  Deno.env.delete("CSM_EMAILS");
});
