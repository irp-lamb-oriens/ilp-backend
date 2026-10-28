/**
 * API/clientStatus/memberDeadlines.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DEADLINES: the person's own deadlines on /status/deadlines. Members and
 * free accounts both use these routes; every route is scoped to the
 * session's clientId (staff previewing pass ?clientId=, per W1).
 *
 *   GET   /api/client-status/me/deadlines                   list (paged contract of helper/listing.ts, schema memberDeadlines)
 *   GET   /api/client-status/me/deadlines/available?country= rules not on the list yet, for the picker
 *   POST  /api/client-status/me/deadlines                   { country, ruleIds[] , claimToken? } add from the picker (or finish a claim)
 *   PATCH /api/client-status/me/deadlines/:id               { userDueAt?, status?, remind?, dismissed?, notes? }
 *
 * Removed deadlines (dismissed) leave the list and come back in the picker.
 */

import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import auditLog from "../../helper/auditLog.ts";
import { isListRequest, type ListSpec, pageProducer, pageRows, respondList } from "../../helper/listing.ts";
import { LIST_SCHEMAS } from "../../schemas/listSchemas.ts";
import { type AuthedRequest, requireClientAuth } from "../../helper/auth/session.ts";
import { accountTypeOf, COLLECTIONS, COUNTRY_ANSWERS_FIELD, type CountryCode, type Obligation, toCountryCode } from "../../schemas/contracts.ts";
import { createRecord, currentMembership, findRecords, forClient, getRecord, updateRecord } from "../members/service.ts";
import { onRecordUpdated } from "../members/events.ts";
import {
  cleanRuleIds,
  type DeadlineView,
  deadlineView,
  factsFor,
  mergeChosen,
  obligationsForRules,
  parseDeadlinePatch,
  pickerItems,
  visibleDeadlines,
} from "../members/deadlines.ts";
import { sha256Hex } from "../privacy/policy.ts";
import { CLAIMS_COLLECTION, claimUsable } from "../leads/claim.ts";

type Doc = Record<string, unknown>;

function clientIdOf(req: Request, res: Response): string | null {
  const id = (req as AuthedRequest).clientId;
  if (!id) {
    res.status(400).json({ error: "No member selected for this session." });
    return null;
  }
  return id;
}

/** The person's country: membership first, then the record. */
async function personCountry(clientId: string, client: Doc | null): Promise<CountryCode> {
  const m = await currentMembership(clientId).catch(() => null);
  return toCountryCode(m?.country) ?? toCountryCode(client?.legalCountry) ?? toCountryCode(client?.country) ?? "CR";
}

/** Facts for date calculations: the person's own answers when they are for this country. */
function personFacts(client: Doc | null, country: CountryCode, home: CountryCode) {
  const answers = country === home && client?.[COUNTRY_ANSWERS_FIELD] && typeof client[COUNTRY_ANSWERS_FIELD] === "object"
    ? (client[COUNTRY_ANSWERS_FIELD] as Doc)
    : {};
  return factsFor(country, answers);
}

const listSpec: ListSpec<DeadlineView> = {
  sorts: {
    shownDueAt: (d) => d.shownDueAt ?? "9999",
    title: (d) => d.title.toLowerCase(),
  },
  defaultSort: "shownDueAt",
  defaultDir: "asc",
  filters: {
    area: (d, v) => d.area === v,
    status: (d, v) => d.status === v,
    source: (d, v) => d.source === v,
    group: (d, v) => d.group === v,
  },
  search: (d) => [d.title, d.meaning, d.notes ?? ""],
  schema: LIST_SCHEMAS.memberDeadlines,
};

