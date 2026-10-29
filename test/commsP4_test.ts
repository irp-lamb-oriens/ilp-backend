// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { clearPlaceholderCache } from "../helper/placeholder.ts";
import { EMAIL_FOOTER } from "../helper/emailTemplates.ts";
import { issueOtp, verifyOtp } from "../helper/auth/otp.ts";
import { LOCKOUT_PORTALS, lockoutKey } from "../helper/auth/lockout.ts";
import { TASK_RULES } from "../schemas/contracts.ts";
import {
  bankLines,
  DOC_WORDS,
  maybeSendProfileReady,
  missingDocuments,
  paymentReference,
  quoteReminderSweep,
  quotesToRemind,
  ratingRequestDue,
  ratingRequests,
  sendManualPaymentInstructions,
  sendMembershipEnded,
} from "../API/retention/closingLoops.ts";
import { DEFAULT_BANK_INFO } from "../API/dashboard/automation/bankInfo.ts";
import { installLifecycleEmailHooks } from "../API/retention/lifecycleEmails.ts";
import { markCancelled } from "../API/payments/lifecycle.ts";
import { activateMembership } from "../API/payments/membership.ts";
import { assignMember } from "../API/members/assignment.ts";
import { autoAssignCsm, csmPool, pickCsm } from "../API/csm/autoAssign.ts";
import { dropAlreadySent, emailedQuote, withoutPendingQuoteReady, type EmailSuggestion } from "../API/dashboard/emailSuggestions.ts";
import { bridgedId, planBridge, stagesFromOldOffsets } from "../API/members/legacyDeadlines.ts";
import { deadlineReminderSweep } from "../jobs/deadlineReminderSweep.ts";
import { deadlineFollowupSweep } from "../jobs/deadlineFollowup.ts";
import { obligationPush, obligationPushBody, retentionMessagesSweep } from "../API/retention/retentionMessages.ts";

/**
 * COMMS-P4: member closing loops. One test (or more) per message: trigger,
 * recipient, class, dedupe, content. Plus the CSM auto-assignment, the
 * quote_ready suggestion after "Send to client", and the unified deadline
 * reminders (client-record dates bridged into obligations: one email per
 * date and stage, push follows, no duplicates).
 * Run: deno test --allow-env --allow-read test/commsP4_test.ts
 */

const NOW = "2026-11-03T15:00:00.000Z"; // Tuesday Nov 3, 09:00 Costa Rica
const DAY = 86_400_000;
const HOUR = 3_600_000;
const CARLA = "carla@internationallegalpartner.com";
const DIEGO = "diego@internationallegalpartner.com";
const ADMIN = "oriens@internationallegalpartner.com";
const DASHES = /—|–/;
const FOOT = "not a law firm";

let world: FakeWorld;
let app: FakeApp;

const iso = (offsetDays: number) => new Date(Date.parse(NOW) + offsetDays * DAY).toISOString();
const call = (token: string | null, method: string, url: string, body?: unknown) =>
  app.call(method, url, { body, headers: token ? { authorization: `Bearer ${token}` } : {} });
const mails = (to?: string) => world.emails().filter((m) => !to || String(m.to).includes(to));
const bySubject = (re: RegExp) => world.emails().filter((m) => re.test(String(m.subject)));

async function setup(env: Record<string, string> = {}, routers: string[] = []) {
  await useFakeEnv({
    ADMIN_EMAILS: ADMIN, CSM_EMAILS: `${CARLA},${DIEGO}`, PAYMENTS_MODE: "manual",
    PUBLIC_SITE_URL: "https://app.e2e-ilp.io", PUBLIC_API_URL: "https://api.e2e-ilp.io", FRONTEND_URL: "https://app.e2e-ilp.io", ...env,
  });
  for (const k of ["DEFAULT_PROVIDER_ID", "SALES_EMAILS", "AUTH_COOKIES", "STAFF_EMAILS", "DEFAULT_CSM_EMAIL", "PAYMENTS_DEMO_AUTOPAY", "RENDER_EXTERNAL_URL", "CSM_AUTO_ASSIGN"]) {
    if (!(k in env)) Deno.env.delete(k);
  }
  clearPlaceholderCache();
  world = installFakeWorld(NOW);
  app = new FakeApp();
  for (const m of routers) (await import(m)).default(app);
  world.put("dashboard_sessions", "admin", { email: ADMIN, expiresAt: "2030-01-01T00:00:00Z" });
}

function lawyer(id: string) {
  world.put("providers", id, { name: `${id} Mora`, email: `${id.toLowerCase()}@lawyers-rt.io`, status: "active", active: true, jurisdictions: ["CR"], legalAreas: ["immigration"] });
  world.put("lawyer_availability", id, { id, providerId: id, timezone: "America/Costa_Rica", weekly: [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "12:00" })), blackoutDates: [], minLeadHours: 0, maxCallsPerDay: 6, specialties: [] });
  world.put("provider_sessions", `law_${id}`, { email: `${id.toLowerCase()}@lawyers-rt.io`, providerId: id, expiresAt: "2030-01-01T00:00:00Z" });
}

