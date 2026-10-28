/**
 * jobs/privacyRetention.ts — daily retention sweep (P6). Registered in
 * jobs/registry.ts at 04:10 Costa Rica (10:10 UTC).
 *
 * Deletes or trims data once its documented retention period has passed.
 * Every period is env-configurable; the defaults are placeholders for ILP's
 * counsel to confirm (policy.ts RETENTION_DEFAULTS, docs/PRIVACY_AND_COMPLIANCE.md):
 *
 *   leads                free-check leads never converted        RETENTION_LEAD_MONTHS (12)
 *   error_log            errors and CSP reports                  RETENTION_ERROR_LOG_DAYS (90)
 *   funnel_events        anonymous funnel beacons                RETENTION_FUNNEL_MONTHS (13)
 *   *_otps, *_sessions,  expired login codes, sessions and       RETENTION_SESSION_GRACE_DAYS (1)
 *   join_sessions,       join hand-off tokens, unused download
 *   download_tickets,    tickets (60 s, single use; AUTH), and
 *   deadline_claims      free-check claim tokens (2 hours; DEADLINES)
 *   email_queue          sent / failed email copies              RETENTION_EMAIL_QUEUE_DAYS (90)
 *   ilp_chatbot_threads  public website chatbot threads          RETENTION_CHATBOT_MONTHS (6)
 *   consultations        transcript, summary text removed N      RETENTION_TRANSCRIPT_MONTHS (24)
 *                        months after the membership ended
 *                        (cancelledAt, else periodEnd; past_due counts as
 *                        ended at periodEnd once the 7-day grace is over)
 *
 * At most RETENTION_MAX_DELETES_PER_RUN (500) changes per target per run;
 * the rest go on the next day. Queries are single-field range filters
 * (automatic indexes). One summary row per run in audit_log
 * (privacy.retention_sweep).
 */

import query from "../db/query.ts";
import remove from "../db/delete.ts";
import replaceDoc from "../db/replace.ts";
import auditLog from "../helper/auditLog.ts";
import log from "../helper/log.ts";
import { COLLECTIONS } from "../schemas/contracts.ts";
import { GRACE_DAYS } from "../API/payments/lifecycle.ts";
import { daysBefore, monthsBefore, olderThan, type RetentionConfig, retentionConfig } from "../API/privacy/policy.ts";

type Doc = Record<string, unknown>;

export interface RetentionTarget {
  name: string;
  collection: string;
  field: string; // ISO timestamp field compared with the cutoff
  cutoff: Date;
  /** Extra in-memory condition; rows failing it are kept. */
  keepIf?: (d: Doc) => boolean;
}

/** Pure: what each run deletes, from the config. */
export function retentionTargets(cfg: RetentionConfig, now: Date): RetentionTarget[] {
  const expired = daysBefore(now, cfg.sessionGraceDays);
  const sessionTargets = [
    "dashboard_otps",
    "provider_otps",
    "client_status_otps",
    "dashboard_sessions",
    "provider_sessions",
    "client_status_sessions",
    "join_sessions",
    "download_tickets",
    "deadline_claims", // DEADLINES: claim tokens from the free check (2 hours)
  ].map((c) => ({ name: `expired ${c}`, collection: c, field: "expiresAt", cutoff: expired }));
  return [
    {
      name: "unconverted leads",
      collection: COLLECTIONS.leads,
      field: "createdAt",
      cutoff: monthsBefore(now, cfg.leadMonths),
      keepIf: (d) => typeof d.convertedClientId === "string" && d.convertedClientId !== "",
    },
    { name: "error log", collection: "error_log", field: "at", cutoff: daysBefore(now, cfg.errorLogDays) },
    { name: "funnel events", collection: COLLECTIONS.funnelEvents, field: "at", cutoff: monthsBefore(now, cfg.funnelMonths) },
    ...sessionTargets,
    {
      name: "sent email copies",
      collection: "email_queue",
      field: "createdAt",
      cutoff: daysBefore(now, cfg.emailQueueDays),
      keepIf: (d) => d.status === "pending" || d.status === "processing",
    },
    { name: "website chatbot threads", collection: "ilp_chatbot_threads", field: "updatedAt", cutoff: monthsBefore(now, cfg.chatbotThreadMonths) },
  ];
}

/**
 * Pure: when a membership ended, or null while it is still open (P7).
 * cancelled → cancelledAt, else periodEnd (a membership can end at period end
 * without cancelledAt); past_due → periodEnd once the grace window is over
 * (access paused); pending / active / past_due inside grace → still open.
 */
