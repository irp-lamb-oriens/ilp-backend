import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  accountNamespace,
  accountTarget,
  asFreeAccount,
  baseAccountDocs,
  batchesOverlap,
  batchNamespace,
  checkAccountPlan,
  namespaceIds,
  planAccountSeed,
  type RealDocs,
  targetIds,
} from "../scripts/accountSeedOps.ts";
import { buildAccountData, envLinesFor, main, parseAccountArgs, targetsOf } from "../scripts/seedAccounts.ts";
import { emailToDocId } from "../helper/auth/otp.ts";
import type { Doc, SeedData } from "../scripts/placeholderData.ts";
import { installFakeWorld, useFakeEnv } from "./e2e/fakeWorld.ts";

/**
 * Per-email account seed (scripts/seedAccounts.ts --email / --roles): one real
 * address in every portal, in its own id namespace. Pure parts offline; the
 * write path against the in-memory Firestore fake (test/e2e/fakeWorld.ts).
 * Run: deno test --allow-env --allow-read test/seedAccountsEmail_test.ts
 */

const EMAIL = "merlin@aiexecutions.com";
const NOW = new Date("2026-10-27T16:00:00Z");
const GEN_META = ["placeholder", "placeholderBatch", "placeholderAlias", "placeholderMeta", "placeholderAccount", "isPlaceholder"];

function cliFor(args: string[]) {
  const o = parseAccountArgs(args);
  if ("error" in o) throw new Error(o.error);
  return o;
}

function build(roles?: string) {
  const o = cliFor([`--email=${EMAIL}`, ...(roles ? [`--roles=${roles}`] : [])]);
  const t = targetsOf(o)[0]!;
  const ids = targetIds(t, emailToDocId);
  const none: RealDocs = { lawyer: null, member: null, availability: null, memberHasRealMembership: false };
  const bases = baseAccountDocs(t, ids, none, NOW.toISOString());
  const real: RealDocs = {
    lawyer: bases.find((b) => b.collection === "providers")?.doc ?? null,
    availability: bases.find((b) => b.collection === "lawyer_availability")?.doc ?? null,
    member: bases.find((b) => b.collection === "clients")?.doc ?? null,
    memberHasRealMembership: false,
  };
  const data = buildAccountData(o, ids, real, NOW, t);
  return { o, t, ids, bases, real, data, plan: planAccountSeed(data, ids, real, data.now) };
}

const all = build();

const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), strings(x, out));
  return out;
};

Deno.test("accounts --email: flags, roles, dry run by default, errors", () => {
  const o = cliFor([`--email= Merlin@AIExecutions.com `, `--email=${EMAIL}`, "--email=other@aiexecutions.com"]);
  assertEquals(o.emails, [EMAIL, "other@aiexecutions.com"]);
  assertEquals(o.roles, ["member", "lawyer", "staff", "csm", "admin"]);
  assertEquals(cliFor([`--email=${EMAIL}`, "--roles=all"]).roles, ["member", "lawyer", "staff", "csm", "admin"]);
  assertEquals(cliFor([`--email=${EMAIL}`, "--roles=all,sales"]).roles, ["member", "lawyer", "staff", "csm", "admin", "sales"]);
  assertEquals(o.dryRun, true, "no --confirm-project → dry run");
  assertEquals(cliFor([`--email=${EMAIL}`, "--confirm-project=p1"]).dryRun, false);
  assertEquals(cliFor([`--email=${EMAIL}`, "--roles=lawyer, member"]).roles, ["lawyer", "member"]);
  assertEquals(cliFor([]).dryRun, true);
  for (const bad of [["--email=nope"], [`--email=${EMAIL}`, "--roles=wizard"], ["--roles=member"], [`--email=${EMAIL}`, "--member-email=a@b.co"], [`--email=${EMAIL}`, "--roles="]]) {
    assert("error" in parseAccountArgs(bad), bad.join(" "));
  }
  assertEquals(targetsOf(cliFor([])), [null]);
});

