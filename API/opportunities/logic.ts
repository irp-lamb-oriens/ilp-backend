/**
 * API/opportunities/logic.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Pure rules for opportunities (paid legal work beyond the membership; master
 * plan sections 15 and 17.1). No Firestore here, so every rule is unit tested
 * in opportunities_test.ts.
 *
 * Stages: identified → quoted → negotiating → won | lost.
 *  - Any open stage can move to any other stage.
 *  - won and lost need an outcome (what happened, in words).
 *  - A closed opportunity can only be reopened to "negotiating".
 *  - Every opportunity has a member (clientId) and a source, so none is orphaned.
 *
 * Value (valueCents) is estimated legal fees: legal GMV, never platform
 * revenue. Opportunities are staff-only; no lawyer or client route reads them.
 */

import { type Opportunity, type OpportunityStage, TASK_RULES } from "../../schemas/contracts.ts";
import { isQuoteAccepted, quoteAcceptedAt, quoteCents, quoteIdOf } from "../dashboard/staffHome/compute.ts";

type Doc = Record<string, unknown>;

export const STAGES: OpportunityStage[] = ["identified", "quoted", "negotiating", "won", "lost"];
export const OPEN_STAGES: OpportunityStage[] = ["identified", "quoted", "negotiating"];
export const CLOSED_STAGES: OpportunityStage[] = ["won", "lost"];
export const SOURCE_KINDS: Opportunity["source"]["kind"][] = ["handoff", "consultation", "obligation", "manual"];

export const isStage = (v: unknown): v is OpportunityStage => typeof v === "string" && (STAGES as string[]).includes(v);
export const isClosed = (stage: OpportunityStage) => stage === "won" || stage === "lost";

const MIN_OUTCOME = 3;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export class OpportunityError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Deterministic id for the opportunity a handoff produces (one per handoff). */
export function opportunityIdForHandoff(handoffId: string): string {
  return `opp_hof_${handoffId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
}

export function newOpportunityId(): string {
  return `opp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Integer cents ≥ 0, or undefined when absent. Throws on anything else. */
export function parseValueCents(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new OpportunityError("valueCents must be a whole number of cents, 0 or more.");
  }
  return n;
}

function parseNextAction(v: unknown): Opportunity["nextAction"] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") throw new OpportunityError("nextAction must be { what, dueAt? }.");
  const what = str((v as Doc).what);
  const dueAt = str((v as Doc).dueAt);
  if (!what) return undefined;
  if (dueAt && Number.isNaN(Date.parse(dueAt))) throw new OpportunityError("nextAction.dueAt must be a date.");
  return dueAt ? { what, dueAt } : { what };
}

export interface CreateInput {
  clientId?: unknown;
  matterId?: unknown;
  source?: unknown;
  title?: unknown;
  area?: unknown;
  stage?: unknown;
  valueCents?: unknown;
  providerId?: unknown;
  ownerEmail?: unknown;
  nextAction?: unknown;
  outcome?: unknown;
}

/**
 * Validate a create body and build the record. `defaultOwner` is the
 * membership's CSM (or the acting staff member) when the body names none.
 */