function member(id: string, opts: { client?: Record<string, unknown>; membership?: Record<string, unknown> } = {}) {
  world.put("clients", id, { email: `${id}@mailbox-rt.io`, fullName: `Grace ${id.toUpperCase()} Whitfield`, legalCountry: "CR", jurisdiction: "Costa Rica", ...opts.client });
  world.put("memberships", `mem_${id}`, {
    id: `mem_${id}`, clientId: id, status: "active", country: "CR", plan: "standard", periodStart: iso(-10), periodEnd: iso(20),
    minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, paymentRef: "manual", createdAt: iso(-40), activatedAt: iso(-40), csmEmail: CARLA,
    ...opts.membership,
  });
  world.put("client_status_sessions", `cli_${id}`, { email: `${id}@mailbox-rt.io`, projectId: id, createdAt: NOW, expiresAt: iso(7) });
}

function checkCopy(m: Record<string, any>) {
  assert(!DASHES.test(m.subject + m.html + (m.text ?? "")), `no dashes: ${m.subject}`);
}

// ─── Manual payment instructions ──────────────────────────────────────────

Deno.test("manual payment: join in manual mode emails the amount and reference once; placeholder bank details are never shown", async () => {
  await setup({}, ["../API/payments/paymentsRouter.ts"]);
  try {
    const body = { email: "newbie@mailbox-rt.io", fullName: "Nora Newbie", country: "CR", acceptTerms: true, acceptPrivacy: true };
    const r = await call(null, "POST", "/api/payments/join", body);
    assertEquals(r.status, 201, JSON.stringify(r.body));
    const m = world.all("memberships")[0];
    const sent = mails("newbie@mailbox-rt.io");
    assertEquals(sent.length, 1);
    assertEquals(sent[0].subject, "How to pay for your ILP membership");
    assert(sent[0].html.includes("US$179.99") && sent[0].html.includes("US$100.00") && sent[0].html.includes("US$79.99"));
    assert(sent[0].html.includes(paymentReference(m.id)), "reference");
    assertEquals(world.doc("memberships", m.id)!.paymentReference, paymentReference(m.id));
    assert(sent[0].html.includes("bank details by email within one business day"), "no fake account numbers");
    assert(!sent[0].html.includes("000000000"), "placeholder account never shown");
    assert(sent[0].html.includes(FOOT));
    checkCopy(sent[0]);
    // A retried join reuses the pending membership: no second email.
    assertEquals((await call(null, "POST", "/api/payments/join", body)).status, 201);
    assertEquals(mails("newbie@mailbox-rt.io").length, 1);
    // Transactional: sent even when reminder emails are off; never for an active membership.
    world.put("clients", "opt", { email: "opt@mailbox-rt.io", fullName: "Opt Out", emailOptOut: true, marketingEmailConsent: false });
    assertEquals(await sendManualPaymentInstructions({ id: "mem_opt", clientId: "opt", status: "pending" }), true);
    assertEquals(await sendManualPaymentInstructions({ id: "mem_opt2", clientId: "opt", status: "active" }), false);
    // Bank lines: null for the seeded placeholders, listed once set.
    assertEquals(bankLines(DEFAULT_BANK_INFO), null);
    const real = { ...DEFAULT_BANK_INFO, beneficiary: { ...DEFAULT_BANK_INFO.beneficiary, accountNumber: "123456789" }, receivingBank: { ...DEFAULT_BANK_INFO.receivingBank, name: "First Bank", abaRoutingNumber: "026009593" } };
    assert(bankLines(real)!.includes("Account number: 123456789 (Checking)"));
  } finally {
    world.restore();
  }
});

// ─── No-show ───────────────────────────────────────────────────────────────

