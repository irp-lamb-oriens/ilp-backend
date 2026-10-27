import { assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { buildPlaceholderData, countDocs, diversityReport, readyShare } from "../scripts/placeholderData.ts";
import { TASK_RULES } from "../schemas/contracts.ts";
import { BACKGROUNDS, COMPANIES, EMPLOYEES, HOUSEHOLDS, LANGUAGES, NATIONALITIES, PROPERTIES, PROVINCES, RESIDENCIES, VEHICLES } from "../scripts/placeholderPeople.ts";
import { checkWrites, parseArgs, plannedWrites, tinyPdf } from "../scripts/seedPlaceholdersFull.ts";
import { selectForDeletion } from "../scripts/removePlaceholders.ts";
import { PlaceholderGuardError } from "../helper/placeholder.ts";
import { computeKpis } from "../API/dashboard/staffHome/compute.ts";
import { sniffContentType } from "../helper/storage.ts";

/**
 * Placeholder seed (scripts/placeholderData.ts): offline, no Firestore.
 * Run: deno test --allow-env --allow-read test/seedPlaceholders_test.ts
 */

const NOW = new Date("2026-10-27T16:00:00Z"); // a Tuesday, 10:00 in Costa Rica
const pilot = buildPlaceholderData({ size: "pilot", seed: 7, now: NOW });
const all = (d = pilot) => [...Object.values(d.collections).flat(), ...Object.values(d.config).flat(), ...d.subcollections.flatMap((s) => s.docs)];

Deno.test("seed: same size + seed → same ids and content", () => {
  const again = buildPlaceholderData({ size: "pilot", seed: 7, now: NOW });
  assertEquals(JSON.stringify(again), JSON.stringify(pilot));
  const other = buildPlaceholderData({ size: "pilot", seed: 8, now: NOW });
  assertEquals(JSON.stringify(other) === JSON.stringify(pilot), false);
});

Deno.test("seed: a re-run a day later keeps people, memberships and matters on the same ids", () => {
  const later = buildPlaceholderData({ size: "pilot", seed: 7, now: new Date(NOW.getTime() + 86_400_000) });
  const ids = (d: typeof pilot, c: string) => d.collections[c].map((x) => String(x.id)).sort();
  for (const c of ["clients", "memberships", "providers", "lawyer_availability", "matters"]) assertEquals(ids(later, c), ids(pilot, c), c);
  const before = new Set(ids(pilot, "consultations"));
  const kept = ids(later, "consultations").filter((id) => before.has(id)).length;
  assertEquals(kept / before.size > 0.8, true, `consultations kept ${kept}/${before.size}`);
});

Deno.test("seed: every document is ph_, placeholder: true and carries the batch", () => {
  for (const d of all()) {
    assertEquals(String(d.id).startsWith("ph_"), true, String(d.id));
    assertEquals(d.placeholder, true, String(d.id));
    assertEquals(d.placeholderBatch, "ph-pilot-7", String(d.id));
  }
  checkWrites(plannedWrites(pilot), pilot.aliasClientId);
  for (const [col, list] of Object.entries(pilot.collections)) {
    assertEquals(new Set(list.map((d) => d.id)).size, list.length, `duplicate ids in ${col}`);
  }
});

Deno.test("seed: only reserved emails, 555-01xx phones and PH- identifiers", () => {
  const text = JSON.stringify(pilot);
  const emails = new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g) ?? []);
  assertEquals([...emails].filter((e) => !e.endsWith("@example.com")), []);
  const phones = text.match(/\+1 \d{3} \d{3} \d{4}/g) ?? [];
  assertEquals(phones.length > 0, true);
  assertEquals(phones.filter((p) => !/ 555 01\d\d$/.test(p)), []);
  for (const c of pilot.collections.clients) {
    if (typeof c.phone === "string") assertEquals(/^\+1 \d{3} 555 01\d\d$|^\+44 7700 900\d{3}$/.test(c.phone), true, String(c.phone));
  }
  for (const c of pilot.collections.clients) {
    for (const k of ["dimexNumber", "companyId"]) if (c[k]) assertEquals(String(c[k]).startsWith("PH-"), true, `${c.id}.${k}`);
  }
  for (const inv of pilot.collections.invoices) assertEquals(/\d\s*$/.test(String(inv.invoiceNumber)), false, "invoice numbers must not end in digits");
});

