import query from "../db/query.ts";
import patch from "../db/patch.ts";
import get from "../db/get.ts";
import { enqueueEmail } from "../helper/emailQueue.ts";
import { isPlaceholderClient, isPlaceholderDoc, logSkipped } from "../helper/placeholder.ts";
import { complianceAlertEmail, withLegalFooter } from "../helper/emailTemplates.ts";
import { emailPrefsOf, mayEmail, unsubscribeUrl } from "../API/retention/mailer.ts";
import log from "../helper/log.ts";

/**
 * Dispatch Smart Compliance Alerts ahead of their obligation deadline. The
 * matching/generation step lives in helper/alertEngine.ts; this job only sends
 * already-scheduled alerts. Runs from the daily cron.
 *
 * COMMS-P1: an alert goes out `leadDays` before the deadline (the alert's own
 * `leadDays`, else ALERT_LEAD_DAYS, default 14), not on the deadline itself.
 * An alert whose deadline already passed without a send is marked "expired"
 * and not mailed. Alerts are service emails: the reminder unsubscribe
 * (clients.emailOptOut) stops them, and an alert for a person with a client
 * record carries the signed unsubscribe link.
 */

const DAY_MS = 86_400_000;
export const DEFAULT_ALERT_LEAD_DAYS = 14;

/** Lead days for one alert: its own value, else the env setting, else 14. Pure. */
export function alertLeadDays(alert: Record<string, unknown>, envValue?: string | null): number {
  const own = Number(alert.leadDays);
  if (Number.isFinite(own) && own >= 0) return Math.min(own, 365);
  const env = Number(envValue);
  if (envValue != null && envValue !== "" && Number.isFinite(env) && env >= 0) return Math.min(env, 365);
  return DEFAULT_ALERT_LEAD_DAYS;
}

/** Pure: "send" inside the lead window, "expired" once the deadline passed, else "wait". */
export function alertDispatchState(alert: Record<string, unknown>, now: number, leadDays: number): "send" | "expired" | "wait" {
  const ts = Number(alert.deadlineTs);
  if (!Number.isFinite(ts)) return "wait";
  if (ts < now) return "expired";
  return ts - leadDays * DAY_MS <= now ? "send" : "wait";
}

/** "November 1, 2026" from an ISO label; other text is kept as it is. */
export function alertDateLabel(label: unknown, ts: unknown): string {
  const raw = typeof label === "string" ? label : "";
  const t = /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : raw ? Number.NaN : Number(ts);
  if (!Number.isFinite(t)) return raw;
  return new Date(t).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export async function dispatchDueAlerts(): Promise<void> {
  // Single-field EQUAL query, with due filtering done in memory: this avoids
  // an equality+orderBy composite index on two different fields.
  const scheduled = await query("alerts", [
    { field: "status", op: "EQUAL", value: "scheduled" },
  ]);

  const now = Date.now();
  const envLead = Deno.env.get("ALERT_LEAD_DAYS");
  const rows = scheduled
    .map((a) => ({ a, state: alertDispatchState(a, now, alertLeadDays(a, envLead)) }))
    .sort((x, y) => Number(x.a.deadlineTs) - Number(y.a.deadlineTs));

  for (const { a: alert, state } of rows) {
    if (state === "wait") continue;
    if (state === "expired") {
      await patch("alerts", alert.id, { status: "expired", expiredAt: new Date().toISOString() });
      log(`Alert ${alert.id} passed its deadline before it was sent; marked expired`, "dispatchDueAlerts");
      continue;
    }
    // Placeholder (seed) alerts are never mailed.
    if (isPlaceholderDoc(alert) || await isPlaceholderClient(alert.clientId)) {
      logSkipped("alert email", String(alert.id));
      continue;
    }
    // The person's client record (alerts carry clientId, or the profile id when it is the same person).
    const clientId = String(alert.clientId ?? alert.profileId ?? "");
    const client = clientId ? ((await get("clients", clientId).catch(() => null)) as Record<string, unknown> | null) : null;
    if (!mayEmail(emailPrefsOf(client), "service")) {
      log(`Alert ${alert.id} not sent: reminder emails are turned off`, "dispatchDueAlerts");
      continue; // stays scheduled: sent if they turn reminders back on before the deadline
    }
    const html = complianceAlertEmail({
      firstName: alert.firstName as string,
      obligationTitle: alert.title as string,
      deadlineLabel: alertDateLabel(alert.deadlineLabel, alert.deadlineTs),
      responseUrl: alert.responseUrl as string,
    });
    await enqueueEmail(
      {
        to: alert.email as string,
        subject: `Coming up: ${alert.title as string}`,
        html: client ? withLegalFooter(html, { unsubscribeUrl: await unsubscribeUrl(clientId) }) : html,
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
