/**
 * API/routing/service.ts — routing I/O (ROUTING).
 * ──────────────────────────────────────────────────────────────────────────
 * Loads lawyers (profile, licences, availability, load, hidden rating) and
 * the member's request, runs the pure router (router.ts), persists the
 * decision ("Why this lawyer") and the assignment, and runs the no-match
 * path when nobody passes:
 *
 *   1. staff: one in-app notification + one email to the staff lists, and a
 *      CSM task ("routing.no_match"), deduplicated per member and matter
 *      through routing_gaps/<gap id>;
 *   2. member: /status shows "we are arranging your lawyer" and an email says so;
 *   3. sales: a short call with the sales team (SALES_EMAILS, default
 *      consultation@internationalrelocationpartner.com) is booked on the sales
 *      hours (lawyer_availability/ilp_sales) with a Meet invitation, or a
 *      "sales.call_unscheduled" task when no time is free. It never uses
 *      membership minutes.
 *
 * Open gaps are retried by the routingSweep job and right after a lawyer is
 * approved or a lawyer profile or specialty changes (rerouteSoon). When one
 * resolves, the member is assigned and emailed, the task closes and staff
 * see a "resolved" notification.
 */

import get from "../../db/get.ts";
import { queueKey } from "../retention/mailer.ts"; // COMMS-P5
import put from "../../db/put.ts";
import getAll from "../../db/getAll.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import auditLog from "../../helper/auditLog.ts";
import { enqueueEmail } from "../../helper/emailQueue.ts";
import { createCalendarEvent } from "../../helper/calendar.ts";
import { isPlaceholderClient, isPlaceholderDoc, isPlaceholderId, PLACEHOLDER_PREFIX } from "../../helper/placeholder.ts";
import {
  AREA_GROUPS,
  COLLECTIONS,
  type Consultation,
  COUNTRIES,
  type CountryCode,
  type CsmTask,
  DEFAULT_SALES_EMAIL,
  type LawyerClientType,
  type LawyerRoutingStatus,
  type Matter,
  obligationDueAt,
  type Obligation,
  ROUTING_RULES_VERSION,
  ROUTING_SLOT_DAYS,
  type RoutingDecision,
  type RoutingGap,
  type RoutingTrigger,
  SALES_CALL_LENGTH_MIN,
  SALES_TEAM_ID,
  type Specialty,
  toAreaGroup,
  toCountryCode,
} from "../../schemas/contracts.ts";
import { createRecord, findRecords, getRecord, newId, updateRecord } from "../../db/records.ts";
import { profileRecord, withDefaults } from "../members/service.ts";
import { emitEvent, taskIdFor } from "../members/events.ts";
import { isProviderBookable } from "../providers/applyLogic.ts";
import { buildSlots, defaultAvailability } from "../calls/callLogic.ts";
import { claimSlot, withLawyerSlots } from "../calls/slotClaims.ts";
import {
  type CallRecord,
  flagCalendarProblem,
  frontendUrl,
  loadAvailability,
  memberCountry,
  memberHomeUrl,
  personTimeZone,
  placeholderMeetUrl,
  providerCountries,
  slotsFor,
  whenLabel,
} from "../calls/callService.ts";
import { assignMember } from "../members/assignment.ts";
import { type LawyerForRouting, memberLanguages, type RouteRequest, routeCandidates, inferSpecialty, urgencyDays } from "./router.ts";
import { cleanSpecialtyIds, loadSpecialties, resolveSpecialty } from "./specialties.ts";
import { ratingsByProvider } from "./ratings.ts";
import { notifyStaff } from "./notifications.ts";
import { arrangingLawyerEmail, lawyerAssignedEmail, salesCallEmail } from "./emails.ts";

type Doc = Record<string, unknown>;
const DAY = 86_400_000;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
export type RoutingActor = { email: string; role: "staff" | "lawyer" | "client" | "system" };
const SYSTEM: RoutingActor = { email: "system", role: "system" };

/** Sales inboxes: SALES_EMAILS (comma list), default consultation@internationalrelocationpartner.com. */
export function salesEmails(): string[] {
  const l = (Deno.env.get("SALES_EMAILS") ?? "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"));
  return l.length ? [...new Set(l)] : [DEFAULT_SALES_EMAIL];
}

