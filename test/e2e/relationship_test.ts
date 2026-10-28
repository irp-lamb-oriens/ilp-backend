import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, fakeServiceAccount, installFakeWorld } from "./fakeWorld.ts";
import { type CallResult, FakeApp } from "./fakeApp.ts";

/**
 * REL: the lawyer–member relationship, end to end, through the real routes.
 * ──────────────────────────────────────────────────────────────────────────
 * Two lawyers in two countries apply and are approved; members join in each
 * country and are routed; a member books (a second member races for the same
 * slot and loses cleanly); reminders queue; the call completes with consent;
 * the summary is confirmed; the handoff opens CSM tasks; staff add
 * commercial notes (opportunity); the lawyer quotes their fee; staff price it;
 * the member accepts; settlement and payout reach the lawyer's Finance (fee
 * only). Then the no-show, cancel/reschedule, reassignment, lawyer
 * deactivation, member cancellation and renewal paths, with permission
 * checks throughout (docs/workstreams/RELATIONSHIP.md).
 *
 * Fakes: Firestore REST, Google OAuth/Calendar/Drive and the LLM are answered
 * in memory by fakeWorld.ts (the server code runs unchanged down to fetch);
 * the clock is fixed and moved by hand. Payments run in manual mode (staff
 * "Mark paid"), so no Stripe call is made.
 *
 * Run: deno test --allow-env --allow-read test/e2e/relationship_test.ts
 * (or under Node with the Deno shim, as the other server tests).
 */

type Doc = Record<string, any>;

const T0 = "2026-10-20T15:00:00.000Z"; // Tuesday
const DOMAIN = "internationallegalpartner.com";
const ADMIN = `oriens@${DOMAIN}`; // also a default quote approver
const CSM = `carla@${DOMAIN}`;
const STAFF = `sam@${DOMAIN}`;

const W5 = (tz: string) => ({
  timezone: tz,
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: tz === "Europe/Madrid" ? "09:00" : "08:00", end: "12:00" })),
  minLeadHours: 0,
  maxCallsPerDay: 6,
  specialties: ["immigration", "corporate", "real_estate"],
});

let world: FakeWorld;
let app: FakeApp;
const ctx: Doc = {};

function application(over: Doc): Doc {
  return {
    country: "CR",
    name: "Mariela Quesada Rojas",
    email: "mariela@quesada-legal.io",
    phone: "+506 8812 3456",
    languages: ["es", "en"],
    city: "Escazú",
    province: "San José",
    carne: "21345",
    yearAdmitted: 2009,
    notary: false,
    yearsInPractice: 16,
    areas: ["immigration", "real_estate", "corporate"],
    areaComfort: { immigration: "regular" },
    weekly: [{ day: 2, start: "09:00", end: "12:00" }],
    callsPerWeek: 6,
    minNoticeHours: 24,
    hourlyRateCents: 12000,
    flatFeesCents: {},
    quotePreference: "flat",
    invoicingEntity: "individual",
    bio: "I help foreigners with residency, property and companies. Sixteen years in practice, English and Spanish, clear fixed fees.",
    agreements: {},
    elapsedMs: 240000,
    ...over,
  };
}

const bearer = (token: string | null): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

function as(token: string | null) {
  const go = (method: string, url: string, body?: unknown): Promise<CallResult> =>
    app.call(method, url, { body, headers: bearer(token) });
  return {
    get: (url: string) => go("GET", url),
    post: (url: string, body: unknown = {}) => go("POST", url, body),
    patch: (url: string, body: unknown = {}) => go("PATCH", url, body),
    put: (url: string, body: unknown = {}) => go("PUT", url, body),
    del: (url: string) => go("DELETE", url),
  };
}

/** A member session (sliding client sessions are capped at 30 days from login, so it is re-minted on use). */
function member(clientId: string): string {
  const token = `cli_${clientId}`;
  world.put("client_status_sessions", token, {
    email: world.doc("clients", clientId)?.email ?? clientId,
    projectId: clientId,
    createdAt: world.now().toISOString(),
    expiresAt: new Date(world.now().getTime() + 7 * 86_400_000).toISOString(),
  });
  return token;
}

function lawyerSession(providerId: string): string {
  const token = `law_${providerId}`;
  world.put("provider_sessions", token, { email: world.doc("providers", providerId)?.email, providerId, expiresAt: "2030-01-01T00:00:00Z" });
  return token;
}

function staffSession(email: string): string {
  const token = `stf_${email.split("@")[0]}`;
  world.put("dashboard_sessions", token, { email, expiresAt: "2030-01-01T00:00:00Z" });
  return token;
}

const json = (v: unknown) => JSON.stringify(v);
const at = (iso: string) => world.setNow(iso);

/** Keys anywhere in a payload. */
function keysIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysIn(x, out));
  return out;
}

const tasks = (clientId: string) => world.all("csm_tasks").filter((t) => t.clientId === clientId);
const consultation = (id: string) => world.doc("consultations", id)!;
const membershipOf = (clientId: string) =>
  world.all("memberships").filter((m) => m.clientId === clientId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];

// ─── Setup ─────────────────────────────────────────────────────────────────

