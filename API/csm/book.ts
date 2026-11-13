/**
 * API/csm/book.ts — who a CSM may see, and loading their book (COMMS-P3).
 * ──────────────────────────────────────────────────────────────────────────
 * A CSM's book is every member whose current membership names them
 * (memberships.csmEmail). The scope is enforced here, on the server:
 *   - a CSM always reads their own book; ?csm=<someone else> answers 403;
 *   - staff and admins read any CSM's book with ?csm=<email> (default: their own);
 *   - ?unassigned=1 adds members with no CSM yet (anyone may see and take them);
 *   - a member in another CSM's book is never readable by a CSM, by id or in a list.
 *
 * Loads use equality queries and bounded per-member gets (no full scans of
 * large collections apart from small reference data).
 */

import type { Request } from "express";
import get from "../../db/get.ts";
import query from "../../db/query.ts";
import { findForClients, findRecords } from "../../db/records.ts";
import { type AuthedRequest } from "../../helper/auth/session.ts";
import { staffRoleFor } from "../../helper/auth/roles.ts";
import type { StaffRole } from "../../helper/auth/session.ts";
import {
  COLLECTIONS,
  type Consultation,
  type CsmContact,
  type CsmTask,
  type Membership,
  type MemberFeedback,
  type Obligation,
} from "../../schemas/contracts.ts";
import { latestMembershipPerClient } from "../dashboard/staffHome/compute.ts";
import { memo } from "../../helper/memo.ts";
import { placeholderExcluded } from "../../helper/placeholderScope.ts";

type Doc = Record<string, unknown>;

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export const CSM_SCOPE_DENIED = "This member is in another CSM's book. Ask an admin if you need to cover for a colleague.";

export interface CsmScope {
  viewer: string;
  role: StaffRole;
  /** Whose book is shown. */
  csm: string;
  includeUnassigned: boolean;
}

export type ScopeResult = { ok: true; scope: CsmScope } | { ok: false; status: number; error: string; code: string };

/** Pure: the scope for a viewer and the request's ?csm= / ?unassigned=. */
export function resolveScope(viewerEmail: string, role: StaffRole, q: { csm?: unknown; unassigned?: unknown }): ScopeResult {
  const viewer = norm(viewerEmail);
  const asked = typeof q.csm === "string" ? norm(q.csm) : "";
  const includeUnassigned = q.unassigned === "1" || q.unassigned === "true";
  if (role === "csm" && asked && asked !== viewer) {
    return { ok: false, status: 403, code: "csm_scope", error: CSM_SCOPE_DENIED };
  }
  const csm = role === "csm" ? viewer : asked || viewer;
  return { ok: true, scope: { viewer, role, csm, includeUnassigned } };
}

/** The scope of a request (after requireDashboardAuth). */
export function scopeOf(req: Request): ScopeResult {
  const r = req as AuthedRequest;
  const viewer = r.dashboardUser ?? "";
  const role = staffRoleFor(viewer);
  return resolveScope(viewer, role, req.query as Record<string, unknown>);
}

/** The member's current CSM (latest membership), or "" when unassigned. Null when the member has no membership. */
export async function csmOfMember(clientId: string): Promise<string | null> {
  const ms = await findRecords<Membership>(COLLECTIONS.memberships, { clientId }).catch(() => []);
  if (!ms.length) return null;
  const [m] = latestMembershipPerClient(ms);
  return norm(m?.csmEmail);
}

/** Pure: may this viewer open a member whose CSM is `memberCsm` ("" = unassigned)? */
export function mayOpenMember(role: StaffRole, viewer: string, memberCsm: string | null): boolean {
  if (role !== "csm") return true;
  if (memberCsm === null) return false; // not a member: CSMs only work with members
  return memberCsm === "" || memberCsm === norm(viewer);
}

/** Check a member id against the request's viewer. */
export async function memberAccess(req: Request, clientId: string): Promise<{ allowed: boolean; memberCsm: string | null; role: StaffRole }> {
  const r = req as AuthedRequest;
  const viewer = r.dashboardUser ?? "";
  const role = staffRoleFor(viewer);
  if (role !== "csm") return { allowed: true, memberCsm: null, role };
  const memberCsm = await csmOfMember(clientId);
  return { allowed: mayOpenMember(role, viewer, memberCsm), memberCsm, role };
}

