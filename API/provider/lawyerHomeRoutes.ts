/**
 * API/provider/lawyerHomeRoutes.ts — lawyer home (W5): Today, brief, board,
 * finance. Registered from providerDashboardRouter.
 * ──────────────────────────────────────────────────────────────────────────
 * Every route is requireProviderAuth and reads by providerId /
 * assignedProviderId / clientId equality queries (no collection scans).
 * Responses pass through stripProviderResponses (lawyerView.ts).
 *
 *   GET   /api/provider/today?from=&to=              the lawyer's consultations in a window, with names
 *   GET   /api/provider/consultations/:id/brief      one-screen pre-call brief
 *   POST  /api/provider/consultations/:id/suggest    AI summary + next steps from the transcript ("suggested")
 *   GET   /api/provider/clients/:id/brief            member brief for the inspector + this lawyer's calls
 *   GET   /api/provider/board                        matter cards (aging, overdue obligations)
 *   PATCH /api/provider/matters/:id/stage            { stage } → the changed card only
 *   GET   /api/provider/finance                      own fees: paid, pending, per matter, payout dates
 *
 * The call flow writes through W1's routes: PATCH /api/lawyer/consultations/:id
 * (consent, transcript, summary, status, minutesUsed) and POST /api/lawyer/handoffs.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import query from "../../db/query.ts";
import auditLog from "../../helper/auditLog.ts";
import { requireProviderAuth } from "../../helper/auth/session.ts";
import {
  COLLECTIONS,
  type Consultation,
  type LegalNextStep,
  type Matter,
  type Obligation,
  profileCompleteness,
  toCountryCode,
} from "../../schemas/contracts.ts";
import {
  findRecords,
  getRecord,
  memberBundle,
  profileRecord,
  updateRecord,
} from "../members/service.ts";
import { onRecordUpdated } from "../members/events.ts";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import { ensureStageConfig, getStageLabel, isValidStage } from "../dashboard/automation/stageConfig.ts";
import { getStageIds, getStageLabels } from "../dashboard/clientHelpers.ts";
import { callLLMWithFallback } from "../chatbot/intelligence/llm.ts";
import { extractJSONFromLLMResponse } from "../chatbot/utils/llm-json-parser.ts";

type Obj = Record<string, unknown>;
const DAY = 86_400_000;

const pidOf = (req: Request) => (req as Request & { providerId?: string }).providerId ?? "";
const emailOf = (req: Request) => (req as Request & { providerUser?: string }).providerUser ?? "";
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Display name for a client doc. */
export function clientName(doc: Obj | null, fallback = ""): string {
  if (!doc) return fallback;
  const p = profileRecord(doc);
  const full = str(p.fullName) ?? [str(p.name), str(p.surname)].filter(Boolean).join(" ");
  return full || str(p.email) || fallback;
}

/** Load client docs by id in parallel (only the ids we need). */
async function clientsById(ids: string[]): Promise<Map<string, Obj>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const docs = await Promise.all(unique.map((id) => get(COLLECTIONS.clients, id).catch(() => null)));
  const out = new Map<string, Obj>();
  unique.forEach((id, i) => {
    if (docs[i]) out.set(id, { ...(docs[i] as Obj), id });
  });
  return out;
}

function ageFrom(dob: unknown): number | null {
  const s = str(dob);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (365.25 * DAY));
}

const yes = (v: unknown) => v === true || v === "yes" || v === "true" || v === "Yes";

// ─── Brief (pure; exported for tests) ──────────────────────────────────────

export interface BriefInput {
  consultation: Consultation & Obj;
  client: Obj | null;
  matters: Matter[];
  obligations: Obligation[];
  completeness: { score: number; bySection: Record<string, number>; consultationReady: boolean };
  minutesLeft: number;
  callsLeft: number;
  priorSummaries: Array<{ scheduledAt: string; text: string }>;
  now?: Date;
}