Deno.test("seed: pilot size and a plausible story (KPIs)", () => {
  const n = Object.fromEntries(countDocs(pilot));
  assertEquals(n.clients, 60);
  assertEquals(n.providers, 6);
  assertEquals(n.memberships, 60);
  for (const k of ["leads", "matters", "consultations", "handoffs", "csm_tasks", "obligations", "opportunities", "funnel_events", "member_feedback", "consents", "privacy_requests", "member_documents", "audit_log", "quoteSettlements", "invoices", "financeLedger", "lawyer_availability"]) {
    assertEquals((n[k] ?? 0) > 0, true, k);
  }
  const C = pilot.collections;
  const k = computeKpis({
    memberships: C.memberships as never, clients: new Map(C.clients.map((c) => [String(c.id), c])), tasks: C.csm_tasks as never,
    handoffs: C.handoffs as never, consultations: C.consultations as never, now: NOW,
  });
  assertEquals(k.retentionM3.pct !== null && k.retentionM3.pct >= 70 && k.retentionM3.pct <= 92, true, `retention ${k.retentionM3.pct}`);
  assertEquals((k.handoffSla.pct ?? 0) >= 75, true, `handoff SLA ${k.handoffSla.pct}`);
  assertEquals(readyShare(pilot) >= 0.7, true, `ready ${readyShare(pilot)}`);
  const statuses = new Set(C.memberships.map((m) => m.status));
  for (const s of ["active", "past_due", "cancelled", "pending"]) assertEquals(statuses.has(s), true, s);
  for (const m of C.memberships.filter((x) => x.status === "cancelled")) assertEquals(!!m.cancelReason && !!m.cancelledAt, true, String(m.id));
  for (const m of C.memberships) assertEquals(Number(m.minutesUsed) <= 60 && Number(m.callsUsed) <= 3, true, String(m.id));
});

Deno.test("seed: every lawyer has calls today; completed calls carry consent and a summary", () => {
  const today = pilot.collections.consultations.filter((c) => String(c.scheduledAt).slice(0, 10) === "2026-10-27");
  assertEquals(new Set(today.map((c) => c.providerId)).size, 6);
  assertEquals(today.some((c) => c.status === "booked"), true);
  assertEquals(today.some((c) => c.status === "completed" && (c.summary as { status: string }).status === "suggested"), true);
  for (const c of pilot.collections.consultations.filter((x) => x.status === "completed")) {
    const consent = (c.consent as { recording: string }).recording;
    assertEquals(["granted", "declined"].includes(consent), true, String(c.id));
    assertEquals(!!c.summary, true, String(c.id));
    if (consent !== "granted") assertEquals(c.transcript, undefined, String(c.id));
    assertEquals(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(String(c.meetUrl)), true);
  }
  const upcoming = pilot.collections.consultations.filter((c) => c.status === "booked" && String(c.scheduledAt) > NOW.toISOString());
  assertEquals(upcoming.every((c) => Date.parse(String(c.scheduledAt)) <= NOW.getTime() + 15 * 86_400_000), true);
});

Deno.test("seed: tasks use TASK_RULES ids; closed opportunities and done tasks have outcomes", () => {
  for (const t of pilot.collections.csm_tasks) {
    assertEquals(String(t.id).startsWith("ph_task_"), true, String(t.id));
    if (t.status === "done") assertEquals(typeof t.outcome === "string" && String(t.outcome).length > 3, true, String(t.id));
  }
  const stages = new Set(pilot.collections.opportunities.map((o) => o.stage));
  for (const s of ["identified", "quoted", "won", "lost"]) assertEquals(stages.has(s), true, s);
  for (const o of pilot.collections.opportunities) {
    if (o.stage === "won" || o.stage === "lost") assertEquals(!!o.outcome && !!o.closedAt, true, String(o.id));
    if (o.valueCents) assertEquals(Number(o.valueCents) >= 30000 && Number(o.valueCents) <= 450000, true, String(o.id));
  }
  // Won quotes have a settlement and an invoice.
  const won = pilot.collections.opportunities.filter((o) => o.stage === "won" && o.quoteId);
  for (const o of won) {
    assertEquals(pilot.collections.quoteSettlements.some((s) => s.id === o.quoteId), true);
    assertEquals(pilot.collections.invoices.some((i) => i.quoteId === o.quoteId), true);
  }
});

