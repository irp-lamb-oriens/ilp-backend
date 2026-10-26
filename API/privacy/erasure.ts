/**
 * API/privacy/erasure.ts — "Run deletion" for a member (P6).
 *
 * Applies ERASURE_PLAN (policy.ts) rule by rule through a small Store
 * interface, so the whole matrix is testable in memory
 * (test/privacy_test.ts) and runs against Firestore + Cloud Storage in
 * production (`firestoreStore()`).
 *
 *   delete              the document goes (member_documents also delete the stored file)
 *   anonymize           the document is replaced by the `keep` fields only
 *   pseudonymize_email  `email` becomes "sha256:<hex>", everything else stays
 *   keep                untouched (accounting, security log)
 *
 * `planErasure` is a dry run (counts per collection) for the staff screen.
 * Erasure refuses while a membership is pending, active or past due: billing
 * must be cancelled first so Stripe stops charging a person ILP can no
 * longer identify.
 */

import get from "../../db/get.ts";
import replaceDoc from "../../db/replace.ts";
import query from "../../db/query.ts";
import remove from "../../db/delete.ts";
import { emailToDocId } from "../../helper/auth/otp.ts";
import { scopedAccessToken } from "../../helper/storage.ts";
import { type ErasureAction, ERASURE_PLAN, type ErasureRule, keepOnly, sha256Hex } from "./policy.ts";

type Doc = Record<string, unknown>;

export interface Store {
  get(collection: string, id: string): Promise<Doc | null>;
  where(collection: string, field: string, value: string): Promise<Doc[]>; // rows carry `id`
  replace(collection: string, id: string, doc: Doc): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
  removeFile(objectName: string): Promise<void>;
}

export interface Subject {
  clientId: string;
  email: string;
  anonId?: string;
  emailDocId: string;
}

export interface ErasureLine {
  collection: string;
  action: ErasureAction;
  count: number;
  why: string;
}

export interface ErasureResult {
  lines: ErasureLine[];
  filesDeleted: number;
  fileErrors: number;
}

export const OPEN_MEMBERSHIP = ["pending", "active", "past_due"];

/** Why erasure cannot run yet, or null. */
export async function erasureBlocker(store: Store, clientId: string): Promise<string | null> {
  const ms = await store.where("memberships", "clientId", clientId);
  const open = ms.find((m) => OPEN_MEMBERSHIP.includes(String(m.status)));
  return open
    ? `Membership ${open.id} is ${open.status}. Cancel it (and the Stripe subscription) before deleting the account.`
    : null;
}

async function select(store: Store, rule: ErasureRule, s: Subject): Promise<Doc[]> {
  const rows: Doc[] = [];
  for (const sel of rule.select) {
    if (sel.by === "docId") {
      const d = await store.get(rule.collection, s.clientId);
      if (d) rows.push({ ...d, id: s.clientId });
    } else if (sel.by === "emailDocId") {
      const d = await store.get(rule.collection, s.emailDocId);
      if (d) rows.push({ ...d, id: s.emailDocId });
    } else if (sel.by === "field") {
      rows.push(...await store.where(rule.collection, sel.field, s.clientId));
    } else if (sel.by === "email") {
      if (s.email) rows.push(...await store.where(rule.collection, sel.field, s.email));
    } else if (sel.by === "anonId") {
      if (s.anonId) rows.push(...await store.where(rule.collection, "anonId", s.anonId));
    } else if (sel.by === "leadOf") {
      rows.push(...await store.where(rule.collection, "convertedClientId", s.clientId));
      if (s.email) rows.push(...await store.where(rule.collection, "email", s.email));
    }
  }
  const seen = new Map<string, Doc>();
  for (const r of rows) if (typeof r.id === "string") seen.set(r.id, r);
  return [...seen.values()];
}

/** Dry run: how many documents each rule would touch. */
export async function planErasure(store: Store, s: Subject): Promise<ErasureLine[]> {
  const out: ErasureLine[] = [];
  for (const rule of ERASURE_PLAN) {
    const rows = rule.select.length ? await select(store, rule, s) : [];
    out.push({ collection: rule.collection, action: rule.action, count: rows.length, why: rule.why });
  }
  return out;
}

/** Apply the matrix. Idempotent: a second run finds tombstones and hashed emails only. */
export async function runErasure(store: Store, s: Subject, at: Date = new Date()): Promise<ErasureResult> {
  const lines: ErasureLine[] = [];
  let filesDeleted = 0;
  let fileErrors = 0;
  const hashed = `sha256:${await sha256Hex(s.email)}`;
  for (const rule of ERASURE_PLAN) {
    const rows = rule.select.length && rule.action !== "keep" ? await select(store, rule, s) : [];
    let count = 0;
    for (const row of rows) {
      const id = String(row.id);
      if (rule.action === "delete") {
        if (rule.collection === "member_documents" && row.storage === "gcs" && typeof row.objectName === "string") {
          try {
            await store.removeFile(row.objectName);
            filesDeleted++;
          } catch {
            fileErrors++;
            continue; // keep the metadata so a re-run retries the file
          }
        }
        await store.remove(rule.collection, id);
      } else if (rule.action === "anonymize") {
        const kept = keepOnly(row, rule.keep ?? ["id"]);
        await store.replace(rule.collection, id, { ...kept, id, erased: true, erasedAt: at.toISOString() });
      } else if (rule.action === "pseudonymize_email") {
        if (typeof row.email === "string" && row.email.startsWith("sha256:")) continue;
        await store.replace(rule.collection, id, { ...row, id, email: hashed, erasedAt: at.toISOString() });
      }
      count++;
    }
    lines.push({ collection: rule.collection, action: rule.action, count, why: rule.why });
  }
  return { lines, filesDeleted, fileErrors };
}

// ─── Production store ─────────────────────────────────────────────────────

async function deleteObject(objectName: string): Promise<void> {
  const bucket = Deno.env.get("DOCUMENT_BUCKET");
  if (!bucket) throw new Error("DOCUMENT_BUCKET is not set.");
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${await scopedAccessToken()}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed (${res.status})`);
}

export function firestoreStore(): Store {
  return {
    get: async (c, id) => ((await get(c, id).catch(() => null)) as Doc | null),
    where: async (c, field, value) =>
      ((await query(c, [{ field, op: "EQUAL", value }]).catch(() => [])) as unknown as Doc[]),
    // Full replace: db/put merges, which would keep the fields we mean to drop.
    replace: (c, id, doc) => replaceDoc(c, id, doc),
    remove: async (c, id) => {
      await remove(c, id);
    },
    removeFile: deleteObject,
  };
}

export function subjectFor(clientId: string, email: string, client: Doc | null): Subject {
  const mail = email.trim().toLowerCase();
  const anon = typeof client?.funnelAnonId === "string" ? client.funnelAnonId : undefined;
  return { clientId, email: mail, anonId: anon, emailDocId: emailToDocId(mail) };
}
