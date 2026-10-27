/**
 * scripts/accountSeedOps.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure core of the account seed (scripts/seedAccounts.ts): attach the
 * placeholder story to three REAL login accounts (a lawyer, a staff CSM and a
 * member) without ever replacing or deleting their real documents.
 *
 * Rules (docs/workstreams/SEED.md, "Account seed"):
 *   - A real document (the lawyer's `providers` doc, the member's `clients`
 *     doc, the lawyer's `lawyer_availability` doc) only gets fields that are
 *     EMPTY on it (absent, null, "", [] or {}); one level deeper for maps
 *     (e.g. clientFields.phone). A non-empty real value is never overwritten.
 *   - Arrays of objects (messages, charges, quotes, notes …) are appended to
 *     in place; each appended element carries `placeholder: true` and a `ph_`
 *     id.
 *   - Every touched path is listed in `placeholderFields`; the value it had
 *     before (when empty) in `placeholderPrior` ("__absent__" when missing),
 *     and what the seed wrote for plain fields in `placeholderValues`, so the
 *     cleanup restores the document exactly and keeps a field a person has
 *     since changed.
 *   - Everything else is a normal placeholder doc (`ph_` id, placeholder: true,
 *     placeholderBatch). A real account doc that is missing is created as a
 *     placeholder (`placeholderAccount: true`).
 * No IO here, so the tests can import it.
 */

import { isPlaceholderDoc, isPlaceholderId, PLACEHOLDER_PREFIX } from "../helper/placeholder.ts";
import type { Doc, SeedData } from "./placeholderData.ts";

export const ABSENT = "__absent__";
/** Bookkeeping fields the seed adds to a real document (all removed by the cleanup). */
export const META_KEYS = ["placeholderFields", "placeholderPrior", "placeholderValues", "placeholderAccountBatch", "placeholderSeededAt"] as const;
/** Generator markers that must never land on a real document. */
const GEN_META = ["placeholder", "placeholderBatch", "placeholderAlias", "placeholderMeta", "placeholderAccount", "isPlaceholder"];
/** Identity and audit fields the seed never fills on a real document, per collection. */
const DENY: Record<string, string[]> = {
  clients: ["id", "email", "projectId", "createdAt", "updatedAt"],
  providers: ["id", "email", "notes", "createdAt", "createdBy", "updatedAt"],
  lawyer_availability: ["id", "providerId", "updatedAt"],
};

/**
 * Record arrays the seed appends to on a real document (messages, money, notes,
 * activity). Any other array (weekly hours, companies, a stage journey) is
 * treated as one value: filled only when empty.
 */
export const APPEND_KEYS: Record<string, readonly string[]> = {
  clients: ["charges", "quotes", "notes", "activityLog", "statusComments", "statusChatThread", "pendingActions", "stageRatings"],
};

export const isPlainObject = (v: unknown): v is Doc => !!v && typeof v === "object" && !Array.isArray(v);

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (isPlainObject(v) && Object.keys(v).length === 0);
}

/** JSON with sorted keys (Firestore does not keep map key order). */
export function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : isPlainObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  return JSON.stringify(sort(v) ?? null);
}

export function getPath(doc: Doc, path: string): unknown {
  let node: unknown = doc;
  for (const part of path.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) node[part] = {};
    node = node[part] as Doc;
  }
  node[parts[parts.length - 1]] = value;
}

function unsetPath(doc: Doc, path: string): void {
  const parts = path.split(".");
  let node: unknown = doc;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node)) return;
    node = node[part];
  }
  if (isPlainObject(node)) delete node[parts[parts.length - 1]];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** One write to a real document (see helper/firestore/firestoreService.ts commitFieldWrite). */
