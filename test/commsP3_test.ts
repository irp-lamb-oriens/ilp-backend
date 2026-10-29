import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { clearPlaceholderCache } from "../helper/placeholder.ts";
import { bandFor, healthScore, type HealthInput } from "../API/csm/health.ts";
import { mayOpenMember, resolveScope } from "../API/csm/book.ts";
import { bookRows, firstContactDueAt, todayView } from "../API/csm/compute.ts";
import { buildDigest, csmDailyDigest, CSM_DIGEST_CRON } from "../API/csm/digest.ts";
import { parseContact } from "../API/csm/csmRouter.ts";
import { DEFAULT_PLAYBOOKS, renderPlaybookEmail, validatePlaybookEmail } from "../API/csm/playbooks.ts";
import { channelsFor, visibleTo } from "../API/notifications/store.ts";
import { emitEvent } from "../API/members/events.ts";
import { jobs } from "../jobs/registry.ts";
import { CSM_PLAYBOOK_IDS } from "../schemas/contracts.ts";
import { PLACEHOLDER_CSMS, planCsmSeed } from "../scripts/seedCsmBooks.ts";

/**
 * COMMS-P3: the CSM portal (/csm), the bell and the CSM daily digest.
 * Health score (pure), role scoping through the real routes, notifications
 * lifecycle, digest content / schedule / skip-empty, playbook emails and
 * their email classes.
 * Run: deno test --allow-env --allow-read test/commsP3_test.ts
 */

const NOW = "2026-11-03T15:00:00.000Z"; // Tuesday Nov 3, 09:00 Costa Rica
const DAY = 86_400_000;
const CARLA = "carla@internationallegalpartner.com";
const DIEGO = "diego@internationallegalpartner.com";
const ADMIN = "oriens@internationallegalpartner.com";
const STAFF = "tomas@internationallegalpartner.com";
const DASHES = /—|–/;

let world: FakeWorld;
let app: FakeApp;

const iso = (offsetDays: number) => new Date(Date.parse(NOW) + offsetDays * DAY).toISOString();
const call = (token: string, method: string, url: string, body?: unknown) => app.call(method, url, { body, headers: { authorization: `Bearer ${token}` } });

async function setup() {
  await useFakeEnv({ ADMIN_EMAILS: ADMIN, CSM_EMAILS: `${CARLA},${DIEGO}`, PUBLIC_SITE_URL: "https://app.e2e-ilp.io", PUBLIC_API_URL: "https://api.e2e-ilp.io" });
  for (const k of ["DEFAULT_PROVIDER_ID", "SALES_EMAILS", "AUTH_COOKIES", "STAFF_EMAILS", "DEFAULT_CSM_EMAIL", "OWNER_EMAILS"]) Deno.env.delete(k);
  clearPlaceholderCache();
  world = installFakeWorld(NOW);
  app = new FakeApp();
  for (const m of ["../API/csm/csmRouter.ts", "../API/notifications/notificationsRouter.ts", "../API/members/membersRouter.ts", "../API/dashboard/dashboardRouter.ts"]) (await import(m)).default(app);
  for (const [tok, email] of [["carla", CARLA], ["diego", DIEGO], ["admin", ADMIN], ["staff", STAFF]]) {
    world.put("dashboard_sessions", tok, { email, expiresAt: "2030-01-01T00:00:00Z" });
  }
}

function member(id: string, csm: string | null, extra: { membership?: Record<string, unknown>; client?: Record<string, unknown> } = {}) {
  world.put("clients", id, { email: `${id}@mailbox-rt.io`, fullName: `Grace ${id.toUpperCase()} Whitfield`, phone: "+1 555 201 3344", nationality: "US", ...extra.client });
  world.put("memberships", `mem_${id}`, {
    id: `mem_${id}`, clientId: id, status: "active", country: "CR", plan: "standard", periodStart: iso(-10), periodEnd: iso(20),
    minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 1, paymentRef: "manual", createdAt: iso(-40), activatedAt: iso(-40),
    ...(csm ? { csmEmail: csm } : {}), ...extra.membership,
  });
}

