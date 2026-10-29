/**
 * API/routing/notifications.ts — staff notifications (the bell) (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * One doc per notification in `staff_notifications`, deduplicated by key.
 * Every staff member sees every notification; `readBy` holds who read it.
 * `notifyStaff` also sends one email to the staff lists (ADMIN_EMAILS,
 * CSM_EMAILS, STAFF_EMAILS, DEFAULT_CSM_EMAIL; TEAM_CC when all are empty).
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { TEAM_CC } from "../../helper/team.ts";
import { adminEmails } from "../../helper/auth/roles.ts";
import { COLLECTIONS, type StaffNotification } from "../../schemas/contracts.ts";
import { staffNotificationEmail } from "./emails.ts";

type Doc = Record<string, unknown>;

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

/** Create the notification once (and email staff once). Returns null when it already existed. Never throws. */
export async function notifyStaff(n: NotifyInput): Promise<StaffNotification | null> {
  try {
    const id = notificationIdFor(n.key);
    if (await get(COLLECTIONS.staffNotifications, id).catch(() => null)) return null;
    const doc: StaffNotification = {
      id,
      kind: n.kind,
      title: n.title,
      ...(n.body ? { body: n.body } : {}),
      ...(n.link ? { link: n.link } : {}),
      ...(n.clientId ? { clientId: n.clientId } : {}),
      ...(n.matterId ? { matterId: n.matterId } : {}),
      createdAt: new Date().toISOString(),
      readBy: [],
      ...(n.placeholder ? { placeholder: true } : {}),
    };
    await put(COLLECTIONS.staffNotifications, id, doc as unknown as Doc);
    if (n.email !== false) {
      const frontend = (Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000").replace(/\/$/, "");
      const mail = staffNotificationEmail({ title: n.title, body: n.body, url: n.link ? `${frontend}${n.link}` : `${frontend}/dashboard` });
      await enqueueEmail({ to: staffAlertRecipients().join(", "), ...mail, placeholder: n.placeholder }, `staff_${id}`);
    }
    return doc;
  } catch (err) {
    log(`[routing] staff notification ${n.key} failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

/** Newest first, at most `limit`, with the unread count for this staff email. */
export async function notificationsFor(email: string, limit = 30): Promise<{ items: Array<StaffNotification & { read: boolean }>; unread: number }> {
  const me = email.trim().toLowerCase();
  const rows = ((await getAll(COLLECTIONS.staffNotifications).catch(() => [])) as unknown as StaffNotification[])
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const withRead = rows.map((r) => ({ ...r, readBy: Array.isArray(r.readBy) ? r.readBy : [], read: Array.isArray(r.readBy) && r.readBy.includes(me) }));
  return { items: withRead.slice(0, limit), unread: withRead.filter((r) => !r.read).length };
}

/** Mark notifications read for one staff email (all when ids is empty). */
export async function markRead(email: string, ids: string[]): Promise<number> {
  const me = email.trim().toLowerCase();
  const rows = (await getAll(COLLECTIONS.staffNotifications).catch(() => [])) as unknown as StaffNotification[];
  let n = 0;
  for (const r of rows) {
    if (ids.length && !ids.includes(r.id)) continue;
    const readBy = Array.isArray(r.readBy) ? r.readBy : [];
    if (readBy.includes(me)) continue;
    await put(COLLECTIONS.staffNotifications, r.id, { readBy: [...readBy, me] });
    n++;
  }
  return n;
}
