/**
 * API/dashboard/activityMetrics.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure call + quote counting for the ILP dashboard Metrics view.
 *
 * No IO. Both aggregators take the already-fetched client docs, so they stay
 * testable without Firestore. Ported from IRP-funnel's `activityMetrics.ts`,
 * retargeted to ILP's flat `clients` collection:
 *   • Quotes live ON the client doc (`doc.quotes`), not a separate collection.
 *   • A "completed call" is a consultation whose `callOutcome` is set OR whose
 *     transcript / meeting-notes text is present.
 *   • "accepted" means quote `status === "accepted"` OR an `acceptedAt` stamp,
 *     matching the client-status portal's accept-quote flow.
 */

export interface CallPerClient {
  clientId: string;
  clientName: string;
  total: number;
  /** Resolved ISO timestamps of this client's completed calls (segmentable). */
  dates: string[];
}

export interface QuotePerClient {
  clientId: string;
  clientName: string;
  total: number;
  accepted: number;
}

export interface ActivityMetrics {
  calls: {
    total: number;
    weekly: Record<string, number>;
    monthly: Record<string, number>;
    annually: Record<string, number>;
    perClient: CallPerClient[];
  };
  quotes: {
    total: number;
    accepted: number;
    perClient: QuotePerClient[];
  };
}

// ── Bucketing helpers ────────────────────────────────────────────────────────

function monthOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function yearOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getUTCFullYear());
}

function weekKeyOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  // ISO-8601 week number: shift so Thursday lands in the week that owns it.
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function bump(map: Record<string, number>, key: string | null): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

// ── Call aggregation ─────────────────────────────────────────────────────────

function resolveCallDate(data: Record<string, unknown>): string | null {
  if (typeof data?.outcomeSetAt === "string" && data.outcomeSetAt) {
    return data.outcomeSetAt;
  }
  const consultations = Array.isArray(data?.consultations) ? data.consultations : [];
  const latest = (consultations[consultations.length - 1] ?? {}) as Record<string, unknown>;
  const scheduling = Array.isArray(latest.scheduling) ? latest.scheduling : [];
  if (scheduling.length && typeof scheduling[0] === "string" && scheduling[0]) {
    return scheduling[0];
  }
  if (typeof data?.createdAt === "string" && data.createdAt) return data.createdAt;
  if (consultations.length && typeof (consultations[0] as Record<string, unknown>)?.timestamp === "string") {
    return (consultations[0] as Record<string, unknown>).timestamp as string;
  }
  return null;
}

function callOccurred(data: Record<string, unknown>): boolean {
  if (typeof data?.callOutcome === "string" && data.callOutcome) return true;
  const lastEvent = data?.lastCalendarEvent as Record<string, unknown> | undefined;
  const notes = lastEvent?.notes as Record<string, unknown> | undefined;
  const transcriptText =
    (typeof data?.transcript === "string" && data.transcript) ||
    (typeof notes?.text === "string" && notes.text);
  return typeof transcriptText === "string" && transcriptText.trim().length > 0;
}

function callClientName(docId: string, data: Record<string, unknown>): string {
  const consultations = Array.isArray(data?.consultations) ? data.consultations : [];
  const latest = (consultations[consultations.length - 1] ?? {}) as Record<string, unknown>;
  const name = (data?.name || latest.name || "").toString().trim();
  const surname = (data?.surname || latest.surname || "").toString().trim();
  const email = (data?.email || data?.dripEmail || latest.email || "").toString().trim();
  if (name || surname) return `${name} ${surname}`.trim();
  if (email) return email;
  return docId;
}

export function aggregateCalls(
  clientDocs: Array<{ docId: string; data: Record<string, unknown> }>,
): ActivityMetrics["calls"] {
  const weekly: Record<string, number> = {};
  const monthly: Record<string, number> = {};
  const annually: Record<string, number> = {};
  const perClient: CallPerClient[] = [];
  let total = 0;

  for (const { docId, data } of clientDocs) {
    if (!callOccurred(data)) continue;
    const at = resolveCallDate(data);
    if (!at) continue;

    total++;
    bump(weekly, weekKeyOf(at));
    bump(monthly, monthOf(at));
    bump(annually, yearOf(at));

    let row = perClient.find((c) => c.clientId === docId);
    if (!row) {
      row = { clientId: docId, clientName: callClientName(docId, data), total: 0, dates: [] };
      perClient.push(row);
    }
    row.total++;
    row.dates.push(at);
  }

  perClient.sort((a, b) => b.total - a.total || a.clientName.localeCompare(b.clientName));
  return { total, weekly, monthly, annually, perClient };
}

// ── Quote aggregation ────────────────────────────────────────────────────────

function quoteAccepted(q: Record<string, unknown>): boolean {
  return q.status === "accepted" || !!q.acceptedAt;
}

export function aggregateQuotes(
  clientDocs: Array<{ docId: string; data: Record<string, unknown> }>,
): ActivityMetrics["quotes"] {
  const byClient = new Map<string, QuotePerClient>();
  let total = 0;
  let accepted = 0;

  for (const { docId, data } of clientDocs) {
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    for (const raw of quotes) {
      const q = raw as Record<string, unknown>;
      total++;
      if (quoteAccepted(q)) accepted++;

      let row = byClient.get(docId);
      if (!row) {
        row = {
          clientId: docId,
          clientName: callClientName(docId, data),
          total: 0,
          accepted: 0,
        };
        byClient.set(docId, row);
      }
      row.total++;
      if (quoteAccepted(q)) row.accepted++;
    }
  }

  const perClient = [...byClient.values()].sort(
    (a, b) => b.total - a.total || a.clientName.localeCompare(b.clientName),
  );

  return { total, accepted, perClient };
}

export function aggregateActivity(
  clientDocs: Array<{ docId: string; data: Record<string, unknown> }>,
): ActivityMetrics {
  return {
    calls: aggregateCalls(clientDocs),
    quotes: aggregateQuotes(clientDocs),
  };
}