Deno.test("accounts --email: target, ids, namespace, batch and env lines", () => {
  const t = all.t;
  assertEquals([t.ns, t.batch, t.lawyer, t.member, t.staff, t.sales], ["merlin", "ph-accounts-merlin-7", true, "member", "admin", false]);
  assertEquals([t.lawyerEmail, t.staffEmail, t.memberEmail], [EMAIL, EMAIL, EMAIL]);
  assertEquals(all.ids, { lawyerId: "prov_merlin_aiexecutions_com", memberId: "merlin_aiexecutions_com", lawyerEmail: EMAIL, staffEmail: EMAIL, memberEmail: EMAIL });
  assertEquals(accountNamespace("Jean-Luc.O'Neil+x@x.io"), "jeanluconeil");
  const lines = envLinesFor(t).join("\n");
  assert(lines.includes(`DASHBOARD_EXTRA_ALLOWED_EMAILS += ${EMAIL}`) && lines.includes(`ADMIN_EMAILS += ${EMAIL}`) && lines.includes(`CSM_EMAILS += ${EMAIL}`) && !lines.includes("SALES_EMAILS"));
  assert(envLinesFor(accountTarget(EMAIL, ["admin", "sales"], 7)).some((l) => l.startsWith("SALES_EMAILS")));
  const csm = accountTarget(EMAIL, ["csm"], 7);
  assertEquals([csm.staff, csm.lawyer, csm.member, csm.lawyerEmail.endsWith("@example.com"), csm.memberEmail.endsWith("@example.com")], ["csm", false, null, true, true]);
  assertEquals(envLinesFor(csm).some((l) => l.startsWith("CSM_EMAILS")), true);
  const ids = targetIds(csm, emailToDocId);
  assertEquals([ids.lawyerId, ids.memberId], ["ph_merlin_prov_acct_lawyer", "ph_merlin_cli_acct_member"]);
  // Batches: only the same namespace can collide.
  assertEquals([batchNamespace("ph-accounts-7"), batchNamespace("ph-pilot-7"), batchNamespace("ph-accounts-merlin-7")], ["", "", "merlin"]);
  assertEquals(batchesOverlap("ph-accounts-merlin-7", "ph-accounts-7"), false);
  assertEquals(batchesOverlap("ph-accounts-merlin-7", "ph-accounts-merlin-8"), true);
  assertEquals(batchesOverlap("ph-accounts-7", "ph-pilot-7"), true);
  assertEquals(batchesOverlap("ph-accounts-7", "ph-accounts-merlin-7"), false);
  assertEquals(batchesOverlap("ph-accounts-7", "derived"), false);
});

Deno.test("accounts --email: every ph_ id is namespaced; no id meets the shared ph-accounts-7 story", () => {
  const leak = strings(all.data).filter((s) => /(^|[^A-Za-z0-9])ph_(?!merlin_)/.test(s));
  assertEquals(leak.slice(0, 5), []);
  const legacyO = cliFor([]);
  const legacy = buildAccountData(legacyO, { lawyerId: "prov_pablo", memberId: "admin_internationallegalpartner_com", lawyerEmail: legacyO.lawyerEmail, staffEmail: legacyO.staffEmail, memberEmail: legacyO.memberEmail }, { lawyer: null, member: null }, NOW);
  const key = (d: SeedData) => new Set(Object.entries(d.collections).flatMap(([c, l]) => l.map((x) => `${c}/${x.id}`)));
  const ours = key(all.data);
  const overlap = [...key(legacy)].filter((k) => ours.has(k));
  assertEquals(overlap, []);
  assertEquals<unknown>(namespaceIds({ a: "ph_cli_001", b: ["x ph_con_1", "graph_x", "ph_merlin_cli_1"], ph_k: 1 }, "merlin"), { a: "ph_merlin_cli_001", b: ["x ph_merlin_con_1", "graph_x", "ph_merlin_cli_1"], ph_merlin_k: 1 });
  assertEquals(namespaceIds("ph_cli_001", ""), "ph_cli_001");
});