Deno.test("no-show: member told about minutes and rebooking, lawyer confirmation, CSM task and bell; once", async () => {
  await setup({}, ["../API/calls/callsRouter.ts"]);
  try {
    lawyer("L1");
    member("ns1");
    world.put("consultations", "c_ns1", { id: "c_ns1", clientId: "ns1", providerId: "L1", matterId: "mat_ns1", status: "booked", scheduledAt: new Date(Date.parse(NOW) - 15 * 60_000).toISOString(), durationMin: 20, createdAt: iso(-3) });
    const r = await call("law_L1", "POST", "/api/provider/consultations/c_ns1/no-show");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const m = mails("ns1@mailbox-rt.io");
    assertEquals(m.length, 1);
    assertEquals(m[0].subject, "We missed you on your ILP call");
    assert(m[0].html.includes("20 minutes and one call") && m[0].html.includes("40 minutes and 2 calls left"), m[0].text);
    assert(m[0].html.includes("https://app.e2e-ilp.io/status/book") && m[0].html.includes("L1 Mora"));
    assert(m[0].html.includes(FOOT));
    checkCopy(m[0]);
    const l = mails("l1@lawyers-rt.io");
    assertEquals(l.length, 1);
    assert(l[0].subject.startsWith("No-show recorded: Grace NS1 Whitfield"), l[0].subject);
    assert(!l[0].html.includes("ns1@mailbox-rt.io"), "no member contact details to the lawyer");
    checkCopy(l[0]);
    const task = world.all("csm_tasks").find((t) => String(t.id).startsWith("task_consultation_no_show__c_ns1"));
    assert(task, "CSM task");
    assertEquals(task!.ownerEmail, CARLA);
    assert(String(task!.title).startsWith(TASK_RULES["consultation.no_show"].title));
    const bell = world.all("notifications").find((n) => n.kind === "call.no_show");
    assertEquals(bell?.to, `csm:${CARLA}`);
    // Pressed again: 409, nothing new.
    assertEquals((await call("law_L1", "POST", "/api/provider/consultations/c_ns1/no-show")).status, 409);
    assertEquals(world.emails().length, 2);
    assertEquals(world.all("notifications").filter((n) => n.kind === "call.no_show").length, 1);
  } finally {
    world.restore();
  }
});

// ─── Cancel undone, membership ended ──────────────────────────────────────

Deno.test("cancel undone: the member is told the membership continues (transactional, once per request)", async () => {
  await setup({}, ["../API/payments/paymentsRouter.ts"]);
  try {
    member("cu1", { client: { emailOptOut: true }, membership: { cancelAtPeriodEnd: true, cancelRequestedAt: iso(-1), cancelReason: "cost" } });
    const r = await call("cli_cu1", "POST", "/api/payments/me/cancel/undo");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const m = mails("cu1@mailbox-rt.io");
    assertEquals(m.length, 1, "sent although reminder emails are off");
    assertEquals(m[0].subject, "Your ILP membership continues");
    assert(m[0].html.includes("November 23, 2026") && m[0].html.includes("US$79.99"));
    checkCopy(m[0]);
    assertEquals((await call("cli_cu1", "POST", "/api/payments/me/cancel/undo")).status, 200);
    assertEquals(mails("cu1@mailbox-rt.io").length, 1, "nothing to undo the second time");
  } finally {
    world.restore();
  }
});

Deno.test("membership ended: member and assigned lawyer (email + bell), once; placeholder members never", async () => {
  await setup();
  try {
    installLifecycleEmailHooks();
    lawyer("L2");
    member("me1", { client: { assignedProviderId: "L2" } });
    const m0 = world.doc("memberships", "mem_me1")! as never;
    await markCancelled(m0, { uid: "system", email: "system", role: "system" }, "cancel at period end");
    const mm = mails("me1@mailbox-rt.io");
    assertEquals(mm.length, 1);
    assertEquals(mm[0].subject, "Your ILP membership has ended");
    assert(mm[0].html.includes("/status/privacy") && mm[0].html.includes("/pricing"));
    checkCopy(mm[0]);
    const lm = mails("l2@lawyers-rt.io");
    assertEquals(lm.length, 1);
    assertEquals(lm[0].subject, "Membership ended: Grace ME1 Whitfield");
    checkCopy(lm[0]);
    assertEquals(world.all("notifications").filter((n) => n.to === "lawyer:L2" && n.kind === "member.membership_ended").length, 1);
    await sendMembershipEnded(world.doc("memberships", "mem_me1") as never);
    assertEquals(world.emails().length, 2, "once each");
    // Placeholder member: nothing.
    member("ph_me2", { client: { assignedProviderId: "L2", placeholder: true }, membership: { placeholder: true } });
    world.put("clients", "ph_me2", { ...(world.doc("clients", "ph_me2") ?? {}), email: "ph_me2@example.com" });
    await sendMembershipEnded(world.doc("memberships", "mem_ph_me2") as never);
    assertEquals(world.emails().length, 2);
  } finally {
    world.restore();
  }
});

// ─── Invoice paid ──────────────────────────────────────────────────────────

