import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { claimDeadlines, type ClaimInput, type ClaimStore, claimUsable, parseClaim } from "../API/leads/claim.ts";
import {
  cleanRuleIds,
  deadlineGroup,
  deadlineView,
  factsFor,
  mergeChosen,
  needsDateClients,
  obligationIdFor,
  obligationsForRules,
  parseDeadlinePatch,
  pickerItems,
} from "../API/members/deadlines.ts";
import { membershipRequiredBody } from "../API/clientStatus/accountGuard.ts";
import { remindable } from "../API/retention/retentionMessages.ts";
import { needsDateEvents } from "../jobs/taskRuleSweep.ts";
import { obligationsDueEmail } from "../helper/emailTemplates.ts";
import { VERSION_FOR_KIND } from "../API/privacy/policy.ts";
import {
  accountTypeOf,
  type Lead,
  MEMBERSHIP_REQUIRED,
  type Membership,
  type Obligation,
  obligationDueAt,
  obligationNeedsDate,
} from "../schemas/contracts.ts";

/**
 * DEADLINES: the free check claim, the Deadlines page rules and free accounts.
 * The claim runs against an in-memory ClaimStore (no Firestore, no email).
 * Run: deno test --allow-env test/deadlines_test.ts
 */

type Doc = Record<string, unknown>;
const NOW = new Date("2026-10-28T12:00:00Z");
const ANSWERS = { ownsVehicle: "yes", residencyStatus: "temporary", residencyExpiryDate: "2027-03-01", ownsProperty: "yes" };
// dated high, dated medium, no date (month by plate digit not given), low confidence
const RULES = ["CR_VEH_MARCHAMO", "CR_IMM_TEMP_RENEWAL", "CR_VEH_RTV", "CR_TAX_FOREIGN_INCOME_WATCH"];
const consents = (marketing?: boolean) => [
  { kind: "terms", granted: true, version: VERSION_FOR_KIND.terms },
  { kind: "privacy", granted: true, version: VERSION_FOR_KIND.privacy },
  ...(marketing === undefined ? [] : [{ kind: "marketing_email", granted: marketing, version: VERSION_FOR_KIND.marketing_email }]),
];

function memStore(seed: { clients?: Record<string, Doc>; memberships?: Membership[]; obligations?: Obligation[]; leads?: Lead[] } = {}) {
  const clients = new Map(Object.entries(seed.clients ?? {}));
  const obligations = new Map((seed.obligations ?? []).map((o) => [o.id, o]));
  const leads = new Map((seed.leads ?? []).map((l) => [l.id, l as unknown as Doc]));
  const claims = new Map<string, Doc>();
  const consentsWritten: string[] = [];
  const audits: Array<{ action: string; meta: Doc }> = [];
  const codes: string[] = [];
  let lastCodeAt = 0;
  let n = 0;
  const store: ClaimStore = {
    getClient: async (id) => clients.get(id) ?? null,
    putClient: async (id, doc) => void clients.set(id, { ...doc }),
    patchClient: async (id, f) => void clients.set(id, { ...(clients.get(id) ?? {}), ...f }),
    memberships: async (cid) => (seed.memberships ?? []).filter((m) => m.clientId === cid),
    getObligation: async (id) => obligations.get(id) ?? null,
    createObligation: async (o) => void obligations.set(o.id, { ...o }),
    updateObligation: async (id, f) => void obligations.set(id, { ...obligations.get(id)!, ...f } as Obligation),
    getLead: async (id) => (leads.get(id) as unknown as Lead) ?? null,
    putLead: async (l) => void leads.set(l.id, { ...l } as unknown as Doc),
    patchLead: async (id, f) => void leads.set(id, { ...(leads.get(id) ?? {}), ...f }),
    recordConsents: async (_who, want) => {
      const kinds = [want.terms, want.privacy, ...(want.marketing ? [want.marketing] : [])].map((c) => `${c.kind}:${c.granted}:${c.source}`);
      consentsWritten.push(...kinds);
      return kinds.length;
    },
    saveClaim: async (h, d) => void claims.set(h, d),
    audit: async (action, _c, _e, meta) => void audits.push({ action, meta }),
    sendCode: async (email) => {
      // the real code issuer refuses a second code within 30 seconds (429)
      const t = Date.now();
      if (t - lastCodeAt < 30_000) return { ok: false, status: 429 };
      lastCodeAt = t;
      codes.push(email);
      return { ok: true };
    },
    newToken: () => `tok_${++n}`,
    hash: async (t) => `h_${t}`,
  };
  return { store, clients, obligations, leads, claims, consentsWritten, audits, codes };
}

