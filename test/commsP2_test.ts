import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { type FakeWorld, installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";
import { FakeApp } from "./e2e/fakeApp.ts";
import { clearPlaceholderCache } from "../helper/placeholder.ts";
import { LAWYER_FEEDBACK_DEFAULTS, TASK_RULES } from "../schemas/contracts.ts";
import { assignMember } from "../API/members/assignment.ts";
import { onQuoteAccepted } from "../API/finance/quoteAccepted.ts";
import {
  licenceExpirySweep,
  licenceStage,
  newlyPaid,
  notifyPayouts,
  notifyQuoteDecision,
  profileGaps,
  profileIncompleteSweep,
  quoteLawyers,
  sendSummaryReady,
  summaryFollowupDue,
  summaryFollowups,
  weeklyDigest,
} from "../API/lawyerComms/notify.ts";
import {
  anonymizeComment,
  evaluateLawyer,
  feedbackConfigErrors,
  feedbackView,
  monthBounds,
  normalizeFeedbackConfig,
  previousMonth,
  themesFrom,
} from "../API/lawyerComms/feedbackLogic.ts";
import { coachingCheck, lawyerFeedbackSweep, monthlyFeedback } from "../API/lawyerComms/feedback.ts";
import { LAWYER_FOOTER } from "../API/lawyerComms/emails.ts";

/**
 * COMMS-P2: lawyers informed + feedback. One test (or more) per message:
 * trigger, recipient, dedupe, content; anonymization; thresholds; the
 * lawyer never sees another lawyer's data, a score or a member's name.
 * Run: deno test --allow-env --allow-read test/commsP2_test.ts
 */

const NOW = "2026-11-01T15:30:00.000Z"; // Sunday Nov 1, 09:30 Costa Rica
const DAY = 86_400_000;
const HOUR = 3_600_000;
const STAFF = "carla@internationallegalpartner.com";
const ADMIN = "oriens@internationallegalpartner.com";
const DASHES = /—|–/;
const WEEK = [1, 2, 3, 4, 5].map((day) => ({ day, start: "08:00", end: "12:00" }));
const PUNITIVE = /warning|poor|fail|penal|terminat|probation|underperform|ranking|rank|worst|bottom/i;

let world: FakeWorld;

async function world0(start = NOW): Promise<FakeWorld> {
  await useFakeEnv({ ADMIN_EMAILS: ADMIN, CSM_EMAILS: STAFF, DEFAULT_CSM_EMAIL: STAFF, PUBLIC_SITE_URL: "https://app.e2e-ilp.io", PUBLIC_API_URL: "https://api.e2e-ilp.io", LAWYER_TEAM_EMAIL: "partners@internationallegalpartner.com" });
  for (const k of ["DEFAULT_PROVIDER_ID", "SALES_EMAILS", "AUTH_COOKIES", "STAFF_EMAILS", "LAWYER_TEAM_OWNER_EMAIL"]) Deno.env.delete(k);
  clearPlaceholderCache();
  world = installFakeWorld(start);
  return world;
}

function lawyer(id: string, extra: Record<string, unknown> = {}, opts: { hours?: boolean } = {}) {
  world.put("providers", id, {
    name: `${id} Mora`, email: `${id.toLowerCase()}@lawyers-rt.io`, status: "active", active: true, jurisdictions: ["CR"],
    specialties: ["residency_renewals"], legalAreas: ["immigration"], languages: ["en", "es"], bio: "Immigration lawyer in San José with fifteen years of residency and property practice for foreign families.",
    activatedAt: "2026-09-01T15:00:00.000Z", ...extra,
  });
  if (opts.hours !== false) world.put("lawyer_availability", id, { id, providerId: id, timezone: "America/Costa_Rica", weekly: WEEK, blackoutDates: [], minLeadHours: 0, maxCallsPerDay: 6, specialties: [] });
  world.put("provider_sessions", `law_${id}`, { email: `${id.toLowerCase()}@lawyers-rt.io`, providerId: id, expiresAt: "2030-01-01T00:00:00Z" });
}

function member(id: string, client: Record<string, unknown> = {}) {
  world.put("clients", id, { email: `${id}@mailbox-rt.io`, phone: "+1 555 201 3344", fullName: `Grace ${id.toUpperCase()} Whitfield`, legalCountry: "CR", nationality: "US", residencyStatus: "temporary", ...client });
  world.put("memberships", `mem_${id}`, {
    id: `mem_${id}`, clientId: id, status: "active", country: "CR", plan: "standard", periodStart: "2026-10-20T15:00:00.000Z", periodEnd: "2026-11-20T15:00:00.000Z",
    minutesIncluded: 60, minutesUsed: 0, callsIncluded: 3, callsUsed: 0, paymentRef: "manual", createdAt: "2026-10-20T15:00:00.000Z",
    intake: { question: "My DIMEX expires in March. What do I renew first?" },
  });
  world.put("matters", `mat_${id}`, { id: `mat_${id}`, clientId: id, country: "CR", title: "DIMEX renewal", area: "immigration", stage: "intake", stageEnteredAt: "2026-10-20T15:00:00.000Z", openedAt: "2026-10-20T15:00:00.000Z" });
}

const mailsTo = (addr: string) => world.emails().filter((m) => String(m.to).includes(addr));
const all = (m: Record<string, string>) => `${m.subject}\n${m.html}\n${m.text}`;

function checkLawyerMail(m: Record<string, string>) {
  assert(!DASHES.test(m.subject + m.text), `dash in ${m.subject}`);
  assert(m.text.includes(LAWYER_FOOTER), `footer in ${m.subject}`);
  assert(!/Hola|Olá/.test(m.text), "English");
}

// ─── New member assigned ───────────────────────────────────────────────────

Deno.test("member assigned: the new lawyer gets the profile summary once; no contact details; seed lawyers get nothing", async () => {
  await world0();
  try {
    lawyer("ANA");
    lawyer("ph_BEA", { placeholder: true });
    member("m1");
    await assignMember("m1", "ANA", { email: STAFF, role: "staff" });
    let mails = mailsTo("ana@lawyers-rt.io");
    assertEquals(mails.length, 1);
    const m = mails[0];
    assertEquals(m.subject, "New ILP member assigned to you: Grace M1 Whitfield");
    for (const needle of ["My DIMEX expires in March", "DIMEX renewal", "Costa Rica", "Nationality: US", "Open your members", "/lawyer/clients", "Do not forward it"]) assert(all(m).includes(needle), needle);
    for (const secret of ["m1@mailbox-rt.io", "555 201 3344"]) assert(!all(m).includes(secret), `no ${secret}`);
    checkLawyerMail(m);
    // Same assignment again: nothing new. A seed lawyer: never emailed.
    await assignMember("m1", "ANA", { email: STAFF, role: "staff" });
    assertEquals(mailsTo("ana@lawyers-rt.io").length, 1);
    member("m2");
    await assignMember("m2", "ph_BEA", { email: STAFF, role: "staff" });
    mails = mailsTo("ph_bea@lawyers-rt.io");
    assertEquals(mails.length, 0);
  } finally {
    world.restore();
  }
});

// ─── Summary ready, reminder, escalation ───────────────────────────────────

Deno.test("summary ready: email on transcript, 24 h reminder, CSM task at 48 h, each once; nothing after confirmation", async () => {
  await world0();
  try {
    lawyer("ANA");
    member("m1");
    const call = { id: "c1", clientId: "m1", providerId: "ANA", matterId: "mat_m1", scheduledAt: "2026-11-01T13:00:00.000Z", durationMin: 20, status: "completed", summary: { text: "Discussed the renewal.", status: "suggested" } };
    world.put("consultations", "c1", call);
    assertEquals(await sendSummaryReady(call as never, true), true);
    assertEquals(await sendSummaryReady({ ...world.doc("consultations", "c1") } as never, true), false, "once per call");
    let mails = mailsTo("ana@lawyers-rt.io");
    assertEquals(mails.length, 1);
    assertEquals(mails[0].subject, "Summary ready to confirm: your call with Grace M1 Whitfield");
    assert(mails[0].text.includes("/lawyer/calls/c1") && mails[0].text.includes("Confirm and hand off"));
    checkLawyerMail(mails[0]);

    const stored = world.doc("consultations", "c1")!;
    assertEquals(stored.summaryNotices, ["ready"]);
    const t0 = new Date(Date.parse(stored.summaryReadyAt));
    assertEquals(summaryFollowupDue(stored as never, new Date(t0.getTime() + 23 * HOUR)), null);
    assertEquals(summaryFollowupDue(stored as never, new Date(t0.getTime() + 24 * HOUR)), "reminder");
    assertEquals(summaryFollowupDue(stored as never, new Date(t0.getTime() + 48 * HOUR)), "escalate");
    assertEquals(summaryFollowupDue({ ...stored, summary: { text: "x", status: "confirmed" } } as never, new Date(t0.getTime() + 48 * HOUR)), null);

    let r = await summaryFollowups(new Date(t0.getTime() + 25 * HOUR));
    assertEquals(r, { reminders: 1, escalated: 0 });
    mails = mailsTo("ana@lawyers-rt.io");
    assertEquals(mails.length, 2);
    assertEquals(mails[1].subject, "Reminder: the summary of your call with Grace M1 Whitfield is waiting");
    assert(mails[1].text.includes("the member's CSM will contact you"));
    r = await summaryFollowups(new Date(t0.getTime() + 30 * HOUR));
    assertEquals(r, { reminders: 0, escalated: 0 });
    r = await summaryFollowups(new Date(t0.getTime() + 49 * HOUR));
    assertEquals(r, { reminders: 0, escalated: 1 });
    const task = world.all("csm_tasks").find((t) => t.id.includes("call_summary_unconfirmed"))!;
    assertEquals([task.clientId, task.ownerEmail, task.source], ["m1", STAFF, { kind: "consultation", id: "c1" }]);
    assert(task.title.startsWith(TASK_RULES["call.summary_unconfirmed"].title) && task.title.includes("ANA Mora"));
    r = await summaryFollowups(new Date(t0.getTime() + 80 * HOUR));
    assertEquals(r, { reminders: 0, escalated: 0 });
    assertEquals(mailsTo("ana@lawyers-rt.io").length, 2);
  } finally {
    world.restore();
  }
});

// ─── Quotes ────────────────────────────────────────────────────────────────

Deno.test("quotes: approved and changes requested reach the quote's lawyer with the note; accepted gives the fee once", async () => {
  await world0();
  try {
    lawyer("ANA");
    lawyer("BEA");
    member("m1", { assignedProviderId: "ANA" });
    const quote = { quoteId: "q1", title: "Residency renewal filing", status: "approved", providerIds: ["ANA"], lineItems: [{ label: "Filing", amount: 450, providerId: "ANA" }, { label: "Translation", amount: 120, providerId: "BEA" }] };
    assertEquals(quoteLawyers(quote), ["ANA", "BEA"]);
    assertEquals(await notifyQuoteDecision("m1", { ...quote, lineItems: [] }, "approved"), 1);
    assertEquals(await notifyQuoteDecision("m1", { ...quote, lineItems: [] }, "approved"), 0, "same minute: once");
    assertEquals(await notifyQuoteDecision("m1", { ...quote, lineItems: [] }, "changes", "Split the government fees into their own line."), 1);
    const ana = mailsTo("ana@lawyers-rt.io");
    assertEquals(ana.map((m) => m.subject), ["Quote approved: Residency renewal filing", "Changes requested on your quote: Residency renewal filing"]);
    assert(ana[1].text.includes("Split the government fees") && ana[1].text.includes("submit it for approval again"));
    for (const m of ana) checkLawyerMail(m);
    for (const m of ana) assert(!/margin|client price/i.test(m.text), "no commercial fields");

    world.put("clients", "m1", { ...world.doc("clients", "m1"), quotes: [quote] });
    await onQuoteAccepted("m1", { ...quote, status: "accepted" }, { email: "m1@mailbox-rt.io", role: "client" });
    await onQuoteAccepted("m1", { ...quote, status: "accepted" }, { email: "m1@mailbox-rt.io", role: "client" });
    const acc = (addr: string) => mailsTo(addr).filter((m) => m.subject.includes("accepted your quote"));
    assertEquals(acc("ana@lawyers-rt.io").length, 1);
    assertEquals(acc("bea@lawyers-rt.io").length, 1);
    assert(acc("ana@lawyers-rt.io")[0].text.includes("US$450.00") && !acc("ana@lawyers-rt.io")[0].text.includes("120"), "own fee only");
    assertEquals(acc("ana@lawyers-rt.io")[0].subject, "Grace M1 Whitfield accepted your quote: Residency renewal filing");
  } finally {
    world.restore();
  }
});

// ─── Payouts ───────────────────────────────────────────────────────────────

Deno.test("payouts: only rows newly marked paid, per lawyer, once per row", async () => {
  await world0();
  try {
    lawyer("ANA");
    lawyer("BEA");
    member("m1", { quotes: [{ quoteId: "q1", title: "Residency renewal filing" }] });
    const before = { quoteId: "q1", clientId: "m1", providerPayments: [{ id: "pp1", providerId: "ANA", amount: 450, paid: false }, { id: "pp2", providerId: "BEA", amount: 120, paid: true }] };
    const after = { quoteId: "q1", clientId: "m1", providerPayments: [{ id: "pp1", providerId: "ANA", amount: 450, paid: true, date: "2026-10-30" }, { id: "pp2", providerId: "BEA", amount: 120, paid: true }] };
    assertEquals(newlyPaid(before, after).map((r) => r.id), ["pp1"]);
    assertEquals(await notifyPayouts(before, after), 1);
    assertEquals(await notifyPayouts(before, after), 0, "once per row");
    const m = mailsTo("ana@lawyers-rt.io");
    assertEquals(m.length, 1);
    assertEquals(m[0].subject, "ILP recorded a payment to you: US$450.00");
    assert(m[0].text.includes("Residency renewal filing for Grace M1 Whitfield: US$450.00, paid on October 30, 2026"));
    assertEquals(mailsTo("bea@lawyers-rt.io").length, 0, "already paid before");
    checkLawyerMail(m[0]);
  } finally {
    world.restore();
  }
});

// ─── Weekly digest ─────────────────────────────────────────────────────────

Deno.test("weekly digest: calls this week, summaries to confirm, open quotes and offers; nothing to say means no email; once a week", async () => {
  await world0("2026-11-02T14:05:00.000Z");
  try {
    lawyer("ANA");
    lawyer("BEA");
    member("m1", { assignedProviderId: "ANA", quotes: [{ quoteId: "q1", title: "Residency renewal filing", status: "pending_approval", providerIds: ["ANA"] }, { quoteId: "q2", title: "Old", status: "client_accepted", providerIds: ["ANA"] }] });
    world.put("consultations", "c1", { id: "c1", clientId: "m1", providerId: "ANA", matterId: "mat_m1", scheduledAt: "2026-11-04T15:00:00.000Z", durationMin: 20, status: "booked" });
    world.put("consultations", "c0", { id: "c0", clientId: "m1", providerId: "ANA", matterId: "mat_m1", scheduledAt: "2026-10-30T15:00:00.000Z", durationMin: 20, status: "completed", summary: { text: "x", status: "suggested" } });
    world.put("work_offers", "wof_1", { id: "wof_1", opportunityId: "opp_1", providerId: "ANA", clientId: "m1", title: "S.A. clean-up", area: "corporate", country: "CR", status: "offered", offeredAt: NOW, offeredBy: STAFF });
    assertEquals(await weeklyDigest(), { sent: 1 });
    assertEquals(await weeklyDigest(), { sent: 0 }, "once a week");
    const m = mailsTo("ana@lawyers-rt.io");
    assertEquals(m.length, 1);
    assertEquals(m[0].subject, "Your ILP week: 1 call, 1 summary to confirm, 1 open quote");
    for (const needle of ["Grace M1 Whitfield, DIMEX renewal", "Residency renewal filing for Grace M1 Whitfield: waiting for ILP approval", "1 offer waiting", "Summaries to confirm (1)"]) assert(m[0].text.includes(needle), needle);
    assert(!m[0].text.includes("Old for"), "accepted quotes are not open");
    assertEquals(mailsTo("bea@lawyers-rt.io").length, 0, "nothing to report");
    checkLawyerMail(m[0]);
  } finally {
    world.restore();
  }
});

// ─── Profile incomplete ────────────────────────────────────────────────────

Deno.test("profile incomplete: 3 days after approval, lists what is empty, once; complete or too early gets nothing", async () => {
  await world0();
  try {
    lawyer("ANA", { activatedAt: new Date(Date.parse(NOW) - 4 * DAY).toISOString(), bio: "", specialties: [] }, { hours: false });
    lawyer("BEA", { activatedAt: new Date(Date.parse(NOW) - 1 * DAY).toISOString(), bio: "" }, { hours: false });
    lawyer("CAM", { activatedAt: new Date(Date.parse(NOW) - 5 * DAY).toISOString() });
    assertEquals(profileGaps(world.doc("providers", "CAM")!, world.doc("lawyer_availability", "CAM")), []);
    assertEquals(await profileIncompleteSweep(new Date(NOW)), { sent: 1 });
    assertEquals(await profileIncompleteSweep(new Date(NOW)), { sent: 0 });
    const m = mailsTo("ana@lawyers-rt.io");
    assertEquals(m.length, 1);
    assertEquals(m[0].subject, "Finish your ILP profile so members can reach you");
    for (const needle of ["Your specialties (Profile)", "Your weekly hours (Availability)", "A short introduction", "/lawyer/profile"]) assert(m[0].text.includes(needle), needle);
    assert(!m[0].text.includes("languages you hold"), "languages are on file");
    assertEquals(mailsTo("bea@lawyers-rt.io").length + mailsTo("cam@lawyers-rt.io").length, 0);
    checkLawyerMail(m[0]);
  } finally {
    world.restore();
  }
});

// ─── Licence expiry ────────────────────────────────────────────────────────

Deno.test("licence expiring: 60 and 30 days before, lawyer and staff, once per stage", async () => {
  await world0();
  try {
    const at = (d: number) => new Date(Date.parse(NOW) + d * DAY).toISOString();
    assertEquals(licenceStage(at(61), new Date(NOW)), null);
    assertEquals(licenceStage(at(59), new Date(NOW)), { stage: 60, days: 59 });
    assertEquals(licenceStage(at(30), new Date(NOW)), { stage: 30, days: 30 });
    assertEquals(licenceStage(at(-1), new Date(NOW)), null);
    lawyer("ANA", { licences: [{ country: "CR", body: "Colegio de Abogados y Abogadas de Costa Rica", number: "12345", verified: true, expiresAt: at(59) }] });
    assertEquals(await licenceExpirySweep(new Date(NOW)), { lawyer: 1, staff: 1 });
    assertEquals(await licenceExpirySweep(new Date(Date.parse(NOW) + DAY)), { lawyer: 0, staff: 0 });
    assertEquals(await licenceExpirySweep(new Date(Date.parse(NOW) + 30 * DAY)), { lawyer: 1, staff: 1 });
    const m = mailsTo("ana@lawyers-rt.io");
    assertEquals(m.map((x) => x.subject), ["Your licence in Costa Rica expires on December 30, 2026", "Your licence in Costa Rica expires on December 30, 2026"]);
    assert(m[0].text.includes("in 59 days") && m[1].text.includes("in 29 days") && m[0].text.includes("partners@internationallegalpartner.com"));
    checkLawyerMail(m[0]);
    const staff = world.emails().filter((x) => String(x.to).includes(STAFF));
    assertEquals(staff.length, 2);
    assert(staff[0].subject.includes("Lawyer licence expires in 59 days: ANA Mora, Costa Rica"));
    assertEquals(world.all("notifications").filter((n) => n.to === "staff:*").length, 2);
  } finally {
    world.restore();
  }
});

// ─── Anonymization ─────────────────────────────────────────────────────────

Deno.test("anonymize: names, emails, phones, links and ID numbers dropped by sentence; own name becomes the lawyer; safe truncation", () => {
  const ctx = { dropNames: ["Grace Whitfield", "Robert"], ownNames: ["Ana Mora"] };
  assertEquals(anonymizeComment("Ana was very clear and kind.", ctx), "The lawyer was very clear and kind.");
  assertEquals(anonymizeComment("Clear answer. I spoke with Ana Mora about my renewal.", ctx), "Clear answer. I spoke with the lawyer about my renewal.");
  assertEquals(anonymizeComment("Great call. Call me at +1 555 201 3344 please.", ctx), "Great call.");
  assertEquals(anonymizeComment("Write to grace@mailbox-rt.io.", ctx), null);
  assertEquals(anonymizeComment("My passport 548812093 was fine. Helpful.", ctx), "Helpful.");
  assertEquals(anonymizeComment("Very helpful. My husband Robert agreed.", ctx), "Very helpful.");
  assertEquals(anonymizeComment("Grace here, thanks!", ctx), null);
  assertEquals(anonymizeComment("Useful. We live near Tamarindo and the beach.", ctx), "Useful.", "unknown capitalized words may be names or places");
  assertEquals(anonymizeComment("She explained the DIMEX renewal in March clearly.", ctx), "She explained the DIMEX renewal in March clearly.");
  assertEquals(anonymizeComment("See www.example.com for my notes. Good.", ctx), "Good.");
  assertEquals(anonymizeComment("Mrs. Lopez told me otherwise. Fine.", ctx), "Fine.");
  assertEquals(anonymizeComment("   ", ctx), null);
  const long = anonymizeComment(`${"The call was clear and useful. ".repeat(20)}`, { maxLength: 100 })!;
  assert(long.length <= 100 && long.endsWith("."), long);
  const words = anonymizeComment("word ".repeat(80), { maxLength: 60 })!;
  assert(words.endsWith("...") && words.length <= 63, words);
});

Deno.test("themes: concrete themes with constructive tips from comments; general when none match", () => {
  const t = themesFrom(["She was late and rushed me.", "Started late again", "Too much jargon", null]);
  assertEquals(t.map((x) => x.id), ["time", "clarity", "listening"]);
  assert(t.every((x) => x.tip.length > 20 && !PUNITIVE.test(x.tip)));
  assertEquals(themesFrom(["meh"]).map((x) => x.id), ["general"]);
});

// ─── Thresholds ────────────────────────────────────────────────────────────

Deno.test("thresholds: coaching below 70 with 5 reviews or 2 low scores in 30 days; recognition; config clamps and errors", () => {
  const cfg = LAWYER_FEEDBACK_DEFAULTS;
  const now = new Date(NOW);
  const ago = (d: number) => new Date(now.getTime() - d * DAY).toISOString();
  assertEquals(evaluateLawyer({ ratingScore: 65, reviewCount: 5 }, [], cfg, now).coaching, true);
  assertEquals(evaluateLawyer({ ratingScore: 65, reviewCount: 4 }, [], cfg, now).coaching, false, "too few reviews for the rating rule");
  assertEquals(evaluateLawyer({ ratingScore: 90, reviewCount: 9 }, [{ stars: 2, at: ago(3) }, { stars: 1, at: ago(20) }], cfg, now).coaching, true);
  assertEquals(evaluateLawyer({ ratingScore: 90, reviewCount: 9 }, [{ stars: 2, at: ago(3) }, { stars: 1, at: ago(40) }], cfg, now).coaching, false, "outside the window");
  const good = evaluateLawyer({ ratingScore: 95, reviewCount: 6 }, [{ stars: 5, at: ago(3) }], cfg, now);
  assertEquals([good.coaching, good.recognition], [false, true]);
  assertEquals(evaluateLawyer({ ratingScore: 95, reviewCount: 6 }, [{ stars: 2, at: ago(3) }], cfg, now).recognition, false, "a recent low score holds recognition");
  const strict = normalizeFeedbackConfig({ coachingBelowScore: 80, lowScoresCount: 3 });
  assertEquals(evaluateLawyer({ ratingScore: 75, reviewCount: 5 }, [], strict, now).coaching, true);
  assertEquals(evaluateLawyer({ ratingScore: 90, reviewCount: 9 }, [{ stars: 2, at: ago(3) }, { stars: 1, at: ago(20) }], strict, now).coaching, false);
  assertEquals(normalizeFeedbackConfig({ coachingBelowScore: 140, lowStars: "3", enabled: false }), { ...cfg, coachingBelowScore: 100, lowStars: 3, enabled: false });
  assertEquals(Object.keys(feedbackConfigErrors({ coachingMinReviews: 0, lowStars: 2.5, enabled: "yes" })).sort(), ["coachingMinReviews", "enabled", "lowStars"]);
  assertEquals(feedbackConfigErrors({ coachingBelowScore: 65 }), {});
  assertEquals(previousMonth(new Date(NOW)), "2026-10");
  assertEquals(previousMonth(new Date("2026-01-01T07:00:00.000Z")), "2025-12");
  assertEquals(monthBounds("2026-10").label, "October 2026");
  const v = feedbackView([{ stars: 5, at: ago(2), comment: "Clear." }, { stars: 4, at: ago(3), comment: "Kind." }], { from: now.getTime() - 30 * DAY, to: now.getTime(), periodLabel: "x", minReviewsToShowDetail: 3, ownNames: [] });
  assertEquals([v.tooFewToShow, v.averageStars, v.comments], [true, null, []], "too few: no average, no comments");
});

// ─── Monthly feedback and coaching ─────────────────────────────────────────

function reviews(pid: string, rows: Array<[number, number, string?, string?]>) {
  rows.forEach(([stars, daysAgo, comment, clientId], i) => {
    world.put("reviews", `rev_${pid}_${i}`, { id: `rev_${pid}_${i}`, providerId: pid, clientId: clientId ?? `m${i}`, consultationId: `c_${pid}_${i}`, stars, score100: (stars - 1) * 25, ...(comment ? { comment } : {}), at: new Date(Date.parse(NOW) - daysAgo * DAY).toISOString() });
  });
}

Deno.test("monthly feedback: own anonymized comments and star average, recognition for strong results, few reviews withheld, once a month", async () => {
  await world0();
  try {
    lawyer("ANA");
    lawyer("BEA");
    lawyer("CAM");
    member("m0");
    reviews("ANA", [[5, 5, "Ana explained everything. Grace M0 here, thanks!", "m0"], [5, 10, "Very clear about the renewal."], [4, 12, "Helpful, call me at 555 201 3344."], [5, 20]]);
    world.put("lawyer_ratings", "ANA", { providerId: "ANA", ratingScore: 93.8, reviewCount: 6, ratingStatus: "average", updatedAt: NOW });
    reviews("BEA", [[3, 6, "Bea was fine."]]);
    world.put("lawyer_ratings", "BEA", { providerId: "BEA", ratingScore: 91.7, reviewCount: 1, ratingStatus: "blended", updatedAt: NOW });
    reviews("CAM", [[5, 45, "Old review."]]);

    const r = await lawyerFeedbackSweep(new Date(NOW));
    assertEquals(r, { coached: 0, monthly: 2 });
    assertEquals((await monthlyFeedback(new Date(NOW))).sent, 0, "once a month");
    const ana = mailsTo("ana@lawyers-rt.io");
    assertEquals(ana.length, 1);
    assertEquals(ana[0].subject, "Thank you: your ILP member feedback for October 2026");
    const a = all(ana[0]);
    for (const needle of ["members reviewed 4 of your calls", "4.8 of 5 stars", "The lawyer explained everything.", "Very clear about the renewal.", "Thank you."]) assert(a.includes(needle), needle);
    for (const secret of ["Grace", "555 201", "BEA", "Bea", "93.8", "rating", "rank"]) assert(!a.includes(secret), `no ${secret}`);
    checkLawyerMail(ana[0]);
    const bea = mailsTo("bea@lawyers-rt.io");
    assertEquals(bea[0].subject, "Your ILP member feedback for October 2026");
    assert(bea[0].text.includes("members reviewed one of your calls") && bea[0].text.includes("at least 3 reviews") && !bea[0].text.includes("Bea was fine") && !bea[0].text.includes("stars."));
    assertEquals(mailsTo("cam@lawyers-rt.io").length, 0, "no review last month");
    assertEquals(world.all("lawyer_feedback").filter((x) => x.kind === "monthly").map((x) => [x.providerId, x.variant]).sort(), [["ANA", "recognition"], ["BEA", "standard"]]);
    assert(world.all("lawyer_feedback").every((x) => !JSON.stringify(x).includes("explained")), "no comments stored");
  } finally {
    world.restore();
  }
});

Deno.test("coaching: constructive email with themes and a call offer, staff alerted with a task, cooldown, thresholds from config", async () => {
  await world0();
  try {
    lawyer("ANA");
    lawyer("DOR");
    reviews("ANA", [[2, 3, "Started late and felt rushed."], [1, 9, "Too much jargon, I did not understand the next steps."], [5, 50]]);
    world.put("lawyer_ratings", "ANA", { providerId: "ANA", ratingScore: 77.5, reviewCount: 3, ratingStatus: "blended", updatedAt: NOW });
    reviews("DOR", [[2, 3, "Late."], [4, 9]]);
    world.put("lawyer_ratings", "DOR", { providerId: "DOR", ratingScore: 85, reviewCount: 2, ratingStatus: "blended", updatedAt: NOW });

    let r = await coachingCheck(new Date(NOW));
    assertEquals(r.coached, ["ANA"]);
    const m = mailsTo("ana@lawyers-rt.io");
    assertEquals(m.length, 1);
    assertEquals(m[0].subject, "Your recent ILP member feedback, and an offer of a call");
    const t = all(m[0]);
    for (const needle of ["Starting on time", "Clear explanations", "Time to listen", "partners@internationallegalpartner.com", "a short call"]) assert(t.includes(needle), needle);
    assert(!PUNITIVE.test(m[0].text), "never punitive");
    for (const secret of ["77.5", "jargon, I did", "rushed."]) assert(!t.includes(secret), `no ${secret}`);
    checkLawyerMail(m[0]);
    const bell = world.all("notifications").filter((n) => n.to === "staff:*").find((n) => n.kind === "lawyer.coaching")!;
    assert(bell.title === "Constructive feedback sent to ANA Mora" && bell.body.includes("2 reviews of 2 stars or fewer in 30 days"));
    assert(world.emails().some((x) => String(x.to).includes(STAFF) && x.subject.includes("Constructive feedback sent to ANA Mora")));
    const task = world.all("csm_tasks").find((x) => x.subject?.kind === "lawyer_feedback")!;
    assertEquals([task.clientId, task.ownerEmail, task.title], ["ANA", STAFF, "Offer a feedback call to ANA Mora"]);
    // Cooldown: the next days send nothing new.
    r = await coachingCheck(new Date(Date.parse(NOW) + 5 * DAY));
    assertEquals(r.coached, []);
    assertEquals(mailsTo("ana@lawyers-rt.io").length, 1);
    assertEquals(mailsTo("dor@lawyers-rt.io").length, 0, "one low score is not enough");
    // Thresholds come from the config doc: one low score now coaches DOR.
    world.put("lawyer_feedback_config", "default", { lowScoresCount: 1 });
    r = await coachingCheck(new Date(NOW));
    assertEquals(r.coached, ["DOR"]);
    // Switched off: nothing.
    world.put("lawyer_feedback_config", "default", { enabled: false });
    assertEquals((await coachingCheck(new Date(Date.parse(NOW) + 60 * DAY))).coached, []);
  } finally {
    world.restore();
  }
});

// ─── Routes: feedback page, config, work offers ────────────────────────────

const keysIn = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysIn(x, out));
  return out;
};

