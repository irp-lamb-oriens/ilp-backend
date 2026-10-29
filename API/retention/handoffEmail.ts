/**
 * API/retention/handoffEmail.ts
 * ──────────────────────────────────────────────────────────────────────────
 * COMMS-P1: when the lawyer approves a handoff (event handoff.approved), the
 * member gets the confirmed next steps right away. Service class: the
 * reminder unsubscribe stops it, marketing opt-out does not. Once per handoff.
 *
 * It also records the matter's next-step fingerprint in retention_state (the
 * same state the daily next-step sweep reads), so the sweep does not send the
 * same step again the next morning.
 */

import put from "../../db/put.ts";
import log from "../../helper/log.ts";
import { isPlaceholderDoc } from "../../helper/placeholder.ts";
import { findRecords, getRecord } from "../../db/records.ts";
import { handoffNextStepsEmail } from "../../helper/emailTemplates.ts";
import { COLLECTIONS, type Handoff, type Matter } from "../../schemas/contracts.ts";
import { nextStepFor } from "../clientStatus/memberLogic.ts";
import { stepFingerprint as fingerprint } from "./retentionMessages.ts";
import { dateLabel, memberContact, sendOnce, siteUrl, unsubscribeUrl } from "./mailer.ts";

const STATE = "retention_state";
const WHO: Record<string, string> = { client: "You", lawyer: "Your lawyer", ilp: "Your ILP team" };


/** Pure: the email for a handoff. Client steps first, then by due date. Exported for tests. */
export function handoffMail(h: Pick<Handoff, "legalNextSteps">, o: { firstName?: string; matterTitle?: string; unsubscribeUrl: string }) {
  const steps = [...(h.legalNextSteps ?? [])]
    .filter((s) => s && typeof s.what === "string" && s.what.trim())
    .sort((a, b) => (a.who === "client" ? 0 : 1) - (b.who === "client" ? 0 : 1) || String(a.dueAt ?? "9999").localeCompare(String(b.dueAt ?? "9999")))
    .map((s) => ({ what: s.what.trim(), whoLabel: WHO[s.who] ?? "Your ILP team", dueLabel: s.dueAt ? dateLabel(s.dueAt) : undefined }));
  return handoffNextStepsEmail({ firstName: o.firstName, matterTitle: o.matterTitle, steps, homeUrl: `${siteUrl()}/status`, unsubscribeUrl: o.unsubscribeUrl });
}

/** Send the next-steps email for a just-approved handoff. Never throws. */
export async function sendHandoffNextSteps(handoff: Record<string, unknown>): Promise<boolean> {
  try {
    const h = handoff as unknown as Handoff;
    if (!h?.id || !h.clientId || !Array.isArray(h.legalNextSteps) || !h.legalNextSteps.length) return false;
    if (isPlaceholderDoc(handoff)) return false;
    const to = await memberContact(h.clientId, handoff);
    if (!to) return false;
    const matter = h.matterId ? await getRecord<Matter>(COLLECTIONS.matters, h.matterId) : null;
    const mail = handoffMail(h, { firstName: to.firstName, matterTitle: matter?.title, unsubscribeUrl: await unsubscribeUrl(to.clientId) });
    const sent = await sendOnce(`handoff_nextsteps_${h.id}`, to, mail, { kind: "service" });
    if (matter) {
      const handoffs = await findRecords<Handoff>(COLLECTIONS.handoffs, { clientId: h.clientId });
      const all = handoffs.some((x) => x.id === h.id) ? handoffs : [...handoffs, h];
      const step = nextStepFor(matter, all);
      const stateId = `ns_${matter.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
      await put(STATE, stateId, { clientId: h.clientId, matterId: matter.id, fingerprint: fingerprint(step), at: new Date().toISOString(), via: "handoff" });
    }
    return sent;
  } catch (err) {
    log(`[retention] handoff next steps ${String(handoff?.id)} failed: ${err instanceof Error ? err.message : err}`, "error");
    return false;
  }
}
