/**
 * API/journeys/journeysRouter.ts — first-party journey analytics + A/B experiments.
 * ──────────────────────────────────────────────────────────────────────────
 * Public (no login):
 *   POST /api/journey/events          batched browser events (≤ 50, 32 KB), see validate.ts
 *   GET  /api/journey/assign          sticky variants of running experiments (cache 60 s)
 *   GET  /api/journey/o/:id.gif       outreach open pixel
 *   GET  /api/journey/c/:id?to=/path  outreach click → redirect to an allowlisted site path
 * Staff (staff | csm | admin; experiment writes: admin or OWNER_EMAILS):
 *   GET  /api/dashboard/journeys/funnel | paths | stuck | stuck/people | pages | outbound
 *   POST /api/dashboard/journeys/stuck/:id/task      CSM task for a stuck person
 *   POST /api/dashboard/journeys/outreach            log a CSM call / manual send, get tracked links
 *   GET|POST /api/dashboard/journeys/experiments, GET|PATCH|DELETE …/:id,
 *   POST …/:id/start | pause | end | declare-winner, GET …/:id/results
 * Reads use journey_daily for past days and today's raw events (bounded) live.
 */

import type { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import asyncHandler from "../../helper/asyncHandler.ts";
import auditLog from "../../helper/auditLog.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import query from "../../db/query.ts";
import patch from "../../db/patch.ts";
import { createRecord, getRecord } from "../../db/records.ts";
import { type AuthedRequest, optionalClientId, requireDashboardAuth } from "../../helper/auth/session.ts";
import { isOwnerEmail, ROLE_DENIED_MESSAGE, staffRoleFor } from "../../helper/auth/roles.ts";
import { type ListSpec, pageRows, respondList } from "../../helper/listing.ts";
import { derivedStamp, isPlaceholderId } from "../../helper/placeholder.ts";
import {
  COLLECTIONS,
  type CsmTask,
  type Experiment,
  FUNNEL_STEPS,
  type FunnelStepId,
  isCountryCode,
  JOURNEY_CHANNELS,
  JOURNEY_DEVICES,
  JOURNEY_TRACK_FIELD,
  type JourneyChannel,
  type JourneyDaily,
  type JourneyDevice,
  type JourneyEvent,
  type JourneyFilters,
  type JourneyFunnel,
  type JourneyFunnelKind,
  type JourneyRange,
  type JourneySource,
  journeyStepLabel,
  type JourneyTrack,
  OUTREACH_PARAM,
  type OutreachChannel,
  type StuckPerson,
} from "../../schemas/contracts.ts";
import { buildDay, experimentResult, funnelRows, matchesFilters, memberRank, outboundRows, pagesOf, pathsOf, stuckOf } from "./aggregate.ts";
import { assignmentsFor, configOf } from "./assign.ts";
import { applyPatch, ExperimentError, parseExperimentInput, transition, type ExperimentAction } from "./experiments.ts";
import { campaignSlug, createOutreach, OUTREACH_CHANNELS, outreachView, PIXEL_GIF, recordClick, recordOpen, siteUrl, trackedUrls } from "./outreach.ts";
import {
  dailyBetween,
  deleteExperiment,
  eventsBetween,
  exposuresOf,
  getExperiment,
  getOutreach,
  listExperiments,
  outreachBetween,
  runningExperiments,
  saveEvents,
  saveExperiment,
} from "./store.ts";
import { bumpOutreach, identify } from "./track.ts";
import { bodyObject, isBot, newEventId, OUTREACH_ID_RE, parseBatch, privacySignal, resolveAttribution, safeRedirectPath, VISITOR_RE } from "./validate.ts";

type Doc = Record<string, unknown>;
const DAY = 86_400_000;

// ─── Small parsers ─────────────────────────────────────────────────────────

const qs = (req: Request, k: string): string => {
  const v = (req.query ?? {})[k];
  return typeof v === "string" ? v.trim() : "";
};
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** ?from&to as UTC days; default the last 28 days; at most 400 days. */
export function parseRange(from: string, to: string, now: Date): JourneyRange {
  const today = now.toISOString().slice(0, 10);
  let t = isDay(to) ? to : today;
  if (t > today) t = today;
  let f = isDay(from) ? from : new Date(Date.parse(`${t}T00:00:00Z`) - 27 * DAY).toISOString().slice(0, 10);
  if (f > t) f = t;
  const min = new Date(Date.parse(`${t}T00:00:00Z`) - 400 * DAY).toISOString().slice(0, 10);
  if (f < min) f = min;
  return { from: f, to: t };
}

export function parseFilters(q: (k: string) => string): JourneyFilters {
  const f: JourneyFilters = {};
  const source = q("source");
  if (source === "inbound" || source === "outbound") f.source = source as JourneySource;
  const channel = q("channel");
  if (JOURNEY_CHANNELS.includes(channel as JourneyChannel)) f.channel = channel as JourneyChannel;
  const country = q("country").toUpperCase();
  if (isCountryCode(country)) f.country = country;
  const device = q("device");
  if (JOURNEY_DEVICES.includes(device as JourneyDevice)) f.device = device as JourneyDevice;
  const experiment = q("experiment");
  if (/^[a-z0-9][a-z0-9-]{0,47}$/.test(experiment)) {
    f.experiment = experiment;
    const variant = q("variant");
    if (/^[a-z0-9][a-z0-9_-]{0,31}$/.test(variant)) f.variant = variant;
  }
  if (q("excludePlaceholder") === "1" || q("excludePlaceholder") === "true") f.excludePlaceholder = true;
  return f;
}

const funnelKind = (v: string): JourneyFunnelKind => (v === "lawyer" || v === "outbound" ? v : "member");

/** Daily rows for the range: stored days before today, today computed live from raw events. */
export async function rowsFor(range: JourneyRange, now: Date): Promise<JourneyDaily[]> {
  const today = now.toISOString().slice(0, 10);
  const stored = (await dailyBetween(range.from, range.to)).filter((r) => r.day < today);
  if (range.to < today) return stored;
  const start = `${today}T00:00:00.000Z`;
  const events = await eventsBetween(start, new Date(now.getTime() + 60_000).toISOString());
  const running = await runningExperiments().catch(() => [] as Experiment[]);
  return [...stored, ...buildDay(events, today, now.toISOString(), new Set(running.map((e) => e.key))).daily];
}

// ─── Gates ─────────────────────────────────────────────────────────────────

/** Experiment writes: admin role, or an OWNER_EMAILS address. */
export function requireExperimentWriter(req: Request, res: Response, next: NextFunction): void {
  const email = (req as AuthedRequest).dashboardUser;
  if (staffRoleFor(email) === "admin" || isOwnerEmail(email)) return next();
  res.status(403).json({ error: ROLE_DENIED_MESSAGE, code: "role_denied", requiredRole: ["admin"] });
}

const eventsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many events. Slow down." },
  validate: { trustProxy: false },
});