const FULL_PROFILE = {
  fullName: "Grace Whitfield", email: "g@mailbox-rt.io", phone: "+1 555", nationality: "US", dateOfBirth: "1960-01-01", maritalStatus: "married", dependents: "0",
  residencyStatus: "temporary", residencyExpiresAt: "2027-03-01", ownsProperty: true, propertyLocation: "Atenas", hasCompany: false, companyType: "none", ownsVehicle: false,
};

// ─── Health score (pure) ──────────────────────────────────────────────────

const base: HealthInput = {
  membershipStatus: "active", completeness: 0.9, lastContactAt: iso(-3), activatedAt: iso(-60), periodStart: iso(-10), callsUsed: 1,
  lastRating: 5, lastNps: 9, deadlinesWithin14d: 0, deadlinesPast: 0, quotesWaiting5d: 0, lastActivityAt: iso(-2),
};

Deno.test("health: a well-looked-after member is Healthy at 100; every signal takes its points with a plain reason", () => {
  const now = new Date(NOW);
  const h = healthScore(base, now);
  assertEquals([h.score, h.band, h.label, h.reasons.length], [100, "healthy", "Healthy", 0]);
  const cases: Array<[Partial<HealthInput>, string, number]> = [
    [{ membershipStatus: "past_due" }, "payment_failed", 35],
    [{ cancelAtPeriodEnd: true }, "cancel_requested", 30],
    [{ membershipStatus: "pending" }, "payment_pending", 10],
    [{ completeness: 0.3 }, "profile_low", 20],
    [{ completeness: 0.55 }, "profile_not_ready", 12],
    [{ lastContactAt: iso(-31) }, "contact_30d", 15],
    [{ lastContactAt: iso(-15) }, "contact_14d", 8],
    [{ lastContactAt: null }, "never_contacted", 12],
    [{ callsUsed: 0, periodStart: iso(-22) }, "no_calls", 10],
    [{ lastRating: 2 }, "rating_low", 20],
    [{ lastRating: 3 }, "rating_mid", 6],
    [{ lastNps: 5 }, "nps_low", 15],
    [{ lastNps: 8 }, "nps_mid", 5],
    [{ deadlinesWithin14d: 1 }, "deadlines_14d", 5],
    [{ deadlinesWithin14d: 4 }, "deadlines_14d", 10],
    [{ deadlinesPast: 2 }, "deadlines_past", 10],
    [{ quotesWaiting5d: 3 }, "quotes_waiting", 10],
    [{ lastActivityAt: iso(-45) }, "inactive_30d", 10],
  ];
  for (const [patch, code, points] of cases) {
    const r = healthScore({ ...base, ...patch }, now);
    assertEquals(r.reasons.map((x) => [x.code, x.points]), [[code, points]], code);
    assertEquals(r.score, 100 - points, code);
    for (const x of r.reasons) assert(x.text.length > 5 && !DASHES.test(x.text), x.text);
  }
  // Not yet two days in: no "never contacted". Calls used: no penalty early in the period.
  assertEquals(healthScore({ ...base, lastContactAt: null, activatedAt: iso(-1), lastActivityAt: null }, now).reasons, []);
  assertEquals(healthScore({ ...base, callsUsed: 0, periodStart: iso(-5) }, now).score, 100);
});

