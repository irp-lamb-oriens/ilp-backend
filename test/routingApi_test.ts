import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { clearPlaceholderCache } from "../helper/placeholder.ts";

/**
 * ROUTING through the real routes: the lawyer profile (staff-only fields
 * ignored, no rating in the response), the member's "arranging" state and
 * slots, the staff capacity list with the hidden rating, override and
 * re-route, the bell.
 * Run: deno test --allow-env --allow-read test/routingApi_test.ts
 */

const WEEK = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "12:00" }));
const STAFF = "carla@internationallegalpartner.com";
let world: FakeWorld;
let app: FakeApp;

const keysIn = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysIn(x, out));
  return out;
};
const call = (token: string, method: string, url: string, body?: unknown) => app.call(method, url, { body, headers: { authorization: `Bearer ${token}` } });

async function setup() {
  await useFakeEnv({ ADMIN_EMAILS: "oriens@internationallegalpartner.com", CSM_EMAILS: STAFF, DEFAULT_CSM_EMAIL: STAFF });
  for (const k of ["DEFAULT_PROVIDER_ID", "SALES_EMAILS", "AUTH_COOKIES"]) Deno.env.delete(k);
  clearPlaceholderCache();
  world = installFakeWorld("2026-10-27T15:00:00.000Z");
  app = new FakeApp();
  for (const m of ["../API/provider/providerDashboardRouter.ts", "../API/dashboard/dashboardRouter.ts", "../API/clientStatus/clientStatusRouter.ts", "../API/routing/routingRouter.ts"]) (await import(m)).default(app);
  world.put("dashboard_sessions", "stf", { email: STAFF, expiresAt: "2030-01-01T00:00:00Z" });
  const lawyer = (id: string, country: string, specialties: string[]) => {
    world.put("providers", id, { name: `${id} Abogada`, email: `${id.toLowerCase()}@lawyers-rt.io`, status: "active", active: true, jurisdictions: [country], specialties, languages: ["es", "en"] });
    world.put("lawyer_availability", id, { id, providerId: id, timezone: "America/Costa_Rica", weekly: WEEK, blackoutDates: [], minLeadHours: 0, maxCallsPerDay: 6, specialties: [] });
    world.put("provider_sessions", `law_${id}`, { email: `${id.toLowerCase()}@lawyers-rt.io`, providerId: id, expiresAt: "2030-01-01T00:00:00Z" });
  };
  lawyer("ANA", "CR", ["residency_renewals"]);
  lawyer("BEA", "CR", ["residency_visas", "property_purchase"]);
  world.put("lawyer_ratings", "ANA", { providerId: "ANA", ratingScore: 83.3, reviewCount: 1, ratingStatus: "blended", updatedAt: "2026-10-20T15:00:00.000Z" });
  const member = (id: string, country: string, matter: Record<string, unknown>) => {
    world.put("clients", id, { email: `${id}@mailbox-rt.io`, fullName: `Member ${id}`, legalCountry: country, country, preferredLanguage: "en" });
    world.put("memberships", `mem_${id}`, { id: `mem_${id}`, clientId: id, status: "active", country, periodStart: "2026-10-20T15:00:00.000Z", periodEnd: "2026-11-20T15:00:00.000Z", minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, paymentRef: "manual", createdAt: "2026-10-20T15:00:00.000Z" });
    world.put("matters", `mat_${id}`, { id: `mat_${id}`, clientId: id, country, stage: "intake", stageEnteredAt: "2026-10-20T15:00:00.000Z", openedAt: "2026-10-20T15:00:00.000Z", ...matter });
    world.put("client_status_sessions", `cli_${id}`, { email: `${id}@mailbox-rt.io`, projectId: id, createdAt: "2026-10-27T15:00:00.000Z", expiresAt: "2026-11-03T15:00:00.000Z" });
  };
  member("m1", "CR", { title: "DIMEX renewal", area: "immigration", question: "My DIMEX expires in March." });
  member("m2", "PA", { title: "Condo fees", area: "real_estate", question: "The condo association raised fees." });
}

const HIDDEN = ["routing", "ratingScore", "reviewCount", "ratingStatus", "lawyerRating", "rating"];