/** Per-visitor cap: events per 10 minutes, in memory (one server). */
const VISITOR_CAP = 400;
const visitorCounts = new Map<string, { n: number; reset: number }>();
export function takeVisitorBudget(visitorId: string, n: number, now = Date.now()): number {
  if (visitorCounts.size > 50_000) visitorCounts.clear();
  const c = visitorCounts.get(visitorId);
  const cur = !c || c.reset < now ? { n: 0, reset: now + 600_000 } : c;
  const allowed = Math.max(0, Math.min(n, VISITOR_CAP - cur.n));
  cur.n += allowed;
  visitorCounts.set(visitorId, cur);
  return allowed;
}

const actorOf = (req: Request) => {
  const email = (req as AuthedRequest).dashboardUser ?? "staff";
  return { uid: email, email, role: (req as AuthedRequest).dashboardRole ?? staffRoleFor(email) };
};

function sendExperimentError(res: Response, err: unknown): boolean {
  if (err instanceof ExperimentError) {
    res.status(err.status).json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
    return true;
  }
  return false;
}

// ─── Stuck people ──────────────────────────────────────────────────────────

/** Pure: a person doc → a stuck row, or null when they moved on recently / left the funnel. */
export function stuckPersonOf(kind: "client" | "lead", d: Doc, step: FunnelStepId, minDays: number, now: Date): StuckPerson | null {
  const t = d[JOURNEY_TRACK_FIELD] as JourneyTrack | undefined;
  if (!t || t.furthestStep !== step || !t.furthestAt) return null;
  if (kind === "lead" && typeof d.convertedClientId === "string" && d.convertedClientId) return null;
  const days = Math.floor((now.getTime() - Date.parse(t.furthestAt)) / DAY);
  if (!Number.isFinite(days) || days < minDays) return null;
  const id = String(d.id);
  const p: StuckPerson = { id: `${kind}:${id}`, step, since: t.furthestAt, daysStuck: days, source: t.source };
  if (kind === "client") p.clientId = id;
  else p.leadId = id;
  const name = typeof d.name === "string" && d.name ? d.name : typeof d.fullName === "string" ? d.fullName : "";
  if (name) p.name = name;
  const country = t.country ?? (isCountryCode(d.country) ? d.country : undefined);
  if (country) p.country = country;
  if (typeof d.csmEmail === "string" && d.csmEmail) p.csmEmail = d.csmEmail;
  if (d.placeholder === true) p.placeholder = true;
  return p;
}

