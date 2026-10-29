/**
 * API/journeys/track.ts — link visitors to people, and record the funnel
 * steps that happen on the server.
 * ──────────────────────────────────────────────────────────────────────────
 * identify(): when an existing route creates a lead or account (free check,
 * claim, join, lawyer application), or a member's session posts events, the
 * browser's random visitorId is stored on the person's doc as `journeyTrack`
 * with the visitor's first-touch attribution, and their earlier events get
 * the clientId/leadId (so a deletion request finds them).
 *
 * trackServerStep(): account created, paid, profile ready, call booked/done,
 * handoff confirmed, paid work accepted, renewals, lawyer verified, outreach
 * sent/opened/clicked. One event per person per step (deterministic id, so a
 * retry or a second emit is a no-op), under the person's visitorId (or a
 * hashed synthetic one when no browser was ever linked). Updates the
 * person's furthest step and the outreach's convertedStep. Never throws.
 */

import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import createIfAbsent from "../../db/create.ts";
import log from "../../helper/log.ts";
import { commitDocuments } from "../../helper/firestore/firestoreService.ts";
import { isPlaceholderId } from "../../helper/placeholder.ts";
import { clean } from "../../db/records.ts";
import {
  COLLECTIONS,
  type FunnelStepId,
  JOURNEY_TRACK_FIELD,
  JOURNEY_VISITOR_HEADER,
  type JourneyEvent,
  type JourneyTrack,
} from "../../schemas/contracts.ts";
import { memberRank } from "./aggregate.ts";
import { eventsOfVisitor, getOutreach, patchOutreach } from "./store.ts";
import { VISITOR_RE } from "./validate.ts";

type Doc = Record<string, unknown>;

export interface Who {
  clientId?: string;
  leadId?: string;
  providerId?: string;
}

function target(who: Who): { collection: string; id: string; field: "clientId" | "leadId" | null } | null {
  if (who.clientId) return { collection: COLLECTIONS.clients, id: who.clientId, field: "clientId" };
  if (who.leadId) return { collection: COLLECTIONS.leads, id: who.leadId, field: "leadId" };
  if (who.providerId) return { collection: "providers", id: who.providerId, field: null };
  return null;
}

/** The visitor id an existing request carries (header or body), if well formed. */
export function visitorFrom(req: { headers?: Record<string, unknown>; body?: unknown }): string | null {
  const h = req.headers?.[JOURNEY_VISITOR_HEADER];
  const b = req.body && typeof req.body === "object" ? (req.body as Doc).visitorId : undefined;
  for (const v of [h, b]) if (typeof v === "string" && VISITOR_RE.test(v)) return v;
  return null;
}

async function sha(text: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(buf.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash of a lowercased email (Outreach.email). */
export async function emailHash(email: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase())));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A non-personal visitor id for a person no browser was linked to. */
export async function syntheticVisitor(key: string): Promise<string> {
  return `srv_${await sha(key)}`;
}

export const isSynthetic = (visitorId: string | undefined) => !visitorId || visitorId.startsWith("srv_");

/** Pure: a person's track from their visitor's events (first touch, furthest step). */
export function trackFromEvents(visitorId: string, events: JourneyEvent[], now: string, prior?: JourneyTrack | null): JourneyTrack {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const first = sorted[0];
  const track: JourneyTrack = first
    ? { visitorId, source: first.source, channel: first.channel, firstAt: first.at }
    : { visitorId, source: prior?.source ?? "inbound", channel: prior?.channel ?? "direct", firstAt: prior?.firstAt ?? now };
  const outreachId = sorted.find((e) => e.outreachId)?.outreachId ?? prior?.outreachId;
  if (outreachId) track.outreachId = outreachId;
  if (outreachId && prior?.source === "outbound") {
    track.source = "outbound";
    track.channel = prior.channel;
  }
  const country = sorted.find((e) => e.country)?.country ?? prior?.country;
  if (country) track.country = country;
  const device = first?.device ?? prior?.device;
  if (device) track.device = device;
  const variants: Record<string, string> = { ...(prior?.variants ?? {}) };
  for (const e of sorted) for (const [k, v] of Object.entries(e.variants ?? {})) variants[k] ??= v;
  if (Object.keys(variants).length) track.variants = variants;
  let best: { step: FunnelStepId; at: string } | null = prior?.furthestStep ? { step: prior.furthestStep, at: prior.furthestAt ?? now } : null;
  for (const e of sorted) {
    if (e.type === "step" && e.step && memberRank(e.step) > memberRank(best?.step)) best = { step: e.step, at: e.at };
  }
  if (best && memberRank(best.step) >= 0) {
    track.furthestStep = best.step;
    track.furthestAt = best.at;
  }
  return track;
}