Deno.test("invoice paid: receipt when the balance reaches zero (mark paid or last payment), once", async () => {
  await setup({}, ["../API/finance/invoicesRouter.ts"]);
  try {
    member("iv1");
    world.put("invoices", "inv1", { id: "inv1", invoiceNumber: "INV-0001", clientId: "iv1", clientName: "Grace Whitfield", clientEmail: "iv1@mailbox-rt.io", total: 500, payments: [], lineItems: [] });
    const r = await call("admin", "POST", "/api/finance/invoices/inv1/paid", { paid: true });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    const m = bySubject(/^Receipt: ILP invoice INV-0001 is paid$/);
    assertEquals(m.length, 1);
    assertEquals(m[0].to, "iv1@mailbox-rt.io");
    assert(m[0].html.includes("US$500.00") && m[0].html.includes("/status/money"));
    checkCopy(m[0]);
    await call("admin", "POST", "/api/finance/invoices/inv1/paid", { paid: true });
    assertEquals(bySubject(/^Receipt:/).length, 1, "already paid: no second receipt");
    // Payments: a partial payment sends nothing, the one that clears the balance sends the receipt.
    world.put("invoices", "inv2", { id: "inv2", invoiceNumber: "INV-0002", clientId: "iv1", clientEmail: "iv1@mailbox-rt.io", total: 300, payments: [], lineItems: [] });
    const pay = (amount: number, i: number) => ({ id: `p${i}`, date: NOW, amount, method: "wire", note: null, received: true });
    await call("admin", "POST", "/api/finance/invoices/inv2/payment", { payments: [pay(100, 1)] });
    assertEquals(bySubject(/INV-0002/).length, 0);
    await call("admin", "POST", "/api/finance/invoices/inv2/payment", { payments: [pay(100, 1), pay(200, 2)] });
    assertEquals(bySubject(/^Receipt: ILP invoice INV-0002 is paid$/).length, 1);
  } finally {
    world.restore();
  }
});

// ─── Rating request ────────────────────────────────────────────────────────

Deno.test("rating request: completed, unrated member call 2 h to 3 days old; service class; once", async () => {
  await setup();
  try {
    const base = { status: "completed", durationMin: 20 } as const;
    const now = new Date(NOW);
    const ended = (h: number) => new Date(now.getTime() - h * HOUR).toISOString();
    assertEquals(ratingRequestDue({ ...base, scheduledAt: ended(3), endedAt: ended(3) }, now), true);
    assertEquals(ratingRequestDue({ ...base, scheduledAt: ended(1), endedAt: ended(1) }, now), false, "too soon");
    assertEquals(ratingRequestDue({ ...base, scheduledAt: ended(80), endedAt: ended(80) }, now), false, "too old");
    assertEquals(ratingRequestDue({ ...base, scheduledAt: ended(3), endedAt: ended(3), rating: { score: 5, at: NOW } }, now), false, "rated");
    assertEquals(ratingRequestDue({ ...base, scheduledAt: ended(3), endedAt: ended(3), kind: "sales" }, now), false, "sales call");
    lawyer("L3");
    member("rr1");
    member("rr2", { client: { emailOptOut: true } });
    const c = (id: string, clientId: string) => ({ id, clientId, providerId: "L3", status: "completed", scheduledAt: ended(4), endedAt: ended(3), durationMin: 20 });
    const calls = [c("c_rr1", "rr1"), c("c_rr2", "rr2")] as never[];
    assertEquals(await ratingRequests(calls, now), 1);
    const m = mails("rr1@mailbox-rt.io");
    assertEquals(m[0].subject, "How was your ILP call?");
    assert(m[0].html.includes("L3 Mora") && m[0].html.includes("https://app.e2e-ilp.io/status") && m[0].html.includes("/api/retention/unsubscribe?c=rr1"));
    checkCopy(m[0]);
    assertEquals(mails("rr2@mailbox-rt.io").length, 0, "service: the reminder unsubscribe stops it");
    assertEquals(await ratingRequests(calls, now), 0, "once per call");
  } finally {
    world.restore();
  }
});

// ─── Missing document ──────────────────────────────────────────────────────

Deno.test("missing document: client step naming a document, 3 days, nothing uploaded since: email with upload link + CSM task, once", async () => {
  await setup();
  try {
    assert(DOC_WORDS.test("Upload a copy of your passport") && !DOC_WORDS.test("Think about the dates"));
    const now = new Date(NOW);
    const matter = (id: string, setDaysAgo: number, what = "Upload a copy of your passport", who = "client") => ({
      id, clientId: "md1", country: "CR", title: "DIMEX renewal", area: "immigration", stage: "docs", stageEnteredAt: iso(-20), openedAt: iso(-20),
      nextStep: { what, who }, nextStepSetAt: iso(-setDaysAgo),
    });
    assertEquals(missingDocuments([matter("a", 4) as never], [], [], now).length, 1);
    assertEquals(missingDocuments([matter("a", 2) as never], [], [], now).length, 0, "not 3 days yet");
    assertEquals(missingDocuments([matter("a", 4, "Wait for the registry", "client") as never], [], [], now).length, 0, "no document named");
    assertEquals(missingDocuments([matter("a", 4, "Upload the deed", "lawyer") as never], [], [], now).length, 0, "lawyer's step");
    assertEquals(missingDocuments([matter("a", 4) as never], [], [{ uploadedAt: iso(-1) }], now).length, 0, "uploaded since");

    member("md1");
    world.put("matters", "mat_md1", matter("mat_md1", 4));
    await retentionMessagesSweep(now);
    const m = bySubject(/^A document is still needed/);
    assertEquals(m.length, 1);
    assertEquals(m[0].to, "md1@mailbox-rt.io");
    assert(m[0].html.includes("https://app.e2e-ilp.io/status/profile#documents") && m[0].html.includes("Upload a copy of your passport"));
    assert(m[0].html.includes("/api/retention/unsubscribe?c=md1"), "service email: reminder unsubscribe link");
    checkCopy(m[0]);
    const task = world.all("csm_tasks").find((t) => String(t.id).startsWith("task_document_missing_3d__mat_md1"));
    assertEquals(task?.ownerEmail, CARLA);
    await retentionMessagesSweep(new Date(Date.parse(NOW) + DAY));
    assertEquals(bySubject(/^A document is still needed/).length, 1, "once per request");
  } finally {
    world.restore();
  }
});