Deno.test("seed: login alias keeps its email-derived client id, everything else stays ph_", () => {
  const d = buildPlaceholderData({ size: "demo", seed: 3, now: NOW, memberEmail: "Me@Gmail.com", lawyerEmail: "lawyer.me@gmail.com", csmEmail: "csm.me@gmail.com" });
  assertEquals(d.aliasClientId, "me_gmail_com");
  const alias = d.collections.clients.find((c) => c.id === "me_gmail_com")!;
  assertEquals(alias.placeholder, true);
  assertEquals(alias.placeholderAlias, true);
  assertEquals(d.collections.providers[0].email, "lawyer.me@gmail.com");
  assertEquals(d.collections.csm_tasks.some((t) => t.ownerEmail === "csm.me@gmail.com"), true);
  for (const t of d.collections.csm_tasks) assertEquals(String(t.id).startsWith("ph_"), true, String(t.id));
  checkWrites(plannedWrites(d), d.aliasClientId);
  assertThrows(() => checkWrites(plannedWrites(d), null), PlaceholderGuardError);
  const tampered = plannedWrites(d);
  tampered[3] = { ...tampered[3], doc: { ...tampered[3].doc, placeholder: false } };
  assertThrows(() => checkWrites(tampered, d.aliasClientId), PlaceholderGuardError);
  assertEquals(d.collections.consultations.some((c) => c.clientId === "me_gmail_com" && c.status === "booked"), true);
});

Deno.test("cleanup selects only placeholder: true AND ph_ ids (alias only on request)", () => {
  const docs = [
    { id: "ph_mem_001", placeholder: true, placeholderBatch: "ph-pilot-7" },
    { id: "ph_mem_002", placeholder: true, placeholderBatch: "derived" },
    { id: "ph_mem_003" }, // no flag: never
    { id: "mem_real", placeholder: true }, // flag without prefix: kept
    { id: "mem_real_2" },
    { id: "task_x", placeholder: true, clientId: "me_gmail_com" },
  ];
  const a = selectForDeletion("memberships", docs);
  assertEquals(a.remove.map((d) => d.id), ["ph_mem_001", "ph_mem_002"]);
  assertEquals(a.kept.map((d) => d.id), ["mem_real", "task_x"]);
  assertEquals(selectForDeletion("memberships", docs, { batch: "derived" }).remove.map((d) => d.id), ["ph_mem_002"]);
  const b = selectForDeletion("memberships", docs, { includeAlias: true, aliasClientIds: new Set(["me_gmail_com"]) });
  assertEquals(b.remove.map((d) => d.id), ["ph_mem_001", "ph_mem_002", "task_x"]);
  const clients = [{ id: "me_gmail_com", placeholder: true, placeholderAlias: true }, { id: "real_gmail_com", placeholder: true }, { id: "x_example_com" }];
  assertEquals(selectForDeletion("clients", clients).remove.length, 0);
  assertEquals(selectForDeletion("clients", clients, { includeAlias: true }).remove.map((d) => d.id), ["me_gmail_com"]);
});

Deno.test("cli: flags, env and the placeholder PDF", () => {
  const env = (m: Record<string, string>) => (k: string) => m[k];
  const p = parseArgs(["--size=large", "--seed=3", "--dry-run", "--config=never"], env({ PLACEHOLDER_MEMBER_EMAIL: " Me@Gmail.com " }));
  assertEquals("error" in p, false);
  if (!("error" in p)) {
    assertEquals([p.size, p.seed, p.dryRun, p.config, p.memberEmail], ["large", 3, true, "never", "me@gmail.com"]);
  }
  assertEquals("error" in parseArgs(["--size=huge"], env({})), true);
  assertEquals("error" in parseArgs([], env({ PLACEHOLDER_MEMBER_EMAIL: "a@b.com", PLACEHOLDER_LAWYER_EMAIL: "A@b.com" })), true);
  assertEquals(sniffContentType(tinyPdf("passport-scan.pdf")), "application/pdf");
  const demo = buildPlaceholderData({ size: "demo", seed: 7, now: NOW, withFiles: true });
  assertEquals(demo.files.length > 0, true);
  for (const f of demo.files) assertEquals(f.objectName, `members/${f.clientId}/${f.docId}`);
});

