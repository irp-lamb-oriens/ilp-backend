import { assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { buildPlaceholderData, countDocs, readyShare } from "../scripts/placeholderData.ts";
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

Deno.test("seed: every document is ph_, placeholder: true and carries the batch", () => {
  for (const d of all()) {
    assertEquals(String(d.id).startsWith("ph_"), true, String(d.id));
    assertEquals(d.placeholder, true, String(d.id));
    assertEquals(d.placeholderBatch, "ph-pilot-7", String(d.id));
  }
  checkWrites(plannedWrites(pilot), pilot.aliasClientId);
});

Deno.test("seed: only reserved emails, 555-01xx phones and PH- identifiers", () => {
  const text = JSON.stringify(pilot);
  const emails = new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g) ?? []);
  assertEquals([...emails].filter((e) => !e.endsWith("@example.com")), []);
  const phones = text.match(/\+1 \d{3} \d{3} \d{4}/g) ?? [];
  assertEquals(phones.length > 0, true);
  assertEquals(phones.filter((p) => !/ 555 01\d\d$/.test(p)), []);
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