export function buildBrief(i: BriefInput) {
  const now = i.now ?? new Date();
  const horizon = new Date(now.getTime() + 60 * DAY).toISOString();
  const p = profileRecord(i.client);
  const c = i.consultation;
  const openMatters = i.matters.filter((m) => !m.closedAt);
  const obligations = i.obligations
    .filter((o) => o.status === "upcoming" || o.status === "asked")
    .filter((o) => o.dueAt && o.dueAt <= horizon)
    .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)))
    .map((o) => ({ id: o.id, title: o.title, dueAt: o.dueAt, status: o.status, overdue: String(o.dueAt) < now.toISOString() }));
  return {
    consultation: {
      id: c.id,
      clientId: c.clientId,
      matterId: c.matterId ?? null,
      scheduledAt: c.scheduledAt,
      durationMin: c.durationMin,
      status: c.status,
      question: c.question ?? null,
      consent: c.consent ?? { recording: "pending" },
      transcript: c.transcript ?? null,
      summary: c.summary ?? null,
      suggestedNextSteps: Array.isArray(c.suggestedNextSteps) ? c.suggestedNextSteps : [],
      minutesUsed: c.minutesUsed ?? null,
      handoffId: c.handoffId ?? null,
      meetUrl: c.meetUrl ?? null,
      transcriptSource: str(c.transcriptSource),
    },
    who: {
      name: clientName(i.client, c.clientId),
      email: str(p.email),
      phone: str(p.phone),
      nationality: str(p.nationality),
      age: ageFrom(p.dateOfBirth),
      country: toCountryCode(p.legalCountry) ?? toCountryCode(p.country) ?? toCountryCode(p.jurisdiction) ?? "CR",
    },
    household: { maritalStatus: str(p.maritalStatus), dependents: p.dependents ?? null },
    residency: { status: str(p.residencyStatus), expiresAt: str(p.residencyExpiresAt) },
    assets: {
      property: { owns: yes(p.ownsProperty), location: str(p.propertyLocation) },
      company: { has: yes(p.hasCompany), type: str(p.companyType) },
      vehicle: { owns: yes(p.ownsVehicle) },
    },
    matters: openMatters.map((m) => ({
      id: m.id,
      title: m.title,
      area: m.area,
      stage: m.stage,
      stageLabel: getStageLabel(m.stage) || m.stage,
      stageEnteredAt: m.stageEnteredAt,
      nextStep: m.nextStep ?? null,
      current: m.id === c.matterId,
    })),
    obligations,
    completeness: i.completeness,
    membership: { minutesLeft: i.minutesLeft, callsLeft: i.callsLeft },
    priorSummaries: i.priorSummaries,
  };
}

// ─── Board card (pure; exported for tests) ─────────────────────────────────

export function buildCard(m: Matter, client: Obj | null, obligations: Obligation[], nextCallAt: string | null, now = new Date()) {
  const nowIso = now.toISOString();
  const in14 = new Date(now.getTime() + 14 * DAY).toISOString();
  const open = obligations.filter((o) => o.status === "upcoming" || o.status === "asked");
  return {
    id: m.id,
    clientId: m.clientId,
    clientName: clientName(client, m.clientId),
    title: m.title,
    area: m.area,
    country: m.country,
    stage: m.stage,
    stageEnteredAt: m.stageEnteredAt,
    nextStep: m.nextStep ?? null,
    overdueCount: open.filter((o) => o.dueAt && o.dueAt < nowIso).length,
    dueSoonCount: open.filter((o) => o.dueAt && o.dueAt >= nowIso && o.dueAt <= in14).length,
    nextCallAt,
  };
}

async function cardFor(m: Matter, providerId: string) {
  const [client, obligations, cons] = await Promise.all([
    get(COLLECTIONS.clients, m.clientId).catch(() => null),
    findRecords<Obligation>(COLLECTIONS.obligations, { clientId: m.clientId }),
    findRecords<Consultation>(COLLECTIONS.consultations, { clientId: m.clientId, providerId }),
  ]);
  const nowIso = new Date().toISOString();
  const next = cons.filter((c) => c.status === "booked" && c.scheduledAt >= nowIso)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
  return buildCard(m, client ? { ...(client as Obj), id: m.clientId } : null, obligations, next?.scheduledAt ?? null);
}