Deno.test("routes: lawyer profile, member slots and arranging state, staff list, override, bell", async () => {
  await setup();
  try {
    // Lawyer: own profile, no rating; staff-only fields are ignored on save.
    let r = await call("law_ANA", "GET", "/api/provider/profile");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.profile.specialties, ["residency_renewals"]);
    for (const k of HIDDEN) assert(!keysIn(r.body).has(k), `${k} in the lawyer profile`);
    r = await call("law_ANA", "PUT", "/api/provider/profile", { specialties: ["residency_renewals", "permanent_residency", "nope"], languages: ["es", "en"], regions: ["Guanacaste"], jurisdictions: ["PA"], licences: [{ country: "PA", number: "1", verified: true }] });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const ana = world.doc("providers", "ANA")!;
    assertEquals([ana.specialties, ana.jurisdictions, ana.licences, ana.legalAreas], [["residency_renewals", "permanent_residency"], ["CR"], undefined, ["immigration"]]);
    assert(world.all("audit_log").some((a) => a.action === "provider.profile_updated" && a.target === "providers/ANA"));
    r = await call("law_ANA", "PUT", "/api/provider/profile", { specialties: [] });
    assertEquals([r.status, r.body.errors?.specialties], [400, "Choose at least one specialty you take."]);

    // Member m1: routed automatically to the exact specialty; sees only that lawyer's times.
    r = await call("cli_m1", "GET", "/api/client-status/me/slots");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.lawyerName, "ANA Abogada");
    assert(r.body.slots.length > 0);
    assertEquals(world.doc("clients", "m1")!.assignedProviderId, "ANA");
    r = await call("cli_m1", "GET", "/api/client-status/me/home");
    assertEquals(r.body.lawyerMatch, { status: "assigned", lawyerName: "ANA Abogada" });
    for (const k of HIDDEN.filter((x) => x !== "rating")) assert(!keysIn(r.body).has(k), `${k} in the member home`);

    // Member m2: nobody in Panama. Arranging, with the sales call; no lawyer data leaks.
    r = await call("cli_m2", "GET", "/api/client-status/me/slots");
    assertEquals([r.body.matching, r.body.slots.length, r.body.lawyerName], [true, 0, null]);
    assert(/arranging a lawyer licensed in Panama/.test(r.body.reason), r.body.reason);
    assert(r.body.salesCall?.scheduledAt, "sales call time");
    const home = await call("cli_m2", "GET", "/api/client-status/me/home");
    assertEquals(home.body.lawyerMatch.status, "arranging");
    assertEquals(home.body.upcomingCalls[0]?.kind, "sales");
    assertEquals(home.body.capacity.callsBooked, 0, "the sales call does not use a membership call");
    for (const k of HIDDEN.filter((x) => x !== "rating")) assert(!keysIn(home.body).has(k), `${k} in the member home`);
    const booked = await call("cli_m2", "POST", "/api/client-status/me/consultations", { scheduledAt: "2026-10-28T15:00:00.000Z", question: "Fees" });
    assertEquals([booked.status, booked.body.matching], [409, true]);

    // Staff: capacity list carries specialties and the hidden rating.
    r = await call("stf", "GET", "/api/dashboard/staff/lawyers");
    const row = (r.body.items as Array<Record<string, unknown>>).find((x) => x.id === "ANA")!;
    assertEquals([row.ratingScore, row.reviewCount, row.ratingLabel], [83.3, 1, "83.3 (1 review)"]);
    assertEquals((r.body.items as Array<Record<string, unknown>>).find((x) => x.id === "BEA")!.ratingLabel, "No reviews yet");
    // Staff: "Why this lawyer" for m1, then override to BEA with a note.
    r = await call("stf", "GET", "/api/dashboard/routing/members/m1");
    assertEquals([r.body.assigned.id, r.body.decision.providerId, r.body.decision.candidates[0].providerId], ["ANA", "ANA", "ANA"]);
    r = await call("stf", "POST", "/api/dashboard/routing/members/m1/override", { providerId: "BEA", note: "Member asked for a woman lawyer she met before" });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(world.doc("clients", "m1")!.assignedProviderId, "BEA");
    const d = world.doc("matters", "mat_m1")!.routing;
    assertEquals([d.providerId, d.trigger, d.overriddenBy], ["BEA", "override", STAFF]);
    r = await call("stf", "POST", "/api/dashboard/routing/members/m1/override", { providerId: "NOPE" });
    assertEquals(r.status, 404);
    // Staff: the bell has the Panama alert; reading it clears the unread count.
    r = await call("stf", "GET", "/api/dashboard/notifications");
    assertEquals(r.body.unread, 1);
    assert(/Missing specialty for an assignment: Panama/.test(r.body.items[0].title));
    await call("stf", "POST", "/api/dashboard/notifications/read", {});
    r = await call("stf", "GET", "/api/dashboard/notifications");
    assertEquals([r.body.unread, r.body.items[0].read], [0, true]);
    // Staff: coverage shows Panama empty and the open gap.
    r = await call("stf", "GET", "/api/dashboard/routing/coverage");
    assertEquals(r.body.cells.PA.condominium, { exact: 0, areaOnly: 0 });
    assertEquals(r.body.cells.CR.residency_renewals.exact, 1);
    assertEquals(r.body.gaps.length, 1);
    // Staff: a Panama lawyer is added and re-route resolves the member.
    world.put("providers", "PAZ", { name: "Paz Abogada", email: "paz@lawyers-rt.io", status: "active", active: true, jurisdictions: ["PA"], specialties: ["condominium"], languages: ["es", "en"] });
    world.put("lawyer_availability", "PAZ", { id: "PAZ", providerId: "PAZ", timezone: "America/Panama", weekly: WEEK, blackoutDates: [], minLeadHours: 0, maxCallsPerDay: 6, specialties: [] });
    r = await call("stf", "POST", "/api/dashboard/routing/members/m2/reroute", {});
    assertEquals(r.body.providerId, "PAZ");
    assertEquals(world.doc("clients", "m2")!.assignedProviderId, "PAZ");
    r = await call("cli_m2", "GET", "/api/client-status/me/home");
    assertEquals(r.body.lawyerMatch, { status: "assigned", lawyerName: "Paz Abogada" });
  } finally {
    world.restore();
  }
});
