/**
 * jobs/callReminders.ts — call reminders and Meet transcript pickup (P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Every 15 minutes:
 * 1. Booked calls in the next 25 hours: email the member and the lawyer 24 h
 *    and 1 h before (Meet link, the member's question, and for the lawyer a
 *    link to the brief). Idempotent: `remindersSent` on the consultation
 *    records each key, and the email queue dedupes on (consultation, key, role).
 *    Which reminder is due is decided by `reminderToSend` (callLogic.ts, tested).
 * 3. REL: calls nobody wrapped up get a CSM task ("call.outcome_missing").
 * 4. COMMS-P4: completed calls not rated 2 hours after the end: one rating request email.
 * 2. Calls that ended 10 minutes to 24 hours ago with recording consent and a
 *    Calendar event but no transcript: try to read the Meet transcript and
 *    draft a suggested summary, so the lawyer finds it ready on the call page.
 *
 * Reads: ONE range query on scheduledAt, shared by every step, so a run costs
 * the calls in that window, never the whole consultation history (that cost
 * ~60 000 reads a day on seed data alone). The window is 8 days back to 25
 * hours ahead; once a day (the first run after 04:00 UTC) it reaches back 31
 * days, so calls missed while the job was down still get their "not wrapped
 * up" task (callOutcomeMissing looks 30 days back). Single-field range, so no
 * composite index is needed.
 */

import log from "../helper/log.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { callReminderEmail } from "../helper/emailTemplates.ts";
import { COLLECTIONS } from "../schemas/contracts.ts";
import { updateRecord } from "../API/members/service.ts";
import query from "../db/query.ts";
import { callOutcomeMissing, reminderToSend, transcriptFetchDue } from "../API/calls/callLogic.ts";
import { emitEvent } from "../API/members/events.ts";
import {
  type CallRecord,
  memberHomeUrl,
  peopleFor,
  pullMeetTranscript,
  whenLabel,
} from "../API/calls/callService.ts";
import { draftSuggestion } from "../API/provider/lawyerHomeRoutes.ts";
import { sendPreCallEmail } from "../API/routing/precall.ts"; // ROUTING
import { salesEmails } from "../API/routing/service.ts"; // ROUTING
import { sendSummaryReady, summaryFollowups } from "../API/lawyerComms/notify.ts"; // COMMS-P2
import { ratingRequests } from "../API/retention/closingLoops.ts"; // COMMS-P4

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const LOOKBACK_DAYS = 8;
export const DEEP_LOOKBACK_DAYS = 31;

/** The daily deep pass: the first run after 04:00 UTC (the job runs every 15 minutes). */
export const isDeepPass = (now: Date) => now.getUTCHours() === 4 && now.getUTCMinutes() < 15;

/**
 * Every call any step below can act on. Each step fires within 3 days of the
 * call: callOutcomeMissing at 1 day after the end (2 days after completion),
 * transcripts up to 1 day, rating requests up to 3 days, summary follow-ups
 * 48 h after the summary (ready within a day of the call); reminders look
 * 25 hours ahead. 8 days back leaves room for a server that was down for a
 * few days; the job runs every 15 minutes.
 */
export async function callsInWindow(now: Date, lookbackDays = LOOKBACK_DAYS): Promise<CallRecord[]> {
  const rows = await query(COLLECTIONS.consultations, [
    { field: "scheduledAt", op: "GREATER_THAN_OR_EQUAL", value: new Date(now.getTime() - lookbackDays * DAY).toISOString() },
    { field: "scheduledAt", op: "LESS_THAN_OR_EQUAL", value: new Date(now.getTime() + 25 * HOUR).toISOString() },
  ]);
  return rows as unknown as CallRecord[];
}