/** Days ahead a candidate must have a free slot (ROUTING_SLOT_DAYS env, default 10). */
export function slotDays(): number {
  const n = Number(Deno.env.get("ROUTING_SLOT_DAYS"));
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : ROUTING_SLOT_DAYS;
}

const areaLabel = (id: string | null) => (id ? AREA_GROUPS.find((g) => g.id === id)?.label ?? id : "General questions");

// ─── Lawyers ───────────────────────────────────────────────────────────────

/** The static routing facts of one provider doc (no I/O). Exported for tests and the staff list. */
export function lawyerFacts(p: Doc, availability: Doc | null, specialties: readonly Specialty[]) {
  const providerId = String(p.id ?? "");
  const bookable = isProviderBookable(p);
  const countries = providerCountries(p).map((c) => toCountryCode(c)).filter((c): c is CountryCode => !!c);
  const licences = Array.isArray(p.licences) ? (p.licences as Doc[]) : [];
  // A licence record decides; lawyers approved before licence records count as verified (staff review checked it).
  const verifiedCountries = countries.filter((c) => {
    const l = licences.find((x) => toCountryCode(x.country) === c);
    return l ? l.verified === true : bookable;
  });
  const ids = cleanSpecialtyIds(p.specialties, specialties);
  const areas = [...new Set([
    ...ids.map((id) => resolveSpecialty(id, specialties)?.group).filter((g): g is NonNullable<typeof g> => !!g),
    ...arr(p.legalAreas).map(toAreaGroup).filter((g): g is NonNullable<typeof g> => !!g),
    ...arr(availability?.specialties).map(toAreaGroup).filter((g): g is NonNullable<typeof g> => !!g),
  ])];
  const app = (p.application && typeof p.application === "object" ? p.application : {}) as Doc;
  const regions = arr(p.regions).length ? arr(p.regions) : [str(app.province), str(app.city)].filter((x): x is string => !!x);
  const status = p.routingStatus === "paused" || p.routingStatus === "onboarding" ? p.routingStatus as LawyerRoutingStatus : "active";
  const maxRaw = Number(p.maxCallsPerWeek ?? app.callsPerWeek);
  return {
    providerId,
    name: str(p.name) ?? str(p.email) ?? providerId,
    bookable,
    routingStatus: status,
    countries,
    verifiedCountries,
    specialties: ids,
    areas,
    languages: arr(p.languages).map((l) => l.toLowerCase()),
    regions,
    clientTypes: arr(p.clientTypes) as LawyerClientType[],
    conflicts: arr(p.conflicts),
    maxCallsPerWeek: Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : null,
    placeholder: isPlaceholderId(providerId),
  };
}

/** Calls held in the next 7 days (member calls only), the load the router balances. */
async function callsNext7Days(providerId: string, now: Date): Promise<number> {
  const rows = await findRecords<Consultation>(COLLECTIONS.consultations, { providerId }).catch(() => [] as Consultation[]);
  const from = now.toISOString();
  const to = new Date(now.getTime() + 7 * DAY).toISOString();
  return rows.filter((c) => c.kind !== "sales" && c.status !== "cancelled" && c.status !== "no_show" && c.scheduledAt >= from && c.scheduledAt < to).length;
}

/**
 * Every provider as the router sees it. Slots are read only for lawyers who
 * are bookable and licensed in the request's country (the others fail a
 * cheaper check anyway).
 */
export async function lawyersForRouting(country: CountryCode, now: Date, specialties: readonly Specialty[], exclude?: string): Promise<LawyerForRouting[]> {
  const [providers, availability, ratings] = await Promise.all([
    getAll("providers").catch(() => []) as Promise<Doc[]>,
    getAll(COLLECTIONS.availability).catch(() => []) as Promise<Doc[]>,
    ratingsByProvider(),
  ]);
  const availBy = new Map(availability.map((a) => [String(a.providerId ?? a.id), a]));
  const out: LawyerForRouting[] = [];
  for (const p of providers) {
    const id = String(p.id ?? "");
    if (!id || id === exclude || id === SALES_TEAM_ID) continue;
    const f = lawyerFacts(p, availBy.get(id) ?? null, specialties);
    const reachable = f.bookable && f.countries.includes(country);
    const nextSlotAt = reachable ? ((await slotsFor(id, now).catch(() => [] as string[]))[0] ?? null) : now.toISOString();
    const r = ratings.get(id);
    out.push({
      ...f,
      callsThisWeek: reachable ? await callsNext7Days(id, now) : 0,
      nextSlotAt,
      ratingScore: r ? Number(r.ratingScore) : 100,
      reviewCount: r ? Number(r.reviewCount) : 0,
    });
  }
  return out;
}

