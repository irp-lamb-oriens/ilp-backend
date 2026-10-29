import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { clearPlaceholderCache } from "../helper/placeholder.ts";
import { EMAIL_FOOTER, handoffNextStepsEmail, invoiceReadyEmail, renewalNoticeEmail, signInCodeEmail, withLegalFooter } from "../helper/emailTemplates.ts";
import { emailPrefsOf, isSuppressed, leadUnsubscribeUrl, mayEmail, unsubscribeUrl, verifyLeadUnsubscribe, verifyUnsubscribe } from "../API/retention/mailer.ts";
import { renewalNotice, renewalNoticeDue, renewalNoticeSweep } from "../API/retention/lifecycleEmails.ts";
import { retentionMessagesSweep } from "../API/retention/retentionMessages.ts";
import { emailClassForSend, legalEmailTypes, LEGAL_EMAIL_SUBJECTS, renderLegalEmail } from "../API/dashboard/automation/renderLegalEmail.ts";
import { dropTemplateOverride, primeTemplateOverride } from "../API/dashboard/automation/templateRender.ts";
import { quoteReadyMail } from "../API/dashboard/quotesRouter.ts";
import { invoiceMail } from "../API/finance/invoicesRouter.ts";
import { findingsEmailHtml } from "../API/leads/leadsRouter.ts";
import { alertDateLabel, alertDispatchState, alertLeadDays, dispatchDueAlerts } from "../jobs/dispatchAlerts.ts";
import { emailLanguageFor } from "../API/routing/precall.ts";
import { lawyerApplyEmails } from "../API/providers/applyEmails.ts";
import { onRecordCreated } from "../API/members/events.ts";
import { renewalEvents } from "../jobs/taskRuleSweep.ts";
import { deadlineReminderSweep } from "../jobs/deadlineReminderSweep.ts";

/**
 * COMMS-P1: compliance and bugs. One test (or more) per message changed:
 * email classes, renewal notice, legal footer on sign-in codes / the seven
 * editable emails / quote / invoice / pricing / free check, free-check
 * unsubscribe, staff trigger-email consent gate, handoff next steps right
 * away (service), invoice without "attached", one quote email, alerts before
 * the deadline, lawyer emails in English.
 * Run: deno test --allow-env --allow-read test/commsP1_test.ts
 */

const FOOT = "not a law firm";
const DASHES = /—|–/;
const NOW = "2026-10-27T15:00:00.000Z";
const DAY = 86_400_000;
const STAFF = "carla@internationallegalpartner.com";

async function world0(): Promise<FakeWorld> {
  await useFakeEnv({ ADMIN_EMAILS: "oriens@internationallegalpartner.com", CSM_EMAILS: STAFF, DEFAULT_CSM_EMAIL: STAFF, PUBLIC_SITE_URL: "https://app.e2e-ilp.io", PUBLIC_API_URL: "https://api.e2e-ilp.io" });
  for (const k of ["ALERT_LEAD_DAYS", "AUTH_COOKIES", "DEFAULT_PROVIDER_ID", "SALES_EMAILS"]) Deno.env.delete(k);
  clearPlaceholderCache();
  return installFakeWorld(NOW);
}

function member(world: FakeWorld, id: string, client: Record<string, unknown> = {}, membership: Record<string, unknown> = {}) {
  world.put("clients", id, { email: `${id}@mailbox-rt.io`, fullName: `Grace ${id}`, legalCountry: "CR", ...client });
  world.put("memberships", `mem_${id}`, {
    id: `mem_${id}`, clientId: id, status: "active", country: "CR", plan: "standard",
    periodStart: "2026-10-01T15:00:00.000Z", periodEnd: "2026-11-01T15:00:00.000Z",
    minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, paymentRef: "sub_123", createdAt: "2026-10-01T15:00:00.000Z",
    ...membership,
  });
}

// ─── Classes ───────────────────────────────────────────────────────────────

