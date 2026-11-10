/**
 * API/referrals/store.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Storage port for the referral engine, plus the Firestore implementation
 * (through db/ wrappers, rules.md §4) and an in-memory one for tests.
 *
 * Collections (top level, each doc stores its own id):
 *   referral_partners, referral_rules, referral_links, referrals,
 *   referral_commissions, referral_payouts, referral_first_paid
 * Queries use single-field equality only (no composite index needed); the
 * rest is filtered in memory, fine at partner-program size (hundreds to a
 * few thousand lines a year).
 */
import get from "../../db/get.ts";
import getAll from "../../db/getAll.ts";
import query, { type QueryFilter } from "../../db/query.ts";
import replace from "../../db/replace.ts";
import auditLog from "../../helper/auditLog.ts";
import type { Brand, Commission, CommissionRule, Partner, Payout, Referral, ReferralLink } from "./types.ts";

export const RC = {
  partners: "referral_partners",
  rules: "referral_rules",
  links: "referral_links",
  referrals: "referrals",
  commissions: "referral_commissions",
  payouts: "referral_payouts",
  firstPaid: "referral_first_paid",
} as const;

export interface Actor {
  uid: string;
  email: string;
  role: string;
}

export interface ReferralStore {
  getPartner(id: string): Promise<Partner | null>;
  findPartnerByEmail(email: string): Promise<Partner | null>;
  listPartners(): Promise<Partner[]>;
  savePartner(p: Partner): Promise<void>;

  getRule(id: string): Promise<CommissionRule | null>;
  listRules(): Promise<CommissionRule[]>;
  saveRule(r: CommissionRule): Promise<void>;

  getLinkByCode(code: string): Promise<ReferralLink | null>;
  getLink(id: string): Promise<ReferralLink | null>;
  listLinks(partnerId?: string): Promise<ReferralLink[]>;
  saveLink(l: ReferralLink): Promise<void>;

  getReferral(id: string): Promise<Referral | null>;
  listReferrals(f: { partnerId?: string; brand?: Brand }): Promise<Referral[]>;
  saveReferral(r: Referral): Promise<void>;

  getCommission(id: string): Promise<Commission | null>;
  listCommissions(f: { partnerId?: string; status?: Commission["status"]; brand?: Brand; saleRef?: string }): Promise<Commission[]>;
  saveCommission(c: Commission): Promise<void>;

  listPayouts(f: { partnerId?: string }): Promise<Payout[]>;
  savePayout(p: Payout): Promise<void>;

  /** First paid sale of a client on a brand: written once, never moved. Returns the stored value. */
  firstPaidAt(brand: Brand, clientId: string, at: string): Promise<string>;

  audit(actor: Actor, action: string, target: string, meta?: Record<string, unknown>): Promise<void>;
}

type Doc = Record<string, unknown>;
const clean = <T>(v: T): T => JSON.parse(JSON.stringify(v));

async function byField<T>(collection: string, field: string, value: string): Promise<T[]> {
  const docs = await query(collection, [{ field, op: "EQUAL", value } as QueryFilter]);
  return (docs as Doc[]).filter((d) => d && typeof d.id === "string") as unknown as T[];
}

async function all<T>(collection: string): Promise<T[]> {
  return ((await getAll(collection)) as Doc[]).filter((d) => d && typeof d.id === "string") as unknown as T[];
}

async function one<T>(collection: string, id: string): Promise<T | null> {
  if (!id) return null;
  const d = await get(collection, id).catch(() => null);
  return d ? ({ ...(d as Doc), id } as unknown as T) : null;
}

const write = (collection: string, id: string, v: unknown) => replace(collection, id, clean(v) as Doc);

