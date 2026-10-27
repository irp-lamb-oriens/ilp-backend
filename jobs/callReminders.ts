/**
 * jobs/callReminders.ts — call reminders and Meet transcript pickup (P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Every 15 minutes:
 * 1. Booked calls in the next 25 hours: email the member and the lawyer 24 h
 *    and 1 h before (Meet link, the member's question, and for the lawyer a
 *    link to the brief). Idempotent: `remindersSent` on the consultation
 *    records each key, and the email queue dedupes on (consultation, key, role).
 *    Which reminder is due is decided by `reminderToSend` (callLogic.ts, tested).
 * 2. Calls that ended 10 minutes to 24 hours ago with recording consent and a
 *    Calendar event but no transcript: try to read the Meet transcript and
 *    draft a suggested summary, so the lawyer finds it ready on the call page.
 *
 * Queries are single-field equalities (status), so no composite index is needed.
 */

import log from "../helper/log.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { callReminderEmail } from "../helper/emailTemplates.ts";
import { COLLECTIONS } from "../schemas/contracts.ts";
import { findRecords, updateRecord } from "../API/members/service.ts";
import { reminderToSend, transcriptFetchDue } from "../API/calls/callLogic.ts";
import {
  type CallRecord,
  lawyerBriefUrl,
  memberHomeUrl,
  peopleFor,
  pullMeetTranscript,
  whenLabel,
} from "../API/calls/callService.ts";
import { draftSuggestion } from "../API/provider/lawyerHomeRoutes.ts";

const HOUR = 3_600_000;

export async function callReminders(now = new Date()): Promise<{ sent: number; transcripts: number }> {
  let sent = 0;
  let transcripts = 0;
  const booked = await findRecords<CallRecord>(COLLECTIONS.consultations, { status: "booked" });
  const horizon = new Date(now.getTime() + 25 * HOUR).toISOString();
  const nowIso = now.toISOString();

  for (const c of booked.filter((x) => x.scheduledAt > nowIso && x.scheduledAt <= horizon)) {
    const { send, mark } = reminderToSend(c, now);
    if (!mark.length) continue;
    try {
      if (send) {
        const who = await peopleFor(c);
        const when = whenLabel(c.scheduledAt);
        if (who.member.email) {
          const m = callReminderEmail({
            to: "member", kind: send, greetingName: who.member.firstName, otherName: who.lawyer.name,
            whenLabel: when, meetUrl: c.meetUrl, question: c.question?.split("\n")[0], portalUrl: memberHomeUrl(),
          });
          await enqueueEmail({ to: who.member.email, ...m, placeholder: who.placeholder }, `call_reminder_${c.id}_${send}_member`);
          sent++;
        }
        if (who.lawyer.email) {
          const l = callReminderEmail({
            to: "lawyer", kind: send, greetingName: who.lawyer.name, otherName: who.member.name,
            whenLabel: when, meetUrl: c.meetUrl, question: c.question, briefUrl: lawyerBriefUrl(c.id),
          });
          await enqueueEmail({ to: who.lawyer.email, ...l, placeholder: who.placeholder }, `call_reminder_${c.id}_${send}_lawyer`);
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
    ...booked,
    ...(await findRecords<CallRecord>(COLLECTIONS.consultations, { status: "in_progress" }).catch(() => [])),
    ...(await findRecords<CallRecord>(COLLECTIONS.consultations, { status: "completed" }).catch(() => []))
      .filter((c) => Date.parse(c.scheduledAt) > now.getTime() - 26 * HOUR),
  ];
  for (const c of recent.filter((x) => transcriptFetchDue(x, now) && x.summary?.status !== "confirmed")) {
    try {
      const r = await pullMeetTranscript(c);
      if (r.status === "fetched" && r.text) {
        transcripts++;
        if (!c.summary) await draftSuggestion(c.id, r.text);
      }
    } catch (err) {
      log(`[callReminders] transcript ${c.id}: ${err instanceof Error ? err.message : err}`, "error");
      await updateRecord(COLLECTIONS.consultations, c.id, { transcriptFetchAttempts: (c.transcriptFetchAttempts ?? 0) + 1 }).catch(() => null);
    }
  }

  if (sent || transcripts) log(`[callReminders] ${sent} reminder emails, ${transcripts} transcripts`);
  return { sent, transcripts };
}
