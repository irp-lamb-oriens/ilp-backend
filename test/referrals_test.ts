// deno-lint-ignore no-import-prefix
import { assert, assertEquals, assertMatch, assertRejects } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { ReferralEngine, subjectFromEmail } from "../API/referrals/engine.ts";
import { MemoryReferralStore } from "../API/referrals/store.ts";
import { buildTrackedUrl, checkDestination, generateCode, slugify } from "../API/referrals/links.ts";
import { RULE_PRESETS } from "../API/referrals/rules.ts";
import { partnerRows, partnerStatement, yearReport } from "../API/referrals/reports.ts";
import { monthlyStatementEmail, usd } from "../API/referrals/emails.ts";
import { maskOf, seal, unseal } from "../API/referrals/crypto.ts";
import { previousMonth, referralMonthlyStatements } from "../API/referrals/jobs.ts";
import { ilpPaymentCollected, attributeIlp, refFromBody, setIlpReferralEngine } from "../API/referrals/ilpHooks.ts";
import { publicPartner } from "../API/referrals/referralsRouter.ts";

// Other test files set RENDER_EXTERNAL_URL (production mode), so give the bank-details key explicitly.
Deno.env.set("REFERRALS_BANK_KEY", "dGVzdC1vbmx5LXJlZmVycmFscy1iYW5rLWtleS0zMmI=");

const ADMIN = { uid: "admin@internationallegalpartner.com", email: "admin@internationallegalpartner.com", role: "admin" };
const preset = (key: string) => {
  const { key: _k, description: _d, ...rest } = RULE_PRESETS.find((p) => p.key === key)!;
  return rest;
};

function world(start = "2026-01-05T12:00:00.000Z") {
  let clock = start;
  let n = 0;
  const store = new MemoryReferralStore();
  const engine = new ReferralEngine(store, { now: () => clock, newId: (p) => `${p}_${++n}`, minPayoutCents: 2500 });
  return { store, engine, set: (iso: string) => (clock = iso) };
}

async function teacher(w: ReturnType<typeof world>) {
  const rule = await w.engine.createRule(preset("ilp_monthly_30"), ADMIN);
  const p = await w.engine.createPartner({ name: "Profe Ana Rojas", email: "Ana@School.cr", type: "teacher", brands: ["ilp"], ruleIds: { ilp: rule.id } }, ADMIN);
  const link = await w.engine.createLink({ partnerId: p.id, brand: "ilp", destination: "https://internationallegalpartner.com/check", campaign: "Maestros 2026" }, ADMIN);
  return { rule, p, link };
}

Deno.test("referrals: codes, UTM and destinations", async () => {
  assertEquals(slugify("Sara Elena Mora Ñúñez!"), "sara-elena-mora-nunez");
  const taken = new Set<string>();
  const c1 = await generateCode("Sara", "ilp", (c) => Promise.resolve(taken.has(c)));
  taken.add(c1);
  const c2 = await generateCode("Sara", "ilp", (c) => Promise.resolve(taken.has(c)));
  assertEquals([c1, c2], ["sara", "sara-ilp"]);
  await assertRejects(() => generateCode("x", "ilp", () => Promise.resolve(false), "dashboard"));
  const url = new URL(buildTrackedUrl("https://internationallegalpartner.com/check?x=1#a", "sara", { source: "sara", medium: "teacher", campaign: "maestros" }));
  assertEquals([url.searchParams.get("ref"), url.searchParams.get("utm_medium"), url.searchParams.get("x"), url.hash], ["sara", "teacher", "1", "#a"]);
  assertEquals(checkDestination("https://www.internationallegalpartner.com/", "ilp"), "https://www.internationallegalpartner.com/");
  let refused = false;
  try {
    checkDestination("https://evil.com/", "ilp");
  } catch {
    refused = true;
  }
  assert(refused);
});

