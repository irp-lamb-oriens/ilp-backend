/**
 * API/leads/claim.ts
 * ──────────────────────────────────────────────────────────────────────────
 * DEADLINES: "Set the deadlines for each" on the free check results.
 *
 *   POST /api/leads/claim { email, firstName?, country, answers?, leadId?, ruleIds[], consents[], website? }
 *
 * Creates or merges the person's client record (a free account when they
 * have no membership; only empty fields are filled, a member's data is never
 * overwritten), saves the chosen rules as obligations (source "check"),
 * records the Terms and Privacy consents (marketing optional), links the
 * lead, writes the audit log, and emails a /status sign-in code. Returns a
 * short-lived claim token the browser keeps in sessionStorage with the
 * selection, so the Deadlines page can finish the save after sign-in if
 * anything was missed (POST /api/client-status/me/deadlines { claimToken }).
 *
 * The logic takes a ClaimStore so tests run it in memory (test/claim_test.ts).
 */

import {
  ACCOUNT_TYPE_FIELD,
  COUNTRIES,
  COUNTRY_ANSWERS_FIELD,
  type CountryCode,
  type Lead,
  type LeadFinding,
  type Membership,
  type Obligation,
  toCountryCode,
} from "../../schemas/contracts.ts";
import { type JoinConsents, parseJoinConsents } from "../privacy/policy.ts";
import { cleanRuleIds, factsFor, mergeChosen, obligationsForRules } from "../members/deadlines.ts";
import { countryAnswersFrom, profileFromCountryAnswers } from "../payments/joinIntake.ts";
import { emailToDocId } from "../../helper/auth/otp.ts";

type Doc = Record<string, unknown>;

export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const CLAIMS_COLLECTION = "deadline_claims";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ClaimInput {
  email: string;
  firstName?: string;
  country: CountryCode;
  answers: Doc;
  leadId?: string;
  ruleIds: string[];
  consents: JoinConsents;
}

export class ClaimError extends Error {
  constructor(public status: number, message: string, public field?: string) {
    super(message);
  }
}

/** Validate the body. A filled honeypot (`website`) returns { honeypot: true }: answer 202 and do nothing. */
export function parseClaim(body: unknown): ClaimInput | { honeypot: true } | { error: string; field?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Doc;
  if (typeof b.website === "string" && b.website.trim()) return { honeypot: true };
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: "Enter a valid email address.", field: "email" };
  const country = toCountryCode(b.country);
  if (!country) return { error: "Choose Colombia, Costa Rica, Mexico, Panama, Portugal or Spain.", field: "country" };
  const { ruleIds } = cleanRuleIds(country, b.ruleIds);
  if (!ruleIds.length) return { error: "Choose at least one deadline to save.", field: "ruleIds" };
  const consents = parseJoinConsents(b, "check");
  if ("error" in consents) return { error: consents.error, field: "consents" };
  const firstName = typeof b.firstName === "string" ? b.firstName.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  const leadId = typeof b.leadId === "string" && /^lead_[A-Za-z0-9-]{8,60}$/.test(b.leadId) ? b.leadId : undefined;
  const answers = b.answers && typeof b.answers === "object" && !Array.isArray(b.answers) ? (b.answers as Doc) : {};
  return { email, country, ruleIds, consents, answers, ...(firstName ? { firstName } : {}), ...(leadId ? { leadId } : {}) };
}

/** Everything the claim reads and writes. The default store is Firestore (leadsRouter.ts). */
export interface ClaimStore {
  getClient(id: string): Promise<Doc | null>;
  putClient(id: string, doc: Doc): Promise<void>;
  patchClient(id: string, fields: Doc): Promise<void>;
  memberships(clientId: string): Promise<Membership[]>;
  getObligation(id: string): Promise<Obligation | null>;
  createObligation(o: Obligation): Promise<void>;
  updateObligation(id: string, fields: Doc): Promise<void>;
  getLead(id: string): Promise<Lead | null>;
  putLead(lead: Lead): Promise<void>;
  patchLead(id: string, fields: Doc): Promise<void>;
  recordConsents(who: { clientId: string; email: string }, want: JoinConsents): Promise<number>;
  saveClaim(tokenHash: string, doc: Doc): Promise<void>;
  audit(action: string, clientId: string, email: string, meta: Doc): Promise<void>;
  sendCode(email: string, clientId: string): Promise<{ ok: boolean; status?: number }>;
  newToken(): string;
  hash(token: string): Promise<string>;
}