export function registerMemberDeadlineRoutes(app: Express) {
  app.get(
    "/api/client-status/me/deadlines",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const [client, membership, all] = await Promise.all([
        get(COLLECTIONS.clients, id).catch(() => null) as Promise<Doc | null>,
        currentMembership(id).catch(() => null),
        findRecords<Obligation>(COLLECTIONS.obligations, { clientId: id }, { sortBy: "dueAt" }),
      ]);
      const now = new Date();
      const rows = visibleDeadlines(all).map((o) => deadlineView(o, now));
      const counts = { soon: 0, later: 0, needsDate: 0, done: 0 };
      for (const r of rows) counts[r.group]++;
      const meta = {
        account: accountTypeOf(client, membership),
        country: toCountryCode(membership?.country) ?? toCountryCode(client?.legalCountry) ?? toCountryCode(client?.country) ?? "CR",
        counts,
        total: rows.length,
      };
      if (isListRequest(req)) {
        return respondList(req, res, listSpec, (p) => ({
          produce: pageProducer(pageRows(rows, p, listSpec), (chunk) => forClient(chunk)),
          meta,
        }));
      }
      res.json({ items: forClient(rows), ...meta });
    }),
  );

  app.get(
    "/api/client-status/me/deadlines/available",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const client = (await get(COLLECTIONS.clients, id).catch(() => null)) as Doc | null;
      const home = await personCountry(id, client);
      const asked = typeof req.query.country === "string" && req.query.country ? toCountryCode(req.query.country) : home;
      if (!asked) return res.status(400).json({ error: "Choose Colombia, Costa Rica, Mexico, Panama, Portugal or Spain." });
      const have = await findRecords<Obligation>(COLLECTIONS.obligations, { clientId: id });
      const items = pickerItems(asked, personFacts(client, asked, home), have);
      res.json({ country: asked, homeCountry: home, items });
    }),
  );

  app.post(
    "/api/client-status/me/deadlines",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const body = (req.body ?? {}) as Doc;
      const client = (await get(COLLECTIONS.clients, id).catch(() => null)) as Doc | null;
      if (!client) return res.status(404).json({ error: "We could not find your ILP record." });
      const home = await personCountry(id, client);
      const country = body.country === undefined ? home : toCountryCode(body.country);
      if (!country) return res.status(400).json({ error: "Choose Colombia, Costa Rica, Mexico, Panama, Portugal or Spain." });
      const { ruleIds, unknown } = cleanRuleIds(country, body.ruleIds);
      if (!ruleIds.length) {
        return res.status(400).json({ error: unknown.length ? "Those deadlines are not on the list for this country." : "Choose at least one deadline to add." });
      }
      // A claim token from the free check (this person's, unexpired, unused) marks them as from the check.
      let source: Obligation["source"] = "picker";
      let claimHash: string | null = null;
      if (typeof body.claimToken === "string" && body.claimToken) {
        claimHash = await sha256Hex(body.claimToken);
        const claim = (await get(CLAIMS_COLLECTION, claimHash).catch(() => null)) as Doc | null;
        if (claimUsable(claim, id)) source = "check";
        else claimHash = null;
      }
      const now = new Date();
      const fresh = obligationsForRules(id, country, ruleIds, personFacts(client, country, home), source, now);
      let created = 0, restored = 0, kept = 0;
      const out: Obligation[] = [];
      for (const o of fresh) {
        const existing = await getRecord<Obligation>(COLLECTIONS.obligations, o.id);
        const step = mergeChosen(existing, o);
        if (step.action === "create") {
          out.push(await createRecord(COLLECTIONS.obligations, o));
          created++;
        } else if (step.action === "restore") {
          const after = await updateRecord<Obligation>(COLLECTIONS.obligations, o.id, step.fields as Doc);
          if (after) out.push(after);
          restored++;
        } else {
          if (existing) out.push(existing);
          kept++;
        }
      }
      if (claimHash) await patch(CLAIMS_COLLECTION, claimHash, { usedAt: now.toISOString() }).catch(() => undefined);
      if (created || restored) {
        await auditLog({
          actor: { uid: id, email: String((req as AuthedRequest).clientUser ?? ""), role: (req as AuthedRequest).isIrpStaff ? "staff" : "client" },
          action: "deadlines.added",
          target: `clients/${id}`,
          meta: { country, source, created, restored, ruleIds },
        });
      }
      log(`[deadlines] ${id}: ${created} added, ${restored} restored, ${kept} already on the list (${source})`);
      res.status(created ? 201 : 200).json(forClient({ created, restored, kept, items: out.map((o) => deadlineView(o, now)) }));
    }),
  );

  app.patch(
    "/api/client-status/me/deadlines/:id",
    requireClientAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const id = clientIdOf(req, res);
      if (!id) return;
      const o = await getRecord<Obligation>(COLLECTIONS.obligations, req.params.id);
      if (!o || o.clientId !== id) return res.status(404).json({ error: "We could not find that deadline." });
      const fields = parseDeadlinePatch(req.body, o);
      if ("error" in fields) return res.status(400).json({ error: fields.error });
      const after = await updateRecord<Obligation>(COLLECTIONS.obligations, o.id, fields as Doc);
      if (!after) return res.status(404).json({ error: "We could not find that deadline." });
      await onRecordUpdated("obligations", o as unknown as Doc, after as unknown as Doc, { actor: String((req as AuthedRequest).clientUser ?? "") });
      res.json(forClient(deadlineView(after)));
    }),
  );
}