Deno.test("referrals: teacher earns US$30 per paid ILP month, never on activation or legal work, then is paid", async () => {
  const w = world();
  const { p, link } = await teacher(w);
  assertEquals(p.email, "ana@school.cr");
  assertEquals(link.code, "profe-ana-rojas");
  assertMatch(link.url, /utm_campaign=maestros-2026/);

  assertEquals((await w.engine.resolveCode(link.code))?.url, link.url);
  assertEquals((await w.store.getLink(link.id))?.clicks, 1);

  const clientId = subjectFromEmail("member@x.com");
  const r = await w.engine.attribute({ brand: "ilp", clientId, email: "member@x.com", refCode: link.code, refAt: "2026-01-02T00:00:00.000Z" });
  assertEquals(r?.partnerId, p.id);

  const first = await w.engine.recordSale({ brand: "ilp", saleRef: "ilp:mem:m1:initial", clientId, amountCents: 17999, activationCents: 10000, kind: "initial", paidAt: "2026-01-09T12:00:00.000Z" });
  assertEquals([first.reason, first.commission?.amountCents], ["earned", 3000]);
  assertEquals((await w.engine.recordSale({ brand: "ilp", saleRef: "ilp:mem:m1:initial", clientId, amountCents: 17999, kind: "initial", paidAt: "2026-01-09T12:00:00.000Z" })).reason, "duplicate");
  assertEquals((await w.engine.recordSale({ brand: "ilp", saleRef: "quote:1", clientId, amountCents: 90000, kind: "one_time", paidAt: "2026-01-20T12:00:00.000Z" })).reason, "not_membership");
  assertEquals((await w.engine.recordSale({ brand: "ilp", saleRef: "ilp:mem:m1:2026-02-09", clientId, amountCents: 7999, kind: "renewal", paidAt: "2026-02-09T12:00:00.000Z" })).commission?.amountCents, 3000);

  w.set("2026-02-10T00:00:00.000Z");
  assertEquals(await w.engine.approveDue(), 1);
  w.set("2026-03-12T00:00:00.000Z");
  assertEquals(await w.engine.approveDue(), 1);

  let preview = await w.engine.previewPayouts();
  assertEquals(preview.ready.length, 0);
  assertEquals(preview.held[0].why, "No payment details yet");

  const saved = await w.engine.setPayoutDetails(p.id, { method: "sinpe", holderName: "Ana Rojas", phone: "8888-1234", taxId: "1-1111-1111" }, { uid: p.id, email: p.email, role: "partner" });
  assertEquals(saved.status, "active");
  assertEquals(saved.payout?.mask, "••••1234");
  assert(!JSON.stringify(publicPartner(saved)).includes("sealed"));
  assertEquals((await w.engine.revealPayoutDetails(p.id, ADMIN)).phone, "8888-1234");

  preview = await w.engine.previewPayouts();
  assertEquals(preview.ready[0].totalCents, 6000);
  const payout = await w.engine.recordPayout({ partnerId: p.id, reference: "SINPE-778" }, ADMIN);
  assertEquals([payout.totalCents, payout.method], [6000, "sinpe"]);

  const st = (await partnerStatement(w.store, p.id, { now: "2026-03-12T00:00:00.000Z" }))!;
  assertEquals([st.lifetime.leads, st.lifetime.customers, st.lifetime.earnedCents, st.lifetime.paidCents, st.lifetime.pendingCents], [1, 1, 6000, 6000, 0]);
  assertEquals(st.months.map((m) => m.earnedCents), [3000, 3000, 0]);
  assertEquals(st.payouts[0].reference, "SINPE-778");
  assert(!JSON.stringify(st).includes("member@x.com"));

  const actions = w.store.auditLog.map((a) => a.action);
  for (const a of ["referral.rule_created", "referral.partner_created", "referral.link_created", "referral.commission_earned", "referral.payout_details_saved", "referral.payout_details_viewed", "referral.payout_recorded"]) {
    assert(actions.includes(a), a);
  }
});

