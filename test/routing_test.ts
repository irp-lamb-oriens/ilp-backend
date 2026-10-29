import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import {
  CLIENT_HIDDEN_FIELDS,
  DEFAULT_SPECIALTIES,
  LAWYER_HIDDEN_FIELDS,
  lawyerRating,
  type Specialty,
  starsTo100,
} from "../schemas/contracts.ts";
import { compareCandidates, hardFilterReasons, inferSpecialty, type LawyerForRouting, memberLanguages, type RouteRequest, routeCandidates } from "../API/routing/router.ts";
import { mergeSpecialty, remapIds } from "../API/routing/specialties.ts";
import { toLawyerPayload } from "../API/provider/lawyerView.ts";
import { stripFields } from "../db/records.ts";
import { buildPreCallBrief, sendPreCallEmail } from "../API/routing/precall.ts";
import { preCallLawyerEmail, whenIn } from "../API/routing/emails.ts";
import { clearPlaceholderCache } from "../helper/placeholder.ts";

/**
 * ROUTING: hidden ratings, the router (filters, ranking, tie-break,
 * continuity), the no-match path (staff alert, member notice, sales call,
 * once), re-route when a lawyer is added, specialty merge, hidden fields,
 * the pre-call email and its reminders.
 * Run: deno test --allow-env --allow-read test/routing_test.ts
 */

const SPECIALTIES: Specialty[] = DEFAULT_SPECIALTIES.map((s) => ({ ...s }));
const NOW = new Date("2026-10-28T15:00:00.000Z");
const DAY = 86_400_000;
const inDays = (d: number) => new Date(NOW.getTime() + d * DAY).toISOString();

function lawyer(id: string, over: Partial<LawyerForRouting> = {}): LawyerForRouting {
  return {
    providerId: id,
    name: id,
    bookable: true,
    routingStatus: "active",
    countries: ["CR"],
    verifiedCountries: ["CR"],
    specialties: ["residency_renewals"],
    areas: ["immigration"],
    languages: ["en", "es"],
    regions: [],
    clientTypes: [],
    conflicts: [],
    maxCallsPerWeek: 10,
    callsThisWeek: 2,
    nextSlotAt: inDays(2),
    ratingScore: 100,
    reviewCount: 0,
    placeholder: false,
    ...over,
  };
}

function request(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    country: "CR",
    area: "immigration",
    specialtyId: "residency_renewals",
    languages: ["en"],
    timezone: "America/New_York",
    urgencyDays: null,
    clientType: "individual",
    region: null,
    previousProviderId: null,
    counterparties: [],
    memberName: "Alice Hartman",
    placeholder: false,
    ...over,
  };
}

// ─── Ratings ───────────────────────────────────────────────────────────────

Deno.test("rating: 100 with no reviews, blended with the 100 prior below 5, plain average from 5", () => {
  assertEquals(lawyerRating([]), { score: 100, reviewCount: 0, status: "no_reviews" });
  // One bad review does not sink a new lawyer: (500 + 0) / 6.
  assertEquals(lawyerRating([0]), { score: 83.3, reviewCount: 1, status: "blended" });
  // Four reviews: (500 + 100 + 75 + 50 + 0) / 9.
  assertEquals(lawyerRating([100, 75, 50, 0]), { score: 80.6, reviewCount: 4, status: "blended" });
  // Five reviews: the real average, the prior is gone.
  assertEquals(lawyerRating([100, 75, 50, 0, 25]), { score: 50, reviewCount: 5, status: "average" });
  assertEquals(lawyerRating(Array(20).fill(75)), { score: 75, reviewCount: 20, status: "average" });
  assertEquals([1, 2, 3, 4, 5].map(starsTo100), [0, 25, 50, 75, 100]);
});

// ─── Hidden fields ─────────────────────────────────────────────────────────

