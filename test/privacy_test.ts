import { assert, assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  businessDaysFrom,
  ERASURE_PLAN,
  latestConsents,
  parseConsentInput,
  retentionConfig,
  RETENTION_DEFAULTS,
  sha256Hex,
  VERSION_FOR_KIND,
} from "../API/privacy/policy.ts";
import { buildExport, type ExportBundle } from "../API/privacy/exportData.ts";
import { erasureBlocker, planErasure, runErasure, type Store, subjectFor } from "../API/privacy/erasure.ts";
import { membershipEndedAt, retentionTargets, runRetention, type RetentionStore, transcriptExpired } from "../jobs/privacyRetention.ts";
import { cleanUri, parseCspReports, resetCspThrottle, shouldStore } from "../API/privacy/cspReport.ts";
import type { ConsentRecord } from "../schemas/contracts.ts";

/** P6 privacy: export shape, deletion matrix, retention, consents, CSP reports. Run: deno test --allow-env test/privacy_test.ts */

type Doc = Record<string, unknown>;
const NOW = new Date("2026-10-26T15:00:00Z");

/** Every key anywhere in a value (deep). */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Doc)) { out.add(k); allKeys(x, out); }
  return out;
}

const bundle = (): ExportBundle => ({
  client: {
    id: "cli_1", name: "Gloria Hayes", email: "gloria@example.com", phone: "+1 503 555 0142", propertyProvince: "Guanacaste",
    notes: [{ body: "Upsell S.A. clean-up, margin 38%" }], priorityRank: 2, transcriptInsights: { buyingSignal: "high" },
    quotes: [{ id: "q1", title: "S.A. clean-up", total: 900, costSubtotal: 520, marginPct: 42, lines: [{ label: "Filing", marginPct: 40, earnings: 300 }] }],
    statusComments: [{ id: "c1", authorType: "staff", author: "mariela.solis@internationallegalpartner.com", body: "Welcome", createdAt: "2026-10-02T10:00:00Z" }],
    statusChatThread: [{ role: "user", content: "When is the corporation tax due?", createdAt: "2026-10-03T10:00:00Z" }, { role: "assistant", content: "It may require review by Jan 31.", createdAt: "2026-10-03T10:00:05Z" }],
    funnelAnonId: "anon12345678",
  },
  memberships: [{ id: "mem_1", clientId: "cli_1", status: "active", csmEmail: "mariela@internationallegalpartner.com", createdAt: "2026-10-01T00:00:00Z" }],
  matters: [{ id: "mat_1", clientId: "cli_1", title: "Corporation", openedAt: "2026-10-01T00:00:00Z" }],
  consultations: [{ id: "con_1", clientId: "cli_1", transcript: "Lawyer: hello", summary: { text: "Discussed S.A.", status: "confirmed" }, scheduledAt: "2026-10-10T16:00:00Z" }],
  handoffs: [{ id: "hof_1", consultationId: "con_1", clientId: "cli_1", legalNextSteps: [{ what: "Send the S.A. books", who: "client" }], commercialNotes: "Quote S.A. clean-up at US$900, margin 42%", csmTaskIds: ["task_9"], approvedAt: "2026-10-10T17:00:00Z" }],
  obligations: [{ id: "obl_1", clientId: "cli_1", title: "Corporation tax", dueAt: "2027-01-31T00:00:00Z" }],
  documents: [{ id: "doc_1", clientId: "cli_1", fileName: "passport.pdf", category: "identity", storage: "gcs", objectName: "members/cli_1/doc_1", dataBase64: "AAAA", uploadedAt: "2026-10-04T00:00:00Z" }],
  feedback: [{ id: "fb_1", clientId: "cli_1", kind: "post_call", score: 5, at: "2026-10-11T00:00:00Z" }],
  leads: [{ id: "lead_1", email: "gloria@example.com", answers: { property: true }, createdAt: "2026-09-30T00:00:00Z" }],
  consents: [{ id: "cns_1", clientId: "cli_1", email: "gloria@example.com", kind: "terms", granted: true, version: "terms-x", source: "join", at: "2026-10-01T00:00:00Z" }],
  privacyRequests: [],
  invoices: [{ id: "inv_1", clientId: "cli_1", invoiceNumber: "ILP-0007", total: 179.99, status: "paid", lineItems: [{ cost: 10 }], createdAt: "2026-10-01T00:00:00Z" }],
});