Deno.test("referrals: first partner keeps the person, self-referral ignored, expired cookie ignored, manual reassignment audited", async () => {
  const w = world();
  const rule = await w.engine.createRule(preset("ilp_monthly_30"), ADMIN);
  const a = await w.engine.createPartner({ name: "Ana", email: "ana@x.com", type: "teacher", brands: ["ilp"], ruleIds: { ilp: rule.id } }, ADMIN);
  const b = await w.engine.createPartner({ name: "Beto", email: "beto@x.com", type: "media", brands: ["ilp"], ruleIds: { ilp: rule.id } }, ADMIN);
  const la = await w.engine.createLink({ partnerId: a.id, brand: "ilp", destination: "https://internationallegalpartner.com/" }, ADMIN);
  const lb = await w.engine.createLink({ partnerId: b.id, brand: "ilp", destination: "https://internationallegalpartner.com/" }, ADMIN);
  const c = subjectFromEmail("p@x.com");
  const r1 = await w.engine.attribute({ brand: "ilp", clientId: c, email: "p@x.com", refCode: la.code });
  const r2 = await w.engine.attribute({ brand: "ilp", clientId: c, email: "p@x.com", refCode: lb.code });
  assertEquals([r1?.partnerId, r2?.partnerId], [a.id, a.id]);
  assertEquals(await w.engine.attribute({ brand: "ilp", clientId: subjectFromEmail("ana@x.com"), email: "ANA@x.com", refCode: la.code }), null);
  assertEquals(await w.engine.attribute({ brand: "ilp", clientId: "old", refCode: la.code, refAt: "2025-09-01T00:00:00.000Z" }), null);
  const moved = await w.engine.assignManually({ brand: "ilp", clientId: c, partnerId: b.id, reason: "Llamó y dijo que lo mandó Beto" }, ADMIN);
  assertEquals(moved.partnerId, b.id);
  const e = w.store.auditLog.find((x) => x.action === "referral.assigned_manually")!;
  assertEquals([e.meta?.from, e.meta?.to], [a.id, b.id]);
  await w.engine.updatePartner(a.id, { status: "paused" }, ADMIN);
  assertEquals(await w.engine.resolveCode(la.code), null);
});

Deno.test("referrals: refunds reverse unpaid lines and claw back paid ones once", async () => {
  const w = world();
  const { p } = await teacher(w);
  await w.engine.setPayoutDetails(p.id, { method: "wire", holderName: "Ana", account: "CR05015202001026284066", bankName: "BN" }, ADMIN);
  await w.engine.assignManually({ brand: "ilp", clientId: "C1", partnerId: p.id, reason: "test" }, ADMIN);
  await w.engine.recordSale({ brand: "ilp", saleRef: "s1", clientId: "C1", amountCents: 7999, kind: "initial", paidAt: "2026-01-05T12:00:00.000Z" });
  await w.engine.recordSale({ brand: "ilp", saleRef: "s2", clientId: "C1", amountCents: 7999, kind: "renewal", paidAt: "2026-02-05T12:00:00.000Z" });
  assertEquals((await w.engine.refundSale({ brand: "ilp", saleRef: "s2", reason: "refund" }, ADMIN))[0].status, "reversed");
  w.set("2026-02-10T00:00:00.000Z");
  await w.engine.approveDue();
  await w.engine.recordPayout({ partnerId: p.id, reference: "BN-1" }, ADMIN);
  const claw = await w.engine.refundSale({ brand: "ilp", saleRef: "s1", reason: "chargeback" }, ADMIN);
  assertEquals([claw[0].amountCents, claw[0].status], [-3000, "approved"]);
  assertEquals((await w.engine.refundSale({ brand: "ilp", saleRef: "s1", reason: "again" }, ADMIN)).length, 0);
  assertEquals((await w.engine.previewPayouts()).held[0].why, "Balance is zero or negative (refunds)");
  await assertRejects(() => w.engine.recordPayout({ partnerId: p.id, reference: "BN-2" }, ADMIN));
  const st = (await partnerStatement(w.store, p.id, { now: "2026-02-10T00:00:00.000Z" }))!;
  assertEquals([st.lifetime.earnedCents, st.lifetime.reversedCents, st.lifetime.pendingCents, st.lifetime.paidCents], [0, 3000, -3000, 3000]);
});