Deno.test("accounts --email: base docs are real (no placeholder markers); creates are ph_merlin_ placeholder docs", () => {
  assertEquals(all.bases.map((b) => `${b.collection}/${b.id}`), ["providers/prov_merlin_aiexecutions_com", "lawyer_availability/prov_merlin_aiexecutions_com", "clients/merlin_aiexecutions_com"]);
  for (const b of all.bases) for (const g of GEN_META) assertEquals(g in b.doc, false, `${b.collection} ${g}`);
  const prov = all.bases[0].doc;
  assertEquals([prov.email, prov.status, prov.active, prov.routingStatus], [EMAIL, "active", true, "onboarding"]);
  assertEquals(all.bases[2].doc.accountType, "member");
  checkAccountPlan(all.plan, all.ids, all.real);
  assertEquals(all.plan.merges.map((m) => `${m.collection}/${m.id}`).sort(), ["clients/merlin_aiexecutions_com", "lawyer_availability/prov_merlin_aiexecutions_com", "providers/prov_merlin_aiexecutions_com"]);
  for (const m of all.plan.merges) for (const g of GEN_META) assertEquals(g in m.set, false);
  assertEquals(all.plan.allowed, []);
  for (const w of all.plan.creates) {
    assert(w.id.startsWith("ph_merlin_"), `${w.collection}/${w.id}`);
    assertEquals([w.doc.placeholder, w.doc.placeholderBatch], [true, "ph-accounts-merlin-7"], `${w.collection}/${w.id}`);
  }
  // Placeholder people stay on reserved domains; only merlin's own address is real.
  const emails = strings(all.data).flatMap((s) => s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []);
  const realOnes = [...new Set(emails.map((e) => e.toLowerCase()).filter((e) => !/@example\.(com|org|net)$/.test(e)))];
  assert(realOnes.every((e) => e === EMAIL || e.endsWith("@internationallegalpartner.com") || e.endsWith("@internationalrelocationpartner.com")), realOnes.join(", "));
});

Deno.test("accounts --email: merlin sees every portal (lawyer, CSM book, member)", () => {
  const C = (c: string) => (all.data.collections[c] ?? []) as Doc[];
  const L = all.ids.lawyerId, M = all.ids.memberId;
  assert(C("matters").filter((m) => m.providerId === L || m.lawyerId === L || m.assignedProviderId === L).length >= 20, "lawyer board");
  assert(C("consultations").filter((c) => c.providerId === L).length >= 50, "lawyer calls");
  assert(C("memberships").filter((m) => m.csmEmail === EMAIL).length >= 10, "CSM book");
  assert(C("csm_tasks").filter((t) => t.ownerEmail === EMAIL || t.owner === EMAIL || JSON.stringify(t).includes(EMAIL)).length >= 15, "CSM queue");
  const contacts = C("csm_contacts").filter((c) => c.csmEmail === EMAIL);
  assert(contacts.length >= 5 && contacts.every((c) => c.placeholder === true && c.placeholderBatch === all.t.batch && String(c.id).startsWith("ph_merlin_")));
  assert(C("notifications").some((n) => n.to === `csm:${EMAIL}`));
  const mem = C("memberships").filter((m) => m.clientId === M);
  assertEquals(mem.length, 1);
  assertEquals(mem[0].status, "active");
  for (const c of ["matters", "consultations", "obligations", "member_documents", "leads"]) assert(C(c).some((d) => d.clientId === M || JSON.stringify(d).includes(`"${M}"`)), c);
  const member = C("clients").find((c) => c.id === M)!;
  for (const k of ["charges", "quotes", "statusComments"]) assert(Array.isArray(member[k]) && (member[k] as unknown[]).length > 0, k);
});

