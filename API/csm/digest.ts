/**
 * API/csm/digest.ts — the CSM daily digest (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * One email per CSM at 08:00 Costa Rica (jobs/registry.ts, 14:00 UTC):
 * overdue tasks, tasks due today, new members in their book (last 24 hours)
 * and members at risk. Nothing to say means no email. Sent once per CSM per
 * Costa Rica day (the queue key is checked first). Recipients: CSM_EMAILS,
 * DEFAULT_CSM_EMAIL and every CSM named on a live membership; reserved
 * addresses (example.com seed CSMs) are dropped by the email queue.
 */

import get from "../../db/get.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { COLLECTIONS, type Membership } from "../../schemas/contracts.ts";
import { findRecords } from "../../db/records.ts";
import { siteUrl } from "../retention/mailer.ts";
import { type BookRow, crDay, type TodayView, todayView, bookRows } from "./compute.ts";
import { loadBook } from "./book.ts";
import { csmDigestEmail, type DigestSection } from "./emails.ts";
import { staffRoleFor } from "../../helper/auth/roles.ts";

const DAY_MS = 86_400_000;
const MAX_LINES = 8;

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

const dueLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Costa_Rica" });

export interface DigestContent {
  overdue: DigestSection;
  dueToday: DigestSection;
  newMembers: DigestSection;
  risks: DigestSection;
  empty: boolean;
  summary: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function section(heading: string, lines: DigestSection["lines"]): DigestSection {
  return { heading, lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES) };
}

/** Pure: what one CSM's digest says. `memberships` gives csmAssignedAt for "new in your book". */
export function buildDigest(input: { today: TodayView; rows: BookRow[]; memberships: Membership[]; now: Date; site: string }): DigestContent {
  const t = input.now.getTime();
  const link = (clientId: string) => `${input.site}/csm/book/${encodeURIComponent(clientId)}`;
  const overdue = input.today.queue.filter((q) => q.overdue);
  const dueToday = input.today.queue.filter((q) => q.dueToday);
  const assignedAt = new Map(input.memberships.map((m) => [m.clientId, m.csmAssignedAt ?? null]));
  const fresh = input.rows.filter((r) => {
    if (r.status === "cancelled") return false;
    const a = Date.parse(String(r.activatedAt ?? ""));
    const s = Date.parse(String(assignedAt.get(r.clientId) ?? ""));
    return (!Number.isNaN(a) && t - a <= DAY_MS && t >= a) || (!Number.isNaN(s) && t - s <= DAY_MS && t >= s);
  });
  const risky = input.rows.filter((r) => r.healthBand === "at_risk").sort((a, b) => a.healthScore - b.healthScore);
  const content = {
    overdue: section("Overdue", overdue.map((q) => ({ title: `${q.title} (${q.memberName})`, detail: `Was due ${dueLabel(q.dueAt)}`, url: link(q.clientId) }))),
    dueToday: section("Due today", dueToday.map((q) => ({ title: `${q.title} (${q.memberName})`, detail: `Due ${dueLabel(q.dueAt)}`, url: link(q.clientId) }))),
    newMembers: section("New in your book", fresh.map((r) => ({ title: r.name, detail: r.status === "active" ? "Welcome call due within one business day" : "Membership not paid yet", url: link(r.clientId) }))),
    risks: section("At risk", risky.map((r) => ({ title: `${r.name}, health ${r.health.score} of 100`, detail: r.health.reasons.slice(0, 2).map((x) => x.text).join(". "), url: link(r.clientId) }))),
  };
  const parts = [
    overdue.length ? `${overdue.length} overdue` : "",
    dueToday.length ? `${dueToday.length} due today` : "",
    fresh.length ? plural(fresh.length, "new member") : "",
    risky.length ? `${plural(risky.length, "member")} at risk` : "",
  ].filter(Boolean);
  return { ...content, empty: parts.length === 0, summary: parts.join(", ") };
}

/** Everyone who gets a digest. */
export async function digestRecipients(): Promise<string[]> {
  const list = (name: string) => (Deno.env.get(name) ?? "").split(/[,;\s]+/).map(norm).filter((e) => e.includes("@"));
  const live = await Promise.all((["active", "past_due", "pending"] as const).map((status) => findRecords<Membership>(COLLECTIONS.memberships, { status }).catch(() => [] as Membership[])));
  const named = live.flat().map((m) => norm(m.csmEmail)).filter((e) => e.includes("@"));
  // Only CSMs: an admin or staff email on a membership still gets the digest when it owns members.
  return [...new Set([...list("CSM_EMAILS"), ...list("DEFAULT_CSM_EMAIL"), ...named])].sort();
}

const digestKey = (csm: string, day: string) => `csm_digest_${csm}_${day}`.replace(/[^A-Za-z0-9_-]/g, "_");

/** Send today's digest to one CSM. Returns "sent", "empty" or "already". */
export async function sendDigest(csm: string, now: Date = new Date()): Promise<"sent" | "empty" | "already"> {
  const day = crDay(now.getTime());
  const key = digestKey(csm, day);
  if (await get("email_queue", `dedupe_${key}`).catch(() => null)) return "already";
  const book = await loadBook({ viewer: csm, role: staffRoleFor(csm), csm, includeUnassigned: false }, now.getTime());
  const rows = bookRows(book, now);
  const today = todayView(rows, book.openTasks, csm, now, book.clients);
  const site = siteUrl();
  const d = buildDigest({ today, rows, memberships: book.memberships, now, site });
  if (d.empty) return "empty";
  const dayLabel = new Date(now.getTime()).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Costa_Rica" });
  const mail = csmDigestEmail({ dayLabel, summary: d.summary, sections: [d.overdue, d.dueToday, d.newMembers, d.risks], portalUrl: `${site}/csm` });
  await enqueueEmail({ to: csm, ...mail }, key);
  return "sent";
}

/** The 08:00 job: one digest per CSM, skipping empty ones. */
export async function csmDailyDigest(now: Date = new Date()): Promise<{ sent: number; empty: number; already: number }> {
  const out = { sent: 0, empty: 0, already: 0 };
  for (const csm of await digestRecipients()) {
    try {
      out[await sendDigest(csm, now)]++;
    } catch (err) {
      log(`[csm-digest] ${csm} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  log(`[csm-digest] sent ${out.sent}, empty ${out.empty}, already ${out.already}`);
  return out;
}

export const CSM_DIGEST_CRON = "0 14 * * *"; // 08:00 America/Costa_Rica (UTC-6, no daylight saving)