Deno.test("hidden fields: ratings and routing never reach lawyer or member payloads", () => {
  for (const k of ["routing", "ratingScore", "reviewCount", "ratingStatus", "lawyerRating"]) {
    assert((LAWYER_HIDDEN_FIELDS as readonly string[]).includes(k), `lawyer list misses ${k}`);
    assert((CLIENT_HIDDEN_FIELDS as readonly string[]).includes(k), `client list misses ${k}`);
  }
  const payload = {
    matter: { id: "m1", title: "Residency", routing: { providerId: "A", candidates: [{ providerId: "B", ratingScore: 40 }] } },
    consultation: { id: "c1", rating: { score: 2 }, routing: { providerId: "A" } },
    lawyer: { name: "Ana", ratingScore: 91, reviewCount: 6, ratingStatus: "average" },
  };
  const toLawyer = JSON.stringify(toLawyerPayload(payload, "A"));
  for (const k of ["routing", "ratingScore", "reviewCount", "ratingStatus", "\"rating\""]) assert(!toLawyer.includes(k), `${k} leaked to the lawyer`);
  const toClient = JSON.stringify(stripFields(payload, CLIENT_HIDDEN_FIELDS));
  for (const k of ["routing", "ratingScore", "reviewCount", "ratingStatus"]) assert(!toClient.includes(k), `${k} leaked to the member`);
});

// ─── Router ────────────────────────────────────────────────────────────────

Deno.test("router hard filters: active, licence verified, specialty, language, slot, capacity, conflict", () => {
  const r = request({ counterparties: ["Inversiones Pacífico S.A."] });
  const why = (l: LawyerForRouting) => hardFilterReasons(l, r, NOW, SPECIALTIES, 10).join(" | ");
  assertEquals(why(lawyer("ok")), "");
  assert(/Not active/.test(why(lawyer("x", { bookable: false }))));
  assert(/Paused/.test(why(lawyer("x", { routingStatus: "paused" }))));
  assertEquals(why(lawyer("x", { routingStatus: "paused" })).length > 0, true);
  assertEquals(hardFilterReasons(lawyer("prev", { routingStatus: "paused" }), { ...r, previousProviderId: "prev" }, NOW, SPECIALTIES).length, 0, "paused lawyers keep their own members");
  assert(/Still onboarding/.test(why(lawyer("x", { routingStatus: "onboarding" }))));
  assert(/Not licensed in Costa Rica/.test(why(lawyer("x", { countries: ["PA"], verifiedCountries: ["PA"] }))));
  assert(/not verified/.test(why(lawyer("x", { verifiedCountries: [] }))));
  assert(/Does not cover/.test(why(lawyer("x", { specialties: ["wills"], areas: ["family_estate"] }))));
  assertEquals(why(lawyer("area", { specialties: ["residency_visas"], areas: ["immigration"] })), "", "the parent area passes");
  assert(/Does not speak English/.test(why(lawyer("x", { languages: ["es"] }))));
  assertEquals(why(lawyer("nolang", { languages: [] })), "", "languages not on file pass (staff are warned)");
  assert(/No free time in the next 10 days/.test(why(lawyer("x", { nextSlotAt: inDays(12) }))));
  assert(/No free time/.test(why(lawyer("x", { nextSlotAt: null }))));
  assert(/At capacity: 5 of 5/.test(why(lawyer("x", { maxCallsPerWeek: 5, callsThisWeek: 5 }))));
  assert(/Conflict on file: Inversiones Pacifico/.test(why(lawyer("x", { conflicts: ["Inversiones Pacifico"] }))));
  assert(/Conflict on file/.test(why(lawyer("x", { conflicts: ["alice hartman"] }))), "the member is on the lawyer's list");
});