Deno.test("referrals: expert 50% on an IRP sale reported by the ingest API with the ref code; duration and first-month rules", async () => {
  const w = world();
  const half = await w.engine.createRule(preset("half"), ADMIN);
  const e = await w.engine.createPartner({ name: "Lic. Mora", email: "mora@law.cr", type: "expert", brands: ["irp"], ruleIds: { irp: half.id } }, ADMIN);
  const link = await w.engine.createLink({ partnerId: e.id, brand: "irp", destination: "https://internationalrelocationpartner.com/" }, ADMIN);
  const out = await w.engine.recordSale({ brand: "irp", saleRef: "irp_1", clientId: subjectFromEmail("buyer@x.com"), email: "buyer@x.com", amountCents: 250000, kind: "one_time", paidAt: "2026-01-05T12:00:00.000Z", refCode: link.code });
  assertEquals(out.commission?.amountCents, 125000);

  const firstMonth = await w.engine.createRule(preset("ilp_first_month"), ADMIN);
  const yearOnly = await w.engine.createRule({ ...preset("ilp_monthly_30"), durationMonths: 12 }, ADMIN);
  const f = await w.engine.createPartner({ name: "Full", email: "f@x.com", type: "influencer", brands: ["ilp"], ruleIds: { ilp: firstMonth.id } }, ADMIN);
  const y = await w.engine.createPartner({ name: "Year", email: "y@x.com", type: "influencer", brands: ["ilp"], ruleIds: { ilp: yearOnly.id } }, ADMIN);
  await w.engine.assignManually({ brand: "ilp", clientId: "F1", partnerId: f.id, reason: "t" }, ADMIN);
  await w.engine.assignManually({ brand: "ilp", clientId: "Y1", partnerId: y.id, reason: "t" }, ADMIN);
  assertEquals((await w.engine.recordSale({ brand: "ilp", saleRef: "f1", clientId: "F1", amountCents: 17999, activationCents: 10000, kind: "initial", paidAt: "2026-01-31T00:00:00.000Z" })).commission?.amountCents, 7999);
  assertEquals((await w.engine.recordSale({ brand: "ilp", saleRef: "f2", clientId: "F1", amountCents: 7999, kind: "renewal", paidAt: "2026-02-28T00:00:00.000Z" })).reason, "not_first_sale");
  await w.engine.recordSale({ brand: "ilp", saleRef: "y1", clientId: "Y1", amountCents: 17999, activationCents: 10000, kind: "initial", paidAt: "2026-01-31T12:00:00.000Z" });
  assertEquals((await w.engine.recordSale({ brand: "ilp", saleRef: "y12", clientId: "Y1", amountCents: 7999, kind: "renewal", paidAt: "2026-12-31T12:00:00.000Z" })).commission?.amountCents, 3000);
  assertEquals((await w.engine.recordSale({ brand: "ilp", saleRef: "y13", clientId: "Y1", amountCents: 7999, kind: "renewal", paidAt: "2027-01-31T12:00:00.000Z" })).reason, "duration_ended");
});

