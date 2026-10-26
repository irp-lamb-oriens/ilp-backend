/**
 * API/retention/lifecycleEmails.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Billing lifecycle emails (P2), all transactional, all through the email
 * queue, all linking to /status/money:
 *
 *   payment failed   day 0 (from the past-due transition), day 3, day 6
 *   access paused    day 7 (end of the grace window)
 *   cancellation confirmed (member asked to cancel)
 *   renewal receipt  (a new paid period started)
 *
 * `installLifecycleEmailHooks()` attaches the immediate ones to
 * payments/lifecycle.ts; `dunningSweep()` (daily, from jobs/retentionSweep.ts)
 * sends days 3/6/7. Every message is once-only per member per episode.
 */

import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import {
  accessPausedEmail,
  cancellationConfirmedEmail,
  paymentFailedEmail,
  renewalReceiptEmail,
} from "../../helper/emailTemplates.ts";
import { COLLECTIONS, PLAN_STANDARD } from "../../schemas/contracts.ts";
import { daysPastDue, GRACE_DAYS, lifecycleHooks, type MembershipDoc } from "../payments/lifecycle.ts";
import { dateLabel, memberContact, sendOnce, siteUrl } from "./mailer.ts";

const DAY_MS = 86_400_000;
const moneyUrl = () => `${siteUrl()}/status/money`;
const byCard = (m: MembershipDoc) => /^sub_/.test(String(m.paymentRef ?? ""));

export type DunningStage = 0 | 3 | 6 | 7;

/** Pure: the latest dunning stage reached after `days` past due (null before day 0). */
export function dunningStage(days: number | null): DunningStage | null {
  if (days === null || days < 0) return null;
  if (days >= GRACE_DAYS) return 7;
  if (days >= 6) return 6;
  if (days >= 3) return 3;
  return 0;
}

const episode = (m: MembershipDoc) => String(m.pastDueSince ?? m.periodEnd).slice(0, 10);

export async function sendDunning(m: MembershipDoc, stage: DunningStage): Promise<boolean> {
  const to = await memberContact(m.clientId);
  if (!to) return false;
  const key = `dunning_${m.id}_${episode(m)}_d${stage}`;
  if (stage === 7) {
    return sendOnce(key, to, accessPausedEmail({ firstName: to.firstName, moneyUrl: moneyUrl(), byCard: byCard(m) }), { transactional: true });
  }
  const since = Date.parse(String(m.pastDueSince ?? m.periodEnd));
  const pausesOn = dateLabel(new Date(since + GRACE_DAYS * DAY_MS).toISOString());
  return sendOnce(key, to, paymentFailedEmail({ firstName: to.firstName, day: stage, pausesOn, moneyUrl: moneyUrl(), byCard: byCard(m) }), {
    transactional: true,
  });
}

/** Daily: past-due members get the day 3 / 6 / 7 message they have reached. */
export async function dunningSweep(now: Date = new Date()): Promise<number> {
  const rows = (await query(COLLECTIONS.memberships, [{ field: "status", op: "EQUAL", value: "past_due" }])
    .catch(() => [])) as unknown as MembershipDoc[];
  let n = 0;
  for (const m of rows) {
    const stage = dunningStage(daysPastDue(m, now));
    if (stage === null || stage === 0) continue; // day 0 goes out on the transition itself
    try {
      if (await sendDunning(m, stage)) n++;
    } catch (err) {
      log(`[retention] dunning ${m.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return n;
}

export async function sendCancelConfirmed(m: MembershipDoc): Promise<boolean> {
  const to = await memberContact(m.clientId);
  if (!to) return false;
  return sendOnce(
    `cancel_confirmed_${m.id}_${String(m.periodEnd).slice(0, 10)}`,
    to,
    cancellationConfirmedEmail({ firstName: to.firstName, endsOn: dateLabel(m.periodEnd), moneyUrl: moneyUrl() }),
    { transactional: true },
  );
}

export async function sendRenewalReceipt(m: MembershipDoc): Promise<boolean> {
  const to = await memberContact(m.clientId);
  if (!to) return false;
  const amount = `US$${(PLAN_STANDARD.monthlyCents / 100).toFixed(2)}`;
  return sendOnce(
    `renewal_receipt_${m.id}_${String(m.periodStart).slice(0, 10)}`,
    to,
    renewalReceiptEmail({
      firstName: to.firstName,
      amountLabel: amount,
      periodLabel: `${dateLabel(m.periodStart)} to ${dateLabel(m.periodEnd)}`,
      minutes: m.minutesIncluded ?? PLAN_STANDARD.minutesIncluded,
      calls: m.callsIncluded ?? PLAN_STANDARD.callsIncluded,
      moneyUrl: moneyUrl(),
      bookUrl: `${siteUrl()}/status/book`,
    }),
    { transactional: true },
  );
}

let installed = false;
/** Attach the immediate emails to the lifecycle transitions. Idempotent. */
export function installLifecycleEmailHooks(): void {
  if (installed) return;
  installed = true;
  lifecycleHooks.onPastDue = async (m) => {
    const stage = dunningStage(daysPastDue(m, new Date())) ?? 0;
    await sendDunning(m, stage);
  };
  lifecycleHooks.onRenewed = async (m) => {
    await sendRenewalReceipt(m);
  };
  lifecycleHooks.onCancelRequested = async (m) => {
    await sendCancelConfirmed(m);
  };
}
