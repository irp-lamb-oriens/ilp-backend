/**
 * API/referrals/reports.ts — every figure comes from referrals + commissions
 * + payouts (never a stored total), so the partner's "since we started" view
 * always matches the transfers.
 */
import type { ReferralStore } from "./store.ts";
import type { Brand, Commission, Partner, Payout, Referral } from "./types.ts";

export interface Totals {
  leads: number;
  customers: number;
  earnedCents: number; // not reversed, clawbacks netted
  paidCents: number; // payouts
  pendingCents: number; // pending + approved, not yet paid
  reversedCents: number;
}

export const emptyTotals = (): Totals => ({ leads: 0, customers: 0, earnedCents: 0, paidCents: 0, pendingCents: 0, reversedCents: 0 });

const ym = (iso: string) => iso.slice(0, 7);
const yr = (iso: string) => Number(iso.slice(0, 4));

function addCommission(t: Totals, c: Commission) {
  if (c.status === "reversed") {
    t.reversedCents += c.amountCents;
    return;
  }
  t.earnedCents += c.amountCents;
  if (c.status === "pending" || c.status === "approved") t.pendingCents += c.amountCents;
}

export function bucket(
  referrals: Referral[],
  commissions: Commission[],
  payouts: Payout[],
  keyOf: (iso: string) => string | null,
  opts: { brand?: Brand } = {},
): Map<string, Totals> {
  const m = new Map<string, Totals>();
  const at = (iso: string | undefined) => {
    if (!iso) return null;
    const k = keyOf(iso);
    if (k === null) return null;
    if (!m.has(k)) m.set(k, emptyTotals());
    return m.get(k)!;
  };
  for (const r of referrals) {
    if (opts.brand && r.brand !== opts.brand) continue;
    const t1 = at(r.firstSeenAt);
    if (t1) t1.leads++;
    if (r.status === "customer") {
      const t2 = at(r.convertedAt);
      if (t2) t2.customers++;
    }
  }
  for (const c of commissions) {
    if (opts.brand && c.brand !== opts.brand) continue;
    const t = at(c.earnedAt);
    if (t) addCommission(t, c);
  }
  if (opts.brand) {
    // A payout can mix brands: per brand, "paid" is that brand's paid lines.
    for (const c of commissions) {
      if (c.brand !== opts.brand || c.status !== "paid") continue;
      const t = at(c.paidAt);
      if (t) t.paidCents += c.amountCents;
    }
  } else {
    for (const p of payouts) {
      const t = at(p.paidAt);
      if (t) t.paidCents += p.totalCents;
    }
  }
  return m;
}

export interface PartnerStatement {
  partner: Pick<Partner, "id" | "name" | "email" | "type" | "brands" | "status" | "language" | "startedAt" | "monthlyEmail"> & {
    payout?: { method: string; holderName: string; bankName?: string; mask: string; updatedAt: string };
    taxFormStatus: Partner["taxFormStatus"];
  };
  lifetime: Totals;
  years: Array<Totals & { year: number }>;
  year: number;
  months: Array<Totals & { month: string }>;
  byBrand: Array<Totals & { brand: Brand }>;
  payouts: Array<Pick<Payout, "id" | "paidAt" | "totalCents" | "method" | "reference">>;
  recent: Array<Pick<Commission, "id" | "brand" | "saleKind" | "amountCents" | "status" | "earnedAt" | "paidAt" | "note">>;
  relationshipYears: number;
}

