/**
 * API/lawyerComms/offers.ts — paid work offered to lawyers in its specialty (COMMS-P2).
 * ──────────────────────────────────────────────────────────────────────────
 * Staff offer an open opportunity (paid legal work beyond the membership) to
 * the lawyers who fit: approved and switched on, licensed in the matter's
 * country, taking the work's area. Each gets an email and a row on the
 * portal's New work page with Accept and Decline. The first to accept takes
 * it: the opportunity gets their providerId, the other offers turn "taken",
 * staff are alerted (bell and email) to introduce the lawyer to the member.
 *
 * Lawyers see only the title, area, country, the staff-written description
 * and dates: never the member's name, the estimated value or other lawyers.
 */

import getAll from "../../db/getAll.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import get from "../../db/get.ts";
import auditLog from "../../helper/auditLog.ts";
import log from "../../helper/log.ts";
import { isPlaceholderId } from "../../helper/placeholder.ts";
import {
  AREA_GROUPS,
  COLLECTIONS,
  COUNTRIES,
  type CountryCode,
  type Matter,
  type Opportunity,
  toAreaGroup,
  toCountryCode,
  type WorkOffer,
} from "../../schemas/contracts.ts";
import { getOpportunity, saveOpportunity } from "../opportunities/store.ts";
import { isClosed } from "../opportunities/logic.ts";
import { lawyerFacts } from "../routing/service.ts";
import { loadSpecialties } from "../routing/specialties.ts";
import { notifyStaff } from "../routing/notifications.ts";
import { memberCountry } from "../calls/callService.ts";
import { workOfferEmail } from "./emails.ts";
import { lawyerContact, lawyerUrl, sendLawyerOnce } from "./notify.ts";

type Doc = Record<string, unknown>;
const DAY = 86_400_000;
const str = (v: unknown, max = 600) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);

