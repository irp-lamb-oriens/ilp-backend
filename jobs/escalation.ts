import query from "../db/query.ts";
import post from "../db/post.ts";
import patch from "../db/patch.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { escalationEmail } from "../helper/emailTemplates.ts";
import log from "../helper/log.ts";

/**
 * Escalation workflow: alerts with status "needs_help" create CSM tasks and
 * notify staff. Runs hourly. Stub: staff distribution seam left open.
 */
const STAFF_NOTIFY_EMAIL = Deno.env.get("STAFF_NOTIFY_EMAIL") ?? "";

export async function runEscalationWorkflow(): Promise<void> {
  const needingHelp = await query(
    "alerts",
    [{ field: "status", op: "EQUAL", value: "needs_help" }],
    { field: "updatedAt", direction: "ASCENDING" },
  );

  for (const alert of needingHelp) {
    const taskId = alert.taskId as string | undefined;
    if (taskId) continue; // already escalated

    const newTaskId = await post("tasks", {
      type: "follow_up",
      profileId: alert.profileId as string,
      source: "alert",
      sourceId: alert.id,
      title: `Follow up: ${alert.title as string}`,
      status: "open",
      createdAt: new Date().toISOString(),
    });

    await patch("alerts", alert.id, { taskId: newTaskId });

    if (STAFF_NOTIFY_EMAIL) {
      await enqueueEmail(
        {
          to: STAFF_NOTIFY_EMAIL,
          subject: `Escalation: ${alert.title as string}`,
          html: escalationEmail({
            staffName: "",
            profileName: (alert.profileName as string) ?? "Customer",
            obligationTitle: alert.title as string,
            dashboardUrl: Deno.env.get("DASHBOARD_URL") ?? "",
          }),
        },
        `escalation_${alert.id}`,
      );
    }
    log(`Escalated alert ${alert.id} -> task ${newTaskId}`, "escalation");
  }
}