export function buildOpportunity(input: CreateInput, opts: { now?: Date; defaultOwner?: string; id?: string } = {}): Opportunity {
  const now = (opts.now ?? new Date()).toISOString();
  const clientId = str(input.clientId);
  if (!clientId) throw new OpportunityError("clientId is required: every opportunity belongs to a member.");
  const title = str(input.title);
  if (!title) throw new OpportunityError("title is required.");
  if (title.length > 160) throw new OpportunityError("Keep the title under 160 characters.");
  const src = (input.source ?? null) as Doc | null;
  const kind = src && typeof src === "object" ? str(src.kind) : "";
  if (!kind) throw new OpportunityError("source is required (handoff, consultation, obligation or manual).");
  if (!(SOURCE_KINDS as string[]).includes(kind)) throw new OpportunityError(`Unknown source kind "${kind}".`);
  const sourceId = str(src?.id);
  if (kind !== "manual" && !sourceId) throw new OpportunityError(`source.id is required for a ${kind} source.`);
  const stage = input.stage === undefined ? "identified" : input.stage;
  if (!isStage(stage)) throw new OpportunityError(`Unknown stage "${String(stage)}".`);
  const outcome = str(input.outcome);
  if (isClosed(stage) && outcome.length < MIN_OUTCOME) throw new OpportunityError(`An outcome is required to mark an opportunity ${stage}.`);

  const opp: Opportunity = {
    id: opts.id ?? newOpportunityId(),
    clientId,
    source: sourceId ? { kind: kind as Opportunity["source"]["kind"], id: sourceId } : { kind: kind as Opportunity["source"]["kind"] },
    title,
    area: str(input.area) || "general",
    stage,
    createdAt: now,
    updatedAt: now,
  };
  const matterId = str(input.matterId);
  if (matterId) opp.matterId = matterId;
  const value = parseValueCents(input.valueCents);
  if (value !== undefined) opp.valueCents = value;
  const providerId = str(input.providerId);
  if (providerId) opp.providerId = providerId;
  const owner = (str(input.ownerEmail) || opts.defaultOwner || "").trim().toLowerCase();
  if (owner) opp.ownerEmail = owner;
  const next = parseNextAction(input.nextAction);
  if (next) opp.nextAction = next;
  if (isClosed(stage)) {
    opp.outcome = outcome;
    opp.closedAt = now;
  }
  return opp;
}

/** Fields staff may edit with PATCH (stage has its own route). */
export const EDITABLE_FIELDS = ["title", "area", "valueCents", "providerId", "ownerEmail", "nextAction", "matterId"] as const;

/** Apply a PATCH body. Empty strings / null clear optional fields. Returns the new record. */
export function applyEdit(opp: Opportunity, body: Doc, now = new Date()): Opportunity {
  const next: Opportunity = { ...opp };
  for (const key of EDITABLE_FIELDS) {
    if (!(key in body)) continue;
    const v = body[key];
    switch (key) {
      case "title": {
        const t = str(v);
        if (!t) throw new OpportunityError("title cannot be empty.");
        if (t.length > 160) throw new OpportunityError("Keep the title under 160 characters.");
        next.title = t;
        break;
      }
      case "area":
        next.area = str(v) || "general";
        break;
      case "valueCents": {
        const c = parseValueCents(v);
        if (c === undefined) delete next.valueCents;
        else next.valueCents = c;
        break;
      }
      case "nextAction": {
        const a = parseNextAction(v);
        if (a) next.nextAction = a;
        else delete next.nextAction;
        break;
      }
      case "ownerEmail": {
        const o = str(v).toLowerCase();
        if (o) next.ownerEmail = o;
        else delete next.ownerEmail;
        break;
      }
      default: {
        const s = str(v);
        if (s) next[key] = s;
        else delete next[key];
      }
    }
  }
  next.updatedAt = now.toISOString();
  return next;
}

/**
 * Move to a stage. Throws an OpportunityError (400/409) when the move breaks
 * a rule. Returns the record to store.
 */
export function moveStage(opp: Opportunity, to: unknown, outcomeIn: unknown, now = new Date()): Opportunity {
  if (!isStage(to)) throw new OpportunityError(`Unknown stage "${String(to)}".`);
  if (to === opp.stage) throw new OpportunityError(`The opportunity is already ${to}.`, 409);
  const iso = now.toISOString();
  const outcome = str(outcomeIn);
  if (isClosed(opp.stage) && to !== "negotiating") {
    throw new OpportunityError(`A ${opp.stage} opportunity can only be reopened to negotiating.`, 409);
  }
  const next: Opportunity = { ...opp, stage: to, updatedAt: iso };
  if (isClosed(to)) {
    if (outcome.length < MIN_OUTCOME) throw new OpportunityError(`An outcome is required to mark an opportunity ${to}.`);
    next.outcome = outcome;
    next.closedAt = iso;
  } else {
    // Reopening keeps the old outcome out of the open record.
    delete next.outcome;
    delete next.closedAt;
  }
  return next;
}

