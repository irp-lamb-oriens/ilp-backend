import { assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  ABSENT,
  AccountGuardError,
  type AccountIds,
  applyWrite,
  checkAccountPlan,
  crDay,
  getPath,
  isEmptyValue,
  planAccountSeed,
  planMerge,
  planRestore,
  type RealDocs,
  screenReport,
  stableJson,
} from "../scripts/accountSeedOps.ts";
import { accountBatch, buildAccountData, DEFAULT_ACCOUNTS, parseAccountArgs } from "../scripts/seedAccounts.ts";
import { selectAccountDeletion } from "../scripts/placeholderOps.ts";
import { buildTask } from "../API/members/events.ts";
import type { Doc } from "../scripts/placeholderData.ts";

/**
 * Account seed (scripts/seedAccounts.ts + scripts/accountSeedOps.ts): offline, no Firestore.
 * Run: deno test --allow-env --allow-read test/seedAccounts_test.ts
 */

const NOW = new Date("2026-10-27T16:00:00Z"); // Tuesday, 10:00 in Costa Rica
const cli = parseAccountArgs([]);
if ("error" in cli) throw new Error(cli.error);
const ids: AccountIds = {
  lawyerId: "prov_pablo",
  memberId: "admin_internationallegalpartner_com",
  lawyerEmail: DEFAULT_ACCOUNTS.lawyer,
  staffEmail: DEFAULT_ACCOUNTS.staff,
  memberEmail: DEFAULT_ACCOUNTS.member,
};

/** Real docs shaped like production (seedPabloAndAdmin.ts / seedAdminClient.ts). */
const realMember = (): Doc => ({
  name: "Admin",
  surname: "Account",
  email: DEFAULT_ACCOUNTS.member,
  dripEmail: DEFAULT_ACCOUNTS.member,
  legalArea: "corporate",
  jurisdiction: "Panama",
  stage: "quote_sent",
  assignedProviderId: "prov_pablo",
  phone: "",
  nationality: null,
  clientFields: { fullName: "Admin Account", phone: "" },
  charges: [{ id: "chg_1", label: "Corporate structuring retainer", total: 3000, payments: [{ id: "pay_1", amount: 1500 }] }],
  statusComments: [{ id: "c_real_1", author: "ana@internationallegalpartner.com", body: "Real message", createdAt: "2026-10-01T10:00:00.000Z" }],
  quotes: [],
  deadlines: { residency_renewal: { date: "2027-01-15", note: "Residency card renewal" } },
  consultations: [{ name: "Admin", source: "seed_admin_client", timestamp: "2026-10-20T10:00:00.000Z" }],
  createdAt: "2026-01-01T00:00:00.000Z",
});
const realLawyer = (): Doc => ({
  id: "prov_pablo",
  name: "Pablo Oriens",
  email: DEFAULT_ACCOUNTS.lawyer,
  phone: "+506 7108 6045",
  legalAreas: ["corporate", "compliance", "real_estate", "immigration", "tax"],
  jurisdictions: ["Panama", "Costa Rica"],
  bio: "Real bio.",
  active: true,
  score: 4.6,
  notes: "",
});
const realAvailability = (): Doc => ({ providerId: "prov_pablo", timezone: "America/Costa_Rica", weekly: [{ day: 1, start: "09:00", end: "12:00" }] });
const real = (): RealDocs => ({ lawyer: realLawyer(), member: realMember(), availability: realAvailability(), memberHasRealMembership: false });

const data = buildAccountData(cli, ids, { lawyer: realLawyer(), member: realMember() }, NOW);
const plan = planAccountSeed(data, ids, real(), data.now);
const merged = (col: string, id: string, doc: Doc) => applyWrite(doc, plan.merges.find((m) => m.collection === col && m.id === id)!);

/** Every non-empty field of `before` is unchanged in `after` (arrays: real elements kept in order). */
function assertRealKept(before: Doc, after: Doc, path = "") {
  for (const [k, v] of Object.entries(before)) {
    const p = path ? `${path}.${k}` : k;
    if (isEmptyValue(v)) continue;
    const a = after[k];
    if (Array.isArray(v)) {
      assertEquals(Array.isArray(a), true, p);
      assertEquals(stableJson((a as unknown[]).slice(0, v.length)), stableJson(v), p);
    } else if (v && typeof v === "object" && a && typeof a === "object" && !Array.isArray(a)) assertRealKept(v as Doc, a as Doc, p);
    else assertEquals(stableJson(a), stableJson(v), p);
  }
}