// ─── Quote unanswered 5 days ───────────────────────────────────────────────

Deno.test("quote reminder: waiting 5 to 30 days, one reminder per quote, links to Money", async () => {
  await setup();
  try {
    const now = new Date(NOW);
    const q = (id: string, days: number, status = "sent_to_client") => ({ quoteId: id, title: `Quote ${id}`, status, sentToClientAt: iso(-days) });
    assertEquals(quotesToRemind([q("a", 6), q("b", 2), q("c", 40), q("d", 6, "client_accepted"), q("e", 6, "draft")], now).map((x) => x.key), ["a"]);
    member("qr1", { client: { quotes: [q("q1", 6), q("q2", 1)] } });
    member("qr2", { client: { emailOptOut: true, quotes: [q("q3", 6)] } });
    assertEquals(await quoteReminderSweep(now), 1);
    const m = mails("qr1@mailbox-rt.io");
    assertEquals(m.length, 1);
    assertEquals(m[0].subject, "Your quote is waiting: Quote q1");
    assert(m[0].html.includes("/status/money") && m[0].html.includes("October 28, 2026"));
    checkCopy(m[0]);
    assertEquals(await quoteReminderSweep(now), 0, "once per quote");
    assertEquals(mails("qr2@mailbox-rt.io").length, 0);
  } finally {
    world.restore();
  }
});

// ─── First lawyer assigned ─────────────────────────────────────────────────

Deno.test("lawyer assigned: the member hears about their first lawyer once; not on reassignment or before paying", async () => {
  await setup();
  try {
    lawyer("L4");
    lawyer("L5");
    member("la1");
    await assignMember("la1", "L4", { email: "system", role: "system" });
    const m = bySubject(/is your ILP lawyer$/);
    assertEquals(m.length, 1);
    assertEquals(m[0].to, "la1@mailbox-rt.io");
    assertEquals(m[0].subject, "L4 Mora is your ILP lawyer");
    assert(m[0].html.includes("licensed in Costa Rica") && m[0].html.includes("/status/book"));
    checkCopy(m[0]);
    await assignMember("la1", "L5", { email: "staff@internationallegalpartner.com", role: "staff" });
    assertEquals(bySubject(/is your ILP lawyer$/).length, 1, "reassignment: not the first lawyer");
    member("la2", { membership: { status: "pending" } });
    await assignMember("la2", "L4", { email: "system", role: "system" });
    assertEquals(mails("la2@mailbox-rt.io").filter((x) => /is your ILP lawyer/.test(x.subject)).length, 0, "not paid yet");
  } finally {
    world.restore();
  }
});

// ─── Profile ready ─────────────────────────────────────────────────────────

Deno.test("profile ready: book your first call once, only for active members with no call yet", async () => {
  await setup();
  try {
    member("pr1");
    assertEquals(await maybeSendProfileReady("pr1"), true);
    const m = mails("pr1@mailbox-rt.io");
    assertEquals(m[0].subject, "Your profile is ready: book your first call");
    assert(m[0].html.includes("3 calls of 20 minutes") && m[0].html.includes("/status/book") && m[0].html.includes("/api/retention/unsubscribe?c=pr1"));
    checkCopy(m[0]);
    assertEquals(await maybeSendProfileReady("pr1"), false, "once per membership");
    member("pr2");
    world.put("consultations", "c_pr2", { id: "c_pr2", clientId: "pr2", providerId: "L1", status: "booked", scheduledAt: iso(2), durationMin: 20 });
    assertEquals(await maybeSendProfileReady("pr2"), false, "already booked");
    member("pr3", { membership: { status: "pending" } });
    assertEquals(await maybeSendProfileReady("pr3"), false, "not active");
  } finally {
    world.restore();
  }
});

// ─── Lockout ───────────────────────────────────────────────────────────────