// ─── Request ───────────────────────────────────────────────────────────────

export interface RequestContext {
  clientId: string;
  request: RouteRequest;
  client: Doc | null;
  matter: Matter | null;
  specialties: Specialty[];
}

/** What this member and matter need, from the profile, the matter, its question and deadlines. */
export async function buildRequest(clientId: string, matterId: string | undefined, now: Date): Promise<RequestContext> {
  const [client, matters, obligations, specialties] = await Promise.all([
    get(COLLECTIONS.clients, clientId).catch(() => null) as Promise<Doc | null>,
    findRecords<Matter>(COLLECTIONS.matters, { clientId }, { sortBy: "openedAt", desc: true }).catch(() => [] as Matter[]),
    findRecords<Obligation>(COLLECTIONS.obligations, { clientId }).catch(() => [] as Obligation[]),
    loadSpecialties(),
  ]);
  const p = profileRecord(client);
  const matter = (matterId ? matters.find((m) => m.id === matterId) : matters.find((m) => !m.closedAt)) ?? null;
  const country = toCountryCode(matter?.country) ?? await memberCountry(clientId, client);
  let area = toAreaGroup(matter?.area ?? p.legalArea);
  const stored = resolveSpecialty(matter?.specialtyId, specialties);
  const specialtyId = stored?.id ?? inferSpecialty([matter?.question, matter?.title].filter(Boolean).join(". "), area, specialties);
  if (!area && specialtyId) area = resolveSpecialty(specialtyId, specialties)?.group ?? null;
  const open = obligations.filter((o) => (o.status === "upcoming" || o.status === "asked") && !o.dismissedAt);
  const relevant = area ? open.filter((o) => toAreaGroup(o.area) === area) : open;
  const region = area === "real_estate" ? str(p.propertyLocation) ?? str(p.residenceProvince) : str(p.residenceProvince) ?? str(p.propertyLocation);
  const request: RouteRequest = {
    country,
    area,
    specialtyId,
    languages: memberLanguages(p.preferredLanguage),
    timezone: personTimeZone(p),
    urgencyDays: urgencyDays([matter?.deadlineAt, ...relevant.map((o) => obligationDueAt(o))], now),
    clientType: p.hasCompany === true && area === "corporate" ? "company" : "individual",
    region,
    previousProviderId: str(matter?.assignedProviderId) ?? str(client?.assignedProviderId),
    counterparties: arr(matter?.counterparties),
    memberName: str(p.fullName) ?? ([str(p.name), str(p.surname)].filter(Boolean).join(" ") || undefined),
    placeholder: await isPlaceholderClient(clientId),
  };
  return { clientId, request, client, matter, specialties };
}

// ─── Decide ────────────────────────────────────────────────────────────────

export interface Decided extends RequestContext {
  decision: RoutingDecision;
}

/** Run the router for one member (and matter). Nothing is written. */
export async function decideRoute(clientId: string, opts: { matterId?: string; trigger: RoutingTrigger; exclude?: string; now?: Date } ): Promise<Decided> {
  const now = opts.now ?? new Date();
  const ctx = await buildRequest(clientId, opts.matterId, now);
  const lawyers = await lawyersForRouting(ctx.request.country, now, ctx.specialties, opts.exclude);
  const r = routeCandidates(ctx.request, lawyers, now, ctx.specialties, slotDays());
  const { counterparties: _c, memberName: _n, placeholder: _p, ...summary } = ctx.request;
  const decision: RoutingDecision = {
    rulesVersion: ROUTING_RULES_VERSION,
    at: now.toISOString(),
    trigger: opts.trigger,
    providerId: r.ranked[0]?.providerId ?? null,
    request: summary,
    candidates: r.ranked.slice(0, 5),
    rejected: r.rejected.slice(0, 25),
    ...(r.noMatchReason ? { noMatchReason: r.noMatchReason } : {}),
  };
  return { ...ctx, decision };
}