export const offerIdFor = (opportunityId: string, providerId: string) =>
  `${isPlaceholderId(opportunityId) ? "ph_" : ""}wof_${opportunityId.replace(/^ph_/, "")}_${providerId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 300);

export class OfferError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const areaLabelOf = (area: string) => AREA_GROUPS.find((g) => g.id === toAreaGroup(area))?.label ?? (area || "General legal work");

/** The country of the work: the matter's, else the member's. */
async function workCountry(opp: Opportunity): Promise<CountryCode> {
  if (opp.matterId) {
    const m = (await get(COLLECTIONS.matters, opp.matterId).catch(() => null)) as Matter | null;
    const c = toCountryCode(m?.country);
    if (c) return c;
  }
  return await memberCountry(opp.clientId);
}

export interface Candidate {
  providerId: string;
  name: string;
}

/** Pure: lawyers who fit work in `country` and `area` (null area = any). Seed lawyers only for seed work. */
export function fitsWork(f: ReturnType<typeof lawyerFacts>, country: CountryCode, area: string | null, seedWork: boolean): boolean {
  if (!f.bookable || f.routingStatus === "onboarding") return false;
  if (f.placeholder !== seedWork) return false;
  if (!f.verifiedCountries.includes(country)) return false;
  return !area || f.areas.includes(area as never);
}

export async function candidatesFor(opp: Opportunity): Promise<{ country: CountryCode; area: string | null; candidates: Candidate[] }> {
  const [country, providers, availability, specialties] = await Promise.all([
    workCountry(opp),
    getAll("providers").catch(() => []) as Promise<Doc[]>,
    getAll(COLLECTIONS.availability).catch(() => []) as Promise<Doc[]>,
    loadSpecialties(),
  ]);
  const area = toAreaGroup(opp.area);
  const availBy = new Map(availability.map((a) => [String(a.providerId ?? a.id), a]));
  const candidates = providers
    .map((p) => lawyerFacts(p, availBy.get(String(p.id)) ?? null, specialties))
    .filter((f) => f.providerId && fitsWork(f, country, area, isPlaceholderId(opp.id) || isPlaceholderId(opp.clientId)))
    .map((f) => ({ providerId: f.providerId, name: f.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { country, area, candidates };
}

export async function offersFor(opportunityId: string): Promise<WorkOffer[]> {
  return ((await query(COLLECTIONS.workOffers, [{ field: "opportunityId", op: "EQUAL", value: opportunityId }]).catch(() => [])) as unknown as WorkOffer[])
    .sort((a, b) => String(a.offeredAt).localeCompare(String(b.offeredAt)));
}

/**
 * Offer the opportunity to `providerIds` (default: every fitting lawyer).
 * Lawyers already offered are skipped. Returns the new offers.
 */
export async function offerOpportunity(
  opportunityId: string,
  actor: string,
  body: { providerIds?: unknown; description?: unknown; respondInDays?: unknown } = {},
  now = new Date(),
): Promise<{ offers: WorkOffer[]; skipped: string[] }> {
  const opp = await getOpportunity(opportunityId);
  if (!opp) throw new OfferError("Opportunity not found.", 404);
  if (isClosed(opp.stage)) throw new OfferError("This opportunity is closed. Reopen it before offering it.", 409);
  if (opp.providerId) throw new OfferError("A lawyer already has this work. Clear the lawyer on the opportunity to offer it again.", 409);
  const { country, candidates } = await candidatesFor(opp);
  const fit = new Set(candidates.map((c) => c.providerId));
  const asked = Array.isArray(body.providerIds) ? (body.providerIds as unknown[]).filter((x): x is string => typeof x === "string") : null;
  const notFit = (asked ?? []).filter((id) => !fit.has(id));
  if (asked && notFit.length) throw new OfferError("Some lawyers do not fit this work (country licence or area). Choose from the list.", 400);
  const targets = asked ?? [...fit];
  if (!targets.length) throw new OfferError(`No active lawyer licensed in ${COUNTRIES[country].name} takes ${areaLabelOf(opp.area).toLowerCase()} work yet.`, 409);
  const days = typeof body.respondInDays === "number" && body.respondInDays >= 1 && body.respondInDays <= 14 ? Math.round(body.respondInDays) : 3;
  const description = str(body.description);
  const existing = new Set((await offersFor(opp.id)).map((o) => o.providerId));
  const offers: WorkOffer[] = [];
  const skipped: string[] = [];
  for (const pid of targets) {
    if (existing.has(pid)) {
      skipped.push(pid);
      continue;
    }
    const offer: WorkOffer = {
      id: offerIdFor(opp.id, pid),
      opportunityId: opp.id,
      providerId: pid,
      clientId: opp.clientId,
      title: opp.title,
      area: opp.area,
      country,
      ...(description ? { description } : {}),
      status: "offered",
      offeredAt: now.toISOString(),
      offeredBy: actor,
      respondBy: new Date(now.getTime() + days * DAY).toISOString(),
      ...(isPlaceholderId(opp.id) || isPlaceholderId(opp.clientId) ? { placeholder: true } : {}),
    };
    await put(COLLECTIONS.workOffers, offer.id, offer as unknown as Doc);
    offers.push(offer);
    const to = await lawyerContact(pid);
    if (to) {
      const mail = workOfferEmail({
        firstName: to.firstName,
        title: offer.title,
        area: areaLabelOf(offer.area),
        country: COUNTRIES[country].name,
        description: offer.description ?? null,
        respondBy: offer.respondBy ? new Date(offer.respondBy).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/Costa_Rica" }) : null,
        url: lawyerUrl("/work"),
      });
      await sendLawyerOnce(`work_offer_${offer.id}`, to, mail, !!offer.placeholder);
    }
  }
  await auditLog({ actor: { uid: actor, email: actor, role: "staff" }, action: "opportunity.offered", target: `opportunities/${opp.id}`, meta: { providerIds: offers.map((o) => o.providerId), skipped } }).catch(() => undefined);
  return { offers, skipped };
}

/** What a lawyer sees of one offer. */
export function lawyerOfferView(o: WorkOffer) {
  const cc = toCountryCode(o.country);
  return {
    id: o.id,
    title: o.title,
    area: o.area,
    areaLabel: areaLabelOf(o.area),
    country: o.country,
    countryName: cc ? COUNTRIES[cc].name : o.country,
    description: o.description ?? null,
    status: o.status,
    offeredAt: o.offeredAt,
    respondBy: o.respondBy ?? null,
    respondedAt: o.respondedAt ?? null,
  };
}

export async function offersForLawyer(providerId: string): Promise<ReturnType<typeof lawyerOfferView>[]> {
  const rows = (await query(COLLECTIONS.workOffers, [{ field: "providerId", op: "EQUAL", value: providerId }]).catch(() => [])) as unknown as WorkOffer[];
  return rows.sort((a, b) => String(b.offeredAt).localeCompare(String(a.offeredAt))).map(lawyerOfferView);
}

/** Accept or decline. First accept wins; a later accept gets 409 and its offer turns "taken". */
export async function respondToOffer(offerId: string, providerId: string, action: unknown, reasonIn?: unknown, now = new Date()): Promise<ReturnType<typeof lawyerOfferView>> {
  if (action !== "accept" && action !== "decline") throw new OfferError("Choose accept or decline.");
  const offer = (await get(COLLECTIONS.workOffers, offerId).catch(() => null)) as WorkOffer | null;
  if (!offer || offer.providerId !== providerId) throw new OfferError("Offer not found.", 404);
  if (offer.status !== "offered") throw new OfferError(offer.status === "taken" ? "Another lawyer already took this work." : "You already answered this offer.", 409);
  const at = now.toISOString();
  const lawyer = await lawyerContact(providerId);
  const lawyerName = lawyer?.name ?? providerId;
  if (action === "decline") {
    const reason = str(reasonIn, 300);
    const next: WorkOffer = { ...offer, status: "declined", respondedAt: at, ...(reason ? { declineReason: reason } : {}) };
    await put(COLLECTIONS.workOffers, offer.id, next as unknown as Doc);
    await auditLog({ actor: { uid: providerId, email: lawyer?.email ?? providerId, role: "lawyer" }, action: "work_offer.declined", target: `work_offers/${offer.id}`, meta: { opportunityId: offer.opportunityId, reason: reason ?? null } }).catch(() => undefined);
    const all = await offersFor(offer.opportunityId);
    if (all.length && all.every((o) => (o.id === offer.id ? "declined" : o.status) === "declined" || o.status === "withdrawn")) {
      await notifyStaff({ key: `work_declined_all_${offer.opportunityId}`, kind: "opportunity.declined_by_all", title: `Every lawyer offered "${offer.title}" declined it`, body: "Offer it to other lawyers, or find one outside the current list.", link: `/dashboard/opportunities?open=${encodeURIComponent(offer.opportunityId)}`, clientId: offer.clientId, placeholder: offer.placeholder });
    }
    return lawyerOfferView(next);
  }
  const opp = await getOpportunity(offer.opportunityId);
  if (!opp || isClosed(opp.stage) || (opp.providerId && opp.providerId !== providerId)) {
    await put(COLLECTIONS.workOffers, offer.id, { status: "taken", respondedAt: at });
    throw new OfferError("Another lawyer already took this work, or it was closed.", 409);
  }
  await saveOpportunity({
    ...opp,
    providerId,
    nextAction: { what: `Introduce ${lawyerName} to the member and ask for a quote`, dueAt: new Date(now.getTime() + DAY).toISOString() },
    updatedAt: at,
  });
  const next: WorkOffer = { ...offer, status: "accepted", respondedAt: at };
  await put(COLLECTIONS.workOffers, offer.id, next as unknown as Doc);
  for (const o of await offersFor(offer.opportunityId)) {
    if (o.id !== offer.id && o.status === "offered") await put(COLLECTIONS.workOffers, o.id, { status: "taken", respondedAt: at });
  }
  await auditLog({ actor: { uid: providerId, email: lawyer?.email ?? providerId, role: "lawyer" }, action: "work_offer.accepted", target: `work_offers/${offer.id}`, meta: { opportunityId: offer.opportunityId } }).catch(() => undefined);
  await notifyStaff({
    key: `work_accepted_${offer.opportunityId}`,
    kind: "opportunity.accepted",
    title: `${lawyerName} accepted "${offer.title}"`,
    body: "Introduce the lawyer to the member and assign them on the member's page if they will work together. The other lawyers were told it is taken.",
    link: `/dashboard/opportunities?open=${encodeURIComponent(offer.opportunityId)}`,
    clientId: offer.clientId,
    placeholder: offer.placeholder,
  });
  log(`[offers] ${offer.opportunityId} accepted by ${providerId}`);
  return lawyerOfferView(next);
}

/** Staff list for one opportunity: offers with lawyer names, and lawyers who fit and were not offered yet. */
export async function staffOffers(opportunityId: string) {
  const opp = await getOpportunity(opportunityId);
  if (!opp) throw new OfferError("Opportunity not found.", 404);
  const [offers, fit] = await Promise.all([offersFor(opportunityId), candidatesFor(opp)]);
  const names = new Map(fit.candidates.map((c) => [c.providerId, c.name]));
  for (const o of offers) {
    if (!names.has(o.providerId)) names.set(o.providerId, (await lawyerContact(o.providerId))?.name ?? o.providerId);
  }
  const offered = new Set(offers.map((o) => o.providerId));
  return {
    country: fit.country,
    countryName: COUNTRIES[fit.country].name,
    areaLabel: areaLabelOf(opp.area),
    offers: offers.map((o) => ({ ...lawyerOfferView(o), providerId: o.providerId, lawyerName: names.get(o.providerId) ?? o.providerId, declineReason: o.declineReason ?? null })),
    candidates: fit.candidates.filter((c) => !offered.has(c.providerId)),
  };
}