// ─── Quotes (embedded on the clients doc) ─────────────────────────────────

export function findQuote(client: Doc | null | undefined, quoteId: string): Doc | undefined {
  const quotes = Array.isArray(client?.quotes) ? (client!.quotes as Doc[]) : [];
  return quotes.find((q) => quoteIdOf(q) === quoteId);
}

/** Link a quote: sets quoteId and moves identified → quoted. Never moves a later stage back. */
export function linkQuote(opp: Opportunity, quote: Doc, now = new Date()): Opportunity {
  const id = quoteIdOf(quote);
  if (!id) throw new OpportunityError("The quote has no id.");
  if (isClosed(opp.stage)) throw new OpportunityError(`A ${opp.stage} opportunity cannot take a new quote. Reopen it first.`, 409);
  const next: Opportunity = { ...opp, quoteId: id, updatedAt: now.toISOString() };
  if (opp.stage === "identified") next.stage = "quoted";
  if (next.valueCents === undefined) {
    const c = quoteCents(quote);
    if (c > 0) next.valueCents = c;
  }
  return reconcileWithQuote(next, quote, now) ?? next;
}

/**
 * Keep an opportunity in step with its linked quote. Returns the updated
 * record, or null when nothing changes:
 *  - the member accepted the quote → won (outcome filled in, closedAt = acceptance time);
 *  - an identified opportunity with a linked quote → quoted.
 * A rejected quote does not close the opportunity: the CSM decides.
 */
export function reconcileWithQuote(opp: Opportunity, quote: Doc | undefined, now = new Date()): Opportunity | null {
  if (!quote || !opp.quoteId || quoteIdOf(quote) !== opp.quoteId || isClosed(opp.stage)) return null;
  if (isQuoteAccepted(quote)) {
    const at = quoteAcceptedAt(quote) || now.toISOString();
    const title = str(quote.title);
    const out: Opportunity = {
      ...opp,
      stage: "won",
      outcome: `Member accepted the quote${title ? ` "${title}"` : ""}.`,
      closedAt: at,
      updatedAt: now.toISOString(),
    };
    const c = quoteCents(quote);
    if (c > 0) out.valueCents = c;
    return out;
  }
  if (opp.stage === "identified") return { ...opp, stage: "quoted", updatedAt: now.toISOString() };
  return null;
}

/** Platform revenue on an accepted quote, in cents: ILP's earnings line, else total − cost. */
export function quotePlatformCents(q: Doc): number {
  if (typeof q.earnings === "number") return Math.round(q.earnings * 100);
  if (typeof q.total === "number" && typeof q.costSubtotal === "number") return Math.round((q.total - q.costSubtotal) * 100);
  return 0;
}

// ─── Handoff → opportunity ────────────────────────────────────────────────

/** True when a handoff write should produce an opportunity: commercial notes appear (on create or later). */
export function handoffNeedsOpportunity(before: Doc | null, after: Doc): boolean {
  const had = str(before?.commercialNotes);
  const has = str(after.commercialNotes);
  return Boolean(has && !had && str(after.clientId) && str(after.id));
}

/** First sentence or line of the notes, at most 80 characters ("S.A." does not end a sentence). */
export function titleFromNotes(notes: string): string {
  const first = notes.trim().split(/\r?\n/)[0].split(/(?<=[a-z0-9)][.!?])\s+(?=[A-Z])/)[0].trim().replace(/[.\s]+$/, "");
  const t = first || notes.trim();
  return t.length > 80 ? `${t.slice(0, 77).trimEnd()}…` : t;
}

/** The opportunity a handoff with commercial notes produces. Pure; owner and area are resolved by the caller. */
export function opportunityFromHandoff(
  handoff: Doc,
  opts: { ownerEmail?: string; area?: string; now?: Date } = {},
): Opportunity | null {
  const notes = str(handoff.commercialNotes);
  const clientId = str(handoff.clientId);
  const hid = str(handoff.id);
  if (!notes || !clientId || !hid) return null;
  const now = opts.now ?? new Date();
  const rule = TASK_RULES["handoff.opportunity"];
  return buildOpportunity(
    {
      clientId,
      matterId: str(handoff.matterId) || undefined,
      source: { kind: "handoff", id: hid },
      title: titleFromNotes(notes),
      area: opts.area,
      providerId: str(handoff.providerId) || undefined,
      ownerEmail: opts.ownerEmail,
      nextAction: { what: rule.title, dueAt: new Date(now.getTime() + rule.dueInHours * 3_600_000).toISOString() },
    },
    { now, id: opportunityIdForHandoff(hid) },
  );
}

