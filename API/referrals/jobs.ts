/**
 * API/referrals/jobs.ts — scheduled work (registered in jobs/registry.ts).
 *   referralApprovals          daily: pending commissions past their hold → approved
 *   referralMonthlyStatements  day 1 of each month: statement email to every partner with activity
 */
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { ReferralEngine } from "./engine.ts";
import { firestoreReferralStore, type ReferralStore } from "./store.ts";
import { partnerStatement } from "./reports.ts";
import { monthlyStatementEmail } from "./emails.ts";
import { partnerPortalUrl } from "./referralsRouter.ts";

export async function referralApprovals(store: ReferralStore = firestoreReferralStore): Promise<number> {
  const n = await new ReferralEngine(store).approveDue();
  log(`[referrals] approved ${n} commission(s)`, "referrals");
  return n;
}

/** The month before `now`, as YYYY-MM. */
export function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

export async function referralMonthlyStatements(
  store: ReferralStore = firestoreReferralStore,
  now = new Date(),
  send: (msg: { to: string; subject: string; html: string; text: string }, key: string) => Promise<unknown> = (m, k) => enqueueEmail(m, k),
): Promise<number> {
  const monthKey = previousMonth(now);
  let sent = 0;
  for (const p of await store.listPartners()) {
    if (!p.monthlyEmail || p.status === "closed") continue;
    try {
      const st = await partnerStatement(store, p.id, { year: Number(monthKey.slice(0, 4)), now: now.toISOString() });
      if (!st) continue;
      const L = st.lifetime;
      if (!L.leads && !L.earnedCents && !L.paidCents) continue; // nothing to report yet
      const mail = monthlyStatementEmail(st, monthKey, partnerPortalUrl());
      await send({ to: p.email, subject: mail.subject, html: mail.html, text: mail.text }, `ref_stmt_${p.id}_${monthKey}`);
      sent++;
    } catch (err) {
      log(`[referrals] statement for ${p.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  log(`[referrals] ${sent} monthly statement(s) queued for ${monthKey}`, "referrals");
  return sent;
}