Deno.test("router ranking: exact specialty beats the area, continuity, rating, urgency, deterministic tie-break", () => {
  const exact = lawyer("B_exact");
  const area = lawyer("A_area", { specialties: ["residency_visas"] });
  let r = routeCandidates(request(), [area, exact], NOW, SPECIALTIES);
  assertEquals(r.ranked.map((c) => c.providerId), ["B_exact", "A_area"]);
  assertEquals([r.ranked[0].breakdown.specialty, r.ranked[1].breakdown.specialty], [40, 25]);
  // Continuity: the member's lawyer outranks an equal stranger.
  r = routeCandidates(request({ previousProviderId: "Z_prev" }), [lawyer("A"), lawyer("Z_prev")], NOW, SPECIALTIES);
  assertEquals(r.ranked[0].providerId, "Z_prev");
  assertEquals(r.ranked[0].breakdown.continuity, 25);
  // Hidden rating orders otherwise equal lawyers.
  r = routeCandidates(request(), [lawyer("A", { ratingScore: 60, reviewCount: 8 }), lawyer("B", { ratingScore: 95, reviewCount: 8 })], NOW, SPECIALTIES);
  assertEquals(r.ranked.map((c) => c.providerId), ["B", "A"]);
  // A close deadline doubles the weight of the earliest slot.
  const urgent = routeCandidates(request({ urgencyDays: 5 }), [lawyer("late", { nextSlotAt: inDays(8) }), lawyer("soon", { nextSlotAt: inDays(1) })], NOW, SPECIALTIES);
  assertEquals(urgent.ranked[0].providerId, "soon");
  assert(urgent.ranked[0].breakdown.earliestSlot > 10);
  // Load balance: fewer calls this week wins.
  r = routeCandidates(request(), [lawyer("busy", { callsThisWeek: 8 }), lawyer("free", { callsThisWeek: 1 })], NOW, SPECIALTIES);
  assertEquals(r.ranked[0].providerId, "free");
  // Tie: identical lawyers break on providerId, whatever the input order.
  const one = routeCandidates(request(), [lawyer("m2"), lawyer("m1"), lawyer("m3")], NOW, SPECIALTIES).ranked.map((c) => c.providerId);
  const two = routeCandidates(request(), [lawyer("m3"), lawyer("m1"), lawyer("m2")], NOW, SPECIALTIES).ranked.map((c) => c.providerId);
  assertEquals(one, ["m1", "m2", "m3"]);
  assertEquals(two, one);
  assertEquals(compareCandidates(routeCandidates(request(), [lawyer("a")], NOW, SPECIALTIES).ranked[0], routeCandidates(request(), [lawyer("a")], NOW, SPECIALTIES).ranked[0]), 0);
  // Placeholder lawyers never take real members.
  r = routeCandidates(request(), [lawyer("ph_seed", { placeholder: true })], NOW, SPECIALTIES);
  assertEquals(r.ranked.length, 0);
  assertEquals(r.rejected.length, 0, "seed lawyers are skipped silently");
});

Deno.test("router no match: plain reasons for staff", () => {
  let r = routeCandidates(request({ country: "PA", area: "real_estate", specialtyId: "condominium" }), [lawyer("cr")], NOW, SPECIALTIES);
  assertEquals(r.noMatchReason, "No active lawyer is licensed in Panama yet.");
  r = routeCandidates(request({ country: "PA", area: "real_estate", specialtyId: "condominium" }), [lawyer("pa", { countries: ["PA"], verifiedCountries: ["PA"] })], NOW, SPECIALTIES);
  assertEquals(r.noMatchReason, "No active lawyer in Panama covers condominiums and owners' associations.");
  r = routeCandidates(request(), [lawyer("full", { maxCallsPerWeek: 2, callsThisWeek: 2 })], NOW, SPECIALTIES);
  assert(/at capacity/.test(r.noMatchReason ?? ""), r.noMatchReason);
});

Deno.test("request helpers: specialty from the question, languages", () => {
  assertEquals(inferSpecialty("My DIMEX expires in March, how do I renew it?", "immigration", SPECIALTIES), "residency_renewals");
  assertEquals(inferSpecialty("I will buy a condo in Tamarindo next year", null, SPECIALTIES), "condominium", "'I will' is not a will");
  assertEquals(inferSpecialty("Renew the marchamo for my car", "vehicle", SPECIALTIES), "vehicle_registration");
  assertEquals(inferSpecialty("Our S.A. needs its annual filings", "corporate", SPECIALTIES), "annual_corporate_filings");
  assertEquals(inferSpecialty("General question", null, SPECIALTIES), null);
  assertEquals(memberLanguages("either"), ["en", "es"]);
  assertEquals(memberLanguages("es"), ["es"]);
  assertEquals(memberLanguages(undefined), ["en"]);
});

// ─── Fake-world scenarios ──────────────────────────────────────────────────

const WEEK = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "12:00" }));
const STAFF = { ADMIN_EMAILS: "oriens@internationallegalpartner.com", CSM_EMAILS: "carla@internationallegalpartner.com", DEFAULT_CSM_EMAIL: "carla@internationallegalpartner.com" };

async function world0() {
  await useFakeEnv(STAFF);
  Deno.env.delete("SALES_EMAILS");
  Deno.env.delete("DEFAULT_PROVIDER_ID");
  clearPlaceholderCache();
  return installFakeWorld("2026-10-27T15:00:00.000Z");
}