Deno.test("accounts: defaults, flags and errors", () => {
  if ("error" in cli) throw new Error();
  assertEquals([cli.lawyerEmail, cli.staffEmail, cli.memberEmail], [DEFAULT_ACCOUNTS.lawyer, DEFAULT_ACCOUNTS.staff, DEFAULT_ACCOUNTS.member]);
  assertEquals([cli.dryRun, cli.seed, accountBatch(cli.seed)], [false, 7, "ph-accounts-7"]);
  const o = parseAccountArgs(["--dry-run", "--seed=3", "--member-email= Someone@Gmail.com ", "--confirm-project=p1"]);
  assertEquals("error" in o ? o.error : [o.dryRun, o.seed, o.memberEmail, o.confirmProject], [true, 3, "someone@gmail.com", "p1"]);
  assertEquals("error" in parseAccountArgs(["--lawyer-email=nope"]), true);
  assertEquals("error" in parseAccountArgs([`--staff-email=${DEFAULT_ACCOUNTS.member}`]), true);
});

Deno.test("accounts: real docs are merged, never replaced; only empty fields are filled", () => {
  const targets = plan.merges.map((m) => `${m.collection}/${m.id}`).sort();
  assertEquals(targets, ["clients/admin_internationallegalpartner_com", "lawyer_availability/prov_pablo", "providers/prov_pablo"]);
  assertEquals(plan.creates.some((w) => [ids.memberId, ids.lawyerId].includes(w.id) && ["clients", "providers", "lawyer_availability"].includes(w.collection)), false);
  checkAccountPlan(plan, ids, real());
  for (const [col, id, before] of [["clients", ids.memberId, realMember()], ["providers", ids.lawyerId, realLawyer()], ["lawyer_availability", ids.lawyerId, realAvailability()]] as const) {
    const after = merged(col, id, before);
    assertRealKept(before, after);
    for (const k of ["placeholder", "placeholderBatch", "placeholderAlias"]) assertEquals(k in after, false, `${col} ${k}`);
  }
  const m = merged("clients", ids.memberId, realMember());
  // Empty real fields are filled; non-empty ones keep their real value.
  assertEquals([m.name, m.jurisdiction, m.stage, m.assignedProviderId], ["Admin", "Panama", "quote_sent", "prov_pablo"]);
  assertEquals(typeof m.phone === "string" && m.phone !== "", true);
  assertEquals(m.nationality !== null, true);
  assertEquals(m.csmEmail, DEFAULT_ACCOUNTS.staff);
  assertEquals((m.clientFields as Doc).fullName, "Admin Account");
  assertEquals(((m.clientFields as Doc).phone as string).length > 0, true);
  assertEquals(stableJson(m.deadlines), stableJson(realMember().deadlines));
  // Appended elements: placeholder: true and ph_ ids; the real element is first and untouched.
  const comments = m.statusComments as Doc[];
  assertEquals(comments[0].id, "c_real_1");
  assertEquals(comments.length > 15, true);
  for (const k of ["statusComments", "charges", "quotes", "notes", "statusChatThread", "activityLog"]) {
    const added = (m[k] as Doc[]).filter((e) => e.placeholder === true);
    assertEquals(added.length > 0, true, k);
    for (const e of added) assertEquals(String(e.id).startsWith("ph_"), true, `${k} ${e.id}`);
  }
  assertEquals((m.charges as Doc[])[0].id, "chg_1");
  // Pablo: real name, phone and bio stay.
  const p = merged("providers", ids.lawyerId, realLawyer());
  assertEquals([p.name, p.phone, p.bio, p.score], ["Pablo Oriens", "+506 7108 6045", "Real bio.", 4.6]);
  assertEquals(p.notes, ""); // never filled with the placeholder note
  const a = merged("lawyer_availability", ids.lawyerId, realAvailability());
  assertEquals(stableJson(a.weekly), stableJson(realAvailability().weekly));
  assertEquals((a.blackoutDates as string[]).length > 0 && (a.specialties as string[]).length > 0, true);
});