export function membershipEndedAt(m: Doc, now: Date): string | null {
  const status = String(m.status ?? "");
  const periodEnd = typeof m.periodEnd === "string" ? m.periodEnd : "";
  if (status === "cancelled") return String(m.cancelledAt ?? periodEnd) || "";
  if (status === "past_due") {
    const end = Date.parse(periodEnd);
    if (Number.isNaN(end) || end + GRACE_DAYS * 86_400_000 > now.getTime()) return null;
    return periodEnd;
  }
  return null;
}

/** Pure: every membership of the member ended before the cutoff (none still open). */
export function transcriptExpired(memberships: Doc[], cutoff: Date, now: Date = new Date()): boolean {
  if (!memberships.length) return false;
  const ends = memberships.map((m) => membershipEndedAt(m, now));
  if (ends.some((e) => e === null)) return false;
  return ends.every((e) => olderThan(e, cutoff));
}

export const TRANSCRIPT_FIELDS = ["transcript", "summary", "suggestedNextSteps", "transcriptSource"] as const;

export interface RetentionStore {
  olderThan(collection: string, field: string, cutoffIso: string): Promise<Doc[]>;
  where(collection: string, field: string, value: string): Promise<Doc[]>;
  remove(collection: string, id: string): Promise<void>;
  replace(collection: string, id: string, doc: Doc): Promise<void>;
}

export interface SweepCounts {
  [target: string]: number;
}

export async function runRetention(store: RetentionStore, cfg: RetentionConfig, now: Date): Promise<SweepCounts> {
  const counts: SweepCounts = {};
  for (const t of retentionTargets(cfg, now)) {
    const rows = await store.olderThan(t.collection, t.field, t.cutoff.toISOString()).catch((err) => {
      log(`[retention] ${t.name}: query failed: ${err instanceof Error ? err.message : err}`, "error");
      return [] as Doc[];
    });
    let n = 0;
    for (const d of rows) {
      if (n >= cfg.maxDeletesPerRun) break;
      if (!olderThan(d[t.field], t.cutoff) || (t.keepIf && t.keepIf(d))) continue;
      await store.remove(t.collection, String(d.id));
      n++;
    }
    counts[t.name] = n;
  }

  // Transcripts: memberships that ended before the cutoff. Candidates come
  // from cancelledAt and from periodEnd (cancelled at period end without
  // cancelledAt, or past_due beyond grace); transcriptExpired decides.
  const cutoff = monthsBefore(now, cfg.transcriptMonthsAfterEnd);
  const ended = [
    ...await store.olderThan(COLLECTIONS.memberships, "cancelledAt", cutoff.toISOString()).catch(() => [] as Doc[]),
    ...await store.olderThan(COLLECTIONS.memberships, "periodEnd", cutoff.toISOString()).catch(() => [] as Doc[]),
  ];
  const clients = [...new Set(ended.map((m) => String(m.clientId ?? "")).filter(Boolean))];
  let trimmed = 0;
  for (const clientId of clients) {
    if (trimmed >= cfg.maxDeletesPerRun) break;
    const ms = await store.where(COLLECTIONS.memberships, "clientId", clientId);
    if (!transcriptExpired(ms, cutoff, now)) continue;
    for (const c of await store.where(COLLECTIONS.consultations, "clientId", clientId)) {
      if (!TRANSCRIPT_FIELDS.some((f) => c[f] !== undefined)) continue;
      const next: Doc = { ...c, transcriptRemovedAt: now.toISOString() };
      for (const f of TRANSCRIPT_FIELDS) delete next[f];
      await store.replace(COLLECTIONS.consultations, String(c.id), next);
      trimmed++;
    }
  }
  counts["transcripts after membership end"] = trimmed;
  return counts;
}

function firestoreRetentionStore(): RetentionStore {
  return {
    olderThan: async (c, field, cutoffIso) =>
      (await query(c, [{ field, op: "LESS_THAN", value: cutoffIso }])) as unknown as Doc[],
    where: async (c, field, value) =>
      ((await query(c, [{ field, op: "EQUAL", value }]).catch(() => [])) as unknown as Doc[]),
    remove: async (c, id) => {
      await remove(c, id);
    },
    replace: (c, id, doc) => replaceDoc(c, id, doc),
  };
}

export async function privacyRetention(): Promise<void> {
  const cfg = retentionConfig((k) => Deno.env.get(k));
  const counts = await runRetention(firestoreRetentionStore(), cfg, new Date());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  log(`[retention] privacy sweep: ${total} changes ${JSON.stringify(counts)}`, "retention");
  await auditLog({
    actor: { uid: "system", email: "system", role: "system" },
    action: "privacy.retention_sweep",
    target: "system/retention",
    meta: { counts, config: cfg },
  }).catch(() => undefined);
}
