import { processEmailQueue } from "../helper/emailQueue.ts";
import { dispatchDueAlerts } from "./dispatchAlerts.ts";
import { runEscalationWorkflow } from "./escalation.ts";
import { generateAlerts } from "../helper/alertEngine.ts";
import { deadlineFollowupSweep } from "./deadlineFollowup.ts";

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
];
