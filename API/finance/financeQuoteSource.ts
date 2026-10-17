/**
 * financeQuoteSource.ts — the one way the finance endpoints read quotes.
 *
 * ILP adaptation: quotes live as an ARRAY on the `clients/{id}` doc (field
 * `quotes`), not as a `consultations/{id}/quotes` subcollection. So there is no
 * collection-group query: we read every client doc and flatten its `quotes`
 * array, then join each quote with the jurisdiction, stage, and client name of
 * its parent client.
 *
 * Both the metrics endpoint and the ledger endpoint read from here. If they
 * each kept their own copy, one could start counting a quote the other ignores,
 * and the two screens would quietly disagree about the same money.
 */

import getAll from "../../db/getAll.ts";
import { buildClientSummary } from "../dashboard/clientHelpers.ts";

/** The quote status that means the client said yes. */
export const WON_STATUS = "client_accepted";

/** Client facts each quote is joined against. */
export interface ClientFacts {
  jurisdiction: string;
  stage: string;
  clientName: string;
}

/**
 * How long a completed read stays reusable.
 *
 * The metrics endpoint and the ledger endpoint read exactly the same quotes,
 * and the Finance view can ask for both within a second of each other. Without
 * this, the second request repeats the entire scan. Thirty seconds is short
 * enough that an edited quote shows up on the next refresh, and long enough
 * that switching between the two sections is instant.
 */
const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

let quotesCache: CacheEntry<Array<Record<string, unknown>>> | null = null;
let factsCache: CacheEntry<Map<string, ClientFacts>> | null = null;

function fresh<T>(entry: CacheEntry<T> | null): Promise<T> | null {
  if (!entry) return null;
  return Date.now() - entry.at < CACHE_TTL_MS ? entry.value : null;
}

/**
 * Drop the cached read. Call after writing a quote if the next Finance load
 * must reflect it immediately rather than within the TTL.
 */
export function invalidateFinanceCache(): void {
  quotesCache = null;
  factsCache = null;
}

/**
 * Every quote document in the database, flattened from the `quotes` array on
 * each client doc. The parent client id is attached to each quote so it can be
 * joined against client facts.
 */
export function fetchAllQuotes(): Promise<Array<Record<string, unknown>>> {
  const cached = fresh(quotesCache);
  if (cached) return cached;

  const value = readAllQuotes();
  quotesCache = { at: Date.now(), value };
  // A failed read must not be served for the rest of the TTL.
  value.catch(() => {
    quotesCache = null;
  });
  return value;
}

async function readAllQuotes(): Promise<Array<Record<string, unknown>>> {
  const docs = await getAll("clients");
  const rows: Array<Record<string, unknown>> = [];

  for (const doc of docs ?? []) {
    if (!doc?.id) continue;
    const quotes = Array.isArray(doc.quotes) ? doc.quotes : [];
    for (const q of quotes) {
      if (!q || typeof q !== "object") continue;
      const quote = q as Record<string, unknown>;
      rows.push({
        ...quote,
        quoteId: String(quote.quoteId ?? quote.id ?? ""),
        clientId: String(doc.id),
      });
    }
  }

  return rows;
}

/**
 * The join table of client facts.
 *
 * Jurisdiction and client name come from the client summary, matching how the
 * CRM resolves them, so a client who re-submitted the form is measured on the
 * matter actually being quoted.
 */
export function fetchClientFacts(): Promise<Map<string, ClientFacts>> {
  const cached = fresh(factsCache);
  if (cached) return cached;

  const value = readClientFacts();
  factsCache = { at: Date.now(), value };
  value.catch(() => {
    factsCache = null;
  });
  return value;
}

async function readClientFacts(): Promise<Map<string, ClientFacts>> {
  const docs = await getAll("clients");
  const facts = new Map<string, ClientFacts>();

  for (const doc of docs ?? []) {
    if (!doc?.id) continue;
    const summary = buildClientSummary(String(doc.id), doc as Record<string, unknown>);
    const name = [summary.name, summary.surname].filter(Boolean).join(" ").trim();
    facts.set(String(doc.id), {
      jurisdiction: typeof summary.jurisdiction === "string" ? summary.jurisdiction : "",
      stage: typeof summary.stage === "string" ? summary.stage : "",
      clientName: name || (typeof summary.email === "string" ? summary.email : ""),
    });
  }

  return facts;
}

/** Quotes joined with their client facts. */
export async function fetchQuotesWithFacts(): Promise<{
  quotes: Array<Record<string, unknown>>;
  facts: Map<string, ClientFacts>;
}> {
  const [quotes, facts] = await Promise.all([
    fetchAllQuotes(),
    fetchClientFacts(),
  ]);

  const joined = quotes.map((q) => {
    const f = facts.get(String(q.clientId ?? ""));
    return {
      ...q,
      jurisdiction: f?.jurisdiction ?? null,
      pipelineStage: f?.stage ?? null,
      clientName: f?.clientName ?? null,
    };
  });

  return { quotes: joined, facts };
}

/**
 * Only the quotes a client accepted. These are the ones that owe and are owed
 * real money, so they are the only ones the settlement table lists.
 */
export async function fetchAcceptedQuotes(): Promise<
  Array<Record<string, unknown>>
> {
  const { quotes } = await fetchQuotesWithFacts();
  return quotes.filter((q) => q.status === WON_STATUS);
}