Deno.test("lockout: the fifth wrong code blocks the code and emails recovery steps, once a day per portal", async () => {
  await setup();
  try {
    const email = "lock@mailbox-rt.io";
    const wrongTimes = async (col: string, id: string, n: number) => {
      for (let i = 0; i < n; i++) await verifyOtp(col, id, "000000x");
    };
    assert((await issueOtp("client_status_otps", "p1__lock", email)).ok);
    await wrongTimes("client_status_otps", "p1__lock", 4);
    assertEquals(world.emails().length, 0, "4 wrong codes: no email");
    const fifth = await verifyOtp("client_status_otps", "p1__lock", "000000x");
    assertEquals(fifth.ok, false);
    const m = mails(email);
    assertEquals(m.length, 1);
    assertEquals(m[0].subject, "Your ILP sign-in code was blocked");
    assert(m[0].html.includes("your ILP home") && m[0].html.includes("https://app.e2e-ilp.io/status") && m[0].html.includes("ask for a new code"));
    checkCopy(m[0]);
    // Again the same day (a new code, 5 more wrong tries): no second email.
    world.advance(60_000);
    assert((await issueOtp("client_status_otps", "p1__lock", email)).ok);
    await wrongTimes("client_status_otps", "p1__lock", 5);
    assertEquals(mails(email).length, 1);
    // Other portals: their own sign-in page.
    assert((await issueOtp("provider_otps", "lockl", "lawyer-lock@lawyers-rt.io")).ok);
    await wrongTimes("provider_otps", "lockl", 5);
    const l = mails("lawyer-lock@lawyers-rt.io");
    assert(l[0].html.includes("the ILP lawyer portal") && l[0].html.includes("https://app.e2e-ilp.io/lawyer"));
    assertEquals(LOCKOUT_PORTALS.dashboard_otps.path, "/dashboard");
    assert(lockoutKey("dashboard_otps", "A@B.io", new Date(NOW)).endsWith("2026-11-03"));
  } finally {
    world.restore();
  }
});

// ─── CSM auto-assignment ───────────────────────────────────────────────────

Deno.test("CSM auto-assign: pool, smallest book, round-robin ties, production skips placeholders", () => {
  assertEquals(csmPool("A@x.io, b@x.io;ph@example.com", false), ["a@x.io", "b@x.io", "ph@example.com"]);
  assertEquals(csmPool("A@x.io, b@x.io;ph@example.com", true), ["a@x.io", "b@x.io"]);
  const pool = ["a@x.io", "b@x.io", "c@x.io"];
  assertEquals(pickCsm(pool, new Map([["a@x.io", 3], ["b@x.io", 1], ["c@x.io", 2]])), "b@x.io");
  assertEquals(pickCsm(pool, new Map(), null), "a@x.io");
  assertEquals(pickCsm(pool, new Map(), "a@x.io"), "b@x.io");
  assertEquals(pickCsm(pool, new Map(), "c@x.io"), "a@x.io");
  assertEquals(pickCsm([], new Map()), null);
});

Deno.test("CSM auto-assign on activation: smallest book gets the member, bell item, onboarding task owner; switch off; manual CSM kept", async () => {
  await setup();
  try {
    // Carla already has two members, Diego none.
    member("bk1");
    member("bk2");
    world.put("clients", "aa1", { email: "aa1@mailbox-rt.io", fullName: "Alma Aa", legalCountry: "CR" });
    world.put("memberships", "mem_aa1", { id: "mem_aa1", clientId: "aa1", status: "pending", country: "CR", plan: "standard", periodStart: NOW, periodEnd: iso(30), minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, createdAt: NOW });
    await activateMembership("mem_aa1", "manual:test", { uid: ADMIN, email: ADMIN, role: "staff" });
    const mem = world.doc("memberships", "mem_aa1")!;
    assertEquals(mem.csmEmail, DIEGO);
    assertEquals(mem.csmAutoAssigned, true);
    assert(world.all("notifications").some((n) => n.to === `csm:${DIEGO}` && n.kind === "member.assigned"), "bell for the CSM");
    const onboarding = world.all("csm_tasks").find((t) => String(t.id).startsWith("task_membership_activated__mem_aa1"));
    assertEquals(onboarding?.ownerEmail, DIEGO);
    // A membership that already has a CSM keeps it.
    assertEquals(await autoAssignCsm({ ...(world.doc("memberships", "mem_bk1") as Record<string, unknown>), csmEmail: CARLA } as never), null);
    // Switched off.
    Deno.env.set("CSM_AUTO_ASSIGN", "false");
    world.put("memberships", "mem_aa2", { id: "mem_aa2", clientId: "aa1", status: "active", createdAt: NOW });
    assertEquals(await autoAssignCsm(world.doc("memberships", "mem_aa2") as never), null);
    assertEquals(world.doc("memberships", "mem_aa2")!.csmEmail, undefined);
  } finally {
    Deno.env.delete("CSM_AUTO_ASSIGN");
    world.restore();
  }
});

// ─── quote_ready after "Send to client" ───────────────────────────────────