function input(over: Partial<ClaimInput> = {}): ClaimInput {
  const p = parseClaim({ email: "Linda.Pendleton@example.com", firstName: "Linda", country: "CR", answers: ANSWERS, ruleIds: RULES, consents: consents(false), ...over });
  if ("error" in p || "honeypot" in p) throw new Error(JSON.stringify(p));
  return p;
}

Deno.test("claim: parse refuses a bad email, no rules, missing consents; honeypot does nothing", () => {
  assertEquals(parseClaim({ email: "nope", country: "CR", ruleIds: RULES, consents: consents() }), { error: "Enter a valid email address.", field: "email" });
  assertEquals((parseClaim({ email: "a@b.co", country: "CR", ruleIds: ["NOT_A_RULE"], consents: consents() }) as { field: string }).field, "ruleIds");
  assertEquals((parseClaim({ email: "a@b.co", country: "CR", ruleIds: RULES, consents: [consents()[0]] }) as { field: string }).field, "consents");
  assertEquals((parseClaim({ email: "a@b.co", country: "XX", ruleIds: RULES, consents: consents() }) as { field: string }).field, "country");
  assertEquals(parseClaim({ website: "http://spam.example", email: "a@b.co" }), { honeypot: true });
  const ok = parseClaim({ email: " A@B.co ", country: "Costa Rica", ruleIds: [...RULES, "CR_VEH_MARCHAMO", "MX_NOT_HERE"], consents: consents(true) });
  assert(!("error" in ok) && !("honeypot" in ok));
  assertEquals(ok.email, "a@b.co");
  assertEquals(ok.country, "CR");
  assertEquals(ok.ruleIds, RULES); // duplicates and other countries' ids dropped
  assertEquals(ok.consents.marketing?.granted, true);
  assertEquals(ok.consents.terms.source, "check");
});

Deno.test("claim: a new person gets a free account, obligations with needsDate, consents, lead, audit and a code", async () => {
  const m = memStore();
  const r = await claimDeadlines(input(), m.store, NOW);
  assertEquals(r.clientId, "linda_pendleton_example_com");
  assertEquals([r.accountType, r.newAccount, r.created, r.kept, r.total, r.codeSent], ["free", true, 4, 0, 4, true]);
  const c = m.clients.get(r.clientId)!;
  assertEquals([c.accountType, c.name, c.email, c.legalCountry, c.timezone, c.source], ["free", "Linda", "linda.pendleton@example.com", "CR", "America/Costa_Rica", "deadline_check"]);
  assertEquals((c.countryAnswers as Doc).ownsVehicle, "yes");
  const o = (rule: string) => m.obligations.get(obligationIdFor(r.clientId, rule))!;
  assertEquals([o("CR_VEH_MARCHAMO").needsDate, o("CR_VEH_MARCHAMO").dueAt?.slice(0, 10), o("CR_VEH_MARCHAMO").source], [false, "2026-12-31", "check"]);
  assertEquals(o("CR_IMM_TEMP_RENEWAL").needsDate, false);
  assertEquals([o("CR_VEH_RTV").needsDate, o("CR_VEH_RTV").dueAt], [true, undefined]); // no computed date
  assertEquals([o("CR_TAX_FOREIGN_INCOME_WATCH").needsDate, o("CR_TAX_FOREIGN_INCOME_WATCH").confidence], [true, "low"]);
  for (const ob of m.obligations.values()) assertEquals([ob.status, ob.remind, ob.area !== undefined], ["upcoming", true, true]);
  assertEquals(m.consentsWritten, ["terms:true:check", "privacy:true:check", "marketing_email:false:check"]);
  const lead = [...m.leads.values()][0];
  assertEquals([lead.convertedClientId, lead.source, (lead.findings as unknown[]).length], [r.clientId, "deadline_check", 4]);
  assertEquals(m.audits.map((a) => a.action), ["deadlines.claimed"]);
  assertEquals(m.codes, ["linda.pendleton@example.com"]);
  assert(claimUsable(m.claims.get(`h_${r.claimToken}`)!, r.clientId, NOW));
  assert(!claimUsable(m.claims.get(`h_${r.claimToken}`)!, "someone_else", NOW));
  assert(!claimUsable(m.claims.get(`h_${r.claimToken}`)!, r.clientId, new Date(NOW.getTime() + 3 * 3600_000)));
});

