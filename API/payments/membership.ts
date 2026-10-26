/**
 * API/payments/membership.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Join funnel (W3): lead → client → pending membership → paid → active.
 *
 * Payments run behind PAYMENTS_MODE:
 *   "stripe"  Stripe Checkout in test mode; the webhook activates the membership.
 *   otherwise "manual": the membership stays pending until staff marks it paid
 *             (POST /api/payments/memberships/:id/mark-paid). For demos only,
 *             PAYMENTS_DEMO_AUTOPAY=true activates it immediately.
 */

import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import log from "../../helper/log.ts";
import auditLog from "../../helper/auditLog.ts";
import { emailToDocId, generateSessionToken } from "../../helper/auth/otp.ts";
import {
  COLLECTIONS,
  type CountryCode,
  type Lead,
  type Membership,
  PLAN_STANDARD,
  PROFILE_FIELDS,
} from "../../schemas/contracts.ts";

export type PaymentsMode = "stripe" | "manual";
export const paymentsMode = (): PaymentsMode =>
  Deno.env.get("PAYMENTS_MODE") === "stripe" ? "stripe" : "manual";
const demoAutopay = () => Deno.env.get("PAYMENTS_DEMO_AUTOPAY") === "true";
const siteUrl = () => (Deno.env.get("PUBLIC_SITE_URL") || "http://localhost:3000").replace(/\/$/, "");

/** Short-lived handle the browser holds between /join and /status. */
const JOIN_COLLECTION = "join_sessions";
const JOIN_TTL_MS = 2 * 60 * 60 * 1000;
/** Same collection and shape the client portal's OTP login writes. */
const CLIENT_SESSION_COLLECTION = "client_status_sessions";

type Doc = Record<string, unknown>;
const nowIso = () => new Date().toISOString();

function addMonths(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString();
}

const filled = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

/** Check answers → profile fields, keeping only keys named in PROFILE_FIELDS. */
export function profileFromAnswers(answers: Record<string, unknown>): Doc {
  const allowed = new Set(Object.values(PROFILE_FIELDS).flat());
  const out: Doc = {};
  for (const [k, v] of Object.entries(answers)) if (allowed.has(k) && filled(v)) out[k] = v;
  return out;
}

export interface JoinInput {
  email: string;
  fullName: string;
  phone?: string;
  leadId?: string;
}

export interface JoinSession {
  clientId: string;
  membershipId: string;
  email: string;
  newClient: boolean;
  leadId?: string;
  createdAt: string;
  expiresAt: string;
  sessionIssuedAt?: string;
}

export class JoinError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function membershipsFor(clientId: string): Promise<Membership[]> {
  const rows = await query(COLLECTIONS.memberships, [{ field: "clientId", op: "EQUAL", value: clientId }]);
  return rows as unknown as Membership[];
}

/**
 * Create or merge the client, then create a pending membership.
 * Existing client values are never overwritten; only empty fields are filled.
 */