Deno.test("quote_ready suggestion: left out when Send to client already emailed the quote; cleared when it emails one", () => {
  const sug = (emailType: string): EmailSuggestion => ({ suggestionId: emailType, emailType, triggeredByStage: "quote_sent", suggestedAt: NOW, movedByActor: ADMIN, status: "pending" });
  const emailed = { quotes: [{ quoteId: "q1", status: "sent_to_client", sentToClientAt: iso(-1) }] };
  assertEquals(emailedQuote(emailed), { quoteId: "q1", sentAt: iso(-1) });
  const r = dropAlreadySent([sug("quote_ready"), sug("other")], emailed);
  assertEquals(r.keep.map((s) => s.emailType), ["other"]);
  assertEquals(r.skipped[0].status, "sent");
  assertEquals(r.skipped[0].quoteId, "q1");
  // Not emailed yet (approved, or accepted already): the suggestion stays.
  assertEquals(dropAlreadySent([sug("quote_ready")], { quotes: [{ quoteId: "q2", status: "approved" }] }).keep.length, 1);
  assertEquals(dropAlreadySent([sug("quote_ready")], { quotes: [{ quoteId: "q3", status: "client_accepted", sentToClientAt: iso(-3) }] }).keep.length, 1);
  assertEquals(withoutPendingQuoteReady([{ status: "pending", emailType: "quote_ready" }, { status: "pending", emailType: "filing_started" }, { status: "dismissed", emailType: "quote_ready" }]).length, 2);
});

// ─── One reminder system ───────────────────────────────────────────────────

Deno.test("deadline bridge (pure): create, skip other country and already tracked, carry old reminders, follow date changes, dismiss on removal", () => {
  const now = new Date(NOW);
  const client = {
    id: "dl1", jurisdiction: "Costa Rica",
    deadlines: {
      dimex: { priorityId: "CR_RESIDENCY_DIMEX", date: "2026-11-20", remindedEmailOffsets: [60, 30] },
      pa: { priorityId: "PA_RESIDENCY_RENEWAL", date: "2026-12-01" },
      bad: { priorityId: "CR_RESIDENCY_DIMEX", date: "soon" },
    },
  };
  const plan = planBridge(client, [], now);
  assertEquals(plan.create.map((o) => o.id), [bridgedId("dl1", "dimex")]);
  const o = plan.create[0];
  assertEquals([o.dueAt, o.status, o.source, o.bridged, o.remindersSent], ["2026-11-20T12:00:00.000Z", "upcoming", "staff", true, ["30"]]);
  assert(plan.skipped.some((s) => s.key === "bad" && s.reason === "invalid"));
  assert(plan.skipped.some((s) => s.key === "pa" && (s.reason === "other_country" || s.reason === "unknown_priority")));
  // Already tracked by the member's own obligation (same rule, same day): not bridged.
  const own = { id: "obl_dl1_x", clientId: "dl1", country: "CR", ruleId: "CR_RESIDENCY_DIMEX", title: "DIMEX", dueAt: "2026-11-20T06:00:00.000Z", status: "upcoming" } as never;
  assertEquals(planBridge(client, [own], now).create.length, 0);
  // Date changed on the record: the obligation follows and its stages start over.
  const moved = planBridge({ ...client, deadlines: { dimex: { priorityId: "CR_RESIDENCY_DIMEX", date: "2027-01-15" } } }, [o], now);
  assertEquals(moved.update[0].fields.dueAt, "2027-01-15T12:00:00.000Z");
  assertEquals(moved.update[0].fields.remindersSent, []);
  // Removed from the record: dismissed, never deleted.
  const gone = planBridge({ ...client, deadlines: {} }, [o], now);
  assertEquals(gone.update[0].fields.status, "dismissed");
  assert(gone.update[0].fields.bridgeRemovedAt);
  // Staff follow-up loop date.
  const f = planBridge({ id: "dl2", jurisdiction: "CR", deadlineFollowup: { status: "active", deadline: "2026-11-30T00:00:00.000Z" } }, [], now);
  assertEquals(f.create[0].ruleId, "filing_deadline");
  assertEquals(f.create[0].dueAt, "2026-11-30T12:00:00.000Z");
  assertEquals(stagesFromOldOffsets([0]), ["30", "7"]);
  assertEquals(stagesFromOldOffsets([90]), []);
  assertEquals(bridgedId("ph_x", "k").startsWith("ph_obl_legacy_ph_x"), true);
});