export async function callReminders(
  now = new Date(),
  opts: { deep?: boolean } = {},
): Promise<{ sent: number; transcripts: number; unresolved: number }> {
  let sent = 0;
  let transcripts = 0;
  const calls = await callsInWindow(now, (opts.deep ?? isDeepPass(now)) ? DEEP_LOOKBACK_DAYS : LOOKBACK_DAYS);
  const ofStatus = (...st: string[]) => calls.filter((c) => st.includes(String(c.status)));
  const booked = ofStatus("booked");
  const horizon = new Date(now.getTime() + 25 * HOUR).toISOString();
  const nowIso = now.toISOString();

  for (const c of booked.filter((x) => x.scheduledAt > nowIso && x.scheduledAt <= horizon)) {
    const { send, mark } = reminderToSend(c, now);
    if (!mark.length) continue;
    try {
      if (send) {
        const who = await peopleFor(c);
        if (who.member.email) {
          const m = callReminderEmail({
            to: "member", kind: send, greetingName: who.member.firstName, otherName: c.kind === "sales" ? "the ILP team" : who.lawyer.name,
            whenLabel: whenLabel(c.scheduledAt, who.member.timezone), meetUrl: c.meetUrl, question: c.question?.split("\n")[0], portalUrl: memberHomeUrl(),
          });
          await enqueueEmail({ to: who.member.email, ...m, placeholder: who.placeholder }, `call_reminder_${c.id}_${send}_member`);
          sent++;
        }
        if (c.kind === "sales") {
          // ROUTING: a sales call: the sales inbox gets the reminder (no lawyer, no brief).
          const l = callReminderEmail({
            to: "lawyer", kind: send, greetingName: "ILP sales team", otherName: who.member.name,
            whenLabel: whenLabel(c.scheduledAt, "America/Costa_Rica"), meetUrl: c.meetUrl, question: c.question,
          });
          await enqueueEmail({ to: (c.salesEmail ? [c.salesEmail] : salesEmails()).join(", "), ...l, placeholder: who.placeholder }, `call_reminder_${c.id}_${send}_sales`);
          sent++;
        } else if (who.lawyer.email && await sendPreCallEmail(c, send)) {
          // ROUTING: the lawyer's reminder is the full pre-call brief in their email language.
          sent++;
        }
      }
      await updateRecord(COLLECTIONS.consultations, c.id, {
        remindersSent: [...new Set([...(c.remindersSent ?? []), ...mark])],
      });
    } catch (err) {
      log(`[callReminders] ${c.id}: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // Transcript pickup: calls still "booked" or "in_progress" after their end
  // (the lawyer has not confirmed yet) and completed calls without a transcript.
  const recent = [
    ...ofStatus("booked", "in_progress"),
    ...ofStatus("completed").filter((c) => Date.parse(c.scheduledAt) > now.getTime() - 26 * HOUR),
  ];
  for (const c of recent.filter((x) => x.kind !== "sales" && transcriptFetchDue(x, now) && x.summary?.status !== "confirmed")) {
    try {
      const r = await pullMeetTranscript(c);
      if (r.status === "fetched" && r.text) {
        transcripts++;
        const drafted = c.summary ? true : !!(await draftSuggestion(c.id, r.text));
        // COMMS-P2: tell the lawyer the summary is ready to confirm (once per call).
        await sendSummaryReady(c, drafted, now);
      }
    } catch (err) {
      log(`[callReminders] transcript ${c.id}: ${err instanceof Error ? err.message : err}`, "error");
      await updateRecord(COLLECTIONS.consultations, c.id, { transcriptFetchAttempts: (c.transcriptFetchAttempts ?? 0) + 1 }).catch(() => null);
    }
  }

  // REL: calls nobody wrapped up (no completion / no-show a day after the end,
  // or no handoff two days after completion): one CSM task per call.
  let unresolved = 0;
  const open = ofStatus("booked", "in_progress", "completed");
  for (const c of open.filter((x) => x.kind !== "sales" && callOutcomeMissing(x, now))) {
    const ids = await emitEvent("call.outcome_missing", {
      clientId: c.clientId,
      matterId: c.matterId,
      sourceId: c.id,
      sourceKind: "consultation",
      detail: `${c.status === "completed" ? "no handoff" : "no outcome"}, call of ${c.scheduledAt.slice(0, 16).replace("T", " ")} UTC`,
    });
    if (ids.length) unresolved++;
  }

  // COMMS-P4: completed calls 2 hours to 3 days old and not rated yet: ask the member once (service email).
  const completed = open.filter((x) => x.status === "completed");
  await ratingRequests(completed, now).catch((err) => log(`[callReminders] rating requests: ${err instanceof Error ? err.message : err}`, "error"));

  // COMMS-P2: summary still not confirmed: lawyer reminder at 24 h, CSM task at 48 h.
  await summaryFollowups(now, open).catch((err) => log(`[callReminders] summary follow-ups: ${err instanceof Error ? err.message : err}`, "error"));

  if (sent || transcripts) log(`[callReminders] ${sent} reminder emails, ${transcripts} transcripts`);
  return { sent, transcripts, unresolved };
}