Deno.test("routes: lawyer feedback page (own only, no score), staff thresholds (admin), work offers accept and decline", async () => {
  await world0();
  try {
    const app = new FakeApp();
    for (const mod of ["../API/provider/providerDashboardRouter.ts", "../API/lawyerComms/lawyerCommsRouter.ts"]) (await import(mod)).default(app);
    const call = (token: string, method: string, url: string, body?: unknown) => app.call(method, url, { body, headers: { authorization: `Bearer ${token}` } });
    world.put("dashboard_sessions", "stf", { email: STAFF, expiresAt: "2030-01-01T00:00:00Z" });
    world.put("dashboard_sessions", "adm", { email: ADMIN, expiresAt: "2030-01-01T00:00:00Z" });
    lawyer("ANA", { legalAreas: ["immigration", "corporate"], specialties: ["residency_renewals", "company_annual_filings"] });
    lawyer("BEA", { legalAreas: ["corporate"], specialties: ["company_annual_filings"] });
    lawyer("PAZ", { jurisdictions: ["PA"], legalAreas: ["corporate"], specialties: ["company_annual_filings"] });
    lawyer("IMM", { legalAreas: ["immigration"] });
    member("m1");
    reviews("ANA", [[5, 5, "Clear and kind."], [4, 6, "Useful call."], [5, 7, "Explained the steps."]]);
    reviews("BEA", [[1, 5, "Secret comment for another lawyer."]]);
    world.put("lawyer_ratings", "ANA", { providerId: "ANA", ratingScore: 95, reviewCount: 3, ratingStatus: "blended", updatedAt: NOW });

    let r = await call("law_ANA", "GET", "/api/provider/feedback");
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals([r.body.recent.reviewsInPeriod, r.body.recent.averageStars, r.body.recent.comments.length], [3, 4.7, 3]);
    assertEquals(r.body.months.length, 6);
    assert(!JSON.stringify(r.body).includes("Secret comment"), "never another lawyer's reviews");
    for (const k of ["rating", "ratingScore", "reviewCount", "ratingStatus", "lawyerRating", "clientId"]) assert(!keysIn(r.body).has(k), `${k} in the lawyer feedback`);

    r = await call("stf", "GET", "/api/dashboard/lawyer-feedback/config");
    assertEquals([r.status, r.body.config.coachingBelowScore], [200, 70]);
    r = await call("stf", "PUT", "/api/dashboard/lawyer-feedback/config", { coachingBelowScore: 65 });
    assertEquals(r.status, 403, "admins edit thresholds");
    r = await call("adm", "PUT", "/api/dashboard/lawyer-feedback/config", { coachingBelowScore: 650 });
    assertEquals([r.status, Object.keys(r.body.errors)], [400, ["coachingBelowScore"]]);
    r = await call("adm", "PUT", "/api/dashboard/lawyer-feedback/config", { coachingBelowScore: 65 });
    assertEquals([r.status, r.body.config.coachingBelowScore, world.doc("lawyer_feedback_config", "default")!.updatedBy], [200, 65, ADMIN]);
    assert(world.all("audit_log").some((a) => a.action === "lawyer_feedback.config_updated"));

    // Work offers: only lawyers licensed in the country who take the area.
    world.put("opportunities", "opp_1", { id: "opp_1", clientId: "m1", matterId: "mat_m1", source: { kind: "manual" }, title: "S.A. clean-up and annual filings", area: "corporate", stage: "identified", valueCents: 150000, createdAt: NOW, updatedAt: NOW });
    r = await call("stf", "GET", "/api/dashboard/opportunities/opp_1/offers");
    assertEquals(r.body.candidates.map((c: { providerId: string }) => c.providerId), ["ANA", "BEA"]);
    r = await call("stf", "POST", "/api/dashboard/opportunities/opp_1/offer", { providerIds: ["IMM"] });
    assertEquals(r.status, 400, "a lawyer who does not fit");
    r = await call("stf", "POST", "/api/dashboard/opportunities/opp_1/offer", { description: "Two dormant companies, filings two years behind." });
    assertEquals([r.status, r.body.offered, r.body.offers.length], [200, 2, 2]);
    r = await call("stf", "POST", "/api/dashboard/opportunities/opp_1/offer", {});
    assertEquals([r.status, r.body.offered, r.body.skipped], [200, 0, 2], "no second offer to the same lawyer");
    const offerMail = mailsTo("bea@lawyers-rt.io").find((m) => m.subject.startsWith("Paid work"))!;
    assertEquals(offerMail.subject, "Paid work in your specialty: Companies, Costa Rica");
    assert(offerMail.text.includes("Two dormant companies") && offerMail.text.includes("/lawyer/work") && !offerMail.text.includes("Grace") && !offerMail.text.includes("1500"));
    checkLawyerMail(offerMail);
    assertEquals(mailsTo("paz@lawyers-rt.io").length + mailsTo("imm@lawyers-rt.io").length, 0);

    r = await call("law_BEA", "GET", "/api/provider/work-offers");
    assertEquals(r.body.offers.length, 1);
    for (const k of ["clientId", "valueCents", "providerId", "offeredBy"]) assert(!keysIn(r.body).has(k), `${k} in the lawyer offer`);
    const bid = r.body.offers[0].id;
    r = await call("law_ANA", "POST", `/api/provider/work-offers/${bid}/respond`, { action: "accept" });
    assertEquals(r.status, 404, "only your own offer");
    r = await call("law_BEA", "POST", `/api/provider/work-offers/${bid}/respond`, { action: "accept" });
    assertEquals([r.status, r.body.offer.status], [200, "accepted"]);
    assertEquals(world.doc("opportunities", "opp_1")!.providerId, "BEA");
    const anaOffer = world.all("work_offers").find((o) => o.providerId === "ANA")!;
    assertEquals(anaOffer.status, "taken");
    r = await call("law_ANA", "POST", `/api/provider/work-offers/${anaOffer.id}/respond`, { action: "accept" });
    assertEquals(r.status, 409);
    assert(world.all("notifications").filter((n) => n.to === "staff:*").some((n) => n.kind === "opportunity.accepted" && n.title === 'BEA Mora accepted "S.A. clean-up and annual filings"'));
    r = await call("stf", "POST", "/api/dashboard/opportunities/opp_1/offer", {});
    assertEquals(r.status, 409, "taken work is not offered again");
  } finally {
    world.restore();
  }
});