Deno.test("accounts: placeholderFields, prior values and seeded values are recorded", () => {
  const m = merged("clients", ids.memberId, realMember());
  const fields = m.placeholderFields as string[];
  for (const k of ["csmEmail", "phone", "nationality", "clientFields.phone", "statusComments", "charges", "quotes", "statusChatThread"]) assertEquals(fields.includes(k), true, k);
  for (const k of ["name", "stage", "jurisdiction", "deadlines", "email", "clientFields.fullName"]) assertEquals(fields.includes(k), false, k);
  const prior = m.placeholderPrior as Doc;
  assertEquals([prior.csmEmail, prior.phone, prior.nationality, prior.quotes, prior["clientFields.phone"]], [ABSENT, "", null, [], ""]);
  assertEquals("statusComments" in prior, false); // had real elements: only appended to
  assertEquals((m.placeholderValues as Doc).csmEmail, JSON.stringify(DEFAULT_ACCOUNTS.staff));
  assertEquals(m.placeholderAccountBatch, "ph-accounts-7");
  // The guard refuses to overwrite a real value or to mark a real doc as placeholder.
  const bad = structuredClone(plan);
  bad.merges.find((x) => x.collection === "clients")!.set.name = "Not Admin";
  assertThrows(() => checkAccountPlan(bad, ids, real()), AccountGuardError);
  const bad2 = structuredClone(plan);
  bad2.merges.find((x) => x.collection === "clients")!.set.placeholder = true;
  assertThrows(() => checkAccountPlan(bad2, ids, real()), AccountGuardError);
  const bad3 = structuredClone(plan);
  bad3.creates.push({ collection: "clients", id: "someone_real_com", doc: { placeholder: true } });
  assertThrows(() => checkAccountPlan(bad3, ids, real()), AccountGuardError);
});

Deno.test("accounts: cleanup restores the real docs exactly; later real changes survive", () => {
  for (const [col, id, before] of [["clients", ids.memberId, realMember()], ["providers", ids.lawyerId, realLawyer()], ["lawyer_availability", ids.lawyerId, realAvailability()]] as const) {
    const after = merged(col, id, before);
    const back = applyWrite(after, planRestore(col, id, after));
    assertEquals(stableJson(back), stableJson(before), col);
  }
  // A person edits a seeded field and posts a real message after the seed: both stay.
  const after = merged("clients", ids.memberId, realMember());
  after.csmEmail = "carla@internationallegalpartner.com";
  (after.statusComments as Doc[]).push({ id: "c_real_2", author: DEFAULT_ACCOUNTS.member, body: "Real reply" });
  (after.quotes as Doc[]).push({ id: "q_real", status: "sent" });
  const w = planRestore("clients", ids.memberId, after);
  assertEquals(w.kept, ["csmEmail"]);
  const back = applyWrite(after, w);
  assertEquals(back.csmEmail, "carla@internationallegalpartner.com");
  assertEquals((back.statusComments as Doc[]).map((c) => c.id), ["c_real_1", "c_real_2"]);
  assertEquals((back.quotes as Doc[]).map((c) => c.id), ["q_real"]);
  assertEquals(Object.keys(back).some((k) => k.startsWith("placeholder")), false);
  assertEquals(getPath(back, "clientFields.phone"), "");
});

Deno.test("accounts: a re-run restores then merges, giving the same document", () => {
  const once = merged("clients", ids.memberId, realMember());
  const restored = applyWrite(once, planRestore("clients", ids.memberId, once));
  const again = applyWrite(restored, planMerge("clients", ids.memberId, restored, data.collections.clients.find((c) => c.id === ids.memberId)!, data.batch, data.now));
  assertEquals(stableJson(again), stableJson(once));
  const d2 = buildAccountData(cli, ids, { lawyer: realLawyer(), member: realMember() }, NOW);
  assertEquals(JSON.stringify(d2), JSON.stringify(data));
});

