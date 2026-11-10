/**
 * API/referrals/engine.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The referral program: partners, rules, links, attribution, commissions,
 * payouts, history import. Pure business logic over a ReferralStore, so the
 * tests run it in memory (test/referrals_test.ts).
 *
 * Invariants
 *  - One person per brand belongs to the first partner that brought them
 *    (deterministic referral id); staff can reassign with a reason (audited).
 *  - One commission per sale (deterministic id from brand + saleRef): replayed
 *    webhooks and retries never pay twice.
 *  - Nothing is deleted: refunds reverse unpaid lines or add a negative line
 *    that the next payout absorbs.
 *  - Every total shown anywhere is computed from commissions + payouts.
 */
import { buildTrackedUrl, buildUtm, checkDestination, generateCode, ReferralError } from "./links.ts";
import { computeEarning, type RuleInput, validateRule } from "./rules.ts";
import { maskOf, seal, unseal } from "./crypto.ts";
import type { Actor, ReferralStore } from "./store.ts";
import {
  type Brand,
  BRANDS,
  type Commission,
  type CommissionRule,
  type Partner,
  PARTNER_STATUSES,
  PARTNER_TYPES,
  type PartnerType,
  type Payout,
  PAYOUT_METHODS,
  type PayoutMethod,
  type Referral,
  type ReferralLink,
  type SaleEvent,
} from "./types.ts";