function addLawyer(world: ReturnType<typeof installFakeWorld>, id: string, country: string, specialties: string[], extra: Record<string, unknown> = {}) {
  const tz = country === "PT" ? "Europe/Lisbon" : country === "PA" ? "America/Panama" : "America/Costa_Rica";
  world.put("providers", id, { name: `${id} Lawyer`, email: `${id.toLowerCase()}@lawyers-rt.io`, status: "active", active: true, jurisdictions: [country], specialties, languages: ["es", "en"], ...extra });
  world.put("lawyer_availability", id, { id, providerId: id, timezone: tz, weekly: WEEK, blackoutDates: [], minLeadHours: 0, maxCallsPerDay: 6, specialties: [] });
}

function addMember(world: ReturnType<typeof installFakeWorld>, id: string, country: string, matter: Record<string, unknown>) {
  world.put("clients", id, { email: `${id}@mailbox-rt.io`, fullName: "Grace Whitfield", name: "Grace", legalCountry: country, country, preferredLanguage: "en", timezone: "America/Chicago", ownsProperty: true, propertyLocation: "Coronado, Panamá Oeste", residencyStatus: "pensionado", residencyExpiresAt: "2027-03-01", passportNumber: "X1234567" });
  world.put("memberships", `mem_${id}`, { id: `mem_${id}`, clientId: id, status: "active", country, periodStart: "2026-10-20T15:00:00.000Z", periodEnd: "2026-11-20T15:00:00.000Z", minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, paymentRef: "manual", createdAt: "2026-10-20T15:00:00.000Z" });
  world.put("matters", `mat_${id}`, { id: `mat_${id}`, clientId: id, country, stage: "intake", stageEnteredAt: "2026-10-20T15:00:00.000Z", openedAt: "2026-10-20T15:00:00.000Z", ...matter });
}

Deno.test("no match: staff bell + email + task, member notice, sales call; once per matter", async () => {
  const world = await world0();
  try {
    const { ensureAssigned } = await import("../API/members/assignment.ts");
    const { bookingCapacity } = await import("../API/clientStatus/memberLogic.ts");
    addLawyer(world, "CR1", "CR", ["condominium"]);
    addMember(world, "g1", "PA", { title: "HOA dispute in Coronado", area: "real_estate", question: "Our condo association raised the fees without a vote." });
    assertEquals(await ensureAssigned("g1"), null);
    const gap = world.doc("routing_gaps", "gap_g1_mat_g1")!;
    assertEquals([gap.status, gap.country, gap.specialtyId], ["open", "PA", "condominium"]);
    const notes = world.all("staff_notifications");
    assertEquals(notes.length, 1);
    assertEquals(notes[0].title, "Missing specialty for an assignment: Panama · Condominiums and owners' associations · Grace Whitfield");
    const tasks = world.all("csm_tasks").filter((t) => t.clientId === "g1" && /Missing specialty/.test(t.title));
    assertEquals(tasks.length, 1);
    const sales = world.all("consultations").filter((c) => c.clientId === "g1");
    assertEquals(sales.length, 1);
    assertEquals([sales[0].kind, sales[0].providerId, sales[0].salesEmail, sales[0].status], ["sales", "ilp_sales", "consultation@internationalrelocationpartner.com", "booked"]);
    assert(sales[0].meetUrl, "the sales call has a Meet link");
    // It never uses membership minutes or calls.
    const cap = bookingCapacity(world.doc("memberships", "mem_g1") as never, sales as never);
    assertEquals([cap.callsBooked, cap.minutesBooked, cap.canBook], [0, 0, true]);
    const mails = world.emails();
    const staffMail = mails.filter((m) => /ILP alert: Missing specialty/.test(m.subject));
    assertEquals(staffMail.length, 1);
    assert(String(staffMail[0].to).includes("oriens@internationallegalpartner.com") && String(staffMail[0].to).includes("carla@internationallegalpartner.com"));
    assertEquals(mails.filter((m) => m.subject === "We are arranging your ILP lawyer" && m.to === "g1@mailbox-rt.io").length, 1);
    assertEquals(mails.filter((m) => /^Sales call booked: Grace Whitfield/.test(m.subject) && m.to === "consultation@internationalrelocationpartner.com").length, 1);
    // Again (another booking attempt, the sweep): nothing new is sent or booked.
    const before = { notes: 1, mails: mails.length };
    assertEquals(await ensureAssigned("g1"), null);
    const { rerouteOpenGaps } = await import("../API/routing/service.ts");
    assertEquals(await rerouteOpenGaps("sweep"), { resolved: 0, open: 1 });
    assertEquals(world.all("staff_notifications").length, before.notes);
    assertEquals(world.emails().length, before.mails);
    assertEquals(world.all("consultations").filter((c) => c.clientId === "g1").length, 1);
    assertEquals(world.all("csm_tasks").filter((t) => /Missing specialty/.test(t.title)).length, 1);
    assertEquals(world.doc("routing_gaps", "gap_g1_mat_g1")!.attempts, 3);
    // Staff and the member's /status read the decision and the "arranging" state.
    const m = world.doc("matters", "mat_g1")!;
    assertEquals([m.routing.providerId, m.routing.noMatchReason], [null, "No active lawyer is licensed in Panama yet."]);
    const { memberLawyerMatch } = await import("../API/routing/service.ts");
    const view = await memberLawyerMatch("g1");
    assertEquals([view.status, view.salesCall?.id], ["arranging", sales[0].id]);
  } finally {
    world.restore();
  }
});