/** Store the decision on the matter (or the client when there is none) and audit it. */
export async function saveDecision(clientId: string, matter: Matter | null, decision: RoutingDecision, actor: RoutingActor = SYSTEM): Promise<void> {
  if (matter) await updateRecord(COLLECTIONS.matters, matter.id, { routing: decision }).catch(() => null);
  else await put(COLLECTIONS.clients, clientId, { routing: decision }).catch(() => undefined);
  await auditLog({
    actor: { uid: actor.email, email: actor.email, role: actor.role },
    action: decision.providerId ? "routing.decided" : "routing.no_match",
    target: matter ? `matters/${matter.id}` : `clients/${clientId}`,
    meta: {
      clientId,
      trigger: decision.trigger,
      providerId: decision.providerId,
      rulesVersion: decision.rulesVersion,
      candidates: decision.candidates.map((c) => ({ providerId: c.providerId, score: c.score })),
      rejected: decision.rejected.length,
      ...(decision.noMatchReason ? { reason: decision.noMatchReason } : {}),
      ...(decision.overriddenBy ? { overriddenBy: decision.overriddenBy } : {}),
    },
  }).catch(() => undefined);
}

export interface RouteOutcome {
  providerId: string | null;
  decision: RoutingDecision;
  gap?: RoutingGap;
}

/**
 * Route, persist and assign. A match assigns the member (assignMember: the
 * matters and upcoming calls follow) and resolves an open gap; no match runs
 * the no-match path. Never throws (a failure reads as no match, logged).
 */
export async function routeAndAssign(clientId: string, opts: { matterId?: string; trigger: RoutingTrigger; actor?: RoutingActor; exclude?: string }): Promise<RouteOutcome> {
  const actor = opts.actor ?? SYSTEM;
  const d = await decideRoute(clientId, { matterId: opts.matterId, trigger: opts.trigger, exclude: opts.exclude });
  await saveDecision(clientId, d.matter, d.decision, actor);
  if (d.decision.providerId) {
    const to = d.decision.providerId;
    if (str(d.client?.assignedProviderId) !== to) {
      await assignMember(clientId, to, { email: actor.email, role: actor.role }, { auto: true, reason: `Routed (${opts.trigger})` });
    }
    const gap = await openGapFor(clientId, d.matter?.id);
    if (gap) await resolveGap(gap, to, d);
    return { providerId: to, decision: d.decision };
  }
  const gap = await handleNoMatch(d);
  return { providerId: null, decision: d.decision, gap };
}

/**
 * The lawyer a member books with now: the matter's or member's lawyer while
 * they can still take calls (continuity), else a fresh route that is
 * persisted. Null means no match (the no-match path has run).
 */
export async function lawyerForBooking(clientId: string, matterId: string | undefined, actor: RoutingActor = SYSTEM): Promise<RouteOutcome | { providerId: string; decision?: undefined; gap?: undefined }> {
  const [matter, client] = await Promise.all([
    matterId ? getRecord<Matter>(COLLECTIONS.matters, matterId) : Promise.resolve(null),
    get(COLLECTIONS.clients, clientId).catch(() => null) as Promise<Doc | null>,
  ]);
  for (const id of [str(matter?.assignedProviderId), str(client?.assignedProviderId)]) {
    if (id && isProviderBookable((await get("providers", id).catch(() => null)) as Doc | null)) return { providerId: id };
  }
  return await routeAndAssign(clientId, { matterId, trigger: "booking", actor });
}

// ─── No match ──────────────────────────────────────────────────────────────