/** Every enum value of every contract type, and every diversity dimension, at demo and pilot size. */
for (const size of ["demo", "pilot"] as const) {
  Deno.test(`seed (${size}): every contract enum value and every diversity value appears`, () => {
    const d = size === "pilot" ? pilot : buildPlaceholderData({ size, seed: 7, now: NOW });
    const C = d.collections;
    const has = (label: string, values: readonly unknown[], seen: unknown[]) => {
      const set = new Set(seen.map(String));
      assertEquals(values.filter((v) => !set.has(String(v))), [], `${size} ${label}`);
    };
    has("membership status", ["pending", "active", "past_due", "cancelled"], C.memberships.map((m) => m.status));
    assertEquals(C.memberships.some((m) => m.status === "active" && m.cancelAtPeriodEnd === true), true, "cancelAtPeriodEnd");
    has("consultation status", ["booked", "in_progress", "completed", "no_show", "cancelled"], C.consultations.map((c) => c.status));
    has("consent", ["pending", "granted", "declined"], C.consultations.map((c) => (c.consent as { recording: string }).recording));
    has("summary", ["suggested", "confirmed"], C.consultations.map((c) => (c.summary as { status?: string } | undefined)?.status));
    has("opportunity stage", ["identified", "quoted", "negotiating", "won", "lost"], C.opportunities.map((o) => o.stage));
    has("opportunity source", ["handoff", "consultation", "obligation", "manual"], C.opportunities.map((o) => (o.source as { kind: string }).kind));
    has("task type", ["onboarding", "follow_up", "missing_document", "proposal", "renewal", "escalation", "privacy"], C.csm_tasks.map((t) => t.type));
    has("task status", ["open", "done", "cancelled"], C.csm_tasks.map((t) => t.status));
    has("task source", ["membership", "consultation", "handoff", "quote", "document", "privacy_request", "manual"], C.csm_tasks.map((t) => (t.source as { kind: string }).kind));
    assertEquals(C.csm_tasks.some((t) => t.status === "open" && String(t.dueAt) < NOW.toISOString()), true, "overdue task");
    has("task rule events", Object.keys(TASK_RULES).filter((k) => !["call.link_failed"].includes(k)).map((k) => k.replace(/[^a-z0-9]+/gi, "_")),
      [...new Set(C.csm_tasks.map((t) => String(t.id).replace(/^ph_task_/, "").split("__")[0]))]);
    has("obligation status", ["upcoming", "asked", "handled", "dismissed"], C.obligations.map((o) => o.status));
    has("privacy kind", ["access", "export", "rectify", "delete", "restrict"], C.privacy_requests.map((p) => p.kind));
    has("privacy status", ["received", "in_review", "completed", "refused"], C.privacy_requests.map((p) => p.status));
    has("feedback kind", ["post_call", "monthly", "cancel"], C.member_feedback.map((f) => f.kind));
    has("post-call score", [1, 2, 3, 4, 5], C.member_feedback.filter((f) => f.kind === "post_call").map((f) => f.score));
    has("monthly score", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], C.member_feedback.filter((f) => f.kind === "monthly").map((f) => f.score));
    has("consent kind", ["terms", "privacy", "recording", "marketing_email", "ai_assistant"], C.consents.map((c) => c.kind));
    has("funnel step", ["check_started", "check_completed", "check_email_given", "join_started", "join_paid"], C.funnel_events.map((f) => f.step));
    has("next step owner", ["client", "lawyer", "ilp"], C.matters.map((m) => (m.nextStep as { who?: string } | undefined)?.who));
    const quotes = C.clients.flatMap((c) => (c.quotes as Array<{ status: string }>) ?? []);
    has("quote status", ["draft", "pending_approval", "changes_requested", "approved", "sent", "sent_to_client", "accepted", "client_accepted", "declined"], quotes.map((q) => q.status));
    has("charge status", ["pending", "paid", "void"], C.clients.flatMap((c) => ((c.charges as Array<{ status: string }>) ?? []).map((x) => x.status)));
    // People and situations
    const meta = (k: string) => C.clients.map((c) => (c.placeholderMeta as Record<string, unknown>)[k]);
    has("background", BACKGROUNDS.map((b) => b.key), meta("background"));
    has("nationality", NATIONALITIES, meta("nationalities").flat());
    has("language", LANGUAGES, meta("language"));
    has("household", HOUSEHOLDS, meta("household"));
    has("residency", RESIDENCIES, meta("residency"));
    has("property", PROPERTIES, meta("property"));
    has("company", COMPANIES, meta("company"));
    has("vehicle", VEHICLES, meta("vehicle"));
    has("employees", EMPLOYEES, meta("employees"));
    has("province", PROVINCES, meta("province"));
    has("pronouns", ["she/her", "he/him", "they/them"], C.clients.map((c) => c.pronouns));
    const ages = meta("age").map(Number);
    assertEquals([Math.min(...ages), Math.max(...ages)], [28, 82], `${size} age range`);
    const names = C.clients.map((c) => `${c.name} ${c.surname}`.trim());
    for (const re of [/[^\x00-\x7F]/, /'/, /-/]) assertEquals(names.some((n) => re.test(n)), true, `${size} name ${re}`);
    assertEquals(C.clients.some((c) => !c.surname), true, "single-name member");
    assertEquals(names.some((n) => n.length >= 30) && names.some((n) => n.length <= 6), true, "long and short names");
    assertEquals(C.clients.some((c) => c.accessibilityNotes), true, "accessibility");
    // Edge cases
    const PF = ["fullName", "phone", "nationality", "dateOfBirth", "maritalStatus", "dependents", "residencyStatus", "residencyExpiresAt", "ownsProperty", "propertyLocation", "hasCompany", "companyType", "ownsVehicle"];
    assertEquals(C.clients.some((c) => PF.every((k) => c[k] === undefined)), true, "empty profile");
    assertEquals(C.clients.some((c) => PF.every((k) => c[k] !== undefined)), true, "100% profile");
    const perClient = (list: Array<Record<string, unknown>>) => list.reduce((m, x) => m.set(String(x.clientId), (m.get(String(x.clientId)) ?? 0) + 1), new Map<string, number>());
    assertEquals([...perClient(C.matters).values()].some((n) => n >= 5), true, "5+ matters");
    assertEquals(C.memberships.some((m) => m.callsUsed === 3 && m.minutesUsed === 60), true, "all calls used");
    const withCalls = new Set(C.consultations.map((c) => c.clientId));
    assertEquals(C.memberships.some((m) => m.status === "active" && Date.parse(String(m.activatedAt)) < NOW.getTime() - 60 * 86_400_000 && !withCalls.has(m.clientId)), true, "zero calls in months");
    const crDay = (v: unknown) => new Date(Date.parse(String(v)) - 6 * 3_600_000).toISOString().slice(0, 10);
    assertEquals(C.memberships.some((m) => m.activatedAt && crDay(m.activatedAt) === crDay(NOW.toISOString())), true, "joined today");
    assertEquals(C.memberships.some((m) => m.status === "active" && crDay(m.periodEnd) === crDay(NOW.toISOString())), true, "renewing today");
    assertEquals(C.clients.some((c) => C.memberships.some((m) => m.clientId === c.id && m.status === "active") && !c.assignedProviderId), true, "unassigned member");
    const texts = C.clients.flatMap((c) => [...((c.notes as Array<{ text: string }>) ?? []).map((n) => n.text), ...((c.statusComments as Array<{ body: string }>) ?? []).map((m) => m.body)]);
    assertEquals(texts.some((t) => t.length > 400) && texts.some((t) => t.length <= 3), true, "long and short notes");
    assertEquals(texts.some((t) => /\p{Extended_Pictographic}/u.test(t)), true, "emoji");
    assertEquals(texts.some((t) => /[¿¡]|Gracias|Hola/.test(t)), true, "Spanish message");
    // Lawyers and staff
    const lawyers = C.providers.map((p) => String(p.id));
    const avail = new Map(C.lawyer_availability.map((a) => [String(a.id), a]));
    assertEquals(lawyers.some((id) => !avail.has(id)), true, "lawyer without availability");
    assertEquals(C.lawyer_availability.some((a) => (a.blackoutDates as string[]).length > 3), true, "vacation blackout");
    const booked = C.consultations.filter((c) => c.status === "booked");
    const fully = [...avail.values()].some((a) => {
      const days = new Map<string, number>();
      for (const c of booked.filter((x) => x.providerId === a.id)) days.set(String(c.scheduledAt).slice(0, 10), (days.get(String(c.scheduledAt).slice(0, 10)) ?? 0) + 1);
      return [...days.values()].some((n) => n >= Number(a.maxCallsPerDay));
    });
    assertEquals(fully, true, "a fully booked lawyer");
    const owners = new Set(C.csm_tasks.filter((t) => t.status === "open").map((t) => t.ownerEmail));
    assertEquals(owners.has("sofia.herrera@example.com"), false, "a CSM with an empty queue");
    assertEquals(diversityReport(d).length > 30, true);
  });
}
