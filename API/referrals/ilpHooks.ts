/**
 * API/referrals/ilpHooks.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Where ILP's own flows feed the referral program. Every function here
 * never throws: a referral problem must not break a lead, a join or a payment.
 *
 *   leads (deadline check, hero form, claim) and /api/payments/join
 *       → attributeIlp: the browser's ref code (first-party cookie ilp_ref,
 *         sent as body.ref / body.refAt) ties the person to the partner.
 *   activateMembership (first payment: activation + first month)
 *       → ilpPaymentCollected kind "initial"
 *   renewMembership (each later month, Stripe or manual)
 *       → ilpPaymentCollected kind "renewal"
 */
import log from "../../helper/log.ts";
import { PLAN_STANDARD } from "../../schemas/contracts.ts";
import { ReferralEngine } from "./engine.ts";
import { firestoreReferralStore } from "./store.ts";

let engine: ReferralEngine | null = null;
const getEngine = () => (engine ??= new ReferralEngine(firestoreReferralStore));

/** Tests swap the engine. */
export function setIlpReferralEngine(e: ReferralEngine | null) {
  engine = e;
}

/** The ref code a public form sent (body.ref, body.refAt), cleaned. */
export function refFromBody(body: unknown): { refCode?: string; refAt?: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const code = typeof b.ref === "string" ? b.ref.trim().toLowerCase() : "";
  const at = typeof b.refAt === "string" && !Number.isNaN(Date.parse(b.refAt)) ? b.refAt : undefined;
  return /^[a-z0-9-]{2,40}$/.test(code) ? { refCode: code, ...(at ? { refAt: at } : {}) } : {};
}

export async function attributeIlp(input: { clientId: string; email?: string; leadId?: string; body?: unknown }): Promise<void> {
  try {
    const ref = refFromBody(input.body);
    // Without a code we still call attribute: it links leadId/clientId to an existing referral.
    const r = await getEngine().attribute({ brand: "ilp", clientId: input.clientId, email: input.email, leadId: input.leadId, ...ref, via: "cookie" });
    if (r && ref.refCode) log(`[referrals] ${input.clientId} → partner ${r.partnerId}`, "referrals");
  } catch (err) {
    log(`[referrals] attribution failed for ${input.clientId}: ${err instanceof Error ? err.message : err}`, "error");
  }
}

/**
 * A membership payment ILP collected. saleRef is stable per payment:
 *   initial  → ilp:mem:<membershipId>:initial
 *   renewal  → ilp:mem:<membershipId>:<periodStart>
 */
export async function ilpPaymentCollected(input: {
  membershipId: string;
  clientId: string;
  kind: "initial" | "renewal";
  periodStart?: string;
  paidAt?: string;
}): Promise<void> {
  try {
    const initial = input.kind === "initial";
    const saleRef = initial ? `ilp:mem:${input.membershipId}:initial` : `ilp:mem:${input.membershipId}:${input.periodStart ?? input.paidAt ?? ""}`;
    const out = await getEngine().recordSale({
      brand: "ilp",
      saleRef,
      clientId: input.clientId,
      amountCents: initial ? PLAN_STANDARD.activationCents + PLAN_STANDARD.monthlyCents : PLAN_STANDARD.monthlyCents,
      ...(initial ? { activationCents: PLAN_STANDARD.activationCents } : {}),
      kind: input.kind,
      paidAt: input.paidAt ?? new Date().toISOString(),
    });
    if (out.commission && out.reason === "earned") {
      log(`[referrals] ${saleRef}: ${out.commission.amountCents}c to ${out.commission.partnerId}`, "referrals");
    }
  } catch (err) {
    log(`[referrals] commission for ${input.membershipId} failed: ${err instanceof Error ? err.message : err}`, "error");
  }
}