Deno.test("REL 0 setup: fake world, real routers, staff sessions", async () => {
  const env: Record<string, string> = {
    SERVICE_ACCOUNT_KEY: await fakeServiceAccount(),
    CALENDAR_ID: `calls@${DOMAIN}`,
    GOOGLE_SUBJECT_EMAIL: `calls@${DOMAIN}`,
    PAYMENTS_MODE: "manual",
    ADMIN_EMAILS: ADMIN,
    CSM_EMAILS: CSM,
    DEFAULT_CSM_EMAIL: CSM,
    FRONTEND_URL: "https://app.e2e-ilp.io",
    OPENROUTER_API_KEY: "e2e",
  };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  for (const k of ["DEFAULT_PROVIDER_ID", "AUTH_COOKIES", "GEMINI_API_KEY", "DEMO_AUTOPAY", "PAYMENTS_DEMO_AUTOPAY"]) Deno.env.delete(k);
  world = installFakeWorld(T0, {
    suggestion: {
      summary: "Alice owns a Guanacaste house through an S.A. whose books are two years behind.",
      nextSteps: [{ what: "Send the corporate books", who: "client", dueInDays: 7 }],
    },
  });
  app = new FakeApp();
  // The routers in main.ts order (only those the relationship touches).
  const S = (m: string) => import(m);
  const { documentAccessRouter } = await S("../../helper/storage.ts");
  documentAccessRouter(app);
  for (
    const m of [
      "../../API/providers/providersRouter.ts",
      "../../API/dashboard/providersRouter.ts",
      "../../API/provider/providerDashboardRouter.ts",
      "../../API/provider/providerQuotesRouter.ts",
      "../../API/dashboard/assignmentRouter.ts",
      "../../API/finance/financeLedgerRouter.ts",
      "../../API/payments/paymentsRouter.ts",
      "../../API/clientStatus/clientStatusRouter.ts",
      "../../API/dashboard/quotesRouter.ts",
      "../../API/members/membersRouter.ts",
      "../../API/calls/callsRouter.ts",
      "../../API/opportunities/opportunitiesRouter.ts",
    ]
  ) (await S(m)).default(app);
  ctx.admin = staffSession(ADMIN);
  ctx.csm = staffSession(CSM);
  ctx.staff = staffSession(STAFF);
  // A placeholder (seed) lawyer licensed in Costa Rica with no load: real members must never be routed to it.
  world.put("providers", "ph_lawyer_cr", { name: "Seed Lawyer", email: "seed@example.com", status: "active", active: true, jurisdictions: ["CR"], legalAreas: ["immigration"], placeholder: true });
  world.put("lawyer_availability", "ph_lawyer_cr", { ...W5("America/Costa_Rica"), id: "ph_lawyer_cr", providerId: "ph_lawyer_cr", blackoutDates: [] });
});

// ─── 1. Lawyer onboarding ─────────────────────────────────────────────────

Deno.test("REL 1 lawyer onboarding: apply → pending_review → review → active; availability", async () => {
  const { PARTNER_TERMS_VERSION } = await import("../../API/providers/applyLogic.ts");
  const { LEGAL_VERSIONS } = await import("../../API/privacy/policy.ts");
  const agreements = { licensedInGoodStanding: true, partnerTerms: true, partnerTermsVersion: PARTNER_TERMS_VERSION, privacy: true, privacyVersion: LEGAL_VERSIONS.privacy, carneVerification: true };
  const apply = async (over: Doc) => {
    const r = await as(null).post("/api/providers/apply", application({ agreements, ...over }));
    assertEquals(r.status, 201, `apply ${over.email}: ${json(r.body)}`);
    const p = world.all("providers").find((x) => x.email === over.email)!;
    assertEquals(p.status, "pending_review");
    assertEquals(p.active, false);
    return p.id as string;
  };
  ctx.A = await apply({ email: "ana.mora@mora-legal.io", name: "Ana Mora" }); // Costa Rica
  ctx.B = await apply({ email: "bea.ruiz@ruiz-abogados.io", name: "Beatriz Ruiz", country: "ES", province: "Madrid", city: "Madrid", carne: "ICAM-123456", phone: "+34 612 345 678", timezone: "Europe/Madrid" });
  ctx.C = await apply({ email: "carlos.vega@vega-legal.io", name: "Carlos Vega" }); // second Costa Rica lawyer, approved later

  // In review: no times offered, no routing, portal open with "in review".
  const tokA = lawyerSession(ctx.A);
  const me = await as(tokA).get("/api/provider/me");
  assertEquals([me.status, me.body.status, me.body.canTakeCalls], [200, "pending_review", false]);

  // Staff: request changes needs a note; then approve.
  const rc = await as(ctx.staff).post(`/api/dashboard/providers/${ctx.A}/review`, { action: "request_changes" });
  assertEquals(rc.status, 400, "request changes without a note");
  for (const id of [ctx.A, ctx.B]) {
    const r = await as(ctx.staff).post(`/api/dashboard/providers/${id}/review`, { action: "approve" });
    assertEquals(r.status, 200, json(r.body));
    assertEquals([world.doc("providers", id)!.status, world.doc("providers", id)!.active], ["active", true]);
  }
  assert(world.all("audit_log").some((a) => a.action?.startsWith("provider.application") || a.target === `providers/${ctx.A}`), "review audited");

  // Availability in each lawyer's own time zone.
  for (const [id, tz] of [[ctx.A, "America/Costa_Rica"], [ctx.B, "Europe/Madrid"]]) {
    const r = await as(lawyerSession(id)).put("/api/provider/availability", W5(tz));
    assertEquals(r.status, 200, json(r.body));
    assertEquals(r.body.timezone, tz);
  }
  const me2 = await as(tokA).get("/api/provider/me");
  assertEquals([me2.body.status, me2.body.canTakeCalls], ["active", true]);
});

// ─── 2. Member onboarding ─────────────────────────────────────────────────

async function join(email: string, fullName: string, country: string): Promise<string> {
  const r = await as(null).post("/api/payments/join", { email, fullName, country, acceptTerms: true, acceptPrivacy: true });
  assertEquals(r.status, 201, `join ${email}: ${json(r.body)}`);
  assertEquals(r.body.status, "pending");
  const c = world.all("clients").find((x) => x.email === email)!;
  return c.id as string;
}