/** Gap id per member and matter; seed (ph_) members get a ph_ id so the placeholder cleanup removes it. */
export const gapIdFor = (clientId: string, matterId?: string | null) => {
  const base = `gap_${clientId.replace(/^ph_/, "")}_${(matterId || "member").replace(/^ph_/, "")}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return isPlaceholderId(clientId) ? `${PLACEHOLDER_PREFIX}${base}` : base;
};

/** The member's open gap for this matter (or any open gap of the member when no matter). */
export async function openGapFor(clientId: string, matterId?: string | null): Promise<RoutingGap | null> {
  const g = (await get(COLLECTIONS.routingGaps, gapIdFor(clientId, matterId)).catch(() => null)) as RoutingGap | null;
  if (g?.status === "open") return g;
  if (matterId) return null;
  const rows = (await query(COLLECTIONS.routingGaps, [{ field: "clientId", op: "EQUAL", value: clientId }]).catch(() => [])) as unknown as RoutingGap[];
  return rows.find((x) => x.status === "open") ?? null;
}

/**
 * Nobody passes: one gap per member and matter. The first time: staff bell +
 * email, a CSM task, the member notice email and a sales call. Later attempts
 * only update the gap.
 */
export async function handleNoMatch(d: Decided): Promise<RoutingGap> {
  const clientId = d.clientId;
  const matterId = d.matter?.id;
  const id = gapIdFor(clientId, matterId);
  const now = new Date().toISOString();
  const existing = (await get(COLLECTIONS.routingGaps, id).catch(() => null)) as RoutingGap | null;
  const reason = d.decision.noMatchReason ?? "No lawyer passes the checks.";
  if (existing?.status === "open") {
    const upd = { reason, updatedAt: now, attempts: (existing.attempts ?? 0) + 1 };
    await put(COLLECTIONS.routingGaps, id, upd);
    return { ...existing, ...upd };
  }
  const req = d.decision.request;
  const placeholder = d.request.placeholder;
  const gap: RoutingGap = {
    id,
    clientId,
    ...(matterId ? { matterId } : {}),
    country: req.country,
    area: req.area,
    specialtyId: req.specialtyId,
    status: "open",
    reason,
    createdAt: now,
    updatedAt: now,
    attempts: 1,
    ...(placeholder ? { placeholder: true } : {}),
  };
  await put(COLLECTIONS.routingGaps, id, gap as unknown as Doc);

  const p = profileRecord(d.client);
  const memberName = d.request.memberName ?? str(p.email) ?? clientId;
  const countryName = COUNTRIES[req.country]?.name ?? req.country;
  const need = (req.specialtyId ? d.specialties.find((s) => s.id === req.specialtyId)?.label : null) ?? areaLabel(req.area);
  const link = `/dashboard/members/${encodeURIComponent(clientId)}`;
  await notifyStaff({
    key: id,
    kind: "routing.no_match",
    title: `Missing specialty for an assignment: ${countryName} · ${need} · ${memberName}`,
    body: `${reason} The member was told we are arranging their lawyer, and a short call with the sales team is being set up. Add or update a lawyer who covers this, or assign one by hand from the member page.`,
    link,
    clientId,
    matterId,
    placeholder,
  });
  const taskIds = await emitEvent("routing.no_match", {
    clientId,
    matterId,
    sourceId: matterId ?? clientId,
    sourceKind: matterId ? "manual" : "membership",
    dedupeKey: id,
    detail: `${countryName} · ${need} · ${memberName}`,
  }).catch(() => [] as string[]);

  const sales = await bookSalesCall(clientId, gap, d).catch((err) => {
    log(`[routing] sales call for ${clientId} failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  });
  const memberEmail = str(p.email);
  if (memberEmail) {
    const mail = arrangingLawyerEmail({
      firstName: str(p.preferredName) ?? str(p.name) ?? str(p.fullName)?.split(" ")[0] ?? undefined,
      country: countryName,
      salesWhen: sales ? whenLabel(sales.scheduledAt, personTimeZone(p)) : null,
      portalUrl: memberHomeUrl(),
    });
    await enqueueEmail({ to: memberEmail, ...mail, placeholder }, `routing_arranging_${id}`).catch(() => undefined);
  }
  const fields = { ...(taskIds[0] ? { taskId: taskIds[0] } : {}), ...(sales ? { salesConsultationId: sales.id } : {}), clientNotifiedAt: now };
  await put(COLLECTIONS.routingGaps, id, fields);
  log(`[routing] no match for ${clientId}${matterId ? `/${matterId}` : ""}: ${reason}`);
  return { ...gap, ...(sales ? { salesConsultationId: sales.id } : {}) };
}

