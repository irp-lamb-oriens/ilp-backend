/**
 * API/journeys/validate.ts — what POST /api/journey/events may store (pure).
 * ──────────────────────────────────────────────────────────────────────────
 * Every stored event is rebuilt field by field from the contract: anything
 * else in the body is dropped. No free text (paths lose their query string
 * and id-like segments, targets and utm values are short slugs), no emails,
 * no IP address. Steps the server records itself are refused from the
 * browser. Privacy signals (opt-out flag, DNT, Sec-GPC) and bots store nothing.
 */

import {
  isCountryCode,
  isFunnelStepId,
  JOURNEY_BATCH_MAX,
  JOURNEY_CHANNELS,
  JOURNEY_DEVICES,
  JOURNEY_EVENT_TYPES,
  JOURNEY_REDIRECT_PREFIXES,
  type JourneyChannel,
  type JourneyDevice,
  type JourneyEvent,
  type JourneyEventType,
  type JourneySource,
  type JourneyUtm,
  OUTBOUND_CHANNELS,
  type Outreach,
  SERVER_JOURNEY_STEPS,
} from "../../schemas/contracts.ts";

type Doc = Record<string, unknown>;

export const VISITOR_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const OUTREACH_ID_RE = /^(ph_)?o_[A-Za-z0-9]{6,40}$/;
const UTM_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const EXP_KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VARIANT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export const MAX_DURATION_MS = 6 * 3_600_000;
const MAX_PAST_MS = 48 * 3_600_000;
const MAX_FUTURE_MS = 5 * 60_000;

/** Path segments that look like ids or personal data become ":id". */
function segmentOf(raw: string): string {
  let seg = raw;
  try {
    seg = decodeURIComponent(raw);
  } catch {
    return ":id";
  }
  seg = seg.toLowerCase();
  if (!seg) return "";
  if (seg.includes("@")) return ":id";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(seg)) return ":id";
  if (/^(ph_|lead_|mem_|mat_|con_|hof_|task_|obl_|cli_|prov_|o_)/.test(seg)) return ":id";
  if (/\d/.test(seg) && seg.replace(/\D/g, "").length >= 4) return ":id";
  if (seg.length > 32 && /\d/.test(seg)) return ":id";
  if (!SEGMENT_RE.test(seg)) return ":id";
  return seg;
}

