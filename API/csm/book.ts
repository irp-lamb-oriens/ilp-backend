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
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import { findRecords } from "../../db/records.ts";
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

/** Load a CSM's book and what the portal pages need about it. */
export async function loadBook(scope: CsmScope, now = Date.now()): Promise<BookData> {
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
  const [clients, open, upcoming, asked, feedback, contacts] = await Promise.all([
    clientsById(ids),
    findRecords<CsmTask>(COLLECTIONS.csmTasks, { status: "open" }),
    findRecords<Obligation>(COLLECTIONS.obligations, { status: "upcoming" }),
    findRecords<Obligation>(COLLECTIONS.obligations, { status: "asked" }),
    getAll(COLLECTIONS.feedback).catch(() => []) as Promise<unknown[]>,
    contactsFor(scope.csm, ids, scope.includeUnassigned),
  ]);
  return {
    scope,
    memberships,
    clients,
    openTasks: open.filter((t) => ids.has(t.clientId) || norm(t.ownerEmail) === scope.csm),
    obligations: [...upcoming, ...asked].filter((o) => ids.has(o.clientId)),
    feedback: (feedback as MemberFeedback[]).filter((f) => f && ids.has(f.clientId)),
    contacts,
  };
}

/** Consultations of the book's members (booked, completed, no-show), for Calls and KPIs. */
export async function loadConsultations(clientIds: Set<string>): Promise<Consultation[]> {
  const rows = await Promise.all(
    (["booked", "in_progress", "completed", "no_show"] as const).map((status) =>
      findRecords<Consultation>(COLLECTIONS.consultations, { status }).catch(() => [] as Consultation[])
    ),
  );
  return rows.flat().filter((c) => clientIds.has(c.clientId));
}

/** Every task (open and closed) the CSM owns, for KPIs. */
export async function tasksOwnedBy(csm: string): Promise<CsmTask[]> {
  return await findRecords<CsmTask>(COLLECTIONS.csmTasks, { ownerEmail: csm }).catch(() => []);
}
