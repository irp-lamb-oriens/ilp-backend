/**
 * API/dashboard/automation/defaults.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The SINGLE hardcoded fallback + seed for the ILP Stage Email Automation
 * engine.
 *
 * Ported from IRP-funnel's `defaults.ts`, retargeted to ILP's legal taxonomy.
 * The relocation email types are replaced with the legal-pipeline types already
 * surfaced by `emailSuggestions.ts` (scoping_intro, legal_review_update,
 * quote_ready, quote_accepted_confirmation, filing_started, matter_closed).
 *
 * Every rule is a suggestion by default (mode "suggest"), so nothing auto-sends
 * until an operator flips a rule to "auto" from the dashboard. This is fully
 * backward compatible with the existing suggestion-only behavior.
 */

import type { StageEmailRule } from "./types.ts";

/** Stable rule id from a stage + email type pair. */
export function ruleId(triggerStage: string, emailType: string): string {
  return `${triggerStage}__${emailType}`;
}

/**
 * The behavior-preserving default rule set. One suggestion rule per legal
 * stage → email type pair, mirroring `STAGE_EMAIL_TRIGGERS` in
 * `emailSuggestions.ts`. All rules are `suggest` mode so the operator still
 * previews and confirms before anything is sent.
 */
export function buildDefaultRules(): StageEmailRule[] {
  const pairs: Array<[string, string]> = [
    ["scoping", "scoping_intro"],
    ["legal_review", "legal_review_update"],
    ["quote_sent", "quote_ready"],
    ["quote_accepted", "quote_accepted_confirmation"],
    ["filing", "filing_started"],
    ["closed", "matter_closed"],
  ];

  return pairs.map(([triggerStage, emailType]) => ({
    id: ruleId(triggerStage, emailType),
    triggerStage,
    emailType,
    condition: "always",
    mode: "suggest",
    enabled: true,
    delayHours: 0,
    label: `${triggerStage} → ${emailType}`,
  }));
}