Deno.test("email classes: transactional always, service stops on unsubscribe, marketing also needs consent", () => {
  const cases: Array<[Parameters<typeof mayEmail>[0], [boolean, boolean, boolean]]> = [
    [{}, [true, true, true]],
    [{ optOut: true }, [true, false, false]],
    [{ marketingConsent: false }, [true, true, false]],
    [{ marketingConsent: true }, [true, true, true]],
    [{ marketingConsent: null, suppressed: true }, [true, true, false]],
  ];
  for (const [to, want] of cases) {
    assertEquals([mayEmail(to, "transactional"), mayEmail(to, "service"), mayEmail(to, "marketing")], want, JSON.stringify(to));
  }
  assertEquals(emailPrefsOf({ emailOptOut: true, marketingEmailConsent: false }), { optOut: true, marketingConsent: false });
  assertEquals(emailPrefsOf(null), { optOut: false, marketingConsent: null });
  assertEquals(emailClassForSend("quote_ready"), "service");
  assertEquals(emailClassForSend("quote_ready", "fall-outreach"), "marketing");
  assertEquals(emailClassForSend("unknown_type"), "marketing");
});

// ─── Renewal notice ────────────────────────────────────────────────────────

Deno.test("renewal notice: due 7 days before an active renewal, not after a cancel request", () => {
  const now = new Date(NOW);
  const at = (d: number) => new Date(now.getTime() + d * DAY).toISOString();
  assertEquals(renewalNoticeDue({ status: "active", periodEnd: at(7) }, now), true);
  assertEquals(renewalNoticeDue({ status: "active", periodEnd: at(1) }, now), true);
  assertEquals(renewalNoticeDue({ status: "active", periodEnd: at(8) }, now), false);
  assertEquals(renewalNoticeDue({ status: "active", periodEnd: at(-1) }, now), false);
  assertEquals(renewalNoticeDue({ status: "active", periodEnd: at(3), cancelAtPeriodEnd: true }, now), false);
  assertEquals(renewalNoticeDue({ status: "past_due", periodEnd: at(3) }, now), false);
});

Deno.test("renewal notice email: amount, date, online cancel link, footer, no dashes; manual payers see a due payment", () => {
  const card = renewalNotice({ periodEnd: "2026-11-01T15:00:00.000Z", paymentRef: "sub_1" } as never, "Grace");
  for (const part of [card.html, card.text]) {
    for (const needle of ["US$79.99", "November 1, 2026", "/status/money/cancel", "renews automatically", "cancel online before November 1, 2026", FOOT]) {
      assert(part.includes(needle), `missing ${needle}`);
    }
  }
  assertEquals(card.subject, "Your ILP membership renews on November 1, 2026");
  assert(!DASHES.test(card.subject + card.text));
  const manual = renewalNoticeEmail({ amountLabel: "US$79.99", chargeOn: "November 1, 2026", cancelUrl: "c", moneyUrl: "m", termsUrl: "t", byCard: false });
  assert(manual.text.includes("is due on that date") && !manual.text.includes("to your card"));
});

Deno.test("renewal notice sweep: one member email per renewal, also to members who stopped reminders; the CSM task stays", async () => {
  const world = await world0();
  try {
    member(world, "r1", { emailOptOut: true });
    member(world, "r2", {}, { cancelAtPeriodEnd: true });
    member(world, "r3", {}, { periodEnd: "2026-11-20T15:00:00.000Z" });
    assertEquals(await renewalNoticeSweep(new Date(NOW)), 1);
    assertEquals(await renewalNoticeSweep(new Date(NOW)), 0, "once per renewal date");
    const mails = world.emails().filter((m) => /renews on/.test(m.subject));
    assertEquals(mails.map((m) => m.to), ["r1@mailbox-rt.io"]);
    assert(mails[0].text.includes("/status/money/cancel"));
    // The CSM renewal task rule is unchanged.
    const ev = renewalEvents([world.doc("memberships", "mem_r1") as never], new Date(NOW));
    assertEquals(ev[0][0], "membership.renewal_7d");
  } finally {
    world.restore();
  }
});

// ─── Legal footer ──────────────────────────────────────────────────────────

