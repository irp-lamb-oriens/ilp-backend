import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { requireDashboardAuth } from "../helper/auth/session.ts";
import { sessionStore } from "../helper/auth/sessionStore.ts";
import { adminEmails, requireStaffRole, staffRoleFor, warnIfNoAdmins } from "../helper/auth/roles.ts";
import { FINANCE_ADMIN } from "../API/finance/financeAuth.ts";

/**
 * ROLES: who may open the Reports page and the money routes.
 *   - operational reports (/api/analytics/funnel, /api/analytics/pmf,
 *     /api/dashboard/metrics): any staff session (staff, csm, admin);
 *   - money (sales report, finance ledger/metrics, invoices): admin only;
 *   - the role is resolved from ADMIN_EMAILS / OWNER_EMAILS / CSM_EMAILS on
 *     every request (trimmed, case-insensitive), not from the role stamped
 *     on the session at login.
 *
 * Run: deno test --allow-env --allow-read test/staffRoles_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;
type Doc = Record<string, unknown>;
const H = 3600_000;

const sessions = new Map<string, Doc>();
sessionStore.get = ((_c: string, id: string) => Promise.resolve(sessions.get(id) ?? null)) as Any;

function session(token: string, email: string, storedRole?: string) {
  sessions.set(token, {
    email,
    role: storedRole,
    createdAt: new Date(Date.now() - H).toISOString(),
    expiresAt: new Date(Date.now() + 11 * H).toISOString(),
  });
}

function env(admin: string, csm = "", owner = "") {
  for (const [k, v] of [["ADMIN_EMAILS", admin], ["CSM_EMAILS", csm], ["OWNER_EMAILS", owner]]) {
    if (v) Deno.env.set(k, v);
    else Deno.env.delete(k);
  }
}

/** Run a middleware chain like Express; resolves with the status (200 when every step called next). */
function chain(mws: readonly Any[], token: string): Promise<{ status: number; body?: Any; req: Any }> {
  const req: Any = { headers: { authorization: `Bearer ${token}` }, query: {}, path: "/x", method: "GET" };
  return new Promise((resolve) => {
    const res: Any = {
      statusCode: 200,
      status(n: number) { this.statusCode = n; return this; },
      json(b: unknown) { resolve({ status: this.statusCode, body: b, req }); return this; },
      getHeader: () => undefined,
      setHeader: () => {},
    };
    const step = (i: number) => {
      if (i >= mws.length) return resolve({ status: 200, req });
      Promise.resolve(mws[i](req, res, () => step(i + 1)));
    };
    step(0);
  });
}

const STAFF_REPORT = [requireDashboardAuth] as const; // funnel, pmf, dashboard metrics

Deno.test("access matrix: reports for every staff role, money for admin only", async () => {
  env("boss@internationallegalpartner.com", "carla@internationallegalpartner.com");
  session("staffTok", "sam@internationallegalpartner.com");
  session("csmTok", "carla@internationallegalpartner.com");
  session("adminTok", "boss@internationallegalpartner.com");
  const expect: Record<string, [number, number]> = { staffTok: [200, 403], csmTok: [200, 403], adminTok: [200, 200] };
  for (const [tok, [reports, money]] of Object.entries(expect)) {
    assertEquals((await chain(STAFF_REPORT, tok)).status, reports, `${tok} reports`);
    const m = await chain(FINANCE_ADMIN, tok);
    assertEquals(m.status, money, `${tok} money`);
    if (money === 403) assertEquals(m.body.code, "role_denied");
  }
  assertEquals((await chain(FINANCE_ADMIN, "noSuchTok")).status, 401);
});

