import query from "../db/query.ts";
import patch from "../db/patch.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { isPlaceholderClient, isPlaceholderDoc, logSkipped } from "../helper/placeholder.ts";
import { complianceAlertEmail } from "../helper/emailTemplates.ts";
import log from "../helper/log.ts";

/**
 * Dispatch Smart Compliance Alerts whose obligation deadline is due and not
 * yet dispatched. The matching/generation step lives in helper/alertEngine.ts;
 * this job only sends already-scheduled, now-due alerts. Runs from the daily
 * cron.
 */
export async function dispatchDueAlerts(): Promise<void> {
  // Single-field EQUAL query, with due filtering done in memory: this avoids
  // an equality+orderBy composite index on two different fields.
  const scheduled = await query("alerts", [
    { field: "status", op: "EQUAL", value: "scheduled" },
  ]);

  const now = Date.now();
  const due = scheduled
    .filter((a) => {
      const ts = Number(a.deadlineTs);
      return Number.isFinite(ts) && ts <= now;
    })
    .sort((a, b) => Number(a.deadlineTs) - Number(b.deadlineTs));

  for (const alert of due) {
    // Placeholder (seed) alerts are never mailed.
    if (isPlaceholderDoc(alert) || await isPlaceholderClient(alert.clientId)) {
      logSkipped("alert email", String(alert.id));
      continue;
    }
    await enqueueEmail(
      {
        to: alert.email as string,
        subject: `Compliance alert: ${alert.title as string}`,
        html: complianceAlertEmail({
          firstName: alert.firstName as string,
          obligationTitle: alert.title as string,
          deadlineLabel: alert.deadlineLabel as string,
          responseUrl: alert.responseUrl as string,
        }),
      },
      `alert_${alert.id}`,
    );

    await patch("alerts", alert.id, {
      status: "dispatched",
      dispatchedAt: new Date().toISOString(),
    });
    log(`Dispatched alert ${alert.id}`, "dispatchDueAlerts");
  }
}