export interface FieldWrite {
  collection: string;
  id: string;
  set: Doc;
  unset: string[];
  append: Record<string, Doc[]>;
  remove: Record<string, unknown[]>;
  /** Paths the seed added or appended to. */
  added: string[];
  /** Paths left alone because the real document already has a value. */
  skipped: string[];
  /** Cleanup only: paths kept because a person changed them after the seed. */
  kept: string[];
}

const emptyWrite = (collection: string, id: string): FieldWrite =>
  ({ collection, id, set: {}, unset: [], append: {}, remove: {}, added: [], skipped: [], kept: [] });

/** Elements appended to a real array: placeholder: true and a ph_ id each. */
export function markElements(path: string, list: Doc[]): Doc[] {
  const key = path.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
  return list.map((e, n) => {
    const id = typeof e.id === "string" && e.id ? (isPlaceholderId(e.id) ? e.id : `${PLACEHOLDER_PREFIX}${e.id}`) : `${PLACEHOLDER_PREFIX}${key}_${String(n + 1).padStart(3, "0")}`;
    return { ...e, id, placeholder: true };
  });
}

/**
 * Plan the merge of a generated document into a real one. `real` must not
 * carry an earlier account seed (restore it first: planRestore + applyWrite).
 */
export function planMerge(collection: string, id: string, real: Doc, gen: Doc, batch: string, seededAt: string): FieldWrite {
  const w = emptyWrite(collection, id);
  const deny = new Set([...GEN_META, ...META_KEYS, ...(DENY[collection] ?? ["id"])]);
  const prior: Doc = {};
  const values: Doc = {};
  const consider = (path: string, r: unknown, g: unknown, depth: number) => {
    if (isEmptyValue(g)) return;
    if (depth === 0 && (APPEND_KEYS[collection] ?? []).includes(path) && Array.isArray(g) && g.every(isPlainObject) &&
      (r === undefined || r === null || Array.isArray(r))) {
      w.append[path] = markElements(path, g as Doc[]);
      if (isEmptyValue(r)) prior[path] = r === undefined ? ABSENT : r;
      w.added.push(path);
      return;
    }
    if (isEmptyValue(r)) {
      w.set[path] = g;
      values[path] = stableJson(g);
      prior[path] = r === undefined ? ABSENT : r;
      w.added.push(path);
      return;
    }
    if (depth === 0 && isPlainObject(g) && isPlainObject(r)) {
      for (const [k, v] of Object.entries(g)) if (!k.includes(".")) consider(`${path}.${k}`, r[k], v, 1);
      return;
    }
    w.skipped.push(path);
  };
  for (const [k, g] of Object.entries(gen)) {
    if (deny.has(k) || k.includes(".")) continue;
    consider(k, real[k], g, 0);
  }
  if (w.added.length) {
    Object.assign(w.set, {
      placeholderFields: w.added,
      placeholderPrior: prior,
      placeholderValues: values,
      placeholderAccountBatch: batch,
      placeholderSeededAt: seededAt,
    });
  }
  return w;
}

/** Plan the cleanup of an account seed on a real document (no-op without placeholderFields). */
export function planRestore(collection: string, id: string, doc: Doc): FieldWrite {
  const w = emptyWrite(collection, id);
  const fields = Array.isArray(doc.placeholderFields) ? (doc.placeholderFields as string[]) : [];
  const prior = isPlainObject(doc.placeholderPrior) ? doc.placeholderPrior : {};
  const values = isPlainObject(doc.placeholderValues) ? doc.placeholderValues : {};
  const back = (path: string) => {
    if (!(path in prior) || prior[path] === ABSENT) w.unset.push(path);
    else w.set[path] = prior[path];
  };
  for (const path of fields) {
    const cur = getPath(doc, path);
    if (path in values) {
      // A plain field: restore only while it still holds what the seed wrote.
      if (cur === undefined) continue;
      if (stableJson(cur) === values[path]) back(path);
      else w.kept.push(path);
      continue;
    }
    if (!Array.isArray(cur)) {
      if (cur !== undefined && cur !== null) w.kept.push(path);
      continue;
    }
    const ph = cur.filter((e) => isPlainObject(e) && e.placeholder === true);
    if (ph.length === cur.length && path in prior) back(path);
    else if (ph.length) w.remove[path] = ph;
  }
  for (const k of META_KEYS) if (k in doc) w.unset.push(k);
  return w;
}