Deno.test("health: bands, reasons biggest first, floor at 0, ended memberships have no score", () => {
  const now = new Date(NOW);
  const r = healthScore({ ...base, membershipStatus: "past_due", lastRating: 1, completeness: 0.2, lastContactAt: iso(-40), lastNps: 2, deadlinesPast: 1, quotesWaiting5d: 2, lastActivityAt: iso(-50) }, now);
  assertEquals(r.score, 0);
  assertEquals(r.band, "at_risk");
  assertEquals(r.reasons[0].code, "payment_failed");
  assert(r.reasons.every((x, i) => i === 0 || r.reasons[i - 1].points >= x.points));
  assertEquals([bandFor(75).label, bandFor(74).label, bandFor(50).label, bandFor(49).label], ["Healthy", "Watch", "Watch", "At risk"]);
  assertEquals(healthScore({ ...base, membershipStatus: "cancelled" }, now), { score: null, band: "ended", label: "Ended", reasons: [] });
  const asked = healthScore({ ...base, cancelAtPeriodEnd: true, completeness: 0.5 }, now); // 100 - 30 - 12
  assertEquals([asked.score, asked.label], [58, "Watch"]);
});

Deno.test("first contact SLA: one business day, weekends skipped (Costa Rica time)", () => {
  assertEquals(firstContactDueAt("2026-11-03T15:00:00.000Z"), "2026-11-04T15:00:00.000Z"); // Tue → Wed
  assertEquals(firstContactDueAt("2026-11-06T15:00:00.000Z"), "2026-11-09T15:00:00.000Z"); // Fri → Mon
  assertEquals(firstContactDueAt("2026-11-07T15:00:00.000Z"), "2026-11-09T15:00:00.000Z"); // Sat → Mon
  assertEquals(firstContactDueAt("nope"), null);
});

// ─── Role scoping ─────────────────────────────────────────────────────────

Deno.test("scope (pure): a CSM reads their own book only; staff and admins pick any CSM", () => {
  assertEquals(resolveScope(CARLA, "csm", {}), { ok: true, scope: { viewer: CARLA, role: "csm", csm: CARLA, includeUnassigned: false } });
  const denied = resolveScope(CARLA, "csm", { csm: DIEGO });
  assert(!denied.ok && denied.status === 403);
  assertEquals(resolveScope(CARLA, "csm", { csm: CARLA.toUpperCase(), unassigned: "1" }).ok, true);
  const staff = resolveScope(ADMIN, "admin", { csm: DIEGO });
  assert(staff.ok && staff.scope.csm === DIEGO);
  assertEquals([mayOpenMember("csm", CARLA, CARLA), mayOpenMember("csm", CARLA, ""), mayOpenMember("csm", CARLA, DIEGO), mayOpenMember("csm", CARLA, null), mayOpenMember("staff", STAFF, DIEGO)], [true, true, false, false, true]);
});