Deno.test("export: member data in, commercial notes / margins / internal notes / storage paths out", () => {
  const out = buildExport(bundle(), { now: NOW, documentUrl: (id) => `https://api.example/api/client-status/me/documents/${id}/file`, memberName: "Gloria Hayes" });
  const keys = allKeys(out);
  for (const k of ["commercialNotes", "marginPct", "costSubtotal", "earnings", "priorityRank", "objectName", "dataBase64", "csmTaskIds", "csmEmail", "notes", "transcriptInsights", "lineItems"]) {
    assertEquals(keys.has(k), false, `export leaks ${k}`);
  }
  assert(!JSON.stringify(out).includes("margin 42%"), "commercial note text leaked");
  assert(!JSON.stringify(out).includes("Upsell"), "staff note text leaked");
  const o = out as Doc;
  assertEquals((o.profile as Doc).propertyProvince, "Guanacaste");
  assertEquals(((o.consultations as Doc[])[0]).transcript, "Lawyer: hello");
  assertEquals((o.legalNextSteps as Doc[])[0].legalNextSteps, [{ what: "Send the S.A. books", who: "client" }]);
  assertEquals((o.documents as Doc[])[0].downloadUrl, "https://api.example/api/client-status/me/documents/doc_1/file");
  assertEquals((o.messages as Doc[]).map((m) => m.kind), ["team", "member", "ai"]);
  assertEquals((o.invoices as Doc[])[0], { id: "inv_1", invoiceNumber: "ILP-0007", issuedAt: "2026-10-01T00:00:00Z", status: "paid", total: 179.99, currency: undefined });
  const quote = ((o.profile as Doc).quotes as Doc[])[0];
  assertEquals([quote.total, quote.costSubtotal], [900, undefined]);
});

// ── In-memory store ──────────────────────────────────────────────────────

function memStore(seed: Record<string, Doc[]>, failFiles = false): Store & { db: Map<string, Map<string, Doc>>; files: string[] } {
  const db = new Map<string, Map<string, Doc>>();
  for (const [c, rows] of Object.entries(seed)) db.set(c, new Map(rows.map((r) => [String(r.id), { ...r }])));
  const col = (c: string) => db.get(c) ?? (db.set(c, new Map()), db.get(c)!);
  const files: string[] = [];
  return {
    db,
    files,
    get: (c, id) => Promise.resolve(col(c).get(id) ? { ...col(c).get(id)! } : null),
    where: (c, f, v) => Promise.resolve([...col(c).values()].filter((d) => d[f] === v).map((d) => ({ ...d }))),
    replace: (c, id, doc) => { col(c).set(id, { ...doc }); return Promise.resolve(); },
    remove: (c, id) => { col(c).delete(id); return Promise.resolve(); },
    removeFile: (name) => failFiles ? Promise.reject(new Error("503")) : (files.push(name), Promise.resolve()),
  };
}

