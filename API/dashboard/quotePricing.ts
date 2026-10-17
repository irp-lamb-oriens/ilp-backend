/**
 * quotePricing.ts — the one place that turns a quote line item's internal cost
 * into the price the client is charged.
 *
 * Extracted so the quotes router and the contract document compute the same
 * figure. Two margin modes are supported:
 *   'pct'  (default) — cost × (1 + marginPct / 100)
 *   'flat'           — cost + marginFlat (same currency as the line)
 */

/** Per-line client price (cost + margin), rounded to cents. */
export function lineClientPrice(item: any): number {
  const cost = typeof item?.amount === "number" ? item.amount : parseFloat(item?.amount) || 0;
  if (item?.marginMode === "flat") {
    const flat = typeof item.marginFlat === "number"
      ? item.marginFlat
      : (parseFloat(item.marginFlat) || 0);
    return Math.round((cost + flat) * 100) / 100;
  }
  const raw = item?.marginPct;
  const m = typeof raw === "number" ? raw : (!isNaN(parseFloat(raw)) ? parseFloat(raw) : 20);
  return Math.round(cost * (1 + m / 100) * 100) / 100;
}