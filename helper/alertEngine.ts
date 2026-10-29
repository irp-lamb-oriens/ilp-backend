/**
 * Alert matching engine: the core Profile -> Obligation (rule) -> Alert step
 * of the ILP flywheel. Ported from IRP-funnel's stage-SLA scan pattern
 * (jobs/stageSla.ts): walk every profile, match it against active rules by
 * country, and deterministically upsert a scheduled alert per match.
 *
 * Rules that carry a deadline signal (`deadline` ISO string or `dueDays`)
 * produce an alert with a concrete `deadlineTs`/`deadlineLabel`; rules without
 * one are skipped. The dispatcher (jobs/dispatchAlerts.ts) then sends alerts
 * whose status is "scheduled" and deadline is due.
 */
import getAll from "../db/getAll.ts";
import get from "../db/get.ts";
import patch from "../db/patch.ts";
import log from "./log.ts";

const ALERTS = "alerts";
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") ?? "http://localhost:3000";

interface RuleDoc {
  id: string;
  country?: string;
  category?: string;
  title?: string;
  description?: string;
  status?: string;
  deadline?: string; // ISO
  dueDays?: number;
}

interface ProfileDoc {
  id: string;
  uid?: string;
  email?: string;
  country?: string;
  firstName?: string;
  lastName?: string;
}

export interface GenerateResult {
  created: number;
  updated: number;
  skipped: number;
}

export function normalizeCountry(v: unknown): string {
  return String(v ?? "").trim().toUpperCase();
}

export function matchesRule(profileCountry: unknown, rule: RuleDoc): boolean {
  if (rule.status !== "active") return false;
  return normalizeCountry(rule.country) === normalizeCountry(profileCountry);
}

export function buildAlertId(profileId: string, ruleId: string): string {
  return `alert_${profileId}_${ruleId}`;
}

/** Compute the next deadline timestamp + label for a rule, or null. */
export function computeDeadline(
  rule: RuleDoc,
  now = new Date(),
): { ts: number; label: string } | null {
  if (rule.deadline) {
    const d = new Date(rule.deadline);
    if (!isNaN(d.getTime())) {
      return { ts: d.getTime(), label: d.toISOString() };
    }
  }
  const dueDays = Number(rule.dueDays);
  if (Number.isFinite(dueDays) && dueDays >= 0) {
    const d = new Date(now.getTime() + dueDays * 86_400_000);
    return { ts: d.getTime(), label: d.toISOString() };
  }
  return null;
}

// COMMS-P1: "expired" (deadline passed before the lead-time send) is kept too.
const PRESERVED_STATUSES = new Set(["dispatched", "responded", "needs_help", "expired"]);

/**
 * Regenerate scheduled alerts for every (profile, active rule) match. Idempotent
 * and non-destructive: each alert lives at a deterministic id, and responses /
 * dispatched alerts are never reset back to "scheduled".
 */
export async function generateAlerts(): Promise<GenerateResult> {
  const [rules, profiles] = await Promise.all([
    getAll("rules"),
    getAll("profiles"),
  ]);

  const result: GenerateResult = { created: 0, updated: 0, skipped: 0 };

  for (const profile of profiles as ProfileDoc[]) {
    for (const rule of rules as RuleDoc[]) {
      if (!matchesRule(profile.country, rule)) continue;

      const deadline = computeDeadline(rule);
      if (!deadline) {
        result.skipped++;
        continue;
      }

      const profileId = profile.uid ?? profile.id;
      const id = buildAlertId(profileId, rule.id ?? "");
      const existing = await get(ALERTS, id);
      const existingStatus = existing?.status as string | undefined;
      const now = new Date().toISOString();

      const doc = {
        profileId,
        profileName:
          [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
          profile.email ||
          "Customer",
        email: profile.email ?? "",
        firstName: (profile.firstName as string) ?? "",
        ruleId: rule.id ?? "",
        title: rule.title ?? "",
        description: rule.description ?? "",
        country: normalizeCountry(profile.country),
        category: rule.category ?? "",
        deadlineTs: deadline.ts,
        deadlineLabel: deadline.label,
        responseUrl: `${FRONTEND_URL}/alerts`,
        status: existingStatus && PRESERVED_STATUSES.has(existingStatus)
          ? existingStatus
          : "scheduled",
        updatedAt: now,
        ...(existing ? {} : { createdAt: now }),
      };

      await patch(ALERTS, id, doc);
      if (existing) result.updated++;
      else result.created++;
    }
  }

  log(
    `[alertEngine] generated: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped`,
  );
  return result;
}