/** The in-memory effect of a FieldWrite (what Firestore does with commitFieldWrite). */
export function applyWrite(doc: Doc, w: FieldWrite): Doc {
  const out = clone(doc);
  for (const [p, v] of Object.entries(w.set)) setPath(out, p, clone(v));
  for (const p of w.unset) unsetPath(out, p);
  for (const [p, list] of Object.entries(w.append)) {
    const cur = getPath(out, p);
    const arr = Array.isArray(cur) ? [...cur] : [];
    for (const e of list) if (!arr.some((x) => stableJson(x) === stableJson(e))) arr.push(clone(e));
    setPath(out, p, arr);
  }
  for (const [p, list] of Object.entries(w.remove)) {
    const cur = getPath(out, p);
    if (!Array.isArray(cur)) continue;
    const drop = new Set(list.map(stableJson));
    setPath(out, p, cur.filter((x) => !drop.has(stableJson(x))));
  }
  return out;
}

export const isEmptyWrite = (w: FieldWrite) =>
  !Object.keys(w.set).length && !w.unset.length && !Object.values(w.append).some((l) => l.length) && !Object.values(w.remove).some((l) => l.length);

// ─── The whole plan ───────────────────────────────────────────────────────

export interface AccountIds {
  lawyerId: string;
  memberId: string;
  lawyerEmail: string;
  staffEmail: string;
  memberEmail: string;
}

/** Real documents found for the accounts (null when missing), already restored from an earlier run. */
export interface RealDocs {
  lawyer: Doc | null;
  member: Doc | null;
  availability: Doc | null;
  /** The member already has a real active or past-due membership: keep it, skip the seed's. */
  memberHasRealMembership: boolean;
}

export interface Write {
  collection: string;
  id: string;
  doc: Doc;
}

export interface AccountPlan {
  creates: Write[];
  merges: FieldWrite[];
  /** Non-ph_ ids the plan creates (missing account docs), per collection. */
  allowed: Array<[string, string]>;
  notes: string[];
}

/** Our own doc from an earlier account seed run (safe to replace). */
const ours = (d: Doc | null) => !!d && isPlaceholderDoc(d) && d.placeholder === true;

export function planAccountSeed(data: SeedData, ids: AccountIds, real: RealDocs, seededAt: string): AccountPlan {
  const plan: AccountPlan = { creates: [], merges: [], allowed: [], notes: [] };
  const flat: Write[] = [];
  const first = ["providers", "lawyer_availability", "clients"];
  const cols = [...first.filter((c) => data.collections[c]), ...Object.keys(data.collections).filter((c) => !first.includes(c)).sort()];
  for (const c of cols) for (const d of data.collections[c]) flat.push({ collection: c, id: String(d.id), doc: d });
  for (const s of data.subcollections) for (const d of s.docs) flat.push({ collection: s.path, id: String(d.id), doc: d });

  const account = (w: Write, realDoc: Doc | null, label: string) => {
    if (realDoc && !ours(realDoc)) {
      const m = planMerge(w.collection, w.id, realDoc, w.doc, data.batch, seededAt);
      plan.merges.push(m);
      plan.notes.push(`${label}: real ${w.collection}/${w.id} kept; ${m.added.length} empty fields filled or appended, ${m.skipped.length} left as they are.`);
      return;
    }
    plan.creates.push({ ...w, doc: { ...w.doc, placeholderAccount: true } });
    if (!isPlaceholderId(w.id)) plan.allowed.push([w.collection, w.id]);
    plan.notes.push(`${label}: no real ${w.collection}/${w.id}${realDoc ? " (only an earlier seed copy)" : ""}; created as placeholder.`);
  };
  for (const w of flat) {
    if (w.collection === "clients" && w.id === ids.memberId) account(w, real.member, "member");
    else if (w.collection === "providers" && w.id === ids.lawyerId) account(w, real.lawyer, "lawyer");
    else if (w.collection === "lawyer_availability" && w.id === ids.lawyerId) account(w, real.availability, "availability");
    else if (w.collection === "memberships" && w.doc.clientId === ids.memberId && real.memberHasRealMembership) {
      plan.notes.push(`member: real membership kept; placeholder membership ${w.id} not written.`);
    } else plan.creates.push(w);
  }
  return plan;
}

