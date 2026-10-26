import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import {
  buildTimeline,
  computeAttention,
  computeKpis,
  filterMembers,
  memberRows,
} from "../API/dashboard/staffHome/compute.ts";
import type { Consultation, CsmTask, Handoff, Matter, Membership, Obligation } from "../schemas/contracts.ts";

/**
 * Staff Today (W6): KPI strip, Needs attention rail, members list, timeline.
 * Pure functions only: no Firestore, no network.
 *
 * Run: deno test --allow-env test/staffHome_test.ts
 */

const NOW = new Date("2026-10-26T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();
const inDays = (d: number) => new Date(NOW.getTime() + d * 86400_000).toISOString();

const READY = {
  fullName: "Robert James Hayes", email: "r@example.com", phone: "+1", nationality: "US", dateOfBirth: "1957-04-12",
  maritalStatus: "married", dependents: 0, residencyStatus: "pensionado", residencyExpiresAt: inDays(100),
  ownsProperty: true,
};

function mem(id: string, over: Partial<Membership> = {}): Membership {
  return {
    id: `m_${id}`, clientId: id, plan: "standard", status: "active", country: "CR",
    activatedAt: daysAgo(30), periodStart: daysAgo(30), periodEnd: inDays(1),
    minutesIncluded: 60, minutesUsed: 20, callsIncluded: 3, callsUsed: 1,
    csmEmail: "csm@internationallegalpartner.com", createdAt: daysAgo(30), updatedAt: daysAgo(1), ...over,
  };
}

const clients = new Map<string, Record<string, unknown>>([
  ["hayes", { id: "hayes", name: "Robert", surname: "Hayes", email: "r@example.com", clientFields: READY, assignedProviderId: "p1" }],
  ["delaney", { id: "delaney", name: "Mark", surname: "Delaney", email: "m@example.com", quotes: [
    { id: "q1", title: "S.R.L. registration", status: "sent", createdAt: daysAgo(6), totalMinor: 38000 },
    { id: "q2", title: "Fresh quote", status: "sent", createdAt: daysAgo(2), totalMinor: 1000 },
  ] }],
  ["novak", { id: "novak", name: "Gary", surname: "Novak", quotes: [
    { id: "q3", title: "S.A. clean-up", status: "client_accepted", clientAcceptedAt: daysAgo(3), totalMinor: 145000 },
  ], charges: [{ status: "paid", amountMinor: 7999, createdAt: daysAgo(4) }] }],
  ["old", { id: "old", name: "Ann", surname: "Old", clientFields: READY }],
]);

const memberships = [
  mem("hayes"),
  mem("delaney", { activatedAt: daysAgo(0.5), createdAt: daysAgo(0.5) }),
  mem("novak", { status: "past_due", activatedAt: daysAgo(120) }),
  mem("old", { activatedAt: daysAgo(100) }),
  mem("gone", { status: "cancelled", activatedAt: daysAgo(150), cancelledAt: daysAgo(20) }),
];

Deno.test("MRR counts active memberships only; delta shows today's join", () => {
  const k = computeKpis({ memberships, clients, tasks: [], handoffs: [], consultations: [], now: NOW });
  assertEquals(k.mrr.activeMembers, 3);
  assertEquals(k.mrr.cents, 3 * 7999);
  assertEquals(k.mrr.deltaCents24h, 7999);
});

Deno.test("month-3 retention uses members activated 90+ days ago", () => {
  const k = computeKpis({ memberships, clients, tasks: [], handoffs: [], consultations: [], now: NOW });
  // novak (past_due, still paying), old (active), gone (cancelled) → 2 of 3
  assertEquals(k.retentionM3.cohort, 3);
  assertEquals(k.retentionM3.retained, 2);
  assertEquals(k.retentionM3.pct, 66.7);
});

Deno.test("consultation-ready share, handoff SLA, overdue tasks, GMV apart from revenue", () => {
  const cons = [
    { id: "c1", endedAt: daysAgo(3) } as Consultation,
    { id: "c2", endedAt: daysAgo(5) } as Consultation,
  ];
  const hofs = [
    { id: "h1", consultationId: "c1", approvedAt: new Date(Date.parse(daysAgo(3)) + 3600_000).toISOString() } as Handoff,
    { id: "h2", consultationId: "c2", approvedAt: daysAgo(3) } as Handoff,
  ];
  const tasks = [
    { id: "t1", status: "open", dueAt: daysAgo(1), ownerEmail: "csm@internationallegalpartner.com" },
    { id: "t2", status: "open", dueAt: daysAgo(2), ownerEmail: "other@internationallegalpartner.com" },
    { id: "t3", status: "open", dueAt: inDays(1), ownerEmail: "csm@internationallegalpartner.com" },
  ] as CsmTask[];
  const k = computeKpis({ memberships, clients, tasks, handoffs: hofs, consultations: cons, me: "csm@internationallegalpartner.com", now: NOW });
  assertEquals(k.consultationReady, { pct: 66.7, ready: 2, active: 3 });
  assertEquals(k.handoffSla, { pct: 50, within24h: 1, total: 2 });
  assertEquals(k.overdueTasks, { total: 2, mine: 1 });
  assertEquals(k.legalGmv30d, { cents: 145000, quotes: 1 });
  assertEquals(k.platformRevenue30d.cents, 7999);
});

Deno.test("needs attention: aging matters, obligations in 14 days, stale quotes, not ready, unassigned", () => {
  const matters = [
    { id: "mt1", clientId: "hayes", title: "Title check", stage: "legal_review", stageEnteredAt: daysAgo(19), assignedProviderId: "p1" },
    { id: "mt2", clientId: "old", title: "DIMEX", stage: "intake", stageEnteredAt: daysAgo(2), nextStep: { what: "Upload birth certificate", who: "client", dueAt: daysAgo(4) } },
    { id: "mt3", clientId: "hayes", title: "Fresh", stage: "intake", stageEnteredAt: daysAgo(1) },
    { id: "mt4", clientId: "hayes", title: "Closed", stage: "closed", stageEnteredAt: daysAgo(60), closedAt: daysAgo(30) },
  ] as Matter[];
  const obligations = [
    { id: "o1", clientId: "hayes", country: "CR", ruleId: "CR-marchamo", title: "Marchamo", dueAt: inDays(10), status: "upcoming" },
    { id: "o2", clientId: "hayes", country: "CR", ruleId: "CR-corp-tax", title: "Corp tax", dueAt: inDays(90), status: "upcoming" },
    { id: "o3", clientId: "hayes", country: "CR", ruleId: "x", title: "Handled", dueAt: inDays(3), status: "handled" },
  ] as Obligation[];
  const notReadyClients = new Map(clients);
  notReadyClients.set("late", { id: "late", name: "Lena", surname: "Late" });
  const a = computeAttention({
    memberships: [...memberships, mem("late", { activatedAt: daysAgo(9) })],
    clients: notReadyClients,
    matters,
    obligations,
    now: NOW,
  });
  assertEquals(a.overdueMatters.map((x) => x.ref), ["mt1", "mt2"]);
  assertEquals(a.obligationsDue.map((x) => x.ref), ["o1"]);
  assertEquals(a.quotesUnanswered.map((x) => x.ref), ["q1"]);
  assertEquals(a.notReady.map((x) => x.clientId), ["late"]);
  // hayes has an assigned matter; old has an open matter without a lawyer; novak is past_due (skipped)
  assertEquals(a.unassigned.map((x) => x.clientId).sort(), ["delaney", "late", "old"]);
});

Deno.test("members list filters, searches and paginates on the server", () => {
  const rows = memberRows(memberships, clients, [{ id: "t", clientId: "hayes", status: "open" } as CsmTask]);
  assertEquals(rows.length, 5);
  assertEquals(rows.find((r) => r.clientId === "hayes")?.openTasks, 1);
  assertEquals(filterMembers(rows, { status: "active" }).total, 3);
  assertEquals(filterMembers(rows, { ready: "ready" }).items.map((r) => r.clientId).sort(), ["hayes", "old"]);
  assertEquals(filterMembers(rows, { q: "novak" }).items[0].clientId, "novak");
  const p2 = filterMembers(rows, { pageSize: 2, page: 2 });
  assertEquals([p2.total, p2.pages, p2.page, p2.items.length], [5, 3, 2, 2]);
});

Deno.test("timeline merges every source, newest first", () => {
  const items = buildTimeline({
    client: { id: "novak", quotes: [{ id: "q3", title: "S.A. clean-up", createdAt: daysAgo(5), sentToClientAt: daysAgo(4), status: "client_accepted", clientAcceptedAt: daysAgo(3), totalMinor: 145000 }], notes: [{ text: "Prefers WhatsApp", author: "csm", createdAt: daysAgo(2) }] },
    memberships: [mem("novak")],
    consultations: [{ id: "c1", clientId: "novak", providerId: "p1", scheduledAt: daysAgo(6), durationMin: 20, status: "completed", consent: { recording: "granted" }, endedAt: daysAgo(6), createdAt: daysAgo(8) }],
    handoffs: [{ id: "h1", consultationId: "c1", clientId: "novak", providerId: "p1", legalNextSteps: [{ what: "Send books", who: "client" }], approvedAt: daysAgo(5.5), csmTaskIds: [] }],
    tasks: [{ id: "t1", clientId: "novak", type: "proposal", title: "Prepare proposal", dueAt: daysAgo(1), status: "done", outcome: "Sent", source: { kind: "handoff", id: "h1" }, createdAt: daysAgo(5.5), closedAt: daysAgo(1) }],
    audit: [{ id: "a1", action: "staff.assign_lawyer", at: daysAgo(0.5), actor: { email: "csm@x", role: "csm" }, target: "clients/novak" }],
    providerNames: new Map([["p1", "Adriana Mora"]]),
  });
  assertEquals(items[0].kind, "audit");
  assertEquals(items[0].title, "Lawyer assigned");
  const kinds = new Set(items.map((i) => i.kind));
  for (const k of ["membership", "consultation", "handoff", "task", "quote", "note", "audit"]) assertEquals(kinds.has(k as never), true);
  assertEquals(items.some((i) => i.title === "Handoff approved by Adriana Mora"), true);
  for (let i = 1; i < items.length; i++) assertEquals(items[i - 1].at >= items[i].at, true);
});
