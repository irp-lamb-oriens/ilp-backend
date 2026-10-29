/**
 * scripts/seedCsmBooks.ts — placeholder CSM books for the /csm portal (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * Works on placeholder data only (run scripts/seedPlaceholdersFull.ts first):
 *   - placeholder memberships with no CSM get one of the placeholder CSMs
 *     (scripts/placeholderData.ts STAFF, role "csm", @example.com), round
 *     robin by id; every fifth stays unassigned so "Show unassigned" has rows;
 *   - each placeholder member in a book gets up to two logged contacts
 *     (ph_ctc_<clientId>_<n>), except every fourth member, who has none, so the
 *     health score and first-contact checks have something to show;
 *   - each placeholder CSM gets a few bell items (ph_nt_…).
 * Idempotent: fills only what is missing (a membership that has a CSM keeps
 * it; existing contacts and notifications are left as they are), ids are
 * deterministic, every doc has placeholder: true. Real records are never
 * read for writing: only ph_ ids with placeholder: true are touched.
 * Placeholder CSMs use @example.com, so no email ever reaches them.
 * Remove with scripts/removePlaceholders.ts (csm_contacts and notifications
 * are in its collection list).
 *
 * Run (dry run by default, prints the plan, no writes):
 *   deno run --allow-net --allow-env --allow-read scripts/seedCsmBooks.ts
 *   deno run --allow-net --allow-env --allow-read scripts/seedCsmBooks.ts --confirm-project=<firestore project id>
 */

import { loadSync } from "dotenv/mod.ts";
import getAll from "../db/getAll.ts";
import put from "../db/put.ts";
import { getProjectId } from "../db/projectId.ts";
import { isPlaceholderDoc, isPlaceholderId } from "../helper/placeholder.ts";
import type { AppNotification, CsmContact, CsmContactChannel } from "../schemas/contracts.ts";
import { STAFF } from "./placeholderData.ts";

type Doc = Record<string, unknown>;

export const PLACEHOLDER_CSMS: string[] = STAFF.filter((s) => s.role === "csm").map((s) => s.email);
const DAY = 86_400_000;

export interface CsmSeedPlan {
  assign: Array<{ membershipId: string; clientId: string; csmEmail: string }>;
  contacts: CsmContact[];
  notifications: AppNotification[];
}

const SUMMARIES: Array<[CsmContactChannel, string, boolean]> = [
  ["call", "Welcome call. Went through the profile together and booked the first call.", true],
  ["email", "Sent the renewal check-in with the booking link.", true],
  ["whatsapp", "Asked for the missing passport copy; she will send it this week.", true],
  ["call", "Called about the open quote. No answer, left a voicemail.", false],
];

/**
 * Pure: what to write. `memberships`, `contacts` and `notifications` are what
 * Firestore holds now; only placeholder memberships are considered.
 */
export function planCsmSeed(memberships: Doc[], contacts: Doc[], notifications: Doc[], now: Date, csms: string[] = PLACEHOLDER_CSMS): CsmSeedPlan {
  const plan: CsmSeedPlan = { assign: [], contacts: [], notifications: [] };
  if (!csms.length) return plan;
  const live = memberships
    .filter((m) => isPlaceholderDoc(m) && isPlaceholderId(m.id) && ["active", "pending", "past_due"].includes(String(m.status)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const haveContact = new Set(contacts.map((c) => String(c.id)));
  const haveNote = new Set(notifications.map((n) => String(n.id)));
  const t = now.getTime();
  const owner = new Map<string, string>();
  live.forEach((m, i) => {
    const current = String(m.csmEmail ?? "").trim().toLowerCase();
    if (current) {
      owner.set(String(m.clientId), current);
      return;
    }
    if (i % 5 === 4) return; // stays unassigned
    const csm = csms[i % csms.length];
    owner.set(String(m.clientId), csm);
    plan.assign.push({ membershipId: String(m.id), clientId: String(m.clientId), csmEmail: csm });
  });
  const clientIds = [...owner.keys()].sort();
  clientIds.forEach((clientId, i) => {
    if (i % 4 === 3) return; // no contact logged: shows as "never contacted"
    const csm = owner.get(clientId)!;
    const n = i % 3 === 0 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const id = `ph_ctc_${clientId.replace(/^ph_/, "")}_${k}`;
      if (haveContact.has(id)) continue;
      const [channel, summary, reached] = SUMMARIES[(i + k) % SUMMARIES.length];
      const at = new Date(t - ((i % 40) + 2 + k * 9) * DAY).toISOString();
      plan.contacts.push({ id, clientId, csmEmail: csm, bookCsmEmail: csm, channel, direction: "outbound", reached, summary, at, createdAt: at, placeholder: true });
    }
  });
  for (const csm of csms) {
    const mine = clientIds.filter((id) => owner.get(id) === csm).slice(0, 2);
    mine.forEach((clientId, k) => {
      const id = `ph_nt_csm_seed_${csm.split("@")[0].replace(/[^a-z0-9]/g, "_")}_${k}`;
      if (haveNote.has(id)) return;
      plan.notifications.push({
        id,
        kind: k === 0 ? "member.assigned" : "member.low_score",
        to: `csm:${csm}`,
        title: k === 0 ? "New member in your book (placeholder)" : "Low rating (placeholder)",
        body: k === 0 ? "Plan the welcome call within one business day." : "Low rating: follow up",
        link: `/csm/book/${encodeURIComponent(clientId)}`,
        clientId,
        severity: "action",
        createdAt: new Date(t - (k + 1) * 3_600_000).toISOString(),
        readBy: [],
        placeholder: true,
      });
    });
  }
  return plan;
}

async function main(): Promise<number> {
  loadSync({ export: true, allowEmptyValues: true, examplePath: null });
  const confirm = Deno.args.find((a) => a.startsWith("--confirm-project="))?.split("=")[1];
  const [memberships, contacts, notifications] = await Promise.all([
    getAll("memberships") as Promise<Doc[]>,
    getAll("csm_contacts").catch(() => []) as Promise<Doc[]>,
    getAll("notifications").catch(() => []) as Promise<Doc[]>,
  ]);
  const plan = planCsmSeed(memberships, contacts, notifications, new Date());
  console.log(`Placeholder CSMs: ${PLACEHOLDER_CSMS.join(", ")}`);
  console.log(`Memberships to give a CSM: ${plan.assign.length}; contacts to add: ${plan.contacts.length}; bell items to add: ${plan.notifications.length}`);
  for (const a of plan.assign.slice(0, 5)) console.log(`  ${a.membershipId} → ${a.csmEmail}`);
  if (!confirm) {
    console.log(`Dry run: nothing written. Re-run with --confirm-project=<project id> to write.`);
    return 0;
  }
  const project = getProjectId();
  if (confirm !== project) {
    console.error(`--confirm-project=${confirm} does not match the service account's project "${project}".`);
    return 2;
  }
  const now = new Date().toISOString();
  for (const a of plan.assign) {
    if (!isPlaceholderId(a.membershipId)) continue;
    await put("memberships", a.membershipId, { csmEmail: a.csmEmail, csmAssignedAt: now, updatedAt: now } as unknown as Doc);
  }
  for (const c of plan.contacts) await put("csm_contacts", c.id, c as unknown as Doc);
  for (const n of plan.notifications) await put("notifications", n.id, n as unknown as Doc);
  console.log("Done.");
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}

