import { processEmailQueue } from "../helper/emailQueue.ts";
import { dispatchDueAlerts } from "./dispatchAlerts.ts";
import { runEscalationWorkflow } from "./escalation.ts";
import { generateAlerts } from "../helper/alertEngine.ts";
import { deadlineFollowupSweep } from "./deadlineFollowup.ts";
import { deadlineReminderSweep } from "./deadlineReminderSweep.ts";
import { taskRuleSweep } from "./taskRuleSweep.ts";
import { membershipRenewalSweep } from "../API/payments/lifecycle.ts"; // P2
import { firestoreBackup } from "./firestoreBackup.ts"; // P1
import { retentionSweep } from "./retentionSweep.ts"; // P2
import { installLifecycleEmailHooks } from "../API/retention/lifecycleEmails.ts"; // P2
import { callReminders } from "./callReminders.ts"; // P3
import { privacyRetention } from "./privacyRetention.ts"; // P6

/**
 * Centralized job registry. Every scheduled job is declared here with its
 * cron expression and handler. The cron runner (cronRunner.ts) dispatches
 * them uniformly. Add a job here + import its handler; nothing else changes.
 */
export interface JobDef {
  name: string;
  cron: string;
  handler: () => Promise<void>;
}

export const jobs: JobDef[] = [
  {
    name: "processEmailQueue",
    cron: "*/15 * * * *",
    handler: async () => {
      await processEmailQueue(50);
    },
  },
  {
    name: "generateAlerts",
    cron: "0 * * * *",
    handler: async () => {
      await generateAlerts();
    },
  },
  {
    name: "dispatchDueAlerts",
    cron: "0 0 * * *",
    handler: dispatchDueAlerts,
  },
  {
    name: "runEscalationWorkflow",
    cron: "0 * * * *",
    handler: runEscalationWorkflow,
  },
  {
    name: "deadlineFollowupSweep",
    cron: "0 */6 * * *",
    handler: deadlineFollowupSweep,
  },
  {
    name: "deadlineReminderSweep",
    cron: "0 8 * * *",
    handler: deadlineReminderSweep,
  },
  {
    name: "taskRuleSweep",
    cron: "30 7 * * *",
    handler: taskRuleSweep,
  },
  // P2: manual-mode renewals (past due / cancel at period end / prepaid renewal).
  {
    name: "membershipRenewalSweep",
    cron: "20 * * * *",
    handler: async () => {
      installLifecycleEmailHooks();
      await membershipRenewalSweep();
    },
  },
  // P2: dunning + retention messages, daily 08:00 Costa Rica (UTC-6, no DST; server runs UTC).
  {
    name: "retentionSweep",
    cron: "0 14 * * *",
    handler: async () => {
      await retentionSweep();
    },
  },
  // P3: call reminders (24 h, 1 h) and Meet transcript pickup.
  {
    name: "callReminders",
    cron: "*/15 * * * *",
    handler: async () => {
      await callReminders();
    },
  },
  // P1: daily Firestore export to gs://$BACKUP_BUCKET/<date>, 03:00 Costa Rica (UTC-6) = 09:00 UTC.
  {
    name: "firestoreBackup",
    cron: "0 9 * * *",
    handler: async () => {
      await firestoreBackup();
    },
  },
  // P6: privacy retention (leads, error_log, funnel events, expired sessions/OTPs,
  // email copies, chatbot threads, transcripts after membership end). 04:10 Costa Rica.
  {
    name: "privacyRetention",
    cron: "10 10 * * *",
    handler: async () => {
      await privacyRetention();
    },
  },
];
