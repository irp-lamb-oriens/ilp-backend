/**
 * API/notifications/store.ts — the bell (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * One `notifications` doc per bell item, created once per dedupe key. Each
 * item belongs to one channel (`to`, see AppNotification in contracts):
 * "staff:*", "csm:*", "csm:<email>", "staff:<email>" or "lawyer:<providerId>".
 * A reader's list is the union of their channels, read with one equality
 * query per channel (no composite index), newest first.
 *
 * Who reads what:
 *   admin, staff  staff:*, staff:<me>, csm:<me>
 *   csm           csm:*, csm:<me>, staff:<me>, and staff:* items about
 *                 members in their own book or with no CSM yet (routing alerts)
 *   lawyer        lawyer:<providerId>
 *
 * Older ROUTING alerts in `staff_notifications` are read as staff:* items so
 * nothing on the bell disappears; marking one read writes back to that row.
 *
 * Email: `notify` sends an email only when `email` is passed. The plan keeps
 * immediate emails to privacy requests, failed payments and a missing
 * specialty; everything else waits for the CSM daily digest.
 */

import get from "../../db/get.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import getAll from "../../db/getAll.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { isPlaceholderId } from "../../helper/placeholder.ts";
import { csmOfMember } from "../csm/book.ts";
import { type AppNotification, COLLECTIONS, type NotificationSeverity } from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;

export type ReaderRole = "staff" | "admin" | "csm" | "lawyer";

export interface Reader {
  role: ReaderRole;
  /** Lowercase email (staff, admin, csm) or provider id (lawyer). */
  id: string;
  /** CSM only: client ids in their book, to show staff-wide alerts about their own members. */
  bookClientIds?: ReadonlySet<string>;
}

export interface NotifyInput {
  key: string; // dedupe key: the same key never notifies twice
  kind: string;
  to: string;
  title: string;
  body?: string;
  link?: string;
  clientId?: string;
  matterId?: string;
  severity?: NotificationSeverity;
  placeholder?: boolean;
  /** Also send this email once (immediate alerts only). */
  email?: { to: string; subject: string; html: string; text: string };
}

const norm = (v: string) => v.trim().toLowerCase();

/** Pure: the channel for one person. */
export const channelFor = (role: "staff" | "csm" | "lawyer", id: string) => `${role}:${role === "lawyer" ? id : norm(id)}`;

/** Pure: the channels a reader's bell reads. */
export function channelsFor(reader: Reader): string[] {
  if (reader.role === "lawyer") return [`lawyer:${reader.id}`];
  const me = norm(reader.id);
  if (reader.role === "csm") return ["csm:*", `csm:${me}`, `staff:${me}`, "staff:*"];
  return ["staff:*", `staff:${me}`, `csm:${me}`];
}