// ─── AI suggestion ─────────────────────────────────────────────────────────

const SUGGEST_PROMPT = `You draft a post-consultation note for the member's lawyer (licensed in Colombia, Costa Rica, Mexico, Panama, Portugal or Spain) to review.
From the transcript, return ONLY JSON: {"summary": string (3-5 plain sentences, what was discussed and concluded),
"nextSteps": [{"what": string, "who": "client" | "lawyer" | "ilp", "dueInDays": integer}] (1 to 5 items)}.
Do not give conclusions the transcript does not support. No prices, fees or sales suggestions.`;

export function parseSuggestion(raw: string): { summary: string; nextSteps: LegalNextStep[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSONFromLLMResponse(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Obj;
  const summary = str(o.summary);
  if (!summary) return null;
  const steps = (Array.isArray(o.nextSteps) ? o.nextSteps : []).slice(0, 5).flatMap((s) => {
    const x = s as Obj;
    const what = str(x.what);
    if (!what) return [];
    const who = x.who === "lawyer" || x.who === "ilp" ? x.who : "client";
    const days = Number(x.dueInDays);
    const dueAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * DAY).toISOString() : undefined;
    return [{ what, who, dueAt } as LegalNextStep];
  });
  return { summary, nextSteps: steps };
}

/**
 * Draft a summary + up to 5 legal next steps from a transcript and store them
 * as `summary.status: "suggested"` (never confirmed here). Shared by the
 * suggest route, the Meet transcript fetch and the audio upload (P3).
 * Returns null when the model gives nothing usable.
 */
export async function draftSuggestion(
  consultationId: string,
  transcript: string,
  opts: { saveTranscript?: boolean; transcriptSource?: string } = {},
): Promise<{ summary: { text: string; status: "suggested" }; suggestedNextSteps: LegalNextStep[] } | null> {
  let parsed: ReturnType<typeof parseSuggestion> = null;
  try {
    const out = await callLLMWithFallback({ systemInstruction: SUGGEST_PROMPT, prompt: transcript.slice(0, 60_000), temperature: 0.2, maxTokens: 900 });
    parsed = parseSuggestion(out.content);
  } catch (err) {
    log(`[provider] suggest failed for ${consultationId}: ${err instanceof Error ? err.message : err}`);
  }
  const fields: Obj = {};
  if (opts.saveTranscript) {
    fields.transcript = transcript.slice(0, 200_000);
    if (opts.transcriptSource) fields.transcriptSource = opts.transcriptSource;
  }
  if (parsed) {
    fields.summary = { text: parsed.summary, status: "suggested" };
    fields.suggestedNextSteps = parsed.nextSteps;
  }
  if (Object.keys(fields).length) await updateRecord(COLLECTIONS.consultations, consultationId, fields);
  return parsed ? { summary: { text: parsed.summary, status: "suggested" }, suggestedNextSteps: parsed.nextSteps } : null;
}

// ─── Routes ────────────────────────────────────────────────────────────────

export default function lawyerHomeRoutes(app: Express) {
  async function ownConsultation(req: Request, res: Response): Promise<(Consultation & Obj) | null> {
    const c = await getRecord<Consultation & Obj>(COLLECTIONS.consultations, req.params.id);
    if (!c || c.providerId !== pidOf(req)) {
      res.status(404).json({ error: "Consultation not found." });
      return null;
    }
    return c;
  }

  app.get(
    "/api/provider/today",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = pidOf(req);
      if (!pid) return res.status(401).json({ error: "No provider identity on session." });
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const from = str(req.query.from) ?? start.toISOString();
      const to = str(req.query.to) ?? new Date(start.getTime() + DAY).toISOString();
      const items = (await findRecords<Consultation & Obj>(COLLECTIONS.consultations, { providerId: pid }, { sortBy: "scheduledAt" }))
        .filter((c) => c.scheduledAt >= from && c.scheduledAt < to && c.status !== "cancelled");
      const [clients, matters] = await Promise.all([
        clientsById(items.map((c) => c.clientId)),
        Promise.all(items.map((c) => (c.matterId ? getRecord<Matter>(COLLECTIONS.matters, c.matterId) : Promise.resolve(null)))),
      ]);
      res.json({
        from,
        to,
        items: items.map((c, i) => ({
          id: c.id,
          clientId: c.clientId,
          clientName: clientName(clients.get(c.clientId) ?? null, c.clientId),
          matterId: c.matterId ?? null,
          matterTitle: matters[i]?.title ?? null,
          area: matters[i]?.area ?? null,
          scheduledAt: c.scheduledAt,
          durationMin: c.durationMin,
          status: c.status,
          question: c.question ?? null,
          consent: c.consent ?? { recording: "pending" },
          summaryStatus: c.summary?.status ?? null,
          handoffId: c.handoffId ?? null,
          // P3: the call itself
          meetUrl: str(c.meetUrl),
          linkPending: !c.meetUrl && c.status === "booked",
          completeness: Math.round(profileCompleteness(profileRecord(clients.get(c.clientId) ?? null)).score * 100),
          hasTranscript: !!str(c.transcript),
        })),
      });
    }),
  );

  app.get(
    "/api/provider/consultations/:id/brief",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await ownConsultation(req, res);
      if (!c) return;
      await ensureStageConfig();
      const b = await memberBundle(c.clientId);
      const priorSummaries = b.consultations
        .filter((x) => x.providerId === c.providerId && x.id !== c.id && x.summary?.status === "confirmed")
        .sort((a, z) => z.scheduledAt.localeCompare(a.scheduledAt))
        .slice(0, 2)
        .map((x) => ({ scheduledAt: x.scheduledAt, text: x.summary!.text }));
      res.json(buildBrief({
        consultation: c,
        client: b.client,
        matters: b.matters,
        obligations: b.obligations,
        completeness: b.completeness,
        minutesLeft: b.minutesLeft,
        callsLeft: b.callsLeft,
        priorSummaries,
      }));
    }),
  );

  app.post(
    "/api/provider/consultations/:id/suggest",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const c = await ownConsultation(req, res);
      if (!c) return;
      if (c.summary?.status === "confirmed") return res.status(409).json({ error: "Summary already confirmed." });
      const transcript = str(req.body?.transcript) ?? str(c.transcript);
      if (!transcript) return res.status(400).json({ error: "No transcript yet. Paste one or write the summary yourself." });
      if (str(req.body?.transcript) && c.consent?.recording !== "granted") {
        return res.status(409).json({ error: "Recording consent is not granted." });
      }
      const out = await draftSuggestion(c.id, transcript, { saveTranscript: !!str(req.body?.transcript) });
      if (!out) return res.status(502).json({ error: "Could not draft a summary. Write it yourself or try again." });
      res.json(out);
    }),
  );

  app.get(
    "/api/provider/clients/:id/brief",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = pidOf(req);
      const clientId = req.params.id;
      await ensureStageConfig();
      const b = await memberBundle(clientId);
      const assigned = b.client?.assignedProviderId === pid ||
        b.matters.some((m) => m.assignedProviderId === pid) ||
        b.consultations.some((c) => c.providerId === pid);
      if (!b.client || !assigned) return res.status(404).json({ error: "Member not found." });
      const mine = b.consultations
        .filter((c) => c.providerId === pid)
        .sort((a, z) => z.scheduledAt.localeCompare(a.scheduledAt));
      const nowIso = new Date().toISOString();
      const anchor = mine.filter((c) => c.status === "booked" && c.scheduledAt >= nowIso).pop() ?? mine[0] ??
        ({ id: "", clientId, providerId: pid, scheduledAt: "", durationMin: 0, status: "booked", consent: { recording: "pending" }, createdAt: "" } as Consultation);
      const brief = buildBrief({
        consultation: anchor as Consultation & Obj,
        client: b.client,
        matters: b.matters.filter((m) => !m.assignedProviderId || m.assignedProviderId === pid),
        obligations: b.obligations,
        completeness: b.completeness,
        minutesLeft: b.minutesLeft,
        callsLeft: b.callsLeft,
        priorSummaries: [],
      });
      res.json({
        ...brief,
        calls: mine.map((c) => ({
          id: c.id,
          scheduledAt: c.scheduledAt,
          status: c.status,
          question: c.question ?? null,
          minutesUsed: c.minutesUsed ?? null,
          summary: c.summary?.status === "confirmed" ? c.summary.text : null,
          summaryStatus: c.summary?.status ?? null,
          handoffId: c.handoffId ?? null,
        })),
      });
    }),
  );

  app.get(
    "/api/provider/board",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = pidOf(req);
      if (!pid) return res.status(401).json({ error: "No provider identity on session." });
      await ensureStageConfig();
      const includeClosed = req.query.closed === "1";
      const [matters, cons] = await Promise.all([
        findRecords<Matter>(COLLECTIONS.matters, { assignedProviderId: pid }, { sortBy: "stageEnteredAt" }),
        findRecords<Consultation>(COLLECTIONS.consultations, { providerId: pid }),
      ]);
      const visible = matters.filter((m) => includeClosed || !m.closedAt);
      if (isListRequest(req)) {
        // LISTS: one column (?stage=) or the whole list, a page at a time. Names,
        // obligations and next calls are loaded for the page's members only;
        // a search also needs every member's name, so it loads those first.
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const names = q ? await clientsById(visible.map((m) => m.clientId)) : new Map<string, Obj>();
        const spec: ListSpec<Matter> = {
          sorts: { stageEnteredAt: (m) => m.stageEnteredAt, openedAt: (m) => m.openedAt, title: (m) => m.title.toLowerCase() },
          defaultSort: "stageEnteredAt",
          filters: { stage: (m, v) => m.stage === v, area: (m, v) => m.area === v, country: (m, v) => String(m.country ?? "CR") === v },
          search: (m) => [m.title, m.area, clientName(names.get(m.clientId) ?? null, ""), m.country],
        };
        const area = typeof req.query.area === "string" ? req.query.area : "";
        const counts: Record<string, number> = {};
        for (const m of visible) if (!area || m.area === area) counts[m.stage] = (counts[m.stage] ?? 0) + 1;
        const stageIds = getStageIds();
        for (const st of Object.keys(counts)) if (!stageIds.includes(st)) stageIds.push(st);
        const areas = [...new Set(visible.map((m) => m.area).filter(Boolean))].sort();
        const nowIso = new Date().toISOString();
        return respondList(req, res, spec, (p) => ({
          produce: pageProducer(pageRows(visible, p, spec), async (chunk) => {
            const ids = [...new Set(chunk.map((m) => m.clientId))];
            const [clients, obligationLists] = await Promise.all([
              q ? Promise.resolve(names) : clientsById(ids),
              Promise.all(ids.map((id) => findRecords<Obligation>(COLLECTIONS.obligations, { clientId: id }))),
            ]);
            const obligationsBy = new Map(ids.map((id, i) => [id, obligationLists[i]]));
            const next = new Map<string, string>();
            for (const c of cons) {
              if (c.status !== "booked" || c.scheduledAt < nowIso) continue;
              const cur = next.get(c.clientId);
              if (!cur || c.scheduledAt < cur) next.set(c.clientId, c.scheduledAt);
            }
            return chunk.map((m) => buildCard(m, clients.get(m.clientId) ?? null, obligationsBy.get(m.clientId) ?? [], next.get(m.clientId) ?? null));
          }, 8),
          meta: { stages: stageIds, stageLabels: getStageLabels(), counts, areas, total: visible.length },
        }));
      }
      const clientIds = [...new Set(visible.map((m) => m.clientId))];
      const [clients, obligationLists] = await Promise.all([
        clientsById(clientIds),
        Promise.all(clientIds.map((id) => findRecords<Obligation>(COLLECTIONS.obligations, { clientId: id }))),
      ]);
      const obligationsBy = new Map(clientIds.map((id, i) => [id, obligationLists[i]]));
      const nowIso = new Date().toISOString();
      const nextCall = new Map<string, string>();
      for (const c of cons.filter((x) => x.status === "booked" && x.scheduledAt >= nowIso).sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))) {
        nextCall.set(c.clientId, c.scheduledAt);
      }
      const cards = visible.map((m) => buildCard(m, clients.get(m.clientId) ?? null, obligationsBy.get(m.clientId) ?? [], nextCall.get(m.clientId) ?? null));
      const stageIds = getStageIds();
      for (const c of cards) if (!stageIds.includes(c.stage)) stageIds.push(c.stage);
      res.json({ cards, stages: stageIds, stageLabels: getStageLabels(), total: cards.length });
    }),
  );

  app.patch(
    "/api/provider/matters/:id/stage",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = pidOf(req);
      const stage = str(req.body?.stage);
      await ensureStageConfig();
      if (!stage || !isValidStage(stage)) return res.status(400).json({ error: "Invalid stage." });
      const before = await getRecord<Matter>(COLLECTIONS.matters, req.params.id);
      if (!before || before.assignedProviderId !== pid) return res.status(404).json({ error: "Matter not found." });
      if (before.stage === stage) return res.json({ card: await cardFor(before, pid), previousStage: stage });
      const now = new Date().toISOString();
      const after = await updateRecord<Matter>(COLLECTIONS.matters, before.id, { stage, stageEnteredAt: now });
      if (!after) return res.status(404).json({ error: "Matter not found." });
      await onRecordUpdated("matters", before, after, { actor: emailOf(req) });
      void auditLog({
        actor: { uid: pid, email: emailOf(req), role: "lawyer" },
        action: "matter.stage_changed",
        target: `matters/${before.id}`,
        meta: { from: before.stage, to: stage, clientId: before.clientId },
      }).catch(() => {});
      res.json({ card: await cardFor(after, pid), previousStage: before.stage });
    }),
  );

  app.get(
    "/api/provider/finance",
    requireProviderAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const pid = pidOf(req);
      if (!pid) return res.status(401).json({ error: "No provider identity on session." });
      // The lawyer's clients: assigned on the client doc or through a matter.
      const [assignedClients, matters] = await Promise.all([
        query(COLLECTIONS.clients, [{ field: "assignedProviderId", op: "EQUAL", value: pid }]).catch(() => []),
        findRecords<Matter>(COLLECTIONS.matters, { assignedProviderId: pid }),
      ]);
      const clientIds = [...new Set([...assignedClients.map((d) => d.id), ...matters.map((m) => m.clientId)])];
      const lists = await Promise.all([
        ...clientIds.map((id) => query("quoteSettlements", [{ field: "clientId", op: "EQUAL", value: id }]).catch(() => [])),
        // Settlements that carry a denormalized providerIds array (see W5 Requests).
        query("quoteSettlements", [{ field: "providerIds", op: "ARRAY_CONTAINS", value: pid }]).catch(() => []),
      ]);
      const settlements = new Map<string, Obj>();
      for (const s of lists.flat()) settlements.set(s.id, s);
      const clients = new Map<string, Obj>(assignedClients.map((d) => [d.id, d as Obj]));
      const missing = [...settlements.values()].map((s) => String(s.clientId ?? "")).filter((id) => id && !clients.has(id));
      for (const [id, doc] of await clientsById(missing)) clients.set(id, doc);

      const payments: Obj[] = [];
      for (const s of settlements.values()) {
        const cid = String(s.clientId ?? "");
        const client = clients.get(cid) ?? null;
        const quotes = Array.isArray(client?.quotes) ? (client!.quotes as Obj[]) : [];
        const quote = quotes.find((q) => (q.quoteId ?? q.id) === s.id);
        const matter = matters.find((m) => m.clientId === cid);
        const rows = Array.isArray(s.providerPayments) ? (s.providerPayments as Obj[]) : [];
        rows.forEach((p, i) => {
          if (p?.providerId !== pid) return;
          payments.push({
            id: String(p.id ?? `${s.id}_${i}`),
            quoteId: s.id,
            quoteTitle: str(quote?.title),
            clientId: cid || null,
            clientName: clientName(client, cid),
            matterId: matter?.id ?? null,
            matterTitle: matter?.title ?? null,
            amount: Math.round((Number(p.amount) || 0) * 100) / 100,
            paid: p.paid === true,
            date: str(p.date),
            note: str(p.note),
          });
        });
      }
      payments.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
      const summary = summarizeFinance(pid, payments);
      if (isListRequest(req)) {
        // LISTS: payments page by page; totals and the per-matter rollup ride in the meta line.
        const spec: ListSpec<Obj> = {
          sorts: { date: (p) => String(p.date ?? ""), amount: (p) => Number(p.amount) || 0 },
          defaultSort: "date",
          defaultDir: "desc",
          filters: { paid: (p, v) => (v === "1" ? p.paid === true : v === "0" ? p.paid !== true : true), matter: (p, v) => String(p.matterId ?? p.quoteId ?? "") === v },
          search: (p) => [p.clientName, p.matterTitle, p.quoteTitle, p.note],
        };
        return respondList(req, res, spec, (lp) => ({
          produce: pageProducer(pageRows(payments, lp, spec)),
          meta: {
            currency: summary.currency,
            totals: summary.totals,
            byMatter: summary.byMatter,
            counts: { paid: payments.filter((x) => x.paid === true).length, pending: payments.filter((x) => x.paid !== true).length },
          },
        }));
      }
      res.json(summary);
    }),
  );
}