export const firestoreReferralStore: ReferralStore = {
  getPartner: (id) => one<Partner>(RC.partners, id),
  findPartnerByEmail: async (email) => (await byField<Partner>(RC.partners, "email", email.trim().toLowerCase()))[0] ?? null,
  listPartners: () => all<Partner>(RC.partners),
  savePartner: (p) => write(RC.partners, p.id, p),

  getRule: (id) => one<CommissionRule>(RC.rules, id),
  listRules: () => all<CommissionRule>(RC.rules),
  saveRule: (r) => write(RC.rules, r.id, r),

  getLinkByCode: async (code) => (await byField<ReferralLink>(RC.links, "code", code.toLowerCase()))[0] ?? null,
  getLink: (id) => one<ReferralLink>(RC.links, id),
  listLinks: (partnerId) => partnerId ? byField<ReferralLink>(RC.links, "partnerId", partnerId) : all<ReferralLink>(RC.links),
  saveLink: (l) => write(RC.links, l.id, l),

  getReferral: (id) => one<Referral>(RC.referrals, id),
  listReferrals: async (f) => {
    const rows = f.partnerId ? await byField<Referral>(RC.referrals, "partnerId", f.partnerId) : await all<Referral>(RC.referrals);
    return rows.filter((r) => !f.brand || r.brand === f.brand);
  },
  saveReferral: (r) => write(RC.referrals, r.id, r),

  getCommission: (id) => one<Commission>(RC.commissions, id),
  listCommissions: async (f) => {
    const rows = f.partnerId
      ? await byField<Commission>(RC.commissions, "partnerId", f.partnerId)
      : f.saleRef
      ? await byField<Commission>(RC.commissions, "saleRef", f.saleRef)
      : f.status
      ? await byField<Commission>(RC.commissions, "status", f.status)
      : await all<Commission>(RC.commissions);
    return rows.filter((c) =>
      (!f.status || c.status === f.status) && (!f.brand || c.brand === f.brand) && (!f.saleRef || c.saleRef === f.saleRef)
    );
  },
  saveCommission: (c) => write(RC.commissions, c.id, c),

  listPayouts: (f) => f.partnerId ? byField<Payout>(RC.payouts, "partnerId", f.partnerId) : all<Payout>(RC.payouts),
  savePayout: (p) => write(RC.payouts, p.id, p),

  firstPaidAt: async (brand, clientId, at) => {
    const id = `${brand}__${clientId}`.replace(/[/]/g, "_");
    const existing = await one<{ at: string }>(RC.firstPaid, id);
    if (existing?.at) return existing.at;
    await write(RC.firstPaid, id, { id, brand, clientId, at });
    return at;
  },

  audit: (actor, action, target, meta) => auditLog({ actor, action, target, ...(meta ? { meta } : {}) }),
};

/** In-memory store for tests. */
export class MemoryReferralStore implements ReferralStore {
  partners = new Map<string, Partner>();
  rules = new Map<string, CommissionRule>();
  links = new Map<string, ReferralLink>();
  referrals = new Map<string, Referral>();
  commissions = new Map<string, Commission>();
  payouts = new Map<string, Payout>();
  first = new Map<string, string>();
  auditLog: Array<{ actor: Actor; action: string; target: string; meta?: Record<string, unknown> }> = [];

  getPartner(id: string) { return Promise.resolve(clean(this.partners.get(id) ?? null)); }
  findPartnerByEmail(email: string) {
    const e = email.trim().toLowerCase();
    return Promise.resolve(clean([...this.partners.values()].find((p) => p.email === e) ?? null));
  }
  listPartners() { return Promise.resolve(clean([...this.partners.values()])); }
  savePartner(p: Partner) { this.partners.set(p.id, clean(p)); return Promise.resolve(); }

  getRule(id: string) { return Promise.resolve(clean(this.rules.get(id) ?? null)); }
  listRules() { return Promise.resolve(clean([...this.rules.values()])); }
  saveRule(r: CommissionRule) { this.rules.set(r.id, clean(r)); return Promise.resolve(); }

  getLinkByCode(code: string) { return Promise.resolve(clean([...this.links.values()].find((l) => l.code === code.toLowerCase()) ?? null)); }
  getLink(id: string) { return Promise.resolve(clean(this.links.get(id) ?? null)); }
  listLinks(partnerId?: string) { return Promise.resolve(clean([...this.links.values()].filter((l) => !partnerId || l.partnerId === partnerId))); }
  saveLink(l: ReferralLink) { this.links.set(l.id, clean(l)); return Promise.resolve(); }

  getReferral(id: string) { return Promise.resolve(clean(this.referrals.get(id) ?? null)); }
  listReferrals(f: { partnerId?: string; brand?: Brand }) {
    return Promise.resolve(clean([...this.referrals.values()].filter((r) => (!f.partnerId || r.partnerId === f.partnerId) && (!f.brand || r.brand === f.brand))));
  }
  saveReferral(r: Referral) { this.referrals.set(r.id, clean(r)); return Promise.resolve(); }

  getCommission(id: string) { return Promise.resolve(clean(this.commissions.get(id) ?? null)); }
  listCommissions(f: { partnerId?: string; status?: Commission["status"]; brand?: Brand; saleRef?: string }) {
    return Promise.resolve(clean([...this.commissions.values()].filter((c) =>
      (!f.partnerId || c.partnerId === f.partnerId) && (!f.status || c.status === f.status) &&
      (!f.brand || c.brand === f.brand) && (!f.saleRef || c.saleRef === f.saleRef)
    )));
  }
  saveCommission(c: Commission) { this.commissions.set(c.id, clean(c)); return Promise.resolve(); }

  listPayouts(f: { partnerId?: string }) { return Promise.resolve(clean([...this.payouts.values()].filter((p) => !f.partnerId || p.partnerId === f.partnerId))); }
  savePayout(p: Payout) { this.payouts.set(p.id, clean(p)); return Promise.resolve(); }

  firstPaidAt(brand: Brand, clientId: string, at: string) {
    const k = `${brand}__${clientId}`;
    if (!this.first.has(k)) this.first.set(k, at);
    return Promise.resolve(this.first.get(k)!);
  }

  audit(actor: Actor, action: string, target: string, meta?: Record<string, unknown>) {
    this.auditLog.push({ actor, action, target, meta });
    return Promise.resolve();
  }
}