/** A gap closed by a match: member assigned and emailed, task done, staff told. */
/**
 * COMMS-P5: true when the member's first-lawyer email (closingLoops
 * `lawyer_assigned_<clientId>`) was queued at or after `since`.
 */
export async function firstLawyerEmailSince(clientId: string, since: string | undefined): Promise<boolean> {
  const q = (await get("email_queue", `dedupe_${queueKey(`lawyer_assigned_${clientId}`)}`).catch(() => null)) as Doc | null;
  if (!q) return false;
  const at = Date.parse(String(q.createdAt ?? ""));
  const from = Date.parse(String(since ?? ""));
  return !Number.isFinite(from) || (Number.isFinite(at) && at >= from);
}

async function resolveGap(gap: RoutingGap, providerId: string, d: Decided): Promise<void> {
  const now = new Date().toISOString();
  await put(COLLECTIONS.routingGaps, gap.id, { status: "resolved", resolvedAt: now, resolvedProviderId: providerId, updatedAt: now });
  const lawyer = (await get("providers", providerId).catch(() => null)) as Doc | null;
  const lawyerName = str(lawyer?.name) ?? "your lawyer";
  const taskId = taskIdFor("routing.no_match", { clientId: gap.clientId, dedupeKey: gap.id });
  const task = await getRecord<CsmTask>(COLLECTIONS.csmTasks, taskId).catch(() => null);
  if (task && task.status === "open") {
    await updateRecord(COLLECTIONS.csmTasks, taskId, { status: "done", outcome: `Lawyer assigned automatically: ${lawyerName}`, closedAt: now }).catch(() => null);
  }
  const p = profileRecord(d.client);
  const countryName = COUNTRIES[gap.country]?.name ?? gap.country;
  const email = str(p.email);
  // COMMS-P5: assignMember already told the member about their first lawyer
  // ("<name> is your ILP lawyer") since this gap opened: no second email.
  if (email && !(await firstLawyerEmailSince(gap.clientId, gap.createdAt))) {
    const mail = lawyerAssignedEmail({
      firstName: str(p.preferredName) ?? str(p.name) ?? str(p.fullName)?.split(" ")[0] ?? undefined,
      lawyerName,
      country: countryName,
      bookUrl: `${frontendUrl()}/status/book`,
    });
    await enqueueEmail({ to: email, ...mail, placeholder: !!gap.placeholder }, `routing_assigned_${gap.id}`).catch(() => undefined);
  }
  await notifyStaff({
    key: `${gap.id}_resolved_${now.slice(0, 16)}`,
    kind: "routing.resolved",
    title: `Lawyer assigned: ${d.request.memberName ?? gap.clientId} now has ${lawyerName}`,
    body: `The member waited since ${gap.createdAt.slice(0, 10)}. They were emailed to book their call.`,
    link: `/dashboard/members/${encodeURIComponent(gap.clientId)}`,
    clientId: gap.clientId,
    matterId: gap.matterId,
    placeholder: !!gap.placeholder,
    email: false,
  });
  await auditLog({ actor: { uid: "system", email: "system", role: "system" }, action: "routing.gap_resolved", target: `routing_gaps/${gap.id}`, meta: { clientId: gap.clientId, providerId } }).catch(() => undefined);
}

/**
 * Retry every open gap (the sweep job, and right after a lawyer or specialty
 * changes). Returns how many resolved and how many stay open.
 */