/** What the partner portal and the staff partner page show. Never lists the referred people's names or emails. */
export async function partnerStatement(store: ReferralStore, partnerId: string, opts: { year?: number; now?: string } = {}): Promise<PartnerStatement | null> {
  const p = await store.getPartner(partnerId);
  if (!p) return null;
  const now = opts.now ?? new Date().toISOString();
  const year = opts.year ?? yr(now);
  const [referrals, commissions, payouts] = await Promise.all([
    store.listReferrals({ partnerId }),
    store.listCommissions({ partnerId }),
    store.listPayouts({ partnerId }),
  ]);
  const lifetime = bucket(referrals, commissions, payouts, () => "all").get("all") ?? emptyTotals();
  const years = [...bucket(referrals, commissions, payouts, (iso) => String(yr(iso))).entries()]
    .map(([y, t]) => ({ year: Number(y), ...t }))
    .sort((a, b) => b.year - a.year);
  const byMonth = bucket(referrals, commissions, payouts, (iso) => (yr(iso) === year ? ym(iso) : null));
  const lastMonth = year === yr(now) ? Number(now.slice(5, 7)) : 12;
  const months = Array.from({ length: lastMonth }, (_, i) => {
    const k = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { month: k, ...(byMonth.get(k) ?? emptyTotals()) };
  });
  const byBrand = p.brands.map((brand) => ({ brand, ...(bucket(referrals, commissions, payouts, () => "all", { brand }).get("all") ?? emptyTotals()) }));
  return {
    partner: {
      id: p.id,
      name: p.name,
      email: p.email,
      type: p.type,
      brands: p.brands,
      status: p.status,
      language: p.language,
      startedAt: p.startedAt,
      monthlyEmail: p.monthlyEmail,
      taxFormStatus: p.taxFormStatus,
      ...(p.payout ? { payout: { method: p.payout.method, holderName: p.payout.holderName, bankName: p.payout.bankName, mask: p.payout.mask, updatedAt: p.payout.updatedAt } } : {}),
    },
    lifetime,
    years,
    year,
    months,
    byBrand,
    payouts: payouts.sort((a, b) => b.paidAt.localeCompare(a.paidAt)).map(({ id, paidAt, totalCents, method, reference }) => ({ id, paidAt, totalCents, method, reference })),
    recent: commissions
      .sort((a, b) => b.earnedAt.localeCompare(a.earnedAt))
      .slice(0, 50)
      .map(({ id, brand, saleKind, amountCents, status, earnedAt, paidAt, note }) => ({ id, brand, saleKind, amountCents, status, earnedAt, paidAt, ...(note && status !== "reversed" ? { note } : {}) })),
    relationshipYears: Math.max(0, Math.round(((Date.parse(now) - Date.parse(p.startedAt)) / (365.25 * 86_400_000)) * 10) / 10),
  };
}

export interface PartnerRow extends Totals {
  id: string;
  name: string;
  email: string;
  type: Partner["type"];
  brands: Brand[];
  status: Partner["status"];
  hasPayout: boolean;
  approvedCents: number;
  links: number;
  clicks: number;
  startedAt: string;
}

/** Staff partner list: lifetime totals per partner. */
export async function partnerRows(store: ReferralStore): Promise<PartnerRow[]> {
  const [partners, referrals, commissions, payouts, links] = await Promise.all([
    store.listPartners(),
    store.listReferrals({}),
    store.listCommissions({}),
    store.listPayouts({}),
    store.listLinks(),
  ]);
  return partners.map((p) => {
    const t = bucket(
      referrals.filter((r) => r.partnerId === p.id),
      commissions.filter((c) => c.partnerId === p.id),
      payouts.filter((x) => x.partnerId === p.id),
      () => "all",
    ).get("all") ?? emptyTotals();
    const mine = links.filter((l) => l.partnerId === p.id);
    return {
      ...t,
      id: p.id,
      name: p.name,
      email: p.email,
      type: p.type,
      brands: p.brands,
      status: p.status,
      hasPayout: !!p.payout,
      approvedCents: commissions.filter((c) => c.partnerId === p.id && c.status === "approved").reduce((s, c) => s + c.amountCents, 0),
      links: mine.length,
      clicks: mine.reduce((s, l) => s + (l.clicks ?? 0), 0),
      startedAt: p.startedAt,
    };
  }).sort((a, b) => b.earnedCents - a.earnedCents || a.name.localeCompare(b.name));
}

/** Year-end board: totals, 12 months, one row per partner. Optional brand filter. */
export async function yearReport(store: ReferralStore, year: number, opts: { brand?: Brand } = {}) {
  const [partners, referrals, commissions, payouts] = await Promise.all([
    store.listPartners(),
    store.listReferrals({}),
    store.listCommissions({}),
    store.listPayouts({}),
  ]);
  const inYear = (iso: string) => (yr(iso) === year ? "y" : null);
  const totals = bucket(referrals, commissions, payouts, inYear, opts).get("y") ?? emptyTotals();
  const mm = bucket(referrals, commissions, payouts, (iso) => (yr(iso) === year ? ym(iso) : null), opts);
  const months = Array.from({ length: 12 }, (_, i) => {
    const k = `${year}-${String(i + 1).padStart(2, "0")}`;
    return { month: k, ...(mm.get(k) ?? emptyTotals()) };
  });
  const rows = partners.map((p) => {
    const t = bucket(
      referrals.filter((r) => r.partnerId === p.id),
      commissions.filter((c) => c.partnerId === p.id),
      payouts.filter((x) => x.partnerId === p.id),
      inYear,
      opts,
    ).get("y") ?? emptyTotals();
    return { ...t, partnerId: p.id, name: p.name, type: p.type, conversionPct: t.leads ? Math.round((t.customers / t.leads) * 1000) / 10 : 0 };
  }).filter((r) => r.leads || r.customers || r.earnedCents || r.paidCents || r.reversedCents)
    .sort((a, b) => b.earnedCents - a.earnedCents);
  const years = [...new Set([...commissions.map((c) => yr(c.earnedAt)), ...referrals.map((r) => yr(r.firstSeenAt)), year])].sort((a, b) => b - a);
  return { year, brand: opts.brand ?? null, totals, months, rows, years };
}