/** Pathname only, lowercased, ids replaced; null when it is not a site path. */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim();
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  p = p.split(/[?#]/)[0];
  const segs = p.split("/").filter(Boolean).slice(0, 12).map(segmentOf).filter(Boolean);
  const out = "/" + segs.join("/");
  return out.length > 160 ? out.slice(0, 160) : out;
}

/** An outreach click may only land on a site path under JOURNEY_REDIRECT_PREFIXES. */
export function safeRedirectPath(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const t = raw.trim();
  if (!t.startsWith("/") || t.startsWith("//") || t.includes("\\") || /[\x00-\x1f]/.test(t) || /^\/[^/]*:/.test(t)) return "/";
  const pathOnly = t.split(/[?#]/)[0];
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(pathOnly) || pathOnly.includes("..") || pathOnly.includes("//")) return "/";
  const ok = JOURNEY_REDIRECT_PREFIXES.some((pre) => pre === "/" ? pathOnly === "/" : pathOnly === pre || pathOnly.startsWith(pre + "/"));
  return ok ? pathOnly : "/";
}

const BOT_RE =
  /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|curl\/|wget|python-requests|python-urllib|httpclient|axios|node-fetch|undici|go-http|java\/|okhttp|facebookexternalhit|embedly|preview|scrapy|phantomjs|puppeteer|playwright|selenium/i;

export function isBot(userAgent: unknown): boolean {
  const ua = typeof userAgent === "string" ? userAgent : "";
  return !ua.trim() || BOT_RE.test(ua);
}

export type PrivacySignal = "opt_out" | "dnt" | "gpc" | null;

export function privacySignal(headers: Record<string, unknown>, body: Doc | null | undefined): PrivacySignal {
  if (body?.optOut === true) return "opt_out";
  const h = (k: string) => String(headers[k] ?? headers[k.toLowerCase()] ?? "").trim();
  if (h("dnt") === "1") return "dnt";
  if (h("sec-gpc") === "1") return "gpc";
  return null;
}

/** Parse the body: JSON object, or a JSON string (text/plain from sendBeacon). */
export function bodyObject(body: unknown): Doc | null {
  if (typeof body === "string") {
    if (body.length > 32_768) return null;
    try {
      const v = JSON.parse(body);
      return v && typeof v === "object" && !Array.isArray(v) ? v as Doc : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" && !Array.isArray(body) ? body as Doc : null;
}

function cleanUtm(v: unknown): JourneyUtm | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Doc;
  const out: JourneyUtm = {};
  for (const k of ["source", "medium", "campaign", "content"] as const) {
    const s = typeof o[k] === "string" ? (o[k] as string).trim().toLowerCase().slice(0, 80) : "";
    if (s && UTM_RE.test(s)) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanVariants(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Doc).slice(0, 10)) {
    if (EXP_KEY_RE.test(k) && typeof x === "string" && VARIANT_RE.test(x)) out[k] = x;
  }
  return out;
}

function clampAt(v: unknown, now: Date): string {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  const n = now.getTime();
  if (!Number.isFinite(t) || t > n + MAX_FUTURE_MS || t < n - MAX_PAST_MS) return now.toISOString();
  return new Date(t).toISOString();
}

/** The event as the browser asked for it, before attribution (source/channel resolved by resolveAttribution). */
export interface ParsedEvent extends Omit<JourneyEvent, "id" | "source" | "channel"> {
  wantSource?: JourneySource;
  wantChannel?: JourneyChannel;
}

/** Pure: one browser event → a clean event, or null to drop it. */
export function parseEvent(raw: unknown, now: Date): ParsedEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Doc;
  const visitorId = typeof e.visitorId === "string" ? e.visitorId : "";
  const sessionId = typeof e.sessionId === "string" ? e.sessionId : "";
  if (!VISITOR_RE.test(visitorId) || !VISITOR_RE.test(sessionId)) return null;
  const type = e.type as JourneyEventType;
  if (!JOURNEY_EVENT_TYPES.includes(type)) return null;
  const path = normalizePath(e.path);
  if (!path) return null;
  const out: ParsedEvent = {
    visitorId,
    sessionId,
    type,
    path,
    variants: cleanVariants(e.variants),
    device: JOURNEY_DEVICES.includes(e.device as JourneyDevice) ? e.device as JourneyDevice : "desktop",
    at: clampAt(e.at, now),
  };
  if (type === "step") {
    if (!isFunnelStepId(e.step) || SERVER_JOURNEY_STEPS.includes(e.step)) return null;
    out.step = e.step;
  } else if ((type === "click" || type === "form_error") && isFunnelStepId(e.step)) {
    out.step = e.step;
  }
  // Experiment exposure (frontend): a heartbeat with durationMs 0 and target "exposure.<experimentKey>".
  if (type === "heartbeat" && typeof e.target === "string" && /^exposure\.[a-z0-9][a-z0-9-]{0,47}$/.test(e.target)) out.target = e.target;
  if (type === "click" || type === "form_error") {
    const target = typeof e.target === "string" ? e.target.trim() : "";
    if (target && TARGET_RE.test(target)) out.target = target;
    else if (type === "form_error") return null;
  }
  if (typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && (type === "heartbeat" || type === "exit" || type === "page_view")) {
    out.durationMs = Math.round(Math.min(MAX_DURATION_MS, Math.max(0, e.durationMs)));
  }
  if (isCountryCode(e.country)) out.country = e.country;
  const utm = cleanUtm(e.utm);
  if (utm) out.utm = utm;
  if (typeof e.outreachId === "string" && OUTREACH_ID_RE.test(e.outreachId)) out.outreachId = e.outreachId;
  if (e.source === "inbound" || e.source === "outbound") out.wantSource = e.source;
  if (JOURNEY_CHANNELS.includes(e.channel as JourneyChannel)) out.wantChannel = e.channel as JourneyChannel;
  return out;
}

const INBOUND_CHANNELS: readonly JourneyChannel[] = JOURNEY_CHANNELS.filter((c) => !OUTBOUND_CHANNELS.includes(c));

/**
 * Pure: source and channel. "outbound" needs a real outreach record (the
 * opaque ?o= id); without one the event is inbound, whatever the browser said.
 */
export function resolveAttribution(ev: ParsedEvent, outreach: Pick<Outreach, "id" | "channel"> | null): Pick<JourneyEvent, "source" | "channel" | "outreachId"> {
  if (outreach) return { source: "outbound", channel: outreach.channel, outreachId: outreach.id };
  let channel: JourneyChannel = ev.wantChannel && INBOUND_CHANNELS.includes(ev.wantChannel) ? ev.wantChannel : ev.utm?.campaign ? "campaign" : "direct";
  if (channel === "direct" && ev.utm?.campaign) channel = "campaign";
  return { source: "inbound", channel };
}

export interface ParsedBatch {
  events: ParsedEvent[];
  dropped: number;
}

/** Pure: the batch → clean events (at most JOURNEY_BATCH_MAX; the rest is dropped). */
export function parseBatch(body: Doc | null, now: Date): ParsedBatch | { error: string } {
  if (!body || !Array.isArray(body.events)) return { error: "Send { events: [...] }." };
  const list = body.events as unknown[];
  const events: ParsedEvent[] = [];
  let dropped = Math.max(0, list.length - JOURNEY_BATCH_MAX);
  for (const raw of list.slice(0, JOURNEY_BATCH_MAX)) {
    const ev = parseEvent(raw, now);
    if (ev) events.push(ev);
    else dropped++;
  }
  return { events, dropped };
}

/** Random event id (journey_events doc id). */
export function newEventId(placeholder = false): string {
  return `${placeholder ? "ph_" : ""}jev_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Random opaque outreach id. */
export function newOutreachId(placeholder = false): string {
  return `${placeholder ? "ph_" : ""}o_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