export async function rerouteOpenGaps(trigger: RoutingTrigger = "sweep"): Promise<{ resolved: number; open: number }> {
  const gaps = ((await query(COLLECTIONS.routingGaps, [{ field: "status", op: "EQUAL", value: "open" }]).catch(() => [])) as unknown as RoutingGap[])
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  let resolved = 0;
  for (const g of gaps) {
    try {
      const r = await routeAndAssign(g.clientId, { matterId: g.matterId, trigger });
      if (r.providerId) resolved++;
    } catch (err) {
      log(`[routing] reroute ${g.id} failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }
  return { resolved, open: gaps.length - resolved };
}

/** Fire-and-forget reroute after a lawyer or specialty change. */
export function rerouteSoon(why: string): void {
  rerouteOpenGaps("sweep")
    .then((r) => { if (r.resolved) log(`[routing] ${why}: ${r.resolved} waiting member(s) assigned`); })
    .catch((err) => log(`[routing] reroute after ${why} failed: ${err instanceof Error ? err.message : err}`, "error"));
}

// ─── Sales call ────────────────────────────────────────────────────────────

/** Sales hours: lawyer_availability/ilp_sales, else weekdays 08:00-17:00 Costa Rica with 4 hours' notice. */
export async function salesAvailability() {
  const doc = (await get(COLLECTIONS.availability, SALES_TEAM_ID).catch(() => null)) as Doc | null;
  if (doc) return await loadAvailability(SALES_TEAM_ID);
  return { ...defaultAvailability(SALES_TEAM_ID), minLeadHours: 4, maxCallsPerDay: 12, isDefault: true, calendarId: null };
}

/** Free sales start times for the next 14 days. */
export async function salesSlots(now = new Date()): Promise<string[]> {
  const a = await salesAvailability();
  const held = (await findRecords<Consultation>(COLLECTIONS.consultations, { providerId: SALES_TEAM_ID }).catch(() => [] as Consultation[]))
    .filter((c) => c.status !== "cancelled");
  return buildSlots({ now, availability: a, booked: held, days: 14, lengthMin: SALES_CALL_LENGTH_MIN });
}

/**
 * Book the first free sales slot for the member (kind "sales", never charged),
 * with a Meet invitation to the member and the sales inbox. No free slot: a
 * "sales.call_unscheduled" task for the sales inbox. Either way the sales
 * inbox gets an email with the member's basics.
 */
export async function bookSalesCall(clientId: string, gap: RoutingGap, d: Decided): Promise<Consultation | null> {
  // One sales call per member while it is upcoming.
  const mine = await findRecords<Consultation>(COLLECTIONS.consultations, { clientId, providerId: SALES_TEAM_ID }).catch(() => [] as Consultation[]);
  const upcoming = mine.find((c) => c.status === "booked" && Date.parse(c.scheduledAt) > Date.now());
  if (upcoming) return upcoming;
  const p = profileRecord(d.client);
  const placeholder = d.request.placeholder;
  const inbox = salesEmails();
  const countryName = COUNTRIES[gap.country]?.name ?? gap.country;
  const need = (gap.specialtyId ? d.specialties.find((s) => s.id === gap.specialtyId)?.label : null) ?? areaLabel(gap.area);
  const memberName = d.request.memberName ?? str(p.email) ?? clientId;
  const question = d.matter?.question ?? d.matter?.title ?? null;
  const baseId = newId(COLLECTIONS.consultations);
  const id = placeholder || isPlaceholderId(clientId) ? `${PLACEHOLDER_PREFIX}${baseId}` : baseId;

  const created = await withLawyerSlots(SALES_TEAM_ID, async () => {
    for (const iso of (await salesSlots()).slice(0, 10)) {
      if (!(await claimSlot(SALES_TEAM_ID, iso, id))) continue;
      return await createRecord<Consultation>(COLLECTIONS.consultations, withDefaults("consultations", {
        id,
        clientId,
        ...(d.matter?.id ? { matterId: d.matter.id } : {}),
        providerId: SALES_TEAM_ID,
        kind: "sales",
        salesEmail: inbox[0],
        scheduledAt: iso,
        durationMin: SALES_CALL_LENGTH_MIN,
        question: `Short call with the ILP team while we arrange a lawyer (${countryName}, ${need}).`,
        bookedBy: "system",
        consent: { recording: "declined", at: new Date().toISOString(), by: "system", where: "sales_call" },
        ...(placeholder ? { placeholder: true } : {}),
      }) as unknown as Consultation);
    }
    return null;
  });

  const memberUrl = `${frontendUrl()}/dashboard/members/${encodeURIComponent(clientId)}`;
  if (!created) {
    await emitEvent("sales.call_unscheduled", { clientId, matterId: d.matter?.id, sourceId: gap.id, dedupeKey: gap.id, ownerEmail: inbox[0], detail: memberName }).catch(() => []);
    const mail = salesCallEmail({ booked: false, memberName, memberEmail: str(p.email), memberPhone: str(p.phone), country: countryName, need, question, when: null, meetUrl: null, memberUrl });
    await enqueueEmail({ to: inbox.join(", "), ...mail, placeholder }, `sales_unscheduled_${gap.id}`).catch(() => undefined);
    return null;
  }

  let meetUrl: string | null = null;
  if (placeholder || isPlaceholderDoc(created)) {
    meetUrl = placeholderMeetUrl(created.id);
    await updateRecord(COLLECTIONS.consultations, created.id, { meetUrl });
  } else {
    try {
      const ev = await createCalendarEvent({
        slot: { start: created.scheduledAt, end: new Date(Date.parse(created.scheduledAt) + SALES_CALL_LENGTH_MIN * 60_000).toISOString(), timezone: "America/Costa_Rica" },
        title: `ILP: short call with ${memberName}`,
        description: `A short call with the ILP team while we arrange a lawyer for the member. It does not use membership minutes.\nMember home: ${memberHomeUrl()}`,
        attendees: [str(p.email), ...inbox].filter((e): e is string => !!e),
        requestId: created.id,
        privateProps: { consultationId: created.id, clientId, kind: "sales" },
      });
      meetUrl = ev.meetUrl ?? null;
      await updateRecord(COLLECTIONS.consultations, created.id, { calendarEventId: ev.eventId ?? null, meetUrl, calendarError: meetUrl ? null : "no_meet_link" });
      if (!meetUrl) await flagCalendarProblem(created as CallRecord, memberName, "no Meet link on the sales call");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[routing] sales calendar event for ${created.id} failed: ${msg}`, "error");
      await updateRecord(COLLECTIONS.consultations, created.id, { calendarError: msg.slice(0, 300) });
      await flagCalendarProblem(created as CallRecord, memberName, "sales call invite failed");
    }
  }
  const mail = salesCallEmail({
    booked: true,
    memberName,
    memberEmail: str(p.email),
    memberPhone: str(p.phone),
    country: countryName,
    need,
    question,
    when: whenLabel(created.scheduledAt, "America/Costa_Rica"),
    meetUrl,
    memberUrl,
  });
  await enqueueEmail({ to: inbox.join(", "), ...mail, placeholder }, `sales_booked_${created.id}`).catch(() => undefined);
  await auditLog({ actor: { uid: "system", email: "system", role: "system" }, action: "routing.sales_call_booked", target: `consultations/${created.id}`, meta: { clientId, gapId: gap.id, scheduledAt: created.scheduledAt } }).catch(() => undefined);
  return { ...created, meetUrl: meetUrl ?? undefined };
}