const seed = (status = "cancelled"): Record<string, Doc[]> => ({
  clients: [{ id: "cli_1", name: "Gloria Hayes", email: "gloria@example.com", phone: "+1 503 555 0142", funnelAnonId: "anon12345678", createdAt: "2026-10-01T00:00:00Z", membershipStatus: status }, { id: "cli_2", name: "Other", email: "other@example.com" }],
  memberships: [{ id: "mem_1", clientId: "cli_1", status, periodEnd: "2026-10-31T00:00:00Z", paymentRef: "sub_123", cancelReason: "Moving back to Ohio", minutesUsed: 20 }],
  matters: [{ id: "mat_1", clientId: "cli_1", title: "S.A." }, { id: "mat_2", clientId: "cli_2", title: "Other" }],
  handoffs: [{ id: "hof_1", clientId: "cli_1", commercialNotes: "x" }],
  obligations: [{ id: "obl_1", clientId: "cli_1" }],
  csm_tasks: [{ id: "task_1", clientId: "cli_1", title: "Call Gloria" }],
  opportunities: [{ id: "opp_1", clientId: "cli_1", title: "Gloria S.A. clean-up", valueCents: 90000, stage: "won", outcome: "Signed" }],
  consultations: [{ id: "con_1", clientId: "cli_1", providerId: "prov_1", status: "completed", minutesUsed: 20, transcript: "secret", question: "My S.A.?", consent: { recording: "granted" }, meetUrl: "https://meet.google.com/abc" }],
  member_documents: [{ id: "doc_1", clientId: "cli_1", storage: "gcs", objectName: "members/cli_1/doc_1" }, { id: "doc_2", clientId: "cli_1", storage: "inline", dataBase64: "AA" }],
  member_feedback: [{ id: "fb_1", clientId: "cli_1", comment: "Great" }],
  funnel_events: [{ id: "join_paid_anon12345678", anonId: "anon12345678" }, { id: "first_call_booked_cli_1", clientId: "cli_1" }, { id: "check_started_zzz", anonId: "zzzzzzzzzz" }],
  leads: [{ id: "lead_1", email: "gloria@example.com" }, { id: "lead_2", convertedClientId: "cli_1", email: "old@example.com" }, { id: "lead_3", email: "x@example.com" }],
  push_subscriptions: [{ id: "gloria_example_com", email: "gloria@example.com" }],
  client_status_sessions: [{ id: "tok1", email: "gloria@example.com" }],
  client_status_otps: [{ id: "gloria_example_com", codeHash: "h" }],
  join_sessions: [{ id: "jt1", clientId: "cli_1", email: "gloria@example.com" }],
  email_queue: [{ id: "e1", to: "gloria@example.com", subject: "Hi" }, { id: "e2", to: "other@example.com" }],
  invoices: [{ id: "inv_1", clientId: "cli_1", clientEmail: "gloria@example.com", total: 179.99 }],
  consents: [{ id: "cns_1", clientId: "cli_1", email: "gloria@example.com", kind: "terms", granted: true }],
  privacy_requests: [{ id: "prq_1", clientId: "cli_1", email: "gloria@example.com", kind: "delete", status: "received" }],
  audit_log: [{ id: "a1", actor: { email: "gloria@example.com" }, action: "auth.login" }],
});

Deno.test("deletion: blocked while a membership is open", async () => {
  for (const status of ["pending", "active", "past_due"]) {
    const st = memStore(seed(status));
    assert((await erasureBlocker(st, "cli_1"))?.includes(status), status);
  }
  assertEquals(await erasureBlocker(memStore(seed("cancelled")), "cli_1"), null);
});

Deno.test("deletion matrix: deletes, anonymizes, keeps accounting and proof, touches nobody else", async () => {
  const st = memStore(seed());
  const subject = subjectFor("cli_1", "Gloria@Example.com", (await st.get("clients", "cli_1")));
  const plan = await planErasure(st, subject);
  assertEquals(plan.find((l) => l.collection === "leads")?.count, 2);
  assertEquals(plan.find((l) => l.collection === "funnel_events")?.count, 2);
  const res = await runErasure(st, subject, NOW);
  const rows = (c: string) => [...(st.db.get(c)?.values() ?? [])];

  for (const c of ["handoffs", "obligations", "csm_tasks", "member_documents", "member_feedback", "push_subscriptions", "client_status_sessions", "client_status_otps", "join_sessions"]) {
    assertEquals(rows(c).length, 0, `${c} not deleted`);
  }
  assertEquals(rows("matters").map((d) => d.id), ["mat_2"]);
  assertEquals(rows("leads").map((d) => d.id), ["lead_3"]);
  assertEquals(rows("funnel_events").map((d) => d.id), ["check_started_zzz"]);
  assertEquals(rows("email_queue").map((d) => d.id), ["e2"]);
  assertEquals(st.files, ["members/cli_1/doc_1"]);
  assertEquals(res.filesDeleted, 1);

  const client = rows("clients").find((d) => d.id === "cli_1")!;
  assertEquals([client.name, client.email, client.phone, client.erased], [undefined, undefined, undefined, true]);
  assertEquals(rows("clients").find((d) => d.id === "cli_2")?.email, "other@example.com");
  const con = rows("consultations")[0];
  assertEquals([con.transcript, con.question, con.meetUrl, con.minutesUsed, (con.consent as Doc).recording], [undefined, undefined, undefined, 20, "granted"]);
  const mem = rows("memberships")[0];
  assertEquals([mem.cancelReason, mem.paymentRef, mem.minutesUsed], [undefined, "sub_123", 20]);
  const opp = rows("opportunities")[0];
  assertEquals([opp.title, opp.outcome, opp.valueCents], [undefined, undefined, 90000]);

  assertEquals(rows("invoices")[0].clientEmail, "gloria@example.com"); // kept for accounting
  assertEquals(rows("audit_log").length, 1); // append-only, kept
  const hash = `sha256:${await sha256Hex("gloria@example.com")}`;
  assertEquals(rows("consents")[0].email, hash);
  assertEquals(rows("consents")[0].granted, true);
  assertEquals(rows("privacy_requests")[0].email, hash);

  // Idempotent: a second run changes nothing it already handled.
  const again = await runErasure(st, subject, NOW);
  assertEquals(again.lines.find((l) => l.collection === "consents")?.count, 0);
  assertEquals(again.lines.find((l) => l.collection === "member_documents")?.count, 0);
});