Deno.test("one reminder system: a client-record date gives one email per stage (no filing_deadline_reminder), push follows, opted-out gets push only", async () => {
  await setup();
  const pushes: Array<{ to: string | null | undefined; body: string }> = [];
  const realSend = obligationPush.send;
  obligationPush.send = (_s, payload, ctx) => {
    pushes.push({ to: ctx.email, body: payload.body });
    return Promise.resolve({ ok: true, gone: false });
  };
  try {
    // A member with a date on the record (24 days out) and an own obligation for another date (in 6 days).
    member("u1", { client: { deadlines: { dimex: { priorityId: "CR_RESIDENCY_DIMEX", date: "2026-11-27" } } } });
    world.put("obligations", "obl_u1_tax", { id: "obl_u1_tax", clientId: "u1", country: "CR", ruleId: "cr_tax", title: "Annual tax return", dueAt: iso(6), status: "upcoming" });
    world.put("push_subscriptions", "u1_mailbox-rt_io", { subscription: { endpoint: "https://push.rt/abc", keys: { p256dh: "x", auth: "y" } } });
    // A CRM client (no membership, no free account) with a date, and an opted-out member with push.
    world.put("clients", "crm1", { email: "crm1@mailbox-rt.io", name: "Old Client", jurisdiction: "Costa Rica", deadlines: { dimex: { priorityId: "CR_RESIDENCY_DIMEX", date: "2026-11-27" } } });
    member("u2", { client: { emailOptOut: true, deadlines: { dimex: { priorityId: "CR_RESIDENCY_DIMEX", date: "2026-11-27" } } } });
    world.put("push_subscriptions", "u2_mailbox-rt_io", { subscription: { endpoint: "https://push.rt/def", keys: { p256dh: "x", auth: "y" } } });

    const now = new Date(NOW);
    await deadlineReminderSweep(now);
    assertEquals(world.emails().length, 0, "bridging sends nothing");
    assert(world.doc("obligations", bridgedId("u1", "dimex")), "bridged");
    await retentionMessagesSweep(now);
    const u1 = mails("u1@mailbox-rt.io");
    assertEquals(u1.length, 1, "one email for both dates");
    assert(u1[0].html.includes("DIMEX renewal") && u1[0].html.includes("Annual tax return"));
    assertEquals(mails("crm1@mailbox-rt.io").length, 1, "the CRM client still gets the reminder");
    assertEquals(mails("u2@mailbox-rt.io").length, 0, "opted out: no email");
    assertEquals(world.emails().filter((m) => /filing deadline/i.test(String(m.subject))).length, 0, "the old template is not used");
    assertEquals(pushes.map((p) => p.to).sort(), ["u1@mailbox-rt.io", "u2@mailbox-rt.io"], "push follows, even when reminder emails are off");
    assert(pushes.find((p) => p.to === "u1@mailbox-rt.io")!.body.startsWith("Annual tax return may require review by"));

    // Same day and next day, both sweeps again: nothing repeats.
    await deadlineReminderSweep(now);
    await retentionMessagesSweep(now);
    const next = new Date(now.getTime() + DAY);
    await deadlineReminderSweep(next);
    await retentionMessagesSweep(next);
    assertEquals(world.emails().filter((m) => /may require review|Coming up/.test(String(m.subject))).length, 2);
    assertEquals(pushes.length, 2);

    // 7 days before the bridged date: one more email (the 7-day stage), still one per date and stage.
    const d7 = new Date(Date.parse("2026-11-20T15:00:00.000Z"));
    await deadlineReminderSweep(d7);
    await retentionMessagesSweep(d7);
    const u1all = mails("u1@mailbox-rt.io");
    assertEquals(u1all.length, 2);
    assertEquals(u1all[1].subject, "A date that may require review this week");
    // The record was never changed.
    assertEquals(world.doc("clients", "u1")!.deadlines, { dimex: { priorityId: "CR_RESIDENCY_DIMEX", date: "2026-11-27" } });
    assertEquals(obligationPushBody([{ title: "X", dueLabel: "Nov 1", daysLeft: 0 }, { title: "Y", dueLabel: "Nov 2", daysLeft: 1 }]), "X may require review today. 1 more date is on your list.");
  } finally {
    obligationPush.send = realSend;
    world.restore();
  }
});

Deno.test("staff follow-up loop: no cadence email to the client any more; its date becomes an obligation; staff escalation unchanged", async () => {
  await setup();
  try {
    world.put("clients", "fl1", {
      email: "fl1@mailbox-rt.io", name: "Loop Client", jurisdiction: "Costa Rica",
      deadlineFollowup: { status: "active", deadline: "2026-11-06T00:00:00.000Z", startedAt: iso(-3), cadenceDays: 1, ownerEmail: CARLA },
    });
    await deadlineFollowupSweep();
    assertEquals(mails("fl1@mailbox-rt.io").length, 0, "no client email from the loop");
    const o = world.doc("obligations", bridgedId("fl1", "filing"));
    assertEquals(o?.ruleId, "filing_deadline");
    assertEquals(o?.dueAt, "2026-11-06T12:00:00.000Z");
    const pa = (world.doc("clients", "fl1")!.pendingActions ?? []) as Array<Record<string, unknown>>;
    assert(pa.some((a) => a.type === "deadline_urgent"), "staff still get the urgent action");
    await retentionMessagesSweep(new Date(NOW));
    assertEquals(mails("fl1@mailbox-rt.io").length, 1, "the obligations reminder (7-day stage) instead");
    assert(String(mails("fl1@mailbox-rt.io")[0].html).includes(EMAIL_FOOTER.slice(0, 20)));
  } finally {
    world.restore();
  }
});
