import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { requireClientAuth, requireClientStatusAuth, requireDashboardAuth, requireProviderAuth } from "../helper/auth/session.ts";
import { sessionStore } from "../helper/auth/sessionStore.ts";
import { sessionRoutes } from "../helper/auth/sessionHooks.ts";
import validateUser from "../helper/auth/validateUser.ts";
import {
  consumeTicket,
  downloadRole,
  downloadTicketAuth,
  hashTicket,
  issueTicket,
  TICKET_COLLECTION,
} from "../helper/auth/downloadTicket.ts";

/**
 * AUTH: Bearer-token sessions for staff, lawyers and clients, against an
 * in-memory session store (no Firestore).
 *   - `Authorization: Bearer` resolves in the role's own collection; legacy
 *     role headers still work; `?token=` and cookies (AUTH_COOKIES unset) do not.
 *   - expired sessions and tokens from another role's collection are 401.
 *   - logout / logout-all delete the session named by the Bearer token.
 *   - download tickets: single use, bound to one path, 60 s.
 *
 * Run: deno test --allow-env test/authBearer_test.ts
 */

// deno-lint-ignore no-explicit-any
type Any = any;
type Doc = Record<string, unknown>;
const H = 3600_000;

const db = new Map<string, Map<string, Doc>>();
function table(c: string): Map<string, Doc> {
  if (!db.has(c)) db.set(c, new Map());
  return db.get(c)!;
}
sessionStore.get = ((c: string, id: string) => Promise.resolve(table(c).get(id) ?? null)) as Any;
sessionStore.put = ((c: string, id: string, d: Doc) => {
  table(c).set(id, { ...(table(c).get(id) ?? {}), ...d });
  return Promise.resolve();
}) as Any;
sessionStore.patch = sessionStore.put as Any;
sessionStore.remove = ((c: string, id: string) => Promise.resolve(table(c).delete(id))) as Any;
sessionStore.query = ((c: string, filters: Array<{ field: string; value: unknown }>) =>
  Promise.resolve(
    [...table(c).entries()]
      .filter(([, d]) => filters.every((f) => d[f.field] === f.value))
      .map(([id, d]) => ({ id, ...d })),
  )) as Any;

const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

function seed() {
  db.clear();
  table("dashboard_sessions").set("staffTok", { email: "ana@internationallegalpartner.com", role: "csm", createdAt: past(H), expiresAt: future(11 * H) });
  table("dashboard_sessions").set("outsiderTok", { email: "x@gmail.com", createdAt: past(H), expiresAt: future(11 * H) });
  table("dashboard_sessions").set("oldStaff", { email: "old@internationallegalpartner.com", createdAt: past(13 * H), expiresAt: past(H) });
  table("provider_sessions").set("lawTok", { email: "lex@firm.cr", providerId: "prov_1", createdAt: past(H), expiresAt: future(11 * H) });
  table("client_status_sessions").set("cliTok", { email: "gloria@example.com", projectId: "cli_1", createdAt: past(H), expiresAt: future(7 * 24 * H) });
  table("client_status_sessions").set("oldCli", { email: "gone@example.com", projectId: "cli_2", createdAt: past(8 * 24 * H), expiresAt: past(H) });
  table("client_status_sessions").set("capCli", { email: "cap@example.com", projectId: "cli_3", createdAt: past(31 * 24 * H), expiresAt: future(H) });
}