export class AccountGuardError extends Error {}

/** The write guard: creates are placeholder docs with ph_ ids (or an allowed missing account doc); merges only touch the account docs. */
export function checkAccountPlan(plan: AccountPlan, ids: AccountIds, real: RealDocs): void {
  const allowed = new Set(plan.allowed.map(([c, i]) => `${c}/${i}`));
  for (const w of plan.creates) {
    if (w.doc.placeholder !== true) throw new AccountGuardError(`Refusing to write ${w.collection}/${w.id}: not placeholder: true.`);
    if (!isPlaceholderId(w.id) && !allowed.has(`${w.collection}/${w.id}`)) throw new AccountGuardError(`Refusing to write ${w.collection}/${w.id}: not a ph_ id.`);
    if (allowed.has(`${w.collection}/${w.id}`) && w.doc.placeholderAccount !== true) throw new AccountGuardError(`${w.collection}/${w.id} must be marked placeholderAccount.`);
  }
  const targets: Record<string, Doc | null> = {
    [`clients/${ids.memberId}`]: real.member,
    [`providers/${ids.lawyerId}`]: real.lawyer,
    [`lawyer_availability/${ids.lawyerId}`]: real.availability,
  };
  for (const m of plan.merges) {
    const key = `${m.collection}/${m.id}`;
    if (!(key in targets) || !targets[key]) throw new AccountGuardError(`Refusing to merge into ${key}: not an account document.`);
    const realDoc = targets[key]!;
    for (const p of Object.keys(m.set)) {
      if ((META_KEYS as readonly string[]).includes(p)) continue;
      if (!isEmptyValue(getPath(realDoc, p))) throw new AccountGuardError(`Refusing to overwrite ${key} ${p}: it has a real value.`);
    }
    for (const p of Object.keys(m.append)) {
      const cur = getPath(realDoc, p);
      if (cur !== undefined && cur !== null && !Array.isArray(cur)) throw new AccountGuardError(`Refusing to append to ${key} ${p}: not an array.`);
      if (m.append[p].some((e) => e.placeholder !== true || !isPlaceholderId(e.id))) throw new AccountGuardError(`${key} ${p}: appended elements must be placeholder ph_ elements.`);
    }
    for (const g of GEN_META) if (g in m.set) throw new AccountGuardError(`Refusing to mark real ${key} as ${g}.`);
  }
}

// ─── What each account will see ─────────────────────────────────────────

const DAY = 86_400_000;
/** Calendar day in Costa Rica (UTC-6, no DST). */
export const crDay = (t: string | number) => new Date((typeof t === "number" ? t : Date.parse(t)) - 6 * 3_600_000).toISOString().slice(0, 10);

export interface ScreenRow {
  account: "lawyer" | "staff" | "member";
  screen: string;
  count: number;
  detail: string;
}

const tally = (list: unknown[]) => {
  const out: Record<string, number> = {};
  for (const k of list) out[String(k)] = (out[String(k)] ?? 0) + 1;
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
};