/** Notification id from its dedupe key; a ph_ key (seed data) keeps the ph_ prefix for the placeholder cleanup. */
export const notificationId = (key: string) =>
  (key.startsWith("ph_") ? `ph_nt_${key.slice(3)}` : `nt_${key}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 300);

/** Create the notification once (and send its email once). Returns null when it already existed. Never throws. */
export async function notify(n: NotifyInput): Promise<AppNotification | null> {
  try {
    if (!n.to || !n.title) return null;
    const id = notificationId(n.key);
    if (await get(COLLECTIONS.notifications, id).catch(() => null)) return null;
    const placeholder = n.placeholder === true || isPlaceholderId(n.clientId) || isPlaceholderId(n.key);
    const doc: AppNotification = {
      id,
      kind: n.kind,
      to: n.to,
      title: n.title,
      ...(n.body ? { body: n.body } : {}),
      ...(n.link ? { link: n.link } : {}),
      ...(n.clientId ? { clientId: n.clientId } : {}),
      ...(n.matterId ? { matterId: n.matterId } : {}),
      severity: n.severity ?? "info",
      createdAt: new Date().toISOString(),
      readBy: [],
      ...(n.email ? { emailed: true } : {}),
      ...(placeholder ? { placeholder: true } : {}),
    };
    await put(COLLECTIONS.notifications, id, doc as unknown as Doc);
    if (n.email && n.email.to) {
      // enqueueEmail drops placeholder records and reserved (example.com) addresses.
      await enqueueEmail({ ...n.email, placeholder }, `notify_${id}`);
    }
    return doc;
  } catch (err) {
    log(`[notifications] ${n.key} failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

export type BellItem = AppNotification & { read: boolean; legacy?: boolean };

const readerKey = (reader: Reader) => (reader.role === "lawyer" ? reader.id : norm(reader.id));

/**
 * Pure: may this reader see this item? staff:* items reach a CSM only about
 * members in their book or members with no CSM yet (`unassigned`).
 */
export function visibleTo(item: Pick<AppNotification, "to" | "clientId">, reader: Reader, unassigned: ReadonlySet<string> = new Set()): boolean {
  const channels = channelsFor(reader);
  if (!channels.includes(item.to)) return false;
  if (reader.role === "csm" && item.to === "staff:*") {
    return !!item.clientId && (!!reader.bookClientIds?.has(item.clientId) || unassigned.has(item.clientId));
  }
  return true;
}

/** CSM bell: which members named by staff-wide items have no CSM yet (at most 50 lookups). */
async function unassignedAmong(rows: AppNotification[], reader: Reader): Promise<Set<string>> {
  const out = new Set<string>();
  if (reader.role !== "csm") return out;
  const ids = [...new Set(rows.filter((r) => r.to === "staff:*" && r.clientId && !reader.bookClientIds?.has(r.clientId)).map((r) => r.clientId!))].slice(0, 50);
  const csms = await Promise.all(ids.map((id) => csmOfMember(id).catch(() => null)));
  ids.forEach((id, i) => {
    if (csms[i] === "") out.add(id);
  });
  return out;
}

async function legacyStaffItems(): Promise<AppNotification[]> {
  const rows = (await getAll(COLLECTIONS.staffNotifications).catch(() => [])) as Doc[];
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind ?? "alert"),
    to: "staff:*",
    title: String(r.title ?? ""),
    ...(typeof r.body === "string" ? { body: r.body } : {}),
    ...(typeof r.link === "string" ? { link: r.link } : {}),
    ...(typeof r.clientId === "string" ? { clientId: r.clientId } : {}),
    severity: "action" as NotificationSeverity,
    createdAt: String(r.createdAt ?? ""),
    readBy: Array.isArray(r.readBy) ? (r.readBy as string[]) : [],
    legacy: true,
  } as AppNotification & { legacy: boolean }));
}

/** Every item this reader may see, newest first (not limited). */
export async function itemsFor(reader: Reader): Promise<BellItem[]> {
  const me = readerKey(reader);
  const channels = channelsFor(reader);
  const batches = await Promise.all(
    channels.map((c) => query(COLLECTIONS.notifications, [{ field: "to", op: "EQUAL", value: c }]).catch(() => [] as Doc[])),
  );
  const rows = batches.flat() as unknown as AppNotification[];
  if (reader.role !== "lawyer") rows.push(...(await legacyStaffItems()));
  const unassigned = await unassignedAmong(rows, reader);
  // A CSM who has their own copy of an alert does not also get the staff-wide one.
  const own = new Set(rows.filter((r) => r.to.startsWith("csm:") && r.clientId).map((r) => `${r.kind}|${r.clientId}`));
  const seen = new Set<string>(rows.filter((r) => reader.role === "csm" && r.to === "staff:*" && own.has(`${r.kind}|${r.clientId}`)).map((r) => r.id));
  const out: BellItem[] = [];
  for (const r of rows) {
    if (!r?.id || seen.has(r.id) || !visibleTo(r, reader, unassigned)) continue;
    seen.add(r.id);
    const readBy = Array.isArray(r.readBy) ? r.readBy : [];
    out.push({ ...r, readBy, read: readBy.includes(me) });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** The bell: newest `limit` items and the unread count over everything the reader may see. */
export async function bellFor(reader: Reader, limit = 30): Promise<{ items: BellItem[]; unread: number }> {
  const all = await itemsFor(reader);
  return { items: all.slice(0, Math.max(1, Math.min(limit, 100))), unread: all.filter((i) => !i.read).length };
}

/** Mark items read for this reader (every visible unread item when ids is empty). Returns how many changed. */
export async function markRead(reader: Reader, ids: string[]): Promise<number> {
  const me = readerKey(reader);
  const all = await itemsFor(reader);
  let n = 0;
  for (const item of all) {
    if (item.read) continue;
    if (ids.length && !ids.includes(item.id)) continue;
    const collection = item.legacy ? COLLECTIONS.staffNotifications : COLLECTIONS.notifications;
    await put(collection, item.id, { readBy: [...item.readBy, me] });
    n++;
  }
  return n;
}