Deno.test("deletion matrix: a file that cannot be deleted keeps its metadata for a retry", async () => {
  const st = memStore(seed(), true);
  const res = await runErasure(st, subjectFor("cli_1", "gloria@example.com", null), NOW);
  assertEquals(res.fileErrors, 1);
  assertEquals([...st.db.get("member_documents")!.keys()], ["doc_1"]);
});

Deno.test("deletion matrix: every rule says why, and accounting + audit are kept", () => {
  for (const r of ERASURE_PLAN) assert(r.why.length > 10, r.collection);
  assertEquals(ERASURE_PLAN.find((r) => r.collection === "invoices")?.action, "keep");
  assertEquals(ERASURE_PLAN.find((r) => r.collection === "audit_log")?.action, "keep");
  assertEquals(ERASURE_PLAN.at(-1)?.collection, "clients"); // tombstone last
  const eq = ERASURE_PLAN.findIndex((r) => r.collection === "email_queue");
  assert(eq >= 0);
});

Deno.test("consents: validation, versions, latest wins", () => {
  assertEquals(parseConsentInput({ kind: "recording", granted: true, source: "booking", consultationId: "con_1" }), { kind: "recording", granted: true, source: "booking", version: VERSION_FOR_KIND.recording, consultationId: "con_1" });
  assert("error" in parseConsentInput({ kind: "sell_data", granted: true }));
  assert("error" in parseConsentInput({ kind: "terms", granted: "yes" }));
  assert("error" in parseConsentInput({ kind: "terms", granted: true, version: "terms-1999" }));
  assert("error" in parseConsentInput({ kind: "terms", granted: true, source: "<x>" }));
  const r = (kind: ConsentRecord["kind"], granted: boolean, at: string) => ({ id: at, email: "a@b.c", kind, granted, version: "v", source: "s", at });
  const latest = latestConsents([r("marketing_email", true, "2026-10-02"), r("marketing_email", false, "2026-10-05"), r("recording", true, "2026-10-01")]);
  assertEquals([latest.marketing_email?.granted, latest.recording?.granted, latest.terms], [false, true, undefined]);
});

Deno.test("privacy request deadline: business days, env override", () => {
  // Monday 2026-10-26 + 10 business days = Monday 2026-11-09
  assertEquals(businessDaysFrom(NOW, 10).toISOString().slice(0, 10), "2026-11-09");
  // Friday + 1 business day = Monday
  assertEquals(businessDaysFrom(new Date("2026-10-30T12:00:00Z"), 1).toISOString().slice(0, 10), "2026-11-02");
  assertEquals(retentionConfig(() => undefined), RETENTION_DEFAULTS);
  assertEquals(retentionConfig((k) => (k === "RETENTION_LEAD_MONTHS" ? "6" : k === "RETENTION_ERROR_LOG_DAYS" ? "abc" : undefined)).leadMonths, 6);
  assertEquals(retentionConfig((k) => (k === "RETENTION_ERROR_LOG_DAYS" ? "abc" : undefined)).errorLogDays, 90);
});

// ── Retention job ────────────────────────────────────────────────────────