Deno.test("claim: repeating it creates nothing new and the code still counts as sent", async () => {
  const m = memStore();
  await claimDeadlines(input(), m.store, NOW);
  const again = await claimDeadlines(input(), m.store, NOW);
  assertEquals([again.created, again.restored, again.kept, again.newAccount, again.codeSent], [0, 0, 4, false, true]);
  assertEquals(m.obligations.size, 4);
  assertEquals(m.codes.length, 1); // the second request hit the 30-second cooldown
  // a removed deadline chosen again comes back, with its date kept
  const id = obligationIdFor(again.clientId, "CR_VEH_MARCHAMO");
  m.obligations.set(id, { ...m.obligations.get(id)!, status: "dismissed", dismissedAt: NOW.toISOString(), userDueAt: "2026-12-20T12:00:00.000Z" });
  const third = await claimDeadlines(input({ ruleIds: ["CR_VEH_MARCHAMO"] }), m.store, NOW);
  assertEquals([third.restored, third.created], [1, 0]);
  assertEquals([m.obligations.get(id)!.status, m.obligations.get(id)!.dismissedAt, m.obligations.get(id)!.userDueAt], ["upcoming", null, "2026-12-20T12:00:00.000Z"]);
});

Deno.test("claim: an existing member keeps every field; the deadlines attach to their account", async () => {
  const id = "linda_pendleton_example_com";
  const member: Doc = { name: "Linda Rose", email: "linda.pendleton@example.com", legalCountry: "CR", timezone: "America/New_York", phone: "", countryAnswers: { ownsVehicle: "3" } };
  const mem = { id: "mem_1", clientId: id, status: "active" } as Membership;
  const m = memStore({ clients: { [id]: { ...member } }, memberships: [mem] });
  const r = await claimDeadlines(input({ firstName: "Lin" }), m.store, NOW);
  assertEquals([r.accountType, r.newAccount, r.created], ["member", false, 4]);
  assertEquals(m.clients.get(id), member); // untouched: not even empty fields are filled on a member
  // the member's own answers win for dates (plate ending 3 gives the RTV month)
  assertEquals(m.obligations.get(obligationIdFor(id, "CR_VEH_RTV"))!.needsDate, false);
});

Deno.test("claim: a free record from another country is not mixed; empty fields only; a pending join stays unmarked", async () => {
  const id = "linda_pendleton_example_com";
  const m = memStore({ clients: { [id]: { email: "linda.pendleton@example.com", legalCountry: "PA", name: "", countryAnswers: { x: "y" } } } });
  await claimDeadlines(input(), m.store, NOW);
  const c = m.clients.get(id)!;
  assertEquals([c.legalCountry, c.name, (c.countryAnswers as Doc).x, c.accountType], ["PA", "Linda", "y", "free"]);
  const p = memStore({ clients: { [id]: { email: "linda.pendleton@example.com" } }, memberships: [{ id: "m", clientId: id, status: "pending" } as Membership] });
  const r = await claimDeadlines(input(), p.store, NOW);
  assertEquals([r.accountType, p.clients.get(id)!.accountType], ["free", undefined]);
});

Deno.test("account type: members, free accounts and older records", () => {
  assertEquals(accountTypeOf({ accountType: "free" }, null), "free");
  assertEquals(accountTypeOf({ accountType: "free" }, { status: "pending" }), "free");
  assertEquals(accountTypeOf({ accountType: "free" }, { status: "active" }), "member");
  assertEquals(accountTypeOf({ accountType: "free" }, { status: "cancelled" }), "member");
  assertEquals(accountTypeOf({}, null), "member"); // records from before free accounts keep everything
  assertEquals(membershipRequiredBody().code, MEMBERSHIP_REQUIRED);
});