/** Totals and per-matter rollup for the lawyer's own fees. Pure; exported for tests. */
export function summarizeFinance(providerId: string, payments: Obj[]) {
  const round = (n: number) => Math.round(n * 100) / 100;
  let paid = 0;
  let pending = 0;
  const byMatter = new Map<string, { key: string; title: string; clientName: string; paid: number; pending: number; lastPayoutAt: string | null; nextPayoutAt: string | null }>();
  for (const p of payments) {
    const amt = Number(p.amount) || 0;
    if (p.paid) paid += amt;
    else pending += amt;
    const key = String(p.matterId ?? p.quoteId ?? "other");
    const row = byMatter.get(key) ?? {
      key,
      title: String(p.matterTitle ?? p.quoteTitle ?? "Other work"),
      clientName: String(p.clientName ?? ""),
      paid: 0,
      pending: 0,
      lastPayoutAt: null,
      nextPayoutAt: null,
    };
    const date = typeof p.date === "string" ? p.date : null;
    if (p.paid) {
      row.paid += amt;
      if (date && (!row.lastPayoutAt || date > row.lastPayoutAt)) row.lastPayoutAt = date;
    } else {
      row.pending += amt;
      if (date && (!row.nextPayoutAt || date < row.nextPayoutAt)) row.nextPayoutAt = date;
    }
    byMatter.set(key, row);
  }
  return {
    providerId,
    currency: "USD",
    totals: { paid: round(paid), pending: round(pending) },
    byMatter: [...byMatter.values()].map((r) => ({ ...r, paid: round(r.paid), pending: round(r.pending) })),
    payments,
    // Legacy keys for the old finance view.
    providerPayments: payments,
    totalEarned: round(paid),
    totalPending: round(pending),
    settlementCount: payments.length,
  };
}