Deno.test("REL 2 member onboarding: join → mark paid → active, onboarding task, country routing", async () => {
  ctx.M1 = await join("alice.hart@mailbox-e2e.io", "Alice Hart", "CR");
  ctx.M2 = await join("bob.stone@mailbox-e2e.io", "Bob Stone", "CR");
  ctx.M3 = await join("carmen.diaz@mailbox-e2e.io", "Carmen Diaz", "ES");
  ctx.M4 = await join("pat.lee@mailbox-e2e.io", "Pat Lee", "PA"); // no lawyer licensed in Panama

  // Pending: booking is refused until paid.
  const early = await as(member(ctx.M1)).post("/api/client-status/me/consultations", { scheduledAt: "2026-10-21T15:00:00Z", question: "Corporation books" });
  assertEquals(early.status, 409, "pending membership cannot book");

  // A member cannot mark themselves paid; staff can.
  const self = await as(member(ctx.M1)).post(`/api/payments/memberships/${membershipOf(ctx.M1).id}/mark-paid`, {});
  assertEquals(self.status, 401);
  for (const id of [ctx.M1, ctx.M2, ctx.M3, ctx.M4]) {
    const r = await as(ctx.csm).post(`/api/payments/memberships/${membershipOf(id).id}/mark-paid`, { reference: "wire-1" });
    assertEquals(r.status, 200, json(r.body));
    assertEquals(membershipOf(id).status, "active");
    assert(tasks(id).some((t) => t.type === "onboarding" && t.status === "open"), "onboarding task");
  }

  // Routing at activation: by country, never to the placeholder lawyer.
  assert(ctx.A && ctx.B, "lawyers approved");
  assertEquals(world.doc("clients", ctx.M1)!.assignedProviderId, ctx.A, "M1 → Costa Rica lawyer");
  assertEquals(world.doc("clients", ctx.M2)!.assignedProviderId, ctx.A, "M2 → Costa Rica lawyer");
  assertEquals(world.doc("clients", ctx.M3)!.assignedProviderId, ctx.B, "M3 → Spain lawyer");
  assertEquals(world.doc("clients", ctx.M4)!.assignedProviderId ?? null, null, "M4 has nobody in Panama");
  assert(tasks(ctx.M4).some((t) => t.title.startsWith("Match a lawyer licensed")), "unassigned-country task");
  const m4slots = await as(member(ctx.M4)).get("/api/client-status/me/slots");
  assertEquals([m4slots.status, m4slots.body.matching, m4slots.body.slots.length], [200, true, 0]);

  // A matter staff open later follows the member's lawyer.
  const mat = await as(ctx.csm).post("/api/staff/matters", { clientId: ctx.M1, title: "S.A. and Guanacaste house", area: "corporate" });
  assertEquals(mat.status, 201, json(mat.body));
  ctx.mat1 = mat.body.id;
  assertEquals(world.doc("matters", ctx.mat1)!.assignedProviderId, ctx.A, "new matter assigned to the member's lawyer");

  // A free account (deadlines only).
  world.put("clients", "free_fran", { email: "fran@mailbox-e2e.io", name: "Fran", accountType: "free", createdAt: T0 });
  ctx.F = "free_fran";
});

// ─── 3. Booking ───────────────────────────────────────────────────────────