Deno.test("picker: lists rules not on the list, matches first; choosing again never duplicates", () => {
  const facts = factsFor("CR", ANSWERS);
  const have = obligationsForRules("c1", "CR", ["CR_VEH_MARCHAMO"], facts, "check", NOW);
  const items = pickerItems("CR", facts, have, NOW);
  assert(!items.some((i) => i.ruleId === "CR_VEH_MARCHAMO"));
  assertEquals(items.length, 34);
  assert(items[0].matches);
  const firstNonMatch = items.findIndex((i) => !i.matches);
  assert(items.slice(firstNonMatch).every((i) => !i.matches));
  assert(!items.find((i) => i.ruleId === "CR_CORP_RTBF")!.dueAt); // not matching: no date shown
  // a removed one is offered again
  const removed = [{ ...have[0], status: "dismissed" as const, dismissedAt: NOW.toISOString() }];
  assert(pickerItems("CR", facts, removed, NOW).some((i) => i.ruleId === "CR_VEH_MARCHAMO"));
  // merge rules
  const fresh = have[0];
  assertEquals(mergeChosen(null, fresh).action, "create");
  assertEquals(mergeChosen(fresh, fresh).action, "keep");
  assertEquals(mergeChosen(removed[0], fresh).action, "restore");
  assertEquals(cleanRuleIds("CR", ["CR_VEH_MARCHAMO", "CR_VEH_MARCHAMO", 3, "x y", "PA_VEH_LICENSE_RENEWAL"]), { ruleIds: ["CR_VEH_MARCHAMO"], unknown: ["PA_VEH_LICENSE_RENEWAL"] });
  assertEquals(obligationsForRules("c1", "CR", ["CR_VEH_MARCHAMO"], facts, "picker", NOW)[0].id, have[0].id);
});

Deno.test("PATCH: own date, done, reminders, remove and undo, notes; bad input refused", () => {
  const [o] = obligationsForRules("c1", "CR", ["CR_VEH_RTV"], factsFor("CR", ANSWERS), "check", NOW);
  const set = parseDeadlinePatch({ userDueAt: "2027-04-15" }, o, NOW);
  assert(!("error" in set));
  assertEquals([set.userDueAt, set.needsDate, set.remindersSent], ["2027-04-15T12:00:00.000Z", false, []]);
  const cleared = parseDeadlinePatch({ userDueAt: null }, { ...o, userDueAt: "2027-04-15T12:00:00.000Z" }, NOW);
  assert(!("error" in cleared));
  assertEquals([cleared.userDueAt, cleared.needsDate], [null, true]);
  assertEquals(parseDeadlinePatch({ userDueAt: "2027-02-30" }, o, NOW), { error: "That date does not exist. Check the day and month." });
  assertEquals(parseDeadlinePatch({ userDueAt: "next week" }, o, NOW), { error: "Enter the date as year, month and day." });
  assertEquals(parseDeadlinePatch({ userDueAt: "2090-01-01" }, o, NOW), { error: "Enter a date within the next 30 years." });
  assertEquals(parseDeadlinePatch({ status: "asked" }, o, NOW), { error: "status must be 'upcoming' or 'handled'." });
  assertEquals(parseDeadlinePatch({ remind: "no" }, o, NOW), { error: "remind must be true or false." });
  assertEquals(parseDeadlinePatch({ clientId: "other" }, o, NOW), { error: '"clientId" cannot be changed here.' });
  assertEquals(parseDeadlinePatch({}, o, NOW), { error: "Nothing to save." });
  assertEquals(parseDeadlinePatch({ notes: "x".repeat(501) }, o, NOW), { error: "Keep the note under 500 characters." });
  const done = parseDeadlinePatch({ status: "handled", remind: false, notes: "  Paid at the bank " }, o, NOW);
  assert(!("error" in done));
  assertEquals([done.status, done.remind, done.notes], ["handled", false, "Paid at the bank"]);
  const rm = parseDeadlinePatch({ dismissed: true }, o, NOW);
  assert(!("error" in rm));
  assertEquals([rm.status, rm.dismissedAt], ["dismissed", NOW.toISOString()]);
  const removed = { ...o, status: "dismissed" as const, dismissedAt: NOW.toISOString() };
  const undo = parseDeadlinePatch({ dismissed: false }, removed, NOW);
  assert(!("error" in undo));
  assertEquals([undo.status, undo.dismissedAt], ["upcoming", null]);
  assertEquals(parseDeadlinePatch({ status: "handled" }, removed, NOW), { error: "Restore this deadline first." });
});

