import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { requireFinanceAdmin } from "../API/finance/financeAuth.ts";

/**
 * P1 finance lockdown: every route in API/finance/ is admin only.
 * 1. The gate: csm and staff sessions get 403, admin passes.
 * 2. Every route registered by the finance routers spreads FINANCE_ADMIN
 *    (static check over the router sources, so a new route cannot skip it).
 *
 * Run: deno test --allow-env --allow-read test/financeAuth_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;

function run(role: string | undefined) {
  let status = 200;
  let body: unknown;
  let passed = false;
  // The gate resolves the role from env by email (ROLES), so each role gets its own address.
  Deno.env.set("ADMIN_EMAILS", "admin@internationallegalpartner.com");
  Deno.env.set("CSM_EMAILS", "csm@internationallegalpartner.com");
  const req: Any = { dashboardUser: `${role ?? "nobody"}@internationallegalpartner.com`, dashboardRole: role };
  const res: Any = {
    status(n: number) { status = n; return this; },
    json(b: unknown) { body = b; return this; },
  };
  requireFinanceAdmin(req, res, () => { passed = true; });
  return { status, body, passed };
}

Deno.test("finance: a csm session gets 403", () => {
  const r = run("csm");
  assertEquals(r.passed, false);
  assertEquals(r.status, 403);
});

Deno.test("finance: a plain staff session (or no role) gets 403", () => {
  assertEquals(run("staff").status, 403);
  assertEquals(run(undefined).status, 403);
});

Deno.test("finance: an admin session passes", () => {
  const r = run("admin");
  assertEquals(r.passed, true);
  assertEquals(r.status, 200);
});

Deno.test("finance: every finance route is gated by FINANCE_ADMIN", async () => {
  const files = ["financeLedgerRouter.ts", "financeMetricsRouter.ts", "invoicesRouter.ts", "salesReportRouter.ts"];
  let routes = 0;
  for (const f of files) {
    const src = await Deno.readTextFile(new URL(`../API/finance/${f}`, import.meta.url));
    const re = /app\.(get|post|put|patch|delete)\(\s*"([^"]+)",\s*([^\n]+)/g;
    for (const m of src.matchAll(re)) {
      routes++;
      assertEquals(m[3].trim(), "...FINANCE_ADMIN,", `${f} ${m[1]} ${m[2]} is not admin-gated`);
    }
  }
  assertEquals(routes, 15);
});