Deno.test("accounts --email: --roles=free gives a free account (no membership, matters or money)", () => {
  const f = build("free");
  assertEquals([f.t.member, f.t.lawyer, f.t.staff, f.ids.lawyerId], ["free", false, null, "ph_merlin_prov_acct_lawyer"]);
  assertEquals(f.bases.map((b) => `${b.collection}/${b.id}`), ["clients/merlin_aiexecutions_com"]);
  assertEquals(f.bases[0].doc.accountType, "free");
  const M = f.ids.memberId;
  for (const c of ["memberships", "matters", "consultations", "handoffs", "quoteSettlements", "invoices", "member_documents"]) {
    assertEquals((f.data.collections[c] ?? []).filter((d) => d.clientId === M).length, 0, c);
  }
  assert((f.data.collections.obligations ?? []).some((o) => o.clientId === M), "free accounts keep their deadlines");
  const member = f.data.collections.clients.find((c) => c.id === M)!;
  assertEquals([member.accountType, "charges" in member, "quotes" in member], ["free", false, false]);
  assertEquals(f.data.subcollections.some((s) => s.path.split("/")[1] === M), false);
  checkAccountPlan(f.plan, f.ids, f.real);
  // asFreeAccount leaves the other members alone.
  const before = all.data.collections.memberships.length;
  assertEquals(asFreeAccount(all.data, M).collections.memberships.length, before - 1);
});

Deno.test("accounts --email: real run against the Firestore fake writes, merges and re-runs without duplicates", async () => {
  const world = installFakeWorld("2026-10-27T16:00:00Z");
  const log = console.log;
  try {
    await useFakeEnv();
    // The shared story already loaded (ph-accounts-7) and a real staff member must stay untouched.
    world.put("clients", "ph_cli_001", { name: "Shared", placeholder: true, placeholderBatch: "ph-accounts-7" });
    world.put("providers", "prov_pablo", { name: "Pablo", email: "pablo@internationalrelocationpartner.com", status: "active" });
    console.log = () => {};
    const args = [`--email=${EMAIL}`, "--confirm-project=ilp-e2e"];
    assertEquals(await main(["--email=nope"]), 2);
    assertEquals(await main([`--email=${EMAIL}`]), 0, "dry run");
    assertEquals(world.all("clients").length, 1, "dry run writes nothing");
    assertEquals(await main([`--email=${EMAIL}`, "--confirm-project=wrong"]), 2);
    assertEquals(await main(args), 0);
    const count = () => [...world.db.entries()].reduce((s, [, c]) => s + c.size, 0);
    const first = count();
    const member = world.doc("clients", "merlin_aiexecutions_com")!;
    const prov = world.doc("providers", "prov_merlin_aiexecutions_com")!;
    const avail = world.doc("lawyer_availability", "prov_merlin_aiexecutions_com")!;
    for (const d of [member, prov, avail]) {
      for (const g of GEN_META) assertEquals(g in d, false, g);
      assertEquals(d.placeholderAccountBatch, "ph-accounts-merlin-7");
    }
    assertEquals([prov.email, prov.status, prov.routingStatus, member.email, member.accountType], [EMAIL, "active", "onboarding", EMAIL, "member"]);
    assert(Array.isArray(prov.licences) || Array.isArray(prov.legalAreas), "lawyer profile filled");
    assert(Array.isArray(avail.weekly) && avail.weekly.length > 0, "hours filled");
    const charges = (member.charges as unknown[]).length;
    assert(charges > 0);
    assertEquals(world.all("memberships").filter((m) => m.clientId === "merlin_aiexecutions_com").map((m) => m.status), ["active"]);
    assert(world.all("csm_contacts").some((c) => c.csmEmail === EMAIL));
    assertEquals(world.doc("clients", "ph_cli_001"), { id: "ph_cli_001", name: "Shared", placeholder: true, placeholderBatch: "ph-accounts-7" });
    assertEquals(world.doc("providers", "prov_pablo")!.name, "Pablo");
    assert(world.all("clients").filter((c) => c.placeholder === true).every((c) => c.id === "ph_cli_001" || String(c.id).startsWith("ph_merlin_")));
    // Re-run: same documents, nothing duplicated.
    assertEquals(await main(args), 0);
    assertEquals(count(), first);
    assertEquals((world.doc("clients", "merlin_aiexecutions_com")!.charges as unknown[]).length, charges);
    assertEquals(world.all("memberships").filter((m) => m.clientId === "merlin_aiexecutions_com").length, 1);
  } finally {
    console.log = log;
    world.restore();
  }
});