Deno.test("accounts: creates are ph_ placeholder docs; missing account docs are created as placeholders", () => {
  for (const w of plan.creates) {
    assertEquals(String(w.id).startsWith("ph_"), true, `${w.collection}/${w.id}`);
    assertEquals(w.doc.placeholder, true);
    assertEquals(w.doc.placeholderBatch, "ph-accounts-7");
  }
  const none: RealDocs = { lawyer: null, member: null, availability: null, memberHasRealMembership: true };
  const p2 = planAccountSeed(data, ids, none, data.now);
  checkAccountPlan(p2, ids, none);
  assertEquals(p2.merges.length, 0);
  assertEquals(p2.allowed.map(([c, i]) => `${c}/${i}`).sort(), ["clients/admin_internationallegalpartner_com", "lawyer_availability/prov_pablo", "providers/prov_pablo"]);
  for (const [c, i] of p2.allowed) assertEquals(p2.creates.find((w) => w.collection === c && w.id === i)!.doc.placeholderAccount, true);
  // A real membership wins over the seed's.
  assertEquals(p2.creates.some((w) => w.collection === "memberships" && w.doc.clientId === ids.memberId), false);
});

Deno.test("accounts: every listed screen has data for its account", () => {
  const rows = screenReport(data, ids);
  for (const r of rows) assertEquals(r.count > 0, true, `${r.account} ${r.screen}`);
  const n = (a: string, s: string) => rows.find((r) => r.account === a && r.screen.startsWith(s))!.count;
  const C = data.collections;
  // Lawyer
  const lm = C.matters.filter((m) => m.assignedProviderId === ids.lawyerId);
  assertEquals(new Set(lm.map((m) => m.stage)).size >= 6, true);
  const clientsL = n("lawyer", "Clients list");
  assertEquals(clientsL >= 20 && clientsL <= 30, true, `lawyer clients ${clientsL}`);
  const age = (m: Doc) => (NOW.getTime() - Date.parse(String(m.stageEnteredAt))) / 86_400_000;
  const open = lm.filter((m) => !m.closedAt);
  assertEquals([open.some((m) => age(m) < 7), open.some((m) => age(m) >= 7 && age(m) < 14), open.some((m) => age(m) >= 14)], [true, true, true]);
  const pay = C.quoteSettlements.flatMap((s) => (s.providerPayments as Doc[]).filter((p) => p.providerId === ids.lawyerId));
  assertEquals([pay.some((p) => p.paid), pay.some((p) => !p.paid), new Set(pay.map((p) => String(p.date).slice(0, 7))).size >= 5], [true, true, true]);
  for (const p of pay) assertEquals("marginPct" in p || "costSubtotal" in p, false);
  // Staff
  const q = n("staff", "Today: My queue");
  assertEquals(q >= 15 && q <= 25, true, `queue ${q}`);
  const mine = C.csm_tasks.filter((t) => t.status === "open" && t.ownerEmail === ids.staffEmail);
  assertEquals(new Set(mine.map((t) => t.type)).size, 7);
  assertEquals(mine.some((t) => String(t.dueAt) < NOW.toISOString()), true);
  assertEquals(mine.some((t) => String(t.dueAt).slice(0, 10) === NOW.toISOString().slice(0, 10)), true);
  const members = n("staff", "Members");
  assertEquals(members >= 40 && members <= 60, true);
  assertEquals(new Set(C.memberships.map((m) => m.status)).size >= 4, true);
  const opps = C.opportunities;
  assertEquals(new Set(opps.map((o) => o.stage)).size, 5);
  assertEquals(opps.filter((o) => o.ownerEmail === ids.staffEmail).length > opps.length / 2, true);
  assertEquals(C.providers.length >= 4 && C.providers.some((p) => p.id === ids.lawyerId), true);
  assertEquals(new Set(C.member_feedback.map((f) => f.kind)).size >= 3, true);
  // Member: assigned to the lawyer and the CSM; every money state; Spanish, emoji and AI replies.
  const me = C.clients.find((c) => c.id === ids.memberId)!;
  assertEquals([me.assignedProviderId, me.csmEmail], [ids.lawyerId, ids.staffEmail]);
  assertEquals(C.memberships.find((m) => m.clientId === ids.memberId)!.csmEmail, ids.staffEmail);
  assertEquals(C.matters.filter((m) => m.clientId === ids.memberId).every((m) => m.assignedProviderId === ids.lawyerId), true);
  const qs = (me.quotes as Doc[]).map((x) => x.status);
  assertEquals(["sent_to_client", "declined", "accepted"].every((s) => qs.includes(s)) || qs.includes("client_accepted"), true, qs.join());
  assertEquals((me.charges as Doc[]).some((c) => c.status === "pending"), true);
  const bodies = (me.statusComments as Doc[]).map((c) => String(c.body)).join("\n");
  assertEquals([/Hola/.test(bodies), /\p{Extended_Pictographic}/u.test(bodies), /attached|uploaded/i.test(bodies)], [true, true, true]);
  assertEquals((me.statusChatThread as Doc[]).filter((m) => m.aiGenerated).every((m) => /AI assistant/.test(String(m.content))), true);
  const next = C.consultations.find((c) => c.clientId === ids.memberId && c.status === "booked" && String(c.scheduledAt) > NOW.toISOString());
  assertEquals(!!next?.meetUrl, true);
  const ob = C.obligations.filter((o) => o.clientId === ids.memberId);
  assertEquals([ob.some((o) => o.status === "upcoming"), ob.some((o) => o.status === "asked")], [true, true]);
  assertEquals(C.member_documents.filter((d) => d.clientId === ids.memberId).length >= 5, true);
});