Deno.test("footer: sign-in codes for all three portals, in English, with the code", async () => {
  for (const portal of ["member", "lawyer", "staff"] as const) {
    const m = signInCodeEmail({ portal, code: "482913" });
    assert(m.html.includes("482913") && m.text.includes("482913"));
    assert(m.html.includes(FOOT) && m.text.includes(EMAIL_FOOTER), portal);
    assert(!/Login Code/.test(m.subject), m.subject);
  }
  for (const f of ["../API/clientStatus/signInCode.ts", "../API/provider/providerAuthRouter.ts", "../API/dashboard/dashboardRouter.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assert(src.includes("signInCodeEmail({ portal:"), `${f} uses the shared sign-in email`);
    assert(!src.includes("Your verification code is:"), `${f} has no old fixed HTML`);
  }
});

Deno.test("footer: all seven editable emails, default and staff override, never twice; no dashes in subjects", () => {
  assertEquals(legalEmailTypes().length, 7);
  for (const t of legalEmailTypes()) {
    const r = renderLegalEmail(t, { name: "Grace", legalArea: "immigration", statusPageUrl: "https://s/status/x", filingDeadline: "2026-11-30" });
    assert(r.bodyHtml.includes(FOOT), t);
    assertEquals(r.bodyHtml.split(FOOT).length, 2, `${t}: footer once`);
    assert(!DASHES.test(LEGAL_EMAIL_SUBJECTS[t]), t);
  }
  primeTemplateOverride({ emailType: "matter_closed", subject: "All done, {{name}}", bodyHtml: "<html><body><p>Closed.</p></body></html>", label: "x", category: "ops", enabled: true } as never);
  try {
    const r = renderLegalEmail("matter_closed", { name: "Grace" });
    assertEquals(r.subject, "All done, Grace");
    assert(r.bodyHtml.indexOf(FOOT) > r.bodyHtml.indexOf("Closed.") && r.bodyHtml.indexOf(FOOT) < r.bodyHtml.indexOf("</body>"), "footer added inside the body of an edited template");
  } finally {
    dropTemplateOverride("matter_closed");
  }
  assertEquals(withLegalFooter(withLegalFooter("<p>x</p>")).split(FOOT).length, 2);
});

Deno.test("quote: one email, the editable quote_ready, with the quote link and footer", async () => {
  const m = quoteReadyMail({ legalArea: "real estate" }, { name: "Grace", quoteTitle: "Condo purchase review", statusPageUrl: "https://s/status/c1?quoteToken=t" });
  assertEquals(m.subject, "Your legal quote is ready");
  for (const needle of ["Grace", "Condo purchase review", "https://s/status/c1?quoteToken=t", "real estate", FOOT]) assert(m.bodyHtml.includes(needle), needle);
  const bare = quoteReadyMail({}, { name: "Grace", quoteTitle: "", statusPageUrl: "u" });
  assert(!bare.bodyHtml.includes("<strong></strong>"), "no empty area");
  const src = await Deno.readTextFile(new URL("../API/dashboard/quotesRouter.ts", import.meta.url));
  assert(!src.includes("View My Quote"), "the fixed-HTML quote email is gone");
  assertEquals(src.match(/quote_to_client_/g)?.length, 1);
});

Deno.test("invoice: a link to Money, no 'attached' wording, balance, footer", async () => {
  await useFakeEnv({ PUBLIC_SITE_URL: "https://app.e2e-ilp.io" });
  const due = invoiceMail({ invoiceNumber: "ILP-0042", clientName: "Grace Whitfield" }, { total: 450, balance: 200 });
  const paid = invoiceMail({ invoiceNumber: "ILP-0043", clientName: "" }, { total: 450, balance: 0 });
  for (const m of [due, paid]) {
    assert(!/attach/i.test(m.html + m.text), m.subject);
    assert(m.text.includes("https://app.e2e-ilp.io/status/money"));
    assert(m.html.includes(FOOT));
  }
  assert(due.text.startsWith("Hi Grace,") && due.text.includes("The balance due is US$200.00"));
  assert(paid.text.startsWith("Hello,") && paid.text.includes("paid in full"));
  assertEquals(invoiceReadyEmail({ invoiceNumber: "X", totalLabel: "US$1.00", moneyUrl: "m", contactEmail: "c" }).subject, "Your ILP invoice X");
  const src = await Deno.readTextFile(new URL("../API/finance/invoicesRouter.ts", import.meta.url));
  assert(!/Please find attached/.test(src));
});

Deno.test("pricing request email carries the footer", async () => {
  const src = await Deno.readTextFile(new URL("../API/dashboard/pricingRequestsRouter.ts", import.meta.url));
  assert(src.includes("html: withLegalFooter(html)"));
});

// ─── Free check: footer + unsubscribe ──────────────────────────────────────

Deno.test("free check email: footer and a signed unsubscribe link that suppresses the address", async () => {
  const world = await world0();
  try {
    const url = await leadUnsubscribeUrl("lead_abc");
    const html = findingsEmailHtml([], "CR", url);
    assert(html.includes(FOOT) && html.includes("Stop emails about this check") && html.includes(url.replace(/&/g, "&amp;")));
    const t = new URL(url).searchParams.get("t")!;
    assert(await verifyLeadUnsubscribe("lead_abc", t));
    assertEquals(await verifyUnsubscribe("lead_abc", t), false, "a lead token is not a member token");
    assertEquals(await verifyLeadUnsubscribe("lead_other", t), false);

    world.put("leads", "lead_abc", { id: "lead_abc", email: "Visitor@Mailbox-rt.io", source: "deadline_check" });
    const app = new FakeApp();
    (await import("../API/retention/retentionRouter.ts")).registerRetentionRoutes(app as never);
    let r = await app.call("GET", url);
    assertEquals(r.status, 200);
    assert(String(r.body).includes("confirm=1"), "asks first, so link scanners do not unsubscribe");
    assertEquals(await isSuppressed("visitor@mailbox-rt.io"), false);
    r = await app.call("GET", `${url}&confirm=1`);
    assertEquals(r.status, 200);
    assertEquals(world.doc("leads", "lead_abc")!.emailOptOut, true);
    assertEquals(await isSuppressed("VISITOR@mailbox-rt.io"), true);
    r = await app.call("GET", url.replace(/t=[0-9a-f]+/, "t=" + "0".repeat(32)));
    assertEquals(r.status, 400);
  } finally {
    world.restore();
  }
});

// ─── Staff trigger-email outreach ──────────────────────────────────────────

Deno.test("staff trigger-email: unsubscribe and marketing consent are honoured; outreach carries the unsubscribe link", async () => {
  const world = await world0();
  try {
    const app = new FakeApp();
    (await import("../API/dashboard/dashboardRouter.ts")).default(app as never);
    world.put("dashboard_sessions", "stf", { email: STAFF, expiresAt: "2030-01-01T00:00:00Z" });
    const send = (id: string, body: Record<string, unknown>) =>
      app.call("POST", `/api/dashboard/clients/${id}/trigger-email`, { body, headers: { authorization: "Bearer stf" } });
    world.put("clients", "t1", { email: "t1@mailbox-rt.io", name: "Grace", emailOptOut: true });
    world.put("clients", "t2", { email: "t2@mailbox-rt.io", name: "Robert", marketingEmailConsent: false });
    world.put("clients", "t3", { email: "t3@mailbox-rt.io", name: "Linda", marketingEmailConsent: true });

    let r = await send("t1", { emailType: "quote_ready" });
    assertEquals([r.status, r.body.blocked], [409, "opted_out"]);
    r = await send("t2", { emailType: "matter_closed", campaign: "fall-outreach" });
    assertEquals([r.status, r.body.blocked], [409, "no_marketing_consent"]);
    r = await send("t2", { emailType: "matter_closed" });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    r = await send("t3", { emailType: "scoping_intro", campaign: "fall-outreach" });
    assertEquals(r.status, 200, JSON.stringify(r.body));

    const mails = world.emails();
    assertEquals(mails.filter((m) => m.to === "t1@mailbox-rt.io").length, 0);
    const service = mails.find((m) => m.to === "t2@mailbox-rt.io")!;
    // COMMS-P5: service sends carry the reminder unsubscribe link too.
    assert(service.html.includes(FOOT) && service.html.includes("/api/retention/unsubscribe") && service.html.includes("Stop reminder emails"));
    const outreach = mails.find((m) => m.to === "t3@mailbox-rt.io")!;
    assert(outreach.html.includes(FOOT) && outreach.html.includes("/api/retention/unsubscribe?c=t3"));
  } finally {
    world.restore();
  }
});

// ─── Handoff next steps: service, immediate ────────────────────────────────

Deno.test("handoff: next steps emailed right away (service), not blocked by marketing opt-out, not repeated by the daily sweep", async () => {
  const world = await world0();
  try {
    member(world, "h1", { marketingEmailConsent: false });
    member(world, "h2", { emailOptOut: true });
    const steps = [
      { what: "Ana drafts the residency renewal letter", who: "lawyer" },
      { what: "Send a copy of your passport", who: "client", dueAt: "2026-11-05T00:00:00.000Z" },
    ];
    for (const id of ["h1", "h2"]) {
      world.put("matters", `mat_${id}`, { id: `mat_${id}`, clientId: id, country: "CR", title: "DIMEX renewal", area: "immigration", stage: "intake", stageEnteredAt: "2026-10-01T15:00:00.000Z", openedAt: "2026-10-01T15:00:00.000Z", nextStep: steps[0], nextStepSetAt: NOW });
      const h = { id: `hand_${id}`, consultationId: `c_${id}`, clientId: id, matterId: `mat_${id}`, providerId: "ANA", legalNextSteps: steps, approvedAt: NOW, csmTaskIds: [] };
      world.put("handoffs", h.id, h);
      await onRecordCreated("handoffs", h);
    }
    const h1 = world.emails().filter((m) => m.to === "h1@mailbox-rt.io");
    assertEquals(h1.length, 1);
    assertEquals(h1[0].subject, "Your next steps on DIMEX renewal");
    assert(h1[0].text.indexOf("Send a copy of your passport (You, by November 5, 2026)") < h1[0].text.indexOf("Ana drafts"), "client steps first");
    assert(h1[0].text.includes("Stop reminder emails: ") && h1[0].text.includes(EMAIL_FOOTER));
    assertEquals(world.emails().filter((m) => m.to === "h2@mailbox-rt.io").length, 0, "the reminder unsubscribe stops it");
    // The CSM task still exists.
    assert(world.all("csm_tasks").some((t) => t.clientId === "h1"));
    // The next morning's sweep has nothing new to say about this step.
    world.advance(DAY);
    const out = await retentionMessagesSweep(new Date(Date.now()));
    assertEquals(out.nextSteps, 0);
    assertEquals(world.emails().filter((m) => m.to === "h1@mailbox-rt.io").length, 1);
    assert(!DASHES.test(handoffNextStepsEmail({ steps: [{ what: "x", whoLabel: "You" }], homeUrl: "h", unsubscribeUrl: "u" }).text));
  } finally {
    world.restore();
  }
});

Deno.test("retention sweep: check-in is marketing (needs consent), deadline reminders are service", async () => {
  const world = await world0();
  try {
    member(world, "k1", { marketingEmailConsent: false }, { activatedAt: "2026-09-20T15:00:00.000Z" });
    member(world, "k2", { marketingEmailConsent: true }, { activatedAt: "2026-09-20T15:00:00.000Z" });
    for (const id of ["k1", "k2"]) {
      world.put("obligations", `ob_${id}`, { id: `ob_${id}`, clientId: id, country: "CR", ruleId: "CR-TAX-1", title: "Corporation tax may require review", dueAt: "2026-11-02T15:00:00.000Z", status: "upcoming" });
    }
    await retentionMessagesSweep(new Date(NOW));
    const to = (id: string) => world.emails().filter((m) => m.to === `${id}@mailbox-rt.io`).map((m) => m.subject).sort();
    assertEquals(to("k1"), ["A date that may require review this week"]);
    assertEquals(to("k2"), ["A date that may require review this week", "Your month with ILP"]);
  } finally {
    world.restore();
  }
});

// ─── Compliance alerts ahead of the deadline ───────────────────────────────

Deno.test("alerts: lead days (alert, env, default 14), state, readable date", () => {
  assertEquals(alertLeadDays({}), 14);
  assertEquals(alertLeadDays({}, "30"), 30);
  assertEquals(alertLeadDays({ leadDays: 7 }, "30"), 7);
  assertEquals(alertLeadDays({}, "abc"), 14);
  const now = Date.parse(NOW);
  assertEquals(alertDispatchState({ deadlineTs: now + 10 * DAY }, now, 14), "send");
  assertEquals(alertDispatchState({ deadlineTs: now + 20 * DAY }, now, 14), "wait");
  assertEquals(alertDispatchState({ deadlineTs: now - DAY }, now, 14), "expired");
  assertEquals(alertDateLabel("2026-11-30T00:00:00.000Z", 0), "November 30, 2026");
  assertEquals(alertDateLabel("end of March", 0), "end of March");
});

Deno.test("alerts: sent before the deadline with footer and unsubscribe; later ones wait; passed ones expire unsent", async () => {
  const world = await world0();
  try {
    const now = Date.parse(NOW);
    world.put("clients", "al1", { email: "al1@mailbox-rt.io", fullName: "Grace" });
    world.put("clients", "al2", { email: "al2@mailbox-rt.io", fullName: "Opted", emailOptOut: true });
    const alert = (id: string, clientId: string, days: number) =>
      world.put("alerts", id, { status: "scheduled", clientId, email: `${clientId}@mailbox-rt.io`, firstName: "Grace", title: "Vehicle tax (marchamo)", deadlineTs: now + days * DAY, deadlineLabel: new Date(now + days * DAY).toISOString(), responseUrl: "https://app.e2e-ilp.io/alerts" });
    alert("a_soon", "al1", 10);
    alert("a_later", "al1", 40);
    alert("a_past", "al1", -2);
    alert("a_opt", "al2", 5);
    await dispatchDueAlerts();
    const mails = world.emails();
    assertEquals(mails.length, 1);
    assertEquals(mails[0].subject, "Coming up: Vehicle tax (marchamo)");
    assert(mails[0].html.includes(FOOT) && mails[0].html.includes("/api/retention/unsubscribe?c=al1"));
    assert(mails[0].html.includes("November 6, 2026"), "a readable date, not an ISO string");
    assertEquals(world.doc("alerts", "a_soon")!.status, "dispatched");
    assertEquals(world.doc("alerts", "a_later")!.status, "scheduled");
    assertEquals(world.doc("alerts", "a_past")!.status, "expired");
    assertEquals(world.doc("alerts", "a_opt")!.status, "scheduled");
    assertEquals((await unsubscribeUrl("al1")).includes("c=al1"), true);
  } finally {
    world.restore();
  }
});

Deno.test("client deadline reminders: footer and unsubscribe link; the reminder unsubscribe stops the email", async () => {
  const world = await world0();
  try {
    const deadlines = { dimex: { priorityId: "CR_RESIDENCY_DIMEX", date: "2026-11-20" } }; // 24 days out: the 30-day reminder
    world.put("clients", "d1", { email: "d1@mailbox-rt.io", name: "Grace", jurisdiction: "Costa Rica", deadlines });
    world.put("clients", "d2", { email: "d2@mailbox-rt.io", name: "Opted", jurisdiction: "Costa Rica", emailOptOut: true, deadlines });
    // COMMS-P4: the record's dates are bridged into obligations; the obligations reminder is the email.
    await deadlineReminderSweep(world.now());
    assertEquals(world.emails().length, 0, "the bridge itself sends nothing");
    await retentionMessagesSweep(world.now());
    const mails = world.emails();
    assertEquals(mails.map((m) => m.to), ["d1@mailbox-rt.io"]);
    assert(mails[0].html.includes(FOOT) && mails[0].html.includes("/api/retention/unsubscribe?c=d1"));
  } finally {
    world.restore();
  }
});

// ─── Lawyer emails in English ──────────────────────────────────────────────

Deno.test("lawyer emails: English for everyone, whatever the stored emailLanguage; apply emails say Hi", () => {
  assertEquals(emailLanguageFor({ emailLanguage: "es" }), "en");
  assertEquals(emailLanguageFor({ jurisdictions: ["PT"] }), "en");
  assertEquals(emailLanguageFor(null), "en");
  const mails = [
    lawyerApplyEmails.received({ name: "Ana", signInUrl: "https://s/lawyer", country: "CR" }),
    lawyerApplyEmails.approved({ name: "Ana", signInUrl: "https://s/lawyer" }),
    lawyerApplyEmails.changes({ name: "", note: "Add your carné number.", applyUrl: "a", signInUrl: "s" }),
    lawyerApplyEmails.declined({ name: "Ana", reason: "We could not verify the licence." }),
  ];
  for (const m of mails) {
    assert(!/Hola|Olá/.test(m.html + m.text), m.subject);
    assert(m.text.startsWith("Hi Ana,") || m.text.startsWith("Hello,"), m.text.slice(0, 20));
  }
});