Deno.test("routes: a CSM cannot read another CSM's member by id, list their book or act on them; staff can open any book with ?csm=", async () => {
  await setup();
  try {
    member("m1", CARLA);
    member("m2", DIEGO);
    member("m3", null);
    // Carla's book has m1 only; with unassigned it adds m3; never m2.
    let r = await call("carla", "GET", "/api/csm/book");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.items.map((x: { clientId: string }) => x.clientId), ["m1"]);
    r = await call("carla", "GET", "/api/csm/book?unassigned=1&limit=10");
    assertEquals(r.body.items.map((x: { clientId: string }) => x.clientId).sort(), ["m1", "m3"]);
    assert(r.body.schema, "list contract carries the schema");
    r = await call("carla", "GET", `/api/csm/book?csm=${encodeURIComponent(DIEGO)}`);
    assertEquals(r.status, 403);
    // By id: CSM routes and the reused staff member page both refuse m2.
    for (const url of ["/api/csm/members/m2", "/api/staff/members/m2", "/api/dashboard/staff/members/m2/timeline"]) {
      r = await call("carla", "GET", url);
      assertEquals(r.status, 403, url);
      assertEquals(r.body.code, "csm_scope", url);
    }
    r = await call("carla", "POST", "/api/csm/members/m2/contacts", { channel: "call", summary: "Called about the renewal." });
    assertEquals(r.status, 403);
    r = await call("carla", "POST", "/api/csm/members/m2/email", { playbookId: "renewal" });
    assertEquals(r.status, 403);
    // Own and unassigned members open.
    for (const url of ["/api/csm/members/m1", "/api/staff/members/m1", "/api/csm/members/m3"]) {
      r = await call("carla", "GET", url);
      assertEquals(r.status, 200, `${url} ${JSON.stringify(r.body)}`);
    }
    // A task on m2 cannot be closed by Carla.
    world.put("csm_tasks", "t2", { id: "t2", clientId: "m2", ownerEmail: DIEGO, type: "follow_up", title: "Call Grace", dueAt: iso(1), status: "open", source: { kind: "manual" }, createdAt: iso(-1) });
    r = await call("carla", "POST", "/api/csm/tasks/t2/close", { outcome: "Done" });
    assertEquals(r.status, 403);
    // Staff and admins: any CSM's book, any member.
    r = await call("admin", "GET", `/api/csm/book?csm=${encodeURIComponent(DIEGO)}`);
    assertEquals(r.body.items.map((x: { clientId: string }) => x.clientId), ["m2"]);
    r = await call("staff", "GET", "/api/staff/members/m2");
    assertEquals(r.status, 200);
    r = await call("admin", "GET", "/api/csm/me");
    assertEquals([r.body.canSwitch, r.body.csms.includes(DIEGO)], [true, true]);
    r = await call("carla", "GET", "/api/csm/me");
    assertEquals([r.body.canSwitch, r.body.csms], [false, [CARLA]]);
    // Taking an unassigned member moves it into the book and tells the CSM.
    r = await call("carla", "POST", "/api/csm/members/m3/take");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(world.doc("memberships", "mem_m3")!.csmEmail, CARLA);
    assert(world.doc("memberships", "mem_m3")!.csmAssignedAt);
    r = await call("diego", "POST", "/api/csm/members/m3/take");
    assertEquals(r.status, 403, "now in Carla's book");
    r = await call("carla", "GET", "/api/notifications");
    assert(r.body.items.some((n: { kind: string; title: string }) => n.kind === "member.assigned" && n.title === "New member in your book: Grace M3 Whitfield"));
  } finally {
    world.restore();
  }
});

// ─── Contacts, tasks and playbook emails ──────────────────────────────────