Deno.test("accounts: the lawyer has 4-6 calls today in Costa Rica time, in every state", () => {
  for (const at of ["2026-10-27T15:00:00Z", "2026-10-27T19:00:00Z", "2026-10-28T22:30:00Z"]) {
    const now = new Date(at);
    const d = buildAccountData(cli, ids, { lawyer: realLawyer(), member: realMember() }, now);
    const today = d.collections.consultations.filter((c) => c.providerId === ids.lawyerId && crDay(String(c.scheduledAt)) === crDay(now.getTime()));
    assertEquals(today.length >= 4 && today.length <= 6, true, `${at}: ${today.length}`);
    const st = (c: Doc) => `${c.status}/${(c.consent as Doc).recording}`;
    const states = today.map(st);
    assertEquals(today.some((c) => c.status === "completed" && (c.summary as Doc | undefined)?.status === "suggested"), true, at);
    assertEquals(states.includes("in_progress/granted"), true, at);
    assertEquals(states.includes("booked/pending"), true, at);
    assertEquals(today.some((c) => c.status === "booked" && Date.parse(String(c.scheduledAt)) < now.getTime()), true, `${at}: no-show candidate`);
    assertEquals(today.filter((c) => c.status === "booked" && Date.parse(String(c.scheduledAt)) > now.getTime()).every((c) => !!c.meetUrl), true);
  }
});

Deno.test("accounts: cleanup selector takes only this batch (and derived records about its members)", () => {
  const docs: Doc[] = [
    { id: "ph_cli_0002", placeholder: true, placeholderBatch: "ph-accounts-7" },
    { id: "prov_pablo", placeholder: true, placeholderBatch: "ph-accounts-7", placeholderAccount: true },
    { id: "prov_pablo_other", placeholder: true, placeholderBatch: "ph-accounts-7" }, // no ph_ id, not an account doc
    { id: "ph_cli_0003", placeholder: true, placeholderBatch: "ph-pilot-7" },
    { id: "ph_task_x", placeholder: true, placeholderBatch: "derived", clientId: ids.memberId },
    { id: "ph_task_y", placeholder: true, placeholderBatch: "derived", clientId: "ph_cli_9999" },
    { id: "admin_internationallegalpartner_com", placeholderAccountBatch: "ph-accounts-7" }, // real doc
  ];
  const sel = selectAccountDeletion("clients", docs, "ph-accounts-7", new Set([ids.memberId, "ph_cli_0002"]));
  assertEquals(sel.remove.map((d) => d.id), ["ph_cli_0002", "prov_pablo", "ph_task_x"]);
  assertEquals(sel.kept.map((d) => d.id), ["prov_pablo_other"]);
});

Deno.test("accounts: tasks raised by a placeholder record on a real member are placeholder too", () => {
  const t = buildTask("consultation.booked", { clientId: ids.memberId, sourceId: "ph_con_001_06" } as never, NOW)!;
  assertEquals([t.id.startsWith("ph_"), (t as unknown as Doc).placeholder], [true, true]);
  const r = buildTask("consultation.booked", { clientId: ids.memberId, sourceId: "con_real" } as never, NOW)!;
  assertEquals([r.id.startsWith("ph_"), (r as unknown as Doc).placeholder], [false, undefined]);
});
