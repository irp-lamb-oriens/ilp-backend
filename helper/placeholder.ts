/**
 * helper/placeholder.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Placeholder (seed) data guard rails. `scripts/seedPlaceholdersFull.ts`
 * writes realistic fake members, lawyers and records into production so the
 * three portals look alive; this module keeps that data from ever reaching the
 * outside world and makes it easy to recognise and remove.
 *
 * Conventions (docs/workstreams/SEED.md):
 *   - every placeholder document has `placeholder: true` and a
 *     `placeholderBatch` id, and its document id starts with `ph_`
 *     (one exception: a member mapped to PLACEHOLDER_MEMBER_EMAIL keeps the
 *     email-derived client id so its owner can sign in; it still carries
 *     `placeholder: true`);
 *   - placeholder people use reserved email domains (RFC 2606 / 6761), so no
 *     message to them can be delivered even if a guard is missed.
 *
 * Guards that use this module: email transport and queue
 * (config/integrations.ts, helper/emailQueue.ts), web push (config/push.ts),
 * Calendar/Meet on booking (API/calls/callService.ts), Stripe on cancel
 * (API/payments/cancel.ts), member emails (API/retention/mailer.ts) and the
 * jobs in jobs/.
 */

import get from "../db/get.ts";
import log from "./log.ts";

export const PLACEHOLDER_PREFIX = "ph_";

/** Second-level domains reserved for documentation (RFC 2606). */
export const RESERVED_EMAIL_DOMAINS = ["example.com", "example.org", "example.net"] as const;
/** Top-level domains that can never resolve (RFC 2606 / 6761). */
export const RESERVED_TLDS = ["test", "invalid", "example", "localhost"] as const;

/** Domain part of an address, lower-cased ("" when there is none). */
function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).trim().toLowerCase().replace(/[>\s]+$/, "").replace(/\.$/, "");
}

/** True for an address on a reserved domain (example.com/.org/.net or a .test/.invalid/… TLD). */
export function isReservedEmail(email: unknown): boolean {
  if (typeof email !== "string" || !email.includes("@")) return false;
  const d = domainOf(email);
  if (!d) return false;
  if ((RESERVED_EMAIL_DOMAINS as readonly string[]).some((r) => d === r || d.endsWith(`.${r}`))) return true;
  const tld = d.split(".").pop() ?? "";
  return (RESERVED_TLDS as readonly string[]).includes(tld);
}

/** Split a To/CC/BCC value ("a@x.com, b@y.com" or an array) into addresses. */
export function addressList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
  return raw.map((s) => String(s ?? "").trim()).filter(Boolean);
}

/** Recipients with reserved-domain addresses removed. */
export function deliverableRecipients(v: unknown): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const a of addressList(v)) (isReservedEmail(a) ? dropped : kept).push(a);
  return { kept, dropped };
}

export function isPlaceholderId(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(PLACEHOLDER_PREFIX);
}

/** A document is placeholder data when it says so or its id has the `ph_` prefix. */
export function isPlaceholderDoc(doc: unknown): boolean {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as Record<string, unknown>;
  return d.placeholder === true || d.isPlaceholder === true || isPlaceholderId(d.id);
}

export class PlaceholderGuardError extends Error {}

/**
 * The seeder's write guard: refuse any id that is not a `ph_` id, unless it is
 * the one explicitly allowed login alias. Throws, so a bug can never write over
 * real data.
 */
export function assertPlaceholderId(collection: string, id: string, allowedAliases: ReadonlySet<string> = new Set()): void {
  if (isPlaceholderId(id)) return;
  if (collection === "clients" && allowedAliases.has(id)) return;
  throw new PlaceholderGuardError(`Refusing to write ${collection}/${id}: placeholder ids must start with "${PLACEHOLDER_PREFIX}".`);
}

/** Refuse a document that does not carry placeholder: true. */
export function assertPlaceholderDoc(collection: string, id: string, doc: Record<string, unknown>): void {
  if (doc.placeholder !== true) {
    throw new PlaceholderGuardError(`Refusing to write ${collection}/${id}: the document is not marked placeholder: true.`);
  }
}

/** Fields stamped on records the app derives from placeholder records (tasks, bookings …). */
export const DERIVED_BATCH = "derived";
export function derivedStamp(): { placeholder: true; placeholderBatch: string } {
  return { placeholder: true, placeholderBatch: DERIVED_BATCH };
}

// ─── Client lookup (cached) ───────────────────────────────────────────────

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: boolean }>();

/**
 * True when the member is placeholder data: a `ph_` client id, or a client
 * document marked placeholder (the login alias). Cached for 5 minutes; a read
 * failure counts as "not placeholder" so real members are never silenced.
 */
export async function isPlaceholderClient(clientId: unknown): Promise<boolean> {
  if (typeof clientId !== "string" || !clientId) return false;
  if (isPlaceholderId(clientId)) return true;
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = false;
  try {
    const doc = await get("clients", clientId);
    value = isPlaceholderDoc(doc);
  } catch {
    value = false;
  }
  cache.set(clientId, { at: Date.now(), value });
  return value;
}

/** Test hook. */
export function clearPlaceholderCache(): void {
  cache.clear();
}

/** One log line per skipped outward action. */
export function logSkipped(what: string, detail: string): void {
  log(`[placeholder] skipped ${what}: ${detail}`, "placeholder");
}
