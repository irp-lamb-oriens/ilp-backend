/**
 * API/retention/mailer.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Member email plumbing for P2: who to write to, once-only enqueue, links,
 * and signed unsubscribe tokens.
 *
 * Idempotency: every message has a key (e.g. `dunning_mem_1_2026-10-26_d3`).
 * The queue doc id is derived from it; if that doc already exists the message
 * is not queued again, even after it was sent (the queue's own dedupe would
 * re-send a sent item, so it is not enough on its own).
 */

import get from "../../db/get.ts";
import log from "../../helper/log.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { isPlaceholderDoc, logSkipped } from "../../helper/placeholder.ts";
import type { MemberEmail } from "../../helper/emailTemplates.ts";

const QUEUE = "email_queue";
const TZ = "America/Costa_Rica";

export const siteUrl = () =>
  (Deno.env.get("PUBLIC_SITE_URL") || Deno.env.get("FRONTEND_URL") || "http://localhost:3000").replace(/\/$/, "");
export const apiUrl = () =>
  (Deno.env.get("PUBLIC_API_URL") || Deno.env.get("API_PUBLIC_URL") || "http://localhost:8000").replace(/\/$/, "");

export interface MemberContact {
  clientId: string;
  email: string;
  firstName: string;
  optOut: boolean;
  /** Placeholder (seed) member: every message is skipped (helper/placeholder.ts). */
  placeholder?: boolean;
}

/**
 * `record` = the membership (or other record) the message is about: a
 * placeholder record on a real member (account seed, scripts/seedAccounts.ts)
 * never produces an email either.
 */
export async function memberContact(clientId: string, record?: unknown): Promise<MemberContact | null> {
  const c = (await get("clients", clientId).catch(() => null)) as Record<string, unknown> | null;
  const email = typeof c?.email === "string" ? c.email.trim() : "";
  if (!c || !email) return null;
  const full = typeof c.fullName === "string" ? c.fullName : typeof c.name === "string" ? c.name : "";
  return {
    clientId,
    email,
    firstName: full.trim().split(/\s+/)[0] ?? "",
    optOut: c.emailOptOut === true,
    placeholder: isPlaceholderDoc({ ...c, id: clientId }) || isPlaceholderDoc(record),
  };
}

/** Pure: the queue doc key for a message key. */
export const queueKey = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 400);

/**
 * Queue a member email once per key. Non-transactional messages are skipped
 * for members who opted out. Returns true when queued now.
 */
export async function sendOnce(
  key: string,
  to: MemberContact,
  mail: MemberEmail,
  opts: { transactional: boolean },
): Promise<boolean> {
  if (!opts.transactional && to.optOut) return false;
  if (to.placeholder) {
    logSkipped("member email", key);
    return false;
  }
  const k = queueKey(key);
  const existing = await get(QUEUE, `dedupe_${k}`).catch(() => null);
  if (existing) return false;
  await enqueueEmail({ to: to.email, subject: mail.subject, html: mail.html, text: mail.text }, k);
  log(`[retention] queued ${key} → ${to.clientId}`, "retention");
  return true;
}

export function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: TZ });
}

/** Calendar day (YYYY-MM-DD) in Costa Rica. */
export function crDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

// ─── Signed links (unsubscribe) ───────────────────────────────────────────

function secret(): string {
  return Deno.env.get("RETENTION_LINK_SECRET") || Deno.env.get("OTP_PEPPER") || "dev-only-retention-secret";
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(sig.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const unsubscribeToken = (clientId: string) => hmac(`unsub:${clientId}`);

export async function verifyUnsubscribe(clientId: string, token: string): Promise<boolean> {
  if (!clientId || !token || token.length !== 32) return false;
  const want = await unsubscribeToken(clientId);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export async function unsubscribeUrl(clientId: string): Promise<string> {
  return `${apiUrl()}/api/retention/unsubscribe?c=${encodeURIComponent(clientId)}&t=${await unsubscribeToken(clientId)}`;
}