Deno.test("re-route: a new lawyer with the specialty resolves the gap and tells everyone", async () => {
  const world = await world0();
  try {
    const { ensureAssigned } = await import("../API/members/assignment.ts");
    const { rerouteOpenGaps } = await import("../API/routing/service.ts");
    addMember(world, "g2", "PA", { title: "Condo fees", area: "real_estate", question: "The condo association raised fees." });
    assertEquals(await ensureAssigned("g2"), null);
    addLawyer(world, "PA1", "PA", ["condominium", "property_purchase"]);
    assertEquals(await rerouteOpenGaps("sweep"), { resolved: 1, open: 0 });
    assertEquals(world.doc("clients", "g2")!.assignedProviderId, "PA1");
    assertEquals(world.doc("matters", "mat_g2")!.assignedProviderId, "PA1");
    const gap = world.doc("routing_gaps", "gap_g2_mat_g2")!;
    assertEquals([gap.status, gap.resolvedProviderId], ["resolved", "PA1"]);
    const decision = world.doc("matters", "mat_g2")!.routing;
    assertEquals([decision.providerId, decision.trigger, decision.candidates[0].breakdown.specialty], ["PA1", "sweep", 40]);
    const task = world.all("csm_tasks").find((t) => /Missing specialty/.test(t.title))!;
    assertEquals(task.status, "done");
    assertEquals(world.emails().filter((m) => m.subject === "Your ILP lawyer is confirmed" && m.to === "g2@mailbox-rt.io").length, 1);
    assertEquals(world.all("staff_notifications").filter((n) => n.kind === "routing.resolved").length, 1);
    assert(world.all("audit_log").some((a) => a.action === "routing.decided" && a.meta?.providerId === "PA1"));
    // Settled: the next sweep has nothing to do.
    assertEquals(await rerouteOpenGaps("sweep"), { resolved: 0, open: 0 });
  } finally {
    world.restore();
  }
});

Deno.test("routing at activation: specialty + continuity; staff override keeps the decision with who overrode", async () => {
  const world = await world0();
  try {
    const { ensureAssigned } = await import("../API/members/assignment.ts");
    addLawyer(world, "CRA", "CR", ["residency_visas"]);
    addLawyer(world, "CRB", "CR", ["residency_renewals"]);
    addMember(world, "g3", "CR", { title: "DIMEX renewal", area: "immigration", question: "My DIMEX expires in March." });
    assertEquals(await ensureAssigned("g3"), "CRB", "the exact specialty wins over the same area");
    const d = world.doc("matters", "mat_g3")!.routing;
    assertEquals([d.request.specialtyId, d.candidates.map((c: { providerId: string }) => c.providerId)], ["residency_renewals", ["CRB", "CRA"]]);
    assert(d.rulesVersion.startsWith("routing-"));
  } finally {
    world.restore();
  }
});