export interface ClaimResult {
  clientId: string;
  accountType: "free" | "member";
  newAccount: boolean;
  created: number;
  restored: number;
  kept: number;
  total: number;
  codeSent: boolean;
  claimToken: string;
  expiresAt: string;
  leadId: string;
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== "" && !(typeof v === "object" && !Array.isArray(v) && !Object.keys(v as Doc).length);

/** Run the claim. Idempotent: a repeat creates nothing new and sends a new code only after the 30-second cooldown. */
export async function claimDeadlines(input: ClaimInput, store: ClaimStore, now: Date = new Date()): Promise<ClaimResult> {
  const nowIso = now.toISOString();
  const { email, country } = input;
  const clientId = emailToDocId(email);
  const { answers } = countryAnswersFrom(country, input.answers);

  // ── The person: create, or fill only what is empty ───────────────────────
  const existing = await store.getClient(clientId);
  const memberships = existing ? await store.memberships(clientId) : [];
  const isMember = memberships.some((m) => m.status !== "pending") || (existing?.[ACCOUNT_TYPE_FIELD] === "member");
  const sameCountry = !existing || !filled(existing.legalCountry) || toCountryCode(existing.legalCountry) === country;
  const base: Doc = {
    email,
    ...(input.firstName ? { name: input.firstName } : {}),
    legalCountry: country,
    country,
    jurisdiction: COUNTRIES[country].name,
    timezone: COUNTRIES[country].defaultTimeZone,
    // Situation answers only for the record's own country (never mixed into another country's answers).
    ...(sameCountry && Object.keys(answers).length ? { [COUNTRY_ANSWERS_FIELD]: answers, ...profileFromCountryAnswers(country, answers) } : {}),
  };
  if (!existing) {
    await store.putClient(clientId, {
      ...base,
      [ACCOUNT_TYPE_FIELD]: "free",
      stage: "intake",
      source: "deadline_check",
      deadlines: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  } else {
    const fill: Doc = {};
    // A member's record is never changed here, apart from new obligations and consents.
    if (!isMember) {
      for (const [k, v] of Object.entries(base)) if (!filled(existing[k])) fill[k] = v;
      if (!filled(existing[ACCOUNT_TYPE_FIELD]) && !memberships.length) fill[ACCOUNT_TYPE_FIELD] = "free";
    }
    if (Object.keys(fill).length) await store.patchClient(clientId, { ...fill, updatedAt: nowIso });
  }
  const accountType: "free" | "member" = isMember ? "member" : "free";

  // ── The chosen deadlines ─────────────────────────────────────────────────
  // Dates come from the check's answers; a member's own answers win for their own country.
  const factAnswers = isMember && existing && toCountryCode(existing.legalCountry) === country && existing[COUNTRY_ANSWERS_FIELD]
    ? { ...answers, ...(existing[COUNTRY_ANSWERS_FIELD] as Doc) }
    : answers;
  const fresh = obligationsForRules(clientId, country, input.ruleIds, factsFor(country, factAnswers), "check", now);
  let created = 0, restored = 0, kept = 0;
  for (const o of fresh) {
    const step = mergeChosen(await store.getObligation(o.id), o);
    if (step.action === "create") {
      await store.createObligation(o);
      created++;
    } else if (step.action === "restore") {
      await store.updateObligation(o.id, step.fields as Doc);
      restored++;
    } else kept++;
  }

  // ── Consents, lead, audit ────────────────────────────────────────────────
  await store.recordConsents({ clientId, email }, input.consents);

  let lead = input.leadId ? await store.getLead(input.leadId) : null;
  if (lead && lead.email !== email) lead = null; // a lead only links to its own email
  const findings: LeadFinding[] = fresh.map((o) => ({
    ruleId: o.ruleId,
    title: o.title,
    area: o.area ?? "",
    ...(o.dueAt ? { dueAt: o.dueAt } : {}),
    ...(o.windowStartAt ? { windowStartAt: o.windowStartAt } : {}),
    ...(o.confidence ? { confidence: o.confidence } : {}),
    ...(o.dueText ? { dueText: o.dueText } : {}),
  }));
  if (!lead) {
    lead = {
      id: `lead_${crypto.randomUUID()}`,
      email,
      ...(input.firstName ? { name: input.firstName } : {}),
      country,
      answers,
      findings,
      source: "deadline_check",
      createdAt: nowIso,
    };
    await store.putLead(lead);
  }
  if (!lead.convertedClientId) await store.patchLead(lead.id, { convertedClientId: clientId, convertedAt: nowIso, claimedRuleIds: input.ruleIds });
  else await store.patchLead(lead.id, { claimedRuleIds: input.ruleIds, claimedAt: nowIso });

  await store.audit("deadlines.claimed", clientId, email, {
    country,
    chosen: input.ruleIds.length,
    created,
    restored,
    kept,
    newAccount: !existing,
    accountType,
    leadId: lead.id,
  });

  // ── Sign-in code and claim token ─────────────────────────────────────────
  const code = await store.sendCode(email, clientId);
  const claimToken = store.newToken();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  await store.saveClaim(await store.hash(claimToken), { clientId, country, ruleIds: input.ruleIds, leadId: lead.id, createdAt: nowIso, expiresAt });

  return {
    clientId,
    accountType,
    newAccount: !existing,
    created,
    restored,
    kept,
    total: fresh.length,
    // A code sent in the last 30 seconds (429) still works: the person uses that one.
    codeSent: code.ok || code.status === 429,
    claimToken,
    expiresAt,
    leadId: lead.id,
  };
}

/** A stored claim is usable by the same person until it expires, once. */
export function claimUsable(doc: Doc | null, clientId: string, now: Date = new Date()): boolean {
  if (!doc || doc.clientId !== clientId || doc.usedAt) return false;
  const exp = Date.parse(String(doc.expiresAt ?? ""));
  return Number.isFinite(exp) && exp > now.getTime();
}