export const stuckTaskId = (personKey: string, step: string, placeholder: boolean) =>
  `${placeholder ? "ph_" : ""}task_journey_stuck__${personKey.replace(/[^A-Za-z0-9_-]/g, "_")}_${step}`.slice(0, 1400);

// ─── Router ────────────────────────────────────────────────────────────────

export default function journeysRouter(app: Express) {
  log("Journeys router initialized.");

  // ── Public ──────────────────────────────────────────────────────────────
  app.post(
    "/api/journey/events",
    eventsLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const body = bodyObject(req.body);
      const total = Array.isArray(body?.events) ? (body!.events as unknown[]).length : 0;
      const signal = privacySignal(req.headers as Record<string, unknown>, body);
      if (signal) return res.status(202).json({ accepted: 0, dropped: total, ignored: signal });
      if (isBot(req.headers["user-agent"])) return res.status(202).json({ accepted: 0, dropped: total, ignored: "bot" });
      const now = new Date();
      const parsed = parseBatch(body, now);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      let dropped = parsed.dropped;
      // Per-visitor budget.
      const byVisitor = new Map<string, number>();
      for (const e of parsed.events) byVisitor.set(e.visitorId, (byVisitor.get(e.visitorId) ?? 0) + 1);
      const budget = new Map([...byVisitor].map(([v, n]) => [v, takeVisitorBudget(v, n)]));
      const kept = parsed.events.filter((e) => {
        const left = budget.get(e.visitorId) ?? 0;
        if (left <= 0) {
          dropped++;
          return false;
        }
        budget.set(e.visitorId, left - 1);
        return true;
      });
      const outreach = new Map<string, Awaited<ReturnType<typeof getOutreach>>>();
      for (const id of new Set(kept.map((e) => e.outreachId).filter(Boolean) as string[])) outreach.set(id, await getOutreach(id, true).catch(() => null));
      const clientId = await optionalClientId(req);
      const events: JourneyEvent[] = kept.map((p) => {
        const { wantSource: _s, wantChannel: _c, outreachId: _o, ...rest } = p;
        const ev: JourneyEvent = { id: newEventId(), ...rest, ...resolveAttribution(p, p.outreachId ? outreach.get(p.outreachId) ?? null : null) };
        if (clientId) ev.clientId = clientId;
        return ev;
      });
      await saveEvents(events);
      // Side effects: never fail the request.
      try {
        for (const e of events) if (e.outreachId && e.type === "step" && e.step) await bumpOutreach(e.outreachId, e.step);
        if (clientId && events.length) {
          const track = await identify(events[0].visitorId, { clientId });
          const best = events.filter((e) => e.type === "step" && e.step).sort((a, b) => memberRank(b.step) - memberRank(a.step))[0];
          if (track && best?.step && memberRank(best.step) > memberRank(track.furthestStep)) {
            await patch(COLLECTIONS.clients, clientId, { [JOURNEY_TRACK_FIELD]: { ...track, furthestStep: best.step, furthestAt: best.at } });
          }
        }
      } catch (err) {
        log(`[journeys] event side effects failed: ${err instanceof Error ? err.message : err}`, "error");
      }
      res.status(202).json({ accepted: events.length, dropped });
    }),
  );

  app.get(
    "/api/journey/assign",
    asyncHandler(async (req: Request, res: Response) => {
      const visitorId = qs(req, "visitorId");
      if (!VISITOR_RE.test(visitorId)) return res.status(400).json({ error: "visitorId is a random id of 8-64 letters, digits, - or _." });
      const source: JourneySource = qs(req, "source") === "outbound" ? "outbound" : "inbound";
      // Placeholder (seed) experiments show in staff views but never change the real site.
      const running = (await runningExperiments()).filter((e) => !e.placeholder);
      const assignments = assignmentsFor(visitorId, running, source);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({ visitorId, assignments, experiments: running.filter((e) => assignments[e.key]).map(configOf) });
    }),
  );

  app.get(
    "/api/journey/o/:id.gif",
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "");
      if (OUTREACH_ID_RE.test(id)) await recordOpen(id);
      res.setHeader("Content-Type", "image/gif");
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.status(200);
      (res as unknown as { end(body: Uint8Array): void }).end(PIXEL_GIF);
    }),
  );

  app.get(
    "/api/journey/c/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "");
      const path = safeRedirectPath(req.query?.to);
      const known = OUTREACH_ID_RE.test(id) && await recordClick(id);
      const url = `${siteUrl()}${path}${known ? `?${OUTREACH_PARAM}=${encodeURIComponent(id)}` : ""}`;
      res.setHeader("Location", url);
      res.setHeader("Cache-Control", "no-store");
      res.status(302).end();
    }),
  );

  // ── Staff reads ─────────────────────────────────────────────────────────
  const staffRead = (path: string, fn: (req: Request, res: Response, ctx: { range: JourneyRange; filters: JourneyFilters; now: Date }) => Promise<unknown>) =>
    app.get(
      `/api/dashboard/journeys/${path}`,
      requireDashboardAuth,
      asyncHandler(async (req: Request, res: Response) => {
        const now = new Date();
        const ctx = { range: parseRange(qs(req, "from"), qs(req, "to"), now), filters: parseFilters((k) => qs(req, k)), now };
        await fn(req, res, ctx);
      }),
    );

  staffRead("funnel", async (req, res, { range, filters, now }) => {
    const kind = funnelKind(qs(req, "funnel"));
    const rows = await rowsFor(range, now);
    const f = kind === "outbound" ? { ...filters, source: "outbound" as const } : filters;
    const body: JourneyFunnel = {
      funnel: kind,
      range,
      filters: f,
      rows: funnelRows(rows.filter((r) => matchesFilters(r, f)), kind),
      bySource: {
        inbound: funnelRows(rows.filter((r) => matchesFilters(r, { ...f, source: "inbound" })), kind),
        outbound: funnelRows(rows.filter((r) => matchesFilters(r, { ...f, source: "outbound" })), kind),
      },
    };
    res.json(body);
  });

  staffRead("paths", async (_req, res, { range, filters, now }) => {
    const rows = (await rowsFor(range, now)).filter((r) => matchesFilters(r, filters));
    res.json({ range, filters, ...pathsOf(rows) });
  });

  staffRead("stuck", async (req, res, { range, filters, now }) => {
    const rows = (await rowsFor(range, now)).filter((r) => matchesFilters(r, filters));
    res.json({ range, filters, steps: stuckOf(rows, funnelKind(qs(req, "funnel"))) });
  });

  staffRead("pages", async (_req, res, { range, filters, now }) => {
    const rows = (await rowsFor(range, now)).filter((r) => matchesFilters(r, filters));
    res.json({ range, filters, pages: pagesOf(rows) });
  });

  staffRead("outbound", async (req, res, { range }) => {
    const channel = qs(req, "channel");
    const list = (await outreachBetween(`${range.from}T00:00:00.000Z`, new Date(Date.parse(`${range.to}T00:00:00Z`) + DAY).toISOString()))
      .filter((o) => !channel || o.channel === channel)
      .filter((o) => !(qs(req, "excludePlaceholder") === "1" && o.placeholder));
    res.json({ range, rows: outboundRows(list) });
  });

  app.get(
    "/api/dashboard/journeys/stuck/people",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const step = qs(req, "step") as FunnelStepId;
      if (memberRank(step) < 0 || step === FUNNEL_STEPS[FUNNEL_STEPS.length - 1].id) {
        return res.status(400).json({ error: "Pick a member-funnel step that has a next step.", field: "step" });
      }
      const days = Math.min(365, Math.max(0, Number.parseInt(qs(req, "days") || "7", 10) || 0));
      const now = new Date();
      const [clients, leads] = await Promise.all([
        query(COLLECTIONS.clients, [{ field: `${JOURNEY_TRACK_FIELD}.furthestStep`, op: "EQUAL", value: step }]).catch(() => []),
        query(COLLECTIONS.leads, [{ field: `${JOURNEY_TRACK_FIELD}.furthestStep`, op: "EQUAL", value: step }]).catch(() => []),
      ]);
      const exclude = qs(req, "excludePlaceholder") === "1";
      const rows = [
        ...(clients as Doc[]).map((d) => stuckPersonOf("client", d, step, days, now)),
        ...(leads as Doc[]).map((d) => stuckPersonOf("lead", d, step, days, now)),
      ].filter((p): p is StuckPerson => !!p && !(exclude && p.placeholder));
      const spec: ListSpec<StuckPerson> = {
        sorts: { daysStuck: (r) => r.daysStuck, since: (r) => r.since, name: (r) => (r.name ?? "").toLowerCase() },
        defaultSort: "daysStuck",
        defaultDir: "desc",
        filters: {
          source: (r, v) => r.source === v,
          country: (r, v) => r.country === v.toUpperCase(),
          csm: (r, v) => r.csmEmail === v,
        },
        search: (r) => [r.name, r.csmEmail, r.country],
      };
      await respondList(req, res, spec, (p) => {
        const page = pageRows(rows, p, spec);
        return {
          produce: async function* () {
            const items: StuckPerson[] = [];
            for (const r of page.items) {
              const tid = stuckTaskId(r.id, r.step, !!r.placeholder);
              const t = await getRecord<CsmTask>(COLLECTIONS.csmTasks, tid).catch(() => null);
              items.push(t && t.status === "open" ? { ...r, openTaskId: tid } : r);
            }
            yield items;
            return { nextCursor: page.nextCursor, hasMore: page.hasMore, total: page.total };
          },
          meta: { step, label: journeyStepLabel(step), days },
        };
      });
    }),
  );

  app.post(
    "/api/dashboard/journeys/stuck/:id/task",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const raw = String(req.params.id ?? "");
      const m = /^(client|lead):(.{1,200})$/.exec(raw);
      if (!m) return res.status(400).json({ error: "Unknown person id." });
      const [, kind, pid] = m;
      const doc = (await get(kind === "client" ? COLLECTIONS.clients : COLLECTIONS.leads, pid).catch(() => null)) as Doc | null;
      if (!doc) return res.status(404).json({ error: "Not found." });
      const track = doc[JOURNEY_TRACK_FIELD] as JourneyTrack | undefined;
      const step = track?.furthestStep;
      if (!step) return res.status(409).json({ error: "This person has no journey step yet." });
      const body = (req.body ?? {}) as Doc;
      const placeholder = doc.placeholder === true || isPlaceholderId(pid);
      const id = stuckTaskId(raw, step, placeholder);
      const existing = await getRecord<CsmTask>(COLLECTIONS.csmTasks, id);
      if (existing && existing.status === "open") return res.status(200).json({ task: existing, existing: true });
      const name = String(doc.name ?? doc.fullName ?? "").trim();
      const hours = Math.min(24 * 14, Math.max(1, Number(body.dueInHours) || 24));
      const title = (typeof body.title === "string" && body.title.trim() ? body.title.trim() : `Stuck at "${journeyStepLabel(step)}": reach out${name ? ` to ${name}` : ""}`).slice(0, 200);
      const owner = (typeof body.ownerEmail === "string" && /^[^@\s]+@[^@\s]+$/.test(body.ownerEmail) ? body.ownerEmail : "") ||
        (typeof doc.csmEmail === "string" ? doc.csmEmail : "") || Deno.env.get("DEFAULT_CSM_EMAIL") || "";
      const clientId = kind === "client" ? pid : (typeof doc.convertedClientId === "string" && doc.convertedClientId) || pid;
      const now = new Date();
      const task: CsmTask = {
        id,
        clientId,
        type: "follow_up",
        title,
        dueAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
        status: "open",
        source: { kind: "manual", id: `journey:${raw}:${step}` },
        createdAt: now.toISOString(),
      };
      if (owner) task.ownerEmail = owner;
      const created = await createRecord(COLLECTIONS.csmTasks, placeholder ? { ...task, ...derivedStamp() } : task);
      await auditLog({ actor: actorOf(req), action: "journey.stuck_task_created", target: `csm_tasks/${id}`, meta: { person: raw, step } }).catch(() => {});
      res.status(201).json({ task: created });
    }),
  );

  app.post(
    "/api/dashboard/journeys/outreach",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const b = (req.body ?? {}) as Doc;
      const channel = b.channel as OutreachChannel;
      if (!OUTREACH_CHANNELS.includes(channel)) return res.status(400).json({ error: "channel is email_outreach, import or csm_call.", field: "channel" });
      const campaign = campaignSlug(b.campaign);
      if (!campaign) return res.status(400).json({ error: "Name the campaign (letters, digits, - or _).", field: "campaign" });
      const clientId = typeof b.clientId === "string" ? b.clientId.trim().slice(0, 200) : "";
      const leadId = typeof b.leadId === "string" ? b.leadId.trim().slice(0, 200) : "";
      if (clientId && !(await get(COLLECTIONS.clients, clientId).catch(() => null))) return res.status(404).json({ error: "Member not found.", field: "clientId" });
      if (leadId && !(await get(COLLECTIONS.leads, leadId).catch(() => null))) return res.status(404).json({ error: "Lead not found.", field: "leadId" });
      const email = typeof b.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email.trim()) ? b.email.trim() : undefined;
      const actor = actorOf(req);
      const o = await createOutreach({ channel, campaign, sentBy: actor.email, ...(clientId ? { clientId } : {}), ...(leadId ? { leadId } : {}), ...(email ? { email } : {}) });
      await auditLog({ actor, action: "journey.outreach_logged", target: `outreach/${o.id}`, meta: { channel, campaign, clientId: clientId || undefined, leadId: leadId || undefined } }).catch(() => {});
      res.status(201).json({ outreach: outreachView(o), ...trackedUrls(o.id, typeof b.to === "string" ? b.to : "/check") });
    }),
  );

  // ── Experiments ─────────────────────────────────────────────────────────
  app.get(
    "/api/dashboard/journeys/experiments",
    requireDashboardAuth,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ items: await listExperiments() });
    }),
  );

  app.post(
    "/api/dashboard/journeys/experiments",
    requireDashboardAuth,
    requireExperimentWriter,
    asyncHandler(async (req: Request, res: Response) => {
      try {
        const input = parseExperimentInput(req.body);
        const all = await listExperiments();
        if (all.some((e) => e.key === input.key)) throw new ExperimentError(409, "Another experiment uses this key.", "key");
        const now = new Date().toISOString();
        const actor = actorOf(req);
        const exp: Experiment = { id: `exp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, ...input, status: "draft", createdBy: actor.email, createdAt: now, updatedAt: now };
        await saveExperiment(exp);
        await auditLog({ actor, action: "experiment.created", target: `experiments/${exp.id}`, meta: { key: exp.key, variants: exp.variants } });
        res.status(201).json({ experiment: exp });
      } catch (err) {
        if (!sendExperimentError(res, err)) throw err;
      }
    }),
  );

  app.get(
    "/api/dashboard/journeys/experiments/:id",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const e = await getExperiment(req.params.id);
      if (!e) return res.status(404).json({ error: "Not found." });
      res.json({ experiment: e });
    }),
  );

  app.patch(
    "/api/dashboard/journeys/experiments/:id",
    requireDashboardAuth,
    requireExperimentWriter,
    asyncHandler(async (req: Request, res: Response) => {
      const e = await getExperiment(req.params.id);
      if (!e) return res.status(404).json({ error: "Not found." });
      try {
        const next = applyPatch(e, req.body, new Date().toISOString());
        if (next.key !== e.key && (await listExperiments()).some((x) => x.key === next.key && x.id !== e.id)) {
          throw new ExperimentError(409, "Another experiment uses this key.", "key");
        }
        await saveExperiment(next);
        await auditLog({ actor: actorOf(req), action: "experiment.updated", target: `experiments/${e.id}`, meta: { fields: Object.keys((req.body ?? {}) as Doc) } });
        res.json({ experiment: next });
      } catch (err) {
        if (!sendExperimentError(res, err)) throw err;
      }
    }),
  );

  app.delete(
    "/api/dashboard/journeys/experiments/:id",
    requireDashboardAuth,
    requireExperimentWriter,
    asyncHandler(async (req: Request, res: Response) => {
      const e = await getExperiment(req.params.id);
      if (!e) return res.status(404).json({ error: "Not found." });
      if (e.status !== "draft") return res.status(409).json({ error: "Only a draft can be deleted. End the experiment instead." });
      await deleteExperiment(e.id);
      await auditLog({ actor: actorOf(req), action: "experiment.deleted", target: `experiments/${e.id}`, meta: { key: e.key } });
      res.json({ success: true });
    }),
  );

  for (const action of ["start", "pause", "end", "declare-winner"] as ExperimentAction[]) {
    app.post(
      `/api/dashboard/journeys/experiments/:id/${action}`,
      requireDashboardAuth,
      requireExperimentWriter,
      asyncHandler(async (req: Request, res: Response) => {
        const e = await getExperiment(req.params.id);
        if (!e) return res.status(404).json({ error: "Not found." });
        try {
          const next = transition(e, action, new Date().toISOString(), (req.body as Doc | undefined)?.variant);
          if (action === "start") {
            const clash = (await listExperiments()).find((x) => x.id !== e.id && x.status === "running" && x.surface === e.surface);
            if (clash) throw new ExperimentError(409, `"${clash.name}" is already running on ${e.surface}. Pause or end it first.`);
          }
          await saveExperiment(next);
          await auditLog({
            actor: actorOf(req),
            action: `experiment.${action === "declare-winner" ? "winner_declared" : action === "start" ? "started" : action === "pause" ? "paused" : "ended"}`,
            target: `experiments/${e.id}`,
            meta: { key: e.key, from: e.status, to: next.status, ...(next.winner ? { winner: next.winner } : {}) },
          });
          res.json({ experiment: next });
        } catch (err) {
          if (!sendExperimentError(res, err)) throw err;
        }
      }),
    );
  }

  app.get(
    "/api/dashboard/journeys/experiments/:id/results",
    requireDashboardAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const e = await getExperiment(req.params.id);
      if (!e) return res.status(404).json({ error: "Not found." });
      const exposures = await exposuresOf(e.key);
      res.json(experimentResult(e, exposures, { excludePlaceholder: qs(req, "excludePlaceholder") === "1" }));
    }),
  );
}

