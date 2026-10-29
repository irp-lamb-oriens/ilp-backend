/**
 * API/csm/notifyEvents.ts — bell items (and the few immediate emails) for
 * CSMs from events the server already raises (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Called by members/events.ts after a TASK_RULES task is created, and when a
 * membership gets a CSM. Every item is keyed by its task (or assignment), so
 * a retry never notifies twice. Never throws.
 *
 *   event                         bell item                       email now?
 *   membership.past_due           "Payment failed: <name>"        yes, to the CSM
 *   privacy.request_received      "Privacy request: <name>"       yes, to the CSM (+ staff bell)
 *   routing.no_match              the staff alert (routing/notifications.ts) is on the bell of the
 *                                 member's CSM (or every CSM while the member has none) and already
 *                                 emails the team: no second item, no second email
 *   membership.cancel_requested   "Cancellation requested"        no (daily digest)
 *   feedback.low_score            "Low rating"                    no (daily digest)
 *   consultation.no_show          "Missed call" (COMMS-P4)        no (daily digest)
 *   membership.csmEmail set       "New member in your book"       no (daily digest)
 *   membership activated, no CSM  "New member without a CSM"      no (every CSM's bell)
 */

import get from "../../db/get.ts";
import { type CsmTask } from "../../schemas/contracts.ts";
import { displayName } from "../dashboard/staffHome/compute.ts";
import { siteUrl } from "../retention/mailer.ts";
import { channelFor, notify } from "../notifications/store.ts";
import { csmAlertEmail } from "./emails.ts";

type Doc = Record<string, unknown>;

interface Rule {
  kind: string;
  title: string;
  severity: "info" | "action" | "urgent";
  email: boolean;
  alsoStaff?: boolean;
}

export const TASK_NOTIFICATIONS: Record<string, Rule> = {
  "membership.past_due": { kind: "payment.failed", title: "Payment failed", severity: "urgent", email: true },
  "privacy.request_received": { kind: "privacy.request", title: "Privacy request", severity: "urgent", email: true, alsoStaff: true },
  "membership.cancel_requested": { kind: "member.cancel_requested", title: "Cancellation requested", severity: "action", email: false },
  "feedback.low_score": { kind: "member.low_score", title: "Low rating", severity: "action", email: false },
  "consultation.no_show": { kind: "call.no_show", title: "Missed call", severity: "action", email: false }, // COMMS-P4
};

async function memberName(clientId: string): Promise<string> {
  const c = (await get("clients", clientId).catch(() => null)) as Doc | null;
  return displayName(c, clientId);
}

const memberLink = (clientId: string) => `/csm/book/${encodeURIComponent(clientId)}`;

/** Bell item (and email) for a task just created from a TASK_RULES event. */
export async function notifyForTask(event: string, task: CsmTask): Promise<void> {
  const rule = TASK_NOTIFICATIONS[event];
  if (!rule) return;
  try {
    const name = await memberName(task.clientId);
    const isPh = (task as unknown as Doc).placeholder === true;
    const title = `${rule.title}: ${name}`;
    const body = task.title;
    const owner = (task.ownerEmail ?? "").trim().toLowerCase();
    const link = memberLink(task.clientId);
    const to = owner ? channelFor("csm", owner) : "csm:*";
    const email = rule.email && owner ? { to: owner, ...csmAlertEmail({ title, body, url: `${siteUrl()}${link}` }) } : undefined;
    await notify({ key: `${event}_${task.id}`, kind: rule.kind, to, title, body, link, clientId: task.clientId, matterId: task.matterId, severity: rule.severity, placeholder: isPh, email });
    if (rule.alsoStaff) {
      await notify({ key: `${event}_${task.id}_staff`, kind: rule.kind, to: "staff:*", title, body, link: `/dashboard/members/${encodeURIComponent(task.clientId)}`, clientId: task.clientId, severity: rule.severity, placeholder: isPh });
    }
  } catch {
    // never break the request that raised the event
  }
}

/** A membership got (or changed) its CSM: tell the new CSM. Unassigned activations go to every CSM. */
export async function notifyMembershipCsm(before: Doc | null, after: Doc): Promise<void> {
  try {
    const clientId = typeof after.clientId === "string" ? after.clientId : "";
    if (!clientId) return;
    const placeholder = after.placeholder === true;
    const now = typeof after.csmEmail === "string" ? after.csmEmail.trim().toLowerCase() : "";
    const prev = typeof before?.csmEmail === "string" ? before.csmEmail.trim().toLowerCase() : "";
    const live = after.status === "active" || after.status === "pending" || after.status === "past_due";
    if (now && now !== prev && live) {
      const name = await memberName(clientId);
      await notify({
        key: `member_assigned_${String(after.id ?? clientId)}_${now}`,
        kind: "member.assigned",
        to: channelFor("csm", now),
        title: `New member in your book: ${name}`,
        body: after.status === "active" ? "Plan the welcome call within one business day." : "Membership not paid yet. Say hello and help with the payment if needed.",
        link: memberLink(clientId),
        clientId,
        severity: "action",
        placeholder,
      });
      return;
    }
    if (!now && after.status === "active" && before?.status !== "active") {
      const name = await memberName(clientId);
      await notify({
        key: `member_unassigned_${String(after.id ?? clientId)}`,
        kind: "member.unassigned",
        to: "csm:*",
        title: `New member without a CSM: ${name}`,
        body: "Take this member from My book (show unassigned) if they are yours.",
        link: memberLink(clientId),
        clientId,
        severity: "action",
        placeholder,
      });
    }
  } catch {
    // never break the write that caused it
  }
}