function req(headers: Doc = {}, extra: Doc = {}): Any {
  return { headers, query: {}, path: "/x", method: "GET", ...extra };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function call(mw: Any, r: Any): Promise<{ status: number; next: boolean; body?: Any; req: Any }> {
  return new Promise((resolve) => {
    const res: Any = {
      statusCode: 200,
      status(n: number) { this.statusCode = n; return this; },
      json(b: unknown) { resolve({ status: this.statusCode, next: false, body: b, req: r }); return this; },
      getHeader: () => undefined,
      setHeader: () => {},
    };
    mw(r, res, () => resolve({ status: 200, next: true, req: r }));
  });
}

Deno.test("Bearer resolves each role in its own collection", async () => {
  seed();
  Deno.env.delete("AUTH_COOKIES");
  Deno.env.set("CSM_EMAILS", "ana@internationallegalpartner.com"); // role comes from env (ROLES)
  const s = await call(requireDashboardAuth, req(bearer("staffTok")));
  assertEquals([s.next, s.req.dashboardUser, s.req.dashboardRole], [true, "ana@internationallegalpartner.com", "csm"]);
  const l = await call(requireProviderAuth, req(bearer("lawTok")));
  assertEquals([l.next, l.req.providerUser, l.req.providerId], [true, "lex@firm.cr", "prov_1"]);
  const c = await call(requireClientAuth, req(bearer("cliTok")));
  assertEquals([c.next, c.req.clientUser, c.req.clientId, c.req.isIrpStaff], [true, "gloria@example.com", "cli_1", false]);
  const cs = await call(requireClientStatusAuth, req(bearer("cliTok")));
  assertEquals([cs.next, cs.req.clientUser], [true, "gloria@example.com"]);
});

Deno.test("wrong role collection is 401", async () => {
  seed();
  assertEquals((await call(requireDashboardAuth, req(bearer("cliTok")))).status, 401);
  assertEquals((await call(requireDashboardAuth, req(bearer("lawTok")))).status, 401);
  assertEquals((await call(requireProviderAuth, req(bearer("cliTok")))).status, 401);
  assertEquals((await call(requireClientAuth, req(bearer("lawTok")))).status, 401);
  assertEquals((await call(requireClientStatusAuth, req(bearer("staffTok")))).status, 401);
  // A staff session outside the org domain gets no bypass into the client portal.
  assertEquals((await call(requireClientAuth, req(bearer("outsiderTok")))).status, 401);
});

Deno.test("expired sessions and the 30-day client cap are 401", async () => {
  seed();
  assertEquals((await call(requireDashboardAuth, req(bearer("oldStaff")))).status, 401);
  assertEquals((await call(requireClientAuth, req(bearer("oldCli")))).status, 401);
  assertEquals((await call(requireClientAuth, req(bearer("capCli")))).status, 401);
  assertEquals((await call(requireDashboardAuth, req(bearer("nope")))).body.error, "Invalid or expired session.");
  assertEquals((await call(requireDashboardAuth, req({}))).body.error, "Authentication required.");
});

Deno.test("client sessions slide on a Bearer request", async () => {
  seed();
  table("client_status_sessions").set("slide", { email: "s@example.com", projectId: "cli_9", createdAt: past(2 * 24 * H), expiresAt: future(5 * 24 * H) });
  assertEquals((await call(requireClientAuth, req(bearer("slide")))).next, true);
  await new Promise((r) => setTimeout(r, 0));
  const exp = new Date(String(table("client_status_sessions").get("slide")!.expiresAt)).getTime();
  assert(exp > Date.now() + 7 * 24 * H - 60_000, "expiry pushed to now + 7 d");
});

Deno.test("legacy role headers still work; ?token= and cookies (AUTH_COOKIES unset) do not", async () => {
  seed();
  Deno.env.delete("AUTH_COOKIES");
  assertEquals((await call(requireDashboardAuth, req({ "x-dashboard-token": "staffTok" }))).next, true);
  assertEquals((await call(requireProviderAuth, req({ "x-provider-token": "lawTok" }))).next, true);
  assertEquals((await call(requireClientAuth, req({ "x-client-token": "cliTok" }))).next, true);
  assertEquals((await call(requireDashboardAuth, req({}, { query: { token: "staffTok" } }))).status, 401);
  assertEquals((await call(requireDashboardAuth, req({ cookie: "ilp_staff_session=staffTok" }))).status, 401);
  Deno.env.set("AUTH_COOKIES", "true");
  assertEquals((await call(requireDashboardAuth, req({ cookie: "ilp_staff_session=staffTok" }))).next, true);
  Deno.env.delete("AUTH_COOKIES");
});

Deno.test("staff Bearer: audited bypass into the client portal; validateUser('staff') accepts it", async () => {
  seed();
  const c = await call(requireClientAuth, req(bearer("staffTok"), { query: { clientId: "cli_1" } }));
  assertEquals([c.next, c.req.isIrpStaff, c.req.clientId], [true, true, "cli_1"]);
  const v = await call(validateUser("staff"), req(bearer("staffTok")));
  assertEquals([v.next, v.req.dashboardUser], [true, "ana@internationallegalpartner.com"]);
  assertEquals((await call(validateUser("staff"), req(bearer("cliTok")))).status, 401);
  assertEquals((await call(validateUser("customer"), req(bearer("staffTok")))).status, 403);
});

function fakeApp() {
  const routes = new Map<string, Any>();
  return { app: { post: (p: string, h: Any) => routes.set(p, h) } as Any, routes };
}

Deno.test("logout deletes the Bearer session; logout-all ends every session of that email", async () => {
  seed();
  const { app, routes } = fakeApp();
  sessionRoutes(app);
  // A lawyer token sent to the staff logout ends nothing.
  await call(routes.get("/api/dashboard/auth/logout"), req(bearer("lawTok"), { method: "POST" }));
  assert(table("provider_sessions").has("lawTok"));
  const out = await call(routes.get("/api/provider/auth/logout"), req(bearer("lawTok"), { method: "POST" }));
  assertEquals(out.body, { success: true });
  assertEquals(table("provider_sessions").has("lawTok"), false);
  assertEquals((await call(requireProviderAuth, req(bearer("lawTok")))).status, 401);

  table("client_status_sessions").set("phone", { email: "gloria@example.com", projectId: "cli_1", createdAt: past(H), expiresAt: future(24 * H) });
  const all = await call(routes.get("/api/client-status/auth/logout-all"), req(bearer("cliTok"), { method: "POST" }));
  assertEquals(all.body, { success: true, ended: 2 });
  assertEquals([table("client_status_sessions").has("cliTok"), table("client_status_sessions").has("phone")], [false, false]);
  assertEquals((await call(routes.get("/api/client-status/auth/logout-all"), req({}, { method: "POST" }))).status, 401);
});

Deno.test("download tickets: path-bound, single use, role-checked", async () => {
  seed();
  const path = "/api/client-status/me/documents/doc_1/file";
  assertEquals(downloadRole(path), "client");
  assertEquals(downloadRole("/api/client-status/me/home"), null);
  // A staff session cannot mint a client-route ticket; no session, no ticket.
  assertEquals(await issueTicket(req(bearer("staffTok")), path), null);
  assertEquals(await issueTicket(req({}), path), null);
  assertEquals(await issueTicket(req(bearer("cliTok")), "/api/client-status/me/home"), null);

  const t = (await issueTicket(req(bearer("cliTok")), path))!;
  assert(t && t.ticket.length === 64);
  // Stored hashed, never in clear text.
  assertEquals(table(TICKET_COLLECTION).has(t.ticket), false);
  assertEquals(table(TICKET_COLLECTION).get(await hashTicket(t.ticket))!.path, path);
  // Wrong path burns the ticket.
  assertEquals(await consumeTicket(t.ticket, "/api/client-status/me/documents/doc_2/file"), null);
  assertEquals(await consumeTicket(t.ticket, path), null);

  const t2 = (await issueTicket(req(bearer("cliTok")), path))!;
  assertEquals(await consumeTicket(t2.ticket, path), "cliTok");
  assertEquals(await consumeTicket(t2.ticket, path), null); // single use

  const t3 = (await issueTicket(req(bearer("cliTok")), path, Date.now() - 61_000))!;
  assertEquals(await consumeTicket(t3.ticket, path), null); // expired after 60 s
});

Deno.test("ticket middleware: swaps ?ticket= for the session's Bearer on download routes only", async () => {
  seed();
  const path = "/api/dashboard/members/cli_1/documents/doc_1/file";
  const t = (await issueTicket(req(bearer("staffTok")), path))!;
  // Ignored on a non-download route.
  const other = await call(downloadTicketAuth, req({}, { path: "/api/dashboard/clients", query: { ticket: t.ticket } }));
  assertEquals([other.next, other.req.headers.authorization], [true, undefined]);
  const ok = await call(downloadTicketAuth, req({ "x-client-token": "cliTok" }, { path, query: { ticket: t.ticket } }));
  assertEquals([ok.next, ok.req.headers.authorization, ok.req.headers["x-client-token"]], [true, "Bearer staffTok", undefined]);
  assertEquals((await call(requireDashboardAuth, ok.req)).next, true);
  const again = await call(downloadTicketAuth, req({}, { path, query: { ticket: t.ticket } }));
  assertEquals(again.status, 401);
});