function retStore(seedRows: Record<string, Doc[]>): RetentionStore & { db: Map<string, Map<string, Doc>> } {
  const db = new Map<string, Map<string, Doc>>();
  for (const [c, rows] of Object.entries(seedRows)) db.set(c, new Map(rows.map((r) => [String(r.id), { ...r }])));
  const col = (c: string) => db.get(c) ?? (db.set(c, new Map()), db.get(c)!);
  return {
    db,
    olderThan: (c, f, iso) => Promise.resolve([...col(c).values()].filter((d) => typeof d[f] === "string" && String(d[f]) < iso)),
    where: (c, f, v) => Promise.resolve([...col(c).values()].filter((d) => d[f] === v)),
    remove: (c, id) => { col(c).delete(id); return Promise.resolve(); },
    replace: (c, id, doc) => { col(c).set(id, doc); return Promise.resolve(); },
  };
}

Deno.test("retention: deletes only what is past its period", async () => {
  const st = retStore({
    leads: [{ id: "old", createdAt: "2025-06-01T00:00:00Z" }, { id: "oldConverted", createdAt: "2025-06-01T00:00:00Z", convertedClientId: "cli_1" }, { id: "new", createdAt: "2026-09-01T00:00:00Z" }],
    error_log: [{ id: "e_old", at: "2026-07-01T00:00:00Z" }, { id: "e_new", at: "2026-10-20T00:00:00Z" }],
    funnel_events: [{ id: "f_old", at: "2025-08-01T00:00:00Z" }, { id: "f_new", at: "2025-12-01T00:00:00Z" }],
    client_status_otps: [{ id: "o1", expiresAt: "2026-10-20T00:00:00Z" }, { id: "o2", expiresAt: "2026-10-26T15:05:00Z" }],
    dashboard_sessions: [{ id: "s1", expiresAt: "2026-10-25T16:00:00Z" }, { id: "s2", expiresAt: "2026-10-24T00:00:00Z" }],
    email_queue: [{ id: "q_sent", createdAt: "2026-06-01T00:00:00Z", status: "sent" }, { id: "q_pending", createdAt: "2026-06-01T00:00:00Z", status: "pending" }],
    ilp_chatbot_threads: [{ id: "t1", updatedAt: "2026-01-01T00:00:00Z" }],
    memberships: [
      { id: "m1", clientId: "cli_ended", status: "cancelled", cancelledAt: "2024-01-15T00:00:00Z" },
      { id: "m2", clientId: "cli_back", status: "cancelled", cancelledAt: "2024-01-15T00:00:00Z" },
      { id: "m3", clientId: "cli_back", status: "active" },
    ],
    consultations: [
      { id: "c1", clientId: "cli_ended", transcript: "t", summary: { text: "s" }, minutesUsed: 20 },
      { id: "c2", clientId: "cli_back", transcript: "t" },
    ],
  });
  const counts = await runRetention(st, RETENTION_DEFAULTS, NOW);
  const ids = (c: string) => [...st.db.get(c)!.keys()].sort();
  assertEquals(ids("leads"), ["new", "oldConverted"]);
  assertEquals(ids("error_log"), ["e_new"]);
  assertEquals(ids("funnel_events"), ["f_new"]);
  assertEquals(ids("client_status_otps"), ["o2"]);
  assertEquals(ids("dashboard_sessions"), ["s1"]); // inside the 1-day grace
  assertEquals(ids("email_queue"), ["q_pending"]);
  assertEquals(ids("ilp_chatbot_threads"), []);
  const c1 = st.db.get("consultations")!.get("c1")!;
  assertEquals([c1.transcript, c1.summary, c1.minutesUsed, typeof c1.transcriptRemovedAt], [undefined, undefined, 20, "string"]);
  assertEquals(st.db.get("consultations")!.get("c2")!.transcript, "t"); // came back: still a member
  assertEquals(counts["transcripts after membership end"], 1);
  assertEquals(retentionTargets(RETENTION_DEFAULTS, NOW).length, 13); // + download_tickets (AUTH)
  assertEquals(transcriptExpired([], new Date()), false);
});