/** Client ids in a CSM's book (current membership names them). */
export async function bookClientIds(csmEmail: string): Promise<Set<string>> {
  const rows = (await findRecords<Membership>(COLLECTIONS.memberships, { csmEmail: norm(csmEmail) }).catch(() => []));
  // Any membership naming the CSM counts (used for bell filtering, where a wider net is harmless).
  return new Set(rows.map((m) => m.clientId));
}

export interface BookData {
  scope: CsmScope;
  /** Current membership per member in scope (active, pending, past due; cancelled in the last 30 days). */
  memberships: Membership[];
  clients: Map<string, Doc>;
  /** Open tasks about these members (any owner) and every open task owned by the CSM. */
  openTasks: CsmTask[];
  obligations: Obligation[];
  feedback: MemberFeedback[];
  contacts: CsmContact[];
}

const RECENT_CANCEL_MS = 30 * 86_400_000;

/** Pure: keep the memberships a book shows. */
export function inBook(m: Membership, scope: Pick<CsmScope, "csm" | "includeUnassigned">, now = Date.now()): boolean {
  const owner = norm(m.csmEmail);
  const mine = owner === scope.csm || (scope.includeUnassigned && !owner);
  if (!mine) return false;
  if (m.status === "cancelled") {
    const at = Date.parse(String(m.cancelledAt ?? m.updatedAt ?? ""));
    return !Number.isNaN(at) && now - at <= RECENT_CANCEL_MS;
  }
  return true;
}

async function clientsById(ids: Iterable<string>): Promise<Map<string, Doc>> {
  const unique = [...new Set(ids)].filter(Boolean);
  const docs = await Promise.all(unique.map((id) => get(COLLECTIONS.clients, id).catch(() => null)));
  const out = new Map<string, Doc>();
  unique.forEach((id, i) => {
    const d = docs[i];
    if (d) out.set(id, { ...(d as Doc), id });
  });
  return out;
}