/** Link a browser visitor to a person. Keeps an existing browser link; replaces a synthetic one. */
export async function identify(visitorId: string | null, who: Who): Promise<JourneyTrack | null> {
  try {
    const t = target(who);
    if (!t || !visitorId || !VISITOR_RE.test(visitorId)) return null;
    const doc = (await get(t.collection, t.id).catch(() => null)) as Doc | null;
    if (!doc) return null;
    const prior = (doc[JOURNEY_TRACK_FIELD] ?? null) as JourneyTrack | null;
    if (prior && !isSynthetic(prior.visitorId)) return prior;
    const events = (await eventsOfVisitor(visitorId).catch(() => [] as JourneyEvent[])).slice(0, 2000);
    const track = trackFromEvents(visitorId, events, new Date().toISOString(), prior);
    await patch(t.collection, t.id, { [JOURNEY_TRACK_FIELD]: clean(track) });
    if (t.field) {
      const field = t.field;
      const unlinked = events.filter((e) => !e[field]).slice(0, 500);
      if (unlinked.length) await commitDocuments(COLLECTIONS.journeyEvents, unlinked.map((e) => ({ id: e.id, data: { [field]: t.id } })));
    }
    return track;
  } catch (err) {
    log(`[journeys] identify failed: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

export interface StepOptions {
  at?: string;
  /** Outreach behind this step (outreach_* steps). */
  outreachId?: string;
  /** Extra key when the same person can reach the step more than once (not used by the funnel). */
  dedupe?: string;
}

/** Record a server-side step for a person (or an outreach with no person). Never throws. */
export async function trackServerStep(step: FunnelStepId, who: Who, opts: StepOptions = {}): Promise<string | null> {
  try {
    const at = opts.at ?? new Date().toISOString();
    const t = target(who);
    const doc = t ? ((await get(t.collection, t.id).catch(() => null)) as Doc | null) : null;
    let track = (doc?.[JOURNEY_TRACK_FIELD] ?? null) as JourneyTrack | null;
    const key = t ? `${t.collection}/${t.id}` : `outreach/${opts.outreachId ?? ""}`;
    if (!t && !opts.outreachId) return null;
    const placeholder = doc?.placeholder === true || isPlaceholderId(t?.id) || isPlaceholderId(opts.outreachId);
    const visitorId = track?.visitorId ?? await syntheticVisitor(key);
    const outreachId = opts.outreachId ?? track?.outreachId;
    const id = `${placeholder ? "ph_" : ""}srv_${step}_${await sha(`${key}|${opts.dedupe ?? ""}`)}`;
    const ev: JourneyEvent = {
      id,
      visitorId,
      sessionId: "server_side",
      source: track?.source ?? (outreachId ? "outbound" : "inbound"),
      channel: track?.channel ?? "direct",
      type: "step",
      step,
      path: "/(server)",
      variants: track?.variants ?? {},
      device: track?.device ?? "desktop",
      at,
    };
    if (who.clientId) ev.clientId = who.clientId;
    if (who.leadId) ev.leadId = who.leadId;
    if (outreachId) ev.outreachId = outreachId;
    if (track?.country) ev.country = track.country;
    if (placeholder) ev.placeholder = true;
    const created = await createIfAbsent(COLLECTIONS.journeyEvents, id, clean(ev) as unknown as Doc);
    if (!created) return id;
    // Furthest member step on the person.
    if (t && doc && memberRank(step) > memberRank(track?.furthestStep)) {
      track = track ?? { visitorId, source: ev.source, channel: ev.channel, firstAt: at };
      await patch(t.collection, t.id, { [JOURNEY_TRACK_FIELD]: clean({ ...track, furthestStep: step, furthestAt: at }) });
    }
    if (outreachId && memberRank(step) >= 0) await bumpOutreach(outreachId, step);
    return id;
  } catch (err) {
    log(`[journeys] step ${step} not recorded: ${err instanceof Error ? err.message : err}`, "error");
    return null;
  }
}

/** Raise an outreach's convertedStep when the person got further. */
export async function bumpOutreach(outreachId: string, step: FunnelStepId): Promise<void> {
  const o = await getOutreach(outreachId).catch(() => null);
  if (!o || memberRank(step) <= memberRank(o.convertedStep)) return;
  await patchOutreach(outreachId, { convertedStep: step });
}