Deno.test("views: shown date is the person's own first; groups; low confidence never shows the computed date", () => {
  const facts = factsFor("CR", ANSWERS);
  const [marchamo, rtv, watch] = obligationsForRules("c1", "CR", ["CR_VEH_MARCHAMO", "CR_VEH_RTV", "CR_TAX_FOREIGN_INCOME_WATCH"], facts, "check", NOW);
  assertEquals(deadlineView(marchamo, NOW).group, "soon");
  assertEquals(deadlineView({ ...marchamo, userDueAt: "2027-06-01T12:00:00.000Z" }, NOW).shownDueAt, "2027-06-01T12:00:00.000Z");
  assertEquals(deadlineView({ ...marchamo, userDueAt: "2027-06-01T12:00:00.000Z" }, NOW).group, "later");
  assertEquals(deadlineView({ ...marchamo, status: "handled" }, NOW).group, "done");
  const v = deadlineView(rtv, NOW);
  assertEquals([v.group, v.hasDate, v.shownDueAt, v.suggestedDueAt], ["needsDate", false, null, null]);
  assert(v.meaning.length > 10 && v.authority.length > 2);
  assertEquals(deadlineGroup({ ...watch, dueAt: "2026-11-01T12:00:00.000Z" }, NOW), "needsDate"); // low confidence
  assertEquals(obligationNeedsDate({ ...watch, userDueAt: "2026-11-01T12:00:00.000Z" }), false);
  assertEquals(obligationDueAt({ dueAt: "a", userDueAt: null }), "a");
  // older records with no source, area or remind
  const old = deadlineView({ id: "o", clientId: "c1", country: "CR", ruleId: "CR_CHECK_MARCHAMO", title: "Marchamo may require review", status: "upcoming", dueAt: "2026-12-31T12:00:00.000Z" }, NOW);
  assertEquals([old.source, old.area, old.remind], ["check", "vehicle", true]);
});

Deno.test("reminders: own date first; reminders off and removed items skipped; free accounts get the deadlines email", () => {
  const base = { clientId: "c1", country: "CR" as const, ruleId: "R", title: "T may require review", status: "upcoming" as const };
  const list: Obligation[] = [
    { ...base, id: "a", dueAt: "2026-12-31T12:00:00.000Z" },
    { ...base, id: "b", dueAt: "2026-12-31T12:00:00.000Z", userDueAt: "2026-11-05T12:00:00.000Z" },
    { ...base, id: "c", dueAt: "2026-11-02T12:00:00.000Z", remind: false },
    { ...base, id: "d", dueAt: "2026-11-02T12:00:00.000Z", dismissedAt: NOW.toISOString(), status: "dismissed" },
    { ...base, id: "e", userDueAt: "2026-11-03T12:00:00.000Z", needsDate: false },
    { ...base, id: "f" },
  ];
  assertEquals(remindable(list).map((o) => `${o.id}:${o.remindAt.slice(0, 10)}`), ["a:2026-12-31", "b:2026-11-05", "e:2026-11-03"]);
  const free = obligationsDueEmail({ items: [{ title: "T", dueLabel: "Nov 5", daysLeft: 7 }], askUrl: "https://x/status/deadlines", unsubscribeUrl: "https://x/u", free: true });
  assert(free.html.includes("See my deadlines") && free.html.includes("free ILP check") && free.html.includes("https://x/u"));
  assert(!free.html.includes("It is part of your membership"));
  const mem = obligationsDueEmail({ items: [{ title: "T", dueLabel: "Nov 5", daysLeft: 7 }], askUrl: "https://x/status/deadlines", unsubscribeUrl: "https://x/u" });
  assert(mem.html.includes("Ask my lawyer"));
});

Deno.test("CSM task: members with undated deadlines older than 7 days, once per member; free accounts never", () => {
  const old = new Date(NOW.getTime() - 8 * 86400_000).toISOString();
  const fresh = new Date(NOW.getTime() - 2 * 86400_000).toISOString();
  const o = (id: string, clientId: string, createdAt: string, extra: Partial<Obligation> = {}): Obligation =>
    ({ id, clientId, country: "CR", ruleId: "R", title: "T", status: "upcoming", needsDate: true, createdAt, ...extra });
  const list = [o("1", "m1", old), o("2", "m1", old), o("3", "m2", fresh), o("4", "free1", old), o("5", "m3", old, { userDueAt: "2027-01-01T12:00:00.000Z" })];
  const ms = ["m1", "m2", "m3"].map((c) => ({ id: `mem_${c}`, clientId: c, status: "active" }) as Membership);
  const events = needsDateEvents(list, ms, NOW);
  assertEquals(events.map(([n, p]) => `${n}:${p.clientId}:${p.sourceId}`), ["obligation.needs_date_7d:m1:m1_needs_date"]);
  assertEquals(needsDateClients(list, new Set(["free1"]), NOW), ["free1"]); // the selector alone; the sweep passes members only
});
