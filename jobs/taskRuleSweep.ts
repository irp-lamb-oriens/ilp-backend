/**
 * jobs/taskRuleSweep.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Time-based TASK_RULES. Runs daily and emits:
 *   membership.renewal_7d  — active membership whose period ends within 7 days
 *   quote.unanswered_5d    — a quote with status "sent" for 5+ days
 *   document.missing_3d    — a document-type pending action overdue by 3+ days
 *   obligation.needs_date_7d — DEADLINES: a member with deadlines still without a
 *                            date 7+ days after they were added (one task per member)
 *
 * emitEvent is idempotent (task id = event + source), so re-running is safe.
 * The pure selectors are exported for tests.
 */

import { isQuoteAwaitingClient, quoteKey, quoteSentAt } from "../schemas/quoteStatus.ts";
import getAll from "../db/getAll.ts";
import { findRecords } from "../db/records.ts";
import log from "../helper/log.ts";
import { COLLECTIONS, type Membership, type Obligation } from "../schemas/contracts.ts";
import { needsDateClients } from "../API/members/deadlines.ts";
import { emitEvent, type EventName, type EventPayload } from "../API/members/events.ts";

const DAY = 86400_000;
type Doc = Record<string, unknown>;

export function renewalEvents(memberships: Membership[], now: Date): Array<[EventName, EventPayload]> {
  return memberships
    .filter((m) => m.status === "active" && m.periodEnd)
    .filter((m) => {
      const left = new Date(m.periodEnd).getTime() - now.getTime();
      return left >= 0 && left <= 7 * DAY;
    })
    .map((m) => ["membership.renewal_7d", {
      clientId: m.clientId,
      // one renewal task per period
      sourceId: `${m.id}_${m.periodEnd.slice(0, 10)}`,
      ownerEmail: m.csmEmail,
    }]);
}

export function unansweredQuoteEvents(clients: Doc[], now: Date): Array<[EventName, EventPayload]> {
  const out: Array<[EventName, EventPayload]> = [];
  for (const c of clients) {
    const quotes = Array.isArray(c.quotes) ? (c.quotes as Doc[]) : [];
    for (const q of quotes) {
      if (!isQuoteAwaitingClient(q)) continue; // sent or sent_to_client (schemas/quoteStatus.ts)
      const sent = quoteSentAt(q) || String(q.updatedAt ?? "");
      if (!sent || now.getTime() - new Date(sent).getTime() < 5 * DAY) continue;
      out.push(["quote.unanswered_5d", {
        clientId: String(c.id),
        sourceId: quoteKey(q) || sent,
        detail: typeof q.title === "string" ? q.title : undefined,
      }]);
    }
  }
  return out;
}

const DOC_WORDS = /(document|upload|passport|pasaporte|c[ée]dula|copy|scan|certificate|certificado|deed|escritura)/i;

export function missingDocumentEvents(clients: Doc[], now: Date): Array<[EventName, EventPayload]> {
  const out: Array<[EventName, EventPayload]> = [];
  for (const c of clients) {
    const actions = Array.isArray(c.pendingActions) ? (c.pendingActions as Doc[]) : [];
    for (const a of actions) {
      const label = String(a.label ?? "");
      if (!DOC_WORDS.test(label) || !a.dueAt) continue;
      if (now.getTime() - new Date(String(a.dueAt)).getTime() < 3 * DAY) continue;
      out.push(["document.missing_3d", { clientId: String(c.id), sourceId: String(a.id ?? label), detail: label }]);
    }
  }
  return out;
}

/** DEADLINES: members (active memberships) with needsDate deadlines older than 7 days. Free accounts get no CSM task. */
export function needsDateEvents(obligations: Obligation[], memberships: Membership[], now: Date): Array<[EventName, EventPayload]> {
  const members = new Set(memberships.filter((m) => m.status === "active").map((m) => m.clientId));
  return needsDateClients(obligations, members, now).map((clientId) => ["obligation.needs_date_7d", {
    clientId,
    sourceId: `${clientId}_needs_date`,
    sourceKind: "obligation",
  }]);
}

export async function taskRuleSweep(): Promise<void> {
  const now = new Date();
  const [memberships, clients, obligations] = await Promise.all([
    findRecords<Membership>(COLLECTIONS.memberships, { status: "active" }),
    getAll(COLLECTIONS.clients) as Promise<Doc[]>,
    findRecords<Obligation>(COLLECTIONS.obligations, { status: "upcoming" }),
  ]);
  const events = [
    ...renewalEvents(memberships, now),
    ...needsDateEvents(obligations, memberships, now),
    ...unansweredQuoteEvents(clients, now),
    ...missingDocumentEvents(clients, now),
  ];
  let created = 0;
  for (const [name, payload] of events) created += (await emitEvent(name, payload)).length;
  log(`[taskRuleSweep] ${events.length} events, ${created} tasks present/created`);
}