Deno.test("specialty merge moves lawyers and matters and is audited", async () => {
  assertEquals(remapIds(["wills", "probate", "wills"], "probate", "wills"), ["wills"]);
  const world = await world0();
  try {
    const { loadSpecialties } = await import("../API/routing/specialties.ts");
    await loadSpecialties(); // seeds the defaults
    addLawyer(world, "L1", "CR", ["probate", "wills"], { specialtyNotes: { probate: "Estates with US heirs" } });
    addLawyer(world, "L2", "CR", ["probate"]);
    world.put("matters", "mx", { id: "mx", clientId: "c", specialtyId: "probate", country: "CR", stage: "intake", stageEnteredAt: "2026-10-20T15:00:00.000Z", openedAt: "2026-10-20T15:00:00.000Z", title: "Estate", area: "family_estate" });
    const r = await mergeSpecialty("probate", "wills", { email: "carla@internationallegalpartner.com", role: "staff" });
    assertEquals([r.status, r.body.providers, r.body.matters], [200, 2, 1]);
    assertEquals(world.doc("providers", "L1")!.specialties, ["wills"]);
    assertEquals(world.doc("providers", "L1")!.specialtyNotes, { wills: "Estates with US heirs" });
    assertEquals(world.doc("providers", "L2")!.specialties, ["wills"]);
    assertEquals(world.doc("matters", "mx")!.specialtyId, "wills");
    assertEquals([world.doc("specialties", "probate")!.active, world.doc("specialties", "probate")!.mergedInto], [false, "wills"]);
    assert(world.all("audit_log").some((a) => a.action === "specialty.merged"));
    assertEquals((await mergeSpecialty("probate", "wills", { email: "x", role: "staff" })).status, 409, "merged once");
  } finally {
    world.restore();
  }
});

// ─── Pre-call email ────────────────────────────────────────────────────────

Deno.test("pre-call email: question, profile, documents by name, lawyer's time zone and language, no attachments", async () => {
  const world = await world0();
  try {
    addLawyer(world, "PT1", "PT", ["residency_renewals"]);
    world.put("clients", "g4", { email: "g4@mailbox-rt.io", fullName: "Grace Whitfield", legalCountry: "PT", preferredLanguage: "en", timezone: "America/Chicago", residencyStatus: "D7 holder", residencyExpiresAt: "2027-03-01", ownsProperty: true, propertyLocation: "Lagos, Faro", passportNumber: "X1234567", dateOfBirth: "1958-04-02", phone: "+1 312 555 0101" });
    world.put("matters", "mat_g4", { id: "mat_g4", clientId: "g4", country: "PT", title: "Residence card renewal", area: "immigration", stage: "intake", stageEnteredAt: "2026-10-20T15:00:00.000Z", openedAt: "2026-10-20T15:00:00.000Z" });
    world.put("obligations", "ob1", { id: "ob1", clientId: "g4", country: "PT", ruleId: "PT-IMM-1", title: "Residence card renewal may require review", dueAt: "2026-12-15T00:00:00.000Z", status: "upcoming" });
    world.put("member_documents", "d1", { id: "d1", clientId: "g4", fileName: "passport-scan.pdf", category: "identity", objectName: "members/g4/d1" });
    const c = { id: "call1", clientId: "g4", matterId: "mat_g4", providerId: "PT1", scheduledAt: "2026-11-03T15:00:00.000Z", durationMin: 20, status: "booked", question: "Can I renew my residence card from Chicago?", consent: { recording: "pending" }, meetUrl: "https://meet.google.com/abc-defg-hij", createdAt: "2026-10-27T15:00:00.000Z" };
    world.put("consultations", "call1", c);
    assert(await sendPreCallEmail(c as never, "booked"));
    const mail = world.emails().find((m) => m.to === "pt1@lawyers-rt.io")!;
    assert(mail, "lawyer email queued");
    assert(mail.subject.startsWith("Nova chamada ILP: Grace Whitfield"), mail.subject);
    // 15:00 UTC on 3 November is 15:00 in Lisbon (winter time).
    assert(mail.text.includes("15:00"), "time in the lawyer's zone");
    assert(mail.text.includes("Lisbon"), "zone named");
    for (const part of ["Can I renew my residence card from Chicago?", "D7 holder", "Lagos, Faro", "passport-scan.pdf (identity)", "Residence card renewal may require review", "https://meet.google.com/abc-defg-hij", "/lawyer/calls/call1"]) {
      assert(mail.text.includes(part), `missing ${part}`);
    }
    for (const secret of ["X1234567", "1958-04-02", "+1 312 555 0101", "g4@mailbox-rt.io", "members/g4/d1"]) assert(!mail.text.includes(secret) && !mail.html.includes(secret), `${secret} leaked`);
    assertEquals(mail.attachments, undefined);
    assert(!/—|–/.test(mail.text), "no em or en dashes");
  } finally {
    world.restore();
  }
});