Deno.test("retention: memberships that ended without cancelledAt (period end, past_due beyond grace) (P7)", async () => {
  const st = retStore({
    memberships: [
      { id: "m_pe", clientId: "cli_period_end", status: "cancelled", periodEnd: "2024-02-01T00:00:00Z" },
      { id: "m_pd", clientId: "cli_past_due", status: "past_due", periodEnd: "2024-03-01T00:00:00Z" },
      { id: "m_recent", clientId: "cli_recent", status: "cancelled", periodEnd: "2026-01-01T00:00:00Z" },
    ],
    consultations: [
      { id: "c_pe", clientId: "cli_period_end", transcript: "t", minutesUsed: 20 },
      { id: "c_pd", clientId: "cli_past_due", summary: { text: "s" } },
      { id: "c_recent", clientId: "cli_recent", transcript: "t" },
    ],
  });
  const counts = await runRetention(st, RETENTION_DEFAULTS, NOW);
  const con = (id: string) => st.db.get("consultations")!.get(id)!;
  assertEquals([con("c_pe").transcript, con("c_pe").minutesUsed, typeof con("c_pe").transcriptRemovedAt], [undefined, 20, "string"]);
  assertEquals(con("c_pd").summary, undefined);
  assertEquals(con("c_recent").transcript, "t"); // ended 10 months ago: inside 24 months
  assertEquals(counts["transcripts after membership end"], 2);

  // the end date rules themselves
  assertEquals(membershipEndedAt({ status: "cancelled", cancelledAt: "2024-01-15T00:00:00Z", periodEnd: "2024-02-01T00:00:00Z" }, NOW), "2024-01-15T00:00:00Z");
  assertEquals(membershipEndedAt({ status: "cancelled", periodEnd: "2024-02-01T00:00:00Z" }, NOW), "2024-02-01T00:00:00Z");
  assertEquals(membershipEndedAt({ status: "past_due", periodEnd: "2026-10-22T00:00:00Z" }, NOW), null); // day 4 of 7: still open
  assertEquals(membershipEndedAt({ status: "past_due", periodEnd: "2026-10-18T00:00:00Z" }, NOW), "2026-10-18T00:00:00Z"); // beyond grace
  assertEquals(membershipEndedAt({ status: "active", periodEnd: "2024-01-01T00:00:00Z" }, NOW), null);
  assertEquals(membershipEndedAt({ status: "pending" }, NOW), null);
  // a past_due inside grace keeps every transcript, even with an old cancelled membership beside it
  const cutoff = new Date("2024-10-26T00:00:00Z");
  assertEquals(transcriptExpired([{ status: "cancelled", cancelledAt: "2023-01-01T00:00:00Z" }, { status: "past_due", periodEnd: "2026-10-24T00:00:00Z" }], cutoff, NOW), false);
  assertEquals(transcriptExpired([{ status: "cancelled", cancelledAt: "2023-01-01T00:00:00Z" }, { status: "past_due", periodEnd: "2024-01-01T00:00:00Z" }], cutoff, NOW), true);
});

Deno.test("retention: per-run cap", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `e${i}`, at: "2025-01-01T00:00:00Z" }));
  const st = retStore({ error_log: rows });
  await runRetention(st, { ...RETENTION_DEFAULTS, maxDeletesPerRun: 5 }, NOW);
  assertEquals(st.db.get("error_log")!.size, 2);
});

// ── CSP reports ──────────────────────────────────────────────────────────

Deno.test("csp reports: both formats, URLs cleaned, deduped", () => {
  resetCspThrottle();
  const legacy = parseCspReports({ "csp-report": { "document-uri": "https://ilp.example/status?token=abc#x", "violated-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js?u=me@example.com", disposition: "report", "source-file": "https://ilp.example/_next/a.js", "line-number": 3 } });
  assertEquals(legacy, [{ directive: "script-src-elem", blocked: "https://evil.example/x.js", page: "https://ilp.example/status", disposition: "report", source: "https://ilp.example/_next/a.js:3" }]);
  const modern = parseCspReports([{ type: "csp-violation", body: { documentURL: "https://ilp.example/join", effectiveDirective: "img-src", blockedURL: "data", disposition: "enforce" } }, { type: "deprecation", body: {} }]);
  assertEquals(modern.map((v) => [v.directive, v.blocked]), [["img-src", "data"]]);
  assertEquals(parseCspReports("nonsense"), []);
  assertEquals(cleanUri("inline"), "inline");
  const t = 1_000_000;
  assertEquals(shouldStore(modern[0], t), true);
  assertEquals(shouldStore(modern[0], t + 1000), false);
  assertEquals(shouldStore(modern[0], t + 11 * 60_000), true);
});