// ─── Lists and summary ────────────────────────────────────────────────────

export interface ListFilter {
  stage?: string;
  ownerEmail?: string;
  area?: string;
  clientId?: string;
  matterId?: string;
  q?: string;
  /** Default true for the board; the list can hide closed ones. */
  includeClosed?: boolean;
}

export function filterOpportunities(items: Opportunity[], f: ListFilter, names: Map<string, string> = new Map()): Opportunity[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return items.filter((o) => {
    if (f.stage && o.stage !== f.stage) return false;
    if (f.ownerEmail && (o.ownerEmail ?? "").toLowerCase() !== f.ownerEmail.toLowerCase()) return false;
    if (f.area && o.area !== f.area) return false;
    if (f.clientId && o.clientId !== f.clientId) return false;
    if (f.matterId && o.matterId !== f.matterId) return false;
    if (f.includeClosed === false && isClosed(o.stage)) return false;
    if (q) {
      const hay = `${o.title} ${o.area} ${names.get(o.clientId) ?? ""} ${o.ownerEmail ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface OpportunitySummary {
  byStage: Record<OpportunityStage, { count: number; valueCents: number }>;
  open: { count: number; valueCents: number };
  /** won / (won + lost), percent with one decimal; null with nothing closed. */
  winRate: number | null;
  /** Mean days from createdAt to closedAt over won opportunities; null when none. */
  avgDaysToWin: number | null;
  /** Mean days to close over won and lost together; null when none closed. */
  avgDaysToClose: number | null;
  /** Legal fees on won work (GMV). Not ILP revenue. */
  legalGmvWonCents: number;
  /** ILP's share on accepted, linked quotes (earnings line). Reported apart from GMV. */
  platformRevenueCents: number;
}

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Summary strip. `quotes` maps quoteId → quote for the linked ones (for platform revenue). */
export function summarize(items: Opportunity[], quotes: Map<string, Doc> = new Map()): OpportunitySummary {
  const byStage = Object.fromEntries(STAGES.map((s) => [s, { count: 0, valueCents: 0 }])) as OpportunitySummary["byStage"];
  let wonDays = 0;
  let wonN = 0;
  let closedDays = 0;
  let closedN = 0;
  let platform = 0;
  for (const o of items) {
    const b = byStage[o.stage];
    if (!b) continue;
    b.count++;
    b.valueCents += o.valueCents ?? 0;
    if (isClosed(o.stage) && o.closedAt) {
      const d = (Date.parse(o.closedAt) - Date.parse(o.createdAt)) / DAY;
      if (Number.isFinite(d) && d >= 0) {
        closedDays += d;
        closedN++;
        if (o.stage === "won") {
          wonDays += d;
          wonN++;
        }
      }
    }
    if (o.stage === "won" && o.quoteId) {
      const q = quotes.get(o.quoteId);
      if (q && isQuoteAccepted(q)) platform += quotePlatformCents(q);
    }
  }
  const won = byStage.won.count;
  const lost = byStage.lost.count;
  const open = OPEN_STAGES.reduce((acc, s) => ({ count: acc.count + byStage[s].count, valueCents: acc.valueCents + byStage[s].valueCents }), { count: 0, valueCents: 0 });
  return {
    byStage,
    open,
    winRate: won + lost ? round1((won / (won + lost)) * 100) : null,
    avgDaysToWin: wonN ? round1(wonDays / wonN) : null,
    avgDaysToClose: closedN ? round1(closedDays / closedN) : null,
    legalGmvWonCents: byStage.won.valueCents,
    platformRevenueCents: platform,
  };
}