Deno.test("pre-call email: Spanish by default, times in the lawyer's zone", () => {
  const brief = buildPreCallBrief({
    consultation: { id: "c", clientId: "x", matterId: "m", providerId: "L", question: "¿Cómo renuevo el DIMEX?", scheduledAt: "2026-11-03T15:00:00.000Z" },
    client: { fullName: "Robert Hayes", legalCountry: "CR", timezone: "America/Denver", hasCompany: true, companyType: "SA" },
    matters: [{ id: "m", clientId: "x", title: "DIMEX", area: "immigration", country: "CR", stage: "intake", stageEnteredAt: "", openedAt: "" }],
    obligations: [],
    consultations: [],
    handoffs: [],
    documents: [],
    lang: "es",
    now: new Date("2026-10-28T00:00:00Z"),
  });
  assertEquals(brief.facts.find(([k]) => k === "Empresa")?.[1], "Sí, SA");
  const mail = preCallLawyerEmail({ lang: "es", kind: "1h", lawyerName: "Ana", when: whenIn("2026-11-03T15:00:00.000Z", "America/Costa_Rica", "es"), durationMin: 20, meetUrl: null, briefUrl: "https://x/lawyer/calls/c", brief });
  assert(mail.subject.startsWith("Recordatorio: llamada con Robert Hayes en una hora"), mail.subject);
  assert(mail.text.includes("9:00"), "15:00 UTC is 9:00 in Costa Rica");
  assert(mail.text.includes("El enlace de Google Meet llegará por correo"));
  assert(mail.text.includes("Migración y residencia"));
});

Deno.test("reminders: the lawyer's 24 h and 1 h reminders carry the brief; a sales call reminds the sales inbox", async () => {
  const world = await world0();
  try {
    const { callReminders } = await import("../jobs/callReminders.ts");
    addLawyer(world, "CR9", "CR", ["residency_renewals"]);
    addMember(world, "g5", "CR", { title: "DIMEX", area: "immigration" });
    world.put("consultations", "c9", { id: "c9", clientId: "g5", providerId: "CR9", scheduledAt: "2026-10-29T15:00:00.000Z", durationMin: 20, status: "booked", question: "DIMEX renewal", consent: { recording: "pending" }, createdAt: "2026-10-20T15:00:00.000Z", remindersSent: [] });
    world.put("consultations", "s9", { id: "s9", clientId: "g5", providerId: "ilp_sales", kind: "sales", salesEmail: "consultation@internationalrelocationpartner.com", scheduledAt: "2026-10-29T15:10:00.000Z", durationMin: 15, status: "booked", question: "Short call", consent: { recording: "declined" }, createdAt: "2026-10-20T15:00:00.000Z", remindersSent: [] });
    world.setNow("2026-10-28T15:30:00.000Z"); // 23.5 h before the lawyer call
    await callReminders(world.now());
    const lawyer24 = world.emails().filter((m) => m.to === "cr9@lawyers-rt.io");
    assertEquals(lawyer24.length, 1);
    assert(lawyer24[0].subject.startsWith("Recordatorio: llamada con Grace Whitfield mañana"), lawyer24[0].subject);
    assert(lawyer24[0].text.includes("DIMEX renewal"));
    assertEquals(world.emails().filter((m) => m.to === "consultation@internationalrelocationpartner.com").length, 1, "sales inbox reminded");
    world.setNow("2026-10-29T14:05:00.000Z");
    await callReminders(world.now());
    const lawyer1h = world.emails().filter((m) => m.to === "cr9@lawyers-rt.io" && /en una hora/.test(m.subject));
    assertEquals(lawyer1h.length, 1);
    assertEquals(world.doc("consultations", "c9")!.remindersSent, ["24h", "1h"]);
  } finally {
    world.restore();
  }
});
