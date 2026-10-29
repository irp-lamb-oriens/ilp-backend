/**
 * API/routing/notifications.ts — staff notifications (the bell) (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * COMMS-P3: notifications now live in the shared `notifications` collection
 * (API/notifications/store.ts) on the "staff:*" channel, deduplicated by key;
 * older rows in `staff_notifications` are still shown. `readBy` holds who read it.
 * `notifyStaff` also sends one email to the staff lists (ADMIN_EMAILS,
 * CSM_EMAILS, STAFF_EMAILS, DEFAULT_CSM_EMAIL; TEAM_CC when all are empty).
 */

import { TEAM_CC } from "../../helper/team.ts";
import { adminEmails, staffRoleFor } from "../../helper/auth/roles.ts";
import { bellFor, markRead as markReadShared, notify, type Reader } from "../notifications/store.ts";
import { bookClientIds } from "../csm/book.ts";
import type { StaffNotification } from "../../schemas/contracts.ts";
import { staffNotificationEmail } from "./emails.ts";

const list = (name: string) =>
  (Deno.env.get(name) ?? "").split(/[,;\s]+/).map((e) => e.trim().replace(/^["']+|["']+$/g, "").toLowerCase()).filter((e) => e.includes("@"));

/** Every address that gets staff alerts: admins, CSMs, STAFF_EMAILS, DEFAULT_CSM_EMAIL; TEAM_CC when none. */
export function staffAlertRecipients(): string[] {
  const all = [...adminEmails(), ...list("CSM_EMAILS"), ...list("STAFF_EMAILS"), ...list("DEFAULT_CSM_EMAIL")];
  const unique = [...new Set(all)];
  return unique.length ? unique : [TEAM_CC];
}

/** Notification id from its dedupe key; a ph_ key (seed data) keeps the ph_ prefix for the placeholder cleanup. */
export const notificationIdFor = (key: string) =>
  (key.startsWith("ph_") ? `ph_ntf_${key.slice(3)}` : `ntf_${key}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 300);

export interface NotifyInput {
  key: string; // dedupe key: the same key never notifies twice
  kind: StaffNotification["kind"];
  title: string;
  body?: string;
  link?: string;
  clientId?: string;
  matterId?: string;
  placeholder?: boolean;
  email?: boolean; // also email the staff lists (default true)
}

/**
 * Create the notification once (and email staff once). Returns null when it already existed. Never throws.
 * COMMS-P3: stored in the shared `notifications` collection on the "staff:*" channel
 * (API/notifications/store.ts); older rows in `staff_notifications` are still read.
 */
export async function notifyStaff(n: NotifyInput): Promise<StaffNotification | null> {
  const frontend = (Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000").replace(/\/$/, "");
  const mail = n.email !== false
    ? { to: staffAlertRecipients().join(", "), ...staffNotificationEmail({ title: n.title, body: n.body, url: n.link ? `${frontend}${n.link}` : `${frontend}/dashboard` }) }
    : undefined;
  const doc = await notify({
    key: n.key,
    kind: n.kind,
    to: "staff:*",
    title: n.title,
    body: n.body,
    link: n.link,
    clientId: n.clientId,
    matterId: n.matterId,
    severity: n.kind === "routing.no_match" ? "urgent" : "action",
    placeholder: n.placeholder,
    email: mail,
  });
  if (!doc) return null;
  return { id: doc.id, kind: doc.kind, title: doc.title, body: doc.body, link: doc.link, clientId: doc.clientId, matterId: doc.matterId, createdAt: doc.createdAt, readBy: doc.readBy, placeholder: doc.placeholder };
}

/** Newest first, at most `limit`, with the unread count for this staff email (COMMS-P3: the shared bell). */
export async function notificationsFor(email: string, limit = 30): Promise<{ items: Array<StaffNotification & { read: boolean }>; unread: number }> {
  const role = staffRoleFor(email);
  const reader: Reader = { role, id: email, ...(role === "csm" ? { bookClientIds: await bookClientIds(email) } : {}) };
  return await bellFor(reader, limit) as unknown as { items: Array<StaffNotification & { read: boolean }>; unread: number };
}

/** Mark notifications read for one staff email (all when ids is empty). */
export async function markRead(email: string, ids: string[]): Promise<number> {
  const role = staffRoleFor(email);
  const reader: Reader = { role, id: email, ...(role === "csm" ? { bookClientIds: await bookClientIds(email) } : {}) };
  return await markReadShared(reader, ids);
}