Deno.test("member actions: log a contact and close the task with its outcome; create a task; playbook emails follow the email classes", async () => {
  await setup();
  try {
    member("m1", CARLA);
    member("m4", CARLA, { client: { emailOptOut: true } });
    world.put("csm_tasks", "t1", { id: "t1", clientId: "m1", ownerEmail: CARLA, type: "onboarding", title: "Welcome call and profile review", dueAt: iso(-1), status: "open", source: { kind: "membership" }, createdAt: iso(-2) });
    assertEquals(parseContact({ channel: "fax", summary: "x" }).ok, false);
    assertEquals(parseContact({ channel: "call", summary: "" }).ok, false);
    assertEquals(parseContact({ channel: "call", summary: "Talked", at: iso(1) }, new Date(NOW)).ok, false);
    let r = await call("carla", "POST", "/api/csm/members/m1/contacts", { channel: "call", summary: "Welcome call. Profile reviewed; she uploads her DIMEX by Friday.", taskId: "t1", closeTask: "Welcome call done, DIMEX promised by Friday." });
    assertEquals(r.status, 201, JSON.stringify(r.body));
    assertEquals(world.doc("csm_tasks", "t1")!.status, "done");
    assertEquals(world.doc("csm_tasks", "t1")!.outcome, "Welcome call done, DIMEX promised by Friday.");
    const contact = world.all("csm_contacts")[0];
    assertEquals([contact.csmEmail, contact.bookCsmEmail, contact.channel, contact.reached], [CARLA, CARLA, "call", true]);
    // The contact shows on the staff timeline and resets "days since contact".
    r = await call("carla", "GET", "/api/dashboard/staff/members/m1/timeline");
    assert(r.body.items.some((e: { kind: string; title: string }) => e.kind === "contact" && e.title === "Call with the member"));
    r = await call("carla", "GET", "/api/csm/members/m1");
    assertEquals(r.body.row.daysSinceContact, 0);
    // A task Carla owns.
    r = await call("carla", "POST", "/api/csm/members/m1/tasks", { title: "Check the DIMEX upload", dueAt: iso(3) });
    assertEquals(r.status, 201);
    assertEquals([r.body.ownerEmail, r.body.source.kind, r.body.status], [CARLA, "manual", "open"]);
    r = await call("carla", "POST", `/api/csm/tasks/${r.body.id}/close`, { outcome: "" });
    assertEquals(r.status, 400, "outcome required");
    // Playbook emails: service email to m1 goes out once a day; to an opted-out member it is refused;
    // the payment email is transactional and still goes.
    r = await call("carla", "POST", "/api/csm/members/m1/email", { playbookId: "renewal" });
    assertEquals([r.status, r.body.sent, r.body.emailClass], [200, true, "service"]);
    r = await call("carla", "POST", "/api/csm/members/m1/email", { playbookId: "renewal" });
    assertEquals([r.status, r.body.blocked], [409, "already_sent"]);
    r = await call("carla", "POST", "/api/csm/members/m4/email", { playbookId: "welcome_call" });
    assertEquals([r.status, r.body.blocked], [409, "opted_out"]);
    r = await call("carla", "POST", "/api/csm/members/m4/email", { playbookId: "payment_failed" });
    assertEquals([r.status, r.body.emailClass], [200, "transactional"]);
    const mails = world.emails().filter((m) => String(m.to).includes("mailbox-rt.io"));
    assertEquals(mails.map((m) => m.subject).sort(), ["Your ILP membership renews on November 23, 2026", "Your ILP payment did not go through"]);
    for (const m of mails) {
      assert(!DASHES.test(m.subject + m.text), m.subject);
      assert(m.text.includes("Carla"), "signed with the CSM's name");
      assert(m.text.includes("not a law firm"), "legal footer");
    }
    assert(world.all("csm_contacts").some((c) => c.playbookId === "renewal" && c.channel === "email"));
  } finally {
    world.restore();
  }
});