Deno.test("REL 3 booking: slots in the lawyer's time zone (DST), race for one slot, consent, Meet, emails", async () => {
  const s1 = await as(member(ctx.M1)).get("/api/client-status/me/slots");
  assertEquals(s1.status, 200, json(s1.body));
  assertEquals(s1.body.lawyerName, "Ana Mora");
  // Costa Rica 08:00-12:00 (UTC-6): 14:00Z-18:00Z; now is Tue 15:00Z.
  assertEquals(s1.body.slots[0], "2026-10-20T15:00:00.000Z");
  ctx.slot1 = "2026-10-21T15:00:00.000Z";
  assert(s1.body.slots.includes(ctx.slot1));

  // Spain: 09:00 Madrid is 07:00Z before the clocks change (25 Oct) and 08:00Z after.
  const s3 = await as(member(ctx.M3)).get("/api/client-status/me/slots");
  assert(s3.body.slots.includes("2026-10-22T07:00:00.000Z"), "CEST 09:00");
  assert(s3.body.slots.includes("2026-10-26T08:00:00.000Z"), "CET 09:00");
  assert(!s3.body.slots.includes("2026-10-26T07:00:00.000Z"), "08:00 CET is outside the window");

  // Two members race for the same slot with the same lawyer: exactly one wins.
  const book = (cid: string, iso: string, extra: Doc = {}) =>
    as(member(cid)).post("/api/client-status/me/consultations", { scheduledAt: iso, question: "My question for the lawyer", ...extra });
  const [r1, r2] = await Promise.all([
    book(ctx.M1, ctx.slot1, { matterId: ctx.mat1, recordingConsent: "granted" }),
    book(ctx.M2, ctx.slot1),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assertEquals(statuses, [201, 409], `race: ${r1.status} ${json(r1.body)} / ${r2.status} ${json(r2.body)}`);
  const held = world.all("consultations").filter((c) => c.providerId === ctx.A && c.scheduledAt === ctx.slot1 && c.status === "booked");
  assertEquals(held.length, 1, "one call holds the slot");
  // The test wants M1 to hold slot1; if M2 won the race, swap their roles.
  if (held[0].clientId !== ctx.M1) [ctx.M1, ctx.M2] = [ctx.M2, ctx.M1];
  ctx.c1 = held[0].id;
  const c1 = consultation(ctx.c1);
  assertEquals(c1.status, "booked");
  assert(c1.meetUrl?.startsWith("https://meet.google.com/"), "Meet link");
  const attendees = world.calendar.get(c1.calendarEventId)!.attendees;
  assert(attendees.includes(world.doc("clients", ctx.M1)!.email) && attendees.includes("ana.mora@mora-legal.io"), json(attendees));
  // The loser books the next slot.
  const r2b = await book(ctx.M2, "2026-10-21T15:20:00.000Z");
  assertEquals(r2b.status, 201, json(r2b.body));
  ctx.c2 = r2b.body.consultation.id;
  assertEquals(consultation(ctx.c2).consent.recording, "pending");
  // Booking emails to both sides; a member never sees the calendar internals.
  const mails = world.emails().map((e) => e.to);
  assert(mails.includes(world.doc("clients", ctx.M1)!.email) && mails.includes("ana.mora@mora-legal.io"), json(mails));
  assertEquals(r2b.body.consultation.calendarEventId, undefined);
  assertEquals(r2b.body.capacity.callsBooked, 1);
  assert(tasks(ctx.M1).some((t) => t.title.startsWith("Check profile is consultation-ready")), "consultation.booked task");

  // Calendar outage: the booking stands, the link is pending, the CSM gets a task; retry fixes it.
  world.failCalendar = true;
  const r3 = await book(ctx.M3, "2026-10-22T07:00:00.000Z");
  world.failCalendar = false;
  assertEquals(r3.status, 201, json(r3.body));
  ctx.c3 = r3.body.consultation.id;
  assertEquals(r3.body.consultation.linkPending, true);
  assert(tasks(ctx.M3).some((t) => t.title.startsWith("Meet link failed")), "link-failed task");
  const retry = await as(ctx.csm).post(`/api/dashboard/consultations/${ctx.c3}/retry-calendar`);
  assertEquals(retry.status, 200);
  assert(consultation(ctx.c3).meetUrl, "link after retry");

  // Free accounts and members without capacity cannot book.
  const free = await as(member(ctx.F)).get("/api/client-status/me/slots");
  assertEquals([free.status, free.body.code], [402, "membership_required"]);
  const freeBook = await book(ctx.F, ctx.slot1);
  assertEquals(freeBook.status, 402);
  // A slot that is not offered (outside the window) is refused.
  const odd = await book(ctx.M1, "2026-10-21T03:00:00.000Z");
  assertEquals(odd.status, 409);
});

// ─── 4. Reschedule rules before the call ──────────────────────────────────

Deno.test("REL 4 cancel / reschedule: member ≥ 24 h, staff any time, Calendar follows", async () => {
  // Member moves the Spain call across the DST change (≥ 24 h ahead).
  const mv = await as(member(ctx.M3)).post(`/api/client-status/me/consultations/${ctx.c3}/reschedule`, { scheduledAt: "2026-10-26T08:00:00.000Z" });
  assertEquals(mv.status, 200, json(mv.body));
  const c3 = consultation(ctx.c3);
  assertEquals([c3.scheduledAt, c3.previousScheduledAt], ["2026-10-26T08:00:00.000Z", "2026-10-22T07:00:00.000Z"]);
  assertEquals(world.calendar.get(c3.calendarEventId)!.start, "2026-10-26T08:00:00.000Z");
  // The old slot is free again for others.
  const s = await as(member(ctx.M3)).get("/api/client-status/me/slots");
  assert(s.body.slots.includes("2026-10-22T07:00:00.000Z"));
  // Another member's call cannot be touched.
  const other = await as(member(ctx.M3)).post(`/api/client-status/me/consultations/${ctx.c1}/cancel`, {});
  assertEquals(other.status, 404);
});

// ─── 5. Reminders ─────────────────────────────────────────────────────────

Deno.test("REL 5 reminders: 1 h before (24 h skipped for a late booking), once", async () => {
  const { callReminders } = await import("../../jobs/callReminders.ts");
  at("2026-10-21T14:05:00.000Z");
  const before = world.emails().length;
  const r = await callReminders(world.now());
  assert(r.sent >= 2, `reminders sent: ${json(r)}`);
  const c1 = consultation(ctx.c1);
  assertEquals((c1.remindersSent ?? []).sort(), ["1h", "24h"]);
  const again = await callReminders(world.now());
  assertEquals(again.sent, 0, "idempotent");
  assert(world.emails().length - before >= 2);
  // Inside 24 h the member can no longer move the call; staff can.
  const late = await as(member(ctx.M2)).post(`/api/client-status/me/consultations/${ctx.c2}/cancel`, {});
  assertEquals(late.status, 409);
});

// ─── 6. The call ──────────────────────────────────────────────────────────

Deno.test("REL 6 the call: brief for the assigned lawyer only, consent-gated transcript, charged once", async () => {
  const tokA = lawyerSession(ctx.A);
  const tokB = lawyerSession(ctx.B);
  at("2026-10-21T15:00:00.000Z");
  const today = await as(tokA).get(`/api/provider/today?from=2026-10-21T00:00:00.000Z&to=2026-10-22T00:00:00.000Z`);
  assertEquals(today.status, 200);
  assertEquals(today.body.items.map((i: Doc) => i.id), [ctx.c1, ctx.c2]);
  const brief = await as(tokA).get(`/api/provider/consultations/${ctx.c1}/brief`);
  assertEquals(brief.status, 200, json(brief.body));
  assertEquals(brief.body.who.name, "Alice Hart");
  assertEquals((await as(tokB).get(`/api/provider/consultations/${ctx.c1}/brief`)).status, 404, "other lawyer");
  assertEquals((await as(tokB).get(`/api/lawyer/members/${ctx.M1}`)).status, 404, "other lawyer, member bundle");
  assertEquals((await as(tokB).get(`/api/provider/members/${ctx.M1}/documents`)).status, 404, "other lawyer, documents");

  // Call starts.
  const ip = await as(tokA).patch(`/api/lawyer/consultations/${ctx.c1}`, { status: "in_progress" });
  assertEquals([ip.status, ip.body.status], [200, "in_progress"]);

  // No consent on c2: no transcript may be stored or fetched.
  const paste = await as(tokA).patch(`/api/lawyer/consultations/${ctx.c2}`, { transcript: "Bob said..." });
  assertEquals(paste.status, 409, "transcript without consent");
  assertEquals(consultation(ctx.c2).transcript, undefined);
  const drive0 = world.requests.filter((r) => r.url.includes("/drive/")).length;
  const meet2 = await as(tokA).post(`/api/provider/consultations/${ctx.c2}/meet-transcript`);
  assertEquals(meet2.status, 409);
  assertEquals(world.requests.filter((r) => r.url.includes("/drive/")).length, drive0, "Drive not read");

  // With consent: Meet transcript → suggested summary (never confirmed by the AI).
  world.calendar.get(consultation(ctx.c1).calendarEventId)!.attachments = [{ fileId: "doc_c1", title: "ILP call - Transcript", mimeType: "application/vnd.google-apps.document" }];
  world.drive.set("doc_c1", "Lawyer: tell me about the company. Alice: the books are two years behind.");
  const meet = await as(tokA).post(`/api/provider/consultations/${ctx.c1}/meet-transcript`);
  assertEquals([meet.status, meet.body.status], [200, "fetched"], json(meet.body));
  assertEquals(consultation(ctx.c1).summary.status, "suggested");
  // The member never sees the transcript or an unconfirmed summary.
  const mh = await as(member(ctx.M1)).get("/api/member/consultations");
  assert(!json(mh.body).includes("two years behind"), "no transcript / suggestion for the member");

  // A handoff before the summary is confirmed is refused.
  const early = await as(tokA).post("/api/lawyer/handoffs", { consultationId: ctx.c1, legalNextSteps: [{ what: "x", who: "client" }] });
  assertEquals(early.status, 409, "handoff needs a confirmed summary");

  // Completing before the call started is refused (c4-style future call checked later); now complete c1 twice at once.
  at("2026-10-21T15:20:00.000Z");
  const done = { summary: { text: "Alice's S.A. books are two years behind; the house is held by the S.A.", status: "confirmed" }, status: "completed", minutesUsed: 500 };
  const [d1, d2] = await Promise.all([as(tokA).patch(`/api/lawyer/consultations/${ctx.c1}`, done), as(tokA).patch(`/api/lawyer/consultations/${ctx.c1}`, done)]);
  assertEquals([d1.status, d2.status], [200, 200]);
  const m1 = membershipOf(ctx.M1);
  assertEquals([m1.minutesUsed, m1.callsUsed], [20, 1], "charged once, at most the booked 20 minutes");
  assertEquals(consultation(ctx.c1).minutesUsed, 20);
  assert(consultation(ctx.c1).chargedAt);
});

// ─── 7. After the call ────────────────────────────────────────────────────

Deno.test("REL 7 after the call: handoff → member Next step, CSM task, rating", async () => {
  const tokA = lawyerSession(ctx.A);
  const h = await as(tokA).post("/api/lawyer/handoffs", {
    consultationId: ctx.c1,
    legalNextSteps: [
      { what: "Send the last two years of corporate books", who: "client", dueAt: "2026-10-28T00:00:00.000Z" },
      { what: "Review the books and the property registry", who: "lawyer" },
    ],
    commercialNotes: "Lawyer tries to write a commercial note", // staff-only: dropped
  });
  assertEquals(h.status, 201, json(h.body));
  ctx.h1 = h.body.id;
  const hof = world.doc("handoffs", ctx.h1)!;
  assertEquals(hof.commercialNotes, undefined, "lawyers cannot write commercial notes");
  assertEquals(hof.legalNextSteps.length, 2);
  assert(tasks(ctx.M1).some((t) => t.title.startsWith("Send next steps and confirm")), "handoff.approved task");
  assert(!tasks(ctx.M1).some((t) => t.type === "proposal"), "no proposal task without commercial notes");
  assert(world.all("audit_log").some((a) => a.action === "handoff.created"), "handoff audited");
  // Second handoff for the same call: 409 with the existing id.
  const dup = await as(tokA).post("/api/lawyer/handoffs", { consultationId: ctx.c1, legalNextSteps: [{ what: "y" }] });
  assertEquals([dup.status, dup.body.handoffId], [409, ctx.h1]);

  // Member home: the next step and the minutes left.
  const home = await as(member(ctx.M1)).get("/api/client-status/me/home");
  assertEquals(home.status, 200);
  const step = home.body.matters.find((m: Doc) => m.id === ctx.mat1)?.nextStep ?? home.body.generalNextStep;
  assertEquals(step.what, "Send the last two years of corporate books");
  assertEquals([home.body.capacity.minutesLeft, home.body.capacity.callsLeft], [40, 2]);
  assertEquals(home.body.pastCalls[0].summary, consultation(ctx.c1).summary.text);
  assert(!json(home.body).includes("Lawyer: tell me"), "no transcript in member home");

  // Post-call rating (once).
  const rate = await as(member(ctx.M1)).post("/api/retention/me/feedback/call", { consultationId: ctx.c1, score: 5 });
  assertEquals(rate.status, 200, json(rate.body));
  assertEquals(consultation(ctx.c1).rating.score, 5);
});

// ─── 8. Commercial follow-up ──────────────────────────────────────────────

Deno.test("REL 8 staff commercial notes → opportunity + proposal task; hidden from lawyer and member", async () => {
  const { opportunityIdForHandoff } = await import("../../API/opportunities/logic.ts");
  const r = await as(ctx.csm).patch(`/api/staff/handoffs/${ctx.h1}`, { commercialNotes: "S.A. clean-up: books, minutes, tax filings. Quote it." });
  assertEquals(r.status, 200, json(r.body));
  ctx.opp = opportunityIdForHandoff(ctx.h1);
  assert(world.doc("opportunities", ctx.opp), "opportunity from the handoff");
  assert(tasks(ctx.M1).some((t) => t.type === "proposal" && t.status === "open"), "handoff.opportunity task");
  for (const [who, url] of [[lawyerSession(ctx.A), "/api/lawyer/handoffs"], [lawyerSession(ctx.A), `/api/lawyer/members/${ctx.M1}`], [member(ctx.M1), "/api/member/handoffs"], [member(ctx.M1), "/api/member/home"]]) {
    const x = await as(who).get(url);
    assertEquals(x.status, 200, `${url}: ${json(x.body)}`);
    assert(!keysIn(x.body).has("commercialNotes") && !json(x.body).includes("S.A. clean-up: books"), `${url} hides commercial notes`);
  }
  assert(world.all("audit_log").some((a) => a.action === "record.updated" && a.target === `handoffs/${ctx.h1}`), "staff edit audited");
});

// ─── 9. Paid legal work ───────────────────────────────────────────────────

Deno.test("REL 9 paid legal work: lawyer fee → staff margin → member price → accept → settlement → payout", async () => {
  const tokA = lawyerSession(ctx.A);
  const base = `/api/provider/clients/${ctx.M1}/quotes`;
  // The lawyer quotes their fee. A status in the body is ignored: lawyer quotes start as drafts.
  const q = await as(tokA).post(base, { title: "S.A. clean-up", lineItems: [{ label: "Corporate books update", amount: 1000 }], status: "approved" });
  assertEquals(q.status, 201, json(q.body));
  ctx.q = q.body.quote.quoteId;
  const stored = () => (world.doc("clients", ctx.M1)!.quotes as Doc[]).find((x) => x.quoteId === ctx.q)!;
  assertEquals(stored().status, "draft");
  assertEquals(stored().providerIds, [ctx.A]);
  assertEquals(stored().lineItems[0].providerId, ctx.A);
  // A lawyer can never move a quote's status (no self-approval, no fake acceptance).
  const fake = await as(tokA).patch(`${base}/${ctx.q}`, { status: "client_accepted" });
  assertEquals(fake.status, 400);
  assertEquals(stored().status, "draft");
  const sub = await as(tokA).post(`${base}/${ctx.q}/submit-for-approval`, {});
  assertEquals(sub.status, 200);
  const locked = await as(tokA).patch(`${base}/${ctx.q}`, { lineItems: [{ lineId: stored().lineItems[0].lineId, label: "Corporate books update", amount: 5000 }] });
  assertEquals(locked.status, 409, "fee locked while staff review it");
  const send = await as(tokA).post(`${base}/${ctx.q}/send-to-client`, {});
  assertEquals(send.status, 403, "only staff send quotes to members");

  // Staff price it: 30% margin on the lawyer's fee.
  const sbase = `/api/dashboard/clients/${ctx.M1}/quotes/${ctx.q}`;
  const priced = await as(ctx.admin).patch(sbase, { lineItems: [{ ...stored().lineItems[0], marginPct: 30 }] });
  assertEquals(priced.status, 200, json(priced.body));
  assertEquals([stored().total, stored().costSubtotal], [1300, 1000]);
  assertEquals((await as(ctx.admin).post(`${sbase}/approve`, {})).status, 200);
  const sent = await as(ctx.admin).post(`${sbase}/send-to-client`, {});
  assertEquals(sent.status, 200, json(sent.body));
  const link = await as(ctx.csm).post(`/api/dashboard/opportunities/${ctx.opp}/quote`, { quoteId: ctx.q });
  assertEquals(link.status, 200, json(link.body));

  // Lawyer sees their fee only.
  const lq = await as(tokA).get(base);
  const lk = keysIn(lq.body);
  assertEquals(lq.body.quotes[0].yourFee, 1000);
  for (const k of ["total", "costSubtotal", "marginPct", "earnings", "clientPrice"]) assert(!lk.has(k), `lawyer sees ${k}`);
  // Member sees the price only.
  const money = await as(member(ctx.M1)).get("/api/client-status/me/money");
  const mq = money.body.quotes.find((x: Doc) => x.id === ctx.q);
  assertEquals([mq.status, mq.totalCents], ["awaiting", 130000]);
  const mk = keysIn(money.body);
  for (const k of ["costSubtotal", "marginPct", "earnings", "amount", "lineItems", "providerIds"]) assert(!mk.has(k), `member sees ${k}`);

  // Member accepts.
  const acc = await as(member(ctx.M1)).post(`/api/client-status/me/quotes/${ctx.q}/accept`, { fullName: "Alice Hart", consent: true });
  assertEquals(acc.status, 200, json(acc.body));
  assertEquals(world.doc("opportunities", ctx.opp)!.stage, "won");
  const st = world.doc("quoteSettlements", ctx.q)!;
  assert(st, "settlement opened on acceptance");
  assertEquals(st.providerIds, [ctx.A]);
  assertEquals(st.providerPayments.map((p: Doc) => [p.providerId, p.amount, p.paid]), [[ctx.A, 1000, false]]);
  assert(world.all("audit_log").some((a) => a.action === "quote.accepted"), "acceptance audited");
  const again = await as(member(ctx.M1)).post(`/api/client-status/me/quotes/${ctx.q}/accept`, { fullName: "Alice Hart", consent: true });
  assertEquals(again.status, 409);
  assertEquals(world.all("quoteSettlements").length, 1, "no duplicate settlement");

  // Lawyer view of the member: no charges (the price would reveal the margin).
  const lc = await as(tokA).get(`/api/provider/clients/${ctx.M1}`);
  assertEquals(lc.status, 200);
  assert(!keysIn(lc.body).has("charges") && !json(lc.body).includes("130000") && !json(lc.body).includes("1300"), "no client price for the lawyer");

  // Lawyer Finance: fee pending.
  let fin = await as(tokA).get("/api/provider/finance");
  assertEquals([fin.body.totals.pending, fin.body.totals.paid], [1000, 0]);
  assert(!json(fin.body).includes("1300"));
  // Staff finance is admin only.
  assertEquals((await as(ctx.csm).get("/api/dashboard/finance/ledger")).status, 403);
  assertEquals((await as(ctx.staff).get("/api/dashboard/finance/ledger")).status, 403);
  const ledger = await as(ctx.admin).get("/api/dashboard/finance/ledger");
  assertEquals(ledger.status, 200, json(ledger.body));
  // Payment collected and lawyer paid.
  const pay = await as(ctx.admin).put(`/api/dashboard/finance/settlements/${ctx.q}`, {
    clientId: ctx.M1,
    clientPayments: [{ amount: 1300, date: "2026-10-21", method: "wire" }],
    providerPayments: [{ id: st.providerPayments[0].id, providerId: ctx.A, providerName: "Ana Mora", amount: 1000, paid: true, date: "2026-10-22" }],
  });
  assertEquals(pay.status, 200, json(pay.body));
  assertEquals(world.doc("quoteSettlements", ctx.q)!.providerIds, [ctx.A]);
  fin = await as(tokA).get("/api/provider/finance");
  assertEquals([fin.body.totals.pending, fin.body.totals.paid], [0, 1000]);
  const finB = await as(lawyerSession(ctx.B)).get("/api/provider/finance");
  assertEquals(finB.body.payments.length, 0, "other lawyer sees nothing");
});

// ─── 10. No-show ──────────────────────────────────────────────────────────

Deno.test("REL 10 no-show: 10-minute rule, charged once, CSM restore once", async () => {
  const tokA = lawyerSession(ctx.A);
  at("2026-10-21T15:25:00.000Z");
  assertEquals((await as(tokA).post(`/api/provider/consultations/${ctx.c2}/no-show`)).status, 409, "before 10 minutes");
  at("2026-10-21T15:31:00.000Z");
  const [a, b] = await Promise.all([as(tokA).post(`/api/provider/consultations/${ctx.c2}/no-show`), as(tokA).post(`/api/provider/consultations/${ctx.c2}/no-show`)]);
  assertEquals([a.status, b.status].sort(), [200, 409], `${json(a.body)} ${json(b.body)}`);
  assertEquals([membershipOf(ctx.M2).minutesUsed, membershipOf(ctx.M2).callsUsed], [20, 1]);
  assertEquals((await as(lawyerSession(ctx.B)).post(`/api/provider/consultations/${ctx.c2}/no-show`)).status, 404, "not their call");
  const [r1, r2] = await Promise.all([as(ctx.csm).post(`/api/dashboard/consultations/${ctx.c2}/restore-call`), as(ctx.csm).post(`/api/dashboard/consultations/${ctx.c2}/restore-call`)]);
  assertEquals([r1.status, r2.status].sort(), [200, 409]);
  assertEquals([membershipOf(ctx.M2).minutesUsed, membershipOf(ctx.M2).callsUsed], [0, 0]);
});

// ─── 11. Reassignment ─────────────────────────────────────────────────────

Deno.test("REL 11 reassignment: calls move when the new lawyer is free, else cancel; old lawyer loses access", async () => {
  // Approve the second Costa Rica lawyer, with a day off on Monday 26 October.
  assertEquals((await as(ctx.staff).post(`/api/dashboard/providers/${ctx.C}/review`, { action: "approve" })).status, 200);
  const av = await as(lawyerSession(ctx.C)).put("/api/provider/availability", { ...W5("America/Costa_Rica"), blackoutDates: ["2026-10-26"] });
  assertEquals(av.status, 200);
  // Alice books two more calls with Ana.
  const book = (iso: string) => as(member(ctx.M1)).post("/api/client-status/me/consultations", { scheduledAt: iso, question: "Follow-up", matterId: ctx.mat1, recordingConsent: "granted" });
  const b4 = await book("2026-10-23T15:00:00.000Z");
  const b5 = await book("2026-10-26T15:00:00.000Z");
  assertEquals([b4.status, b5.status], [201, 201], `${json(b4.body)} ${json(b5.body)}`);
  ctx.c4 = b4.body.consultation.id;
  ctx.c5 = b5.body.consultation.id;
  const oldEvent4 = consultation(ctx.c4).calendarEventId;
  // A third call: the member has used or booked all three.
  assertEquals((await book("2026-10-27T15:00:00.000Z")).status, 409);

  // Guards: not to a placeholder lawyer, not to a lawyer licensed elsewhere, not to one in review.
  assertEquals((await as(ctx.staff).post(`/api/dashboard/clients/${ctx.M1}/assign`, { providerId: "ph_lawyer_cr" })).status, 409);
  assertEquals((await as(ctx.staff).post(`/api/dashboard/clients/${ctx.M1}/assign`, { providerId: ctx.B })).status, 409);
  const r = await as(ctx.staff).post(`/api/dashboard/clients/${ctx.M1}/assign`, { providerId: ctx.C });
  assertEquals(r.status, 200, json(r.body));
  assertEquals([r.body.moved, r.body.cancelled], [[ctx.c4], [ctx.c5]]);
  assertEquals(consultation(ctx.c4).providerId, ctx.C);
  assertEquals(consultation(ctx.c4).status, "booked");
  assert(world.calendar.get(oldEvent4)!.deleted, "old invitation withdrawn");
  assert(consultation(ctx.c4).calendarEventId !== oldEvent4 && consultation(ctx.c4).meetUrl, "new invitation");
  assertEquals(consultation(ctx.c5).status, "cancelled");
  assertEquals(world.doc("matters", ctx.mat1)!.assignedProviderId, ctx.C, "matter follows");
  assertEquals(world.doc("clients", ctx.M1)!.assignedProviderId, ctx.C);
  assert(world.all("audit_log").some((a) => a.action === "member.reassigned"), "reassignment audited");
  // Cancelled call was never charged; the member can book again.
  assertEquals(membershipOf(ctx.M1).callsUsed, 1);
  const home = await as(member(ctx.M1)).get("/api/client-status/me/home");
  assertEquals(home.body.capacity.callsAvailable, 1);

  // Old lawyer: no member bundle, documents, brief or board card; new lawyer: yes.
  const tokA = lawyerSession(ctx.A);
  const tokC = lawyerSession(ctx.C);
  for (const url of [`/api/lawyer/members/${ctx.M1}`, `/api/provider/clients/${ctx.M1}/brief`, `/api/provider/members/${ctx.M1}/documents`, `/api/provider/consultations/${ctx.c1}/brief`, `/api/provider/clients/${ctx.M1}`]) {
    const x = await as(tokA).get(url);
    assert(x.status === 404 || x.status === 403, `old lawyer ${url}: ${x.status}`);
  }
  for (const url of [`/api/lawyer/members/${ctx.M1}`, `/api/provider/clients/${ctx.M1}/brief`, `/api/provider/members/${ctx.M1}/documents`, `/api/provider/consultations/${ctx.c4}/brief`]) {
    assertEquals((await as(tokC).get(url)).status, 200, `new lawyer ${url}`);
  }
  const boardA = await as(tokA).get("/api/provider/board");
  assert(!boardA.body.cards.some((c: Doc) => c.clientId === ctx.M1), "card left the old board");
  const boardC = await as(tokC).get("/api/provider/board");
  assert(boardC.body.cards.some((c: Doc) => c.id === ctx.mat1), "card on the new board");
  // The old lawyer keeps their own payout history.
  assertEquals((await as(tokA).get("/api/provider/finance")).body.totals.paid, 1000);
  // A future call cannot be completed (and charged) before it starts.
  assertEquals((await as(tokC).patch(`/api/lawyer/consultations/${ctx.c4}`, { status: "completed" })).status, 409);
});

// ─── 12. Reminders for the Spain call, then lawyer deactivation ───────────

Deno.test("REL 12 lawyer deactivation: unbookable, calls cancelled, members re-matched or flagged", async () => {
  const { callReminders } = await import("../../jobs/callReminders.ts");
  at("2026-10-25T08:05:00.000Z");
  await callReminders(world.now());
  assertEquals(consultation(ctx.c3).remindersSent, ["24h"]);
  assert(world.emails().some((e) => e.to === "carmen.diaz@mailbox-e2e.io" && /tomorrow|24|reminder/i.test(String(e.subject))), "24 h reminder to the member");
  // Inside 24 h: the member cannot move it.
  assertEquals((await as(member(ctx.M3)).post(`/api/client-status/me/consultations/${ctx.c3}/reschedule`, { scheduledAt: "2026-10-27T08:00:00.000Z" })).status, 409);

  const ev3 = consultation(ctx.c3).calendarEventId;
  const r = await as(ctx.staff).patch(`/api/dashboard/providers/${ctx.B}`, { active: false });
  assertEquals(r.status, 200, json(r.body));
  assertEquals(consultation(ctx.c3).status, "cancelled");
  assert(world.calendar.get(ev3)!.deleted);
  assertEquals(world.doc("clients", ctx.M3)!.assignedProviderId ?? null, null);
  assert(tasks(ctx.M3).some((t) => t.title.startsWith("Match a lawyer licensed") && t.status === "open"), "CSM task to re-match");
  assert(world.emails().some((e) => e.to === "carmen.diaz@mailbox-e2e.io" && /cancel/i.test(String(e.subject))), "member told");
  const s = await as(member(ctx.M3)).get("/api/client-status/me/slots");
  assertEquals([s.body.matching, s.body.slots.length], [true, 0]);
  assertEquals(membershipOf(ctx.M3).callsUsed, 0, "cancelled call not charged");
  assert(world.all("audit_log").some((a) => a.action === "provider.deactivated"), "deactivation audited");
  const me = await as(lawyerSession(ctx.B)).get("/api/provider/me");
  assertEquals(me.body.canTakeCalls, false);
});

// ─── 13. Member cancellation and renewal ──────────────────────────────────

Deno.test("REL 13 member cancellation ends calls after the period; renewal resets minutes and calls", async () => {
  const { membershipRenewalSweep } = await import("../../API/payments/lifecycle.ts");
  at("2026-11-10T15:00:00.000Z");
  const later = "2026-11-23T15:00:00.000Z"; // after Bob's period ends (20 Nov)
  const b = await as(member(ctx.M2)).post("/api/client-status/me/consultations", { scheduledAt: later, question: "Will" });
  assertEquals(b.status, 201, json(b.body));
  ctx.c6 = b.body.consultation.id;
  const cancel = await as(member(ctx.M2)).post("/api/payments/me/cancel", { reason: "price" });
  assertEquals(cancel.status, 200, json(cancel.body));
  assertEquals(membershipOf(ctx.M2).cancelAtPeriodEnd, true);
  // After a cancel request, no new call past the end of the paid period.
  const past = await as(member(ctx.M2)).post("/api/client-status/me/consultations", { scheduledAt: "2026-11-23T15:20:00.000Z", question: "x" });
  assertEquals(past.status, 409);

  at("2026-11-20T16:00:00.000Z");
  await membershipRenewalSweep(world.now());
  assertEquals(membershipOf(ctx.M2).status, "cancelled");
  assertEquals(consultation(ctx.c6).status, "cancelled", "calls after the end are cancelled");
  const today = await as(lawyerSession(ctx.A)).get("/api/provider/today?from=2026-11-23T00:00:00.000Z&to=2026-11-24T00:00:00.000Z");
  assertEquals(today.body.items.length, 0, "gone from the lawyer's day");
  // The call moved to Carlos on 23 Oct was never completed or marked a no-show: the CSM gets a task.
  const { callReminders } = await import("../../jobs/callReminders.ts");
  const sweep = await callReminders(world.now());
  assert(sweep.unresolved >= 1, json(sweep));
  assert(tasks(ctx.M1).some((t) => t.title.startsWith("Call not wrapped up") && t.source?.id === ctx.c4), "call.outcome_missing task");
  assert(!tasks(ctx.M1).some((t) => t.title.startsWith("Call not wrapped up") && t.source?.id === ctx.c1), "wrapped-up call: no task");
  // Alice did not pay on time: past due, then staff mark the renewal paid.
  assertEquals(membershipOf(ctx.M1).status, "past_due");
  assertEquals(membershipOf(ctx.M1).minutesUsed, 20);
  const paid = await as(ctx.csm).post(`/api/payments/memberships/${membershipOf(ctx.M1).id}/mark-paid`, { reference: "wire-2" });
  assertEquals(paid.status, 200, json(paid.body));
  const m1 = membershipOf(ctx.M1);
  assertEquals([m1.status, m1.minutesUsed, m1.callsUsed], ["active", 0, 0]);
});

// ─── 14. Permissions matrix ───────────────────────────────────────────────

Deno.test("REL 14 permissions: roles, scoping and hidden fields", async () => {
  const tokA = lawyerSession(ctx.A);
  const tokC = lawyerSession(ctx.C);
  const m1 = member(ctx.M1);
  const m2 = member(ctx.M2);
  // No session.
  for (const url of ["/api/client-status/me/home", "/api/provider/today", "/api/staff/today", "/api/lawyer/consultations"]) {
    assertEquals((await as(null).get(url)).status, 401, url);
  }
  // Wrong portal.
  assertEquals((await as(m1).get("/api/staff/today")).status, 401);
  assertEquals((await as(m1).get("/api/provider/today")).status, 401);
  assertEquals((await as(tokA).get("/api/client-status/me/home")).status, 401);
  assertEquals((await as(tokA).get("/api/staff/today")).status, 401);
  // Member scoping.
  assertEquals((await as(m2).get(`/api/client-status/me/consultations/${ctx.c1}/join`)).status, 404);
  const own = await as(m2).get("/api/member/consultations");
  assert(own.body.items.every((c: Doc) => c.clientId === ctx.M2));
  // Lawyer scoping.
  assertEquals((await as(tokA).patch(`/api/lawyer/consultations/${ctx.c4}`, { status: "in_progress" })).status, 404);
  assertEquals((await as(tokA).get(`/api/provider/clients/${ctx.M1}/quotes`)).status, 403);
  assertEquals((await as(tokC).get(`/api/provider/clients/${ctx.M2}`)).status, 403);
  // Free account: deadlines only.
  const f = member(ctx.F);
  for (const url of ["/api/client-status/me/slots", "/api/client-status/me/money", "/api/client-status/me/messages"]) {
    assertEquals((await as(f).get(url)).status, 402, url);
  }
  assertEquals((await as(f).get("/api/client-status/me/deadlines")).status, 200);
  // Staff roles: finance admin only.
  assertEquals((await as(ctx.csm).get("/api/dashboard/finance/ledger")).status, 403);
  assertEquals((await as(ctx.admin).get("/api/dashboard/finance/ledger")).status, 200);
  // Hidden fields both ways.
  const lm = await as(tokC).get(`/api/lawyer/members/${ctx.M1}`);
  for (const k of ["commercialNotes", "tasks", "costSubtotal", "marginPct", "charges"]) assert(!keysIn(lm.body).has(k) || k === "tasks" && lm.body.tasks === undefined, `lawyer sees ${k}`);
  const mc = await as(m1).get("/api/member/consultations");
  assert(!keysIn(mc.body).has("transcript"), "member sees no transcript");
  // No email went to a reserved or placeholder address.
  assert(world.emails().every((e) => !/@example\.(com|org|net)|\.test$|\.invalid$/.test(String(e.to))));
});

Deno.test("REL 99 teardown", () => {
  world.restore();
});