Deno.test("referrals: Sara's history import gives the lifetime total; statement email; monthly job", async () => {
  const w = world("2026-11-09T12:00:00.000Z");
  const half = await w.engine.createRule(preset("half"), ADMIN);
  const sara = await w.engine.createPartner({ name: "Sara Elena", email: "sara@gmail.com", type: "referrer", brands: ["irp", "ilp"], ruleIds: { irp: half.id } }, ADMIN);
  const rows = ["2023-11-15", "2024-03-02", "2024-08-20", "2025-02-11", "2025-09-30", "2026-04-18"].map((date, i) => ({
    partnerEmail: "sara@gmail.com", brand: "irp", date, amount: 1500 + i * 100, reference: `BN-${i}`, clientLabel: `Cliente ${i + 1}`,
  }));
  const res = await w.engine.importHistory([...rows, { partnerEmail: "nadie@x.com", brand: "irp", date: "2024-01-01", amount: 1 }], ADMIN);
  assertEquals([res.lines, res.payouts, res.skipped.length], [6, 6, 1]);
  assertEquals((await w.engine.importHistory(rows, ADMIN)).lines, 0);

  await w.engine.assignManually({ brand: "irp", clientId: "irp_77", partnerId: sara.id, reason: "historic referrer" }, ADMIN);
  await w.engine.recordSale({ brand: "irp", saleRef: "irp_s77", clientId: "irp_77", amountCents: 300000, kind: "one_time", paidAt: "2026-10-20T12:00:00.000Z" });

  const st = (await partnerStatement(w.store, sara.id, { now: "2026-11-09T12:00:00.000Z" }))!;
  assertEquals(st.partner.startedAt.slice(0, 10), "2023-11-15");
  assertEquals([st.lifetime.paidCents, st.lifetime.pendingCents, st.relationshipYears], [1_050_000, 150_000, 3]);
  assertEquals(usd(st.lifetime.paidCents), "US$10,500");

  const mail = monthlyStatementEmail(st, "2026-10", "https://internationallegalpartner.com/partners");
  assertEquals(mail.subject, "Su resumen de octubre 2026: US$10,500 transferidos desde noviembre 2023");
  assertMatch(mail.text, /Desde noviembre 2023 nos ha enviado 1 persona y 1 cliente, y le hemos transferido US\$10,500\./);
  assertMatch(mail.text, /Ganado en octubre 2026: US\$1,500/);

  assertEquals(previousMonth(new Date("2026-11-01T15:00:00Z")), "2026-10");
  const sent: string[] = [];
  const n = await referralMonthlyStatements(w.store, new Date("2026-11-01T15:00:00Z"), (m, key) => {
    sent.push(`${m.to}|${key}`);
    return Promise.resolve();
  });
  assertEquals(n, 1);
  assertEquals(sent, [`sara@gmail.com|ref_stmt_${sara.id}_2026-10`]);

  const rows2 = await partnerRows(w.store);
  assertEquals(rows2[0].paidCents, 1_050_000);
  const rep = await yearReport(w.store, 2026);
  assertEquals(rep.totals.paidCents, 200_000);
  assertEquals(rep.months[9].earnedCents, 150_000);
  assertEquals((await yearReport(w.store, 2026, { brand: "ilp" })).rows.length, 0);
});

Deno.test("referrals: ILP hooks never throw and map membership payments", async () => {
  const w = world();
  const { p, link } = await teacher(w);
  setIlpReferralEngine(w.engine);
  try {
    assertEquals(refFromBody({ ref: " Profe-Ana-Rojas ", refAt: "2026-01-01T00:00:00Z" }), { refCode: "profe-ana-rojas", refAt: "2026-01-01T00:00:00Z" });
    assertEquals(refFromBody({ ref: "<script>" }), {});
    const clientId = subjectFromEmail("m@x.com");
    await attributeIlp({ clientId, email: "m@x.com", leadId: "lead_1", body: { ref: link.code } });
    await ilpPaymentCollected({ membershipId: "mem_1", clientId, kind: "initial" });
    await ilpPaymentCollected({ membershipId: "mem_1", clientId, kind: "initial" }); // replay
    await ilpPaymentCollected({ membershipId: "mem_1", clientId, kind: "renewal", periodStart: "2026-02-05T00:00:00.000Z" });
    const lines = await w.store.listCommissions({ partnerId: p.id });
    assertEquals(lines.map((c) => c.amountCents), [3000, 3000]);
    await ilpPaymentCollected({ membershipId: "", clientId: "", kind: "initial" }); // bad input: logged, not thrown
  } finally {
    setIlpReferralEngine(null);
  }
});

Deno.test("referrals: bank details are sealed and masked", async () => {
  const s = await seal({ account: "CR05015202001026284066" });
  assert(s.startsWith("v1:") && !s.includes("CR0501"));
  assertEquals((await unseal(s)).account, "CR05015202001026284066");
  assertEquals(maskOf("CR05 0152 0200 1026 2840 66"), "••••4066");
});