Deno.test("playbooks: four defaults with steps, emails within the copy rules; edits validated; staff cannot edit", async () => {
  assertEquals(Object.keys(DEFAULT_PLAYBOOKS).sort(), [...CSM_PLAYBOOK_IDS].sort());
  for (const p of Object.values(DEFAULT_PLAYBOOKS)) {
    assert(p.steps.length >= 3 && p.steps.length <= 6, p.id);
    const text = [p.title, p.when, ...p.steps, p.email.subject, ...p.email.paragraphs].join(" ");
    assert(!DASHES.test(text), p.id);
    assert(!/journey|seamless|leverage|empower|crucial|!/i.test(text), p.id);
    const mail = renderPlaybookEmail(p, { firstName: "Grace", csmEmail: CARLA, periodEnd: "November 23, 2026", siteUrl: "https://app.e2e-ilp.io" });
    assert(!/\{\{/.test(mail.text + mail.subject), `${p.id} placeholders filled`);
  }
  assertEquals(validatePlaybookEmail({ subject: "", paragraphs: ["a"] }).ok, false);
  assertEquals(validatePlaybookEmail({ subject: "Hello — there", paragraphs: ["a"] }).ok, false);
  assertEquals(validatePlaybookEmail({ subject: "Hello", paragraphs: ["One.", "Two."] }).ok, true);
  await setup();
  try {
    let r = await call("staff", "PUT", "/api/csm/playbooks/renewal", { subject: "Hi", paragraphs: ["Text."] });
    assertEquals(r.status, 403);
    r = await call("carla", "PUT", "/api/csm/playbooks/renewal", { subject: "Your renewal on {{periodEnd}}", paragraphs: ["Short note."] });
    assertEquals([r.status, r.body.edited, r.body.email.subject], [200, true, "Your renewal on {{periodEnd}}"]);
    r = await call("carla", "GET", "/api/csm/playbooks");
    assertEquals(r.body.items.find((p: { id: string }) => p.id === "renewal").email.paragraphs, ["Short note."]);
    r = await call("carla", "POST", "/api/csm/playbooks/renewal/reset");
    assertEquals(r.body.email.subject, DEFAULT_PLAYBOOKS.renewal.email.subject);
  } finally {
    world.restore();
  }
});

// ─── Notifications ────────────────────────────────────────────────────────

Deno.test("bell (pure): channels per role; a CSM sees staff-wide items only about their own or unassigned members", () => {
  assertEquals(channelsFor({ role: "admin", id: ADMIN }), ["staff:*", `staff:${ADMIN}`, `csm:${ADMIN}`]);
  assertEquals(channelsFor({ role: "lawyer", id: "ANA" }), ["lawyer:ANA"]);
  const csm = { role: "csm" as const, id: CARLA, bookClientIds: new Set(["m1"]) };
  assertEquals(visibleTo({ to: "staff:*", clientId: "m1" }, csm), true);
  assertEquals(visibleTo({ to: "staff:*", clientId: "m2" }, csm), false);
  assertEquals(visibleTo({ to: "staff:*", clientId: "m3" }, csm, new Set(["m3"])), true);
  assertEquals(visibleTo({ to: "staff:*" }, csm), false);
  assertEquals(visibleTo({ to: `csm:${DIEGO}` }, csm), false);
  assertEquals(visibleTo({ to: "lawyer:ANA" }, { role: "staff", id: STAFF }), false);
});

Deno.test("notifications lifecycle: created from events, emailed only when urgent, unread count, mark read, read-all; each reader sees their own", async () => {
  await setup();
  try {
    member("m1", CARLA);
    member("m2", DIEGO);
    // Payment failed on Carla's member: her bell and an email to her now.
    await emitEvent("membership.past_due", { clientId: "m1", sourceId: "mem_m1", dedupeKey: "mem_m1_ep1", ownerEmail: CARLA });
    // Low rating on Diego's member: his bell, no email.
    await emitEvent("feedback.low_score", { clientId: "m2", sourceId: "fb1", ownerEmail: DIEGO });
    // Privacy request on Carla's member: her bell + email, and the staff bell.
    await emitEvent("privacy.request_received", { clientId: "m1", sourceId: "pr1", ownerEmail: CARLA });
    // The same event again: nothing new.
    await emitEvent("membership.past_due", { clientId: "m1", sourceId: "mem_m1", dedupeKey: "mem_m1_ep1", ownerEmail: CARLA });
    const csmMails = world.emails().filter((m) => String(m.to).includes(CARLA));
    assertEquals(csmMails.map((m) => m.subject).sort(), ["ILP: Payment failed: Grace M1 Whitfield", "ILP: Privacy request: Grace M1 Whitfield"]);
    assertEquals(world.emails().filter((m) => String(m.to).includes(DIEGO)).length, 0, "low rating waits for the digest");
    let r = await call("carla", "GET", "/api/notifications/unread-count");
    assertEquals(r.body.unread, 2);
    r = await call("carla", "GET", "/api/notifications");
    assertEquals(r.body.items.map((n: { kind: string }) => n.kind).sort(), ["payment.failed", "privacy.request"]);
    assert(r.body.items.every((n: { link: string }) => n.link === "/csm/book/m1"));
    r = await call("diego", "GET", "/api/notifications");
    assertEquals(r.body.items.map((n: { kind: string }) => n.kind), ["member.low_score"]);
    r = await call("admin", "GET", "/api/notifications");
    assertEquals(r.body.items.map((n: { kind: string }) => n.kind), ["privacy.request"], "staff see the staff-wide copy, not CSM items");
    // Mark one read, then all.
    r = await call("carla", "GET", "/api/notifications");
    const first = r.body.items[0].id;
    r = await call("carla", "POST", "/api/notifications/read", { ids: [first] });
    assertEquals(r.body.marked, 1);
    r = await call("carla", "GET", "/api/notifications/unread-count");
    assertEquals(r.body.unread, 1);
    r = await call("carla", "POST", "/api/notifications/read", {});
    assertEquals(r.status, 400);
    r = await call("carla", "POST", "/api/notifications/read-all");
    assertEquals(r.body.marked, 1);
    r = await call("carla", "GET", "/api/notifications");
    assertEquals([r.body.unread, r.body.items.every((n: { read: boolean }) => n.read)], [0, true]);
    // Carla's reads do not touch Diego's count.
    r = await call("diego", "GET", "/api/notifications/unread-count");
    assertEquals(r.body.unread, 1);
    // Diego cannot mark Carla's items.
    r = await call("diego", "POST", "/api/notifications/read", { ids: [first] });
    assertEquals(r.body.marked, 0);
  } finally {
    world.restore();
  }
});

// ─── Daily digest ─────────────────────────────────────────────────────────

Deno.test("digest: 08:00 Costa Rica schedule; overdue, due today, new members and risks; once a day; nothing to say means no email", async () => {
  assertEquals(CSM_DIGEST_CRON, "0 14 * * *");
  assertEquals(jobs.find((j) => j.name === "csmDailyDigest")?.cron, "0 14 * * *");
  await setup();
  try {
    member("m1", CARLA, { client: FULL_PROFILE });
    member("m5", CARLA, { membership: { activatedAt: iso(-0.5), createdAt: iso(-0.5), csmAssignedAt: iso(-0.5) }, client: FULL_PROFILE });
    member("m6", CARLA, { membership: { status: "past_due", pastDueSince: iso(-2) } });
    world.put("csm_contacts", "c1", { id: "c1", clientId: "m1", csmEmail: CARLA, bookCsmEmail: CARLA, channel: "call", direction: "outbound", reached: true, summary: "Check-in", at: iso(-2), createdAt: iso(-2) });
    world.put("csm_tasks", "t1", { id: "t1", clientId: "m1", ownerEmail: CARLA, type: "follow_up", title: "Send next steps", dueAt: iso(-1), status: "open", source: { kind: "handoff" }, createdAt: iso(-3) });
    world.put("csm_tasks", "t2", { id: "t2", clientId: "m5", ownerEmail: CARLA, type: "onboarding", title: "Welcome call and profile review", dueAt: "2026-11-03T22:00:00.000Z", status: "open", source: { kind: "membership" }, createdAt: iso(-0.5) });
    // Diego's book is calm: nothing overdue, nothing new, nobody at risk.
    member("m2", DIEGO, { client: FULL_PROFILE });
    world.put("csm_contacts", "c2", { id: "c2", clientId: "m2", csmEmail: DIEGO, bookCsmEmail: DIEGO, channel: "call", direction: "outbound", reached: true, summary: "Check-in", at: iso(-3), createdAt: iso(-3) });
    const out = await csmDailyDigest(new Date(NOW));
    assertEquals([out.sent, out.empty], [1, 1]);
    const mails = world.emails().filter((m) => String(m.to) === CARLA);
    assertEquals(mails.length, 1);
    const m = mails[0];
    assertEquals(m.subject, "ILP today: 1 overdue, 1 due today, 1 new member, 1 member at risk");
    for (const needle of ["Overdue", "Send next steps (Grace Whitfield)", "Due today", "Welcome call and profile review (Grace Whitfield)", "New in your book", "At risk", "Grace M6 Whitfield, health", "Payment failed", "https://app.e2e-ilp.io/csm/book/m6", "Open Today in the CSM portal"]) {
      assert(m.text.includes(needle), `${needle}\n${m.text}`);
    }
    assert(!DASHES.test(m.subject + m.text));
    assert(!m.text.includes("mailbox-rt.io"), "no member email addresses");
    assertEquals(world.emails().filter((x) => String(x.to) === DIEGO).length, 0, "empty digest skipped");
    // Same day again: nothing new.
    const again = await csmDailyDigest(new Date(Date.parse(NOW) + 3_600_000));
    assertEquals(again.already, 1);
    assertEquals(world.emails().filter((x) => String(x.to) === CARLA).length, 1);
  } finally {
    world.restore();
  }
});

Deno.test("digest (pure): sections are capped with a count of the rest; empty when nothing is due, new or at risk", () => {
  const now = new Date(NOW);
  const rows = bookRows({ memberships: [], clients: new Map(), openTasks: [], obligations: [], feedback: [], contacts: [] }, now);
  const empty = buildDigest({ today: todayView(rows, [], CARLA, now), rows, memberships: [], now, site: "https://x" });
  assertEquals([empty.empty, empty.summary], [true, ""]);
  const tasks = Array.from({ length: 11 }, (_, i) => ({ id: `t${i}`, clientId: "m1", ownerEmail: CARLA, type: "follow_up" as const, title: `Task ${i}`, dueAt: iso(-1 - i), status: "open" as const, source: { kind: "manual" as const }, createdAt: iso(-20) }));
  const d = buildDigest({ today: todayView(rows, tasks, CARLA, now), rows, memberships: [], now, site: "https://x" });
  assertEquals([d.overdue.lines.length, d.overdue.more, d.summary], [8, 3, "11 overdue"]);
});

// ─── Seed ─────────────────────────────────────────────────────────────────

Deno.test("seed: placeholder CSM books are filled once, real memberships never touched, every fifth left unassigned", () => {
  assert(PLACEHOLDER_CSMS.length >= 2 && PLACEHOLDER_CSMS.every((e) => e.endsWith("@example.com")));
  const ms = Array.from({ length: 10 }, (_, i) => ({ id: `ph_mem_${i}`, clientId: `ph_cli_${i}`, status: "active", placeholder: true }));
  ms.push({ id: "mem_real", clientId: "real", status: "active" } as typeof ms[number]);
  ms.push({ id: "ph_mem_kept", clientId: "ph_cli_kept", status: "active", placeholder: true, csmEmail: "kevin.araya@example.com" } as typeof ms[number]);
  const now = new Date(NOW);
  const plan = planCsmSeed(ms, [], [], now);
  assert(!plan.assign.some((a) => a.membershipId === "mem_real" || a.membershipId === "ph_mem_kept"));
  // 11 placeholder memberships: ph_mem_4 and ph_mem_9 stay unassigned, ph_mem_kept keeps its CSM.
  assertEquals(plan.assign.map((a) => a.membershipId), ["ph_mem_0", "ph_mem_1", "ph_mem_2", "ph_mem_3", "ph_mem_5", "ph_mem_6", "ph_mem_7", "ph_mem_8"]);
  assert(plan.contacts.every((c) => c.id.startsWith("ph_ctc_") && c.placeholder === true && !c.clientId.startsWith("real")));
  assert(plan.notifications.every((n) => n.id.startsWith("ph_nt_") && n.placeholder === true && n.to.startsWith("csm:")));
  // Second run over the written state: nothing new.
  const written = ms.map((m) => ({ ...m, csmEmail: (m as Record<string, unknown>).csmEmail ?? plan.assign.find((a) => a.membershipId === m.id)?.csmEmail }));
  const again = planCsmSeed(written, plan.contacts as unknown as Record<string, unknown>[], plan.notifications as unknown as Record<string, unknown>[], now);
  assertEquals([again.assign.length, again.contacts.length, again.notifications.length], [0, 0, 0]);
});