export async function startJoin(input: JoinInput): Promise<{ session: JoinSession; token: string; membership: Membership }> {
  const email = input.email.toLowerCase().trim();
  const clientId = emailToDocId(email);
  const now = nowIso();

  // A lead only pre-fills the profile when it belongs to the same email.
  let lead: Lead | null = null;
  if (input.leadId) {
    const l = (await get(COLLECTIONS.leads, input.leadId).catch(() => null)) as unknown as Lead | null;
    if (l && l.email === email) lead = l;
  }
  const country: CountryCode = lead?.country ?? "CR";
  const profile = lead ? profileFromAnswers(lead.answers) : {};

  const existing = (await get(COLLECTIONS.clients, clientId).catch(() => null)) as Doc | null;
  const prior = existing ? await membershipsFor(clientId) : [];
  if (prior.some((m) => m.status === "active" || m.status === "past_due")) {
    throw new JoinError(409, "This email already has an ILP membership. Sign in to see it.");
  }

  const base: Doc = {
    name: input.fullName,
    fullName: input.fullName,
    email,
    ...(input.phone ? { phone: input.phone } : {}),
    jurisdiction: "Costa Rica",
    country,
    ...profile,
  };
  if (!existing) {
    await put(COLLECTIONS.clients, clientId, {
      ...base,
      stage: "intake",
      source: lead ? "deadline_check" : "join",
      ...(lead ? { leadId: lead.id } : {}),
      deadlines: {},
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const fill: Doc = {};
    for (const [k, v] of Object.entries(base)) if (!filled(existing[k])) fill[k] = v;
    await patch(COLLECTIONS.clients, clientId, { ...fill, updatedAt: now });
  }

  // Reuse an unpaid membership so a retried join does not create duplicates.
  const pending = prior.find((m) => m.status === "pending");
  const membership: Membership & { sourceLeadId?: string } = pending ?? {
    id: `mem_${crypto.randomUUID()}`,
    clientId,
    plan: PLAN_STANDARD.id,
    status: "pending",
    country,
    periodStart: now,
    periodEnd: addMonths(now, 1),
    minutesIncluded: PLAN_STANDARD.minutesIncluded,
    minutesUsed: 0,
    callsIncluded: PLAN_STANDARD.callsIncluded,
    callsUsed: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (lead) membership.sourceLeadId = lead.id;
  membership.paymentRef = paymentsMode() === "stripe" ? "stripe:pending" : "manual";
  await patch(COLLECTIONS.memberships, membership.id, membership as unknown as Doc);

  const token = generateSessionToken();
  const session: JoinSession = {
    clientId,
    membershipId: membership.id,
    email,
    newClient: !existing,
    ...(lead ? { leadId: lead.id } : {}),
    createdAt: now,
    expiresAt: new Date(Date.now() + JOIN_TTL_MS).toISOString(),
  };
  await put(JOIN_COLLECTION, token, session as unknown as Doc);

  await auditLog({
    actor: { uid: clientId, email, role: "client" },
    action: "membership.join_started",
    target: `memberships/${membership.id}`,
    meta: { mode: paymentsMode(), leadId: lead?.id ?? null, newClient: !existing },
  });
  return { session, token, membership };
}

/**
 * Emit `membership.activated` through W1's TASK_RULES engine (creates the
 * onboarding CSM task). The module is loaded at runtime so this file builds
 * before W1's API/members/events.ts lands on main; once it does, this call
 * goes live with no change. emitEvent is idempotent per membership id.
 */
async function emitMembershipActivated(clientId: string, membershipId: string): Promise<void> {
  const eventsModule = "../members/events.ts";
  try {
    const mod = await import(eventsModule) as {
      emitEvent?: (name: string, payload: { clientId: string; sourceId?: string }) => Promise<string[]>;
    };
    if (typeof mod.emitEvent !== "function") throw new Error("emitEvent missing");
    await mod.emitEvent("membership.activated", { clientId, sourceId: membershipId });
  } catch (err) {
    // TODO(W1): remove the fallback once API/members/events.ts is on main:
    //   await emitEvent("membership.activated", { clientId, sourceId: membershipId });
    log(`[payments] membership.activated not emitted (${err instanceof Error ? err.message : err})`, "payments");
  }
}

/** Mark a membership paid and active. Idempotent; returns null when missing. */
export async function activateMembership(
  membershipId: string,
  paymentRef: string,
  actor: { uid: string; email: string; role: string },
): Promise<Membership | null> {
  const m = (await get(COLLECTIONS.memberships, membershipId).catch(() => null)) as
    | (Membership & { sourceLeadId?: string })
    | null;
  if (!m) return null;
  if (m.status === "active") return m;

  const now = nowIso();
  const update: Partial<Membership> = {
    status: "active",
    activatedAt: m.activatedAt ?? now,
    activationPaidAt: m.activationPaidAt ?? now,
    periodStart: now,
    periodEnd: addMonths(now, 1),
    paymentRef,
    updatedAt: now,
  };
  await patch(COLLECTIONS.memberships, membershipId, update as unknown as Doc);

  if (m.sourceLeadId) {
    await patch(COLLECTIONS.leads, m.sourceLeadId, { convertedClientId: m.clientId, convertedAt: now })
      .catch((err) => log(`[payments] lead ${m.sourceLeadId} not marked converted: ${err}`, "payments"));
  }
  await patch(COLLECTIONS.clients, m.clientId, { membershipStatus: "active", memberSince: update.activatedAt, updatedAt: now })
    .catch(() => {});
  await emitMembershipActivated(m.clientId, membershipId);
  await auditLog({ actor, action: "membership.activated", target: `memberships/${membershipId}`, meta: { paymentRef } });
  log(`[payments] membership ${membershipId} active (${paymentRef})`, "payments");
  return { ...m, ...update } as Membership;
}

/** Set a status on the membership a Stripe subscription belongs to. */
export async function setStatusByPaymentRef(paymentRef: string, status: "past_due" | "cancelled"): Promise<void> {
  const rows = await query(COLLECTIONS.memberships, [{ field: "paymentRef", op: "EQUAL", value: paymentRef }]);
  const now = nowIso();
  for (const m of rows as unknown as Membership[]) {
    await patch(COLLECTIONS.memberships, m.id, {
      status,
      updatedAt: now,
      ...(status === "cancelled" ? { cancelledAt: now } : {}),
    });
    await auditLog({ actor: { uid: "stripe", email: "stripe", role: "system" }, action: `membership.${status}`, target: `memberships/${m.id}` });
  }
}

export async function readJoinSession(token: string): Promise<JoinSession | null> {
  if (!token || token.length > 200) return null;
  const s = (await get(JOIN_COLLECTION, token).catch(() => null)) as unknown as JoinSession | null;
  if (!s || new Date(s.expiresAt) < new Date()) return null;
  return s;
}

export async function getMembership(id: string): Promise<Membership | null> {
  return (await get(COLLECTIONS.memberships, id).catch(() => null)) as unknown as Membership | null;
}

/**
 * Hand a brand-new member straight into the client portal. Only for clients
 * this join created (an existing client must sign in with the email code, so
 * typing someone's email here never opens their portal), only once the
 * membership is active, and only once per join.
 */
export async function issuePortalSession(token: string, s: JoinSession): Promise<string | null> {
  if (!s.newClient || s.sessionIssuedAt) return null;
  const portalToken = generateSessionToken();
  const now = nowIso();
  await put(CLIENT_SESSION_COLLECTION, portalToken, {
    email: s.email,
    projectId: s.clientId,
    createdAt: now,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    source: "join",
  });
  await patch(JOIN_COLLECTION, token, { sessionIssuedAt: now });
  return portalToken;
}

// ─── Stripe (test mode) ────────────────────────────────────────────────────

async function stripeApi(path: string, method: "GET" | "POST", form?: URLSearchParams): Promise<Doc> {
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (!key.startsWith("sk_test_") && Deno.env.get("STRIPE_ALLOW_LIVE") !== "true") {
    throw new Error("Only Stripe test keys are allowed (set STRIPE_ALLOW_LIVE=true to go live)");
  }
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form?.toString(),
  });
  const data = await res.json() as Doc;
  if (!res.ok) {
    const msg = (data.error as Doc | undefined)?.message ?? `Stripe ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

/** Checkout Session: monthly subscription + one-time activation on the first invoice. */
export async function createStripeCheckout(s: JoinSession, token: string): Promise<string> {
  const f = new URLSearchParams();
  f.set("mode", "subscription");
  f.set("customer_email", s.email);
  f.set("client_reference_id", s.clientId);
  f.set("success_url", `${siteUrl()}/join/welcome?t=${encodeURIComponent(token)}`);
  f.set("cancel_url", `${siteUrl()}/join?cancelled=1`);
  f.set("line_items[0][quantity]", "1");
  f.set("line_items[0][price_data][currency]", "usd");
  f.set("line_items[0][price_data][unit_amount]", String(PLAN_STANDARD.monthlyCents));
  f.set("line_items[0][price_data][recurring][interval]", "month");
  f.set("line_items[0][price_data][product_data][name]", "ILP membership");
  f.set("line_items[1][quantity]", "1");
  f.set("line_items[1][price_data][currency]", "usd");
  f.set("line_items[1][price_data][unit_amount]", String(PLAN_STANDARD.activationCents));
  f.set("line_items[1][price_data][product_data][name]", "ILP activation (one time)");
  f.set("metadata[membershipId]", s.membershipId);
  f.set("subscription_data[metadata][membershipId]", s.membershipId);
  const session = await stripeApi("/checkout/sessions", "POST", f);
  return String(session.url);
}

/**
 * Handle a Stripe webhook. The body is not trusted: only the event id is read
 * and the event is fetched back from Stripe with the secret key, which proves
 * it is real without needing the raw body for signature checks (the global
 * JSON parser in main.ts has already consumed it).
 */
export async function handleStripeEvent(body: Doc): Promise<string> {
  const id = typeof body.id === "string" && /^evt_[A-Za-z0-9]+$/.test(body.id) ? body.id : "";
  if (!id) throw new JoinError(400, "Missing event id");
  const evt = await stripeApi(`/events/${id}`, "GET");
  const obj = ((evt.data as Doc | undefined)?.object ?? {}) as Doc;
  const system = { uid: "stripe", email: "stripe", role: "system" };
  switch (evt.type) {
    case "checkout.session.completed": {
      const membershipId = String((obj.metadata as Doc | undefined)?.membershipId ?? "");
      if (membershipId && obj.payment_status === "paid") {
        await activateMembership(membershipId, String(obj.subscription ?? obj.id), system);
      }
      break;
    }
    case "invoice.payment_failed":
      if (obj.subscription) await setStatusByPaymentRef(String(obj.subscription), "past_due");
      break;
    case "customer.subscription.deleted":
      await setStatusByPaymentRef(String(obj.id), "cancelled");
      break;
  }
  return String(evt.type);
}

export const autopayInManualMode = demoAutopay;