export const ATTRIBUTION_WINDOW_DAYS = 90;
export const SYSTEM: Actor = { uid: "system", email: "system", role: "system" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (e: unknown) => String(e ?? "").trim().toLowerCase();
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

export async function sha(input: string, len = 24): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

/** Same id the ILP clients collection uses for an email. */
export function subjectFromEmail(email: string): string {
  return normEmail(email).replace(/[@.]/g, "_");
}

export function isBrand(v: unknown): v is Brand {
  return typeof v === "string" && (BRANDS as readonly string[]).includes(v);
}

export function brandOrThrow(v: unknown): Brand {
  if (!isBrand(v)) throw new ReferralError(400, `Brand must be one of ${BRANDS.join(", ")}.`);
  return v;
}

export interface EngineOptions {
  now?: () => string;
  newId?: (prefix: string) => string;
  minPayoutCents?: number;
}

export class ReferralEngine {
  readonly store: ReferralStore;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  readonly minPayoutCents: number;

  constructor(store: ReferralStore, opts: EngineOptions = {}) {
    this.store = store;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.newId ?? ((p) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`);
    this.minPayoutCents = opts.minPayoutCents ?? Number(Deno.env.get("REFERRALS_MIN_PAYOUT_CENTS") ?? 2500);
  }

  // ─── Rules ───────────────────────────────────────────────────────────────

  async createRule(input: RuleInput, actor: Actor): Promise<CommissionRule> {
    const r: RuleInput = {
      name: str(input.name, 120),
      brand: brandOrThrow(input.brand),
      base: input.base,
      include: input.include ?? "all",
      holdDays: Number(input.holdDays ?? 30),
      ...(input.amountCents !== undefined && input.amountCents !== null ? { amountCents: Number(input.amountCents) } : {}),
      ...(input.amountCents === undefined || input.amountCents === null
        ? (input.percent !== undefined && input.percent !== null ? { percent: Number(input.percent) } : {})
        : {}),
      ...(input.durationMonths ? { durationMonths: Number(input.durationMonths) } : {}),
    };
    validateRule(r);
    const rule: CommissionRule = { ...r, id: this.newId("rrule"), createdAt: this.now(), createdBy: actor.email };
    await this.store.saveRule(rule);
    await this.store.audit(actor, "referral.rule_created", `referral_rules/${rule.id}`, { ...r });
    return rule;
  }

  async archiveRule(id: string, archived: boolean, actor: Actor): Promise<CommissionRule> {
    const r = await this.store.getRule(id);
    if (!r) throw new ReferralError(404, "Rule not found.");
    r.archived = archived;
    await this.store.saveRule(r);
    await this.store.audit(actor, archived ? "referral.rule_archived" : "referral.rule_restored", `referral_rules/${id}`);
    return r;
  }

  private async checkRuleIds(ruleIds: unknown, brands: Brand[]): Promise<Partial<Record<Brand, string>>> {
    const out: Partial<Record<Brand, string>> = {};
    if (!ruleIds || typeof ruleIds !== "object") return out;
    for (const [b, id] of Object.entries(ruleIds as Record<string, unknown>)) {
      if (!id) continue;
      const brand = brandOrThrow(b);
      if (!brands.includes(brand)) throw new ReferralError(400, `The partner is not on ${brand.toUpperCase()}.`);
      const rule = await this.store.getRule(String(id));
      if (!rule || rule.brand !== brand || rule.archived) throw new ReferralError(400, `Pick a ${brand.toUpperCase()} rule for ${brand.toUpperCase()}.`);
      out[brand] = rule.id;
    }
    return out;
  }

  // ─── Partners ────────────────────────────────────────────────────────────

  async createPartner(input: {
    name: unknown;
    email: unknown;
    type: unknown;
    brands: unknown;
    ruleIds?: unknown;
    language?: unknown;
    notes?: unknown;
    startedAt?: unknown;
  }, actor: Actor): Promise<Partner> {
    const name = str(input.name, 120);
    const email = normEmail(input.email);
    if (!name) throw new ReferralError(400, "Enter the partner's name.");
    if (!EMAIL_RE.test(email) || email.length > 254) throw new ReferralError(400, "Enter a valid email.");
    if (!(PARTNER_TYPES as readonly string[]).includes(String(input.type))) throw new ReferralError(400, "Pick a partner type.");
    const brands = [...new Set(Array.isArray(input.brands) ? input.brands : [])].map(brandOrThrow);
    if (!brands.length) throw new ReferralError(400, "Pick at least one brand.");
    if (await this.store.findPartnerByEmail(email)) throw new ReferralError(409, "A partner with this email already exists.");
    const now = this.now();
    const startedAt = input.startedAt && !Number.isNaN(Date.parse(String(input.startedAt))) ? new Date(String(input.startedAt)).toISOString() : now;
    const p: Partner = {
      id: this.newId("ptr"),
      name,
      email,
      type: input.type as PartnerType,
      brands,
      status: "invited",
      ruleIds: await this.checkRuleIds(input.ruleIds, brands),
      language: input.language === "en" ? "en" : "es",
      taxFormStatus: "missing",
      ...(str(input.notes, 2000) ? { notes: str(input.notes, 2000) } : {}),
      startedAt,
      invitedBy: actor.email,
      monthlyEmail: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.savePartner(p);
    await this.store.audit(actor, "referral.partner_created", `referral_partners/${p.id}`, { email, type: p.type, brands });
    return p;
  }

  async updatePartner(id: string, patch: Record<string, unknown>, actor: Actor): Promise<Partner> {
    const p = await this.mustPartner(id);
    const changed: string[] = [];
    if (patch.name !== undefined) {
      const n = str(patch.name, 120);
      if (!n) throw new ReferralError(400, "Enter the partner's name.");
      p.name = n;
      changed.push("name");
    }
    if (patch.type !== undefined) {
      if (!(PARTNER_TYPES as readonly string[]).includes(String(patch.type))) throw new ReferralError(400, "Pick a partner type.");
      p.type = patch.type as PartnerType;
      changed.push("type");
    }
    if (patch.brands !== undefined) {
      const brands = [...new Set(Array.isArray(patch.brands) ? patch.brands : [])].map(brandOrThrow);
      if (!brands.length) throw new ReferralError(400, "Pick at least one brand.");
      p.brands = brands;
      for (const b of Object.keys(p.ruleIds) as Brand[]) if (!brands.includes(b)) delete p.ruleIds[b];
      changed.push("brands");
    }
    if (patch.ruleIds !== undefined) {
      p.ruleIds = await this.checkRuleIds(patch.ruleIds, p.brands);
      changed.push("ruleIds");
    }
    if (patch.status !== undefined) {
      if (!(PARTNER_STATUSES as readonly string[]).includes(String(patch.status))) throw new ReferralError(400, "Invalid status.");
      p.status = patch.status as Partner["status"];
      changed.push("status");
    }
    if (patch.language !== undefined) {
      p.language = patch.language === "en" ? "en" : "es";
      changed.push("language");
    }
    if (patch.notes !== undefined) {
      p.notes = str(patch.notes, 2000);
      changed.push("notes");
    }
    if (patch.taxFormStatus !== undefined) {
      if (!["missing", "w9", "w8ben", "cr_invoice", "other"].includes(String(patch.taxFormStatus))) throw new ReferralError(400, "Invalid tax form.");
      p.taxFormStatus = patch.taxFormStatus as Partner["taxFormStatus"];
      changed.push("taxFormStatus");
    }
    if (patch.monthlyEmail !== undefined) {
      p.monthlyEmail = patch.monthlyEmail === true;
      changed.push("monthlyEmail");
    }
    if (patch.startedAt !== undefined && !Number.isNaN(Date.parse(String(patch.startedAt)))) {
      p.startedAt = new Date(String(patch.startedAt)).toISOString();
      changed.push("startedAt");
    }
    p.updatedAt = this.now();
    await this.store.savePartner(p);
    await this.store.audit(actor, "referral.partner_updated", `referral_partners/${p.id}`, { changed, status: p.status });
    return p;
  }

  /** Partner (or staff for them) saves bank details. Sealed at rest; only a mask is readable. */
  async setPayoutDetails(partnerId: string, input: Record<string, unknown>, actor: Actor): Promise<Partner> {
    const p = await this.mustPartner(partnerId);
    const method = String(input.method ?? "") as PayoutMethod;
    if (!(PAYOUT_METHODS as readonly string[]).includes(method)) throw new ReferralError(400, "Pick how you want to be paid.");
    const holderName = str(input.holderName, 120);
    if (!holderName) throw new ReferralError(400, "Enter the account holder's name.");
    const account = str(input.account, 64) || str(input.iban, 64) || str(input.phone, 32) || str(input.email, 254);
    if (!account) throw new ReferralError(400, "Enter the account number, IBAN, SINPE phone or payment email.");
    const details = {
      method,
      holderName,
      account: str(input.account, 64),
      iban: str(input.iban, 64),
      swift: str(input.swift, 20),
      routing: str(input.routing, 20),
      phone: str(input.phone, 32),
      email: str(input.email, 254),
      taxId: str(input.taxId, 40),
      address: str(input.address, 300),
    };
    p.payout = {
      method,
      holderName,
      ...(str(input.bankName, 120) ? { bankName: str(input.bankName, 120) } : {}),
      ...(str(input.country, 60) ? { country: str(input.country, 60) } : {}),
      ...(str(input.currency, 3) ? { currency: str(input.currency, 3).toUpperCase() } : {}),
      mask: maskOf(account),
      sealed: await seal(details),
      updatedAt: this.now(),
      updatedBy: actor.email,
    };
    if (p.status === "invited") p.status = "active";
    p.updatedAt = this.now();
    await this.store.savePartner(p);
    await this.store.audit(actor, "referral.payout_details_saved", `referral_partners/${p.id}`, { method, mask: p.payout.mask });
    return p;
  }

  /** Admin only: read the full bank details to send a transfer. Audited. */
  async revealPayoutDetails(partnerId: string, actor: Actor): Promise<Record<string, unknown>> {
    const p = await this.mustPartner(partnerId);
    if (!p.payout?.sealed) throw new ReferralError(404, "This partner has not entered payment details.");
    const details = await unseal(p.payout.sealed);
    await this.store.audit(actor, "referral.payout_details_viewed", `referral_partners/${p.id}`);
    return { ...details, bankName: p.payout.bankName, country: p.payout.country, currency: p.payout.currency };
  }

  // ─── Links ───────────────────────────────────────────────────────────────

  async createLink(input: { partnerId: unknown; brand: unknown; destination: unknown; campaign?: unknown; content?: unknown; code?: unknown }, actor: Actor): Promise<ReferralLink> {
    const partner = await this.mustPartner(String(input.partnerId ?? ""));
    const brand = brandOrThrow(input.brand);
    if (!partner.brands.includes(brand)) throw new ReferralError(400, `${partner.name} is not a partner on ${brand.toUpperCase()}.`);
    if (partner.status === "closed") throw new ReferralError(400, "This partner is closed.");
    const destination = checkDestination(String(input.destination ?? ""), brand);
    const code = await generateCode(partner.name, brand, async (c) => !!(await this.store.getLinkByCode(c)), str(input.code, 40) || undefined);
    const utm = buildUtm(partner.type, code, str(input.campaign, 64) || undefined, str(input.content, 64) || undefined);
    const link: ReferralLink = {
      id: this.newId("rlnk"),
      partnerId: partner.id,
      brand,
      code,
      destination,
      utm,
      url: buildTrackedUrl(destination, code, utm),
      clicks: 0,
      active: true,
      createdAt: this.now(),
      createdBy: actor.email,
    };
    await this.store.saveLink(link);
    await this.store.audit(actor, "referral.link_created", `referral_links/${link.id}`, { partnerId: partner.id, code, brand });
    return link;
  }

  async setLinkActive(linkId: string, active: boolean, actor: Actor): Promise<ReferralLink> {
    const l = await this.store.getLink(linkId);
    if (!l) throw new ReferralError(404, "Link not found.");
    l.active = active;
    await this.store.saveLink(l);
    await this.store.audit(actor, active ? "referral.link_enabled" : "referral.link_disabled", `referral_links/${l.id}`);
    return l;
  }

  /** Public short link: where to send the visitor. Counts the click. Null for unknown, paused or closed. */
  async resolveCode(code: string, count = true): Promise<{ url: string; code: string; brand: Brand } | null> {
    const c = String(code ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(c)) return null;
    const link = await this.store.getLinkByCode(c);
    if (!link || !link.active) return null;
    const partner = await this.store.getPartner(link.partnerId);
    if (!partner || partner.status === "closed" || partner.status === "paused") return null;
    if (count) {
      link.clicks = (link.clicks ?? 0) + 1;
      await this.store.saveLink(link).catch(() => {});
    }
    return { url: link.url, code: link.code, brand: link.brand };
  }

  // ─── Attribution ─────────────────────────────────────────────────────────

  async referralIdFor(brand: Brand, subjectKey: string): Promise<string> {
    return `ref_${brand}_${await sha(`${brand}|${subjectKey}`)}`;
  }

  /**
   * Tie a person to the partner whose code they carry. First partner wins.
   * refAt: when the browser first saw the code (cookie); older than the
   * 90-day window → ignored. Returns the referral (existing or new) or null.
   */
  async attribute(input: {
    brand: Brand;
    clientId?: string;
    email?: string;
    leadId?: string;
    refCode?: string;
    refAt?: string;
    via?: "link" | "cookie" | "ingest";
  }): Promise<Referral | null> {
    const subjectKey = input.clientId || (input.email ? subjectFromEmail(input.email) : "");
    if (!subjectKey) return null;
    const id = await this.referralIdFor(input.brand, subjectKey);
    const existing = await this.store.getReferral(id);
    if (existing) {
      let dirty = false;
      if (input.clientId && !existing.clientId) { existing.clientId = input.clientId; dirty = true; }
      if (input.leadId && !existing.leadId) { existing.leadId = input.leadId; dirty = true; }
      if (dirty) {
        existing.updatedAt = this.now();
        await this.store.saveReferral(existing);
      }
      return existing;
    }
    const code = str(input.refCode, 40).toLowerCase();
    if (!code) return null;
    const now = this.now();
    const seenAt = input.refAt && !Number.isNaN(Date.parse(input.refAt)) && Date.parse(input.refAt) <= Date.parse(now)
      ? new Date(input.refAt).toISOString()
      : now;
    if (Date.parse(now) - Date.parse(seenAt) > ATTRIBUTION_WINDOW_DAYS * 86_400_000) return null;
    const link = await this.store.getLinkByCode(code);
    if (!link || link.brand !== input.brand) return null;
    const partner = await this.store.getPartner(link.partnerId);
    if (!partner || partner.status === "closed" || partner.status === "paused") return null;
    if (input.email && normEmail(input.email) === partner.email) return null; // self-referral
    const r: Referral = {
      id,
      brand: input.brand,
      partnerId: partner.id,
      linkId: link.id,
      code: link.code,
      subjectKey,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.leadId ? { leadId: input.leadId } : {}),
      status: "lead",
      firstSeenAt: seenAt,
      via: input.via ?? "link",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveReferral(r);
    return r;
  }

  /** "Me mandó Sara": staff sets (or changes) the partner of a customer, with a reason. */
  async assignManually(input: { brand: unknown; clientId?: unknown; email?: unknown; partnerId: unknown; reason: unknown }, actor: Actor): Promise<Referral> {
    const brand = brandOrThrow(input.brand);
    const partner = await this.mustPartner(String(input.partnerId ?? ""));
    if (!partner.brands.includes(brand)) throw new ReferralError(400, `${partner.name} is not a partner on ${brand.toUpperCase()}.`);
    const reason = str(input.reason, 300);
    if (!reason) throw new ReferralError(400, "Say why (for example: the client said Sara sent them).");
    const clientId = str(input.clientId, 200) || (input.email ? subjectFromEmail(String(input.email)) : "");
    if (!clientId) throw new ReferralError(400, "Enter the customer's id or email.");
    const id = await this.referralIdFor(brand, clientId);
    const existing = await this.store.getReferral(id);
    const now = this.now();
    const r: Referral = existing
      ? { ...existing, partnerId: partner.id, linkId: undefined, code: undefined, via: "manual", assignedBy: actor.email, clientId, updatedAt: now }
      : { id, brand, partnerId: partner.id, subjectKey: clientId, clientId, status: "lead", firstSeenAt: now, via: "manual", assignedBy: actor.email, createdAt: now, updatedAt: now };
    await this.store.saveReferral(r);
    await this.store.audit(actor, "referral.assigned_manually", `referrals/${id}`, { clientId, from: existing?.partnerId ?? null, to: partner.id, reason });
    return r;
  }

  // ─── Sales ───────────────────────────────────────────────────────────────

  async commissionIdFor(brand: Brand, saleRef: string): Promise<string> {
    return `rcom_${await sha(`${brand}|${saleRef}`)}`;
  }

  /**
   * A collected payment. Idempotent on (brand, saleRef). Returns the commission
   * (new or existing) or null with the reason. A paused partner still earns
   * on people already brought (pausing only stops new attributions); a closed
   * partner earns nothing.
   */
  async recordSale(sale: SaleEvent, actor: Actor = SYSTEM): Promise<{ commission: Commission | null; reason: string }> {
    const brand = brandOrThrow(sale.brand);
    const saleRef = str(sale.saleRef, 200);
    const clientId = str(sale.clientId, 200);
    if (!saleRef || !clientId) throw new ReferralError(400, "saleRef and clientId are required.");
    if (!Number.isInteger(sale.amountCents) || sale.amountCents < 0) throw new ReferralError(400, "amountCents must be whole cents.");
    if (!["initial", "renewal", "one_time"].includes(sale.kind)) throw new ReferralError(400, "kind must be initial, renewal or one_time.");
    const paidAt = sale.paidAt && !Number.isNaN(Date.parse(sale.paidAt)) ? new Date(sale.paidAt).toISOString() : this.now();

    const comId = await this.commissionIdFor(brand, saleRef);
    const dup = await this.store.getCommission(comId);
    if (dup) return { commission: dup, reason: "duplicate" };

    const firstPaidAt = await this.store.firstPaidAt(brand, clientId, paidAt);
    let referral = await this.store.getReferral(await this.referralIdFor(brand, clientId));
    if (!referral && sale.refCode) referral = await this.attribute({ brand, clientId, email: sale.email, refCode: sale.refCode, via: "ingest" });
    if (!referral) return { commission: null, reason: "no_referral" };

    const partner = await this.store.getPartner(referral.partnerId);
    if (!partner) return { commission: null, reason: "partner_missing" };
    if (referral.status !== "customer") {
      referral.status = "customer";
      referral.convertedAt = referral.convertedAt ?? paidAt;
      referral.clientId = referral.clientId ?? clientId;
      referral.updatedAt = this.now();
      await this.store.saveReferral(referral);
    }
    if (partner.status === "closed") return { commission: null, reason: "partner_closed" };

    const rule = partner.ruleIds[brand] ? await this.store.getRule(partner.ruleIds[brand]!) : null;
    if (!rule) return { commission: null, reason: "no_rule" };
    const isFirstPayment = Date.parse(firstPaidAt) === Date.parse(paidAt) && sale.kind !== "renewal";
    const e = computeEarning(rule, { ...sale, brand, saleRef, clientId, paidAt }, { firstPaidAt, isFirstPayment });
    if (!("approvableAt" in e)) return { commission: null, reason: e.reason };

    const c: Commission = {
      id: comId,
      brand,
      partnerId: partner.id,
      referralId: referral.id,
      ruleId: rule.id,
      clientId,
      saleRef,
      saleKind: sale.kind,
      saleAmountCents: sale.amountCents,
      amountCents: e.amountCents,
      status: "pending",
      earnedAt: paidAt,
      approvableAt: e.approvableAt,
      source: "engine",
      createdAt: this.now(),
    };
    await this.store.saveCommission(c);
    await this.store.audit(actor, "referral.commission_earned", `referral_commissions/${c.id}`, { partnerId: partner.id, brand, saleRef, amountCents: c.amountCents });
    return { commission: c, reason: "earned" };
  }

  /** Refund / chargeback of a sale: unpaid → reversed; paid → negative line on the next payout. */
  async refundSale(input: { brand: unknown; saleRef: unknown; reason: unknown }, actor: Actor): Promise<Commission[]> {
    const brand = brandOrThrow(input.brand);
    const saleRef = str(input.saleRef, 200);
    const reason = str(input.reason, 300) || "refund";
    const c = await this.store.getCommission(await this.commissionIdFor(brand, saleRef));
    if (!c || c.amountCents <= 0) return [];
    const now = this.now();
    if (c.status === "pending" || c.status === "approved") {
      c.status = "reversed";
      c.reversedAt = now;
      c.reversalReason = reason;
      await this.store.saveCommission(c);
      await this.store.audit(actor, "referral.commission_reversed", `referral_commissions/${c.id}`, { saleRef, reason });
      return [c];
    }
    if (c.status !== "paid") return [];
    const clawId = await this.commissionIdFor(brand, `${saleRef}#refund`);
    if (await this.store.getCommission(clawId)) return [];
    const claw: Commission = {
      id: clawId,
      brand,
      partnerId: c.partnerId,
      referralId: c.referralId,
      ruleId: c.ruleId,
      clientId: c.clientId,
      saleRef: `${saleRef}#refund`,
      saleKind: "clawback",
      saleAmountCents: -c.saleAmountCents,
      amountCents: -c.amountCents,
      status: "approved",
      earnedAt: now,
      approvableAt: now,
      approvedAt: now,
      offsetsId: c.id,
      source: "engine",
      note: reason,
      createdAt: now,
    };
    await this.store.saveCommission(claw);
    await this.store.audit(actor, "referral.commission_clawback", `referral_commissions/${claw.id}`, { saleRef, amountCents: claw.amountCents, reason });
    return [claw];
  }

  /** Manual bonus (+) or correction (−). Approved at once; paid with the next payout. */
  async adjust(input: { partnerId: unknown; brand: unknown; amountCents: unknown; note: unknown }, actor: Actor): Promise<Commission> {
    const p = await this.mustPartner(String(input.partnerId ?? ""));
    const brand = brandOrThrow(input.brand);
    const amount = Number(input.amountCents);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new ReferralError(400, "Enter a non-zero amount in cents.");
    const note = str(input.note, 300);
    if (!note) throw new ReferralError(400, "Say what the adjustment is for.");
    const now = this.now();
    const c: Commission = {
      id: this.newId("rcom"),
      brand,
      partnerId: p.id,
      saleRef: `adjust:${now}`,
      saleKind: "adjustment",
      saleAmountCents: 0,
      amountCents: amount,
      status: "approved",
      earnedAt: now,
      approvableAt: now,
      approvedAt: now,
      source: "manual",
      note,
      createdAt: now,
    };
    await this.store.saveCommission(c);
    await this.store.audit(actor, "referral.adjustment", `referral_commissions/${c.id}`, { partnerId: p.id, amountCents: amount, note });
    return c;
  }

  /** Daily: pending lines past their hold become approved. */
  async approveDue(): Promise<number> {
    const now = this.now();
    let n = 0;
    for (const c of await this.store.listCommissions({ status: "pending" })) {
      if (Date.parse(c.approvableAt) <= Date.parse(now)) {
        c.status = "approved";
        c.approvedAt = now;
        await this.store.saveCommission(c);
        n++;
      }
    }
    if (n) await this.store.audit(SYSTEM, "referral.commissions_approved", "referral_commissions", { count: n });
    return n;
  }

  // ─── Payouts ─────────────────────────────────────────────────────────────

  async previewPayouts(): Promise<{
    ready: Array<{ partner: Partner; totalCents: number; lines: number }>;
    held: Array<{ partner: Partner; totalCents: number; lines: number; why: string }>;
  }> {
    const byPartner = new Map<string, Commission[]>();
    for (const c of await this.store.listCommissions({ status: "approved" })) {
      byPartner.set(c.partnerId, [...(byPartner.get(c.partnerId) ?? []), c]);
    }
    const ready: Array<{ partner: Partner; totalCents: number; lines: number }> = [];
    const held: Array<{ partner: Partner; totalCents: number; lines: number; why: string }> = [];
    for (const [pid, lines] of byPartner) {
      const partner = await this.store.getPartner(pid);
      if (!partner) continue;
      const totalCents = lines.reduce((s, c) => s + c.amountCents, 0);
      const row = { partner, totalCents, lines: lines.length };
      if (partner.status === "closed") held.push({ ...row, why: "Partner closed" });
      else if (!partner.payout) held.push({ ...row, why: "No payment details yet" });
      else if (totalCents <= 0) held.push({ ...row, why: "Balance is zero or negative (refunds)" });
      else if (totalCents < this.minPayoutCents) held.push({ ...row, why: `Below the minimum of US$${(this.minPayoutCents / 100).toFixed(2)}` });
      else ready.push(row);
    }
    ready.sort((a, b) => b.totalCents - a.totalCents);
    return { ready, held };
  }

  /** Record a transfer actually sent: every approved line of the partner becomes paid. */
  async recordPayout(input: { partnerId: unknown; method?: unknown; reference: unknown; paidAt?: unknown }, actor: Actor): Promise<Payout> {
    const partner = await this.mustPartner(String(input.partnerId ?? ""));
    const reference = str(input.reference, 120);
    if (!reference) throw new ReferralError(400, "Enter the transfer reference.");
    const method = (PAYOUT_METHODS as readonly string[]).includes(String(input.method)) ? input.method as PayoutMethod : (partner.payout?.method ?? "wire");
    const lines = await this.store.listCommissions({ partnerId: partner.id, status: "approved" });
    if (!lines.length) throw new ReferralError(400, "Nothing approved to pay.");
    const total = lines.reduce((s, c) => s + c.amountCents, 0);
    if (total <= 0) throw new ReferralError(400, "The balance is not positive.");
    const now = this.now();
    const paidAt = input.paidAt && !Number.isNaN(Date.parse(String(input.paidAt))) ? new Date(String(input.paidAt)).toISOString() : now;
    const payout: Payout = {
      id: this.newId("rpay"),
      partnerId: partner.id,
      totalCents: total,
      method,
      reference,
      paidAt,
      commissionIds: lines.map((c) => c.id),
      createdBy: actor.email,
      source: "engine",
      createdAt: now,
    };
    await this.store.savePayout(payout);
    for (const c of lines) {
      c.status = "paid";
      c.paidAt = paidAt;
      c.payoutId = payout.id;
      await this.store.saveCommission(c);
    }
    await this.store.audit(actor, "referral.payout_recorded", `referral_payouts/${payout.id}`, { partnerId: partner.id, totalCents: total, reference });
    return payout;
  }

  // ─── History import ──────────────────────────────────────────────────────

  /**
   * Past payments (e.g. Sara's last years): rows → paid lines + payouts.
   * Rows sharing a reference (or, without one, a date) are one payout.
   * Idempotent per row. Moves the partner's startedAt back to the oldest row.
   */
  async importHistory(rows: unknown, actor: Actor): Promise<{ lines: number; payouts: number; skipped: Array<{ row: number; why: string }> }> {
    if (!Array.isArray(rows) || !rows.length) throw new ReferralError(400, "No rows to import.");
    if (rows.length > 5000) throw new ReferralError(400, "Import at most 5,000 rows at a time.");
    const skipped: Array<{ row: number; why: string }> = [];
    const groups = new Map<string, Commission[]>();
    const partners = new Map<string, Partner>();
    for (const [i, raw] of rows.entries()) {
      const row = (raw ?? {}) as Record<string, unknown>;
      const email = normEmail(row.partnerEmail);
      const partner = partners.get(email) ?? await this.store.findPartnerByEmail(email);
      if (!partner) { skipped.push({ row: i + 1, why: `No partner with email ${email || "(empty)"}` }); continue; }
      partners.set(email, partner);
      if (!isBrand(row.brand)) { skipped.push({ row: i + 1, why: "Brand must be ilp, irp, aiva or censo" }); continue; }
      const amount = Math.round(Number(row.amountCents ?? Number(row.amount) * 100));
      if (!Number.isInteger(amount) || amount <= 0) { skipped.push({ row: i + 1, why: "Amount must be positive" }); continue; }
      const date = String(row.date ?? "");
      if (Number.isNaN(Date.parse(date))) { skipped.push({ row: i + 1, why: "Unreadable date" }); continue; }
      const at = new Date(date).toISOString();
      const reference = str(row.reference ?? row.wireRef, 120);
      const label = str(row.clientLabel ?? row.client, 120);
      const saleRef = `import:${partner.id}:${at.slice(0, 10)}:${reference}:${label}:${amount}`;
      const id = await this.commissionIdFor(row.brand, saleRef);
      if (await this.store.getCommission(id)) { skipped.push({ row: i + 1, why: "Already imported" }); continue; }
      const c: Commission = {
        id,
        brand: row.brand,
        partnerId: partner.id,
        saleRef,
        saleKind: "import",
        saleAmountCents: 0,
        amountCents: amount,
        status: "paid",
        earnedAt: at,
        approvableAt: at,
        approvedAt: at,
        paidAt: at,
        source: "import",
        ...(label ? { note: label } : {}),
        createdAt: this.now(),
      };
      const key = `${partner.id}|${reference || at.slice(0, 10)}`;
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    let lines = 0;
    for (const [key, cs] of groups) {
      const [partnerId, ref] = key.split("|");
      const paidAt = cs.map((c) => c.paidAt!).sort().at(-1)!;
      const payout: Payout = {
        id: this.newId("rpay"),
        partnerId,
        totalCents: cs.reduce((s, c) => s + c.amountCents, 0),
        method: "wire",
        reference: ref,
        paidAt,
        commissionIds: cs.map((c) => c.id),
        createdBy: actor.email,
        source: "import",
        createdAt: this.now(),
      };
      for (const c of cs) {
        c.payoutId = payout.id;
        await this.store.saveCommission(c);
        lines++;
      }
      await this.store.savePayout(payout);
    }
    for (const p of partners.values()) {
      const oldest = [...groups.values()].flat().filter((c) => c.partnerId === p.id).map((c) => c.earnedAt).sort()[0];
      if (oldest && oldest < p.startedAt) {
        const fresh = await this.store.getPartner(p.id);
        if (fresh) {
          fresh.startedAt = oldest;
          fresh.updatedAt = this.now();
          await this.store.savePartner(fresh);
        }
      }
    }
    await this.store.audit(actor, "referral.history_imported", "referral_commissions", { lines, payouts: groups.size, skipped: skipped.length });
    return { lines, payouts: groups.size, skipped };
  }

  async mustPartner(id: string): Promise<Partner> {
    const p = id ? await this.store.getPartner(id) : null;
    if (!p) throw new ReferralError(404, "Partner not found.");
    return p;
  }
}
