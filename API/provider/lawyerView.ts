/**
 * API/provider/lawyerView.ts — what a lawyer (provider) may see and change.
 * ──────────────────────────────────────────────────────────────────────────
 * Master plan sections 9 and 24.1: lawyer judgment stays separate from
 * commercial follow-up. Lawyers see their own fee, never ILP's margin, the
 * client price built on top of it, or CSM commercial notes.
 *
 * `stripProviderResponses` is mounted on /api/provider and /api/lawyer so
 * every JSON response passes through `toLawyerPayload`, whichever route
 * produced it. Routes should still avoid loading hidden data where they can;
 * this is the last line, not the only one.
 */

import type { NextFunction, Request, Response } from "express";
import { LAWYER_HIDDEN_FIELDS } from "../../schemas/contracts.ts";

/**
 * LAWYER_HIDDEN_FIELDS (contracts) plus quote fields that reveal the margin
 * indirectly: `earnings` is client price minus cost, the margin modes/amounts
 * and the default margin are the inputs. `rankIndex`/`priorityRank` are ILP's
 * internal prioritisation.
 */
export const PROVIDER_HIDDEN_FIELDS: readonly string[] = [
  ...LAWYER_HIDDEN_FIELDS,
  "earnings",
  "marginMode",
  "marginFlat",
  "defaultMarginPct",
  "clientPrice",
  "rankIndex",
  "priorityRank",
];

/** Client-record fields a lawyer may edit. Identity and ILP ranking are staff-only. */
export const LAWYER_EDITABLE_CLIENT_FIELDS: readonly string[] = [
  "legalArea",
  "legalMatter",
  "jurisdiction",
];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

const num = (v: unknown) => (typeof v === "number" ? v : parseFloat(String(v ?? ""))) || 0;

/** A quote document: has a quote id and line items. */
function isQuote(o: Obj): boolean {
  return ("quoteId" in o || "lineGroups" in o) && Array.isArray(o.lineItems);
}

/** Sum of the lines that are this lawyer's fee (their own lines, or unassigned lines). */
export function lawyerFee(lineItems: unknown[], providerId?: string): number {
  let sum = 0;
  for (const li of lineItems) {
    if (!isObj(li)) continue;
    const owner = li.providerId;
    if (!providerId || !owner || owner === providerId) sum += num(li.amount);
  }
  return Math.round(sum * 100) / 100;
}

/**
 * Deep copy with hidden fields removed. Quote documents also lose `total`
 * (the client price, which with the fee would reveal the margin) and gain
 * `yourFee`.
 */
export function toLawyerPayload<T>(value: T, providerId?: string): T {
  const hidden = new Set(PROVIDER_HIDDEN_FIELDS);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const quote = isQuote(v);
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      if (hidden.has(k)) continue;
      if (quote && k === "total") continue;
      out[k] = walk(x);
    }
    if (quote) out.yourFee = lawyerFee(v.lineItems as unknown[], providerId);
    return out;
  };
  return walk(value) as T;
}

/** Every hidden key path found in a payload (used by tests and as a dev guard). */
export function findHiddenKeys(value: unknown, path = "$"): string[] {
  const hidden = new Set(PROVIDER_HIDDEN_FIELDS);
  const found: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (!isObj(v)) return;
    const quote = isQuote(v);
    for (const [k, x] of Object.entries(v)) {
      if (hidden.has(k) || (quote && k === "total")) found.push(`${p}.${k}`);
      walk(x, `${p}.${k}`);
    }
  };
  walk(value, path);
  return found;
}

/** Express middleware: filter every res.json body through toLawyerPayload. */
export function stripProviderResponses(req: Request, res: Response, next: NextFunction) {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => {
    const pid = (req as Request & { providerId?: string }).providerId;
    return original(toLawyerPayload(body, pid));
  }) as Response["json"];
  next();
}

/**
 * Merge line items a lawyer sent with the stored ones: the lawyer controls
 * label, fee (amount), notes and optional flag; margin fields always come
 * from the stored line (or the quote's default for a new line), so a lawyer
 * edit can neither read nor overwrite ILP's margin.
 */
export function mergeLawyerLineItems(
  incoming: unknown,
  existing: unknown,
  defaultMarginPct: number,
): Obj[] {
  const prev = new Map<string, Obj>();
  for (const li of Array.isArray(existing) ? existing : []) {
    if (isObj(li) && typeof li.lineId === "string") prev.set(li.lineId, li);
  }
  return (Array.isArray(incoming) ? incoming : []).filter(isObj).map((li) => {
    const old = typeof li.lineId === "string" ? prev.get(li.lineId) : undefined;
    return {
      ...li,
      marginPct: old?.marginPct ?? defaultMarginPct,
      marginMode: old?.marginMode ?? "pct",
      marginFlat: old?.marginFlat ?? null,
    };
  });
}

/** Same as mergeLawyerLineItems for grouped quotes. */
export function mergeLawyerLineGroups(
  incoming: unknown,
  existingLineItems: unknown,
  defaultMarginPct: number,
): Obj[] | null {
  if (!Array.isArray(incoming)) return null;
  return incoming.filter(isObj).map((g) => ({
    ...g,
    lineItems: mergeLawyerLineItems(g.lineItems, existingLineItems, defaultMarginPct),
  }));
}