/** Counts per portal screen for the three accounts (from the generated data). */
export function screenReport(data: SeedData, ids: AccountIds): ScreenRow[] {
  const C = (c: string) => (data.collections[c] ?? []) as Doc[];
  const now = Date.parse(data.now);
  const today = crDay(now);
  const L = ids.lawyerId;
  const M = ids.memberId;
  const S = ids.staffEmail;
  const rows: ScreenRow[] = [];
  const row = (account: ScreenRow["account"], screen: string, count: number, detail = "") => rows.push({ account, screen, count, detail });

  // Lawyer
  const lc = C("consultations").filter((c) => c.providerId === L);
  const todayCalls = lc.filter((c) => crDay(String(c.scheduledAt)) === today);
  row("lawyer", "Today: calls today (CR)", todayCalls.length, todayCalls.map((c) => {
    const cr = new Date(Date.parse(String(c.scheduledAt)) - 6 * 3_600_000).toISOString().slice(11, 16);
    const consent = (c.consent as Doc | undefined)?.recording ?? "?";
    const summary = (c.summary as Doc | undefined)?.status;
    return `${cr} ${c.status}/${consent}${summary ? `/${summary}` : ""}`;
  }).join(", "));
  const lm = C("matters").filter((m) => m.assignedProviderId === L);
  const open = lm.filter((m) => !m.closedAt && m.stage !== "closed");
  const age = (m: Doc) => (now - Date.parse(String(m.stageEnteredAt))) / DAY;
  row("lawyer", "Board: matters", lm.length, `stages: ${tally(lm.map((m) => m.stage))}; open aging: ${tally(open.map((m) => (age(m) >= 14 ? "overdue" : age(m) >= 7 ? "warn" : "fresh")))}`);
  const lClients = new Set([...C("clients").filter((c) => c.assignedProviderId === L).map((c) => c.id), ...lm.map((m) => m.clientId)]);
  row("lawyer", "Clients list", lClients.size, "");
  row("lawyer", "Call pages: consultations", lc.length, `${tally(lc.map((c) => c.status))}; transcripts ${lc.filter((c) => c.transcript).length}; handoffs ${C("handoffs").filter((h) => h.providerId === L).length}`);
  const pay = C("quoteSettlements").flatMap((s) => ((s.providerPayments as Doc[] | undefined) ?? []).filter((p) => p.providerId === L));
  row("lawyer", "Finance: fee payments", pay.length, `paid ${pay.filter((p) => p.paid).length}, pending ${pay.filter((p) => !p.paid).length}; months ${[...new Set(pay.map((p) => String(p.date ?? p.dueDate ?? "").slice(0, 7)))].sort().join(" ")}`);
  const av = C("lawyer_availability").find((a) => a.id === L);
  row("lawyer", "Availability", av ? 1 : 0, av ? `${(av.weekly as unknown[]).length} weekly slots, ${(av.blackoutDates as unknown[]).length} blackout dates, specialties ${(av.specialties as unknown[]).join("/")}, max ${av.maxCallsPerDay}/day` : "");

  // Staff
  const tasks = C("csm_tasks").filter((t) => t.status === "open" && t.ownerEmail === S);
  const iso = new Date(now).toISOString();
  row("staff", "Today: My queue (open tasks)", tasks.length, `overdue ${tasks.filter((t) => String(t.dueAt) < iso).length}, due today ${tasks.filter((t) => String(t.dueAt).slice(0, 10) === iso.slice(0, 10)).length}; ${tally(tasks.map((t) => t.type))}`);
  const ms = C("memberships");
  row("staff", "Members", ms.length, `${tally(ms.map((m) => m.status))}; CSM ${S}: ${ms.filter((m) => m.csmEmail === S).length}`);
  row("staff", "Pipeline: matters", C("matters").length, tally(C("matters").map((m) => m.stage)));
  const opps = C("opportunities");
  row("staff", "Opportunities", opps.length, `${tally(opps.map((o) => o.stage))}; owned by ${S}: ${opps.filter((o) => o.ownerEmail === S).length}`);
  row("staff", "Lawyers", C("providers").length, `${C("lawyer_availability").length} with availability`);
  const fb = C("member_feedback");
  row("staff", "Reports: funnel events", C("funnel_events").length, tally(C("funnel_events").map((f) => f.step ?? f.name ?? f.type)));
  row("staff", "Reports: feedback (post-call, NPS, cancel)", fb.length, tally(fb.map((f) => f.kind)));
  row("staff", "Reports: membership cohorts (months)", new Set(ms.map((m) => String(m.activatedAt ?? m.createdAt).slice(0, 7))).size, "");
  row("staff", "Reports: audit/activity", C("audit_log").length, "");

  // Member
  const mc = C("consultations").filter((c) => c.clientId === M);
  const next = mc.filter((c) => c.status === "booked" && Date.parse(String(c.scheduledAt)) > now).sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))[0];
  row("member", "Overview: next booked call", next ? 1 : 0, next ? `${String(next.scheduledAt).slice(0, 16)}Z ${next.meetUrl ? "with Meet link" : "no link"}` : "");
  const mem = ms.find((m) => m.clientId === M);
  row("member", "Overview: membership", mem ? 1 : 0, mem ? `${mem.status}, ${mem.minutesUsed}/${mem.minutesIncluded} min, ${mem.callsUsed}/${mem.callsIncluded} calls, renews ${String(mem.periodEnd).slice(0, 10)}` : "");
  const ob = C("obligations").filter((o) => o.clientId === M);
  row("member", "Overview: obligations", ob.length, tally(ob.map((o) => o.status)));
  row("member", "Overview: matters (stage timeline)", C("matters").filter((m) => m.clientId === M).length, "");
  row("member", "Overview: completed calls (rate last call)", mc.filter((c) => c.status === "completed").length, `${tally(mc.map((c) => c.status))}`);
  const client = C("clients").find((c) => c.id === M) ?? {};
  row("member", "Profile: documents", C("member_documents").filter((d) => d.clientId === M).length, "");
  const arr = (k: string) => (Array.isArray(client[k]) ? (client[k] as Doc[]) : []);
  row("member", "Money: charges", arr("charges").length, tally(arr("charges").map((c) => c.status)));
  row("member", "Money: quotes", arr("quotes").length, tally(arr("quotes").map((q) => q.status)));
  row("member", "Money: invoices", C("invoices").filter((i) => i.clientId === M).length, "");
  const comments = arr("statusComments");
  row("member", "Messages: team thread", comments.length, `${tally(comments.map((c) => (c.authorType === "client" ? "member" : c.author === ids.lawyerEmail ? "lawyer" : "csm")))}`);
  row("member", "Messages: AI assistant (labelled)", arr("statusChatThread").length, `${arr("statusChatThread").filter((m) => m.aiGenerated).length} AI replies`);
  return rows;
}

/** Docs per collection that belong to each account (member id, lawyer id, staff email). */
export function accountCounts(data: SeedData, ids: AccountIds): Array<[string, number, number, number, number]> {
  const out: Array<[string, number, number, number, number]> = [];
  const has = (d: Doc, needle: string) => JSON.stringify(d).includes(`"${needle}"`);
  for (const [c, list] of Object.entries(data.collections).sort()) {
    out.push([c, list.length, list.filter((d) => has(d, ids.memberId)).length, list.filter((d) => has(d, ids.lawyerId)).length, list.filter((d) => has(d, ids.staffEmail)).length]);
  }
  const subs = data.subcollections.flatMap((s) => s.docs.map((d) => ({ d, member: s.path.split("/")[1] === ids.memberId, name: s.path.split("/").pop()! })));
  for (const name of [...new Set(subs.map((s) => s.name))]) {
    const list = subs.filter((s) => s.name === name);
    out.push([`clients/*/${name}`, list.length, list.filter((s) => s.member).length, 0, 0]);
  }
  return out;
}