// ─── Member view ───────────────────────────────────────────────────────────

/** What /status shows about the member's lawyer: assigned, or being arranged (with the sales call). */
export async function memberLawyerMatch(clientId: string): Promise<{
  status: "assigned" | "arranging" | "none";
  lawyerName?: string | null;
  salesCall?: { id: string; scheduledAt: string; meetUrl: string | null; durationMin: number } | null;
}> {
  const gap = await openGapFor(clientId, null);
  if (gap) {
    const calls = await findRecords<Consultation>(COLLECTIONS.consultations, { clientId, providerId: SALES_TEAM_ID }).catch(() => [] as Consultation[]);
    const next = calls.filter((c) => c.status === "booked" && Date.parse(c.scheduledAt) > Date.now() - 30 * 60_000)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
    return {
      status: "arranging",
      salesCall: next ? { id: next.id, scheduledAt: next.scheduledAt, meetUrl: next.meetUrl ?? null, durationMin: next.durationMin || SALES_CALL_LENGTH_MIN } : null,
    };
  }
  const client = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
  const id = str(client?.assignedProviderId);
  if (!id) return { status: "none" };
  const p = (await get("providers", id).catch(() => null)) as Doc | null;
  return { status: "assigned", lawyerName: str(p?.name) };
}

/** Calm notice for the member while no lawyer matches. */
export const arrangingNotice = (country: CountryCode) =>
  `We are arranging a lawyer licensed in ${COUNTRIES[country]?.name ?? country} for your question. We will email you as soon as they are confirmed.`;