Deno.test("report routes carry no role gate; the sales report and finance routes do", async () => {
  const src = async (p: string) => await Deno.readTextFile(new URL(`../${p}`, import.meta.url));
  const guards = (text: string, path: string) => {
    const m = text.match(new RegExp(`app\\.get\\(\\s*"${path.replace(/[/]/g, "\\/")}",\\s*([^\\n]+)`));
    return m ? m[1].trim() : null;
  };
  const analytics = await src("API/analytics/analyticsRouter.ts");
  assertEquals(guards(analytics, "/api/analytics/funnel"), "requireDashboardAuth,");
  assertEquals(guards(analytics, "/api/analytics/pmf"), "requireDashboardAuth,");
  assertEquals(guards(await src("API/dashboard/dashboardRouter.ts"), "/api/dashboard/metrics"), "requireDashboardAuth,");
  assertEquals(guards(await src("API/finance/salesReportRouter.ts"), "/api/dashboard/sales-report"), "...FINANCE_ADMIN,");
});

Deno.test("email match is trimmed, case-insensitive and tolerates quotes and spaces in the list", async () => {
  env(' "Owner@InternationalLegalPartner.com" ; other@internationallegalpartner.com ', "  CSM@internationallegalpartner.com");
  assertEquals(staffRoleFor("owner@internationallegalpartner.com"), "admin");
  assertEquals(staffRoleFor("  OWNER@internationallegalpartner.COM "), "admin");
  assertEquals(staffRoleFor("Other@InternationalLegalPartner.com"), "admin");
  assertEquals(staffRoleFor("csm@INTERNATIONALLEGALPARTNER.com"), "csm");
  assertEquals(staffRoleFor(""), "staff");
  assertEquals(staffRoleFor(undefined), "staff");
  session("mixedTok", " Owner@InternationalLegalPartner.com ");
  const r = await chain(FINANCE_ADMIN, "mixedTok");
  assertEquals([r.status, r.req.dashboardRole], [200, "admin"]);
});

Deno.test("role is resolved from env at request time, not from the session stamp", async () => {
  env("");
  session("bossTok", "boss@internationallegalpartner.com", "staff"); // stamped before ADMIN_EMAILS was set
  assertEquals((await chain(FINANCE_ADMIN, "bossTok")).status, 403);
  env("boss@internationallegalpartner.com");
  const ok = await chain(FINANCE_ADMIN, "bossTok");
  assertEquals([ok.status, ok.req.dashboardRole], [200, "admin"]);
  // Removing an admin also applies at once, whatever the session says.
  session("exTok", "ex@internationallegalpartner.com", "admin");
  assertEquals((await chain(FINANCE_ADMIN, "exTok")).status, 403);
});

Deno.test("OWNER_EMAILS stands in only while ADMIN_EMAILS is empty; both empty → nobody is admin", () => {
  env("", "", "owner@internationallegalpartner.com");
  assertEquals(staffRoleFor("owner@internationallegalpartner.com"), "admin");
  assertEquals(warnIfNoAdmins(), true);
  env("boss@internationallegalpartner.com", "", "owner@internationallegalpartner.com");
  assertEquals(staffRoleFor("owner@internationallegalpartner.com"), "staff");
  assertEquals(adminEmails(), ["boss@internationallegalpartner.com"]);
  env("");
  assertEquals(adminEmails(), []);
  assertEquals(staffRoleFor("owner@internationallegalpartner.com"), "staff");
  assertEquals(staffRoleFor("anyone@internationallegalpartner.com"), "staff");
  assertEquals(warnIfNoAdmins(), false);
});

Deno.test("requireStaffRole(): no roles listed still means admin only (privacy routes)", async () => {
  env("boss@internationallegalpartner.com", "carla@internationallegalpartner.com");
  session("s2", "sam@internationallegalpartner.com");
  session("c2", "carla@internationallegalpartner.com");
  session("a2", "boss@internationallegalpartner.com");
  const gate = [requireDashboardAuth, requireStaffRole()];
  assertEquals((await chain(gate, "s2")).status, 403);
  assertEquals((await chain(gate, "c2")).status, 403);
  assertEquals((await chain(gate, "a2")).status, 200);
  const csmGate = [requireDashboardAuth, requireStaffRole("csm")];
  assertEquals((await chain(csmGate, "c2")).status, 200);
  assertEquals((await chain(csmGate, "s2")).status, 403);
  env("");
});