/** Contacts about these members: logged by the CSM, or logged for their book by anyone. */
async function contactsFor(csm: string, clientIds: Set<string>, includeUnassigned: boolean): Promise<CsmContact[]> {
  const [mine, forBook] = await Promise.all([
    query(COLLECTIONS.csmContacts, [{ field: "csmEmail", op: "EQUAL", value: csm }]).catch(() => []),
    query(COLLECTIONS.csmContacts, [{ field: "bookCsmEmail", op: "EQUAL", value: csm }]).catch(() => []),
  ]);
  const extra: Doc[] = [];
  if (includeUnassigned) {
    // Unassigned members are few: read their contacts one member at a time.
    const others = [...clientIds].filter((id) => ![...mine, ...forBook].some((c) => c.clientId === id));
    const rows = await Promise.all(others.slice(0, 200).map((id) => query(COLLECTIONS.csmContacts, [{ field: "clientId", op: "EQUAL", value: id }]).catch(() => [])));
    extra.push(...rows.flat());
  }
  const seen = new Set<string>();
  const out: CsmContact[] = [];
  for (const c of [...mine, ...forBook, ...extra] as unknown as CsmContact[]) {
    if (!c?.id || seen.has(c.id) || !clientIds.has(c.clientId)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** What the book is built from: a write to any of these drops the kept book (helper/memo.ts). */
const BOOK_DEPS = [COLLECTIONS.memberships, COLLECTIONS.csmTasks, COLLECTIONS.obligations, COLLECTIONS.feedback, COLLECTIONS.csmContacts, COLLECTIONS.clients];

/**
 * Load a CSM's book and what the portal pages need about it. Every /csm page
 * needs the same book, so it is built once and kept until one of BOOK_DEPS
 * changes (or MEMO_TTL_MIN passes), instead of being rebuilt on each page.
 */
export function loadBook(scope: CsmScope, now = Date.now()): Promise<BookData> {
  // "Exclude placeholder data" filters inside the reads, so it is part of the key.
  const ph = placeholderExcluded() ? "real" : "all";
  return memo(`csm-book:${scope.csm}:${scope.includeUnassigned ? "with-unassigned" : "own"}:${ph}`, BOOK_DEPS, () => buildBook(scope, now));
}

async function buildBook(scope: CsmScope, now: number): Promise<BookData> {
  const [mine, all] = await Promise.all([
    findRecords<Membership>(COLLECTIONS.memberships, { csmEmail: scope.csm }),
    scope.includeUnassigned ? findRecords<Membership>(COLLECTIONS.memberships) : Promise.resolve([] as Membership[]),
  ]);
  // A member's latest membership decides whose book they are in.
  const candidateIds = new Set([...mine, ...all.filter((m) => !m.csmEmail)].map((m) => m.clientId));
  const everyForCandidates = scope.includeUnassigned
    ? all.filter((m) => candidateIds.has(m.clientId))
    : (await Promise.all([...candidateIds].map((id) => findRecords<Membership>(COLLECTIONS.memberships, { clientId: id }).catch(() => [])))).flat();
  const memberships = latestMembershipPerClient(everyForCandidates).filter((m) => inBook(m, scope, now));
  const ids = new Set(memberships.map((m) => m.clientId));
  // Only the book's own documents: clientId IN (…), never a whole collection (readMeter.ts).
  const [clients, memberTasks, ownedOpen, obligations, feedback, contacts] = await Promise.all([
    clientsById(ids),
    findForClients<CsmTask>(COLLECTIONS.csmTasks, ids, { where: { status: "open" } }),
    findRecords<CsmTask>(COLLECTIONS.csmTasks, { ownerEmail: scope.csm, status: "open" }).catch(() => [] as CsmTask[]),
    findForClients<Obligation>(COLLECTIONS.obligations, ids, { where: { status: ["upcoming", "asked"] } }),
    findForClients<MemberFeedback>(COLLECTIONS.feedback, ids).catch(() => [] as MemberFeedback[]),
    contactsFor(scope.csm, ids, scope.includeUnassigned),
  ]);
  const seen = new Set<string>();
  const openTasks = [...memberTasks, ...ownedOpen].filter((t) => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
  return {
    scope,
    memberships,
    clients,
    openTasks,
    obligations,
    feedback: feedback.filter((f) => f && ids.has(f.clientId)),
    contacts,
  };
}

/** Consultations of the book's members (booked, completed, no-show), for Calls and KPIs. */
export function loadConsultations(clientIds: Set<string>): Promise<Consultation[]> {
  const key = `csm-calls:${placeholderExcluded() ? "real" : "all"}:${[...clientIds].sort().join(",")}`;
  return memo(key, [COLLECTIONS.consultations], () => findForClients<Consultation>(COLLECTIONS.consultations, clientIds, {
    where: { status: ["booked", "in_progress", "completed", "no_show"] },
  }).catch(() => [] as Consultation[]));
}

/**
 * Tasks the CSM owns, for KPIs: still open (any age) plus everything created in
 * the last `days` (default 120; the KPIs look back 90 days at most). Never the
 * CSM's whole history. Needs the (ownerEmail, createdAt) index.
 */
export function tasksOwnedBy(csm: string, now = Date.now(), days = 120): Promise<CsmTask[]> {
  return memo(`csm-owned:${csm}:${days}:${placeholderExcluded() ? "real" : "all"}`, [COLLECTIONS.csmTasks], () => ownedTasks(csm, now, days));
}

async function ownedTasks(csm: string, now: number, days: number): Promise<CsmTask[]> {
  const since = new Date(now - days * 86_400_000).toISOString();
  const [recent, open] = await Promise.all([
    query(COLLECTIONS.csmTasks, [
      { field: "ownerEmail", op: "EQUAL", value: csm },
      { field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: since },
    ]).catch(() => []),
    findRecords<CsmTask>(COLLECTIONS.csmTasks, { ownerEmail: csm, status: "open" }).catch(() => []),
  ]);
  const byId = new Map<string, CsmTask>();
  for (const t of [...(recent as unknown as CsmTask[]), ...open]) if (t?.id) byId.set(t.id, t);
  return [...byId.values()];
}
