/**
 * API/dashboard/actions/requestQuoteFromProvidersAction.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REAL handler for the `request_quote_from_providers` action.
 *
 * Matches active providers against the client's legalArea/jurisdiction
 * (providerTaxonomy), then creates an RFQ quoteRequest doc per matched provider
 * in the `clients/{id}/quoteRequests` subcollection — the same shape the
 * providerRfqDashboardRouter reads.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import getAll from "../../../db/getAll.ts";
import log from "../../../helper/log.ts";
import { inferProviderCriteria, filterProviders } from "./providerTaxonomy.ts";
import type { Provider, LegalArea } from "../providersRouter.ts";
import type { ActionContext, ActionResult } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

function requestsPath(clientId: string): string {
  return `${CLIENTS_COLLECTION}/${clientId}/quoteRequests`;
}

function newRequestId(): string {
  return `rfq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function requestQuoteFromProvidersAction(
  ctx: ActionContext,
): Promise<ActionResult> {
  const { clientId, args, actor } = ctx;

  const doc = (await get(CLIENTS_COLLECTION, clientId)) ?? ctx.clientDoc ?? {};
  const criteria = inferProviderCriteria(doc);

  // Optional operator overrides for the match dimensions.
  const areaOverride = typeof args?.legalArea === "string" && args.legalArea
    ? (args.legalArea.trim() as LegalArea)
    : null;
  const jurisdictionOverride = typeof args?.jurisdiction === "string"
    ? args.jurisdiction.trim().toUpperCase()
    : null;

  const effCriteria = {
    legalArea: areaOverride ?? criteria.legalArea,
    jurisdiction: jurisdictionOverride ?? criteria.jurisdiction,
  };

  if (!effCriteria.legalArea && !effCriteria.jurisdiction) {
    return {
      success: false,
      message:
        "No legal area or jurisdiction on the client. Set them (or pass overrides) before requesting quotes.",
      data: { reason: "no_criteria" },
    };
  }

  const providers = (await getAll("providers").catch(() => [])) as Provider[];
  const matched = filterProviders(providers, effCriteria);

  if (matched.length === 0) {
    return {
      success: false,
      message:
        "No active providers match this client's legal area / jurisdiction.",
      data: { matched: 0, criteria: effCriteria },
    };
  }

  const nowIso = new Date().toISOString();
  const created: Array<{ requestId: string; providerId: string; providerName: string }> = [];

  for (const p of matched) {
    const requestId = newRequestId();
    await put(requestsPath(clientId), requestId, {
      requestId,
      providerId: p.id,
      providerName: p.name,
      providerEmail: p.email,
      status: "sent",
      sentAt: nowIso,
      expiresAt: null,
      providerResponse: null,
      operatorOverride: null,
      reviewedAt: null,
      reviewedBy: null,
      createdBy: actor,
      createdAt: nowIso,
    });
    created.push({ requestId, providerId: p.id, providerName: p.name });
  }

  log(
    `[request_quote] ${clientId} → ${created.length} RFQ requests created by ${actor}`,
  );

  return {
    success: true,
    message: `Requested quotes from ${created.length} matching provider(s).`,
    data: { matched: created, criteria: effCriteria },
  };
}